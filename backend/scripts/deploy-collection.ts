// Deploy one collection against the deployed program, the way the creator
// wizard will, but from a keypair: folder of `N.png` (+ optional `N.json`) ->
// Arweave -> manifest -> inscriptions -> Core collection under the program PDA
// -> initialize_registry -> backend DB -> feed row. No compression here: the
// wizard compresses in the browser before upload; pass already-small images.
//
//   bun --env-file backend/.env.devnet run backend/scripts/deploy-collection.ts \
//     --dir backend/test-assets --slug test-monks --name "Test Monks" --symbol TMONK \
//     --price 10000000 --deposit 2000000 --creator ~/Desktop/deploy/deploy.json
//
//   --single --slug iq6900-inscriptions --name "IQ6900 Inscriptions" --symbol IQNFT
//     creates a max_supply 0 registry for single NFTs (no folder).

import { parseArgs } from "node:util";
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { Connection, Keypair, sendAndConfirmTransaction } from "@solana/web3.js";
import { writer } from "@iqlabs-official/solana-sdk";
import { config } from "../src/config.ts";
import { db } from "../src/db.ts";
import { stageCollection, buildDeploy, recordCollection, type DeploySpec, type StageItem } from "../src/creator.ts";
import { dbRootSeed, feedSeed, userInventoryPda } from "../src/feed.ts";

const { values: a } = parseArgs({
  options: {
    dir: { type: "string" },
    slug: { type: "string" },
    name: { type: "string" },
    symbol: { type: "string" },
    description: { type: "string", default: "" },
    price: { type: "string", default: "0" },
    deposit: { type: "string", default: "0" },
    "royalty-bps": { type: "string", default: "500" },
    sequential: { type: "boolean", default: false },
    single: { type: "boolean", default: false },
    creator: { type: "string" },
    "skip-feed": { type: "boolean", default: false },
  },
});
for (const k of ["slug", "name", "symbol", "creator"] as const) if (!a[k]) throw new Error(`--${k} required`);
if (!a.single && !a.dir) throw new Error("--dir required (or --single)");
if (!/^[a-z0-9-]{3,32}$/.test(a.slug!)) throw new Error("slug must be 3..32 of [a-z0-9-]");
if (db.query("SELECT 1 FROM collection WHERE slug = ?").get(a.slug!)) throw new Error(`slug ${a.slug} already exists in the backend DB`);

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const creator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(a.creator!.replace(/^~/, process.env.HOME!), "utf8"))));
const connection = new Connection(config.rpcUrls[0], "confirmed");
const price = Number(a.price);
const deposit = Number(a.deposit);
if (deposit > price) throw new Error("deposit cannot exceed price");

// 1. Items: read the folder, pair image i with template i.
function readItems(dir: string): StageItem[] {
  const files = readdirSync(dir);
  const images = files.filter((f) => MIME[extname(f).toLowerCase()] && /^\d+\./.test(f));
  const numbers = images.map((f) => Number(f.split(".")[0])).sort((x, y) => x - y);
  if (numbers.length === 0) throw new Error("no numbered images in the folder");
  const base = numbers[0]; // 0-based or 1-based folders both normalize to 1..N
  if (base !== 0 && base !== 1) throw new Error(`images must start at 0 or 1, found ${base}`);
  return numbers.map((n, i) => {
    if (n !== base + i) throw new Error(`missing image number ${base + i}`);
    const file = images.find((f) => Number(f.split(".")[0]) === n)!;
    const jsonFile = files.find((f) => f === `${n}.json`);
    const raw = jsonFile ? (JSON.parse(readFileSync(join(dir, jsonFile), "utf8")) as Record<string, unknown>) : {};
    // The template never carries an image pointer: C fills it at mint.
    const { image: _i, animation_url: _a, properties: _p, external_url: _e, ...rest } = raw as any;
    const index = i + 1;
    const name = typeof rest.name === "string" && rest.name ? rest.name : `${a.name} #${index}`;
    if (Buffer.byteLength(name) > 80) throw new Error(`name over 80 bytes at ${file}`);
    return { index, name, bytes: readFileSync(join(dir, file)), mime: MIME[extname(file).toLowerCase()], template: { ...rest, name } };
  });
}

async function main() {
  const items: StageItem[] = a.single ? [] : readItems(a.dir!);
  const spec: DeploySpec = { slug: a.slug!, name: a.name!, symbol: a.symbol!, description: a.description!, price, deposit, royaltyBps: Number(a["royalty-bps"]), sequential: !!a.sequential };
  console.log(`${spec.slug}: ${items.length} items, price ${price}, deposit ${deposit}, creator ${creator.publicKey.toBase58()}`);

  // Images to Arweave + the manifest/collection.json bytes (shuffle seed stays server-side).
  const staged = await stageCollection(spec, items);
  for (const m of staged.manifestItems) console.log(`  item ${m.index} -> arweave ${m.arweave_id}`);

  // The creator inscribes the manifest (unless single) and collection.json.
  const manifestSig = a.single ? "" : await writer.codeIn({ connection, signer: creator }, staged.manifestJson, `${spec.slug}-manifest.json`, 0, "json");
  if (manifestSig) console.log(`  manifest -> ${manifestSig}`);
  const metaSig = await writer.codeIn({ connection, signer: creator }, staged.collectionJson, `${spec.slug}-collection.json`, 0, "json");
  console.log(`  collection.json -> ${metaSig}`);

  // Core collection + initialize_registry in one tx; the creator and the fresh
  // collection keypair sign.
  const collection = Keypair.generate();
  const { tx, registry } = await buildDeploy({ connection, creatorPubkey: creator.publicKey, payerPubkey: creator.publicKey, collectionPubkey: collection.publicKey, spec, itemCount: staged.itemCount, manifestHash: staged.manifestHash, manifestSig, shuffleCommit: staged.shuffleCommit, metaSig });
  await sendAndConfirmTransaction(connection, tx, [creator, collection], { commitment: "confirmed" });
  console.log(`  core collection ${collection.publicKey.toBase58()} + registry ${registry.toBase58()} (one tx)`);

  recordCollection({ spec, collectionPubkey: collection.publicKey, registry, creatorPubkey: creator.publicKey, staged, items, manifestSig, metaSig });

  // Feed row so the site's launchpad list sees it (best effort).
  if (!a["skip-feed"]) {
    try {
      const row = JSON.stringify({ kind: "collection", body: JSON.stringify({ slug: spec.slug, collection: collection.publicKey.toBase58(), registry: registry.toBase58(), meta: metaSig, manifest: manifestSig }), who: creator.publicKey.toBase58() });
      const feedSig = await writer.writeRow(connection, creator, dbRootSeed, feedSeed, row, false, [userInventoryPda(creator.publicKey)]);
      console.log(`  feed row -> ${feedSig}`);
    } catch (e) {
      console.warn(`  feed row skipped: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`\ndeployed ${spec.slug}: collection ${collection.publicKey.toBase58()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
