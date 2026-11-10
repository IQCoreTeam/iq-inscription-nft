// Secondary-market sales, read from Tensor. Read-only and mainnet-scoped: the
// API key is rejected by the devnet host, so the poller only runs on mainnet.
// Everything here is a cache over on-chain sales; it never signs or spends, and
// the key stays in this process (never reaches a browser).
import { config } from "./config";
import { db, nowSec } from "./db";
import { listCollections } from "./collections";
import type { CollectionRow } from "./db";

export const tensorOn = (): boolean => config.tensorApiKey !== "" && config.cluster === "mainnet";

async function tj(path: string): Promise<any | null> {
  try {
    const r = await fetch(config.tensorBase + path, { headers: { "x-tensor-api-key": config.tensorApiKey } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// A minted NFT mint -> its Tensor collection. `collections/mints` returns, per
// mint, the collection object; `id` is the collId that tx_history takes and
// `slug` is what the /listings endpoint keys on, so we keep both. Verified
// against live mainnet data.
async function resolveColl(itemMint: string): Promise<{ id: string | null; slug: string | null }> {
  const a = await tj(`/collections/mints?${new URLSearchParams({ mints: itemMint })}`);
  const c = Array.isArray(a) ? a[0] : null;
  return { id: c?.id != null ? String(c.id) : null, slug: c?.slug != null ? String(c.slug) : null };
}

type ParsedSale = { txId: string; mint: string; price: number; buyer: string | null; seller: string | null; source: string | null; blockTime: number };

async function fetchSales(collId: string, limit = 50): Promise<ParsedSale[]> {
  const qs = new URLSearchParams({ collId, limit: String(limit) });
  qs.append("txTypes", "SALE_BUY_NOW");
  qs.append("txTypes", "SALE_ACCEPT_BID");
  const j = await tj(`/collections/tx_history?${qs}`);
  const txs: any[] = j?.txs ?? [];
  return txs
    .map((t) => {
      const tx = t.tx ?? {};
      const at = tx.txAt ? Math.floor(new Date(tx.txAt).getTime() / 1000) : 0;
      return {
        txId: String(tx.txId ?? tx.txKey ?? ""),
        mint: String(tx.mintOnchainId ?? t.mint?.onchainId ?? ""),
        price: Math.round(Number(tx.grossAmount ?? 0)), // lamports
        buyer: tx.buyerId ?? null,
        seller: tx.sellerId ?? null,
        source: tx.source ?? null,
        blockTime: Number.isFinite(at) ? at : 0,
      } as ParsedSale;
    })
    .filter((s) => s.txId && s.mint && s.price > 0);
}

type ParsedListing = { mint: string; price: number; seller: string | null; source: string | null };

// Active listings for a collection. The endpoint keys on the Tensor slug and
// returns a bare array; price is a lamport string, owner is the seller.
async function fetchListings(slug: string, limit = 100): Promise<ParsedListing[]> {
  const j = await tj(`/listings?${new URLSearchParams({ slug, sortBy: "PriceAsc", limit: String(limit) })}`);
  const arr: any[] = Array.isArray(j) ? j : (j?.listings ?? []);
  return arr
    .map((l) => ({ mint: String(l.mint ?? ""), price: Math.round(Number(l.price ?? 0)), seller: l.owner ?? null, source: l.source ?? null }))
    .filter((l) => l.mint && l.price > 0);
}

const setCollId = db.query("UPDATE collection SET tensor_coll_id = ? WHERE slug = ?");
const setCollSlug = db.query("UPDATE collection SET tensor_slug = ? WHERE slug = ?");
const insSale = db.query(
  "INSERT OR IGNORE INTO sale(tx_id,slug,item_index,asset,price,buyer,seller,source,block_time) VALUES(?,?,?,?,?,?,?,?,?)",
);
const delListings = db.query("DELETE FROM listing WHERE slug = ?");
const insListing = db.query(
  "INSERT OR REPLACE INTO listing(slug,item_index,asset,price,seller,source,updated_at) VALUES(?,?,?,?,?,?,?)",
);

async function syncCollection(c: CollectionRow): Promise<void> {
  if (c.max_supply <= 0) return; // single registries have no item slots to match
  let collId = c.tensor_coll_id;
  let slug = c.tensor_slug;
  if (!collId || !slug) {
    // resolve from one of our minted NFTs; nothing minted = nothing yet
    const sample = db.query<{ asset: string }, [string]>("SELECT asset FROM slot WHERE slug = ? LIMIT 1").get(c.slug);
    if (!sample) return;
    const r = await resolveColl(sample.asset);
    if (r.id && !collId) { collId = r.id; setCollId.run(r.id, c.slug); }
    if (r.slug && !slug) { slug = r.slug; setCollSlug.run(r.slug, c.slug); }
    if (!collId && !slug) return; // Tensor does not index this collection yet
  }
  const slots = db
    .query<{ asset: string; item_index: number }, [string]>("SELECT asset, item_index FROM slot WHERE slug = ?")
    .all(c.slug);
  const idxOf = new Map(slots.map((s) => [s.asset, s.item_index]));

  if (collId) {
    const sales = await fetchSales(collId, 50);
    for (const s of sales) insSale.run(s.txId, c.slug, idxOf.get(s.mint) ?? null, s.mint, s.price, s.buyer, s.seller, s.source, s.blockTime);
  }
  if (slug) {
    // Listings are a live snapshot: replace the whole set so cancelled or bought
    // ones disappear instead of lingering.
    const listings = await fetchListings(slug, 100);
    const now = nowSec();
    db.transaction(() => {
      delListings.run(c.slug);
      for (const l of listings) insListing.run(c.slug, idxOf.get(l.mint) ?? null, l.mint, l.price, l.seller, l.source, now);
    })();
  }
}

let lastPoll = 0;
let lastError: string | null = null;

export async function syncAll(): Promise<void> {
  if (!tensorOn()) return;
  for (const c of listCollections()) {
    try {
      await syncCollection(c);
    } catch (e) {
      lastError = String((e as any)?.message ?? e); // best effort; one bad collection never stalls the rest
    }
  }
  lastPoll = nowSec();
}

export type RecentSale = {
  index: number | null;
  asset: string;
  price: number;
  buyer: string | null;
  source: string | null;
  blockTime: number;
  inscriptionSig: string | null;
};

const recentSalesQ = db.query<
  { item_index: number | null; asset: string; price: number; buyer: string | null; source: string | null; block_time: number; inscription_sig: string | null },
  [string, number]
>(
  `SELECT sale.item_index, sale.asset, sale.price, sale.buyer, sale.source, sale.block_time, slot.inscription_sig
   FROM sale LEFT JOIN slot ON slot.slug = sale.slug AND slot.asset = sale.asset
   WHERE sale.slug = ? ORDER BY sale.block_time DESC LIMIT ?`,
);

export function recentSales(slug: string, limit: number): RecentSale[] {
  return recentSalesQ.all(slug, limit).map((r) => ({
    index: r.item_index,
    asset: r.asset,
    price: r.price,
    buyer: r.buyer,
    source: r.source,
    blockTime: r.block_time,
    inscriptionSig: r.inscription_sig,
  }));
}

export function startTensorPoller(): void {
  if (!tensorOn()) return;
  void syncAll();
  setInterval(() => void syncAll(), config.tensorPollMs);
}

export type ActiveListing = { index: number | null; asset: string; price: number; seller: string | null; source: string | null };

const listingQ = db.query<
  { item_index: number | null; asset: string; price: number; seller: string | null; source: string | null },
  [string, number]
>("SELECT item_index, asset, price, seller, source FROM listing WHERE slug = ? ORDER BY price ASC LIMIT ?");

export function activeListings(slug: string, limit: number): ActiveListing[] {
  return listingQ.all(slug, limit).map((r) => ({ index: r.item_index, asset: r.asset, price: r.price, seller: r.seller, source: r.source }));
}

// Why the poller sees (or does not see) data, for the /stats auditor.
const saleCountQ = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sale WHERE slug = ?");
const listingCountQ = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM listing WHERE slug = ?");

// Temporary probe: `/collections/mints` returns a collId but no slug, and the
// listings endpoint keys on slug, so dump the raw shapes to find where the slug
// lives (or whether the collId doubles as the slug). Remove once resolved.
export async function tensorProbe(dbSlug: string): Promise<any> {
  const sample = db.query<{ asset: string }, [string]>("SELECT asset FROM slot WHERE slug = ? LIMIT 1").get(dbSlug);
  if (!sample) return { error: "no minted item" };
  const mints = await tj(`/collections/mints?${new URLSearchParams({ mints: sample.asset })}`);
  const collId = Array.isArray(mints) ? (mints[0]?.id != null ? String(mints[0].id) : null) : null;
  const txh = collId ? await tj(`/collections/tx_history?${new URLSearchParams({ collId, limit: "1" })}`) : null;
  const listByCollId = collId ? await tj(`/listings?${new URLSearchParams({ slug: collId, limit: "2" })}`) : null;
  return { sampleAsset: sample.asset, collId, mintsRaw: mints, txHistorySample: txh, listingsUsingCollIdAsSlug: listByCollId };
}

export function tensorDiag() {
  return {
    on: tensorOn(),
    base: config.tensorBase,
    lastPoll,
    lastError,
    collections: listCollections().map((c) => ({
      slug: c.slug,
      collId: c.tensor_coll_id,
      tensorSlug: c.tensor_slug,
      sales: saleCountQ.get(c.slug)?.n ?? 0,
      listings: listingCountQ.get(c.slug)?.n ?? 0,
    })),
  };
}
