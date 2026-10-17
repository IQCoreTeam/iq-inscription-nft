// The reconciler (every 5 min): make the local `slot` mirror match the chain
// and confirm reservations off what actually landed. The registry's minted
// bitmap is the chain's sold set; the collection's assets (read from mpl-core)
// give each sold index its asset, owner, C and M. The chain is the source of
// truth, so a wiped database is a restart. It never expires anything.

import { PublicKey } from "@solana/web3.js";
import { db } from "./db.ts";
import { listCollections, upsertSlot } from "./collections.ts";
import { fetchCollectionAssets, fetchRegistry, mintedIndicesOf } from "./program.ts";
import { markConfirmed } from "./reservations.ts";

const liveForItem = db.query<{ id: string }, [string, number]>(
  `SELECT id FROM reservation WHERE slug = ? AND item_index = ? AND state IN ('reserved','awaiting_submit')`
);
const countSlots = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM slot WHERE slug = ?");

export type ReconcileReport = { collections: number; slots: number; confirmed: number; divergent: string[] };

export async function reconcile(): Promise<ReconcileReport> {
  const report: ReconcileReport = { collections: 0, slots: 0, confirmed: 0, divergent: [] };
  for (const c of listCollections()) {
    if (c.max_supply === 0) continue; // single-NFT registries have no numbers
    report.collections++;
    const reg = await fetchRegistry(new PublicKey(c.registry));
    const sold = mintedIndicesOf(reg.bitmap, reg.maxSupply);
    for (const index of sold) {
      for (const r of liveForItem.all(c.slug, index)) {
        markConfirmed(r.id);
        report.confirmed++;
      }
    }
    const assets = await fetchCollectionAssets(new PublicKey(c.core_collection));
    for (const a of assets) upsertSlot(c.slug, a);
    report.slots += assets.length;
    const local = countSlots.get(c.slug)!.n;
    if (sold.length !== reg.minted || assets.length !== sold.length || local !== sold.length) {
      report.divergent.push(c.slug);
      console.error(`[reconciler] ${c.slug}: bitmap=${sold.length} registry.minted=${reg.minted} assets=${assets.length} mirror=${local}`);
    }
  }
  return report;
}
