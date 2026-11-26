import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use the real SQLite schema and sale cache without credentials or chain access.
const directory = mkdtempSync(join(tmpdir(), "iq-sales-test-"));
const config = {
  dbPath: join(directory, "sales.sqlite"),
  cluster: "mainnet",
  tensorApiKey: "fixture-only",
  tensorBase: "https://tensor.invalid",
};
mock.module("../backend/src/config", () => ({ config }));
mock.module("../backend/src/program.ts", () => ({ PLATFORM_TREASURY: "fixture-treasury" }));
const { db } = await import("../backend/src/db");
const { syncAll, recentSales, activeListings, recentListings } = await import("../backend/src/tensor");

db.exec(`
  INSERT INTO collection
    (slug, core_collection, registry, name, symbol, creator, treasury,
     max_supply, price_lamports, deposit_lamports, shuffle_seed, shuffle_commit,
     manifest_sig, manifest_hash, meta_sig, created_at)
  VALUES ('qa', 'core', 'registry', 'Test', 'QA', 'owner', 'owner',
          2, 0, 0, 'seed', 'commit', 'manifest', 'hash', 'meta', 1);
  INSERT INTO slot VALUES ('qa', 1, 'asset', 'owner', 'C', 'M', 1);
`);

const originalFetch = globalThis.fetch;
let calls: string[] = [];
let response = async (url: string): Promise<Response> =>
  Response.json(
    url.includes("/collections/mints")
      ? [{ id: "collection-id" }]
      : {
          txs: ["asset", "other-asset"].map((mint) => ({
            tx: {
              txId: "sale-" + mint,
              txType: "SALE_BUY_NOW",
              mintOnchainId: mint,
              grossAmount: 1000000000,
              buyerId: "buyer",
              source: "TCOMP",
              txAt: "2026-01-01T00:00:00Z",
            },
          })),
        },
  );
globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url = String(input);
  expect(url.startsWith(config.tensorBase + "/")).toBe(true);
  expect(init?.headers).toEqual({ "x-tensor-api-key": "fixture-only" });
  calls.push(url);
  return response(url);
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
  db.close();
  rmSync(directory, { recursive: true });
});

test("preserves current sales coverage, caches collection IDs and deduplicates sales", async () => {
  await syncAll();
  await syncAll();
  expect(
    calls.filter((url) => url.includes("/collections/mints")),
  ).toHaveLength(1);
  expect(recentSales("qa", 10)).toMatchObject([
    { asset: "asset", index: 1, price: 1000000000 },
    { asset: "other-asset", index: null, price: 1000000000 },
  ]);
});

test("cached reads make no network requests", () => {
  const before = calls.length;
  for (let i = 0; i < 3; i++) expect(recentSales("qa", 10)).toHaveLength(2);
  expect(calls.length).toBe(before);
});

test("an outage preserves previously cached sales", async () => {
  response = async () => new Response("unavailable", { status: 503 });
  await syncAll();
  expect(recentSales("qa", 10)).toHaveLength(2);
});

test("a stalled request uses the 10-second deadline and releases the sync", async () => {
  const savedFetch = globalThis.fetch;
  const savedTimeout = AbortSignal.timeout;
  let deadline = 0;
  AbortSignal.timeout = ((ms: number) => {
    deadline = ms;
    return savedTimeout(5);
  }) as typeof AbortSignal.timeout;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener(
        "abort",
        () => reject(init!.signal!.reason),
        { once: true },
      );
    })) as typeof fetch;
  try {
    await syncAll();
    expect(deadline).toBe(10000);
    expect(recentSales("qa", 10)).toHaveLength(2);
  } finally {
    globalThis.fetch = savedFetch;
    AbortSignal.timeout = savedTimeout;
  }
  response = async () => Response.json({ txs: [] });
  await syncAll();
});

test("devnet and missing API keys skip Tensor entirely", async () => {
  const before = calls.length;
  config.cluster = "devnet";
  await syncAll();
  config.cluster = "mainnet";
  config.tensorApiKey = "";
  await syncAll();
  config.tensorApiKey = "fixture-only";
  expect(calls.length).toBe(before);
});

