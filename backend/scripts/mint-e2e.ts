// End to end on devnet through the HTTP layer (app.request, no TCP) with real
// chain writes: a script wallet with a site-style deterministic burner funds
// itself, pays the deposit, reserves, inscribes the Arweave bytes as a feed row
// (C), inscribes the canonical JSON (M), gets the co-signed register tx, lands
// it, and the public verifier reproduces the evidence. Then the rejection path.
//
//   bun --env-file backend/.env.devnet run backend/scripts/mint-e2e.ts --slug test-monks --funder ~/Desktop/deploy/deploy.json

import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import nacl from "tweetnacl";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { publicKey as umiPk } from "@metaplex-foundation/umi";
import { fetchAssetV1 } from "@metaplex-foundation/mpl-core";
import { writer } from "@iqlabs-official/solana-sdk";
import * as anchor from "@coral-xyz/anchor";
import { config } from "../src/config.ts";
import { dbRootSeed, feedSeed, userInventoryPda } from "../src/feed.ts";
import { getCollection } from "../src/collections.ts";

const { values: a } = parseArgs({ options: { slug: { type: "string" }, funder: { type: "string" } } });
if (!a.slug || !a.funder) throw new Error("--slug and --funder required");
const col = getCollection(a.slug)!;
assert.ok(col, `collection ${a.slug} not in the backend DB`);

const connection = new Connection(config.rpcUrls[0], "confirmed");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(a.funder.replace(/^~/, process.env.HOME!), "utf8"))));

// The site's burner derivation (assets/js/codein/burner.js): sha256 of one
// signMessage over a fixed string, so the same wallet always gets the same burner.
const DERIVE_MESSAGE =
  "IQ6900 code-in burner v1. Sign to unlock your inscription wallet. This costs nothing and never leaves your browser.";
function deriveBurner(wallet: Keypair): Keypair {
  const signature = nacl.sign.detached(new TextEncoder().encode(DERIVE_MESSAGE), wallet.secretKey);
  return Keypair.fromSeed(new Uint8Array(createHash("sha256").update(signature).digest()));
}

async function transfer(from: Keypair, to: PublicKey, lamports: number): Promise<string> {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
  return sendAndConfirmTransaction(connection, tx, [from], { commitment: "confirmed" });
}

