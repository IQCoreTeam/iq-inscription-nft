// The second devnet e2e: everything mint-e2e.ts does not touch. Rules
// (allowlist, window, per-wallet limit, open-reservation limit), cancel and
// touch, expiry through the reaper, sequential assignment, deposit mistakes,
// a big image through the session path, the single-NFT route, and the read
// routes. Deploys its own 6-item collection with a short TTL.
//
//   bun --env-file=backend/.env.devnet backend/scripts/rules-e2e.ts --funder ~/Desktop/deploy/deploy.json

import { parseArgs } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";
import { deflateSync } from "node:zlib";
import nacl from "tweetnacl";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { publicKey as umiPk } from "@metaplex-foundation/umi";
import { fetchAssetV1 } from "@metaplex-foundation/mpl-core";
import { writer } from "@iqlabs-official/solana-sdk";

// Short reservation life so expiry is testable in one run. Set before config loads.
process.env.RESERVATION_TTL_SECONDS = "25";
process.env.REAPER_SLACK_SECONDS = "5";

const { values: a } = parseArgs({ options: { funder: { type: "string" } } });
if (!a.funder) throw new Error("--funder required");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(a.funder.replace(/^~/, process.env.HOME!), "utf8"))));
const slug = "rules-" + randomBytes(3).toString("hex");

// A 6-item folder: item 1 is a ~20 KB noise PNG (linked-list path, 6 chunks),
// the rest tiny. The session path (10+ chunks) needs a keyed RPC: the public
// devnet endpoint rate-limits getTransaction and the SDK's chunk walk trips it.
function png(w: number, h: number, noise: boolean): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) rows.push(Buffer.concat([Buffer.from([0]), noise ? randomBytes(w * 3) : Buffer.alloc(w * 3, 40 + y)]));
  const raw = Buffer.concat(rows);
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
const dir = mkdtempSync(join(tmpdir(), "rules-assets-"));
for (let i = 1; i <= 6; i++) {
  writeFileSync(join(dir, `${i}.png`), i === 1 ? png(80, 80, true) : png(16, 16, false));
  writeFileSync(join(dir, `${i}.json`), JSON.stringify({ name: `Rule #${i}`, attributes: [{ trait_type: "Slot", value: String(i) }] }));
}

