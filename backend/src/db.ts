// SQLite state. A cache over the chain for everything that is on chain (slots,
// registry counters) and the only home for what is not: collection manifests,
// metadata templates, reservations, the shuffle seed. The partial unique index
// plus BEGIN IMMEDIATE in the allocator plus the on-chain ItemSlot PDA are the
// three layers against a double mint.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS collection (
  slug             TEXT PRIMARY KEY,
  core_collection  TEXT NOT NULL UNIQUE,
  registry         TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  creator          TEXT NOT NULL,   -- creator wallet = registry admin
  treasury         TEXT NOT NULL,
  max_supply       INTEGER NOT NULL, -- 0 = single-NFT registry (no items)
  price_lamports   INTEGER NOT NULL,
  deposit_lamports INTEGER NOT NULL,
  sequential       INTEGER NOT NULL DEFAULT 0, -- 1 = indices in order, 0 = shuffled
  shuffle_seed     TEXT NOT NULL,   -- 64 hex, SECRET until sellout
  shuffle_commit   TEXT NOT NULL,   -- sha256(seed) hex, committed on chain
  manifest_sig     TEXT NOT NULL,   -- base58 inscription of the manifest ('' for single registries)
  manifest_hash    TEXT NOT NULL,   -- sha256 hex of the manifest bytes
  meta_sig         TEXT NOT NULL,   -- base58 inscription of collection.json
  start_at         INTEGER NOT NULL DEFAULT 0,
  end_at           INTEGER NOT NULL DEFAULT 0, -- 0 = no end
  max_per_wallet   INTEGER NOT NULL DEFAULT 0, -- 0 = unlimited
  allowlist_only   INTEGER NOT NULL DEFAULT 0,
  cursor           INTEGER NOT NULL DEFAULT 0, -- allocator position in the permutation
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS item (
  slug          TEXT NOT NULL REFERENCES collection(slug),
  item_index    INTEGER NOT NULL,
  name          TEXT NOT NULL,
  image_sha256  TEXT NOT NULL,
  image_mime    TEXT NOT NULL,
  meta_sha256   TEXT NOT NULL,   -- sha256 of the template JSON bytes
  arweave_id    TEXT NOT NULL,
  template      TEXT NOT NULL,   -- metadata template JSON (name, description, attributes), no image
  PRIMARY KEY (slug, item_index)
);

CREATE TABLE IF NOT EXISTS allowlist (
  slug   TEXT NOT NULL REFERENCES collection(slug),
  wallet TEXT NOT NULL,
  PRIMARY KEY (slug, wallet)
);

CREATE TABLE IF NOT EXISTS reservation (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL,
  item_index      INTEGER NOT NULL,
  wallet          TEXT NOT NULL,   -- the user's wallet, becomes the asset owner
  burner          TEXT NOT NULL,   -- the user's burner, fee payer of C, M and the mint
  deposit_sig     TEXT,            -- the deposit transfer, one reservation per transfer
  state           TEXT NOT NULL,   -- reserved | awaiting_submit | confirmed | expired | rejected | cancelled
  inscription_sig TEXT,
  meta_sig        TEXT,
  asset           TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

-- One live reservation per item. Only 'reserved' can go back to the pool.
CREATE UNIQUE INDEX IF NOT EXISTS res_active_idx ON reservation(slug, item_index)
  WHERE state IN ('reserved','awaiting_submit','confirmed');
CREATE UNIQUE INDEX IF NOT EXISTS res_deposit_idx ON reservation(deposit_sig) WHERE deposit_sig IS NOT NULL;
CREATE INDEX IF NOT EXISTS res_wallet_idx ON reservation(slug, wallet);
CREATE INDEX IF NOT EXISTS res_state_idx ON reservation(state);

CREATE TABLE IF NOT EXISTS returned (
  slug        TEXT NOT NULL,
  item_index  INTEGER NOT NULL,
  returned_at INTEGER NOT NULL,
  PRIMARY KEY (slug, item_index)
);

-- Mirror of on-chain ItemSlot accounts (rebuilt by the reconciler).
CREATE TABLE IF NOT EXISTS slot (
  slug            TEXT NOT NULL,
  item_index      INTEGER NOT NULL,
  asset           TEXT NOT NULL,
  owner           TEXT NOT NULL,
  inscription_sig TEXT NOT NULL,
  meta_sig        TEXT NOT NULL,
  registered_at   INTEGER NOT NULL,
  PRIMARY KEY (slug, item_index)
);
`);

// Lightweight migrations for columns added after launch (idempotent; the live DB
// predates them). logo_sig / banner_sig are the inscriptions of the collection
// logo and banner, surfaced in collection.json and publicView.
for (const col of ["logo_sig TEXT", "banner_sig TEXT", "last_mint_at INTEGER NOT NULL DEFAULT 0"]) {
  try { db.exec(`ALTER TABLE collection ADD COLUMN ${col}`); } catch (e) { /* column already exists */ }
}

export type CollectionRow = {
  slug: string;
  core_collection: string;
  registry: string;
  name: string;
  symbol: string;
  description: string;
  creator: string;
  treasury: string;
  max_supply: number;
  price_lamports: number;
  deposit_lamports: number;
  sequential: number;
  shuffle_seed: string;
  shuffle_commit: string;
  manifest_sig: string;
  manifest_hash: string;
  meta_sig: string;
  start_at: number;
  end_at: number;
  max_per_wallet: number;
  allowlist_only: number;
  cursor: number;
  created_at: number;
  logo_sig: string | null;
  banner_sig: string | null;
  last_mint_at: number;
};

export type ItemRow = {
  slug: string;
  item_index: number;
  name: string;
  image_sha256: string;
  image_mime: string;
  meta_sha256: string;
  arweave_id: string;
  template: string;
};

export type ReservationRow = {
  id: string;
  slug: string;
  item_index: number;
  wallet: string;
  burner: string;
  deposit_sig: string | null;
  state: string;
  inscription_sig: string | null;
  meta_sig: string | null;
  asset: string | null;
  created_at: number;
  expires_at: number;
};

export const nowSec = () => Math.floor(Date.now() / 1000);
