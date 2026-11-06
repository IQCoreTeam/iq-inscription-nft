import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import { addresses, PLATFORM_TREASURY } from "../../client/protocol.mjs";
import { createPackOperatorMarket } from "../market.mjs";
const ORAO = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
function fixture() {
  const program = Keypair.generate().publicKey,
    collection = Keypair.generate().publicKey,
    signer = Keypair.generate(),
    treasury = Keypair.generate().publicKey,
    keys = addresses(program, collection);
  const pool = Buffer.alloc(4352);
  pool.write("NUBSALE5");
  signer.publicKey.toBuffer().copy(pool, 8);
  collection.toBuffer().copy(pool, 40);
  treasury.toBuffer().copy(pool, 72);
  ORAO.toBuffer().copy(pool, 104);
  treasury.toBuffer().copy(pool, 136);
  pool.writeBigUInt64LE(100000000n, 200);
  pool[208] = 1;
  pool[209] = 4;
  pool[250] = 1;
  const epoch = Buffer.alloc(2048);
  epoch.write("NUBEPOC5");
  keys.pool.toBuffer().copy(epoch, 8);
  epoch[48] = 4;
  epoch.writeUInt16LE(1, 65);
  epoch[256 + 44] = 15;
  epoch.writeBigUInt64LE(105000000n, 69);
  epoch.writeBigUInt64LE(100n, 49);
  epoch.writeBigUInt64LE(120n, 57);
  let simulated = 0,
    requester = null;
  const connection = {
    getGenesisHash: async () => "pinned",
    getMinimumBalanceForRentExemption: async (size, commitment) => {
      assert.equal(size, 749);
      assert.equal(commitment, "confirmed");
      return 6000000;
    },
    getMultipleAccountsInfoAndContext: async (queried) =>
      queried[0].equals(keys.pool)
        ? {
            context: { slot: 10 },
            value: [
              { owner: program, data: pool },
              { executable: true },
              { executable: true },
            ],
          }
        : {
            context: { slot: 11 },
            value: [{ owner: program, data: epoch }, requester],
          },
    getAccountInfoAndContext: async () => ({
      context: { slot: 11 },
      value: { owner: program, data: epoch },
    }),
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }),
    simulateTransaction: async () => {
      simulated++;
      return { value: { err: null } };
    },
  };
  const vrf = {
    programId: ORAO,
    getNetworkState: async () => ({
      config: {
        treasury,
        requestFee: { toString: () => "1000000" },
        fulfillmentAuthorities: [signer.publicKey],
      },
    }),
    getRandomness: async () => ({
      getVersion: () => "V2",
      getSeed: () => epoch.subarray(77, 109),
      getClient: () => keys.requester,
      getFulfilledRandomness: () => null,
    }),
  };
  const config = {
    connection,
    program,
    collection,
    signer,
    expectedGenesis: "pinned",
    vrf,
    requestFundingLamports: 10000000,
  };
  return {
    config,
    pool,
    epoch,
    treasury,
    keys,
    setRequester(value) {
      requester = value;
    },
    get simulated() {
      return simulated;
    },
  };
}
test("real operator builds exact pinned payout and simulates before returning signed checkpoint", async () => {
  const f = fixture(),
    market = createPackOperatorMarket(f.config),
    state = await market.readState(),
    job = await market.buildSigned({ kind: "payout" }, state);
  const tx = Transaction.from(Buffer.from(job.signedTransaction, "base64"));
  assert(tx.verifySignatures());
  assert.equal(f.simulated, 1);
  assert.equal(tx.instructions.length, 2);
  const ix = tx.instructions[1];
  assert.equal(ix.data[0], 10);
  assert(ix.keys[2].pubkey.equals(f.treasury));
  assert(ix.keys[3].pubkey.equals(PLATFORM_TREASURY));
  assert(!("secretKey" in job));
});
test("new window instruction uses new epoch and proves the previous terminal epoch", async () => {
  const f = fixture();
  f.epoch[48] = 6;
  f.pool.writeBigUInt64LE(1n, 226);
  f.pool.writeUInt32LE(76, 384 + 232);
  const market = createPackOperatorMarket(f.config);
  market.requestSaleWindow();
  const state = await market.readState(),
    job = await market.buildSigned({ kind: "open" }, state);
  const instruction = Transaction.from(
    Buffer.from(job.signedTransaction, "base64"),
  ).instructions[1];
  assert.equal(instruction.data[0], 1);
  assert(
    instruction.keys[2].pubkey.equals(
      addresses(f.config.program, f.config.collection, 1).epoch,
    ),
  );
  assert(instruction.keys[4].pubkey.equals(f.keys.epoch));
  assert(instruction.keys[5].pubkey.equals(f.keys.requester));

  f.config.connection.getMinimumBalanceForRentExemption = async () => 9_000_001;
  await assert.rejects(
    () => market.buildSigned({ kind: "open" }, state),
    /fee and pending account rent/,
  );
  assert.equal(f.simulated, 1);
});

