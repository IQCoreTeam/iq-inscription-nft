import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { readPool } from "../protocol.mjs";
import {
  sealedAddresses,
  initializeSealedRelease,
  buySealedPack,
  openSealedPack,
  readSealedRelease,
  readSealedPack,
} from "../sealed.mjs";
const key = (n) => new PublicKey(new Uint8Array(32).fill(n)),
  program = key(1),
  collection = key(2),
  asset = key(3),
  holder = key(4),
  packCollection = key(5);
test("sealed instructions pin asset, collection, holder and exact reviewed money", () => {
  const init = initializeSealedRelease({
    program,
    collection,
    creator: holder,
    packCollection,
    supply: 20,
    name: "Test packs",
    uri: "https://example.com/pack.json",
  });
  assert.equal(init.data[0], 30);
  assert.equal(init.data.readUInt32LE(1), 20);
  const k = sealedAddresses(program, collection, asset),
    buy = buySealedPack({
      program,
      collection,
      buyer: holder,
      packCollection,
      asset,
      serial: 7,
      expectedTotal: 105000000,
    });
  assert.equal(buy.data[0], 31);
  assert.equal(buy.data.readUInt32LE(1), 7);
  assert.equal(buy.data.readBigUInt64LE(5), 105000000n);
  assert(buy.keys[5].pubkey.equals(k.receipt));
  assert(buy.keys[4].isSigner);
  const open = openSealedPack({
    program,
    collection,
    holder,
    packCollection,
    asset,
    epoch: 2,
    ticket: 3,
    expectedTotal: 105000000,
  });
  assert.equal(open.data[0], 32);
  assert.equal(open.data.readUInt16LE(1), 3);
  assert.equal(open.data.readBigUInt64LE(3), 105000000n);
  assert(open.keys[0].pubkey.equals(holder) && open.keys[0].isSigner);
  assert.equal(open.keys[4].isSigner, false);
});
test("invalid supplies, strings, amounts and ticket indices fail before any wallet call", () => {
  for (const extra of [
    { supply: 0 },
    { supply: 1.2 },
    { supply: 250001 },
    { name: "x".repeat(33) },
    { uri: "x".repeat(160) },
  ])
    assert.throws(() =>
      initializeSealedRelease({
        program,
        collection,
        creator: holder,
        packCollection,
        supply: 20,
        name: "Test packs",
        uri: "https://example.com",
        ...extra,
      }),
    );
  for (const expectedTotal of [0, -1, 1.1, NaN, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() =>
      buySealedPack({
        program,
        collection,
        buyer: holder,
        packCollection,
        asset,
        serial: 0,
        expectedTotal,
      }),
    );
  for (const ticket of [-1, 32, 1.2])
    assert.throws(() =>
      openSealedPack({
        program,
        collection,
        holder,
        packCollection,
        asset,
        epoch: 0,
        ticket,
        expectedTotal: 1,
      }),
    );
});
test("release and pack decoders reject malformed counter state and preserve prepaid u64", () => {
  const release = Buffer.alloc(320);
  release.write("NUBSEAL1");
  release.writeUInt32LE(20, 72);
  release.writeUInt32LE(7, 76);
  release.writeUInt32LE(2, 80);
  assert.deepEqual(
    [readSealedRelease(release).sealed, readSealedRelease(release).unminted],
    [5, 13],
  );
  release.writeUInt32LE(8, 80);
  assert.throws(() => readSealedRelease(release));
  const receipt = Buffer.alloc(160);
  receipt.write("NUBPACK1");
  receipt.writeBigUInt64LE(105000000n, 88);
  assert.equal(readSealedPack(receipt).paid, 105000000n);
  receipt[13] = 2;
  assert.throws(() => readSealedPack(receipt));
  assert.throws(() => readSealedPack(Buffer.alloc(159)));
});

test("sealed-only mode is exposed by the shared pool decoder", () => {
  const bytes = Buffer.alloc(4352);
  bytes.write("NUBSALE5");
  bytes.writeBigUInt64LE(100n, 200);
  bytes[253] = 1;
  assert.equal(readPool(bytes).sealedPacks, true);
  bytes[253] = 0;
  assert.equal(readPool(bytes).sealedPacks, false);
});

test("SOL labels preserve u64 precision instead of rounding marketplace asking prices", async () => {
  const { formatSolLamports } = await import("../protocol.mjs");
  assert.equal(formatSolLamports(105000000), "0.105");
  assert.equal(
    formatSolLamports(18446744073709551615n),
    "18446744073.709551615",
  );
  assert.throws(() => formatSolLamports(Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => formatSolLamports(-1));
});

test("sealed quote rejects an unfunded delivery reserve before wallet interaction", async () => {
  const { createSealedPackClient } = await import("../sealed-wallet.mjs");
  const { SystemProgram } = await import("@solana/web3.js");
  const k = sealedAddresses(program, collection),
    pool = Buffer.alloc(4352),
    release = Buffer.alloc(320);
  pool.write("NUBSALE5");
  collection.toBuffer().copy(pool, 40);
  pool.writeBigUInt64LE(100000000n, 200);
  pool[250] = 1;
  pool[253] = 1;
  release.write("NUBSEAL1");
  k.pool.toBuffer().copy(release, 8);
  release.writeUInt32LE(2, 72);
  let reserve = 0;
  const connection = {
    getGenesisHash: async () => "local-genesis",
    getMultipleAccountsInfoAndContext: async (keys) => {
      assert.equal(keys.length, 3);
      assert(keys[2].equals(k.ops));
      return {
        context: { slot: 1 },
        value: [
          { owner: program, data: pool },
          { owner: program, data: release },
          {
            owner: SystemProgram.programId,
            data: Buffer.alloc(0),
            lamports: reserve,
          },
        ],
      };
    },
  };
  const client = createSealedPackClient({
    connection,
    program,
    collection,
    chain: "solana:localnet",
    localGenesis: "local-genesis",
    pendingPurchases: {
      load: async () => null,
      save: async () => {},
      clear: async () => {},
    },
    notify: async () => {},
  });
  await assert.rejects(() => client.readSale(), /fund the delivery reserve/);
  reserve = 148000000;
  assert.equal((await client.readSale()).canPurchase, true);
  pool.writeBigUInt64LE(4n, 242);
  await assert.rejects(() => client.readSale(), /fund the delivery reserve/);
  connection.getAccountInfoAndContext = async () => {
    throw Error("epoch-read-reached");
  };
  const account = { address: holder.toBase58(), chains: ["solana:localnet"] };
  await assert.rejects(
    () => client.open({ wallet: { accounts: [account] }, account, asset }),
    /epoch-read-reached/,
  );
});
