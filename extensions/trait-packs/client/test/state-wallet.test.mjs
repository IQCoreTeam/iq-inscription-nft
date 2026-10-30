import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { createWardrobeReader } from "../state.mjs";
import { compatibleWallets, createWalletSession } from "../wallet.mjs";
import { addresses } from "../protocol.mjs";

test("reader batches pool/loadout and coalesces in-flight reads until completion", async () => {
  const program = Keypair.generate().publicKey,
    collection = Keypair.generate().publicKey,
    avatar = Keypair.generate().publicKey,
    k = addresses(program, collection);
  const pool = Buffer.alloc(4352);
  pool.write("NUBSALE4");
  collection.toBuffer().copy(pool, 40);
  pool[209] = 4;
  const load = Buffer.alloc(312);
  load.write("NUBLOAD4");
  avatar.toBuffer().copy(load, 14);
  k.pool.toBuffer().copy(load, 46);
  load.fill(255, 110, 116);
  let calls = 0,
    finish;
  const gate = new Promise((r) => (finish = r));
  const connection = {
    async getMultipleAccountsInfo() {
      calls++;
      await gate;
      return [
        { owner: program, data: pool },
        { owner: program, data: load },
      ];
    },
  };
  const reader = createWardrobeReader({ connection, program, collection }),
    first = reader.read(avatar),
    second = reader.read(avatar);
  assert.equal(calls, 1);
  finish();
  assert.equal((await first).loadoutHash, (await second).loadoutHash);
  await reader.read(avatar);
  assert.equal(calls, 1);
  reader.invalidate(avatar);
  await reader.read(avatar);
  assert.equal(calls, 2);
  const wrong = createWardrobeReader({
    connection: {
      getMultipleAccountsInfo: async () => [
        { owner: collection, data: pool },
        null,
      ],
    },
    program,
    collection,
  });
  await assert.rejects(() => wrong.read(avatar), /account owner/);
});

test("wallet session handles account removal, disconnect and cancelled connect", async () => {
  const account = {
    address: Keypair.generate().publicKey.toBase58(),
    chains: ["solana:devnet"],
    features: ["solana:signTransaction"],
  };
  let changed,
    disconnects = 0,
    unsubscribed = false;
  const wallet = {
    accounts: [account],
    chains: ["solana:devnet"],
    features: {
      "standard:connect": { connect: async () => ({ accounts: [account] }) },
      "standard:events": {
        on(event, listener) {
          changed = listener;
          return () => (unsubscribed = true);
        },
      },
      "standard:disconnect": {
        async disconnect() {
          disconnects++;
        },
      },
      "solana:signTransaction": { supportedTransactionVersions: ["legacy"] },
    },
  };
  const updates = [];
  assert.equal(
    compatibleWallets({ get: () => [wallet] }, "solana:devnet").length,
    1,
  );
  assert.equal(
    compatibleWallets({ get: () => [wallet] }, "solana:mainnet").length,
    0,
  );
  const session = createWalletSession(wallet, "solana:devnet", (a) =>
    updates.push(a?.address ?? null),
  );
  await session.connect();
  wallet.accounts = [];
  changed({ accounts: [] });
  assert.equal(session.account, null);
  wallet.accounts = [account];
  await session.connect();
  await session.disconnect();
  assert.equal(disconnects, 1);
  session.dispose();
  assert(unsubscribed);
  await assert.rejects(() => session.connect(), /disposed/);
  let resolve;
  wallet.features["standard:connect"].connect = () =>
    new Promise((r) => (resolve = r));
  const next = createWalletSession(wallet, "solana:devnet", () => {});
  const pending = next.connect();
  await next.disconnect();
  resolve({ accounts: [account] });
  await assert.rejects(() => pending, /cancelled/);
  next.dispose();
});
