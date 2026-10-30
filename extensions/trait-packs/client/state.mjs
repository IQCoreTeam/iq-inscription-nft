import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import { addresses, readPool, readLoadout } from "./protocol.mjs";

// Bounded confirmed account reads, shared across inventory/outfit views.
// No background polling. Host invalidates after its own confirmed writes.
export function createWardrobeReader({ connection, program, collection }) {
  const keys = addresses(program, collection),
    cache = new Map();
  async function read(avatar) {
    const key = new PublicKey(avatar),
      id = key.toBase58(),
      cached = cache.get(id);
    if (cached && (cached.pending || Date.now() - cached.at < 1000))
      return cached.work;
    const entry = { pending: true, at: 0 };
    entry.work = (async () => {
      const infos = await connection.getMultipleAccountsInfo(
        [keys.pool, keys.loadout(key)],
        "confirmed",
      );
      if (
        infos.length !== 2 ||
        infos.some((i) => !i || !i.owner.equals(program))
      )
        throw Error("Wrong wardrobe account owner");
      const pool = readPool(infos[0].data),
        loadout = readLoadout(infos[1].data);
      if (
        !pool.collection.equals(collection) ||
        !loadout.avatar.equals(key) ||
        !loadout.pool.equals(keys.pool) ||
        pool.definitionCount > 16 ||
        pool.pulls !== 4
      )
        throw Error("Wrong wardrobe identity");
      for (const [slot, id] of loadout.definitionIds.entries())
        if (
          id !== 255 &&
          (!pool.definitions[id] || pool.definitions[id].slot !== slot)
        )
          throw Error("Invalid equipped trait");
      return {
        pool,
        loadout,
        loadoutHash: Buffer.from(sha256(infos[1].data)).toString("hex"),
      };
    })();
    cache.set(id, entry);
    if (cache.size > 64) cache.delete(cache.keys().next().value);
    try {
      const state = await entry.work;
      entry.pending = false;
      entry.at = Date.now();
      return state;
    } catch (error) {
      if (cache.get(id) === entry) cache.delete(id);
      throw error;
    }
  }
  return {
    read,
    invalidate(avatar) {
      cache.delete(new PublicKey(avatar).toBase58());
    },
  };
}
