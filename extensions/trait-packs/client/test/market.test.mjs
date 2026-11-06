import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { createWardrobeReader } from "../state.mjs";
import { createPackClient } from "../market.mjs";
import { addresses } from "../protocol.mjs";
function saleFixture() {
  const program = Keypair.generate().publicKey,
    collection = Keypair.generate().publicKey,
    keys = addresses(program, collection);
  const pool = Buffer.alloc(4352),
    epoch = Buffer.alloc(2048);
  pool.write("NUBSALE5");
  collection.toBuffer().copy(pool, 40);
  pool.writeBigUInt64LE(100000000n, 200);
  pool[208] = 1;
  pool[209] = 4;
  pool[250] = 1;
  pool.writeUInt32LE(80, 384 + 232);
  epoch.write("NUBEPOC5");
  keys.pool.toBuffer().copy(epoch, 8);
  epoch[48] = 1;
  epoch.writeBigUInt64LE(100n, 49);
  let reads = 0;
  const connection = {
    getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    getAccountInfoAndContext: async (key) => {
      reads++;
      assert(key.equals(keys.pool));
      return { context: { slot: 1 }, value: { owner: program, data: pool } };
    },
    getMultipleAccountsInfoAndContext: async (queried, options) => {
      reads++;
      assert(queried[0].equals(keys.epoch));
      assert(queried[1].equals(keys.ops));
      assert.equal(options.minContextSlot, 1);
      return {
        context: { slot: 2 },
        value: [
          { owner: program, data: epoch },
          {
            owner: SystemProgram.programId,
            data: Buffer.alloc(0),
            lamports: 1000000000,
          },
        ],
      };
    },
  };
  return {
    program,
    collection,
    pool,
    epoch,
    connection,
    pendingPurchases: {
      load: async () => null,
      save: async () => {},
      clear: async () => {},
    },
    get reads() {
      return reads;
    },
  };
}
test("sale quote batches mutable state, reuses warm reads and invalidates on demand", async () => {
  const f = saleFixture(),
    reader = createWardrobeReader(f);
  const [a, b] = await Promise.all([reader.sale(), reader.sale()]);
  assert.equal(f.reads, 2);
  assert.equal(a.pool.totalPrice, 105000000);
  assert.equal(b.canPurchase, true);
  await reader.sale();
  assert.equal(f.reads, 2);
  reader.invalidate();
  f.epoch[48] = 4;
  assert.equal((await reader.sale()).canPurchase, false);
  assert.equal(f.reads, 4);
});
test("sale quote rejects another collection or epoch before allowing purchase", async () => {
  const f = saleFixture();
  f.pool.fill(0, 40, 72);
  await assert.rejects(() => createWardrobeReader(f).sale(), /identity/);
  const other = saleFixture();
  other.epoch.fill(0, 8, 40);
  await assert.rejects(() => createWardrobeReader(other).sale(), /identity/);
});
test("production purchase refuses an undisclosed surcharge before asking a wallet", async () => {
  const f = saleFixture(),
    client = createPackClient({ ...f, chain: "solana:devnet" });
  const account = { address: Keypair.generate().publicKey.toBase58() };
  await assert.rejects(
    () => client.purchase({ wallet: {}, account, expectedTotal: 100000000 }),
    /current pack price and IQ fee/,
  );
  f.epoch.writeBigUInt64LE(1n, 49);
  await assert.rejects(
    () => client.purchase({ wallet: {}, account, expectedTotal: 105000000 }),
    /not open/,
  );
});

test("unfunded operations cannot invite a buyer to sign", async () => {
  const f = saleFixture(),
    read = f.connection.getMultipleAccountsInfoAndContext;
  f.connection.getMultipleAccountsInfoAndContext = async (...args) => {
    const result = await read(...args);
    result.value[1].lamports = 0;
    return result;
  };
  assert.equal((await createWardrobeReader(f).sale()).canPurchase, false);
});

test("a wrong network cannot even display a sale quote", async () => {
  const f = saleFixture();
  f.connection.getGenesisHash = async () => "wrong-chain";
  await assert.rejects(
    () => createPackClient({ ...f, chain: "solana:devnet" }).readSale(),
    /chain mismatch/,
  );
  assert.equal(f.reads, 0);
});

