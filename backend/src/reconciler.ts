// The reconciler (every 5 min): make the local `slot` mirror match the chain
// and confirm reservations off what actually landed. The chain is the source of
// truth, so this is what makes a wiped database a restart: slots are rebuilt
// from ItemSlot accounts, not from our own memory. It never expires anything.

import { PublicKey } from "@solana/web3.js";
import { db } from "./db.ts";
import { listCollections, upsertSlot } from "./collections.ts";
import { fetchItemSlots, fetchRegistry } from "./program.ts";
import { markConfirmed } from "./reservations.ts";

const liveForItem = db.query<{ id: string }, [string, number]>(
  `SELECT id FROM reservation WHERE slug = ? AND item_index = ? AND state IN ('reserved','awaiting_submit')`
);
const countSlots = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM slot WHERE slug = ?");

export type ReconcileReport = { collections: number; slots: number; confirmed: number; divergent: string[] };

export async function reconcile(): Promise<ReconcileReport> {
  const report: ReconcileReport = { collections: 0, slots: 0, confirmed: 0, divergent: [] };
  for (const c of listCollections()) {
    if (c.max_supply === 0) continue; // single-NFT registries have no slots
    report.collections++;
    const registry = new PublicKey(c.registry);
    const slots = await fetchItemSlots(registry);
    for (const s of slots) {
      upsertSlot(c.slug, s);
      for (const r of liveForItem.all(c.slug, s.index)) {
        markConfirmed(r.id);
        report.confirmed++;
      }
    }
    report.slots += slots.length;
    const onChain = (await fetchRegistry(registry)).minted;
    const local = countSlots.get(c.slug)!.n;
    if (onChain !== local) {
      report.divergent.push(c.slug);
      console.error(`[reconciler] ${c.slug}: registry.minted=${onChain} but COUNT(slot)=${local}`);
    }
  }
  return report;
}
