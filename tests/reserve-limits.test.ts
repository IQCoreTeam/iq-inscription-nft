import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";

const directory = mkdtempSync(join(tmpdir(), "iq-nft-reserve-"));
mock.module("../backend/src/config.ts", () => ({
  config: {
    dbPath: join(directory, "nft.sqlite"),
    maxOpenReservationsPerWallet: 3,
    reservationTtlSeconds: 600,
    depositMaxAgeSeconds: 900,
    rpcUrls: ["http://127.0.0.1:1"],
  },
}));
let arrived = 0;
let depositReads = 0;
const deposits = new Map<string, any>();
mock.module("../backend/src/rpcpool.ts", () => ({
  withConnection: async (fn: any) => fn({
    getParsedTransaction: async (signature: string) => {
      depositReads++;
      return deposits.get(signature) ?? null;
    },
  }),
}));
let mintedBitmap = new Uint8Array(2);
let release!: () => void;
let gate: Promise<void> = Promise.resolve();
mock.module("../backend/src/program.ts", () => ({
  fetchRegistry: async () => {
    arrived++;
    await gate;
    return { bitmap: mintedBitmap };
  },
  isMinted: (bitmap: Uint8Array, index: number) =>
    ((bitmap[(index - 1) >> 3] ?? 0) & (1 << ((index - 1) & 7))) !== 0,
}));

const { db } = await import("../backend/src/db.ts");
const { reserve } = await import("../backend/src/allocator.ts");
const { getReservation, markAwaitingSubmit, markConfirmed, markCancelled, markExpired, markRejected } =
  await import("../backend/src/reservations.ts");
const wallet = Keypair.generate().publicKey.toBase58();
const burner = Keypair.generate().publicKey.toBase58();
const seed = Buffer.alloc(32).toString("hex");

