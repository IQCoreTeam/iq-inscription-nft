import { PublicKey } from "@solana/web3.js";
import {
  sealedAddresses,
  readSealedRelease,
  readSealedPack,
} from "../client/sealed.mjs";
import { readPool } from "../client/protocol.mjs";

// Confirmed on-chain receipts are the authority. SQLite is only a bounded,
// restart-safe discovery index populated after writes, never an ownership ledger.
export function createSealedPackIndex({
  db,
  connection,
  program,
  collection,
  expectedGenesis,
  chain,
  readCoreAssets,
}) {
  program = new PublicKey(program);
  collection = new PublicKey(collection);
  const keys = sealedAddresses(program, collection);
  db.exec(
    `CREATE TABLE IF NOT EXISTS sealed_pack_index(program TEXT NOT NULL,pool TEXT NOT NULL,asset TEXT NOT NULL,serial INTEGER NOT NULL,PRIMARY KEY(program,pool,asset),UNIQUE(program,pool,serial));`,
  );
  let shared = null,
    at = 0;
  async function terms() {
    if (shared && (at === 0 || Date.now() - at < 1000)) return shared;
    at = 0;
    const work = (async () => {
      if ((await connection.getGenesisHash()) !== expectedGenesis)
        throw Error("Sealed-pack index chain mismatch");
      const r = await connection.getMultipleAccountsInfoAndContext(
        [keys.pool, keys.release],
        { commitment: "confirmed" },
      );
      if (
        !Number.isSafeInteger(r.context?.slot) ||
        r.value.length !== 2 ||
        r.value.some((info) => !info?.owner.equals(program))
      )
        throw Error("Sealed release is unavailable");
      const pool = readPool(r.value[0].data),
        release = readSealedRelease(r.value[1].data);
      if (
        !pool.collection.equals(collection) ||
        !pool.sealedPacks ||
        !pool.sealed ||
        !release.pool.equals(keys.pool)
      )
        throw Error("Wrong sealed release identity");
      return { pool, release, slot: r.context.slot };
    })();
    shared = work;
    try {
      const value = await work;
      if (shared === work) at = Date.now();
      return value;
    } catch (e) {
      if (shared === work) shared = null;
      throw e;
    }
  }
  async function receipts(assets, slot) {
    if (!Array.isArray(assets) || assets.length < 1 || assets.length > 24)
      throw Error("Read 1–24 sealed assets per page");
    const ids = [...new Set(assets.map((id) => new PublicKey(id).toBase58()))];
    const r = await connection.getMultipleAccountsInfoAndContext(
      ids.map((id) => sealedAddresses(program, collection, id).receipt),
      { commitment: "confirmed", minContextSlot: slot },
    );
    if (
      !Number.isSafeInteger(r.context?.slot) ||
      r.context.slot < slot ||
      r.value.length !== ids.length
    )
      throw Error("Stale sealed receipt page");
    return {
      slot: r.context.slot,
      rows: r.value.map((info, i) => {
        if (!info?.owner.equals(program))
          throw Error("Wrong sealed receipt owner");
        const receipt = readSealedPack(info.data);
        if (
          !receipt.release.equals(keys.release) ||
          receipt.asset.toBase58() !== ids[i]
        )
          throw Error("Wrong sealed receipt identity");
        return receipt;
      }),
    };
  }
  return {
    async notify(assets) {
      shared = null;
      const t = await terms(),
        r = await receipts(assets, t.slot);
      db.transaction(() => {
        for (const receipt of r.rows) {
          if (receipt.serial >= t.release.minted)
            throw Error("Sealed mint is not confirmed");
          db.query(
            "INSERT OR IGNORE INTO sealed_pack_index(program,pool,asset,serial) VALUES(?1,?2,?3,?4)",
          ).run(
            program.toBase58(),
            keys.pool.toBase58(),
            receipt.asset.toBase58(),
            receipt.serial,
          );
        }
      }).immediate();
      return { accepted: r.rows.length };
    },
    async read({ before } = {}) {
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
        throw Error("Invalid sealed page cursor");
      const t = await terms();
      const found = db
          .query(
            "SELECT asset,serial FROM sealed_pack_index WHERE program=?1 AND pool=?2 AND serial<?3 ORDER BY serial DESC LIMIT 25",
          )
          .all(
            program.toBase58(),
            keys.pool.toBase58(),
            before ?? Number.MAX_SAFE_INTEGER,
          ),
        page = found.slice(0, 24);
      const r = page.length
        ? await receipts(
            page.map((x) => x.asset),
            t.slot,
          )
        : { rows: [], slot: t.slot };
      const core = await readCoreAssets(
        r.rows.filter((x) => !x.opened).map((x) => x.asset),
        { minContextSlot: r.slot },
      );
      const packs = r.rows.map((receipt) => {
        const asset = core.get(receipt.asset.toBase58());
        if (
          !receipt.opened &&
          (!asset ||
            asset.updateAuthority?.type !== "Collection" ||
            asset.updateAuthority.address !==
              t.release.packCollection.toBase58())
        )
          throw Error("Sealed NFT does not match its release");
        return {
          asset: receipt.asset.toBase58(),
          serial: receipt.serial,
          opened: receipt.opened,
          owner: asset?.owner ?? null,
          opener: receipt.opener.toBase58(),
          epoch: Number(receipt.epoch),
          ticket: receipt.ticket,
          paidLamports: receipt.paid.toString(),
        };
      });
      return {
        chain,
        program: program.toBase58(),
        collectionAddress: collection.toBase58(),
        packCollection: t.release.packCollection.toBase58(),
        supply: t.release.supply,
        minted: t.release.minted,
        opened: t.release.opened,
        sealed: t.release.sealed,
        unminted: t.release.unminted,
        priceLamports: t.pool.price,
        totalPriceLamports: t.pool.totalPrice,
        platformFeeLamports: t.pool.platformFee,
        name: t.release.name,
        uri: t.release.uri,
        packs,
        pagination: {
          nextBefore: found.length > 24 ? page.at(-1).serial : null,
        },
        slot: r.slot,
      };
    },
  };
}
