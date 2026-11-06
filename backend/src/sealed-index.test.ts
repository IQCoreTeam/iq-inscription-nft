import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Keypair } from "@solana/web3.js";
import { createSealedPackIndex } from "../../extensions/trait-packs/service/sealed-state.mjs";
import { sealedAddresses } from "../../extensions/trait-packs/client/sealed.mjs";
const key = () => Keypair.generate().publicKey;
function fixture() {
  const program = key(),
    collection = key(),
    packCollection = key(),
    asset = key(),
    k = sealedAddresses(program, collection, asset),
    db = new Database(":memory:");
  let owner = key().toBase58(),
    wrong = false,
    reads = 0;
  const pool = Buffer.alloc(4352);
  pool.write("NUBSALE5");
  collection.toBuffer().copy(pool, 40);
  pool.writeBigUInt64LE(100000000n, 200);
  pool[250] = 1;
  pool[253] = 1;
  const release = Buffer.alloc(320);
  release.write("NUBSEAL1");
  k.pool.toBuffer().copy(release, 8);
  packCollection.toBuffer().copy(release, 40);
  release.writeUInt32LE(2, 72);
  release.writeUInt32LE(1, 76);
  const receipt = Buffer.alloc(160);
  receipt.write("NUBPACK1");
  k.release.toBuffer().copy(receipt, 16);
  asset.toBuffer().copy(receipt, 48);
  receipt.writeBigUInt64LE(105000000n, 88);
  const epoch = Buffer.alloc(2048);
  epoch.write("NUBEPOC5");
  k.pool.toBuffer().copy(epoch, 8);
  epoch.writeUInt16LE(1, 65);
  const connection = {
    getGenesisHash: async () => "local-genesis",
    getMultipleAccountsInfoAndContext: async (keys) => {
      reads++;
      return {
        context: { slot: 100 },
        value: keys.map((pk) => ({
          owner: wrong ? key() : program,
          data: pk.equals(k.pool)
            ? pool
            : pk.equals(k.epoch)
              ? epoch
              : pk.equals(k.release)
                ? release
                : receipt,
        })),
      };
    },
  };
  const options = {
    db,
    connection,
    program,
    collection,
    expectedGenesis: "local-genesis",
    chain: "solana:localnet",
    readCoreAssets: async () =>
      new Map([
        [
          asset.toBase58(),
          {
            owner,
            updateAuthority: {
              type: "Collection",
              address: packCollection.toBase58(),
            },
          },
        ],
      ]),
  };
  return {
    db,
    asset,
    program,
    options,
    receipt,
    epoch,
    reads: () => reads,
    setOwner: (value) => (owner = value),
    setWrong: () => (wrong = true),
  };
}
test("sealed discovery survives reader restart and rereads current Core ownership", async () => {
  const f = fixture();
  try {
    const index = createSealedPackIndex(f.options);
    expect((await index.read()).packs).toHaveLength(0);
    await index.notify([f.asset.toBase58()]);
    expect((await index.read()).packs).toHaveLength(1);
    const newOwner = key().toBase58();
    f.setOwner(newOwner);
    const restarted = createSealedPackIndex(f.options),
      page = await restarted.read();
    expect(page.packs[0].owner).toBe(newOwner);
    expect(page.totalPriceLamports).toBe(105000000);
    expect(page.pagination.nextBefore).toBeNull();
  } finally {
    f.db.close();
  }
});
test("unverified notifications cannot enter the index and request sizes are bounded", async () => {
  const f = fixture();
  try {
    const index = createSealedPackIndex(f.options);
    await expect(
      index.notify(Array(25).fill(f.asset.toBase58())),
    ).rejects.toThrow(/1–24/);
    f.receipt[48] ^= 1;
    await expect(index.notify([f.asset.toBase58()])).rejects.toThrow(
      /identity/,
    );
    expect(f.db.query("SELECT COUNT(*) n FROM sealed_pack_index").get().n).toBe(
      0,
    );
    await expect(index.read({ before: 0 })).rejects.toThrow(/cursor/);
  } finally {
    f.db.close();
  }
});
test("wrong program account owner rejects before discovery is accepted", async () => {
  const f = fixture();
  try {
    f.setWrong();
    await expect(
      createSealedPackIndex(f.options).notify([f.asset.toBase58()]),
    ).rejects.toThrow(/unavailable/);
  } finally {
    f.db.close();
  }
});

test("redeemed packs expose proof actions only after confirmed complete claims", async () => {
  const f = fixture();
  try {
    const index = createSealedPackIndex(f.options);
    f.receipt[13] = 1;
    await index.notify([f.asset.toBase58()]);
    expect((await index.read()).packs[0].status).toBe("preparing");
    f.epoch[256 + 44] = 15;
    expect((await index.read()).packs[0].status).toBe("ready");
    f.epoch[256 + 45] = 1;
    expect((await index.read()).packs[0].status).toBe("refunded");
  } finally {
    f.db.close();
  }
});
