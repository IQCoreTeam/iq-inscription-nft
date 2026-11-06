// Optional native runtime over the incumbent NFT database/SDK readers. It is
// constructed only from an explicit, operator-reviewed deployment config.
import path from "node:path";
import { createHash } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { publicKey as umiKey } from "@metaplex-foundation/umi";
import * as core from "@metaplex-foundation/mpl-core";
import { reader as iqReader, getRpcUrl } from "@iqlabs-official/solana-sdk";
import nftIdl from "../../target/idl/iq_inscription_nft.json";
import bs58 from "bs58";
import { createPackCreator } from "./pack-creator.ts";
import { createPackJobStore, runPackJobs } from "./pack-jobs.ts";
import { createPackWindowApi } from "./pack-window.ts";
import { createWardrobeReader } from "../../extensions/trait-packs/client/state.mjs";
import {
  assertOraoRequestFunding,
  createPackOperatorMarket,
} from "../../extensions/trait-packs/operator/market.mjs";
import {
  createPackPageStateReader,
} from "../../extensions/trait-packs/service/pack-state.mjs";
import {createSealedPackIndex} from "../../extensions/trait-packs/service/sealed-state.mjs";
import { createOutfitView } from "../../extensions/trait-packs/service/outfit-view.mjs";
import { createPublishedKitRenderer } from "../../extensions/trait-packs/service/kit-cache.mjs";

const CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const CODE_IN = new PublicKey("9KLLchQVJpGkw4jPuUmnvqESdR7mtNCYr3qS4iQLabs");
const hash = (bytes: any) => createHash("sha256").update(bytes).digest("hex");