test("wrong network and collection reject before operator signing", async () => {
  for (const change of [
    (f) => (f.config.connection.getGenesisHash = async () => "other"),
    (f) => f.pool.fill(0, 40, 72),
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(() => createPackOperatorMarket(f.config).readState());
    assert.equal(f.simulated, 0);
  }
});
test("changed provider config blocks new requests without blocking owed refunds", async () => {
  const f = fixture();
  f.epoch[48] = 2;
  f.config.vrf.getNetworkState = async () => ({
    config: {
      treasury: SystemProgram.programId,
      requestFee: { toString: () => "1000000" },
      fulfillmentAuthorities: [f.config.signer.publicKey],
    },
  });
  const market = createPackOperatorMarket(f.config);
  await assert.rejects(
    async () =>
      market.buildSigned({ kind: "request" }, await market.readState()),
    /ORAO configuration/,
  );
  assert.equal(f.simulated, 0);
  f.epoch[48] = 5;
  f.epoch[256 + 45] = 0;
  const job = await market.buildSigned(
    { kind: "refund", ticket: 0 },
    await market.readState(),
  );
  assert.equal(
    Transaction.from(Buffer.from(job.signedTransaction, "base64"))
      .instructions[1].data[0],
    7,
  );
});

test("request funding includes rent before signing a provider request", async () => {
  const f = fixture();
  f.epoch[48] = 2;
  f.config.requestFundingLamports = 6_999_999;
  const underfunded = createPackOperatorMarket(f.config);
  await assert.rejects(
    async () => underfunded.buildSigned({ kind: "request" }, await underfunded.readState()),
    /fee and pending account rent/,
  );
  assert.equal(f.simulated, 0);

  f.config.requestFundingLamports = 7_000_000;
  const covered = createPackOperatorMarket(f.config);
  await covered.buildSigned({ kind: "request" }, await covered.readState());
  assert.equal(f.simulated, 1);
});
test("provider state uses the SDK V2 API and binds seed plus requester", async () => {
  const f = fixture();
  f.epoch[48] = 3;
  const market = createPackOperatorMarket(f.config);
  assert.equal((await market.readState()).providerStatus, "pending");
  f.config.vrf.getRandomness = async () => ({
    getVersion: () => "V2",
    getSeed: () => f.epoch.subarray(77, 109),
    getClient: () => f.keys.requester,
    getFulfilledRandomness: () => Buffer.alloc(64, 1),
  });
  assert.equal((await market.readState()).providerStatus, "fulfilled");
  f.config.vrf.getRandomness = async () => ({
    getVersion: () => "V2",
    getSeed: () => Buffer.alloc(32, 9),
    getClient: () => f.keys.requester,
    getFulfilledRandomness: () => Buffer.alloc(64, 1),
  });
  assert.equal((await market.readState()).providerStatus, "unknown");
});
test("stale requested task cannot build another action from newer confirmed state", async () => {
  const f = fixture(),
    market = createPackOperatorMarket(f.config),
    state = await market.readState();
  await assert.rejects(
    () => market.buildSigned({ kind: "refund", ticket: 0 }, state),
    /no longer matches/,
  );
  assert.equal(f.simulated, 0);
});

test("sale-window demand expires or is consumed by an already open window", async (t) => {
  const f = fixture();
  f.epoch[48] = 6;
  f.pool.writeBigUInt64LE(1n, 226);
  f.pool.writeUInt32LE(76, 384 + 232);
  let now = 1000;
  const real = Date.now;
  Date.now = () => now;
  t.after(() => (Date.now = real));
  const market = createPackOperatorMarket(f.config);
  assert.equal((await market.readState()).saleDemand, false);
  market.requestSaleWindow();
  assert.equal((await market.readState()).saleDemand, true);
  now = 31001;
  assert.equal((await market.readState()).saleDemand, false);
  market.requestSaleWindow();
  f.epoch[48] = 1;
  f.epoch.writeBigUInt64LE(100n, 49);
  assert.equal((await market.readState()).saleDemand, false);
  f.epoch[48] = 6;
  assert.equal((await market.readState()).saleDemand, false);
});

test("unused provider funding sweeps only to its recorded sponsor, not creator or operator", async () => {
  const f = fixture(),
    sponsor = Keypair.generate().publicKey;
  f.epoch[141] = 1;
  sponsor.toBuffer().copy(f.epoch, 224);
  f.setRequester({
    owner: SystemProgram.programId,
    data: Buffer.alloc(0),
    executable: false,
    lamports: 1234,
  });
  const market = createPackOperatorMarket(f.config),
    state = await market.readState();
  assert.equal(state.requesterLamports, 1234);
  assert(state.epoch.requestSponsor.equals(sponsor));
  const job = await market.buildSigned(
      { kind: "sweep", balance: 1234, slot: 11 },
      state,
    ),
    instruction = Transaction.from(Buffer.from(job.signedTransaction, "base64"))
      .instructions[1];
  assert.equal(instruction.data[0], 9);
  assert(instruction.keys[2].pubkey.equals(f.keys.requester));
  assert(instruction.keys[3].pubkey.equals(sponsor));
  assert(!sponsor.equals(f.config.signer.publicKey));
  assert(!sponsor.equals(f.treasury));
  f.setRequester({
    owner: f.config.program,
    data: Buffer.alloc(0),
    executable: false,
    lamports: 1234,
  });
  await assert.rejects(() => market.readState(), /requester account/);
});

test("reopening a requested epoch atomically sweeps to the saved sponsor before the zero-balance proof", async () => {
  const f = fixture(),
    sponsor = Keypair.generate().publicKey;
  f.epoch[48] = 6;
  f.epoch[141] = 1;
  sponsor.toBuffer().copy(f.epoch, 224);
  f.pool.writeBigUInt64LE(1n, 226);
  f.pool.writeUInt32LE(76, 384 + 232);
  const market = createPackOperatorMarket(f.config);
  market.requestSaleWindow();
  const state = await market.readState(),
    job = await market.buildSigned({ kind: "open" }, state);
  const tx = Transaction.from(Buffer.from(job.signedTransaction, "base64"));
  assert.equal(tx.instructions.length, 3);
  assert.equal(tx.instructions[1].data[0], 9);
  assert(tx.instructions[1].keys[3].pubkey.equals(sponsor));
  assert.equal(tx.instructions[2].data[0], 1);
  assert(tx.instructions[2].keys[5].pubkey.equals(f.keys.requester));
});

test("operator opens a later epoch using bounded active-state reads rather than loading history", async () => {
  const f=fixture();f.epoch[48]=6;f.epoch.writeBigUInt64LE(69n,40);f.epoch.writeBigUInt64LE(0n,69);
  f.pool.writeBigUInt64LE(70n,226);f.pool.writeBigUInt64LE(69n,234);f.pool.writeUInt32LE(76,384+232);
  const sizes=[],read=f.config.connection.getMultipleAccountsInfoAndContext;
  f.config.connection.getMultipleAccountsInfoAndContext=async(keys,...rest)=>{sizes.push(keys.length);return read(keys,...rest);};
  const market=createPackOperatorMarket(f.config);market.requestSaleWindow();
  const state=await market.readState(),job=await market.buildSigned({kind:'open'},state);
  const tx=Transaction.from(Buffer.from(job.signedTransaction,'base64')),ix=tx.instructions.at(-1);
  assert.equal(ix.data[0],1);assert(ix.keys[2].pubkey.equals(addresses(f.config.program,f.config.collection,70).epoch));
  assert.deepEqual(sizes,[3,2]);assert.equal(f.simulated,1);
});
