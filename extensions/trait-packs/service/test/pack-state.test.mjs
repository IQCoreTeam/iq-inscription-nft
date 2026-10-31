import bs58 from "bs58";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PublicKey, Keypair } from "@solana/web3.js";
import { createPackPageStateReader } from "../pack-state.mjs";
import { addresses } from "../../client/protocol.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const program = Keypair.generate().publicKey,
    collection = Keypair.generate().publicKey,
    owner = Keypair.generate().publicKey,
    avatar = Keypair.generate().publicKey,
    k = addresses(program, collection);
  const meta = Buffer.from(
    JSON.stringify({
      name: "Blue hair",
      image: "https://gateway.iqlabs.dev/img/example",
      attributes: [
        { trait_type: "Initial supply", value: 4 },
        { trait_type: "Creator tier", value: "rare" },
      ],
    }),
  );
  const pool = Buffer.alloc(4352);
  pool.write("NUBSALE5");
  collection.toBuffer().copy(pool, 40);
  pool.writeBigUInt64LE(100000000n, 200);
  pool[208] = 1;
  pool[209] = 4;
  pool.writeBigUInt64LE(1n, 226);
  pool[250] = 1;
  const def = 384;
  pool[def] = 0;
  pool[def + 1] = 1;
  pool[def + 2] = 255;
  pool[def + 3] = 255;
  Buffer.from(hash(meta), "hex").copy(pool, def + 4);
  pool[def + 36] = 9;
  pool.write("Blue hair", def + 37);
  const uri = "https://gateway.iqlabs.dev/token-meta/example";
  pool[def + 69] = uri.length;
  pool.write(uri, def + 70);
  const epoch = Buffer.alloc(2048);
  epoch.write("NUBEPOC5");
  k.pool.toBuffer().copy(epoch, 8);
  epoch[48] = 6;
  epoch.writeUInt16LE(1, 65);
  owner.toBuffer().copy(epoch, 256);
  epoch.writeBigUInt64LE(105000000n, 288);
  epoch.fill(0, 296, 300);
  epoch[300] = 15;
  const assets = new Map(),
    records = [];
  for (let pull = 0; pull < 4; pull++) {
    const asset = Keypair.generate().publicKey,
      data = Buffer.alloc(140);
    data.write("NUBGEAR4");
    k.pool.toBuffer().copy(data, 8);
    k.epoch.toBuffer().copy(data, 40);
    data[74] = pull;
    asset.toBuffer().copy(data, 76);
    records.push({
      pubkey: k.issuance(asset),
      account: { owner: program, data },
    });
    assets.set(asset.toBase58(), {
      owner: owner.toBase58(),
      updateAuthority: { type: "Address", address: k.gearAuthority.toBase58() },
      name: "Blue hair",
      uri,
    });
  }
  const base = {
    owner: owner.toBase58(),
    updateAuthority: { type: "Collection", address: collection.toBase58() },
    name: "Base #1",
    uri: "https://gateway.iqlabs.dev/token-meta/base",
    attributes: { attributeList: [{ key: "index", value: "1" }] },
  };
  assets.set(avatar.toBase58(), base);
  const load = Buffer.alloc(312);
  load.write("NUBLOAD4");
  avatar.toBuffer().copy(load, 14);
  k.pool.toBuffer().copy(load, 46);
  load.fill(255, 110, 116);
  load.writeUInt32LE(2, 308);
  const name = Buffer.from(base.name),
    uriBytes = Buffer.from(base.uri),
    n = Buffer.alloc(4),
    u = Buffer.alloc(4);
  n.writeUInt32LE(name.length);
  u.writeUInt32LE(uriBytes.length);
  Buffer.from(hash(Buffer.concat([n, name, u, uriBytes])), "hex").copy(
    load,
    78,
  );
  const stats = { pool: 0, epochs: 0, issuances: 0, core: 0, metadata: 0 };
  const connection = {
    getGenesisHash: async () => "pinned",
    getAccountInfoAndContext: async (address) => {
      if (address.equals(k.pool)) {
        stats.pool++;
        return { context: { slot: 10 }, value: { owner: program, data: pool } };
      }
      assert(address.equals(k.loadout(avatar)));
      return { context: { slot: 13 }, value: { owner: program, data: load } };
    },
    getMultipleAccountsInfoAndContext: async (keys, options) => {
      stats.epochs++;
      assert(options.minContextSlot >= 10);
      return {
        context: { slot: 11 },
        value: keys.map(() => ({ owner: program, data: epoch })),
      };
    },
    getProgramAccounts: async (_, options) => {
      stats.issuances++;
      if(options.filters.at(-1).memcmp.offset===108) {
        assert.equal(options.filters.at(-1).memcmp.bytes,avatar.toBase58());
        return {context:{slot:12},value:records.filter(row=>new PublicKey(row.account.data.subarray(108,140)).equals(avatar))};
      }
      assert.deepEqual(options.filters, [
        { dataSize: 140 },
        { memcmp: { offset: 8, bytes: k.pool.toBase58() } },
        { memcmp: { offset: 40, bytes: k.epoch.toBase58() } },
      ]);
      assert(options.minContextSlot >= 11);
      return { context: { slot: 12 }, value: records };
    },
  };
  const config = {
    connection,
    program,
    collection,
    chain: "solana:localnet",
    expectedGenesis: "pinned",
    collectionSlug: "test",
    appearance: { title: "Pack", privateKey: "never serialize" },
    readCoreAssets: async (keys) => {
      stats.core++;
      return new Map(
        keys.map((key) => [key.toBase58(), assets.get(key.toBase58()) ?? null]),
      );
    },
    readMetadata: async () => {
      stats.metadata++;
      return meta;
    },
    getAvatar: async (id) =>
      id === owner.toBase58() ? avatar.toBase58() : null,
    outfitUrl: (id, revision) =>
      "https://gateway.iqlabs.dev/wardrobe/" + id + "?r=" + revision,
  };
  return {
    config,
    pool,
    epoch,
    records,
    assets,
    meta,
    stats,
    owner,
    avatar,
    load,
    k,
  };
}
test("public state uses confirmed identities, pool-filtered issuance and shared cache without actors", async () => {
  const f = fixture(),
    reader = createPackPageStateReader(f.config);
  const [first, second] = await Promise.all([
    reader.read(f.owner.toBase58()),
    reader.read(f.owner.toBase58()),
  ]);
  assert.equal(first.packs.length, 1);
  assert.equal(first.packs[0].status, "settled");
  assert.equal(first.packs[0].traitAddresses.length, 4);
  assert.equal(first.traits.length, 4);
  assert.equal(first.stock[0].initialSupply, 4);
  assert.equal(first.stock[0].creatorTier, "rare");
  assert.equal(first.avatar.outfitsEnabled, true);
  assert.equal(first.avatar.revision, 2);
  assert.equal("actors" in first, false);
  assert.equal("privateKey" in first.appearance, false);
  assert.equal(f.stats.pool, 1);
  assert.equal(f.stats.issuances, 1);
  assert.equal(f.stats.metadata, 1);
  first.traits[0].name = "bad";
  assert.equal(
    (await reader.read(f.owner.toBase58())).traits[0].name,
    "Blue hair",
  );
  reader.invalidate(f.owner.toBase58());
  await reader.read(f.owner.toBase58());
  assert.equal(f.stats.pool, 2);
  assert.equal(f.stats.metadata, 1);
  assert.equal(second.collectionAddress, f.config.collection.toBase58());
});
test("invalid cursors and oversized epoch responses fail without an unbounded scan", async () => {
  const f=fixture(),reader=createPackPageStateReader(f.config);
  for(const before of [-1,0,1.5,NaN,Number.MAX_SAFE_INTEGER])await assert.rejects(()=>reader.read(undefined,{before}),/cursor/);
  const g=fixture();g.records.push(...Array(129).fill(g.records[0]));
  await assert.rejects(()=>createPackPageStateReader(g.config).read(),/bounded epoch/);
  assert.equal(g.stats.core,0);
});
test("foreign issuance, missing settled rewards and unverified metadata fail closed", async () => {
  const f = fixture();
  f.records[0].account.data.fill(0, 8, 40);
  await assert.rejects(
    () => createPackPageStateReader(f.config).read(),
    /issuance identity/,
  );
  const g = fixture();
  g.records.pop();
  await assert.rejects(
    () => createPackPageStateReader(g.config).read(),
    /four confirmed/,
  );
  const h = fixture();
  h.config.readMetadata = async () => Buffer.from("{}");
  await assert.rejects(
    () => createPackPageStateReader(h.config).read(),
    /sealed catalog/,
  );
});
test("outfit identity changes are visible and wrong selected ownership is rejected", async () => {
  const f = fixture();
  f.assets.get(f.avatar.toBase58()).uri = "https://gateway.iqlabs.dev/other";
  const state = await createPackPageStateReader(f.config).read(
    f.owner.toBase58(),
  );
  assert.equal(state.avatar.hasLoadout, true);
  assert.equal(state.avatar.outfitsEnabled, false);
  assert.equal(state.avatar.outfitURL, null);
  const g = fixture();
  g.assets.get(g.avatar.toBase58()).owner = PublicKey.default.toBase58();
  await assert.rejects(
    () => createPackPageStateReader(g.config).read(g.owner.toBase58()),
    /not owned/,
  );
});

