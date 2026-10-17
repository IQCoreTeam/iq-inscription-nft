// Reservation lifecycle transitions. The allocator creates rows in `reserved`;
// everything past that lives here so the state machine has one home. Which
// transitions return an index to the pool: `reserved` -> expired, rejected,
// cancelled. Nothing else ever pools an index.

import { db, nowSec, type ReservationRow } from "./db.ts";
import { config } from "./config.ts";

const byId = db.query<ReservationRow, [string]>("SELECT * FROM reservation WHERE id = ?");
const returnToPoolStmt = db.query("INSERT OR IGNORE INTO returned (slug, item_index, returned_at) VALUES (?1, ?2, ?3)");
const toAwaiting = db.query(
  "UPDATE reservation SET state = 'awaiting_submit', inscription_sig = ?2, meta_sig = ?3, asset = ?4 WHERE id = ?1"
);
const toConfirmed = db.query("UPDATE reservation SET state = 'confirmed' WHERE id = ?1");
const toRejected = db.query("UPDATE reservation SET state = 'rejected' WHERE id = ?1");
const toExpired = db.query("UPDATE reservation SET state = 'expired' WHERE id = ?1");
const toCancelled = db.query("UPDATE reservation SET state = 'cancelled' WHERE id = ?1");
const extendExpiry = db.query("UPDATE reservation SET expires_at = ?2 WHERE id = ?1 AND state = 'reserved'");

export function getReservation(id: string): ReservationRow | null {
  return byId.get(id) ?? null;
}

export function markAwaitingSubmit(id: string, inscriptionSig: string, metaSig: string, asset: string): void {
  toAwaiting.run(id, inscriptionSig, metaSig, asset);
}

export function markConfirmed(id: string): void {
  toConfirmed.run(id);
}

function releaseToPool(setState: typeof toExpired, r: ReservationRow): void {
  db.run("BEGIN IMMEDIATE");
  try {
    setState.run(r.id);
    returnToPoolStmt.run(r.slug, r.item_index, nowSec());
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}

// Verification failed: the index goes back to the pool. The deposit stays with the creator.
export function markRejected(r: ReservationRow): void {
  releaseToPool(toRejected, r);
}

// TTL elapsed and no slot landed on chain: back to the pool.
export function markExpired(r: ReservationRow): void {
  releaseToPool(toExpired, r);
}

// User gave up a still-`reserved` item. No refund; the index is freed now
// instead of waiting for the reaper.
export function markCancelled(r: ReservationRow): void {
  releaseToPool(toCancelled, r);
}

// Re-arm the expiry fuse the moment the user actually starts inscribing, so a
// long upload is never raced by the reaper.
export function touchReservation(id: string): number | null {
  const expiresAt = nowSec() + config.reservationTtlSeconds;
  const res = extendExpiry.run(id, expiresAt);
  return res.changes > 0 ? expiresAt : null;
}
