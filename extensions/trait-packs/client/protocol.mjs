// The sole JS encoder/decoder for the new private paid-program candidate.
import { sha256 } from "@noble/hashes/sha256";
import { Buffer } from "buffer";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
// UI uses exact JS numbers; reject values outside that representation instead
// of rounding an on-chain price, balance or slot. A general SDK may retain BigInt.
export function readU64Safe(data, offset) {
  const value = data.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw Error("On-chain u64 exceeds exact JavaScript number range.");
  return Number(value);
}
export const key = (data, offset) =>
  new PublicKey(data.subarray(offset, offset + 32));
export const u64 = (n) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(n));
  return bytes;
};
export const u32 = (n) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(n);
  return bytes;
};
export const u16 = (n) => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(n);
  return bytes;
};
export const account = (pubkey, isWritable = false, isSigner = false) => ({
  pubkey,
  isWritable,
  isSigner,
});
export const instruction = (
  program,
  opcode,
  accounts,
  data = Buffer.alloc(0),
) =>
  new TransactionInstruction({
    programId: program,
    keys: accounts,
    data: Buffer.concat([Buffer.from([opcode]), data]),
  });
export function addresses(program, collection, epochId = 0) {
  const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, program)[0];
  const pool = pda(Buffer.from("sale-v4"), collection.toBuffer()),
    epoch = pda(Buffer.from("epoch-v4"), pool.toBuffer(), u64(epochId));
  return {
    pool,
    epoch,
    ops: pda(Buffer.from("ops-v4"), pool.toBuffer()),
    requester: pda(Buffer.from("requester-v4"), epoch.toBuffer()),
    gearAuthority: pda(Buffer.from("gear-authority-v4"), pool.toBuffer()),
    issuance: (asset) => pda(Buffer.from("gear-v4"), asset.toBuffer()),
    loadout: (asset) => pda(Buffer.from("loadout-v4"), asset.toBuffer()),
  };
}
export function readPool(data) {
  const d = Buffer.from(data);
  if (d.length !== 4352 || d.subarray(0, 8).toString() !== "NUBSALE4")
    throw Error("Invalid paid pool.");
  return {
    authority: key(d, 8),
    collection: key(d, 40),
    treasury: key(d, 72),
    provider: key(d, 104),
    providerTreasury: key(d, 136),
    catalogHash: d.subarray(168, 200).toString("hex"),
    price: readU64Safe(d, 200),
    definitionCount: d[208],
    pulls: d[209],
    window: readU64Safe(d, 210),
    timeout: readU64Safe(d, 218),
    epochCount: readU64Safe(d, 226),
    activeEpoch: readU64Safe(d, 234),
    outstandingTraits: readU64Safe(d, 242),
    definitions: Array.from({ length: d[208] }, (_, i) => {
      const o = 384 + i * 240;
      return {
        id: i,
        slot: d[o],
        bodyMask: d[o + 1],
        requiredSlot: d[o + 2],
        requiredDefinition: d[o + 3],
        hash: d.subarray(o + 4, o + 36).toString("hex"),
        name: d.subarray(o + 37, o + 37 + d[o + 36]).toString(),
        uri: d.subarray(o + 70, o + 70 + d[o + 69]).toString(),
        remaining: d.readUInt32LE(o + 232),
      };
    }),
  };
}
export function readEpoch(data) {
  const d = Buffer.from(data);
  if (d.length !== 2048 || d.subarray(0, 8).toString() !== "NUBEPOC4")
    throw Error("Invalid paid epoch.");
  return {
    pool: key(d, 8),
    id: readU64Safe(d, 40),
    status: d[48],
    closeSlot: readU64Safe(d, 49),
    deadlineSlot: readU64Safe(d, 57),
    ticketCount: d.readUInt16LE(65),
    cursor: d.readUInt16LE(67),
    escrow: readU64Safe(d, 69),
    seed: d.subarray(77, 109),
    entropy: d.subarray(109, 141),
    requested: !!d[141],
    inventory: Array.from({ length: 16 }, (_, i) =>
      d.readUInt32LE(160 + i * 4),
    ),
    tickets: Array.from({ length: d.readUInt16LE(65) }, (_, i) => {
      const o = 256 + i * 48;
      return {
        serial: i,
        buyer: key(d, o),
        paid: readU64Safe(d, o + 32),
        definitions: [...d.subarray(o + 40, o + 44)],
        claimMask: d[o + 44],
        refunded: !!d[o + 45],
      };
    }),
  };
}
export function encodeDefinitions(definitions) {
  return Buffer.concat(
    definitions.map((def) => {
      const d = Buffer.alloc(240),
        name = Buffer.from(def.name),
        uri = Buffer.from(def.uri);
      if (
        name.length > 32 ||
        uri.length > 160 ||
        name.length === 0 ||
        uri.length === 0
      )
        throw Error("Catalog string bound");
      d[0] = def.slot;
      d[1] = def.bodyMask;
      d[2] = def.requiredSlot ?? 255;
      d[3] = def.requiredDefinition ?? 255;
      Buffer.from(def.hash, "hex").copy(d, 4);
      d[36] = name.length;
      name.copy(d, 37);
      d[69] = uri.length;
      uri.copy(d, 70);
      d.writeUInt32LE(def.supply, 232);
      return d;
    }),
  );
}
export function readGear(data) {
  const d = Buffer.from(data);
  if (d.length !== 140 || d.subarray(0, 8).toString() !== "NUBGEAR4")
    throw Error("Invalid gear record");
  return {
    pool: key(d, 8),
    epoch: key(d, 40),
    ticket: d.readUInt16LE(72),
    pull: d[74],
    definition: d[75],
    asset: key(d, 76),
    avatar: key(d, 108),
  };
}
export function readLoadout(data) {
  const d = Buffer.from(data);
  if (d.length !== 312 || d.subarray(0, 8).toString() !== "NUBLOAD4")
    throw Error("Invalid loadout");
  return {
    bodyClass: d[13],
    avatar: key(d, 14),
    pool: key(d, 46),
    baseHash: d.subarray(78, 110).toString("hex"),
    definitionIds: [...d.subarray(110, 116)],
    slots: Array.from({ length: 6 }, (_, i) => key(d, 116 + i * 32)),
    revision: d.readUInt32LE(308),
    burnPolicy: d[11],
  };
}

// Byte-for-byte counterpart of opcode 4's domain-separated candidate seed hash.
export function candidateRequestSeed(
  snapshotCommit,
  nonce,
  program,
  pool,
  epoch,
  requester,
) {
  const snapshot = Buffer.from(snapshotCommit),
    random = Buffer.from(nonce);
  if (snapshot.length !== 32 || random.length !== 32)
    throw Error("Request snapshot and nonce must be 32 bytes");
  return Buffer.from(
    sha256(
      Buffer.concat([
        Buffer.from("nubbies-paid-request-v6"),
        snapshot,
        random,
        program.toBuffer(),
        pool.toBuffer(),
        epoch.toBuffer(),
        requester.toBuffer(),
      ]),
    ),
  );
}
export function encodeRequest(funding, nonce) {
  const n = Buffer.from(nonce);
  if (n.length !== 32) throw Error("Request nonce must be 32 bytes");
  return Buffer.concat([u64(funding), n]);
}