async function main() {
  const { app } = await import("../src/server.ts");
  const { reconcile } = await import("../src/reconciler.ts");
  const { db } = await import("../src/db.ts");
  const req = async (path: string, method = "GET", body?: unknown) => {
    const res = await app.request(path, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  let passed = 0;
  const ok = (label: string) => { passed++; console.log(`ok ${label}`); };

  // 1. A fresh user wallet and its burner, funded by the funder.
  const wallet = Keypair.generate();
  const burner = deriveBurner(wallet);
  await transfer(funder, burner.publicKey, 0.25 * 1e9 + col.price_lamports);
  ok(`wallet ${wallet.publicKey.toBase58().slice(0, 8)} burner ${burner.publicKey.toBase58().slice(0, 8)} funded`);

  // 2. Deposit, then reserve.
  const depositSig = col.deposit_lamports > 0 ? await transfer(burner, new PublicKey(col.treasury), col.deposit_lamports) : undefined;
  const noDeposit = await req(`/c/${col.slug}/reserve`, "POST", { wallet: wallet.publicKey.toBase58(), burner: burner.publicKey.toBase58() });
  if (col.deposit_lamports > 0) assert.equal(noDeposit.status, 400, "reserve without a deposit must be refused");
  const reserved = await req(`/c/${col.slug}/reserve`, "POST", { wallet: wallet.publicKey.toBase58(), burner: burner.publicKey.toBase58(), depositSig });
  assert.equal(reserved.status, 200, `reserve: ${reserved.text}`);
  const { reservationId, index, arweaveId, imageSha256, imageMime } = reserved.json;
  ok(`reserve -> item ${index} (${reserved.json.name}), arweave ${arweaveId}`);
  const again = await req(`/c/${col.slug}/reserve`, "POST", { wallet: wallet.publicKey.toBase58(), burner: burner.publicKey.toBase58(), depositSig });
  assert.equal(again.status, 409, "the same deposit must not back a second reservation");
  ok("deposit reuse refused");

  // 3. Fetch the bytes from Arweave, check the manifest hash, inscribe as the site does.
  const res = await fetch(`${config.arweaveGateway}/${arweaveId}`);
  assert.equal(res.status, 200, `arweave fetch ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), imageSha256, "arweave bytes must match the manifest");
  const row = JSON.stringify({ kind: "image", body: `data:${imageMime};base64,${bytes.toString("base64")}`, who: wallet.publicKey.toBase58() });
  const C = await writer.writeRow(connection, burner, dbRootSeed, feedSeed, row, false, [userInventoryPda(wallet.publicKey)]);
  ok(`image inscribed -> C ${C.slice(0, 12)}`);

  // 4. Canonical JSON from the server, inscribed as is.
  const json = await req(`/c/${col.slug}/json/${index}?c=${C}`);
  assert.equal(json.status, 200, json.text);
  assert.ok(json.text.includes(`"image":"${config.gatewayBase}/img/${C}.png"`), "json image must point at C");
  const M = await writer.codeIn({ connection, signer: burner }, json.text, `nft-${C}.json`, 0, "json");
  ok(`metadata inscribed -> M ${M.slice(0, 12)}`);

  // 5. Mint: verify + co-sign, then land it with the burner and asset signatures.
  const asset = Keypair.generate();
  const mint1 = await req(`/c/${col.slug}/mint`, "POST", { reservationId, inscriptionSig: C, metaSig: M, asset: asset.publicKey.toBase58() });
  assert.equal(mint1.status, 200, `mint: ${mint1.text}`);
  ok("mint verified and co-signed");
  const mint2 = await req(`/c/${col.slug}/mint`, "POST", { reservationId });
  assert.equal(mint2.json.replay, true, "second /mint must be a replay");
  const tx = Transaction.from(Buffer.from(mint2.json.transaction, "base64"));
  tx.partialSign(burner, asset);
  const mintSig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(mintSig, "confirmed");
  ok(`register_item landed -> ${mintSig.slice(0, 12)}`);

  // 6. The asset is a plain Core asset owned by the wallet with the sigs in Attributes.
  const umi = createUmi(connection.rpcEndpoint, { commitment: "confirmed" });
  const onChain = await fetchAssetV1(umi, umiPk(asset.publicKey.toBase58()));
  assert.equal(onChain.owner.toString(), wallet.publicKey.toBase58(), "owner must be the user wallet");
  assert.equal(onChain.uri, `${config.gatewayBase}/token-meta/${M}`);
  const attrs = Object.fromEntries(((onChain as any).attributes?.attributeList ?? []).map((x: any) => [x.key, x.value]));
  assert.equal(attrs.inscription, Buffer.from(anchor.utils.bytes.bs58.decode(C)).toString("hex"));
  assert.equal(attrs.metadata, Buffer.from(anchor.utils.bytes.bs58.decode(M)).toString("hex"));
  assert.equal(attrs.index, String(index));
  ok("asset: owner, uri = gateway/token-meta/M, Attributes C/M/index");

  // 7. Reconcile, verify, idempotency.
  const rec = await reconcile();
  assert.ok(rec.slots >= 1 && rec.divergent.length === 0, JSON.stringify(rec));
  const verify = await req(`/c/${col.slug}/verify/${index}`);
  assert.equal(verify.json.matches, true, verify.text);
  ok("reconcile + public verify: inscribed hash == manifest, metadata matches");
  const mint3 = await req(`/c/${col.slug}/mint`, "POST", { reservationId });
  assert.equal(mint3.json.status, "confirmed");
  ok("post-confirm /mint is idempotent");

  // 8. Rejection: reserve another item but inscribe the FIRST item's bytes.
  const dep2 = col.deposit_lamports > 0 ? await transfer(burner, new PublicKey(col.treasury), col.deposit_lamports) : undefined;
  const r2 = await req(`/c/${col.slug}/reserve`, "POST", { wallet: wallet.publicKey.toBase58(), burner: burner.publicKey.toBase58(), depositSig: dep2 });
  assert.equal(r2.status, 200, r2.text);
  const badC = await writer.writeRow(connection, burner, dbRootSeed, feedSeed, row, false, [userInventoryPda(wallet.publicKey)]);
  const badJson = await req(`/c/${col.slug}/json/${r2.json.index}?c=${badC}`);
  const badM = await writer.codeIn({ connection, signer: burner }, badJson.text, `nft-${badC}.json`, 0, "json");
  const bad = await req(`/c/${col.slug}/mint`, "POST", { reservationId: r2.json.reservationId, inscriptionSig: badC, metaSig: badM, asset: Keypair.generate().publicKey.toBase58() });
  assert.equal(bad.status, 400, `wrong bytes must be rejected: ${bad.text}`);
  assert.ok(db.query("SELECT 1 FROM returned WHERE slug = ? AND item_index = ?").get(col.slug, r2.json.index), "rejected index returns to the pool");
  ok(`rejection: ${bad.json.reason}`);

  // 9. DB wipe rebuild.
  db.exec("DELETE FROM slot");
  const rec2 = await reconcile();
  assert.ok(db.query("SELECT 1 FROM slot WHERE slug = ? AND item_index = ?").get(col.slug, index), "slot rebuilt from chain");
  ok(`DB-wipe rebuild: ${rec2.slots} slot(s) restored from chain`);

  // Sweep the burner back to the funder.
  const left = await connection.getBalance(burner.publicKey);
  if (left > 10_000) await transfer(burner, funder.publicKey, left - 5_000);
  console.log(`\n${passed} e2e checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