test("appearance only accepts bounded public strings, never nested project objects", () => {
  const f = fixture();
  f.config.appearance.title = { privateKey: "must not serialize" };
  assert.throws(
    () => createPackPageStateReader(f.config),
    /public pack appearance/,
  );
});

function followContextFloors(f) {
  const connection = f.config.connection;
  for (const name of [
    "getAccountInfoAndContext",
    "getMultipleAccountsInfoAndContext",
    "getProgramAccounts",
  ]) {
    const original = connection[name];
    connection[name] = async (...args) => {
      const result = await original(...args);
      result.context.slot = Math.max(
        result.context.slot,
        args[1]?.minContextSlot ?? 0,
      );
      return result;
    };
  }
}
function receipt(f, signature, slot = 50) {
  return {
    slot,
    meta: { err: null },
    transaction: {
      message: {
        accountKeys: [f.config.program, f.k.pool],
        instructions: [{ programIdIndex: 0, accounts: [1], data: "P" }],
      },
    },
  };
}
test("verified confirmed write invalidates the warm snapshot once and follows receipt context", async () => {
  const f = fixture();
  followContextFloors(f);
  let checked = 0;
  const signature = bs58.encode(Keypair.generate().secretKey);
  f.config.connection.getTransaction = async () => {
    checked++;
    return receipt(f, signature);
  };
  const reader = createPackPageStateReader(f.config),
    owner = f.owner.toBase58();
  await reader.read(owner);
  assert.equal(f.stats.pool, 1);
  f.load[110] = 0;
  const first = f.records[0];
  f.avatar.toBuffer().copy(first.account.data, 108);
  f.assets.get(
    new PublicKey(first.account.data.subarray(76, 108)).toBase58(),
  ).owner = f.k.gearAuthority.toBase58();
  assert.equal((await reader.read(owner)).avatar.definitions[0], 255);
  const [a, b] = await Promise.all([
    reader.read(owner, { afterSignature: signature }),
    reader.read(owner, { afterSignature: signature }),
  ]);
  assert.equal(a.avatar.definitions[0], 0);
  assert.equal(
    b.traits.filter((row) => row.avatar === f.avatar.toBase58()).length,
    1,
  );
  assert.equal(f.stats.pool, 2);
  assert.equal(checked, 1);
  await reader.read(owner, { afterSignature: signature });
  assert.equal(f.stats.pool, 2);
  assert.equal(checked, 1);
  assert.equal(f.stats.metadata, 1);
});
test("invalid, failed or unrelated signatures cannot flush a warm snapshot", async () => {
  const f = fixture();
  let checked = 0;
  f.config.connection.getTransaction = async (signature) => {
    checked++;
    const tx = receipt(f, signature);
    if (checked === 1) tx.meta.err = { InstructionError: [0, "Custom"] };
    else tx.transaction.message.accountKeys[1] = Keypair.generate().publicKey;
    return tx;
  };
  const reader = createPackPageStateReader(f.config);
  await reader.read();
  await assert.rejects(
    () => reader.read(undefined, { afterSignature: "not-a-signature" }),
    /signature/,
  );
  assert.equal(checked, 0);
  await assert.rejects(
    () =>
      reader.read(undefined, {
        afterSignature: bs58.encode(Keypair.generate().secretKey),
      }),
    /successfully confirmed/,
  );
  await assert.rejects(
    () =>
      reader.read(undefined, {
        afterSignature: bs58.encode(Keypair.generate().secretKey),
      }),
    /does not change/,
  );
  await reader.read();
  assert.equal(f.stats.pool, 1);
});
test("known IQ restore and v0 loaded-address pack changes are verified without arbitrary program mentions", async () => {
  const f = fixture();
  followContextFloors(f);
  f.config.nftProgram = Keypair.generate().publicKey;
  let version = 0;
  f.config.connection.getTransaction = async () => {
    if (version === 0)
      return {
        slot: 50,
        meta: { err: null },
        transaction: {
          message: {
            accountKeys: [f.config.nftProgram, f.config.collection],
            instructions: [
              {
                programIdIndex: 0,
                accounts: [1],
                data: bs58.encode(
                  createHash("sha256")
                    .update("global:restore_wardrobe_metadata")
                    .digest()
                    .subarray(0, 8),
                ),
              },
            ],
          },
        },
      };
    return {
      slot: 51,
      meta: {
        err: null,
        loadedAddresses: { writable: [f.k.pool], readonly: [] },
      },
      transaction: {
        message: {
          staticAccountKeys: [f.config.program],
          compiledInstructions: [
            {
              programIdIndex: 0,
              accountKeyIndexes: Uint8Array.from([1]),
              data: Uint8Array.from([22]),
            },
          ],
        },
      },
    };
  };
  const reader = createPackPageStateReader(f.config);
  await reader.read(undefined, {
    afterSignature: bs58.encode(Keypair.generate().secretKey),
  });
  version = 1;
  await reader.read(undefined, {
    afterSignature: bs58.encode(Keypair.generate().secretKey),
  });
  assert.equal(f.stats.pool, 2);
});
test("a RPC response older than its confirmed receipt floor is rejected, not shown as fresh", async () => {
  const f = fixture();
  f.config.connection.getTransaction = async () => receipt(f, "unused");
  await assert.rejects(
    () =>
      createPackPageStateReader(f.config).read(undefined, {
        afterSignature: bs58.encode(Keypair.generate().secretKey),
      }),
    /receipt slot/,
  );
});

