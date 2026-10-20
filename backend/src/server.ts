// The HTTP surface: reserve, canonical metadata, mint (verify + co-sign), the
// public auditor, and read-only collection views. Holds the registrar key and
// the RPC pool; neither reaches a browser.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createHash, randomBytes } from "node:crypto";
import { PublicKey, Connection } from "@solana/web3.js";
import { config } from "./config.ts";
import { db, nowSec } from "./db.ts";
import { getCollection, getItem, listCollections, mintedIndices, publicView } from "./collections.ts";
import { reserve, ReserveError } from "./allocator.ts";
import { getReservation, markAwaitingSubmit, markCancelled, markRejected, touchReservation } from "./reservations.ts";
import { verifyItem, verifySingle } from "./verifier.ts";
import { coSignRegisterItem, coSignRegisterSingle } from "./cosigner.ts";
import { buildMetadata } from "./metadata.ts";
import { stageCollection, buildDeploy, recordCollection, deployFee, buildCollectionJson, imgUrl, type DeploySpec, type StageItem, type Staged } from "./creator.ts";
import { reconcile, type ReconcileReport } from "./reconciler.ts";
import { reap } from "./reaper.ts";
import { poolStats } from "./rpcpool.ts";

export const app = new Hono();
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (config.corsOrigins.includes("*")) return origin || "*";
      if (config.corsOrigins.includes(origin)) return origin;
      // Dev convenience: on devnet, allow localhost so a branch can be tested
      // from a local static server. Never on mainnet.
      if (config.cluster === "devnet" && origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
      return null;
    },
  }),
);

let lastReconcile: ReconcileReport | null = null;

function isPubkey(s: unknown): s is string {
  if (typeof s !== "string") return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}
const isSig = (s: unknown): s is string => typeof s === "string" && s.length >= 80 && s.length <= 90;

// Per-IP reserve rate limit, sliding minute.
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > config.reservePerIpPerMinute;
}
const clientIp = (c: any) => c.req.header("x-forwarded-for")?.split(",")[0].trim() || c.req.header("x-real-ip") || "local";

app.get("/health", (c) => c.json({ ok: true, cluster: config.cluster, programId: config.programId.toBase58() }));

app.get("/c", (c) => c.json({ collections: listCollections().map(publicView) }));

app.get("/c/:slug", (c) => {
  const col = getCollection(c.req.param("slug"));
  if (!col) return c.json({ error: "not found" }, 404);
  return c.json({ ...publicView(col), mintedIndices: mintedIndices(col.slug) });
});

// Items are public before mint (the images sit on Arweave), so the page can
// render the grid. Paged; names and Arweave ids only.
app.get("/c/:slug/items", (c) => {
  const col = getCollection(c.req.param("slug"));
  if (!col) return c.json({ error: "not found" }, 404);
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
  const limit = Math.min(Math.max(1, Number(c.req.query("limit") ?? 60) || 60), 200);
  const rows = db
    .query<{ item_index: number; name: string; arweave_id: string; image_mime: string }, [string, number, number]>(
      "SELECT item_index, name, arweave_id, image_mime FROM item WHERE slug = ? ORDER BY item_index LIMIT ? OFFSET ?"
    )
    .all(col.slug, limit, offset);
  const minted = new Set(mintedIndices(col.slug));
  // Asset address per minted index, so the client can link a minted cell to the
  // on-chain NFT viewer. Only minted items have a slot row.
  const assetByIndex = new Map<number, string>();
  for (const s of db
    .query<{ item_index: number; asset: string }, [string]>("SELECT item_index, asset FROM slot WHERE slug = ?")
    .all(col.slug))
    assetByIndex.set(s.item_index, s.asset);
  return c.json({
    items: rows.map((r) => ({ index: r.item_index, name: r.name, arweaveId: r.arweave_id, mime: r.image_mime, minted: minted.has(r.item_index), asset: assetByIndex.get(r.item_index) ?? null })),
    total: col.max_supply,
  });
});

