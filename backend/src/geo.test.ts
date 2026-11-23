import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";

// The real routes over real SQLite, isolated from operator keys and databases.
const dir = mkdtempSync(join(tmpdir(), "nft-geo-test-"));
process.env.DB_PATH = join(dir, "test.sqlite");
process.env.REGISTRAR_KEYPAIR = join(dir, "registrar.json");
writeFileSync(process.env.REGISTRAR_KEYPAIR, JSON.stringify(Array.from(Keypair.generate().secretKey)));
const { db } = await import("./db.ts");
// bun test runs every file in one process and shares one database handle: start
// from empty tables, never close or delete it.
for (const t of ["sale", "slot", "returned", "reservation", "allowlist", "item", "collection"]) db.run(`DELETE FROM ${t}`);
const { config } = await import("./config.ts");
const { recordCollection } = await import("./creator.ts");
const { app } = await import("./server.ts");

const NVDA = "NVDAVuiB7hwd3m5Wa1JuHNovPaPG6BH1QNztbKFxNjv";
const owner = Keypair.generate().publicKey.toBase58();
const assets: Record<string, string> = {};
for (const [slug, currency] of [["geo-sol", "SOL"], ["geo-stock", NVDA]]) {
  const items = [{ index: 1, name: `${slug} 1`, bytes: Buffer.alloc(0), mime: "image/png", template: {} }];
  recordCollection({
    spec: { slug, name: slug, symbol: "GEO", description: "", price: 1000, deposit: 0, royaltyBps: 0, sequential: true, currency },
    items, collectionPubkey: Keypair.generate().publicKey, registry: Keypair.generate().publicKey,
    creatorPubkey: Keypair.generate().publicKey, manifestSig: "manifest", metaSig: "metadata",
    staged: { seed: Buffer.alloc(32), shuffleCommit: "commit", manifestHash: "hash", manifestJson: "", collectionJson: "", itemCount: 1,
      manifestItems: [{ index: 1, name: items[0].name, image_sha256: "image", image_mime: "image/png", meta_sha256: "meta", arweave_id: "arweave" }] },
  });
  assets[slug] = Keypair.generate().publicKey.toBase58();
  db.run("INSERT INTO slot (slug, item_index, asset, owner, inscription_sig, meta_sig, registered_at) VALUES (?1, 1, ?2, ?3, 'C', 'M', 1)", [slug, assets[slug], owner]);
}

// The production shape: mainnet, switch on, the default blocked list.
const before = { cluster: config.cluster, stockEnabled: config.stockEnabled };
config.cluster = "mainnet";
config.stockEnabled = true;
afterAll(() => Object.assign(config, before));

const get = async (path: string, country?: string) => {
  const res = await app.request(path, { headers: country ? { "cf-ipcountry": country } : {} });
  return { status: res.status, body: (await res.json()) as any };
};
const post = (path: string, body: unknown, country?: string) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...(country ? { "cf-ipcountry": country } : {}) }, body: JSON.stringify(body) });
const slugs = async (country?: string) => (await get("/c", country)).body.collections.map((c: any) => c.slug).sort();

test("an allowed country gets the stock currencies and stock collections", async () => {
  expect((await get("/health", "KR")).body).toMatchObject({ country: "KR", stocks: true });
  expect((await get("/creator/currencies", "KR")).body.currencies.map((x: any) => x.symbol)).toContain("NVDA");
  expect(await slugs("KR")).toEqual(["geo-sol", "geo-stock"]);
  expect((await get("/c/geo-stock", "kr")).body.currency.symbol).toBe("NVDA");
  expect((await get("/owner/" + owner, "KR")).body.items).toHaveLength(2);
  expect((await get("/asset/" + assets["geo-stock"], "KR")).status).toBe(200);
});

test("a blocked country gets the SOL-only site: stock collections do not exist", async () => {
  expect((await get("/health", "US")).body).toMatchObject({ country: "US", stocks: false });
  expect((await get("/creator/currencies", "US")).body.currencies).toEqual([]);
  expect(await slugs("US")).toEqual(["geo-sol"]);
  for (const path of ["/c/geo-stock", "/c/geo-stock/items", "/c/geo-stock/recent", "/c/geo-stock/listings", "/c/geo-stock/item/1", "/c/geo-stock/verify/1", "/asset/" + assets["geo-stock"]])
    expect([path, (await get(path, "US")).status]).toEqual([path, 404]);
  expect((await get("/owner/" + owner, "US")).body.items.map((i: any) => i.slug)).toEqual(["geo-sol"]);
  // SOL is untouched.
  expect((await get("/c/geo-sol", "US")).status).toBe(200);
  expect((await get("/asset/" + assets["geo-sol"], "US")).status).toBe(200);
});

