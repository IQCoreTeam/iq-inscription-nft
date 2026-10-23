// Secondary-market sales, read from Tensor. Read-only and mainnet-scoped: the
// API key is rejected by the devnet host, so the poller only runs on mainnet.
// Everything here is a cache over on-chain sales; it never signs or spends, and
// the key stays in this process (never reaches a browser).
import { config } from "./config";
import { db } from "./db";
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

// Our Core collection mint -> Tensor collId. `voc` (verified on-chain collection)
// is the Core collection address; fall back to the by-mint lookup.
async function resolveCollId(coreCollection: string): Promise<string | null> {
  const a = await tj(`/collections/find_collection?${new URLSearchParams({ voc: coreCollection })}`);
  const id = a?.collId ?? a?.collection?.collId ?? a?.slug ?? a?.collection?.slug;
  if (id) return String(id);
  const b = await tj(`/mint/collection?${new URLSearchParams({ mints: coreCollection })}`);
  const fromMint = Array.isArray(b) ? b[0]?.collId ?? b[0]?.slug : b?.collections?.[0]?.collId ?? b?.[coreCollection]?.collId;
  return fromMint ? String(fromMint) : null;
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

const setCollId = db.query("UPDATE collection SET tensor_coll_id = ? WHERE slug = ?");
const insSale = db.query(
  "INSERT OR IGNORE INTO sale(tx_id,slug,item_index,asset,price,buyer,seller,source,block_time) VALUES(?,?,?,?,?,?,?,?,?)",
);

async function syncCollection(c: CollectionRow): Promise<void> {
  if (c.max_supply <= 0) return; // single registries have no item slots to match
  let collId = c.tensor_coll_id;
  if (!collId) {
    collId = await resolveCollId(c.core_collection);
    if (!collId) return; // Tensor does not index this collection yet
    setCollId.run(collId, c.slug);
  }
  const sales = await fetchSales(collId, 50);
  if (!sales.length) return;
  const slots = db
    .query<{ asset: string; item_index: number }, [string]>("SELECT asset, item_index FROM slot WHERE slug = ?")
    .all(c.slug);
  const idxOf = new Map(slots.map((s) => [s.asset, s.item_index]));
  for (const s of sales) {
    const idx = idxOf.get(s.mint);
    if (idx === undefined) continue; // a sale of some other collection's mint
    insSale.run(s.txId, c.slug, idx, s.mint, s.price, s.buyer, s.seller, s.source, s.blockTime);
  }
}

export async function syncAllSales(): Promise<void> {
  if (!tensorOn()) return;
  for (const c of listCollections()) {
    try {
      await syncCollection(c);
    } catch {
      /* best effort; a bad collection never stalls the rest */
    }
  }
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
  void syncAllSales();
  setInterval(() => void syncAllSales(), config.tensorPollMs);
}