app.post("/c/:slug/reserve", async (c) => {
  if (rateLimited(clientIp(c))) return c.json({ error: "rate limited" }, 429);
  const col = getCollection(c.req.param("slug"));
  if (!col) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (!isPubkey(body.wallet) || !isPubkey(body.burner)) return c.json({ error: "wallet and burner must be base58 pubkeys" }, 400);
  try {
    return c.json(await reserve(col, body.wallet, body.burner, typeof body.depositSig === "string" ? body.depositSig : null));
  } catch (e) {
    if (e instanceof ReserveError) return c.json({ error: e.message }, e.status as any);
    console.error("[reserve]", e);
    return c.json({ error: "reserve failed" }, 500);
  }
});

app.post("/c/:slug/reserve/touch", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body?.reservationId !== "string") return c.json({ error: "reservationId required" }, 400);
  const expiresAt = touchReservation(body.reservationId);
  return c.json(expiresAt == null ? { ok: false, reason: "not reserved" } : { ok: true, expiresAt });
});

// Give up a still-`reserved` item. The deposit is not refunded.
app.post("/c/:slug/reserve/cancel", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = typeof body?.reservationId === "string" ? getReservation(body.reservationId) : null;
  if (!r) return c.json({ ok: false, reason: "not found" });
  if (r.state !== "reserved") return c.json({ ok: false, reason: r.state });
  markCancelled(r);
  return c.json({ ok: true, released: true });
});

// The canonical metadata for (item, C): the exact bytes the minter must inscribe as M.
app.get("/c/:slug/json/:index", (c) => {
  const col = getCollection(c.req.param("slug"));
  const index = Number(c.req.param("index"));
  const sig = c.req.query("c");
  if (!col) return c.json({ error: "not found" }, 404);
  if (!isSig(sig)) return c.json({ error: "c (base58 inscription signature) required" }, 400);
  const item = getItem(col.slug, index);
  if (!item) return c.json({ error: "index out of range" }, 404);
  return c.body(buildMetadata(col, item, sig), 200, { "content-type": "application/json" });
});

app.post("/c/:slug/mint", async (c) => {
  const t0 = Date.now();
  const col = getCollection(c.req.param("slug"));
  if (!col) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const { reservationId, inscriptionSig, metaSig, asset } = body ?? {};
  if (typeof reservationId !== "string") return c.json({ error: "reservationId required" }, 400);
  const r = getReservation(reservationId);
  if (!r || r.slug !== col.slug) return c.json({ error: "reservation not found" }, 404);
  const tag = `[mint] ${col.slug} #${r.item_index} resv=${reservationId.slice(0, 8)}`;
  const item = getItem(col.slug, r.item_index)!;

  if (r.state === "confirmed") return c.json({ status: "confirmed", index: r.item_index });
  if (r.state !== "reserved" && r.state !== "awaiting_submit") return c.json({ error: `reservation is ${r.state}` }, 409);
  if (r.expires_at < nowSec()) return c.json({ error: "reservation expired" }, 409);

  // Replay: already verified, re-issue with a fresh blockhash. No new verification.
  if (r.state === "awaiting_submit") {
    const co = await coSignRegisterItem(col, item, r, r.inscription_sig!, r.meta_sig!, r.asset!);
    console.log(`${tag} path=replay ${Date.now() - t0}ms`);
    return c.json({ ...co, index: r.item_index, replay: true });
  }

  if (!isSig(inscriptionSig) || !isSig(metaSig)) return c.json({ error: "inscriptionSig and metaSig (base58) required" }, 400);
  if (!isPubkey(asset)) return c.json({ error: "asset must be a base58 pubkey" }, 400);

  const tv = Date.now();
  const result = await verifyItem(r, col, item, inscriptionSig, metaSig);
  if (!result.pass) {
    if (result.retry) {
      // Not a verdict: the chain could not be read. Keep the reservation, let the
      // client try again (touch keeps it alive).
      console.warn(`${tag} VERIFY-UNAVAILABLE verify=${Date.now() - tv}ms reason="${result.reason}"`);
      return c.json({ error: "verification unavailable, retry", reason: result.reason }, 503);
    }
    console.error(`${tag} VERIFY-REJECT verify=${Date.now() - tv}ms reason="${result.reason}"`);
    markRejected(r);
    return c.json({ error: "verification failed", reason: result.reason }, 400);
  }
  markAwaitingSubmit(r.id, inscriptionSig, metaSig, asset);
  const co = await coSignRegisterItem(col, item, r, inscriptionSig, metaSig, asset);
  console.log(`${tag} path=first verify=${Date.now() - tv}ms total=${Date.now() - t0}ms`);
  return c.json({ ...co, index: r.item_index });
});

