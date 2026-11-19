import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";

const endpoint = process.env.ANCHOR_PROVIDER_URL!;
assert.equal(new URL(endpoint).hostname, "127.0.0.1");
process.env.RPC_URLS = endpoint;
process.env.CLUSTER = "devnet";
process.env.REGISTRAR_KEYPAIR = process.env.ANCHOR_WALLET!;
const scratch = mkdtempSync(join(tmpdir(), "iq-finalization-test-"));
process.once("exit", () => rmSync(scratch, { recursive: true, force: true }));
process.env.DB_PATH = join(scratch, "nft.sqlite");
process.env.ARWEAVE_KEYPAIR = "";
process.env.TENSOR_API_KEY = "";

const { app } = await import("../backend/src/server.ts");
const { db } = await import("../backend/src/db.ts");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET!, "utf8"))));
const collection = Keypair.generate();
const creator = payer.publicKey.toBase58();
const slug = "local-finalization-qa";
async function post(path: string, body: object) {
  const response = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

const { stagingId } = await post("/creator/stage", { slug, creator, name: "Local proof QA", symbol: "QA", currency: "SOL", single: true, items: [] });
const built = await post("/creator/deploy", {
  stagingId, creator, collection: collection.publicKey.toBase58(),
  metaSig: utils.bytes.bs58.encode(new Uint8Array(64).fill(43)),
});
const connection = new Connection(endpoint, "confirmed");
const tx = Transaction.from(Buffer.from(built.transaction, "base64"));
tx.sign(payer, collection);
const deploySig = await connection.sendRawTransaction(tx.serialize());
const landed = await connection.confirmTransaction({ signature: deploySig, blockhash: tx.recentBlockhash!, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed");
assert.equal(landed.value.err, null);
const result = await post("/creator/finalize", { stagingId, deploySig });
assert.equal(result.collection, collection.publicKey.toBase58());
assert.equal(result.registry, built.registry);
const row = db.query("SELECT core_collection, registry, creator FROM collection WHERE slug = ?").get(slug);
assert.deepEqual(row, { core_collection: collection.publicKey.toBase58(), registry: built.registry, creator });
console.log("Confirmed Surfnet deployment proof accepted and matching staged collection stored in SQLite");
