import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";

// Real SQLite and creator code, isolated from operator keys and databases.
const dir = mkdtempSync(join(tmpdir(), "nft-creator-test-"));
process.env.DB_PATH = join(dir, "test.sqlite");
process.env.REGISTRAR_KEYPAIR = join(dir, "registrar.json");
writeFileSync(process.env.REGISTRAR_KEYPAIR, JSON.stringify(Array.from(Keypair.generate().secretKey)));
const { db } = await import("./db.ts");
const { recordCollection, stageCollection } = await import("./creator.ts");
afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const spec = { slug: "regression", name: "Test", symbol: "TEST", description: "", price: 0, deposit: 0, royaltyBps: 0, sequential: true };
const item = (index: number) => ({ index, name: `Item ${index}`, bytes: Buffer.alloc(0), mime: "image/png", template: {} });
function args(indices: number[]) {
  const items = indices.map(item);
  return {
    spec, items, collectionPubkey: Keypair.generate().publicKey, registry: Keypair.generate().publicKey,
    creatorPubkey: Keypair.generate().publicKey, manifestSig: "manifest", metaSig: "metadata",
    staged: { seed: Buffer.alloc(32), shuffleCommit: "commit", manifestHash: "hash", manifestJson: "", collectionJson: "", itemCount: items.length,
      manifestItems: items.map(it => ({ index: it.index, name: it.name, image_sha256: "image", image_mime: it.mime, meta_sha256: "meta", arweave_id: "arweave" })) },
  };
}

test("failed item insert rolls back all rows and allows the next transaction", () => {
  try {
    expect(() => recordCollection(args([1, 1]))).toThrow();
    expect(db.inTransaction).toBe(false);
    expect(db.query("SELECT * FROM collection").all()).toHaveLength(0);
    expect(db.query("SELECT * FROM item").all()).toHaveLength(0);
    db.run("BEGIN IMMEDIATE"); db.run("COMMIT");
    recordCollection(args([1, 2]));
    expect(db.query("SELECT * FROM collection").all()).toHaveLength(1);
    expect(db.query("SELECT * FROM item").all()).toHaveLength(2);
  } finally {
    if (db.inTransaction) db.run("ROLLBACK");
    db.run("DELETE FROM item"); db.run("DELETE FROM collection");
  }
});

for (const indices of [[1, 1], [0], [-1], [1.5], [2], [1, 3], [NaN], [Infinity]]) {
  test(`reject invalid indices before uploading: ${indices}`, async () => {
    await expect(stageCollection(spec, indices.map(item))).rejects.toThrow(/indices must be unique integers from 1 to/);
  });
}
test("single collection can stage without items", async () => {
  expect((await stageCollection(spec, [])).itemCount).toBe(0);
});

test("stage API rejects duplicate and invalid indices with HTTP 400", async () => {
  const { app } = await import("./server.ts");
  for (const indices of [[1, 1], [0], [-1], [1.5], [2], [1, 3], [null], ["bad"]]) {
    const response = await app.request("/creator/stage", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...spec, creator: Keypair.generate().publicKey.toBase58(), items: indices.map(index => ({ index, name: "Test" })) }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/indices must be unique integers/);
  }
  const response = await app.request("/creator/stage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...spec, creator: Keypair.generate().publicKey.toBase58(), single: true, items: [] }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).itemCount).toBe(0);
});