// Single NFT from the user's own inscription into the global collection.
app.post("/single/mint", async (c) => {
  const col = getCollection(config.singleSlug);
  if (!col) return c.json({ error: "single-NFT collection not configured" }, 500);
  const body = await c.req.json().catch(() => ({}));
  const { wallet, burner, inscriptionSig, metaSig, asset, name } = body ?? {};
  if (!isPubkey(wallet) || !isPubkey(burner) || !isPubkey(asset)) return c.json({ error: "wallet, burner, asset must be base58 pubkeys" }, 400);
  if (!isSig(inscriptionSig) || !isSig(metaSig)) return c.json({ error: "inscriptionSig and metaSig (base58) required" }, 400);
  if (typeof name !== "string" || name.length === 0 || Buffer.byteLength(name) > 80) return c.json({ error: "name must be 1..80 bytes" }, 400);
  const result = await verifySingle(wallet, burner, inscriptionSig, metaSig);
  if (!result.pass) return c.json({ error: result.retry ? "verification unavailable, retry" : "verification failed", reason: result.reason }, result.retry ? 503 : 400);
  return c.json(await coSignRegisterSingle(col, { wallet, burner, inscriptionSig, metaSig, name, asset }));
});

// ── Creator wizard: stage (Arweave + manifest; shuffle seed stays server-side)
//    -> the creator inscribes the returned bytes -> deploy (one tx incl. the
//    fee) -> finalize (DB rows after it lands). Staging holds the seed in memory
//    only, keyed by stagingId; a restart loses in-flight deploys (creator restarts).
type Staging = { spec: DeploySpec; items: StageItem[]; staged: Staged; creator: string; collection?: string; registry?: string; manifestSig?: string; metaSig?: string; logoSig?: string; bannerSig?: string };
const staging = new Map<string, Staging>();
const nftConn = () => new Connection(config.rpcUrls[0], "confirmed");

app.post("/creator/stage", async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const slug = typeof b.slug === "string" ? b.slug : "";
  if (!/^[a-z0-9-]{3,32}$/.test(slug)) return c.json({ error: "slug must be 3..32 of [a-z0-9-]" }, 400);
  if (getCollection(slug)) return c.json({ error: "slug already exists" }, 409);
  if (!isPubkey(b.creator)) return c.json({ error: "creator must be a base58 pubkey" }, 400);
  if (typeof b.name !== "string" || !b.name || Buffer.byteLength(b.name) > 80) return c.json({ error: "name must be 1..80 bytes" }, 400);
  if (typeof b.symbol !== "string" || !b.symbol) return c.json({ error: "symbol required" }, 400);
  const price = Number(b.price) || 0, deposit = Number(b.deposit) || 0;
  if (deposit > price) return c.json({ error: "deposit cannot exceed price" }, 400);
  const spec: DeploySpec = { slug, name: b.name, symbol: b.symbol, description: typeof b.description === "string" ? b.description : "", price, deposit, royaltyBps: Number(b.royaltyBps) || 0, sequential: !!b.sequential };

  // items: [{ index, name, mime, imageBase64, template }]; the browser compresses first.
  const raw = Array.isArray(b.items) ? b.items : [];
  const items: StageItem[] = raw.map((it: any, i: number) => ({
    index: Number(it.index) || i + 1,
    name: typeof it.name === "string" && it.name ? it.name : `${b.name} #${i + 1}`,
    bytes: Buffer.from(typeof it.imageBase64 === "string" ? it.imageBase64 : "", "base64"),
    mime: typeof it.mime === "string" ? it.mime : "image/png",
    template: typeof it.template === "object" && it.template ? it.template : {},
  }));
  for (const it of items) if (Buffer.byteLength(it.name) > 80) return c.json({ error: `name over 80 bytes at item ${it.index}` }, 400);
  if (!b.single && items.length === 0) return c.json({ error: "no items (or pass single:true)" }, 400);

  try {
    const staged = await stageCollection(spec, items);
    const id = randomBytes(16).toString("hex");
    // Drop raw bytes now that Arweave has them; keep index/name/template for recordCollection.
    staging.set(id, { spec, items: items.map((it) => ({ ...it, bytes: Buffer.alloc(0) })), staged, creator: b.creator });
    return c.json({ stagingId: id, manifestJson: staged.manifestJson, collectionJson: staged.collectionJson, itemCount: staged.itemCount, deployFeeLamports: deployFee(staged.itemCount), arweaveGateway: config.arweaveGateway });
  } catch (e) {
    console.error("[creator/stage]", e);
    return c.json({ error: "stage failed: " + (e instanceof Error ? e.message : String(e)) }, 502);
  }
});

