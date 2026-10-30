import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  packPurchase,
  outfitAssertion,
  guardedTrade,
  tradePayments,
  sendWalletTransaction,
} from "../transactions.mjs";
import { addresses } from "../protocol.mjs";
import * as browserEntry from '../browser-entry.mjs';
const devnet = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const payer = Keypair.generate(),
  seller = Keypair.generate(),
  creator = Keypair.generate(),
  program = Keypair.generate().publicKey,
  collection = Keypair.generate().publicKey,
  avatar = Keypair.generate().publicKey;
function fixture(change) {
  const account = {
    address: payer.publicKey.toBase58(),
    publicKey: payer.publicKey.toBytes(),
    chains: ["solana:devnet"],
    features: ["solana:signTransaction"],
  };
  const calls = { sent: 0, signed: 0, chain: null, signature: null };
  const wallet = {
    chains: ["solana:devnet"],
    accounts: [account],
    features: {
      "solana:signTransaction": {
        supportedTransactionVersions: ["legacy"],
        async signTransaction(input) {
          calls.signed++;
          calls.chain = input.chain;
          const tx = Transaction.from(input.transaction);
          if (change) change(tx, wallet);
          tx.partialSign(payer);
          return [
            {
              signedTransaction: tx.serialize({ requireAllSignatures: false }),
            },
          ];
        },
      },
    },
  };
  const connection = {
    getGenesisHash: async () => devnet,
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }),
    simulateTransaction: async () => ({ value: { err: null } }),
    sendRawTransaction: async (bytes) => {
      calls.sent++;
      calls.signature = bs58.encode(Transaction.from(bytes).signature);
      return calls.signature;
    },
    confirmTransaction: async () => ({ value: { err: null } }),
    getSignatureStatuses: async () => ({ value: [null] }),
  };
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: seller.publicKey,
      lamports: 100n,
    }),
  );
  return {
    account,
    wallet,
    connection,
    transaction,
    calls,
    chain: "solana:devnet",
  };
}
test("explicit devnet wallet signing preserves message and confirms once", async () => {
  const f = fixture();
  assert.equal(await sendWalletTransaction(f), f.calls.signature);
  assert.equal(f.calls.sent, 1);
  assert.equal(f.calls.chain, "solana:devnet");
});
test("wrong RPC chain rejects before wallet prompt", async () => {
  const f = fixture();
  f.connection.getGenesisHash = async () => "mainnet";
  await assert.rejects(() => sendWalletTransaction(f), /chain mismatch/);
  assert.equal(f.calls.signed, 0);
  assert.equal(f.calls.sent, 0);
});
test("wallet message substitution rejects before submission", async () => {
  const f = fixture((tx) =>
    tx.instructions.push(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: creator.publicKey,
        lamports: 900n,
      }),
    ),
  );
  await assert.rejects(
    () => sendWalletTransaction(f),
    /changed the transaction/,
  );
  assert.equal(f.calls.sent, 0);
});
test("account switch during prompt and simulation failure cannot broadcast", async () => {
  const f = fixture((tx, wallet) => (wallet.accounts = []));
  await assert.rejects(() => sendWalletTransaction(f), /account changed/);
  assert.equal(f.calls.sent, 0);
  const rejected = fixture();
  rejected.connection.simulateTransaction = async () => ({
    value: { err: { InstructionError: [0, "bad"] } },
  });
  await assert.rejects(
    () => sendWalletTransaction(rejected),
    /simulation rejected/,
  );
  assert.equal(rejected.calls.sent, 0);
});
test("ambiguous confirmation returns signature and never replays", async () => {
  const f = fixture();
  f.connection.confirmTransaction = async () => {
    throw Error("timeout");
  };
  await assert.rejects(
    () => sendWalletTransaction(f),
    (e) => e.signature === f.calls.signature,
  );
  assert.equal(f.calls.sent, 1);
  assert.equal(f.calls.signed, 1);
  const landed = fixture();
  landed.connection.confirmTransaction = f.connection.confirmTransaction;
  landed.connection.getSignatureStatuses = async () => ({
    value: [{ err: null, confirmationStatus: "confirmed" }],
  });
  assert.equal(await sendWalletTransaction(landed), landed.calls.signature);
  assert.equal(landed.calls.sent, 1);
});
test("onchain rejection remains rejection after confirmation throws", async () => {
  const f = fixture();
  f.connection.confirmTransaction = async () => ({ value: { err: "failed" } });
  f.connection.getSignatureStatuses = async () => ({
    value: [{ err: "failed", confirmationStatus: "confirmed" }],
  });
  await assert.rejects(() => sendWalletTransaction(f), /Transaction failed/);
});
test("pack builder pins accounts and guard precedes settlement", () => {
  const purchase = packPurchase(program, collection, payer.publicKey, 31, 0);
  assert.equal(purchase.data[0], 2);
  assert(purchase.keys[1].pubkey.equals(addresses(program, collection).pool));
  assert.throws(() =>
    packPurchase(program, collection, payer.publicKey, 32, 0),
  );
  const settlement = [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: seller.publicKey,
      lamports: 1,
    }),
  ];
  const trade = guardedTrade({
    program,
    collection,
    avatar,
    revision: 7,
    loadoutHash: "ab".repeat(32),
    settlement,
  });
  assert.equal(trade[0].data[0], 25);
  assert.equal(trade[0].data.readUInt32LE(1), 7);
  assert.equal(trade[1], settlement[0]);
  assert.throws(() =>
    outfitAssertion(program, collection, avatar, -1, "ab".repeat(32)),
  );
  assert.throws(() =>
    guardedTrade({
      program,
      collection,
      avatar,
      revision: 0,
      loadoutHash: "ab".repeat(32),
      settlement: [],
    }),
  );
});
test("direct trade distributes explicit royalties with exact lamports", () => {
  const ix = tradePayments({
    buyer: payer.publicKey,
    seller: seller.publicKey,
    price: 101n,
    royaltyBps: 500,
    creators: [{ address: creator.publicKey, percentage: 100 }],
  });
  const decoded = ix.map(
    (i) =>
      SystemProgram.programId.equals(i.programId) && i.data.readBigUInt64LE(4),
  );
  assert.deepEqual(decoded, [5n, 96n]);
  assert.throws(() =>
    tradePayments({
      buyer: payer.publicKey,
      seller: seller.publicKey,
      price: 10n,
      royaltyBps: 500,
      creators: [],
    }),
  );
});

