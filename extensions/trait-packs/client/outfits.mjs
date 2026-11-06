import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import { Buffer } from "buffer";
import bs58 from "bs58";
import {
  addresses,
  account as a,
  instruction,
  readLoadout,
  assertPackDeployment,
} from "./protocol.mjs";
import {
  sendWalletTransaction,
  assertConnectionChain,
} from "./transactions.mjs";
const core = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const discriminator = (name) =>
  Buffer.from(sha256(new TextEncoder().encode("global:" + name))).subarray(
    0,
    8,
  );
export function outfitConsentInstructions({
  program,
  nftProgram,
  collection,
  admin,
  owner,
  asset,
  inscription,
  bodyClass,
  metadataUri,
}) {
  [program, nftProgram, collection, admin, owner, asset] = [
    program,
    nftProgram,
    collection,
    admin,
    owner,
    asset,
  ].map((value) => new PublicKey(value));
  const raw = bs58.decode(inscription),
    uri = Buffer.from(metadataUri, "utf8");
  if (
    raw.length !== 64 ||
    uri.length > 160 ||
    !Number.isInteger(bodyClass) ||
    bodyClass < 0 ||
    bodyClass > 7
  )
    throw Error("Invalid outfit consent");
  const parsed = new URL(metadataUri);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    (parsed.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/wardrobe/metadata/" + asset
  )
    throw Error("Invalid derived outfit URI");
  const registry = PublicKey.findProgramAddressSync(
      [Buffer.from("registry"), collection.toBuffer()],
      nftProgram,
    )[0],
    collectionAuth = PublicKey.findProgramAddressSync(
      [Buffer.from("collection-auth"), registry.toBuffer()],
      nftProgram,
    )[0],
    recovery = PublicKey.findProgramAddressSync(
      [Buffer.from("wardrobe-meta"), asset.toBuffer()],
      nftProgram,
    )[0],
    record = PublicKey.findProgramAddressSync(
      [
        Buffer.from("inscription"),
        Buffer.from(raw.subarray(0, 32)),
        Buffer.from(raw.subarray(32)),
      ],
      nftProgram,
    )[0],
    keys = addresses(program, collection),
    length = Buffer.alloc(4);
  length.writeUInt32LE(uri.length);
  return [
    new TransactionInstruction({
      programId: nftProgram,
      keys: [
        a(admin, true, true),
        a(registry),
        a(asset, true),
        a(record),
        a(collection, true),
        a(collectionAuth),
        a(core),
        a(SystemProgram.programId),
        a(owner, true, true),
        a(recovery, true),
        a(SystemProgram.programId),
      ],
      data: Buffer.concat([
        discriminator("opt_in_wardrobe_metadata"),
        length,
        uri,
      ]),
    }),
    instruction(
      program,
      24,
      [
        a(owner, true, true),
        a(admin, false, true),
        a(keys.pool),
        a(registry),
        a(collection, true),
        a(asset, true),
        a(keys.loadout(asset), true),
        a(collectionAuth),
        a(program),
        a(nftProgram),
        a(core),
        a(SystemProgram.programId),
      ],
      Buffer.from([bodyClass]),
    ),
  ];
}
export async function enableOutfits({
  connection,
  wallet,
  account,
  creatorWallet,
  creatorAccount,
  chain,
  localGenesis,
  context,
  expectedAsset,
  deployment,
  collection,
}) {
  assertPackDeployment(context,deployment,collection);
  if (!expectedAsset || context.asset !== expectedAsset) throw Error("Selected NFT changed");
  if (!creatorAccount || creatorAccount.address !== context.admin)
    throw Error("The registered creator must explicitly co-sign this NFT");
  await assertConnectionChain(connection, chain, localGenesis);
  const program = new PublicKey(context.program),
    asset = new PublicKey(context.asset),
    keys = addresses(program, new PublicKey(context.collection));
  const existing = await connection.getAccountInfo(
    keys.loadout(asset),
    "confirmed",
  );
  if (existing) {
    if (!existing.owner.equals(program))
      throw Error("Wrong existing outfit policy");
    const load = readLoadout(existing.data);
    if (
      !load.pool.equals(keys.pool) ||
      !load.avatar.equals(asset) ||
      load.bodyClass !== context.bodyClass ||
      load.definitionIds.some((id) => id !== 255)
    )
      throw Error(
        "Existing outfit policy must be empty and match the reviewed body",
      );
  }
  const instructions = outfitConsentInstructions({
    ...context,
    owner: account.address,
  });
  const tx = new Transaction().add(
    ...(existing ? instructions.slice(0, 1) : instructions),
  );
  return sendWalletTransaction({
    connection,
    wallet,
    account,
    chain,
    localGenesis,
    transaction: tx,
    coSigners: [{ wallet: creatorWallet, account: creatorAccount }],
  });
}
export function restoreOutfitInstruction({
  nftProgram,
  collection,
  owner,
  asset,
}) {
  [nftProgram, collection, owner, asset] = [
    nftProgram,
    collection,
    owner,
    asset,
  ].map((value) => new PublicKey(value));
  const registry = PublicKey.findProgramAddressSync(
      [Buffer.from("registry"), collection.toBuffer()],
      nftProgram,
    )[0],
    authority = PublicKey.findProgramAddressSync(
      [Buffer.from("collection-auth"), registry.toBuffer()],
      nftProgram,
    )[0],
    recovery = PublicKey.findProgramAddressSync(
      [Buffer.from("wardrobe-meta"), asset.toBuffer()],
      nftProgram,
    )[0];
  return new TransactionInstruction({
    programId: nftProgram,
    keys: [
      a(owner, true, true),
      a(registry),
      a(asset, true),
      a(recovery),
      a(collection, true),
      a(authority),
      a(core),
      a(SystemProgram.programId),
    ],
    data: discriminator("restore_wardrobe_metadata"),
  });
}