app.post("/creator/deploy", async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const s = typeof b.stagingId === "string" ? staging.get(b.stagingId) : undefined;
  if (!s) return c.json({ error: "unknown or expired stagingId" }, 404);
  if (!isPubkey(b.creator) || b.creator !== s.creator) return c.json({ error: "creator mismatch" }, 400);
  if (!isPubkey(b.collection)) return c.json({ error: "collection must be a base58 pubkey" }, 400);
  const payer = isPubkey(b.payer) ? b.payer : b.creator; // the wallet itself, or its burner
  const manifestSig = s.staged.itemCount ? b.manifestSig : "";
  if (s.staged.itemCount && !isSig(manifestSig)) return c.json({ error: "manifestSig required" }, 400);
  if (!isSig(b.metaSig)) return c.json({ error: "metaSig required" }, 400);
  try {
    const conn = nftConn();
    const { tx, registry } = await buildDeploy({
      connection: conn, creatorPubkey: new PublicKey(b.creator), payerPubkey: new PublicKey(payer), collectionPubkey: new PublicKey(b.collection),
      spec: s.spec, itemCount: s.staged.itemCount, manifestHash: s.staged.manifestHash, manifestSig, shuffleCommit: s.staged.shuffleCommit, metaSig: b.metaSig,
    });
    s.collection = b.collection; s.registry = registry.toBase58(); s.manifestSig = manifestSig; s.metaSig = b.metaSig;
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = new PublicKey(payer);
    return c.json({ transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), lastValidBlockHeight, registry: registry.toBase58() });
  } catch (e) {
    console.error("[creator/deploy]", e);
    return c.json({ error: "deploy build failed: " + (e instanceof Error ? e.message : String(e)) }, 502);
  }
});

// Rebuild collection.json once the creator has inscribed their logo/banner, so
// its image/banner point at those on-chain inscriptions. The creator inscribes
// the returned string (-> metaSig) before /creator/deploy. Optional: with no
// sigs it falls back to the first-item image (same as stage).
app.post("/creator/collection-json", async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const s = typeof b.stagingId === "string" ? staging.get(b.stagingId) : undefined;
  if (!s) return c.json({ error: "unknown or expired stagingId" }, 404);
  const logoSig = isSig(b.logoSig) ? b.logoSig : undefined;
  const bannerSig = isSig(b.bannerSig) ? b.bannerSig : undefined;
  const fallback = s.staged.manifestItems.length ? `${config.arweaveGateway}/${s.staged.manifestItems[0].arweave_id}` : "";
  const collectionJson = buildCollectionJson(s.spec, logoSig ? imgUrl(logoSig) : fallback, bannerSig ? imgUrl(bannerSig) : "");
  s.logoSig = logoSig;
  s.bannerSig = bannerSig;
  return c.json({ collectionJson });
});

