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
const { db } = await import("../backend/src/db");
const { syncAllSales, recentSales } = await import("../backend/src/tensor");

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

test("matches registered assets, caches the collection ID and deduplicates sales", async () => {
  await syncAllSales();
  await syncAllSales();
  expect(
    calls.filter((url) => url.includes("/collections/mints")),
  ).toHaveLength(1);
  expect(recentSales("qa", 10)).toMatchObject([
    { asset: "asset", index: 1, price: 1000000000 },
  ]);
});

test("cached reads make no network requests", () => {
  const before = calls.length;
  for (let i = 0; i < 3; i++) expect(recentSales("qa", 10)).toHaveLength(1);
  expect(calls.length).toBe(before);
});

test("an outage preserves previously cached sales", async () => {
  response = async () => new Response("unavailable", { status: 503 });
  await syncAllSales();
  expect(recentSales("qa", 10)).toHaveLength(1);
});

test("overlapping syncs share one request and completion permits the next run", async () => {
  let release!: () => void;
  let requests = 0;
  response = async () => {
    requests++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return Response.json({ txs: [] });
  };
  const first = syncAllSales();
  expect(syncAllSales()).toBe(first);
  expect(syncAllSales()).toBe(first);
  expect(requests).toBe(1);
  release();
  await first;
  const next = syncAllSales();
  expect(requests).toBe(2);
  release();
  await next;
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
    await syncAllSales();
    expect(deadline).toBe(10000);
    expect(recentSales("qa", 10)).toHaveLength(1);
  } finally {
    globalThis.fetch = savedFetch;
    AbortSignal.timeout = savedTimeout;
  }
  response = async () => Response.json({ txs: [] });
  await syncAllSales();
});

test("devnet and missing API keys skip Tensor entirely", async () => {
  const before = calls.length;
  config.cluster = "devnet";
  await syncAllSales();
  config.cluster = "mainnet";
  config.tensorApiKey = "";
  await syncAllSales();
  config.tensorApiKey = "fixture-only";
  expect(calls.length).toBe(before);
});
