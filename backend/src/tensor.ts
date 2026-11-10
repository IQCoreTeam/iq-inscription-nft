// Secondary market, read from Tensor. Read-only and mainnet-scoped: the API key
// is rejected by the devnet host, so the poller only runs on mainnet. Everything
// here is a cache over on-chain activity; it never signs or spends, and the key
// stays in this process (never reaches a browser).
//
// One tx_history call per collection feeds both views. Sales (the recent feed)
// are the SALE rows; active listings are reconstructed by walking the history
// newest-first and keeping each mint's latest state when it is a live LIST. The
// dedicated /listings endpoint is Tensor-swap only and misses Magic Eden asks,
// so tx_history (which spans every marketplace) is the source of truth.
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

// A minted NFT mint -> its Tensor collId (tx_history's key). `/collections/mints`
// returns, per mint, the collection `{ id, name, verifiedCollection }`; `id` is
// the collId. Verified against live mainnet data.
async function resolveCollId(itemMint: string): Promise<string | null> {
  const a = await tj(`/collections/mints?${new URLSearchParams({ mints: itemMint })}`);
  const id = Array.isArray(a) ? a[0]?.id : null;
  return id != null ? String(id) : null;
}

type HistTx = { txId: string; mint: string; type: string; price: number; buyer: string | null; seller: string | null; source: string | null; blockTime: number; listingEnd: number };

// Recent txs across every marketplace, newest first. Fetched unfiltered (the
// txType enum names beyond LIST/SALE_* are not all documented, and one bad
// txTypes value 400s the whole request, so we classify client-side). The
// endpoint caps limit at 50; a larger value is rejected and returns nothing.
// Returns null when the request itself failed, so the caller can tell a real
// "no activity" from a transient error and not wipe a good snapshot.
async function fetchHistory(collId: string, limit = 50): Promise<HistTx[] | null> {
  const j = await tj(`/collections/tx_history?${new URLSearchParams({ collId, limit: String(limit) })}`);
  if (j === null) return null;
  const txs: any[] = j?.txs ?? [];
  const secs = (v: any) => (v ? Math.floor(new Date(v).getTime() / 1000) : 0);
  return txs
    .map((t) => {
      const tx = t.tx ?? {};
      const at = secs(tx.txAt);
      const end = secs(tx.listingEnd);
      return {
        txId: String(tx.txId ?? tx.txKey ?? ""),
        mint: String(tx.mintOnchainId ?? t.mint?.onchainId ?? ""),
        type: String(tx.txType ?? ""),
        price: Math.round(Number(tx.grossAmount ?? 0)), // lamports
        buyer: tx.buyerId ?? null,
        seller: tx.sellerId ?? null,
        source: tx.source ?? null,
        blockTime: Number.isFinite(at) ? at : 0,
        listingEnd: Number.isFinite(end) ? end : 0,
      } as HistTx;
    })
    .filter((x) => x.txId && x.mint)
    .sort((a, b) => b.blockTime - a.blockTime);
}

const setCollId = db.query("UPDATE collection SET tensor_coll_id = ? WHERE slug = ?");
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
  if (!collId) {
    // resolve from one of our minted NFTs; nothing minted = nothing yet
    const sample = db.query<{ asset: string }, [string]>("SELECT asset FROM slot WHERE slug = ? LIMIT 1").get(c.slug);
    if (!sample) return;
    collId = await resolveCollId(sample.asset);
    if (!collId) return; // Tensor does not index this collection yet
    setCollId.run(collId, c.slug);
  }
  const slots = db
    .query<{ asset: string; item_index: number }, [string]>("SELECT asset, item_index FROM slot WHERE slug = ?")
    .all(c.slug);
  const idxOf = new Map(slots.map((s) => [s.asset, s.item_index]));

  const hist = await fetchHistory(collId, 50);
  if (hist === null) return; // transient fetch error; keep the existing snapshot
  const now = nowSec();

  for (const h of hist) {
    if (h.type === "SALE_BUY_NOW" || h.type === "SALE_ACCEPT_BID") {
      if (h.price > 0) insSale.run(h.txId, c.slug, idxOf.get(h.mint) ?? null, h.mint, h.price, h.buyer, h.seller, h.source, h.blockTime);
    }
  }

  // Active listings = each mint's most recent state, kept when it is a live LIST
  // (or a price adjustment) that has not expired. Snapshot-replaced so sold or
  // delisted items drop out.
  const seen = new Set<string>();
  const active: { mint: string; price: number; seller: string | null; source: string | null }[] = [];
  for (const h of hist) {
    if (seen.has(h.mint)) continue;
    seen.add(h.mint);
    if ((h.type === "LIST" || h.type === "ADJUST_PRICE") && h.price > 0 && (h.listingEnd === 0 || h.listingEnd > now)) {
      active.push({ mint: h.mint, price: h.price, seller: h.seller, source: h.source });
    }
  }
  db.transaction(() => {
    delListings.run(c.slug);
    for (const l of active) insListing.run(c.slug, idxOf.get(l.mint) ?? null, l.mint, l.price, l.seller, l.source, now);
  })();
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

export function tensorDiag() {
  return {
    on: tensorOn(),
    base: config.tensorBase,
    lastPoll,
    lastError,
    collections: listCollections().map((c) => ({
      slug: c.slug,
      collId: c.tensor_coll_id,
      sales: saleCountQ.get(c.slug)?.n ?? 0,
      listings: listingCountQ.get(c.slug)?.n ?? 0,
    })),
  };
}