const DERIVE_MESSAGE = "IQ6900 code-in burner v1. Sign to unlock your inscription wallet. This costs nothing and never leaves your browser.";
const deriveBurner = (w: Keypair) => Keypair.fromSeed(new Uint8Array(createHash("sha256").update(nacl.sign.detached(new TextEncoder().encode(DERIVE_MESSAGE), w.secretKey)).digest()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { config } = await import("../src/config.ts");
  const connection = new Connection(config.rpcUrls[0], "confirmed");
  const transfer = async (from: Keypair, to: PublicKey, lamports: number) =>
    sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports })), [from], { commitment: "confirmed" });

  // Deploy the collection through the real CLI (one tx for collection + registry).
  const cli = Bun.spawnSync(["bun", "backend/scripts/deploy-collection.ts", "--dir", dir, "--slug", slug, "--name", "Rules", "--symbol", "RULE", "--price", "3000000", "--deposit", "1000000", "--sequential", "--creator", a.funder!, "--skip-feed"], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const cliOut = cli.stdout.toString() + cli.stderr.toString();
  assert.equal(cli.exitCode, 0, cliOut);
  console.log(cliOut.split("\n").filter((l) => l.includes("one tx") || l.includes("deployed")).join("\n"));

  const { app } = await import("../src/server.ts");
  const { db } = await import("../src/db.ts");
  const { reap } = await import("../src/reaper.ts");
  const { reconcile } = await import("../src/reconciler.ts");
  const { getCollection } = await import("../src/collections.ts");
  for (const t of ["reservation", "returned", "slot", "item", "allowlist", "collection"]) db.exec(`DELETE FROM ${t} WHERE slug LIKE 'rules-%' AND slug != '${slug}'`);
  const col = getCollection(slug)!;
  const treasury = new PublicKey(col.treasury);
  const req = async (path: string, method = "GET", body?: unknown) => {
    const res = await app.request(path, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: any = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  // A 503 from /mint means the chain could not be read (public RPC 429s on
  // session walks): the reservation is intact. Re-arm it and try again, exactly
  // what the site does; the short TTL here would otherwise run out mid-retry.
  const mintWithRetry = async (body: Record<string, unknown>) => {
    for (let attempt = 0; ; attempt++) {
      await req(`/c/${slug}/reserve/touch`, "POST", { reservationId: body.reservationId });
      const r = await req(`/c/${slug}/mint`, "POST", body);
      if (r.status === 503 && attempt < 5) { console.log(`   503 (${r.json?.reason?.slice(0, 60)}), retrying in 8 s`); await sleep(8_000); continue; }
      return r;
    }
  };
  let passed = 0;
  const ok = (l: string) => { passed++; console.log(`ok ${l}`); };

  // Rules on the collection: allowlist only, one per wallet, window open.
  db.exec(`UPDATE collection SET allowlist_only = 1, max_per_wallet = 1, start_at = ${Math.floor(Date.now() / 1000) - 60}, end_at = ${Math.floor(Date.now() / 1000) + 3600} WHERE slug = '${slug}'`);

  const w1 = Keypair.generate(), b1 = deriveBurner(w1);
  const w2 = Keypair.generate(), b2 = deriveBurner(w2);
  await transfer(funder, b1.publicKey, 0.12 * 1e9);
  await transfer(funder, b2.publicKey, 0.08 * 1e9);
  const W1 = w1.publicKey.toBase58(), B1 = b1.publicKey.toBase58(), W2 = w2.publicKey.toBase58(), B2 = b2.publicKey.toBase58();
  const deposit = async (b: Keypair, lamports = col.deposit_lamports, to = treasury) => transfer(b, to, lamports);

  // 1. Allowlist: refused until listed.
  let r = await req(`/c/${slug}/reserve`, "POST", { wallet: W1, burner: B1, depositSig: await deposit(b1) });
  assert.equal(r.status, 403, r.text); assert.match(r.json.error, /allowlist/);
  db.exec(`INSERT INTO allowlist (slug, wallet) VALUES ('${slug}', '${W1}'), ('${slug}', '${W2}')`);
  ok("allowlist: not listed -> 403");

  // 2. Deposit mistakes: wrong destination, too small.
  r = await req(`/c/${slug}/reserve`, "POST", { wallet: W1, burner: B1, depositSig: await deposit(b1, col.deposit_lamports, w2.publicKey) });
  assert.equal(r.status, 400, r.text);
  r = await req(`/c/${slug}/reserve`, "POST", { wallet: W1, burner: B1, depositSig: await deposit(b1, col.deposit_lamports - 1) });
  assert.equal(r.status, 400, r.text);
  ok("deposit: wrong destination and short amount -> 400");

  // 3. Sequential: first reservation is #1; cancel returns it; next reserve gets #1 again.
  r = await req(`/c/${slug}/reserve`, "POST", { wallet: W1, burner: B1, depositSig: await deposit(b1) });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.index, 1, "sequential starts at 1");
  const cancelled = await req(`/c/${slug}/reserve/cancel`, "POST", { reservationId: r.json.reservationId });
  assert.equal(cancelled.json.ok, true);
  r = await req(`/c/${slug}/reserve`, "POST", { wallet: W1, burner: B1, depositSig: await deposit(b1) });
  assert.equal(r.json.index, 1, "a cancelled index is served first");
  ok("sequential + cancel: #1, cancel, #1 again");

  // 4. Touch extends; expiry through the reaper returns the index.
  const touched = await req(`/c/${slug}/reserve/touch`, "POST", { reservationId: r.json.reservationId });
  assert.equal(touched.json.ok, true); assert.ok(touched.json.expiresAt > r.json.expiresAt - 1);
  console.log("   waiting for the reservation to expire (TTL 25 s + slack 5 s)...");
  await sleep(32_000);
  const reaped = await reap();
  assert.equal(reaped.expired, 1, JSON.stringify(reaped));
  assert.ok(db.query("SELECT 1 FROM returned WHERE slug = ? AND item_index = 1").get(slug), "expired index back in the pool");
  ok("touch + expiry: reaper returned #1 to the pool, deposit kept");

  // 5. Full mint of #1, the ~60 KB image (session path), then the per-wallet limit.
  r = await req(`/c/${slug}/reserve`, "POST", { wallet: W1, burner: B1, depositSig: await deposit(b1) });
  assert.equal(r.json.index, 1);
  const bytes = Buffer.from(await (await fetch(`${config.arweaveGateway}/${r.json.arweaveId}`)).arrayBuffer());
  assert.ok(bytes.length > 15_000, `big image is ${bytes.length} B`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), r.json.imageSha256);
  const { dbRootSeed, feedSeed, userInventoryPda } = await import("../src/feed.ts");
  const row = JSON.stringify({ kind: "image", body: `data:${r.json.imageMime};base64,${bytes.toString("base64")}`, who: W1 });
  await req(`/c/${slug}/reserve/touch`, "POST", { reservationId: r.json.reservationId });
  const C = await writer.writeRow(connection, b1, dbRootSeed, feedSeed, row, false, [userInventoryPda(w1.publicKey)], { speed: "light" });
  await sleep(5_000); // let the public RPC breathe after the session upload
  const json = await req(`/c/${slug}/json/1?c=${C}`);
  const M = await writer.codeIn({ connection, signer: b1 }, json.text, `nft-${C}.json`, 0, "json");
  await req(`/c/${slug}/reserve/touch`, "POST", { reservationId: r.json.reservationId });
  const asset = Keypair.generate();
  const mint = await mintWithRetry({ reservationId: r.json.reservationId, inscriptionSig: C, metaSig: M, asset: asset.publicKey.toBase58() });
  assert.equal(mint.status, 200, mint.text);
  const tx = Transaction.from(Buffer.from(mint.json.transaction, "base64"));
  tx.partialSign(b1, asset);
  await connection.confirmTransaction(await connection.sendRawTransaction(tx.serialize()), "confirmed");
  ok(`big image (${bytes.length} B, linked-list path) minted as #1`);
  r = await req(`/c/${slug}/reserve`, "POST", { wallet: W1, burner: B1, depositSig: await deposit(b1) });
  assert.equal(r.status, 403, r.text); assert.match(r.json.error, /already holds/);
  ok("per-wallet limit: second reservation -> 403");

  // 6. Open-reservation cap on another wallet: 3 live, the 4th is refused; sequential gives 2, 3, 4.
  const live: string[] = [];
  for (let i = 0; i < 3; i++) {
    db.exec(`UPDATE collection SET max_per_wallet = 0 WHERE slug = '${slug}'`);
    r = await req(`/c/${slug}/reserve`, "POST", { wallet: W2, burner: B2, depositSig: await deposit(b2) });
    assert.equal(r.status, 200, r.text); assert.equal(r.json.index, 2 + i, "sequential continues");
    live.push(r.json.reservationId);
  }
  r = await req(`/c/${slug}/reserve`, "POST", { wallet: W2, burner: B2, depositSig: await deposit(b2) });
  assert.equal(r.status, 429, r.text);
  for (const id of live) await req(`/c/${slug}/reserve/cancel`, "POST", { reservationId: id });
  ok("open-reservation cap: 3 live, 4th -> 429; sequential 2, 3, 4");

  // 7. Window closed.
  db.exec(`UPDATE collection SET end_at = ${Math.floor(Date.now() / 1000) - 1} WHERE slug = '${slug}'`);
  r = await req(`/c/${slug}/reserve`, "POST", { wallet: W2, burner: B2, depositSig: await deposit(b2) });
  assert.equal(r.status, 403, r.text); assert.match(r.json.error, /ended/);
  db.exec(`UPDATE collection SET end_at = 0 WHERE slug = '${slug}'`);
  ok("window: after end_at -> 403");

  // 8. Read routes.
  const items = await req(`/c/${slug}/items?limit=3`);
  assert.equal(items.json.items.length, 3); assert.equal(items.json.total, 6);
  await reconcile();
  const detail = await req(`/c/${slug}`);
  assert.deepEqual(detail.json.mintedIndices, [1]);
  const recent = await req(`/c/${slug}/recent`);
  assert.equal(recent.json.recent[0].index, 1);
  const stats = await req(`/stats`);
  assert.ok(stats.json.collections >= 1);
  ok("read routes: items paging, minted indices, recent, stats");

  // 9. Single NFT: own text inscription -> own JSON naming C -> /single/mint; same C twice fails on chain; someone else's C refused.
  const textRow = JSON.stringify({ kind: "text", body: "gm from the rules e2e " + Date.now(), who: W2 });
  const Cs = await writer.writeRow(connection, b2, dbRootSeed, feedSeed, textRow, false, [userInventoryPda(w2.publicKey)]);
  const singleJson = JSON.stringify({ name: "My gm", symbol: "IQNFT", description: "single", image: `${config.gatewayBase}/render/${Cs}`, attributes: [{ trait_type: "inscription", value: Cs }, { trait_type: "kind", value: "text" }] });
  const Ms = await writer.codeIn({ connection, signer: b2 }, singleJson, `nft-${Cs}.json`, 0, "json");
  const sAsset = Keypair.generate();
  const single = await req(`/single/mint`, "POST", { wallet: W2, burner: B2, inscriptionSig: Cs, metaSig: Ms, asset: sAsset.publicKey.toBase58(), name: "My gm" });
  assert.equal(single.status, 200, single.text);
  const stx = Transaction.from(Buffer.from(single.json.transaction, "base64"));
  stx.partialSign(b2, sAsset);
  await connection.confirmTransaction(await connection.sendRawTransaction(stx.serialize()), "confirmed");
  const onChain = await fetchAssetV1(createUmi(connection.rpcEndpoint), umiPk(sAsset.publicKey.toBase58()));
  assert.equal(onChain.owner.toString(), W2);
  ok("single NFT: own inscription -> register_single landed, owner = wallet");
  // The server does not track singles, so it co-signs again; the chain refuses
  // because the inscription record for Cs already exists.
  const aAsset = Keypair.generate();
  const again = await req(`/single/mint`, "POST", { wallet: W2, burner: B2, inscriptionSig: Cs, metaSig: Ms, asset: aAsset.publicKey.toBase58(), name: "My gm" });
  assert.equal(again.status, 200, again.text);
  const atx = Transaction.from(Buffer.from(again.json.transaction, "base64"));
  atx.partialSign(b2, aAsset);
  let chainRefused = "";
  try { await connection.sendRawTransaction(atx.serialize()); } catch (e: any) { chainRefused = String(e.message) + JSON.stringify(e.logs ?? []); }
  assert.match(chainRefused, /already in use/, "second token for the same C must be refused on chain");
  ok("single NFT: same C again -> chain refuses (inscription record exists)");
  const stolen = await req(`/single/mint`, "POST", { wallet: W1, burner: B1, inscriptionSig: Cs, metaSig: Ms, asset: Keypair.generate().publicKey.toBase58(), name: "x" });
  assert.equal(stolen.status, 400, stolen.text);
  ok("single NFT: someone else's C -> 400");

  // Sweep both burners back.
  for (const b of [b1, b2]) { const left = await connection.getBalance(b.publicKey); if (left > 10_000) await transfer(b, funder.publicKey, left - 5_000); }
  console.log(`\n${passed} rules checks passed (collection ${slug})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
