import { expect, mock, test } from "bun:test";
import { Keypair, Message, SystemProgram, Transaction } from "@solana/web3.js";

const programId = Keypair.generate().publicKey;
const coreProgram = Keypair.generate().publicKey;
const collection = Keypair.generate().publicKey;
const registry = Keypair.generate().publicKey;
const authority = Keypair.generate().publicKey;
const payer = Keypair.generate().publicKey;
const signature = "fixture-signature";
let tx: any;
let accounts: any;
let unavailable = false;
mock.module("../backend/src/config.ts", () => ({ config: { rpcUrls: ["http://127.0.0.1:1"], programId }, MPL_CORE: coreProgram }));
mock.module("../backend/src/program.ts", () => ({
  collectionAuthOf: () => authority,
  program: { coder: { accounts: { decode: () => ({ collection }) } } },
}));
mock.module("../backend/src/rpcpool.ts", () => ({
  withConnection: async (fn: any) => {
    if (unavailable) throw Error("offline");
    return fn({ getTransaction: async () => tx, getMultipleAccountsInfo: async () => accounts });
  },
}));
const { deploymentMessage, verifyDeployment } = await import("../backend/src/verifier.ts");
const transaction = new Transaction({ feePayer: payer, recentBlockhash: payer.toBase58() })
  .add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: authority, lamports: 100 }));
const message = transaction.compileMessage();
const expected = { message: deploymentMessage(message), collection: collection.toBase58(), registry: registry.toBase58() };

test("deployment proof binds every message field except the refreshable blockhash", () => {
  const refreshed = Message.from(message.serialize());
  refreshed.recentBlockhash = registry.toBase58();
  expect(deploymentMessage(refreshed)).toBe(expected.message);
  expect(message.recentBlockhash).toBe(payer.toBase58());
  const changed = new Transaction({ feePayer: payer, recentBlockhash: payer.toBase58() })
    .add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: authority, lamports: 99 }));
  expect(deploymentMessage(changed.compileMessage())).not.toBe(expected.message);
});

test("missing or unavailable proof is retryable; failed or unrelated proof is rejected", async () => {
  unavailable = true;
  expect(await verifyDeployment(signature, expected)).toMatchObject({ pass: false, retry: true });
  unavailable = false;
  tx = null;
  expect(await verifyDeployment(signature, expected)).toMatchObject({ pass: false, retry: true });
  tx = { version: "legacy", meta: { err: "failed" }, transaction: { signatures: [signature], message } };
  expect(await verifyDeployment(signature, expected)).toMatchObject({ pass: false, retry: false });
  tx.meta = null;
  expect(await verifyDeployment(signature, expected)).toMatchObject({ pass: false, retry: false });
  tx.meta = { err: null };
  tx.transaction.signatures = ["different"];
  expect(await verifyDeployment(signature, expected)).toMatchObject({ pass: false, retry: false });
  tx.transaction.signatures = [signature];
  tx.version = 0;
  expect(await verifyDeployment(signature, expected)).toMatchObject({ pass: false, retry: false });
  tx.version = "legacy";
  expect(await verifyDeployment(signature, { ...expected, message: "not issued" })).toMatchObject({ pass: false, retry: false });
});

test("account existence alone is insufficient to finalize", async () => {
  tx = { version: "legacy", meta: { err: null }, transaction: { signatures: [signature], message } };
  accounts = [null, null];
  expect(await verifyDeployment(signature, expected)).toMatchObject({ pass: false, retry: true });
  accounts = [{ owner: SystemProgram.programId }, { owner: coreProgram }];
  expect(await verifyDeployment(signature, expected)).toMatchObject({ pass: false, retry: false });
  accounts = [{ owner: programId, data: Buffer.alloc(0) }, { owner: coreProgram, data: Buffer.alloc(0) }];
  expect(await verifyDeployment(signature, expected)).toMatchObject({ pass: false, retry: false });
});
