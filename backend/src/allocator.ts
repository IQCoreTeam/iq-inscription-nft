// The allocator: hand out an item, locking it before the user inscribes.
// Returned indices are served before the shuffle cursor advances, so a released
// item is reused, not skipped. Three layers stop a double allocation: BEGIN
// IMMEDIATE serializes concurrent reserves, the partial unique index rejects a
// second live row for an item, and the on-chain ItemSlot init is the backstop.
//
// The deposit: a plain transfer from the user's burner to the creator treasury,
// landed before the index is revealed. One transfer backs exactly one
// reservation (unique column). It is what makes "draw, look, cancel" cost money.

import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { db, nowSec, type CollectionRow } from "./db.ts";
import { config } from "./config.ts";
import { getItem, permutationOf } from "./collections.ts";
import { withConnection } from "./rpcpool.ts";
import { fetchRegistry, isMinted } from "./program.ts";
import { markConfirmed } from "./reservations.ts";

export class ReserveError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const openByWallet = db.query<{ n: number }, [string]>(
  `SELECT COUNT(*) AS n FROM reservation WHERE wallet = ? AND state IN ('reserved','awaiting_submit')`
);
const heldInCollection = db.query<{ n: number }, [string, string]>(
  `SELECT COUNT(*) AS n FROM reservation WHERE slug = ? AND wallet = ? AND state IN ('reserved','awaiting_submit','confirmed')`
);
const onAllowlist = db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM allowlist WHERE slug = ? AND wallet = ?");
const depositUsed = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM reservation WHERE deposit_sig = ?");
const takeReturned = db.query<{ item_index: number }, [string]>(
  "SELECT item_index FROM returned WHERE slug = ? ORDER BY returned_at LIMIT 1"
);
const deleteReturned = db.query("DELETE FROM returned WHERE slug = ? AND item_index = ?");
const getCursor = db.query<{ cursor: number }, [string]>("SELECT cursor FROM collection WHERE slug = ?");
const setCursor = db.query("UPDATE collection SET cursor = ?2 WHERE slug = ?1");
const insertReservation = db.query(
  `INSERT INTO reservation (id, slug, item_index, wallet, burner, deposit_sig, state, created_at, expires_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'reserved', ?7, ?8)`
);

export type Reservation = {
  reservationId: string;
  index: number;
  name: string;
  arweaveId: string;
  imageSha256: string;
  imageMime: string;
  expiresAt: number;
};

function checkEligibility(c: CollectionRow, wallet: string): void {
  const now = nowSec();
  if (c.start_at && now < c.start_at) throw new ReserveError(403, "mint has not started");
  if (c.end_at && now > c.end_at) throw new ReserveError(403, "mint has ended");
  if (c.allowlist_only && (onAllowlist.get(c.slug, wallet)?.n ?? 0) === 0) {
    throw new ReserveError(403, "wallet is not on the allowlist");
  }
  if (c.max_per_wallet && (heldInCollection.get(c.slug, wallet)?.n ?? 0) >= c.max_per_wallet) {
    throw new ReserveError(403, `wallet already holds ${c.max_per_wallet} in this collection`);
  }
  if ((openByWallet.get(wallet)?.n ?? 0) >= config.maxOpenReservationsPerWallet) {
    throw new ReserveError(429, `wallet already has ${config.maxOpenReservationsPerWallet} open reservations`);
  }
}

// The deposit transfer must be a landed system transfer burner -> treasury of at
// least the configured amount, recent, and not already spent on a reservation.
async function checkDeposit(c: CollectionRow, burner: string, depositSig: string | null): Promise<void> {
  if (c.deposit_lamports === 0) return;
  if (!depositSig) throw new ReserveError(400, "depositSig required");
  if ((depositUsed.get(depositSig)?.n ?? 0) > 0) throw new ReserveError(409, "deposit already used");
  const tx = await withConnection(
    (cn) => cn.getParsedTransaction(depositSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }),
    { retableOnNull: true }
  );
  if (!tx) throw new ReserveError(404, "deposit transaction not found");
  if (tx.meta?.err) throw new ReserveError(400, "deposit transaction failed on chain");
  if ((tx.blockTime ?? 0) < nowSec() - config.depositMaxAgeSeconds) throw new ReserveError(400, "deposit transaction too old");
  const ok = tx.transaction.message.instructions.some((ix: any) => {
    const p = ix.parsed;
    return (
      ix.program === "system" &&
      p?.type === "transfer" &&
      p.info.source === burner &&
      p.info.destination === c.treasury &&
      Number(p.info.lamports) >= c.deposit_lamports
    );
  });
  if (!ok) throw new ReserveError(400, `deposit must transfer at least ${c.deposit_lamports} lamports from the burner to ${c.treasury}`);
}

export async function reserve(c: CollectionRow, wallet: string, burner: string, depositSig: string | null): Promise<Reservation> {
  if (c.max_supply === 0) throw new ReserveError(400, "this collection has no items to reserve");
  new PublicKey(wallet);
  new PublicKey(burner);
  checkEligibility(c, wallet);
  await checkDeposit(c, burner, depositSig);

  const permutation = permutationOf(c);
  // The registry's minted bitmap is the chain's own sold list: one account read
  // per reservation. An index whose bit is set (the DB was rolled back, or a
  // mint happened around the backend) is held as confirmed so it is never
  // offered again, and the next one is taken; the reconciler fills in its asset.
  const { bitmap } = await fetchRegistry(new PublicKey(c.registry));
  let id: string;
  let index: number;
  let expiresAt: number;
  for (;;) {
    const now = nowSec();
    expiresAt = now + config.reservationTtlSeconds;
    id = randomUUID();
    db.run("BEGIN IMMEDIATE");
    try {
      const returned = takeReturned.get(c.slug);
      if (returned) {
        index = returned.item_index;
        deleteReturned.run(c.slug, index);
      } else {
        const cursor = getCursor.get(c.slug)!.cursor;
        if (cursor >= c.max_supply) throw new ReserveError(409, "sold out: every item is reserved or minted");
        index = permutation[cursor];
        setCursor.run(c.slug, cursor + 1);
      }
      insertReservation.run(id, c.slug, index, wallet, burner, c.deposit_lamports ? depositSig : null, now, expiresAt);
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
    if (!isMinted(bitmap, index)) break;
    console.warn(`[reserve] ${c.slug} #${index} is already minted on chain but the DB did not know; holding and skipping`);
    markConfirmed(id);
  }

  const item = getItem(c.slug, index)!;
  return {
    reservationId: id,
    index,
    name: item.name,
    arweaveId: item.arweave_id,
    imageSha256: item.image_sha256,
    imageMime: item.image_mime,
    expiresAt,
  };
}