test('lost broadcast response retains signed identity without re-signing', async()=>{
  const f=fixture();
  f.connection.sendRawTransaction=async(bytes)=>{f.calls.sent++;f.calls.signature=bs58.encode(Transaction.from(bytes).signature);throw Error('response lost');};
  await assert.rejects(()=>sendWalletTransaction(f),error=>error.signature===f.calls.signature&&/Submission unresolved/.test(error.message));
  assert.equal(f.calls.sent,1);assert.equal(f.calls.signed,1);
});

test('definitive chain failure is not overridden by a later status response',async()=>{
  const f=fixture();f.connection.confirmTransaction=async()=>({value:{err:'failed'}});
  f.connection.getSignatureStatuses=async()=>({value:[{err:null,confirmationStatus:'confirmed'}]});
  await assert.rejects(()=>sendWalletTransaction(f),/Transaction failed/);
});

test('full mainnet genesis is recognized without any network send',async()=>{
  const f=fixture();f.chain='solana:mainnet';f.wallet.chains=[f.chain];f.account.chains=[f.chain];
  f.connection.getGenesisHash=async()=> '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
  f.connection.simulateTransaction=async()=>({value:{err:'test stops before send'}});
  await assert.rejects(()=>sendWalletTransaction(f),/simulation rejected/);
  assert.equal(f.calls.signed,1);assert.equal(f.calls.sent,0);
  const truncated=fixture();truncated.chain=f.chain;truncated.wallet.chains=[f.chain];truncated.account.chains=[f.chain];truncated.connection.getGenesisHash=async()=> '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  await assert.rejects(()=>sendWalletTransaction(truncated),/chain mismatch/);assert.equal(truncated.calls.signed,0);
});

test('browser entry exports the guarded trade APIs',()=>{
  assert.equal(browserEntry.guardedTrade,guardedTrade);assert.equal(browserEntry.outfitAssertion,outfitAssertion);assert.equal(browserEntry.tradePayments,tradePayments);
});
