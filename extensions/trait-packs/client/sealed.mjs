import { PublicKey, SystemProgram } from "@solana/web3.js";
import { Buffer } from "buffer";
import { addresses, account, instruction, u32, u16, u64 } from "./protocol.mjs";
const CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
export function sealedAddresses(program, collection, asset) {
  program = new PublicKey(program);
  const k = addresses(program, new PublicKey(collection));
  const release = PublicKey.findProgramAddressSync(
    [Buffer.from("sealed-release-v1"), k.pool.toBuffer()],
    program,
  )[0];
  return {
    ...k,
    release,
    authority: PublicKey.findProgramAddressSync(
      [Buffer.from("sealed-authority-v1"), release.toBuffer()],
      program,
    )[0],
    receipt: asset
      ? PublicKey.findProgramAddressSync(
          [Buffer.from("sealed-pack-v1"), new PublicKey(asset).toBuffer()],
          program,
        )[0]
      : null,
  };
}
export function readSealedRelease(bytes) {
  const d = Buffer.from(bytes);
  if (
    d.length !== 320 ||
    d.subarray(0, 8).toString() !== "NUBSEAL1" ||
    d[84] > 32 ||
    d[117] > 159
  )
    throw Error("Invalid sealed release");
  const supply = d.readUInt32LE(72),
    minted = d.readUInt32LE(76),
    opened = d.readUInt32LE(80);
  if (opened > minted || minted > supply)
    throw Error("Invalid release counters");
  return {
    pool: new PublicKey(d.subarray(8, 40)),
    packCollection: new PublicKey(d.subarray(40, 72)),
    supply,
    minted,
    opened,
    unminted: supply - minted,
    sealed: minted - opened,
    name: d.subarray(85, 85 + d[84]).toString(),
    uri: d.subarray(118, 118 + d[117]).toString(),
  };
}
export function readSealedPack(bytes) {
  const d = Buffer.from(bytes);
  if (
    d.length !== 160 ||
    d.subarray(0, 8).toString() !== "NUBPACK1" ||
    d[13] > 1
  )
    throw Error("Invalid sealed pack");
  return {
    release: new PublicKey(d.subarray(16, 48)),
    asset: new PublicKey(d.subarray(48, 80)),
    serial: d.readUInt32LE(80),
    opened: !!d[13],
    paid: d.readBigUInt64LE(88),
    opener: new PublicKey(d.subarray(96, 128)),
    epoch: d.readBigUInt64LE(128),
    ticket: d.readUInt16LE(136),
  };
}
export function initializeSealedRelease({
  program,
  collection,
  creator,
  packCollection,
  supply,
  name,
  uri,
}) {
  if (
    !Number.isInteger(supply) ||
    supply < 1 ||
    supply > 250000 ||
    typeof name !== "string" ||
    !name ||
    Buffer.byteLength(name) > 32 ||
    typeof uri !== "string" ||
    !uri ||
    Buffer.byteLength(uri) > 159
  )
    throw Error("Invalid sealed release terms");
  program = new PublicKey(program);
  const k = sealedAddresses(program, collection),
    body = Buffer.alloc(197);
  body.writeUInt32LE(supply);
  body[4] = Buffer.byteLength(name);
  body.write(name, 5);
  body[37] = Buffer.byteLength(uri);
  body.write(uri, 38);
  return instruction(
    program,
    30,
    [
      account(new PublicKey(creator), true, true),
      account(k.pool, true),
      account(k.release, true),
      account(new PublicKey(packCollection), true, true),
      account(k.authority),
      account(CORE),
      account(SystemProgram.programId),
    ],
    body,
  );
}
export function buySealedPack({
  program,
  collection,
  buyer,
  packCollection,
  asset,
  serial,
  expectedTotal,
}) {
  if (
    !Number.isInteger(serial) ||
    serial < 0 ||
    serial > 0xffffffff ||
    !Number.isSafeInteger(expectedTotal) ||
    expectedTotal <= 0
  )
    throw Error("Invalid pack purchase terms");
  program = new PublicKey(program);
  const k = sealedAddresses(program, collection, asset);
  return instruction(
    program,
    31,
    [
      account(new PublicKey(buyer), true, true),
      account(k.pool, true),
      account(k.release, true),
      account(new PublicKey(packCollection), true),
      account(new PublicKey(asset), true, true),
      account(k.receipt, true),
      account(k.authority),
      account(k.ops, true),
      account(CORE),
      account(SystemProgram.programId),
    ],
    Buffer.concat([u32(serial), u64(expectedTotal)]),
  );
}
export function openSealedPack({
  program,
  collection,
  holder,
  packCollection,
  asset,
  epoch,
  ticket,
  expectedTotal,
}) {
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    !Number.isInteger(ticket) ||
    ticket < 0 ||
    ticket >= 32 ||
    !Number.isSafeInteger(expectedTotal) ||
    expectedTotal <= 0
  )
    throw Error("Invalid pack opening terms");
  program = new PublicKey(program);
  const k = sealedAddresses(program, collection, asset),
    e = addresses(program, new PublicKey(collection), epoch);
  return instruction(
    program,
    32,
    [
      account(new PublicKey(holder), true, true),
      account(k.pool, true),
      account(k.release, true),
      account(new PublicKey(packCollection), true),
      account(new PublicKey(asset), true),
      account(k.receipt, true),
      account(e.epoch, true),
      account(k.ops, true),
      account(CORE),
      account(SystemProgram.programId),
    ],
    Buffer.concat([u16(ticket), u64(expectedTotal)]),
  );
}