test("durable unresolved purchase blocks signing until confirmed reconciliation", async () => {
  const f = saleFixture(),
    signature = "saved-signature";
  let cleared = 0;
  f.pendingPurchases = {
    load: async () => ({ signature }),
    save: async () => {},
    clear: async (key, sig) => {
      assert.equal(sig, signature);
      cleared++;
    },
  };
  const client = createPackClient({ ...f, chain: "solana:devnet" }),
    account = { address: Keypair.generate().publicKey.toBase58() };
  await assert.rejects(
    () => client.purchase({ wallet: {}, account, expectedTotal: 105000000 }),
    (e) => e.signature === signature,
  );
  f.connection.getSignatureStatuses = async () => ({ value: [null] });
  assert.equal((await client.reconcilePurchase(account)).state, "unresolved");
  assert.equal(cleared, 0);
  f.connection.getSignatureStatuses = async () => ({
    value: [{ err: null, confirmationStatus: "confirmed" }],
  });
  assert.equal((await client.reconcilePurchase(account)).state, "confirmed");
  assert.equal(cleared, 1);
});

test("confirmed follow-up stays durable through failure and restart before clearing", async () => {
  const { reconcilePackTransaction } = await import("../market.mjs");
  let pending = { signature: "confirmed-signature", asset: "public-asset" },
    failNotify = true,
    failClear = false,
    notifications = 0,
    clearCalls = 0;
  const storage = {
    load: async () => pending,
    clear: async () => {
      clearCalls++;
      if (failClear) throw Error("Interrupted before cleanup");
      pending = null;
    },
  };
  const args = {
    connection: {
      getGenesisHash: async () => "local-genesis",
      getSignatureStatuses: async () => ({
        value: [{ err: null, confirmationStatus: "confirmed" }],
      }),
    },
    chain: "solana:localnet",
    localGenesis: "local-genesis",
    pendingPurchases: storage,
    key: "local-checkpoint",
    afterConfirmation: async (value) => {
      assert.equal(
        pending,
        value,
        "checkpoint must still exist during indexing",
      );
      notifications++;
      if (failNotify) throw Error("Indexer offline");
    },
  };
  await assert.rejects(
    () => reconcilePackTransaction(args),
    (error) => error.confirmed && error.signature === "confirmed-signature",
  );
  assert.equal(clearCalls, 0);
  assert.ok(pending);
  failNotify = false;
  failClear = true;
  await assert.rejects(
    () => reconcilePackTransaction(args),
    (error) => error.confirmed,
  );
  assert.ok(pending);
  failClear = false;
  assert.equal((await reconcilePackTransaction(args)).state, "confirmed");
  assert.equal(pending, null);
  assert.equal(notifications, 3);
  assert.equal((await reconcilePackTransaction(args)).state, "none");
});

test('sealed client cannot forget a confirmed mint while discovery notification fails',async()=>{
 const {createSealedPackClient}=await import('../sealed-wallet.mjs');let pending={signature:'saved-mint',asset:Keypair.generate().publicKey.toBase58()},fail=true,clears=0;
 const connection={getGenesisHash:async()=> 'local-genesis',getSignatureStatuses:async()=>({value:[{err:null,confirmationStatus:'confirmed'}]})};
 const client=createSealedPackClient({connection,program:Keypair.generate().publicKey,collection:Keypair.generate().publicKey,chain:'solana:localnet',localGenesis:'local-genesis',pendingPurchases:{load:async()=>pending,save:async(_,value)=>pending=value,clear:async()=>{clears++;pending=null;}},notify:async assets=>{assert.equal(assets[0],pending.asset);assert.equal(clears,0);if(fail)throw Error('Offline');}});
 const account={address:Keypair.generate().publicKey.toBase58()};await assert.rejects(()=>client.reconcilePurchase(account),error=>error.confirmed);assert.equal(clears,0);assert.ok(pending);fail=false;assert.equal((await client.reconcilePurchase(account)).state,'confirmed');assert.equal(clears,1);
});
