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
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity, publicKey as umiPk, generateSigner } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair, toWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import { createCollection, ruleSet } from "@metaplex-foundation/mpl-core";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { writer } from "@iqlabs-official/solana-sdk";
import { config, idl } from "../src/config.ts";
import { db, nowSec } from "../src/db.ts";
import { registryOf, collectionAuthOf } from "../src/program.ts";
import { uploadToArweave } from "../src/arweave.ts";
import { assetUri } from "../src/metadata.ts";
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
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const creator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(a.creator!.replace(/^~/, process.env.HOME!), "utf8"))));
const connection = new Connection(config.rpcUrls[0], "confirmed");
const price = Number(a.price);
const deposit = Number(a.deposit);
if (deposit > price) throw new Error("deposit cannot exceed price");

// 1. Items: read the folder, pair image i with template i.
type Item = { index: number; name: string; bytes: Buffer; mime: string; template: Record<string, unknown> };
function readItems(dir: string): Item[] {
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
  const items = a.single ? [] : readItems(a.dir!);
  console.log(`${a.slug}: ${items.length} items, price ${price}, deposit ${deposit}, creator ${creator.publicKey.toBase58()}`);

  // 2. Images to Arweave (permanent buffer), hashes for the manifest.
  const manifestItems: { index: number; name: string; image_sha256: string; image_mime: string; meta_sha256: string; arweave_id: string }[] = [];
  for (const it of items) {
    const arweave_id = await uploadToArweave(it.bytes, it.mime);
    const templateJson = JSON.stringify(it.template);
    manifestItems.push({ index: it.index, name: it.name, image_sha256: sha256(it.bytes), image_mime: it.mime, meta_sha256: sha256(templateJson), arweave_id });
    console.log(`  item ${it.index} -> arweave ${arweave_id} (${it.bytes.length} B)`);
  }

  // 3. Manifest and collection.json inscribed by the creator.
  const seed = randomBytes(32);
  const shuffleCommit = sha256(seed);
  const manifestJson = JSON.stringify({ std: "iqnft-0.1", slug: a.slug, name: a.name, shuffle_commit: shuffleCommit, items: manifestItems });
  const manifestHash = sha256(manifestJson);
  const manifestSig = a.single ? "" : await writer.codeIn({ connection, signer: creator }, manifestJson, `${a.slug}-manifest.json`, 0, "json");
  if (manifestSig) console.log(`  manifest -> ${manifestSig}`);
  const collectionJson = JSON.stringify({
    name: a.name,
    symbol: a.symbol,
    description: a.description,
    image: items.length ? `${config.arweaveGateway}/${manifestItems[0].arweave_id}` : "",
    external_url: `${config.siteBase}/c/${a.slug}`,
    properties: { category: "image" },
  });
  const metaSig = await writer.codeIn({ connection, signer: creator }, collectionJson, `${a.slug}-collection.json`, 0, "json");
  console.log(`  collection.json -> ${metaSig}`);

  // 4. Core collection under the program PDA, royalties to the creator.
  const umi = createUmi(connection.rpcEndpoint, { commitment: "confirmed" }).use(keypairIdentity(fromWeb3JsKeypair(creator)));
  const collectionSigner = generateSigner(umi);
  const collectionPk = toWeb3JsPublicKey(collectionSigner.publicKey);
  const registry = registryOf(collectionPk);
  await createCollection(umi, {
    collection: collectionSigner,
    updateAuthority: umiPk(collectionAuthOf(registry).toBase58()),
    name: a.name!,
    uri: assetUri(metaSig),
    plugins: [
      { type: "Royalties", basisPoints: Number(a["royalty-bps"]), creators: [{ address: umiPk(creator.publicKey.toBase58()), percentage: 100 }], ruleSet: ruleSet("None") },
    ],
  }).sendAndConfirm(umi);
  console.log(`  core collection ${collectionPk.toBase58()}, registry ${registry.toBase58()}`);

  // 5. initialize_registry: payer = creator keypair, admin = creator wallet.
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(creator), { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider);
  const sig64 = (s: string) => (s ? Array.from(anchor.utils.bytes.bs58.decode(s)) : new Array(64).fill(0));
  await program.methods
    .initializeRegistry(
      items.length,
      Array.from(Buffer.from(manifestHash, "hex")),
      sig64(manifestSig),
      Array.from(Buffer.from(shuffleCommit, "hex")),
      config.registrar.publicKey,
      creator.publicKey,
      new BN(price),
      new BN(deposit),
      creator.publicKey
    )
    .accountsStrict({
      payer: creator.publicKey,
      collection: collectionPk,
      registry,
      collectionAuth: collectionAuthOf(registry),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`  initialize_registry done`);

  // 6. Backend DB.
  db.run("BEGIN");
  db.query(
    `INSERT INTO collection (slug, core_collection, registry, name, symbol, description, creator, treasury, max_supply,
       price_lamports, deposit_lamports, sequential, shuffle_seed, shuffle_commit, manifest_sig, manifest_hash, meta_sig, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`
  ).run(a.slug!, collectionPk.toBase58(), registry.toBase58(), a.name!, a.symbol!, a.description!, creator.publicKey.toBase58(), items.length,
    price, deposit, a.sequential ? 1 : 0, seed.toString("hex"), shuffleCommit, manifestSig, manifestHash, metaSig, nowSec());
  const ins = db.query("INSERT INTO item (slug, item_index, name, image_sha256, image_mime, meta_sha256, arweave_id, template) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)");
  for (const it of items) {
    const m = manifestItems.find((x) => x.index === it.index)!;
    ins.run(a.slug!, it.index, it.name, m.image_sha256, m.image_mime, m.meta_sha256, m.arweave_id, JSON.stringify(it.template));
  }
  db.run("COMMIT");

  // 7. Feed row so the site's launchpad list sees it (best effort).
  if (!a["skip-feed"]) {
    try {
      const row = JSON.stringify({ kind: "collection", body: JSON.stringify({ slug: a.slug, collection: collectionPk.toBase58(), registry: registry.toBase58(), meta: metaSig, manifest: manifestSig }), who: creator.publicKey.toBase58() });
      const feedSig = await writer.writeRow(connection, creator, dbRootSeed, feedSeed, row, false, [userInventoryPda(creator.publicKey)]);
      console.log(`  feed row -> ${feedSig}`);
    } catch (e) {
      console.warn(`  feed row skipped: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`\ndeployed ${a.slug}: collection ${collectionPk.toBase58()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
