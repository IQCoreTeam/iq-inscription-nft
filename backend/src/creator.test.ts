import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";

// Real SQLite and creator code, isolated from operator keys and databases.
const dir = mkdtempSync(join(tmpdir(), "nft-creator-test-"));
process.env.DB_PATH = join(dir, "test.sqlite");
process.env.REGISTRAR_KEYPAIR = join(dir, "registrar.json");
writeFileSync(process.env.REGISTRAR_KEYPAIR, JSON.stringify(Array.from(Keypair.generate().secretKey)));
const { db, nowSec } = await import("./db.ts");
// bun test runs every file in one process, so the first file's DB_PATH is the
// one db.ts opens: start from empty tables instead of closing or deleting the
// database, which would break whichever file runs next.
for (const t of ["sale", "slot", "returned", "reservation", "allowlist", "item", "collection"]) db.run(`DELETE FROM ${t}`);
const { recordCollection, stageCollection } = await import("./creator.ts");
const { listCollections } = await import("./collections.ts");

const spec = { slug: "regression", name: "Test", symbol: "TEST", description: "", price: 0, deposit: 0, royaltyBps: 0, sequential: true, currency: "SOL" };
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

// A fresh launch is activity too: it must not sink below every collection that
// ever had a mint, or creators cannot find what they just deployed.
test("collections list by latest activity, launch or mint", () => {
  const record = (slug: string, createdAt: number, lastMintAt: number) => {
    recordCollection({ ...args([1]), spec: { ...spec, slug } });
    db.run("UPDATE collection SET created_at = ?2, last_mint_at = ?3 WHERE slug = ?1", [slug, createdAt, lastMintAt]);
  };
  try {
    record("old-minted-recently", 10, 200);
    record("minted-a-while-ago", 50, 80);
    record("just-launched", 100, 0);
    expect(listCollections().map((c) => c.slug)).toEqual(["old-minted-recently", "just-launched", "minted-a-while-ago"]);
  } finally {
    db.run("DELETE FROM item"); db.run("DELETE FROM collection");
  }
});

test("stock toggle controls Studio, mint reservations, co-signing and Tensor trades", async () => {
  const { app } = await import("./server.ts");
  const { config } = await import("./config.ts");
  const { STOCK_CURRENCIES } = await import("./currencies.ts");
  const currency = STOCK_CURRENCIES[0].mint;
  const previous = config.stockEnabled;
  const fixture = args([1]);
  const { slug } = fixture.spec;
  const wallet = fixture.creatorPubkey.toBase58();
  const burner = Keypair.generate().publicKey.toBase58();
  const post = (path: string, body: object) => app.request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const currencies = async () => (await app.request("/creator/currencies")).json();
  const begin = { ...spec, slug: "new-collection", creator: wallet, price: 1 };
  const trade = { mint: fixture.collectionPubkey.toBase58(), owner: wallet, buyer: burner, price: 1, maxPrice: 1 };
  try {
    config.stockEnabled = true;
    expect(await currencies()).toEqual({ currencies: STOCK_CURRENCIES, checkout: "wallet-v1" });
    const stage = await post("/creator/stage/begin", { ...begin, currency });
    expect(stage.status).toBe(200);
    const single = await post("/creator/stage", { ...begin, currency, single: true, items: [] });
    expect(single.status).toBe(200);
    const stagedSingle = await single.json();
    recordCollection({ ...fixture, spec: { ...fixture.spec, currency, price: 1 } });
    db.run(`INSERT INTO reservation (id, slug, item_index, wallet, burner, state, created_at, expires_at)
      VALUES ('stock-toggle', ?1, 1, ?2, ?3, 'reserved', ?4, ?5)`, [slug, wallet, burner, nowSec(), nowSec() + 600]);

    config.stockEnabled = false;
    expect(await currencies()).toEqual({ currencies: [], checkout: "wallet-v1" });
    expect((await app.request("/c/" + slug)).status).toBe(200);
    expect((await post("/creator/stage/begin", { ...begin, currency })).status).toBe(400);
    expect((await post("/creator/stage/begin", begin)).status).toBe(200);
    expect((await post("/creator/deploy", { stagingId: stagedSingle.stagingId })).status).toBe(403);
    expect((await post("/c/" + slug + "/reserve", { wallet, burner })).status).toBe(403);
    const mint = () => post("/c/" + slug + "/mint", { reservationId: "stock-toggle" });
    expect((await mint()).status).toBe(403);
    db.run("UPDATE reservation SET state = 'awaiting_submit' WHERE id = 'stock-toggle'");
    expect((await mint()).status).toBe(403);
    db.run("UPDATE reservation SET state = 'confirmed' WHERE id = 'stock-toggle'");
    expect(await (await mint()).json()).toEqual({ status: "confirmed", index: 1 });
    for (const action of ["list", "buy"]) {
      expect((await post("/market/" + action, { ...trade, currency })).status).toBe(403);
    }
  } finally {
    config.stockEnabled = previous;
    db.run("DELETE FROM reservation WHERE slug = ?", [slug]);
    db.run("DELETE FROM item WHERE slug = ?", [slug]);
    db.run("DELETE FROM collection WHERE slug = ?", [slug]);
  }
});