app.post("/creator/finalize", async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const s = typeof b.stagingId === "string" ? staging.get(b.stagingId) : undefined;
  if (!s || !s.collection || !s.registry) return c.json({ error: "nothing to finalize for this stagingId" }, 404);
  if (getCollection(s.spec.slug)) { staging.delete(b.stagingId); return c.json({ ok: true, slug: s.spec.slug, already: true }); }
  // Record only once the registry actually exists on chain (the deploy tx landed).
  const info = await nftConn().getAccountInfo(new PublicKey(s.registry)).catch(() => null);
  if (!info) return c.json({ error: "registry not on chain yet; send the deploy tx, then retry" }, 409);
  try {
    recordCollection({ spec: s.spec, collectionPubkey: new PublicKey(s.collection), registry: new PublicKey(s.registry), creatorPubkey: new PublicKey(s.creator), staged: s.staged, items: s.items, manifestSig: s.manifestSig || "", metaSig: s.metaSig || "", logoSig: s.logoSig, bannerSig: s.bannerSig });
    staging.delete(b.stagingId);
    return c.json({ ok: true, slug: s.spec.slug, collection: s.collection, registry: s.registry });
  } catch (e) {
    console.error("[creator/finalize]", e);
    return c.json({ error: "finalize failed: " + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});

// The public auditor: re-read the inscriptions and expose every value so a
// third party can redo the work.
app.get("/c/:slug/verify/:index", async (c) => {
  const col = getCollection(c.req.param("slug"));
  const index = Number(c.req.param("index"));
  if (!col) return c.json({ error: "not found" }, 404);
  const item = getItem(col.slug, index);
  const slot = db
    .query<{ inscription_sig: string; meta_sig: string; asset: string; owner: string }, [string, number]>(
      "SELECT inscription_sig, meta_sig, asset, owner FROM slot WHERE slug = ? AND item_index = ?"
    )
    .get(col.slug, index);
  if (!item || !slot) return c.json({ error: "item not minted yet" }, 404);
  const { withConnection } = await import("./rpcpool.ts");
  const { reader } = await import("@iqlabs-official/solana-sdk");
  const read = async (sig: string) => {
    const tx: any = await withConnection((cn) => cn.getTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }));
    if (!tx || tx.meta?.err) return null;
    const d = await reader.readUserInventoryCodeInFromTx(tx);
    return d.data ?? (d.metadata ? JSON.parse(d.metadata).data ?? null : null);
  };
  try {
    const row = await read(slot.inscription_sig);
    const body = row ? String(JSON.parse(row).body ?? "") : "";
    const at = body.indexOf(";base64,");
    const inscribedHash = at >= 0 ? createHash("sha256").update(Buffer.from(body.slice(at + 8), "base64")).digest("hex") : null;
    const meta = await read(slot.meta_sig);
    return c.json({
      index,
      name: item.name,
      asset: slot.asset,
      owner: slot.owner,
      inscriptionSig: slot.inscription_sig,
      metaSig: slot.meta_sig,
      manifestHash: item.image_sha256,
      inscribedHash,
      metadataMatches: meta === buildMetadata(col, item, slot.inscription_sig),
      matches: inscribedHash === item.image_sha256 && meta === buildMetadata(col, item, slot.inscription_sig),
    });
  } catch (e) {
    return c.json({ error: `could not read inscriptions: ${e}` }, 502);
  }
});

app.get("/c/:slug/recent", (c) => {
  const col = getCollection(c.req.param("slug"));
  if (!col) return c.json({ error: "not found" }, 404);
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 100);
  // arweave_id rides along so the feed can show the item's thumbnail without a
  // second round trip (the image itself is the creator's Arweave copy).
  const rows = db
    .query<{ item_index: number; asset: string; owner: string; registered_at: number; arweave_id: string | null }, [string, number]>(
      `SELECT s.item_index, s.asset, s.owner, s.registered_at, i.arweave_id
         FROM slot s LEFT JOIN item i ON i.slug = s.slug AND i.item_index = s.item_index
        WHERE s.slug = ? ORDER BY s.registered_at DESC, s.item_index DESC LIMIT ?`
    )
    .all(col.slug, limit);
  return c.json({ recent: rows.map((r) => ({ index: r.item_index, asset: r.asset, owner: r.owner, registeredAt: r.registered_at, arweaveId: r.arweave_id })) });
});

app.get("/stats", (c) => {
  const counts: Record<string, number> = {};
  for (const row of db.query<{ state: string; n: number }, []>("SELECT state, COUNT(*) AS n FROM reservation GROUP BY state").all()) counts[row.state] = row.n;
  return c.json({ collections: listCollections().length, reservations: counts, rpcPool: poolStats(), lastReconcile });
});

export function startJobs() {
  setInterval(() => {
    reconcile().then((r) => (lastReconcile = r)).catch((e) => console.error("[reconciler]", e));
  }, config.reconcileMs);
  setInterval(() => {
    reap().catch((e) => console.error("[reaper]", e));
  }, config.reaperMs);
}

if (import.meta.main) {
  lastReconcile = await reconcile().catch((e) => {
    console.error("[boot reconcile]", e);
    return null;
  });
  startJobs();
  Bun.serve({ port: config.port, fetch: app.fetch });
  console.log(`iq-inscription-nft backend on :${config.port} (${config.cluster}, program ${config.programId.toBase58()})`);
}