function addCollection(slug: string, maxPerWallet: number, deposit = 0) {
  db.query(
    `INSERT INTO collection
    (slug,core_collection,registry,name,symbol,creator,treasury,max_supply,price_lamports,deposit_lamports,
     sequential,shuffle_seed,shuffle_commit,manifest_sig,manifest_hash,meta_sig,max_per_wallet,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    slug,
    Keypair.generate().publicKey.toBase58(),
    Keypair.generate().publicKey.toBase58(),
    "Local",
    "LOCAL",
    wallet,
    wallet,
    10,
    deposit,
    deposit,
    1,
    seed,
    "commit",
    "manifest",
    "hash",
    "metadata",
    maxPerWallet,
    1,
  );
  const row = db
    .query("SELECT * FROM collection WHERE slug = ?")
    .get(slug) as any;
  const insert =
    db.query(`INSERT INTO item (slug,item_index,name,image_sha256,image_mime,meta_sha256,arweave_id,template)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (let i = 1; i <= 10; i++)
    insert.run(
      slug,
      i,
      `Item ${i}`,
      "hash",
      "image/png",
      "hash",
      `local-${i}`,
      "{}",
    );
  return row;
}

function addDeposit(signature: string, treasury: string) {
  deposits.set(signature, {
    meta: { err: null }, blockTime: Math.floor(Date.now() / 1000),
    transaction: { message: { instructions: [{
      program: "system", parsed: { type: "transfer", info: {
        source: burner, destination: treasury, lamports: 100,
      } },
    }] } },
  });
}

async function concurrent(
  slug: string,
  count: number,
  maxPerWallet: number,
  who: string,
) {
  const row = addCollection(slug, maxPerWallet);
  arrived = 0;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = Array.from({ length: count }, () =>
    reserve(row, who, burner, null),
  );
  for (let i = 0; i < 100 && arrived < count; i++) await Bun.sleep(1);
  expect(arrived).toBe(count);
  release();
  return Promise.allSettled(pending);
}

afterAll(() => {
  if (db.inTransaction) db.exec("ROLLBACK");
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test("concurrent reservations respect per-wallet and open-reservation limits", async () => {
    const same = await concurrent("limited", 2, 1, wallet);
    expect(same.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(same.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(same.find((r) => r.status === "rejected")?.reason.status).toBe(403);
    expect(db.query("SELECT cursor FROM collection WHERE slug = 'limited'").get()).toEqual({ cursor: 1 });
    const otherWallet = Keypair.generate().publicKey.toBase58();
    const open = await concurrent("open", 4, 0, otherWallet);
    expect(open.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(open.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(open.find((r) => r.status === "rejected")?.reason.status).toBe(429);
    // The global open cap also applies when the next request targets another collection.
    const another = addCollection("another", 0);
    await expect(reserve(another, otherWallet, burner, null)).rejects.toMatchObject({ status: 429 });
    expect(db.query("SELECT cursor FROM collection WHERE slug = 'another'").get()).toEqual({ cursor: 0 });
    // A different wallet can still reserve independently.
    expect((await reserve(another, Keypair.generate().publicKey.toBase58(), burner, null)).index).toBe(1);

    mintedBitmap = new Uint8Array([3, 0]); // #1 and #2 sold on chain, absent from SQLite
    const stale = addCollection("stale", 1);
    const recovered = await reserve(stale, wallet, burner, null);
    expect(recovered.index).toBe(3);
    mintedBitmap = new Uint8Array(2);

    const lifecycleWallet = Keypair.generate().publicKey.toBase58();
    const lifecycle = addCollection("lifecycle", 1);
    const held = await reserve(lifecycle, lifecycleWallet, burner, null);
    markAwaitingSubmit(held.reservationId, "inscription", "metadata", "asset");
    await expect(reserve(lifecycle, lifecycleWallet, burner, null)).rejects.toMatchObject({ status: 403 });
    markConfirmed(held.reservationId);
    await expect(reserve(lifecycle, lifecycleWallet, burner, null)).rejects.toMatchObject({ status: 403 });

    // Release transitions return the index and free quota without moving the cursor.
    const releaseCollection = addCollection("released", 1);
    const releaseWallet = Keypair.generate().publicKey.toBase58();
    let released = await reserve(releaseCollection, releaseWallet, burner, null);
    for (const release of [markCancelled, markExpired, markRejected]) {
      release(getReservation(released.reservationId)!);
      released = await reserve(releaseCollection, releaseWallet, burner, null);
      expect(released.index).toBe(1);
    }
    expect(db.query("SELECT cursor FROM collection WHERE slug = 'released'").get()).toEqual({ cursor: 1 });
    expect(db.inTransaction).toBe(false);
});

test("paid recovery skips sold items without spending the deposit on placeholders", async () => {
  const paidWallet = Keypair.generate().publicKey.toBase58();
  const c = addCollection("paid", 1, 100);
  addDeposit("paid-transfer", c.treasury);
  mintedBitmap = new Uint8Array([3, 0]);
  const reads = depositReads;
  const held = await reserve(c, paidWallet, burner, "paid-transfer");
  expect(held.index).toBe(3);
  expect(depositReads - reads).toBe(1);
  expect(db.query(`SELECT item_index, state, deposit_sig, inscription_sig
    FROM reservation WHERE slug = 'paid' ORDER BY item_index`).all()).toEqual([
    { item_index: 1, state: "confirmed", deposit_sig: null, inscription_sig: null },
    { item_index: 2, state: "confirmed", deposit_sig: null, inscription_sig: null },
    { item_index: 3, state: "reserved", deposit_sig: "paid-transfer", inscription_sig: null },
  ]);
  mintedBitmap = new Uint8Array(2);
  markCancelled(getReservation(held.reservationId)!);
  await expect(reserve(c, paidWallet, burner, "paid-transfer")).rejects.toMatchObject({ status: 409 });
  expect(db.query("SELECT item_index FROM returned WHERE slug = 'paid'").all()).toEqual([{ item_index: 3 }]);
  expect(db.inTransaction).toBe(false);
});

test("paid recovery removes sold returned items and retains the deposit on the usable item", async () => {
  const c = addCollection("paid-returned", 1, 100);
  db.query("UPDATE collection SET cursor = 2 WHERE slug = ?").run(c.slug);
  db.query("INSERT INTO returned VALUES (?, 1, 1)").run(c.slug);
  addDeposit("returned-transfer", c.treasury);
  mintedBitmap = new Uint8Array([1, 0]);
  const held = await reserve(c, Keypair.generate().publicKey.toBase58(), burner, "returned-transfer");
  expect(held.index).toBe(3);
  expect(db.query("SELECT * FROM returned WHERE slug = ?").all(c.slug)).toEqual([]);
  expect(db.query("SELECT state, deposit_sig FROM reservation WHERE slug = ? ORDER BY item_index").all(c.slug)).toEqual([
    { state: "confirmed", deposit_sig: null },
    { state: "reserved", deposit_sig: "returned-transfer" },
  ]);
  mintedBitmap = new Uint8Array(2);
});

test("sold-out bitmap recovery preserves sold holds without consuming the supplied deposit", async () => {
  const c = addCollection("paid-sold-out", 1, 100);
  addDeposit("unused-transfer", c.treasury);
  mintedBitmap = new Uint8Array([255, 3]);
  const who = Keypair.generate().publicKey.toBase58();
  await expect(reserve(c, who, burner, "unused-transfer")).rejects.toMatchObject({ status: 409 });
  expect(db.query("SELECT COUNT(*) AS n FROM reservation WHERE slug = ? AND state = 'confirmed' AND deposit_sig IS NULL").get(c.slug)).toEqual({ n: 10 });
  expect(db.query("SELECT cursor FROM collection WHERE slug = ?").get(c.slug)).toEqual({ cursor: 10 });
  expect(db.query("SELECT COUNT(*) AS n FROM reservation WHERE deposit_sig = 'unused-transfer'").get()).toEqual({ n: 0 });
  expect(db.inTransaction).toBe(false);
  mintedBitmap = new Uint8Array(2);
  const available = addCollection("paid-still-available", 1, 100);
  expect((await reserve(available, who, burner, "unused-transfer")).index).toBe(1);
});

test("cancelled expired and rejected paid reservations never permit deposit replay", async () => {
  mintedBitmap = new Uint8Array(2);
  for (const [state, release] of [["cancelled", markCancelled], ["expired", markExpired], ["rejected", markRejected]] as const) {
    const c = addCollection("paid-" + state, 1, 100);
    const signature = state + "-transfer";
    addDeposit(signature, c.treasury);
    const who = Keypair.generate().publicKey.toBase58();
    const held = await reserve(c, who, burner, signature);
    release(getReservation(held.reservationId)!);
    await expect(reserve(c, who, burner, signature)).rejects.toMatchObject({ status: 409 });
    expect(getReservation(held.reservationId)!.deposit_sig).toBe(signature);
    expect(db.query("SELECT cursor FROM collection WHERE slug = ?").get(c.slug)).toEqual({ cursor: 1 });
    expect(db.query("SELECT item_index FROM returned WHERE slug = ?").all(c.slug)).toEqual([{ item_index: 1 }]);
  }
});

test("concurrent paid requests consume one transfer once and return a controlled conflict", async () => {
  const c = addCollection("paid-concurrent", 0, 100);
  addDeposit("racing-transfer", c.treasury);
  mintedBitmap = new Uint8Array([1, 0]);
  arrived = 0;
  gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = [0, 1].map(() => reserve(c, Keypair.generate().publicKey.toBase58(), burner, "racing-transfer"));
  for (let i = 0; i < 100 && arrived < 2; i++) await Bun.sleep(1);
  expect(arrived).toBe(2);
  release();
  const results = await Promise.allSettled(pending);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")?.reason.status).toBe(409);
  expect(db.query("SELECT COUNT(*) AS n FROM reservation WHERE deposit_sig = 'racing-transfer'").get()).toEqual({ n: 1 });
  expect(db.query("SELECT cursor FROM collection WHERE slug = ?").get(c.slug)).toEqual({ cursor: 2 });
  expect(db.inTransaction).toBe(false);
  mintedBitmap = new Uint8Array(2);
});

test("paid requests still reject missing failed stale and underpaid transfers before allocation", async () => {
  const c = addCollection("paid-invalid", 0, 100);
  const who = Keypair.generate().publicKey.toBase58();
  await expect(reserve(c, who, burner, null)).rejects.toMatchObject({ status: 400 });
  await expect(reserve(c, who, burner, "unknown-transfer")).rejects.toMatchObject({ status: 404 });
  for (const kind of ["failed", "stale", "underpaid", "wrong-source", "wrong-treasury"]) {
    addDeposit(kind, c.treasury);
    const tx = deposits.get(kind);
    const info = tx.transaction.message.instructions[0].parsed.info;
    if (kind === "failed") tx.meta.err = "failed";
    if (kind === "stale") tx.blockTime -= 901;
    if (kind === "underpaid") info.lamports = 99;
    if (kind === "wrong-source") info.source = who;
    if (kind === "wrong-treasury") info.destination = who;
    await expect(reserve(c, who, burner, kind)).rejects.toMatchObject({ status: 400 });
  }
  expect(db.query("SELECT cursor FROM collection WHERE slug = ?").get(c.slug)).toEqual({ cursor: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM reservation WHERE slug = ?").get(c.slug)).toEqual({ n: 0 });
});
