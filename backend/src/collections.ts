// Collections and their items, as stored at deploy time. The permutation is
// derived from the secret seed once per process and cached.

import { db, type CollectionRow, type ItemRow } from "./db.ts";
import { derivePermutation } from "./shuffle.ts";
import type { OnChainSlot } from "./program.ts";

const bySlug = db.query<CollectionRow, [string]>("SELECT * FROM collection WHERE slug = ?");
const all = db.query<CollectionRow, []>("SELECT * FROM collection ORDER BY created_at DESC");
const itemOf = db.query<ItemRow, [string, number]>("SELECT * FROM item WHERE slug = ? AND item_index = ?");
const mintedOf = db.query<{ item_index: number }, [string]>("SELECT item_index FROM slot WHERE slug = ? ORDER BY item_index");

export function getCollection(slug: string): CollectionRow | null {
  return bySlug.get(slug) ?? null;
}

export function listCollections(): CollectionRow[] {
  return all.all();
}

export function getItem(slug: string, index: number): ItemRow | null {
  return itemOf.get(slug, index) ?? null;
}

export function mintedIndices(slug: string): number[] {
  return mintedOf.all(slug).map((r) => r.item_index);
}

const upsertSlotStmt = db.query(
  `INSERT INTO slot (slug, item_index, asset, owner, inscription_sig, meta_sig, registered_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
   ON CONFLICT(slug, item_index) DO UPDATE SET
     asset = ?3, owner = ?4, inscription_sig = ?5, meta_sig = ?6, registered_at = ?7`
);
// Mirror one on-chain slot into the DB (reconciler, and the allocator when it
// discovers a minted index the DB did not know about).
export function upsertSlot(slug: string, s: OnChainSlot): void {
  upsertSlotStmt.run(slug, s.index, s.asset, s.owner, s.inscriptionSig, s.metaSig, s.registeredAt);
}

const permutations = new Map<string, number[]>();
export function permutationOf(c: CollectionRow): number[] {
  let p = permutations.get(c.slug);
  if (!p) {
    p = c.sequential
      ? Array.from({ length: c.max_supply }, (_, k) => k + 1)
      : derivePermutation(Buffer.from(c.shuffle_seed, "hex"), c.max_supply);
    permutations.set(c.slug, p);
  }
  return p;
}

// Public view: everything a minting page needs, nothing secret.
export function publicView(c: CollectionRow) {
  return {
    slug: c.slug,
    collection: c.core_collection,
    registry: c.registry,
    name: c.name,
    symbol: c.symbol,
    description: c.description,
    creator: c.creator,
    maxSupply: c.max_supply,
    priceLamports: c.price_lamports,
    depositLamports: c.deposit_lamports,
    treasury: c.treasury,
    sequential: c.sequential === 1,
    shuffleCommit: c.shuffle_commit,
    manifestSig: c.manifest_sig,
    metaSig: c.meta_sig,
    startAt: c.start_at,
    endAt: c.end_at,
    maxPerWallet: c.max_per_wallet,
    allowlistOnly: c.allowlist_only === 1,
    minted: mintedIndices(c.slug).length,
  };
}
