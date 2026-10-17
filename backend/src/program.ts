// The on-chain program surface the backend touches: PDA derivation, the
// register instruction builders, and account reads for the reconciler. Anchor
// builds instructions offline; only the account reads hit the chain, through
// the provider's primary connection. The security-critical verification read is
// the rotating pool's job (verifier.ts), not this file.

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { publicKey as umiPk } from "@metaplex-foundation/umi";
import { fetchAssetsByCollection } from "@metaplex-foundation/mpl-core";
import { config, idl, MPL_CORE } from "./config.ts";

const connection = new Connection(config.rpcUrls[0], "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(config.registrar), {
  commitment: "confirmed",
});
export const program = new anchor.Program(idl, provider);
export const PLATFORM_TREASURY = new PublicKey("EWNSTD8tikwqHMcRNuuNbZrnYJUiJdKq9UXLXSEU4wZ1");
const bs58 = anchor.utils.bytes.bs58;
const enc = new TextEncoder();

export function registryOf(collection: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("registry"), collection.toBuffer()], config.programId)[0];
}
export function collectionAuthOf(registry: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("collection-auth"), registry.toBuffer()], config.programId)[0];
}
export function inscriptionPda(sig: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode("inscription"), Buffer.from(sig.slice(0, 32)), Buffer.from(sig.slice(32))],
    config.programId
  )[0];
}

export const sigBytes = (base58: string): Uint8Array => {
  const b = bs58.decode(base58);
  if (b.length !== 64) throw new Error(`signature is ${b.length} bytes, expected 64`);
  return b;
};

type Target = { collection: PublicKey; treasury: PublicKey };

export function buildRegisterItemIx(t: Target, a: {
  index: number;
  contentHash: Uint8Array; // 32
  inscriptionSig: Uint8Array; // 64
  metaSig: Uint8Array; // 64
  name: string;
  uri: string;
  minter: PublicKey;
  owner: PublicKey;
  asset: PublicKey;
}): Promise<TransactionInstruction> {
  const registry = registryOf(t.collection);
  return program.methods
    .registerItem(a.index, Array.from(a.contentHash), Array.from(a.inscriptionSig), Array.from(a.metaSig), a.name, a.uri)
    .accountsStrict({
      minter: a.minter,
      owner: a.owner,
      registrar: config.registrar.publicKey,
      registry,
      inscriptionRecord: inscriptionPda(a.inscriptionSig),
      collection: t.collection,
      collectionAuth: collectionAuthOf(registry),
      treasury: t.treasury,
      platformTreasury: PLATFORM_TREASURY,
      asset: a.asset,
      mplCoreProgram: MPL_CORE,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export function buildRegisterSingleIx(t: Target, a: {
  inscriptionSig: Uint8Array;
  metaSig: Uint8Array;
  name: string;
  uri: string;
  minter: PublicKey;
  owner: PublicKey;
  asset: PublicKey;
}): Promise<TransactionInstruction> {
  const registry = registryOf(t.collection);
  return program.methods
    .registerSingle(Array.from(a.inscriptionSig), Array.from(a.metaSig), a.name, a.uri)
    .accountsStrict({
      minter: a.minter,
      owner: a.owner,
      registrar: config.registrar.publicKey,
      registry,
      inscriptionRecord: inscriptionPda(a.inscriptionSig),
      collection: t.collection,
      collectionAuth: collectionAuthOf(registry),
      treasury: t.treasury,
      platformTreasury: PLATFORM_TREASURY,
      asset: a.asset,
      mplCoreProgram: MPL_CORE,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export type OnChainSlot = {
  index: number;
  owner: string;
  asset: string;
  inscriptionSig: string; // base58
  metaSig: string; // base58
  registeredAt: number;
};

export type OnChainRegistry = {
  minted: number;
  maxSupply: number;
  priceLamports: number;
  depositLamports: number;
  frozen: boolean;
  treasury: string;
  registrar: string;
  admin: string;
  bitmap: Uint8Array; // one bit per index, index i at bit i-1
};

export async function fetchRegistry(registry: PublicKey): Promise<OnChainRegistry> {
  const r = (await program.account.registry.fetchNullable(registry, "confirmed")) as any;
  if (!r) throw new Error(`registry ${registry.toBase58()} not found on chain`);
  return {
    minted: r.minted as number,
    maxSupply: r.maxSupply as number,
    priceLamports: Number(r.priceLamports),
    depositLamports: Number(r.depositLamports),
    frozen: r.frozen as boolean,
    treasury: (r.treasury as PublicKey).toBase58(),
    registrar: (r.registrar as PublicKey).toBase58(),
    admin: (r.admin as PublicKey).toBase58(),
    bitmap: Uint8Array.from(r.mintedBitmap as number[]),
  };
}

export const isMinted = (bitmap: Uint8Array, index: number): boolean =>
  ((bitmap[(index - 1) >> 3] ?? 0) >> ((index - 1) & 7) & 1) === 1;

export function mintedIndicesOf(bitmap: Uint8Array, maxSupply: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= maxSupply; i++) if (isMinted(bitmap, i)) out.push(i);
  return out;
}

// Every asset of a collection, read from Metaplex Core itself (getProgramAccounts
// on mpl-core filtered by the collection), with the index and both inscription
// sigs taken from the Attributes our program wrote. The on-chain index -> asset
// map, and what makes a wiped database a restart.
const umi = createUmi(config.rpcUrls[0], { commitment: "confirmed" });
export async function fetchCollectionAssets(collection: PublicKey): Promise<OnChainSlot[]> {
  const assets = await fetchAssetsByCollection(umi, umiPk(collection.toBase58()));
  const out: OnChainSlot[] = [];
  for (const a of assets) {
    const attrs = Object.fromEntries(((a as any).attributes?.attributeList ?? []).map((x: any) => [x.key, x.value]));
    if (!attrs.inscription || !attrs.metadata) continue; // not one of ours
    out.push({
      index: Number(attrs.index ?? 0),
      owner: a.owner.toString(),
      asset: a.publicKey.toString(),
      inscriptionSig: bs58.encode(Buffer.from(attrs.inscription, "hex")),
      metaSig: bs58.encode(Buffer.from(attrs.metadata, "hex")),
      registeredAt: 0,
    });
  }
  return out;
}
