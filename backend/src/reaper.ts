// The reaper (every 60s): return abandoned items to the pool. Before expiring a
// reservation it checks the chain for the item's slot: a register tx we
// co-signed may have landed after our last look. A slot on chain means the mint
// happened (confirm it); no slot means the index is free again. The deposit is
// not refunded either way.

import { PublicKey } from "@solana/web3.js";
import { db, nowSec, type ReservationRow } from "./db.ts";
import { config } from "./config.ts";
import { getCollection } from "./collections.ts";
import { slotExists } from "./program.ts";
import { markConfirmed, markExpired } from "./reservations.ts";

// `reserved` past TTL + slack, and `awaiting_submit` (co-signed, never seen to
// land) past TTL + a long slack: a co-signed tx dies with its blockhash in ~90s,
// so after several minutes an unlanded one is abandoned.
const expired = db.query<ReservationRow, [number, number]>(
  `SELECT * FROM reservation
    WHERE (state = 'reserved' AND expires_at < ?1)
       OR (state = 'awaiting_submit' AND expires_at < ?2)`
);

export type ReapReport = { checked: number; confirmed: number; expired: number };

export async function reap(): Promise<ReapReport> {
  const now = nowSec();
  const rows = expired.all(now - config.reaperSlackSeconds, now - config.reaperSlackSeconds - config.reservationTtlSeconds);
  let confirmed = 0;
  let released = 0;
  for (const r of rows) {
    const c = getCollection(r.slug);
    if (!c) continue;
    let landed: boolean;
    try {
      landed = await slotExists(new PublicKey(c.registry), r.item_index);
    } catch {
      continue; // rpc down: cannot tell, leave it for the next tick
    }
    if (landed) {
      markConfirmed(r.id);
      confirmed++;
    } else {
      markExpired(r);
      released++;
    }
  }
  return { checked: rows.length, confirmed, expired: released };
}
