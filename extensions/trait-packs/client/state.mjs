import { PublicKey, SystemProgram } from "@solana/web3.js";
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import { addresses, readPool, readLoadout, readEpoch, CLAIM_BUDGET_LAMPORTS, PROVIDER_RESERVE_LAMPORTS } from "./protocol.mjs";

// Bounded confirmed account reads, shared across inventory/outfit views.
// No background polling. Host invalidates after its own confirmed writes.
export function createWardrobeReader({ connection, program, collection }) {
  const keys = addresses(program, collection),
    cache = new Map();
  async function cachedRead(id, load) {
    const cached = cache.get(id);
    if (cached && (cached.pending || Date.now() - cached.at < 1000))
      return cached.work;
    const entry = { pending: true, at: 0 };
    entry.work = load();
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
  function verifiedPool(info) {
    if (!info || !info.owner.equals(program)) throw Error("Wrong wardrobe account owner");
    const pool = readPool(info.data);
    if (!pool.collection.equals(collection) || pool.definitionCount > 16 || pool.pulls !== 4)
      throw Error("Wrong wardrobe identity");
    return pool;
  }
  function read(avatar) {
    const key = new PublicKey(avatar);
    return cachedRead(key.toBase58(), async () => {
      const infos = await connection.getMultipleAccountsInfo(
        [keys.pool, keys.loadout(key)],
        "confirmed",
      );
      if (
        infos.length !== 2 ||
        infos.some((i) => !i || !i.owner.equals(program))
      )
        throw Error("Wrong wardrobe account owner");
      const pool = verifiedPool(infos[0]),
        loadout = readLoadout(infos[1].data);
      if (
        !loadout.avatar.equals(key) ||
        !loadout.pool.equals(keys.pool)
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
    });
  }
  function sale() {
    return cachedRead('sale', async () => {
      const first = await connection.getAccountInfoAndContext(keys.pool, 'confirmed');
      const pool = verifiedPool(first.value);
      if (!pool.sealed || pool.retired || pool.definitionCount < 1)
        throw Error('Pack catalog is not available');
      const epochKey = addresses(program, collection, pool.activeEpoch).epoch;
      const latest = await connection.getMultipleAccountsInfoAndContext([epochKey, keys.ops], {
        commitment:'confirmed', minContextSlot:first.context.slot,
      });
      const [epochInfo,opsInfo] = latest.value;
      if (!epochInfo || !epochInfo.owner.equals(program) || !opsInfo ||
          !opsInfo.owner.equals(SystemProgram.programId) || opsInfo.data.length ||
          !Number.isSafeInteger(opsInfo.lamports) || opsInfo.lamports<0)
        throw Error('Wrong pack sale account owner');
      const epoch = readEpoch(epochInfo.data);
      if (!epoch.pool.equals(keys.pool) || epoch.id !== pool.activeEpoch || epoch.ticketCount > 32)
        throw Error('Wrong pack sale identity');
      const stock = pool.definitions.reduce((sum,trait)=>sum+trait.remaining,0);
      const requiredOperations=(pool.outstandingTraits+4)*CLAIM_BUDGET_LAMPORTS+PROVIDER_RESERVE_LAMPORTS;
      if(!Number.isSafeInteger(requiredOperations))throw Error("Operations reserve exceeds the exact client amount range");
      return {
        pool, epoch, slot:latest.context.slot, operationsLamports:opsInfo.lamports,
        requiredOperationsLamports:requiredOperations,
        canPurchase:opsInfo.lamports>=requiredOperations && epoch.status===1 && epoch.ticketCount<32 &&
          latest.context.slot<epoch.closeSlot && stock>=(epoch.ticketCount+1)*4,
      };
    });
  }
  return {
    read,
    sale,
    invalidate(avatar) {
      if (avatar) cache.delete(new PublicKey(avatar).toBase58());
      cache.delete("sale");
    },
  };
}
