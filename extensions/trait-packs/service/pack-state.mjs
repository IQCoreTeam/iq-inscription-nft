import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import { Buffer } from "buffer";
import bs58 from "bs58";
import {
  addresses,
  readPool,
  readEpoch,
  readGear,
  readLoadout,
} from "../client/protocol.mjs";

export const PACK_PAGE_LIMITS = Object.freeze({
  epochs: 2,
  packs: 64,
  traits: 256,
  definitions: 16,
});

const hash = (bytes) => Buffer.from(sha256(bytes)).toString("hex");
const none = PublicKey.default.toBase58();
const slotLabels = [
  "Hair",
  "Clothing",
  "Headwear",
  "Accessory",
  "Background",
  "Border",
];

// Read-only host adapter. Core and immutable metadata readers are the existing
// batched SDK/gateway paths, not generated fixtures or arbitrary URL fetching.
// readCoreAssets returns a Map(address -> decoded Core asset | null). The host
// validates raw Core ownership/state; null means a verified burnt/absent account.
export function createPackPageStateReader({
  connection,
  program,
  collection,
  chain,
  expectedGenesis,
  nftProgram,
  appearance,
  collectionSlug,
  readCoreAssets,
  readMetadata,
  getAvatar,
  outfitUrl,
  onConfirmedWrite,
}) {
  program = new PublicKey(program);
  collection = new PublicKey(collection);
  nftProgram = nftProgram ? new PublicKey(nftProgram) : null;
  if (!["solana:localnet", "solana:devnet", "solana:mainnet"].includes(chain))
    throw Error("Unsupported pack state network");
  if (
    collectionSlug !== undefined &&
    (typeof collectionSlug !== "string" ||
      !/^[-a-z0-9]{3,32}$/.test(collectionSlug))
  )
    throw Error("Invalid public collection handle");
  const { title, subtitle, accent, cover, logo, collectionName } =
    appearance ?? {};
  const publicAppearance = {
    title,
    subtitle,
    accent,
    cover,
    logo,
    collectionName,
  };
  for (const [field, bound] of [
    ["title", 40],
    ["subtitle", 80],
    ["accent", 7],
    ["cover", 2048],
    ["logo", 2048],
    ["collectionName", 80],
  ]) {
    const value = publicAppearance[field];
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "string" ||
        [...value].length > bound ||
        /[\x00-\x1f]/.test(value))
    )
      throw Error("Invalid public pack appearance");
  }
  const keys = addresses(program, collection),
    immutable = new Map(),
    avatars = new Map(),
    receipts = new Map();
  const nftChanges = [
    "opt_in_wardrobe_metadata",
    "restore_wardrobe_metadata",
  ].map((name) =>
    Buffer.from(sha256(new TextEncoder().encode("global:" + name))).subarray(
      0,
      8,
    ),
  );
  const pages = new Map();
  let
    confirmedFloor = 0;
  async function network() {
    if ((await connection.getGenesisHash()) !== expectedGenesis)
      throw Error("Pack state RPC chain mismatch");
  }
  async function after(signature) {
    if (
      typeof signature !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature) ||
      bs58.decode(signature).length !== 64
    )
      throw Error("Invalid confirmed pack signature");
    if (receipts.has(signature)) return receipts.get(signature).work;
    if (receipts.size >= 128) {
      const settled = [...receipts].find(([, value]) => !value.pending);
      if (!settled) throw Error("Pack receipt checks are busy");
      receipts.delete(settled[0]);
    }
    const entry = { pending: true, work: null };
    entry.work = (async () => {
      await network();
      const tx = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (
        !tx ||
        !tx.meta ||
        tx.meta.err !== null ||
        !Number.isSafeInteger(tx.slot) ||
        tx.slot < 0
      )
        throw Error("Pack signature is not successfully confirmed");
      const message = tx.transaction.message;
      const accountKeys = message.accountKeys ?? [
        ...message.staticAccountKeys,
        ...(tx.meta.loadedAddresses?.writable ?? []),
        ...(tx.meta.loadedAddresses?.readonly ?? []),
      ];
      const key = (index) => accountKeys[index]?.toBase58();
      const relevant = (
        message.compiledInstructions ?? message.instructions
      ).some((instruction) => {
        const invoked = key(instruction.programIdIndex),
          accounts = [
            ...(instruction.accountKeyIndexes ?? instruction.accounts),
          ].map(key);
        if (
          invoked === program.toBase58() &&
          accounts.includes(keys.pool.toBase58())
        )
          return true;
        if (
          nftProgram &&
          invoked === nftProgram.toBase58() &&
          accounts.includes(collection.toBase58())
        ) {
          const data =
            typeof instruction.data === "string"
              ? Buffer.from(bs58.decode(instruction.data))
              : Buffer.from(instruction.data);
          return nftChanges.some((discriminator) =>
            data.subarray(0, 8).equals(discriminator),
          );
        }
        return false;
      });
      if (!relevant)
        throw Error("Confirmed signature does not change this pack collection");
      confirmedFloor = Math.max(confirmedFloor, tx.slot);
      pages.clear();
      avatars.clear();
      await onConfirmedWrite?.({
        signature,
        slot: tx.slot,
        accounts: accountKeys.map((value) => value.toBase58()),
      });
      entry.pending = false;
      return tx.slot;
    })();
    receipts.set(signature, entry);
    try {
      return await entry.work;
    } catch (error) {
      if (receipts.get(signature) === entry) receipts.delete(signature);
      throw error;
    }
  }
  async function metadata(definition) {
    const key = definition.uri + ":" + definition.hash;
    if (immutable.has(key)) return immutable.get(key);
    const work = (async () => {
      const bytes = Buffer.from(await readMetadata(definition.uri));
      if (bytes.length > 65536 || hash(bytes) !== definition.hash)
        throw Error("Trait metadata does not match the sealed catalog");
      const value = JSON.parse(bytes.toString("utf8"));
      if (
        value.name !== definition.name ||
        typeof value.image !== "string" ||
        value.image.length > 2048 ||
        !Array.isArray(value.attributes) ||
        value.attributes.length > 256
      )
        throw Error("Invalid sealed trait metadata");
      const initialSupply = value.attributes.find(
        (row) => row.trait_type === "Initial supply",
      )?.value;
      const creatorTier = value.attributes.find(
        (row) => row.trait_type === "Creator tier",
      )?.value;
      if (
        !Number.isSafeInteger(initialSupply) ||
        initialSupply < 0 ||
        initialSupply < definition.remaining
      )
        throw Error("Invalid sealed initial trait supply");
      return {
        image: value.image,
        initialSupply,
        creatorTier: ["common", "rare", "epic", "legendary"].includes(
          creatorTier,
        )
          ? creatorTier
          : null,
      };
    })();
    immutable.set(key, work);
    if (immutable.size > 32) immutable.delete(immutable.keys().next().value);
    try {
      return await work;
    } catch (error) {
      if (immutable.get(key) === work) immutable.delete(key);
      throw error;
    }
  }
  function verifiedGear(records, pool, epochsByAddress) {
      const gear = records.map(({ pubkey, account }) => {
        if (!account.owner.equals(program))
          throw Error("Wrong trait issuance owner");
        const value = readGear(account.data),
          epoch = epochsByAddress.get(value.epoch.toBase58());
        if (
          !value.pool.equals(keys.pool) ||
          !keys.issuance(value.asset).equals(pubkey) ||
          !pool.definitions[value.definition] ||
          !epoch ||
          value.ticket >= epoch.ticketCount ||
          value.pull > 3 ||
          epoch.tickets[value.ticket].definitions[value.pull] !==
            value.definition ||
          !(epoch.tickets[value.ticket].claimMask & (1 << value.pull))
        )
          throw Error("Wrong confirmed trait issuance identity");
        return {
          ...value,
          epochId: epoch.id,
          issuanceAddress: pubkey.toBase58(),
        };
      });
      if (new Set(gear.map((row) => row.asset.toBase58())).size !== gear.length)
        throw Error("Duplicate confirmed trait issuance");
      return gear;
  }
  function traitRows(gear, stock, core) {
      return gear.map((row) => {
        const asset = core.get(row.asset.toBase58()),
          definition = stock[row.definition],
          equipped = row.avatar.toBase58() !== none;
        if (
          asset &&
          (asset.updateAuthority?.type !== "Address" ||
            asset.updateAuthority.address !== keys.gearAuthority.toBase58() ||
            (equipped && asset.owner !== keys.gearAuthority.toBase58()))
        )
          throw Error("Issued trait Core authority mismatch");
        if (!asset && equipped)
          throw Error("An equipped trait is missing its confirmed Core asset");
        return {
          address: row.asset.toBase58(),
          definition: row.definition,
          slot: definition.slot,
          name: definition.name,
          image: definition.image,
          freeOwner: asset?.owner ?? null,
          avatar: equipped ? row.avatar.toBase58() : null,
          burned: !asset,
          epoch: row.epochId,
          ticket: row.ticket,
          pull: row.pull,
          issuanceAddress: row.issuanceAddress,
        };
      });
  }
  async function shared(before) {
    const cacheKey=before??"latest",cached=pages.get(cacheKey);
    if (
      cached &&
      cached.floor >= confirmedFloor &&
      (cached.pending || Date.now() - cached.at < 1000)
    )
      return cached.work;
    if(pages.size>=16&&!pages.has(cacheKey)) {
      const old=[...pages].find(([,entry])=>!entry.pending);
      if(!old)throw Error('Pack history reads are busy');pages.delete(old[0]);
    }
    const entry = { pending: true, at: 0, floor: confirmedFloor, work: null };
    entry.work = (async () => {
      await network();
      const initial = await connection.getAccountInfoAndContext(keys.pool, {
        commitment: "confirmed",
        minContextSlot: entry.floor,
      });
      if (
        !Number.isSafeInteger(initial.context?.slot) ||
        initial.context.slot < entry.floor
      )
        throw Error("Pack state RPC did not meet the confirmed receipt slot");
      if (!initial.value?.owner.equals(program))
        throw Error("Wrong pack pool owner");
      const pool = readPool(initial.value.data);
      if (
        !pool.collection.equals(collection) ||
        !pool.sealed ||
        pool.definitionCount < 1 ||
        pool.definitionCount > PACK_PAGE_LIMITS.definitions ||
        pool.pulls !== 4 ||
        pool.activeEpoch >= pool.epochCount
      )
        throw Error("Wrong pack pool identity");
      const end=before??pool.epochCount;
      if(!Number.isSafeInteger(end)||end<1||end>pool.epochCount)throw Error('Invalid pack history cursor');
      const start=Math.max(0,end-PACK_PAGE_LIMITS.epochs);
      const ids=Array.from({length:end-start},(_,i)=>start+i);
      const readIds=[...new Set([...ids,pool.activeEpoch])];
      const readKeys=readIds.map(id=>addresses(program,collection,id).epoch);
      const epochKeys=new Map(readIds.map((id,i)=>[id,readKeys[i]]));
      const epochRead = await connection.getMultipleAccountsInfoAndContext(
        readKeys,
        { commitment: "confirmed", minContextSlot: initial.context.slot },
      );
      if (
        !Number.isSafeInteger(epochRead.context?.slot) ||
        epochRead.context.slot < initial.context.slot
      )
        throw Error("Pack epoch RPC did not meet the confirmed context slot");
      const loadedEpochs = epochRead.value.map((info, index) => {
        const id=readIds[index];
        if (!info?.owner.equals(program)) throw Error("Wrong pack epoch owner");
        const epoch = readEpoch(info.data);
        if (
          !epoch.pool.equals(keys.pool) ||
          epoch.id !== id ||
          epoch.ticketCount > 32
        )
          throw Error("Wrong pack epoch identity");
        return epoch;
      });
      const epochs=loadedEpochs.filter(epoch=>ids.includes(epoch.id));
      // Filter each immutable epoch PDA as well as the pool: at most 128
      // issuance accounts per RPC, regardless of total collection history.
      const reads=await Promise.all(ids.map(id=>connection.getProgramAccounts(program,{
        commitment:'confirmed',withContext:true,minContextSlot:epochRead.context.slot,
        filters:[{dataSize:140},{memcmp:{offset:8,bytes:keys.pool.toBase58()}},{memcmp:{offset:40,bytes:epochKeys.get(id).toBase58()}}]
      })));
      if(reads.some((read,i)=>!Number.isSafeInteger(read.context?.slot)||read.context.slot<epochRead.context.slot||read.value.length>128||read.value.some(row=>!readGear(row.account.data).epoch.equals(epochKeys.get(ids[i])))))throw Error('Invalid bounded epoch issuance read');
      const issuanceRead={context:{slot:Math.max(...reads.map(read=>read.context.slot))},value:reads.flatMap(read=>read.value)};
      if (
        !Number.isSafeInteger(issuanceRead.context?.slot) ||
        issuanceRead.context.slot < epochRead.context.slot
      )
        throw Error(
          "Pack issuance RPC did not meet the confirmed context slot",
        );
      if (issuanceRead.value.length > PACK_PAGE_LIMITS.traits)
        throw Error(
          "Trait page exceeds its bounded read budget",
        );
      const epochsByAddress = new Map(
        loadedEpochs.map(epoch => [epochKeys.get(epoch.id).toBase58(), epoch]),
      );
      const gear = verifiedGear(issuanceRead.value, pool, epochsByAddress);
      const [core, details] = await Promise.all([
        readCoreAssets(
          gear.map((row) => row.asset),
          { minContextSlot: issuanceRead.context.slot },
        ),
        Promise.all(pool.definitions.map(metadata)),
      ]);
      const stock = pool.definitions.map((definition, id) => ({
        ...definition,
        ...details[id],
        id,
      }));
      const traits = traitRows(gear, stock, core);
      const packs = [];
      for (const epoch of epochs)
        for (const ticket of epoch.tickets) {
          const granted = traits
            .filter(
              (row) => row.epoch === epoch.id && row.ticket === ticket.serial,
            )
            .sort((a, b) => a.pull - b.pull);
          const settled = ticket.claimMask === 15;
          if (
            settled &&
            (granted.length !== 4 ||
              new Set(granted.map((row) => row.pull)).size !== 4)
          )
            throw Error(
              "Settled pack is missing its four confirmed trait accounts",
            );
          packs.push({
            id: epoch.id * 32 + ticket.serial,
            address: epochKeys.get(epoch.id).toBase58() + ":" + ticket.serial,
            owner: ticket.buyer.toBase58(),
            status: settled
              ? "settled"
              : [4, 6, 7].includes(epoch.status)
                ? "fulfilled"
                : epoch.status === 3
                  ? "requested"
                  : "sealed",
            epoch: epoch.id,
            sequence: ticket.serial,
            paidLamports: ticket.paid,
            refunded: ticket.refunded,
            void: epoch.status === 5,
            traitAddresses: settled ? granted.map((row) => row.address) : [],
            burnedRewards: settled
              ? granted.filter((row) => row.burned).length
              : 0,
          });
        }
      const pendingReserved = loadedEpochs.filter(epoch=>epoch.id===pool.activeEpoch)
        .filter((epoch) => [1, 2, 3, 7].includes(epoch.status))
        .reduce((sum, epoch) => sum + epoch.ticketCount * 4, 0);
      return {
        pagination:{before:before??null,nextBefore:start>0?start:null},
        pool,
        packs,
        traits,
        stock,
        epochs,
        slot: issuanceRead.context.slot,
        floor: entry.floor,
        availablePacks: pool.retired
          ? 0
          : Math.max(
              0,
              Math.floor(
                (stock.reduce((sum, row) => sum + row.remaining, 0) -
                  pendingReserved) /
                  4,
              ),
            ),
      };
    })();
    pages.set(cacheKey,entry);
    if(pages.size>16)for(const [key,value] of pages)if(!value.pending&&key!==cacheKey){pages.delete(key);break;}
    try {
      const value = await entry.work;
      entry.pending = false;
      entry.at = Date.now();
      return value;
    } catch (error) {
      if (pages.get(cacheKey) === entry) pages.delete(cacheKey);
      throw error;
    }
  }
  async function avatarFor(owner, slot, selected) {
    if (!owner) return null;
    const key = new PublicKey(owner).toBase58() + (selected ? ":" + selected : ""),
      existing = avatars.get(key);
    if (
      existing &&
      existing.floor >= slot &&
      (existing.pending || Date.now() - existing.at < 1000)
    )
      return existing.work;
    const entry = { pending: true, at: 0, floor: slot, work: null };
    entry.work = (async () => {
      const id = selected ?? await getAvatar(owner, { minContextSlot: slot });
      if (!id) return null;
      const address = new PublicKey(id),
        [core, loadInfo] = await Promise.all([
          readCoreAssets([address], { minContextSlot: slot }),
          connection.getAccountInfoAndContext(keys.loadout(address), {
            commitment: "confirmed",
            minContextSlot: slot,
          }),
        ]);
      if (
        !Number.isSafeInteger(loadInfo.context?.slot) ||
        loadInfo.context.slot < slot
      )
        throw Error("NFT loadout RPC did not meet the confirmed context slot");
      const asset = core.get(address.toBase58());
      if (
        !asset ||
        asset.owner !== owner ||
        asset.updateAuthority?.type !== "Collection" ||
        asset.updateAuthority.address !== collection.toBase58()
      )
        throw Error("Selected NFT is not owned in this collection");
      let load = null;
      if (loadInfo.value) {
        if (!loadInfo.value.owner.equals(program))
          throw Error("Wrong NFT loadout owner");
        load = readLoadout(loadInfo.value.data);
        if (!load.avatar.equals(address) || !load.pool.equals(keys.pool))
          throw Error("Wrong NFT loadout identity");
      }
      const name = Buffer.from(asset.name),
        uri = Buffer.from(asset.uri),
        n = Buffer.alloc(4),
        u = Buffer.alloc(4);
      n.writeUInt32LE(name.length);
      u.writeUInt32LE(uri.length);
      const preserved =
        !load || hash(Buffer.concat([n, name, u, uri])) === load.baseHash;
      const rawIndex = asset.attributes?.attributeList?.find(
        (row) => row.key === "index",
      )?.value;
      return {
        address: address.toBase58(),
        owner,
        name: asset.name,
        uri: asset.uri,
        exists: true,
        hasLoadout: !!load,
        outfitsEnabled: !!load && preserved,
        revision: load?.revision ?? 0,
        definitions: load?.definitionIds ?? Array(6).fill(255),
        sourceEditionId: /^[1-9][0-9]{0,4}$/.test(rawIndex ?? "")
          ? Number(rawIndex)
          : null,
        bodyClass: load?.bodyClass ?? null,
        baseURI: asset.uri,
        outfitURL:
          load && preserved
            ? outfitUrl(
                address.toBase58(),
                load.revision,
                hash(loadInfo.value.data),
              )
            : null,
        originalBasePreserved: preserved,
      };
    })();
    avatars.set(key, entry);
    if (avatars.size > 64) avatars.delete(avatars.keys().next().value);
    try {
      const value = await entry.work;
      entry.pending = false;
      entry.at = Date.now();
      return value;
    } catch (error) {
      if (avatars.get(key) === entry) avatars.delete(key);
      throw error;
    }
  }
  async function equippedTraits(avatar,state) {
    if(!avatar?.hasLoadout||avatar.definitions.every(id=>id===255))return [];
    const entry=avatars.get(avatar.owner+":"+avatar.address)??avatars.get(avatar.owner)??{};
    if(entry.equipped?.floor>=state.slot)return entry.equipped.work;
    const work=(async()=>{
        const read=await connection.getProgramAccounts(program,{commitment:'confirmed',withContext:true,minContextSlot:state.slot,filters:[{dataSize:140},{memcmp:{offset:8,bytes:keys.pool.toBase58()}},{memcmp:{offset:108,bytes:avatar.address}}]});
        if(!Number.isSafeInteger(read.context?.slot)||read.context.slot<state.slot||read.value.length>6)throw Error('Invalid equipped trait read');
        const missing=read.value;
        if(missing.length) {
          const ids=[...new Set(missing.map(row=>readGear(row.account.data).epoch.toBase58()))];
          const epochs=await connection.getMultipleAccountsInfoAndContext(ids.map(id=>new PublicKey(id)),{commitment:'confirmed',minContextSlot:read.context.slot});
          if(!Number.isSafeInteger(epochs.context?.slot)||epochs.context.slot<read.context.slot)throw Error('Invalid equipped epoch context');
          const verified=new Map(ids.map((id,i)=>{
            const info=epochs.value[i];if(!info?.owner.equals(program))throw Error('Wrong equipped epoch owner');
            const e=readEpoch(info.data);if(!e.pool.equals(keys.pool)||!addresses(program,collection,e.id).epoch.equals(new PublicKey(id))||e.ticketCount>32)throw Error('Wrong equipped epoch identity');
            return [id,e];
          }));
          const gear=verifiedGear(missing,state.pool,verified);
          if(gear.some(row=>row.avatar.toBase58()!==avatar.address))throw Error('Equipped trait changed NFT');
          if(gear.length!==avatar.definitions.filter(id=>id!==255).length||gear.some(row=>avatar.definitions[state.stock[row.definition].slot]!==row.definition))throw Error('Equipped loadout changed during read');
          return traitRows(gear,state.stock,await readCoreAssets(gear.map(row=>row.asset),{minContextSlot:epochs.context.slot}));
        }
        if(avatar.definitions.some(id=>id!==255))throw Error('Equipped issuance is missing');
        return [];
    })();
    const cached={floor:state.slot,work};entry.equipped=cached;
    try{return await work;}catch(error){if(entry.equipped===cached)delete entry.equipped;throw error;}
  }
  return {
    async read(owner, { afterSignature, minContextSlot = 0, before, asset } = {}) {
      if (!Number.isSafeInteger(minContextSlot) || minContextSlot < 0)
        throw Error("Invalid trusted pack read context");
      if(asset){if(!owner)throw Error("A selected NFT requires a holder");asset=new PublicKey(asset).toBase58();}
      confirmedFloor = Math.max(confirmedFloor, minContextSlot);
      if (afterSignature) await after(afterSignature);
      if(before!==undefined&&before!==null&&(!Number.isSafeInteger(before)||before<1))throw Error("Invalid pack history cursor");
      let state = await shared(before);
      if (state.floor < confirmedFloor) state = await shared(before);
      let avatar = await avatarFor(owner, state.slot, asset);
      if (state.floor < confirmedFloor) {
        state = await shared(before);
        avatar = await avatarFor(owner, state.slot, asset);
      }
      if (state.floor < confirmedFloor)
        throw Error(
          "Pack state changed while reading; retry with the latest confirmed receipt",
        );
      const equipped=await equippedTraits(avatar,state);
      return {
        chain,
        program: program.toBase58(),
        collectionAddress: collection.toBase58(),
        collectionSlug,
        appearance: publicAppearance,
        priceLamports: state.pool.price,
        platformFeeLamports: state.pool.platformFee,
        totalPriceLamports: state.pool.totalPrice,
        availablePacks: state.availablePacks,
        slotLabels,
        avatar: avatar ?? {
          address: null,
          owner: null,
          name: "No compatible NFT selected",
          uri: null,
          exists: false,
          hasLoadout: false,
          outfitsEnabled: false,
          revision: 0,
          definitions: Array(6).fill(255),
          sourceEditionId: null,
          bodyClass: null,
          baseURI: null,
          outfitURL: null,
          originalBasePreserved: true,
        },
        pagination:state.pagination,
        packs: structuredClone(state.packs),
        traits: structuredClone([...state.traits,...equipped.filter(row=>!state.traits.some(item=>item.address===row.address))]),
        stock: structuredClone(state.stock),
        epochs: state.epochs.map((epoch) => ({
          id: epoch.id,
          status: epoch.status,
          closeSlot: epoch.closeSlot,
          deadlineSlot: epoch.deadlineSlot,
          cursor: epoch.cursor,
          ticketCount: epoch.ticketCount,
          escrowLamports: epoch.escrow,
        })),
        nextSettlement: null,
        receipts: [],
      };
    },
    invalidate(owner) {
      pages.clear();
      if (owner) {const prefix=new PublicKey(owner).toBase58();for(const key of avatars.keys())if(key===prefix||key.startsWith(prefix+":"))avatars.delete(key);}
      else avatars.clear();
    },
  };
}
