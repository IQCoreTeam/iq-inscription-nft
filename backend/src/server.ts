// The HTTP surface: reserve, canonical metadata, mint (verify + co-sign), the
// public auditor, and read-only collection views. Holds the registrar key and
// the RPC pool; neither reaches a browser.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { config } from "./config.ts";
import { db, nowSec } from "./db.ts";
import { getCollection, getItem, listCollections, mintedIndices, publicView } from "./collections.ts";
import { reserve, ReserveError } from "./allocator.ts";
import { getReservation, markAwaitingSubmit, markCancelled, markRejected, touchReservation } from "./reservations.ts";
import { verifyItem, verifySingle } from "./verifier.ts";
import { coSignRegisterItem, coSignRegisterSingle } from "./cosigner.ts";
import { buildMetadata } from "./metadata.ts";
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
  return c.json({
    items: rows.map((r) => ({ index: r.item_index, name: r.name, arweaveId: r.arweave_id, mime: r.image_mime, minted: minted.has(r.item_index) })),
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
  const rows = db
    .query<{ item_index: number; asset: string; owner: string; registered_at: number }, [string, number]>(
      "SELECT item_index, asset, owner, registered_at FROM slot WHERE slug = ? ORDER BY registered_at DESC, item_index DESC LIMIT ?"
    )
    .all(col.slug, limit);
  return c.json({ recent: rows.map((r) => ({ index: r.item_index, asset: r.asset, owner: r.owner, registeredAt: r.registered_at })) });
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