export async function createPackRuntime(options: {
  db: any;
  connection: any;
  iqProgram: any;
  program: string | PublicKey;
  operator: any;
  vrf: any;
  chain: "solana:localnet" | "solana:devnet" | "solana:mainnet";
  expectedGenesis: string;
  gateway: string;
  origin: string;
  stagingRoot: string;
  renderRoot: string;
  requestOrigins?: string[];
  providerTreasury: string;
  window: number;
  timeout: number;
  operationsReserveLamports: number;
  requestFundingLamports: number;
  maxWindowsPerDay: number;
  workerId?: string;
}) {
  if (
    !["solana:localnet", "solana:devnet", "solana:mainnet"].includes(
      options.chain,
    )
  )
    throw Error("Configure an explicit supported native pack chain");
  const { db, connection } = options,
    program = new PublicKey(options.program),
    nftProgram = new PublicKey(options.iqProgram.programId),
    gateway = new URL(options.gateway),
    origin = new URL(options.origin).origin;
  if (!nftProgram.equals(new PublicKey(nftIdl.address)))
    throw Error("Native NFT program differs from the incumbent backend IDL");
  const api = new URL(options.origin);
  if (
    api.origin !== options.origin ||
    api.username ||
    api.password ||
    !(
      api.protocol === "https:" ||
      (api.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(api.hostname))
    )
  )
    throw Error("Configure the exact native API origin");
  if (
    gateway.origin !== options.gateway ||
    gateway.username ||
    gateway.password ||
    !(
      gateway.protocol === "https:" ||
      (gateway.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(gateway.hostname))
    )
  )
    throw Error("Configure the exact cluster gateway origin");
  if ((await connection.getGenesisHash()) !== options.expectedGenesis)
    throw Error("Native packs RPC chain mismatch");
  const registryConnection = options.iqProgram.provider?.connection;
  if (
    !registryConnection ||
    (registryConnection !== connection &&
      (await registryConnection.getGenesisHash()) !== options.expectedGenesis)
  )
    throw Error("Native registry provider RPC chain mismatch");
  // The incumbent verifier owns the SDK's process-global reader configuration.
  // SDK 0.3.6 cannot accept a connection for linked/session reads. Check its
  // existing endpoint instead of silently retargeting ordinary NFT reads.
  const readerRpc = getRpcUrl(),
    readerConnection =
      readerRpc === connection.rpcEndpoint
        ? connection
        : readerRpc === registryConnection.rpcEndpoint
          ? registryConnection
          : new Connection(readerRpc, "confirmed");
  if (
    readerConnection !== connection &&
    readerConnection !== registryConnection &&
    (await readerConnection.getGenesisHash()) !== options.expectedGenesis
  )
    throw Error("Native SDK reader RPC chain mismatch");
  if (!options.operator?.publicKey || !options.vrf?.programId)
    throw Error("Configure a separate operator signer and provider SDK");
  if (
    !Number.isInteger(options.maxWindowsPerDay) ||
    options.maxWindowsPerDay < 1 ||
    options.maxWindowsPerDay > 32
  )
    throw Error("Configure a finite native pack-window budget");
  const executables = await connection.getMultipleAccountsInfo(
    [program, nftProgram],
    "confirmed",
  );
  if (executables.some((info: any) => !info?.executable))
    throw Error(
      "Native pack and NFT programs must be deployed executable accounts",
    );
  await assertOraoRequestFunding(
    connection,
    options.vrf,
    new PublicKey(options.providerTreasury),
    options.requestFundingLamports,
  );
  const umi = createUmi(connection.rpcEndpoint).use(core.mplCore());
  const artifacts = new Map<string, any>(),
    coreCache = new Map<string, any>();
  let artifactBytes = 0,
    coreFloor = 0,
    stopped = false;
  const markets = new Map(),
    sales = new Map(),
    pages = new Map(),
    sealed = new Map(),
    views = new Map(),
    windowMarkets = new Map(),
    registrations = new Map<string, Promise<any>>();
  const store = createPackJobStore(db),
    workerId = options.workerId ?? "iq-pack-runtime-" + process.pid;
  async function readArtifact(signature: string) {
    if (
      !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature) ||
      bs58.decode(signature).length !== 64
    )
      throw Error("Invalid native IQ artifact reference");
    if (artifacts.has(signature)) return artifacts.get(signature).work;
    if (artifacts.size >= 64) {
      const settled = [...artifacts].find(([, value]) => !value.pending);
      if (!settled) throw Error("Native artifact reads are busy");
      artifactBytes -= settled[1].size;
      artifacts.delete(settled[0]);
    }
    const entry: any = { pending: true, size: 0, work: null };
    entry.work = (async () => {
      if ((await connection.getGenesisHash()) !== options.expectedGenesis)
        throw Error("Native IQ artifact chain mismatch");
      let bytes: Buffer | null = null;
      try {
        const response = await fetch(
          new URL("/token-meta/" + signature, gateway),
          {
            credentials: "omit",
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          },
        );
        if (response.ok) {
          if (Number(response.headers.get("content-length")) > 32000000)
            throw Error("Native artifact exceeds read budget");
          const chunks = [],
            stream = response.body!.getReader();
          let total = 0;
          try {
            for (;;) {
              const { done, value } = await stream.read();
              if (done) break;
              total += value.length;
              if (total > 32000000)
                throw Error("Native artifact exceeds read budget");
              chunks.push(value);
            }
          } finally {
            await stream.cancel();
          }
          bytes = Buffer.concat(chunks);
        }
      } catch {
        /* A cold/unreachable gateway may recover through the existing SDK. */
      }
      if (!bytes) {
        if (getRpcUrl() !== readerRpc)
          throw Error("Native SDK reader configuration changed after startup");
        const tx = await connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 1,
        });
        if (!tx || tx.meta?.err)
          throw Error("Native IQ artifact is not successfully confirmed");
        const message = tx.transaction.message,
          keys = message.staticAccountKeys ?? message.accountKeys;
        if (!keys.some((key: any) => key.equals(CODE_IN)))
          throw Error("Native artifact is not an IQ inscription");
        const decoded = await iqReader.readUserInventoryCodeInFromTx(tx);
        if (decoded.data === null || decoded.data === undefined)
          throw Error("Native IQ artifact has no code-in body");
        bytes = Buffer.from(decoded.data);
      }
      if (bytes.length > 32000000)
        throw Error("Native artifact exceeds read budget");
      entry.pending = false;
      entry.size = bytes.length;
      artifactBytes += entry.size;
      for (const [key, value] of artifacts) {
        if (artifactBytes <= 16000000) break;
        if (!value.pending) {
          artifactBytes -= value.size;
          artifacts.delete(key);
        }
      }
      return bytes;
    })();
    artifacts.set(signature, entry);
    try {
      return await entry.work;
    } catch (error) {
      if (artifacts.get(signature) === entry) {
        artifactBytes -= entry.size;
        artifacts.delete(signature);
      }
      throw error;
    }
  }
  async function readCoreAssets(
    input: any[],
    { minContextSlot = 0 }: { minContextSlot?: number } = {},
  ) {
    const floor = Math.max(coreFloor, minContextSlot),
      ids = [...new Set(input.map((value) => new PublicKey(value).toBase58()))],
      work = new Map<string, Promise<any>>(),
      missing = [];
    if (ids.length > 256)
      throw Error("Native Core batch exceeds the page profile");
    for (const id of ids) {
      const entry = coreCache.get(id);
      if (
        entry &&
        entry.floor >= floor &&
        (entry.pending || Date.now() - entry.at < 1000)
      )
        work.set(id, entry.work);
      else missing.push(id);
    }
    if (missing.length) {
      const batch = umi.rpc.getAccounts(missing.map(umiKey), {
        commitment: "confirmed",
        minContextSlot: floor,
      });
      for (const [index, id] of missing.entries()) {
        const entry: any = { pending: true, at: 0, floor, work: null };
        entry.work = batch
          .then((raw) => {
            const value = raw[index];
            if (!value.exists) return null;
            if (value.owner !== CORE.toBase58())
              throw Error("Native Core account owner changed");
            if (value.data.length === 1 && value.data[0] === 0) return null;
            if (value.data.length <= 1 || value.data[0] !== 1)
              throw Error("Native Core asset state is invalid");
            return core.deserializeAssetV1(value);
          })
          .then((value) => {
            entry.pending = false;
            entry.at = Date.now();
            return value;
          })
          .catch((error) => {
            if (coreCache.get(id) === entry) coreCache.delete(id);
            throw error;
          });
        coreCache.set(id, entry);
        work.set(id, entry.work);
      }
      while (coreCache.size > 512) {
        const settled = [...coreCache].find(([, entry]) => !entry.pending);
        if (!settled) break;
        coreCache.delete(settled[0]);
      }
    }
    return new Map(
      await Promise.all(ids.map(async (id) => [id, await work.get(id)])),
    );
  }
  async function readCollection(collection: string) {
    collection = new PublicKey(collection).toBase58();
    const row = db
      .query("SELECT * FROM collection WHERE core_collection=?1")
      .get(collection);
    if (!row) return null;
    const registry = PublicKey.findProgramAddressSync(
      [Buffer.from("registry"), new PublicKey(collection).toBuffer()],
      nftProgram,
    )[0];
    if (row.registry !== registry.toBase58())
      throw Error("Native collection registry mirror changed");
    const [registered, actual] = await Promise.all([
      options.iqProgram.account.registry.fetch(registry, "confirmed"),
      core.fetchCollection(umi, umiKey(collection), {
        commitment: "confirmed",
      }),
    ]);
    const authority = PublicKey.findProgramAddressSync(
      [Buffer.from("collection-auth"), registry.toBuffer()],
      nftProgram,
    )[0];
    if (
      actual.updateAuthority !== authority.toBase58() ||
      registered.collection.toBase58() !== collection
    )
      throw Error("Native collection is not controlled by the IQ registry");
    const manifestSignature = bs58.encode(Buffer.from(registered.manifestSig)),
      manifestHash = Buffer.from(registered.manifestHash).toString("hex");
    if (
      row.manifest_sig !== manifestSignature ||
      row.manifest_hash !== manifestHash
    )
      throw Error("Native collection manifest mirror changed");
    const raw = await readArtifact(manifestSignature);
    if (hash(raw) !== manifestHash || raw.length > 8000000)
      throw Error("Native collection manifest hash changed");
    const manifest = JSON.parse(raw.toString("utf8"));
    if (
      manifest.std !== "iqnft-0.1" ||
      manifest.slug !== row.slug ||
      !Array.isArray(manifest.items) ||
      manifest.items.length !== registered.maxSupply
    )
      throw Error("Native collection manifest identity changed");
    return {
      collection,
      registry: registry.toBase58(),
      admin: registered.admin.toBase58(),
      treasury: registered.treasury.toBase58(),
      itemCount: registered.maxSupply,
      items: manifest.items.map((item: any) => ({
        index: item.index,
        name: item.name,
        imageSha256: item.image_sha256,
      })),
      slug: row.slug,
      name: row.name,
    };
  }
  async function readAsset(address: string) {
    const id = new PublicKey(address).toBase58(),
      asset = (
        await readCoreAssets([new PublicKey(id)], { minContextSlot: coreFloor })
      ).get(id);
    if (!asset) return null;
    if (asset.updateAuthority.type !== "Collection") return null;
    const collection = asset.updateAuthority.address,
      row = db
        .query("SELECT * FROM collection WHERE core_collection=?1")
        .get(collection);
    if (!row) return null;
    const attributes = Object.fromEntries(
        (asset.attributes?.attributeList ?? []).map((value: any) => [
          value.key,
          value.value,
        ]),
      ),
      index = Number(attributes.index);
    if (
      !Number.isInteger(index) ||
      index < 1 ||
      !/^[0-9a-fA-F]{128}$/.test(attributes.inscription ?? "")
    )
      throw Error("Native NFT registration attributes are invalid");
    const verified = await readCollection(collection),
      item = verified?.items.find((item: any) => item.index === index);
    if (!item || item.name !== asset.name)
      throw Error("Native NFT does not match its registered manifest");
    return {
      ...asset,
      collection,
      index,
      imageSha256: item.imageSha256,
      inscription: bs58.encode(Buffer.from(attributes.inscription, "hex")),
    };
  }
  async function avatarFor(collection: string, owner: string, floor = 0) {
    const rows = db
      .query(
        "SELECT slot.asset FROM slot JOIN collection ON slot.slug=collection.slug WHERE collection.core_collection=?1 AND slot.owner=?2 ORDER BY slot.registered_at DESC LIMIT 64",
      )
      .all(collection, owner);
    let ids = rows.map((row: any) => row.asset),
      assets = await readCoreAssets(
        ids.map((id: string) => new PublicKey(id)),
        { minContextSlot: floor },
      );
    for (const id of ids) {
      const asset = assets.get(id);
      if (
        asset?.owner === owner &&
        asset.updateAuthority?.type === "Collection" &&
        asset.updateAuthority.address === collection
      )
        return id;
    }
    // Fresh mints need not wait for the periodic slot reconciler. This is a
    // collection+owner-filtered Core key query, never an org/wallet-wide scan.
    const found = await core
      .getAssetV1GpaBuilder(umi)
      .whereField("key", core.Key.AssetV1)
      .whereField("owner", umiKey(owner))
      .whereField(
        "updateAuthority",
        core.updateAuthority("Collection", [umiKey(collection)]),
      )
      .getPublicKeys({ commitment: "confirmed", minContextSlot: floor });
    if (found.length > 256)
      throw Error("Native owner selection needs an indexed collection reader");
    ids = found.slice(0, 64).map(String);
    assets = await readCoreAssets(
      ids.map((id: string) => new PublicKey(id)),
      { minContextSlot: floor },
    );
    for (const id of ids) {
      const asset = assets.get(id);
      if (
        asset?.owner === owner &&
        asset.updateAuthority?.type === "Collection" &&
        asset.updateAuthority.address === collection
      )
        return id;
    }
    return null;
  }
  let creator: any, windowApi: any;
  const materializer = createPublishedKitRenderer({
    cacheRoot: path.resolve(options.renderRoot),
    readVerifiedPublishedKit: (collection: string) =>
      creator.readVerifiedPublishedKit(collection),
    readArtifact,
  });
  async function register(collection: string) {
    if (stopped) throw Error("Native pack runtime is stopped");
    if (pages.has(collection)) return;
    if (registrations.has(collection)) return registrations.get(collection);
    if (pages.size + registrations.size >= 32)
      throw Error("Native runtime collection profile is full");
    const work = (async () => {
      const verified = await creator.readVerifiedPublishedKit(collection);
      await materializer.forCollection(collection);
      const col = new PublicKey(collection),
        wardrobe = createWardrobeReader({
          connection,
          program,
          collection: col,
        });
      const view = createOutfitView({
        origin,
        program: program.toBase58(),
        collection,
        readAsset,
        wardrobe,
        readBaseMetadata: readArtifact,
        render: async ({ address, asset, loadout }: any) => {
          const index = Number(
            asset.attributes?.attributeList.find(
              (value: any) => value.key === "index",
            )?.value,
          );
          const cached = await materializer.forCollection(collection);
          return (
            await cached.renderer.image({
              address,
              name: asset.name,
              revision: loadout.revision,
              bodyClass: loadout.bodyClass,
              sourceEditionId: index,
              definitions: loadout.definitionIds,
              originalBasePreserved: true,
            })
          ).image;
        },
      });
      const row = db
        .query("SELECT slug,name FROM collection WHERE core_collection=?1")
        .get(collection);
      const page = createPackPageStateReader({
        connection,
        program,
        collection: col,
        nftProgram,
        chain: options.chain,
        expectedGenesis: options.expectedGenesis,
        appearance: {
          ...verified.published.appearance,
          collectionName: row.name,
        },
        collectionSlug: row.slug,
        readCoreAssets,
        readMetadata: async (uri: string) => {
          const parsed = new URL(uri);
          if (
            parsed.origin !== gateway.origin ||
            parsed.search ||
            parsed.hash ||
            !parsed.pathname.startsWith("/token-meta/")
          )
            throw Error("Native trait metadata gateway changed");
          return readArtifact(parsed.pathname.slice("/token-meta/".length));
        },
        getAvatar: (owner: string, context: any) =>
          avatarFor(collection, owner, context?.minContextSlot ?? coreFloor),
        outfitUrl: (asset: string, revision: number, loadoutHash: string) =>
          origin +
          "/wardrobe/image/" +
          asset +
          "?r=" +
          revision +
          "&h=" +
          loadoutHash,
        onConfirmedWrite: ({ slot, accounts }: any) => {
          coreFloor = Math.max(coreFloor, slot);
          for (const id of accounts) {
            coreCache.delete(id);
            wardrobe.invalidate(id);
          }
        },
      });
      const market = createPackOperatorMarket({
        connection,
        program,
        collection: col,
        signer: options.operator,
        expectedGenesis: options.expectedGenesis,
        vrf: options.vrf,
        requestFundingLamports: options.requestFundingLamports,
      });
      const sale = { readSale: wardrobe.sale };
      markets.set(collection, market);
      sales.set(collection, sale);
      pages.set(collection, page);
      sealed.set(collection,createSealedPackIndex({db,connection,program,collection:col,expectedGenesis:options.expectedGenesis,chain:options.chain,readCoreAssets}));
      views.set(collection, view);
      windowMarkets.set(collection, {
        market,
        program: program.toBase58(),
        chain: options.chain,
        maxWindowsPerDay: options.maxWindowsPerDay,
      });
    })();
    registrations.set(collection, work);
    try {
      await work;
    } finally {
      if (registrations.get(collection) === work)
        registrations.delete(collection);
    }
  }
  creator = createPackCreator({
    db,
    auth:{origin,requestOrigins:options.requestOrigins??[origin],chain:options.chain},
    stagingRoot: options.stagingRoot,
    connection,
    expectedGenesis: options.expectedGenesis,
    gateway: gateway.origin,
    program: program.toBase58(),
    nftProgram: nftProgram.toBase58(),
    provider: options.vrf.programId.toBase58(),
    providerTreasury: options.providerTreasury,
    window: options.window,
    timeout: options.timeout,
    operationsReserveLamports: options.operationsReserveLamports,
    readCollection,
    readAsset,
    outfitBase: origin,
    readArtifact,
    onFinalized: register,
  });
  let syncing: Promise<any> | null = null;
  async function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      const rows = creator.listFinalized();
      if (rows.length > 32)
        throw Error(
          "Native finalized-collection profile exceeds its configured process bound",
        );
      const results = [];
      for (const collection of rows) {
        try {
          await register(collection);
          results.push({ collection, state: "registered" });
        } catch {
          results.push({ collection, state: "unavailable" });
        }
      }
      return results;
    })();
    try {
      return await syncing;
    } finally {
      syncing = null;
    }
  }
  const run = async () => {
    if (stopped) return [];
    await sync();
    windowApi.refreshDemands();
    return runPackJobs({ store, markets, workerId });
  };
  windowApi = createPackWindowApi({
    db,
    origin,
    markets: windowMarkets,
    requestOrigins: options.requestOrigins ?? [origin],
    runJobs: run,
  });
  await sync();
  return {
    creator,
    markets,
    sales,
    pages,
    sealed,
    views,
    windowApi,
    sync,
    runJobs: run,
    readArtifact,
    async viewForAsset(address: string) {
      if (!views.size) return null;
      const key = new PublicKey(address),
        asset = (
          await readCoreAssets([key], { minContextSlot: coreFloor })
        ).get(key.toBase58());
      return asset?.updateAuthority?.type === "Collection"
        ? (views.get(asset.updateAuthority.address) ?? null)
        : null;
    },
    async stop() {
      stopped = true;
      await materializer.stop();
      markets.clear();
      sales.clear();
      pages.clear();
      sealed.clear();
      views.clear();
      windowMarkets.clear();
      coreCache.clear();
      artifacts.clear();
    },
  };
}
