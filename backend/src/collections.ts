// Collections and their items, as stored at deploy time. The permutation is
// derived from the secret seed once per process and cached.

import { config } from "./config.ts";
import { db, nowSec, type CollectionRow, type ItemRow } from "./db.ts";
import { derivePermutation } from "./shuffle.ts";
import type { OnChainSlot } from "./program.ts";

const bySlug = db.query<CollectionRow, [string]>("SELECT * FROM collection WHERE slug = ?");
// Bump order (pump.fun style) by latest activity: a mint or a launch, whichever
// is newer. Ordering by mints alone sank every fresh launch below collections
// that had ever minted, so creators could not find what they just deployed.
const all = db.query<CollectionRow, []>("SELECT * FROM collection ORDER BY MAX(last_mint_at, created_at) DESC, created_at DESC");
const slotExistsStmt = db.query<{ one: number }, [string, number]>("SELECT 1 AS one FROM slot WHERE slug = ? AND item_index = ?");
const bumpMintStmt = db.query("UPDATE collection SET last_mint_at = ?2 WHERE slug = ?1");
const ownersStmt = db.query<{ n: number }, [string]>("SELECT COUNT(DISTINCT owner) AS n FROM slot WHERE slug = ?");
const itemOf = db.query<ItemRow, [string, number]>("SELECT * FROM item WHERE slug = ? AND item_index = ?");
const mintedOf = db.query<{ item_index: number }, [string]>("SELECT item_index FROM slot WHERE slug = ? ORDER BY item_index");
const latestMintOf = db.query<{ inscription_sig: string }, [string]>("SELECT inscription_sig FROM slot WHERE slug = ? ORDER BY registered_at DESC, item_index DESC LIMIT 1");

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

// registered_at = when this backend first saw the mint. The bitmap design keeps
// no per-item time on chain, so "first seen" is the only honest timestamp: the
// feed's WHEN column and the collection bump both come from it. A later upsert
// (reconciler re-scan) never overwrites a time already recorded.
const upsertSlotStmt = db.query(
  `INSERT INTO slot (slug, item_index, asset, owner, inscription_sig, meta_sig, registered_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
   ON CONFLICT(slug, item_index) DO UPDATE SET
     asset = ?3, owner = ?4, inscription_sig = ?5, meta_sig = ?6,
     registered_at = CASE WHEN slot.registered_at > 0 THEN slot.registered_at ELSE ?7 END`
);
// Mirror one on-chain slot into the DB (reconciler, and the allocator when it
// discovers a minted index the DB did not know about).
export function upsertSlot(slug: string, s: OnChainSlot): void {
  // A newly seen mint bumps the collection to the top of the feed (cheap: one
  // existence check + one timestamp update, only on genuinely new mints).
  const isNew = !slotExistsStmt.get(slug, s.index);
  const seenAt = nowSec();
  upsertSlotStmt.run(slug, s.index, s.asset, s.owner, s.inscriptionSig, s.metaSig, s.registeredAt || seenAt);
  if (isNew) bumpMintStmt.run(slug, seenAt);
}

export function ownersOf(slug: string): number {
  return ownersStmt.get(slug)?.n ?? 0;
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
    owners: ownersOf(c.slug), // distinct owners (from the slot mirror; cheap)
    lastMintAt: c.last_mint_at, // first-seen time of the newest mint (bump order + the HOT chip)
    chain: "solana",
    // volume + floor live on secondary marketplaces (ME/Tensor), which we do not
    // index, so the client shows them as "-". everything else is from our data.
    // Collection logo + banner (inscribed by the creator), as gateway image URLs.
    logo: c.logo_sig ? `${config.gatewayBase}/img/${c.logo_sig}.png` : null,
    banner: c.banner_sig ? `${config.gatewayBase}/img/${c.banner_sig}.png` : null,
    // A representative cover = the newest minted item's inscription (the client
    // renders it through the gateway). Unminted art is never shown: the card
    // falls back to a sealed tile when nothing is minted and no banner/logo is set.
    coverSig: latestMintOf.get(c.slug)?.inscription_sig ?? null,
    // Where the client fetches an item's bytes before inscribing (C). The
    // backend owns the cluster (devnet.irys.xyz vs gateway.irys.xyz), so it
    // tells the client rather than the client guessing.
    arweaveGateway: config.arweaveGateway,
  };
}