test("a blocked country cannot reserve, mint, deploy or trade in a stock currency", async () => {
  const k = () => Keypair.generate().publicKey.toBase58();
  expect((await post("/c/geo-stock/reserve", { wallet: k(), burner: k() }, "US")).status).toBe(404);
  expect((await post("/c/geo-stock/mint", { reservationId: "x" }, "US")).status).toBe(404);
  expect((await post("/c/geo-stock/mint/landed", { reservationId: "x" }, "US")).status).toBe(404);
  const spec = { slug: "geo-new", creator: k(), name: "New", symbol: "NEW", price: 1000, currency: NVDA };
  const refused = await post("/creator/stage/begin", spec, "US");
  expect([refused.status, ((await refused.json()) as any).error]).toEqual([400, "currency must be SOL or an allowed mint"]);
  expect((await post("/market/list", { mint: assets["geo-stock"], owner: k(), price: 1 }, "US")).status).toBe(404);
  expect((await post("/market/buy", { mint: assets["geo-stock"], buyer: k(), owner: k(), maxPrice: 1 }, "US")).status).toBe(404);

  // Staged from an allowed country, then the deploy is asked for from a blocked one.
  const begun = await post("/creator/stage/begin", spec, "KR");
  expect(begun.status).toBe(200);
  const { stagingId } = (await begun.json()) as any;
  expect((await post("/creator/deploy", { stagingId }, "US")).status).toBe(403);
  expect((await post("/creator/deploy", { stagingId }, "KR")).status).toBe(409); // allowed: only the unfinished staging stops it
  // A SOL collection stages from anywhere.
  expect((await post("/creator/stage/begin", { ...spec, slug: "geo-new-sol", currency: "SOL" }, "US")).status).toBe(200);
});

test("no country, unknown and Tor are refused on mainnet and allowed off it", async () => {
  for (const country of [undefined, "XX", "T1"]) {
    expect((await get("/health", country)).body.stocks).toBe(false);
    expect(await slugs(country)).toEqual(["geo-sol"]);
  }
  config.cluster = "devnet";
  expect((await get("/health")).body.stocks).toBe(true);
  expect((await get("/health", "US")).body.stocks).toBe(false); // the list still applies off mainnet
  config.cluster = "mainnet";
});

test("the master switch off hides stock currencies everywhere", async () => {
  config.stockEnabled = false;
  expect((await get("/health", "KR")).body.stocks).toBe(false);
  expect((await get("/creator/currencies", "KR")).body.currencies).toEqual([]);
  expect(await slugs("KR")).toEqual(["geo-sol"]);
  config.stockEnabled = true;
});

test("an item trades only in its collection's currency, and only if minted here", async () => {
  const k = () => Keypair.generate().publicKey.toBase58();
  const list = async (mint: string, currency?: string) => {
    const res = await post("/market/list", { mint, owner: k(), price: 1, currency }, "KR");
    return [res.status, ((await res.json()) as any).error];
  };
  // Past the currency rule the request reaches Tensor, which has no key in tests.
  const reachedTensor = [400, "tensor api key not configured"];
  expect(await list(assets["geo-stock"])).toEqual(reachedTensor);
  expect(await list(assets["geo-stock"], NVDA)).toEqual(reachedTensor);
  expect(await list(assets["geo-stock"], "SOL")).toEqual([400, "geo-stock trades in NVDA only"]);
  expect(await list(assets["geo-sol"])).toEqual(reachedTensor);
  expect(await list(assets["geo-sol"], NVDA)).toEqual([400, "geo-sol trades in SOL only"]);
  expect(await list(k())).toEqual([404, "not a minted item in this registry"]);
  const buy = await post("/market/buy", { mint: assets["geo-sol"], buyer: k(), owner: k(), maxPrice: 1, currency: NVDA }, "KR");
  expect(buy.status).toBe(400);
});

test("the market lists visible collections, the latest sale first", async () => {
  const now = Math.floor(Date.now() / 1000);
  db.run("INSERT INTO sale(tx_id,slug,item_index,asset,price,buyer,seller,source,block_time) VALUES('t1','geo-stock',1,?1,100,'b','s','TCOMP',?2)", [assets["geo-stock"], now - 90000]);
  db.run("INSERT INTO sale(tx_id,slug,item_index,asset,price,buyer,seller,source,block_time) VALUES('t2','geo-stock',1,?1,150,'b','s','TCOMP',?2)", [assets["geo-stock"], now - 60]);
  db.run("INSERT INTO listing(slug,item_index,asset,price,seller,source,listed_at,updated_at) VALUES('geo-stock',1,?1,200,'s','TCOMP',?2,?2)", [assets["geo-stock"], now]);
  const kr = (await get("/market", "KR")).body.collections;
  expect(kr.map((r: any) => r.slug)).toEqual(["geo-stock", "geo-sol"]);
  expect(kr[0]).toMatchObject({ floor: 200, listed: 1, change24h: 50, currency: { symbol: "NVDA" } });
  expect(kr[1]).toMatchObject({ floor: 0, listed: 0, lastSaleAt: 0, change24h: 0 });
  expect((await get("/market", "US")).body.collections.map((r: any) => r.slug)).toEqual(["geo-sol"]);
  const [l] = (await get("/c/geo-stock/listings", "KR")).body.listings;
  expect(l).toMatchObject({ asset: assets["geo-stock"], price: 200, lastSale: 150, listedAt: now, rarity: null });
});

test("a collection priced in a currency that is no longer offered is hidden from everyone", async () => {
  // xStocks NVDAx: once offered, now withdrawn. The collection was made while it was.
  db.run("UPDATE collection SET currency_mint = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh' WHERE slug = 'geo-stock'");
  expect(await slugs("KR")).toEqual(["geo-sol"]);
  expect((await get("/c/geo-stock", "KR")).status).toBe(404);
  expect((await get("/market", "KR")).body.collections.map((r: any) => r.slug)).toEqual(["geo-sol"]);
  expect((await get("/creator/currencies", "KR")).body.currencies.map((x: any) => x.symbol)).not.toContain("NVDAx");
  db.run("UPDATE collection SET currency_mint = ?1 WHERE slug = 'geo-stock'", [NVDA]);
});
