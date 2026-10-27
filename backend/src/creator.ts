// The collection-deploy core, shared by the CLI (deploy-collection.ts, signs
// with a keypair) and the creator wizard endpoints (the creator's browser burner
// signs, the backend builds). Three responsibilities, no signing here:
//   stageCollection  - images to Arweave, server-side shuffle seed, the manifest
//                       and collection.json BYTES the creator will inscribe.
//   buildDeploy      - the one createCollection + initialize_registry tx, built
//                       for a given creator + collection pubkey (caller signs).
//   recordCollection - the backend DB rows, after the tx has landed.
// The shuffle seed is generated and kept here, never handed to the browser; only
// its commit (sha256) goes into the manifest and on-chain.
import { createHash, randomBytes } from "node:crypto";
import { Transaction, SystemProgram, type Connection, type PublicKey } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { publicKey as umiPk, createNoopSigner } from "@metaplex-foundation/umi";
import { toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import { createCollection, ruleSet } from "@metaplex-foundation/mpl-core";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { config } from "./config.ts";
import { db, nowSec } from "./db.ts";
import { program, registryOf, collectionAuthOf, PLATFORM_TREASURY } from "./program.ts";
import { uploadToArweave } from "./arweave.ts";
import { assetUri } from "./metadata.ts";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

// The creator deploy fee (covers the backend-fronted Arweave upload + margin),
// paid to the platform treasury inside the deploy tx. Shown to the creator before
// they sign. itemCount 0 (single registry) still pays the base.
export const deployFee = (itemCount: number) => config.deployFeeBase + config.deployFeePerItem * itemCount;

export type DeploySpec = {
  slug: string;
  name: string;
  symbol: string;
  description: string;
  price: number;
  deposit: number;
  royaltyBps: number;
  sequential: boolean;
};
export type StageItem = { index: number; name: string; bytes: Buffer; mime: string; template: Record<string, unknown> };
export type ManifestItem = { index: number; name: string; image_sha256: string; image_mime: string; meta_sha256: string; arweave_id: string };
export type Staged = {
  seed: Buffer;
  shuffleCommit: string;
  manifestHash: string;
  manifestJson: string; // the creator inscribes this -> manifestSig
  collectionJson: string; // the creator inscribes this -> metaSig
  manifestItems: ManifestItem[];
  itemCount: number;
};

// The allocator and on-chain bitmap address exactly 1..itemCount.
export function validateItemIndices(items: { index: number }[]): void {
  const seen = new Set<number>();
  for (const { index } of items) {
    if (!Number.isInteger(index) || index < 1 || index > items.length || seen.has(index)) {
      throw new Error(`item indices must be unique integers from 1 to ${items.length}`);
    }
    seen.add(index);
  }
}

// Upload each image to Arweave, build the manifest + collection.json. `single`
// (itemCount 0) skips Arweave and leaves the manifest empty (no items, no sig).
export async function stageCollection(spec: DeploySpec, items: StageItem[]): Promise<Staged> {
  validateItemIndices(items);
  const manifestItems: ManifestItem[] = [];
  for (const it of items) {
    const arweave_id = await uploadToArweave(it.bytes, it.mime);
    const templateJson = JSON.stringify(it.template);
    manifestItems.push({ index: it.index, name: it.name, image_sha256: sha256(it.bytes), image_mime: it.mime, meta_sha256: sha256(templateJson), arweave_id });
  }
  const seed = randomBytes(32);
  const shuffleCommit = sha256(seed);
  const manifestJson = JSON.stringify({ std: "iqnft-0.1", slug: spec.slug, name: spec.name, shuffle_commit: shuffleCommit, items: manifestItems });
  // Default collection image = the first item (used when the creator uploads no
  // logo, and by the CLI). buildCollectionJson rebuilds it when a logo exists.
  const fallbackImage = manifestItems.length ? `${config.arweaveGateway}/${manifestItems[0].arweave_id}` : "";
  const collectionJson = buildCollectionJson(spec, fallbackImage, "");
  return { seed, shuffleCommit, manifestHash: sha256(manifestJson), manifestJson, collectionJson, manifestItems, itemCount: items.length };
}

// The collection metadata JSON (the Core collection's uri points here, so
// marketplaces read the collection logo/banner/description from it). Field names
// follow the widely-read collection-metadata standard (OpenSea / ERC-7572
// contract-level metadata): `image` = logo/pfp, `banner_image` = the wide header,
// `external_link` = the site. We also keep Metaplex's `external_url` and a plain
// `banner` alias so any reader (ME/Tensor/OpenSea/explorers) finds them. Both
// image URLs are gateway/img/{C} of the creator's inscriptions (image falls back
// to the first item when no logo is uploaded).
export function buildCollectionJson(spec: DeploySpec, imageUrl: string, bannerUrl: string): string {
  const link = `${config.siteBase}/c/${spec.slug}`;
  const j: Record<string, unknown> = {
    name: spec.name,
    symbol: spec.symbol,
    description: spec.description,
    image: imageUrl,
    external_url: link,
    external_link: link,
    properties: { category: "image" },
  };
  if (bannerUrl) {
    j.banner_image = bannerUrl; // OpenSea / ERC-7572 standard key
    j.banner = bannerUrl; // alias for readers that look for `banner`
  }
  return JSON.stringify(j);
}

// gateway/img/{sig}.png serves a feed-row image inscription; the creator
// inscribes the logo/banner as such rows, so their collection.json points here.
export const imgUrl = (sig: string) => `${config.gatewayBase}/img/${sig}.png`;

// The createCollection (authority = our PDA) + initialize_registry instructions
// in one transaction, so no one can initialize a registry for this collection
// between the two. Signing is the caller's: the CLI adds [creator, collection],
// the endpoint returns it for the browser burner + collection keypair to sign.
export async function buildDeploy(args: {
  connection: Connection;
  creatorPubkey: PublicKey; // admin + treasury + royalty recipient (the creator's wallet)
  payerPubkey: PublicKey; // pays rent + deploy fee and signs (the wallet itself, or its burner)
  collectionPubkey: PublicKey;
  spec: DeploySpec;
  itemCount: number;
  manifestHash: string;
  manifestSig: string; // "" for single
  shuffleCommit: string;
  metaSig: string;
}): Promise<{ tx: Transaction; registry: PublicKey }> {
  const registry = registryOf(args.collectionPubkey);
  const umi = createUmi(args.connection.rpcEndpoint, { commitment: "confirmed" });
  const createIxs = createCollection(umi, {
    collection: createNoopSigner(umiPk(args.collectionPubkey.toBase58())),
    payer: createNoopSigner(umiPk(args.payerPubkey.toBase58())),
    updateAuthority: umiPk(collectionAuthOf(registry).toBase58()),
    name: args.spec.name,
    uri: assetUri(args.metaSig),
    plugins: [{ type: "Royalties", basisPoints: args.spec.royaltyBps, creators: [{ address: umiPk(args.creatorPubkey.toBase58()), percentage: 100 }], ruleSet: ruleSet("None") }],
  })
    .getInstructions()
    .map(toWeb3JsInstruction);

  const sig64 = (s: string) => (s ? Array.from(anchor.utils.bytes.bs58.decode(s)) : new Array(64).fill(0));
  const initIx = await program.methods
    .initializeRegistry(
      args.itemCount,
      Array.from(Buffer.from(args.manifestHash, "hex")),
      sig64(args.manifestSig),
      Array.from(Buffer.from(args.shuffleCommit, "hex")),
      config.registrar.publicKey,
      args.creatorPubkey,
      new BN(args.spec.price),
      new BN(args.spec.deposit),
      args.creatorPubkey,
    )
    .accountsStrict({
      payer: args.payerPubkey,
      collection: args.collectionPubkey,
      registry,
      collectionAuth: collectionAuthOf(registry),
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx = new Transaction().add(...createIxs, initIx);
  // Deploy fee: creator -> platform treasury, atomic with the deploy (no extra signature).
  const fee = deployFee(args.itemCount);
  if (fee > 0) tx.add(SystemProgram.transfer({ fromPubkey: args.payerPubkey, toPubkey: PLATFORM_TREASURY, lamports: fee }));
  return { tx, registry };
}

// Write the collection + item rows after the deploy tx has landed. Idempotent on
// the slug via the caller's pre-check; the seed is persisted here (only here).
export function recordCollection(args: {
  spec: DeploySpec;
  collectionPubkey: PublicKey;
  registry: PublicKey;
  creatorPubkey: PublicKey;
  staged: Staged;
  items: StageItem[];
  manifestSig: string;
  metaSig: string;
  logoSig?: string | null;
  bannerSig?: string | null;
}): void {
  const { spec, staged } = args;
  db.transaction(() => {
    db.query(
      `INSERT INTO collection (slug, core_collection, registry, name, symbol, description, creator, treasury, max_supply,
         price_lamports, deposit_lamports, sequential, shuffle_seed, shuffle_commit, manifest_sig, manifest_hash, meta_sig, logo_sig, banner_sig, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`,
    ).run(
      spec.slug, args.collectionPubkey.toBase58(), args.registry.toBase58(), spec.name, spec.symbol, spec.description,
      args.creatorPubkey.toBase58(), staged.itemCount, spec.price, spec.deposit, spec.sequential ? 1 : 0,
      staged.seed.toString("hex"), staged.shuffleCommit, args.manifestSig, staged.manifestHash, args.metaSig,
      args.logoSig ?? null, args.bannerSig ?? null, nowSec(),
    );
    const ins = db.query("INSERT INTO item (slug, item_index, name, image_sha256, image_mime, meta_sha256, arweave_id, template) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)");
    for (const it of args.items) {
      const m = staged.manifestItems.find((x) => x.index === it.index)!;
      ins.run(spec.slug, it.index, it.name, m.image_sha256, m.image_mime, m.meta_sha256, m.arweave_id, JSON.stringify(it.template));
    }
  })();
}