test("trusted native history checks raise context without accepting an unverified HTTP cache-bust", async () => {
  const f = fixture();
  followContextFloors(f);
  let observed = 0;
  f.config.getAvatar = async (_owner, context) => {
    observed = context.minContextSlot;
    return null;
  };
  const reader = createPackPageStateReader(f.config);
  await reader.read(f.owner.toBase58(), { minContextSlot: 100 });
  assert.equal(observed, 100);
  await assert.rejects(
    () => reader.read(undefined, { minContextSlot: -1 }),
    /trusted pack read context/,
  );
});

test('history pages cover more than64 epochs and256 traits with bounded epoch filters; old equipped gear stays removable',async()=>{
 const f=fixture(),epochs=new Map(),records=new Map(),all=[];let scans=0,batches=0;
 const meta=JSON.parse(f.meta);meta.attributes.find(x=>x.trait_type==='Initial supply').value=300;
 const bytes=Buffer.from(JSON.stringify(meta));Buffer.from(hash(bytes),'hex').copy(f.pool,384+4);f.config.readMetadata=async()=>bytes;
 f.pool.writeBigUInt64LE(70n,226);f.pool.writeBigUInt64LE(69n,234);
 for(let id=0;id<71;id++) {
  const key=addresses(f.config.program,f.config.collection,id).epoch,e=Buffer.from(f.epoch);e.writeBigUInt64LE(BigInt(id),40);epochs.set(key.toBase58(),e);
  const rows=[];
  for(let pull=0;pull<4;pull++) {
   const asset=Keypair.generate().publicKey,data=Buffer.from(f.records[pull].account.data);key.toBuffer().copy(data,40);asset.toBuffer().copy(data,76);
   const row={pubkey:f.k.issuance(asset),account:{owner:f.config.program,data}};rows.push(row);all.push(row);
   f.assets.set(asset.toBase58(),{owner:f.owner.toBase58(),updateAuthority:{type:'Address',address:f.k.gearAuthority.toBase58()}});
  }
  records.set(key.toBase58(),rows);
 }
 const equipped=records.get(addresses(f.config.program,f.config.collection,0).epoch.toBase58())[0];f.avatar.toBuffer().copy(equipped.account.data,108);f.load[110]=0;
 f.assets.get(new PublicKey(equipped.account.data.subarray(76,108)).toBase58()).owner=f.k.gearAuthority.toBase58();
 f.config.connection.getMultipleAccountsInfoAndContext=async(keys,options)=>{batches++;assert(keys.length<=3);return {context:{slot:Math.max(11,options.minContextSlot)},value:keys.map(key=>({owner:f.config.program,data:epochs.get(key.toBase58())}))};};
 f.config.connection.getProgramAccounts=async(_,options)=>{
  scans++;assert.equal(options.filters.length,3);assert.equal(options.filters[1].memcmp.bytes,f.k.pool.toBase58());
  const filter=options.filters[2].memcmp;
  const value=filter.offset===108?all.filter(row=>new PublicKey(row.account.data.subarray(108,140)).toBase58()===filter.bytes):records.get(filter.bytes);
  assert([40,108].includes(filter.offset));assert(value.length<=128);
  return {context:{slot:Math.max(12,options.minContextSlot)},value};
 };
 const reader=createPackPageStateReader(f.config),seen=new Set();let before,first=true,pages=0;
 do {
  const snapshot=await reader.read(f.owner.toBase58(),{before});pages++;
  assert(snapshot.epochs.length<=2);assert(snapshot.packs.length<=64);assert(snapshot.traits.length<=262);
  assert(snapshot.traits.some(row=>row.avatar===f.avatar.toBase58()));
  for(const p of snapshot.packs){assert(!seen.has(p.id));seen.add(p.id);}
  const oldScans=scans,oldBatches=batches;await reader.read(f.owner.toBase58(),{before});assert.equal(scans,oldScans);assert.equal(batches,oldBatches);
  if(first){first=false;f.pool.writeBigUInt64LE(71n,226);f.pool.writeBigUInt64LE(70n,234);}
  before=snapshot.pagination.nextBefore;
 }while(before!==null);
 assert.equal(pages,35);assert.equal(seen.size,70);assert(seen.has(0)&&seen.has(69*32));assert(scans<=105);
 reader.invalidate();assert.equal((await reader.read()).epochs.at(-1).id,70);
});
test('explicit NFT selection bypasses default discovery but independently verifies owner and collection',async()=>{
 const f=fixture();let defaults=0;f.config.getAvatar=async()=>{defaults++;return null;};const reader=createPackPageStateReader(f.config),owner=f.owner.toBase58(),asset=f.avatar.toBase58();
 assert.equal((await reader.read(owner)).avatar.exists,false);
 assert.equal((await reader.read(owner,{asset})).avatar.address,asset);assert.equal(defaults,1);
 await assert.rejects(()=>reader.read(undefined,{asset}),/requires a holder/);
 await assert.rejects(()=>reader.read(owner,{asset:'invalid'}));
 reader.invalidate(owner);f.assets.get(asset).owner=Keypair.generate().publicKey.toBase58();await assert.rejects(()=>reader.read(owner,{asset}),/not owned/);
 const g=fixture();g.assets.get(g.avatar.toBase58()).updateAuthority.address=Keypair.generate().publicKey.toBase58();await assert.rejects(()=>createPackPageStateReader(g.config).read(g.owner.toBase58(),{asset:g.avatar.toBase58()}),/not owned/);
});
