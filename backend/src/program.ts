// The on-chain program surface the backend touches: PDA derivation, the
// register instruction builders, and account reads for the reconciler. Anchor
// builds instructions offline; only the account reads hit the chain, through
// the provider's primary connection. The security-critical verification read is
// the rotating pool's job (verifier.ts), not this file.

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
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
export function itemSlotPda(registry: PublicKey, index: number): PublicKey {
  const le = Buffer.alloc(4);
  le.writeUInt32LE(index);
  return PublicKey.findProgramAddressSync([enc.encode("item"), registry.toBuffer(), le], config.programId)[0];
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
      itemSlot: itemSlotPda(registry, a.index),
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

// All ItemSlot accounts of one registry (memcmp on the registry field right
// after the discriminator and bump). What makes a wiped database a restart.
export async function fetchItemSlots(registry: PublicKey): Promise<OnChainSlot[]> {
  const rows = await program.account.itemSlot.all([{ memcmp: { offset: 8 + 1, bytes: registry.toBase58() } }]);
  return rows.map((r) => decodeSlot(r.account));
}

export async function fetchRegistry(registry: PublicKey) {
  const r = (await program.account.registry.fetch(registry)) as any;
  return {
    minted: r.minted as number,
    maxSupply: r.maxSupply as number,
    priceLamports: Number(r.priceLamports),
    depositLamports: Number(r.depositLamports),
    frozen: r.frozen as boolean,
    treasury: (r.treasury as PublicKey).toBase58(),
    registrar: (r.registrar as PublicKey).toBase58(),
    admin: (r.admin as PublicKey).toBase58(),
  };
}

function decodeSlot(a: any): OnChainSlot {
  return {
    index: a.index as number,
    owner: (a.owner as PublicKey).toBase58(),
    asset: (a.asset as PublicKey).toBase58(),
    inscriptionSig: bs58.encode(Buffer.from(a.inscriptionSig as number[])),
    metaSig: bs58.encode(Buffer.from(a.metaSig as number[])),
    registeredAt: Number(a.registeredAt),
  };
}

// One slot, or null when that index has not been minted on chain.
export async function fetchItemSlot(registry: PublicKey, index: number): Promise<OnChainSlot | null> {
  const a = await program.account.itemSlot.fetchNullable(itemSlotPda(registry, index), "confirmed");
  return a ? decodeSlot(a) : null;
}