test("preserves listing snapshots, inscription links and fifty-event history limit", async () => {
  response = async (url) => {
    if (new URL(url).pathname === "/mint") return Response.json([{
      onchainId: "asset", listing: { price: "2500000000", seller: "owner", source: "MAGICEDEN_V2" },
    }]);
    expect(new URL(url).searchParams.get("limit")).toBe("50");
    return Response.json({ txs: [{ tx: {
      txId: "list-asset", mintOnchainId: "asset", txType: "LIST",
      grossAmount: 2500000000, sellerId: "owner", source: "MAGICEDEN_V2",
      txAt: new Date().toISOString(),
    } }] });
  };
  await syncAll();
  expect(activeListings("qa", 10)).toMatchObject([
    { asset: "asset", price: 2500000000, inscriptionSig: "C", source: "MAGICEDEN_V2" },
  ]);
  expect(recentListings("qa", 10)).toHaveLength(1);
  response = async () => new Response("temporary outage", { status: 503 });
  await syncAll();
  expect(activeListings("qa", 10)).toHaveLength(1);
  response = async (url) => Response.json(new URL(url).pathname === "/mint" ? [] : { txs: [] });
  await syncAll();
  expect(activeListings("qa", 10)).toHaveLength(0);
});

test("item batches share an in-flight sync, keep the snapshot on timeout, and recover", async () => {
  const stock = "stock-token-mint";
  db.run("UPDATE collection SET currency_mint = ?, max_supply = 102 WHERE slug = 'qa'", [stock]);
  const insert = db.query("INSERT INTO slot VALUES ('qa', ?, ?, 'owner', 'C', 'M', 1)");
  for (let n = 2; n <= 102; n++) insert.run(n, "asset-" + n);

  const batches: number[] = [];
  const itemResponse = (url: string, price: number) => {
    const mints = new URL(url).searchParams.getAll("mints");
    batches.push(mints.length);
    return Response.json(mints.map((mint) => ({
      onchainId: mint,
      listing: { price, priceUnit: mint === "asset-102" ? null : stock },
    })));
  };
  response = async (url) => new URL(url).pathname === "/mint"
    ? itemResponse(url, 300000)
    : Response.json({ txs: [] });
  await syncAll();
  expect(batches).toEqual([100, 2]);
  const firstSnapshot = activeListings("qa", 102);
  expect(firstSnapshot).toHaveLength(101);
  expect(firstSnapshot.every((item) => item.asset !== "asset-102" && item.price === 300000)).toBe(true);

  batches.length = 0;
  const fetchWithFixture = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  let enterSecondBatch!: () => void;
  const secondBatchEntered = new Promise<void>((resolve) => { enterSecondBatch = resolve; });
  let abortSeen = false;
  const deadlines: number[] = [];
  AbortSignal.timeout = (ms) => { deadlines.push(ms); return realTimeout(100); };
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const mints = new URL(url).searchParams.getAll("mints");
    if (!mints.length) return Response.json({ txs: [] });
    if (mints.length === 100) return itemResponse(url, 400000);
    batches.push(mints.length);
    enterSecondBatch();
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => {
      abortSeen = true;
      reject(init!.signal!.reason);
    }, { once: true }));
  }) as typeof fetch;

  try {
    const run = syncAll();
    await Promise.race([secondBatchEntered, run.then(() => { throw Error("Sync ended before the second item batch"); })]);
    expect(syncAll()).toBe(run);
    expect(syncAll()).toBe(run);
    await run;
    expect(abortSeen).toBe(true);
    expect(deadlines).toEqual([10000, 10000, 10000]);
    expect(batches).toEqual([100, 2]);
    expect(activeListings("qa", 102)).toEqual(firstSnapshot);
  } finally {
    globalThis.fetch = fetchWithFixture;
    AbortSignal.timeout = realTimeout;
  }

  batches.length = 0;
  response = async (url) => new URL(url).pathname === "/mint"
    ? itemResponse(url, 500000)
    : Response.json({ txs: [] });
  await syncAll();
  expect(batches).toEqual([100, 2]);
  const refreshed = activeListings("qa", 102);
  expect(refreshed).toHaveLength(101);
  expect(refreshed.every((item) => item.price === 500000)).toBe(true);
});
