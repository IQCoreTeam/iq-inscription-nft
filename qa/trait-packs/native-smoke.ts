// Synthetic offline native application lifecycle. No supplied signers or art.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as core from "@metaplex-foundation/mpl-core";
import { generateSigner, publicKey, createSignerFromKeypair } from "@metaplex-foundation/umi";
import { toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import { writer, reader, setRpcUrl } from "@iqlabs-official/solana-sdk";
import bs58 from "bs58";
import {
  inputsFromEnvironment,
  startSyntheticFixture,
  snapshotSource,
  CORE_ID,
  ORAO_ID,
} from "./fixture.mjs";
import { fixture as kitFixture } from "../../extensions/trait-packs/creator/test/fixtures.mjs";
import { createPackRuntime } from "../../backend/src/pack-runtime.ts";
import { publishKitArtifacts } from "../../extensions/trait-packs/client/publish-kit.mjs";
import { publishPackSetup } from "../../extensions/trait-packs/client/creator.mjs";
import { createPackClient } from "../../extensions/trait-packs/client/market.mjs";
import { enableOutfits } from "../../extensions/trait-packs/client/outfits.mjs";
import { packWindowMessage } from "../../extensions/trait-packs/client/window-message.mjs";
import nacl from "tweetnacl";
import { guardedTrade, tradePayments } from "../../extensions/trait-packs/client/transactions.mjs";
import { createWardrobeReader } from "../../extensions/trait-packs/client/state.mjs";
const sha = (value: any) => createHash("sha256").update(value).digest("hex");
const inputs = await inputsFromEnvironment(),
  codePath = process.env.IQ_QA_CODE_IN_BINARY,
  codeHash = process.env.IQ_QA_CODE_IN_SHA256;
assert(
  codePath && /^[a-f0-9]{64}$/.test(codeHash ?? ""),
  "Set explicit reviewed IQ_QA_CODE_IN_BINARY and IQ_QA_CODE_IN_SHA256",
);
assert((await stat(codePath)).size < 16000000);
const codeBytes = await readFile(codePath);
assert(codeBytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])));
assert.equal(sha(codeBytes), codeHash);
const f = await startSyntheticFixture(inputs),
  kit = await kitFixture(),
  out = new URL("./.evidence/native-" + Date.now() + "/", import.meta.url);
await mkdir(out, { recursive: true });
const db = new Database(new URL("native.sqlite", out).pathname),
  report: any = {
    passed: false,
    scope: "synthetic offline native application lifecycle; no public writes",
    codeInSha256: codeHash,
    inputs: Object.fromEntries(
      Object.entries(inputs).map(([name, input]: any) => [
        name,
        { sha256: input.sha256, bytes: input.bytes },
      ]),
    ),
    scenarios: [],
    sourceHashes: await snapshotSource(),
  };
let runtime: any;
const artifactCache = new Map<string, Buffer>();
const gateway = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const signature = new URL(request.url).pathname.slice(
        "/token-meta/".length,
      );
      const data = artifactCache.get(signature);
      return data
        ? new Response(data, {
            headers: { "Content-Type": "application/json" },
          })
        : new Response("cold", { status: 404 });
    },
  }),
  origin = "http://127.0.0.1:" + gateway.port;
function walletFor(signer: any) {
  const account = {
    address: signer.publicKey.toBase58(),
    publicKey: signer.publicKey.toBytes(),
    chains: ["solana:localnet"],
    features: ["solana:signTransaction"],
  };
  const wallet = {
    accounts: [account],
    chains: ["solana:localnet"],
    features: {
      "solana:signTransaction": {
        supportedTransactionVersions: ["legacy"],
        async signTransaction({ transaction }: any) {
          const tx = Transaction.from(transaction);
          tx.partialSign(signer);
          return [
            {
              signedTransaction: tx.serialize({ requireAllSignatures: false }),
            },
          ];
        },
      },
    },
  };
  return { account, wallet };
}
const creatorWallet = walletFor(f.creator),
  buyerWallet = walletFor(f.buyer),
  pendingMap = new Map(),
  pending = {
    load: async (key: string) => pendingMap.get(key),
    save: async (key: string, value: any) => pendingMap.set(key, value),
    clear: async (key: string) => pendingMap.delete(key),
  };
try {
  f.surf.deploy({
    programId: "9KLLchQVJpGkw4jPuUmnvqESdR7mtNCYr3qS4iQLabs",
    soPath: codePath,
  });
  setRpcUrl(f.connection.rpcEndpoint);
  async function writeArtifact(bytes: any, name: string) {
    const signature = await writer.codeIn(
      { connection: f.connection, signer: f.creator },
      Buffer.from(bytes).toString("utf8"),
      name,
      0,
      "json",
    );
    const receipt = await f.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 1,
    });
    assert(receipt && !receipt.meta?.err);
    const decoded = await reader.readUserInventoryCodeInFromTx(receipt);
    const actual = Buffer.from(decoded.data);
    assert.equal(sha(actual), sha(bytes));
    artifactCache.set(signature, actual);
    return signature;
  }
  const baseBytes = await readFile(
      new URL("base/1.png", "file://" + kit.root + "/"),
    ),
    manifest = Buffer.from(
      JSON.stringify({
        std: "iqnft-0.1",
        slug: "native-synthetic",
        name: "Native synthetic",
        items: [{ index: 1, name: "Creator #1", image_sha256: sha(baseBytes) }],
      }),
    ),
    manifestSig = await writeArtifact(manifest, "manifest.json"),
    C = await writeArtifact(
      Buffer.from(
        JSON.stringify({
          kind: "image",
          body: "data:image/png;base64," + baseBytes.toString("base64"),
        }),
      ),
      "base-image.json",
    ),
    M = await writeArtifact(
      Buffer.from(
        JSON.stringify({
          name: "Creator #1",
          image: origin + "/img/" + C + ".png",
        }),
      ),
      "base-metadata.json",
    );
  const collection = generateSigner(f.umi),
    collectionKey = new PublicKey(collection.publicKey),
    registry = PublicKey.findProgramAddressSync(
      [Buffer.from("registry"), collectionKey.toBuffer()],
      f.iqId,
    )[0],
    auth = PublicKey.findProgramAddressSync(
      [Buffer.from("collection-auth"), registry.toBuffer()],
      f.iqId,
    )[0],
    idl = JSON.parse(
      await readFile(
        new URL("../../target/idl/iq_inscription_nft.json", import.meta.url),
        "utf8",
      ),
    ),
    iq = new anchor.Program(
      idl,
      new anchor.AnchorProvider(f.connection, new anchor.Wallet(f.creator), {
        commitment: "confirmed",
      }),
    );
  const create = core
      .createCollectionV1(f.umi, {
        collection,
        updateAuthority: publicKey(auth.toBase58()),
        name: "Native synthetic",
        uri: origin + "/token-meta/" + M,
      })
      .getInstructions()
      .map(toWeb3JsInstruction),
    initialize = await iq.methods
      .initializeRegistry(
        1,
        Array.from(Buffer.from(sha(manifest), "hex")),
        Array.from(bs58.decode(manifestSig)),
        Array(32).fill(7),
        f.creator.publicKey,
        f.creator.publicKey,
        new anchor.BN(0),
        new anchor.BN(0),
        f.treasury.publicKey,
      )
      .accountsStrict({
        payer: f.creator.publicKey,
        collection: collectionKey,
        registry,
        collectionAuth: auth,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  await f.send(
    "native-real-collection-and-manifest",
    [...create, initialize],
    [f.creator, Keypair.fromSecretKey(collection.secretKey)],
  );
  const dbSource = await readFile(
      new URL("../../backend/src/db.ts", import.meta.url),
      "utf8",
    ),
    schema = /db\.exec\(`([\s\S]*?)`\);/.exec(dbSource);
  assert(schema);
  db.exec(schema[1]);
  db.query(
    "INSERT INTO collection (slug,core_collection,registry,name,symbol,creator,treasury,max_supply,price_lamports,deposit_lamports,shuffle_seed,shuffle_commit,manifest_sig,manifest_hash,meta_sig,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,1,0,0,?8,?9,?10,?11,?12,0)",
  ).run(
    "native-synthetic",
    collectionKey.toBase58(),
    registry.toBase58(),
    "Native synthetic",
    "TEST",
    f.creator.publicKey.toBase58(),
    f.treasury.publicKey.toBase58(),
    "00".repeat(32),
    "07".repeat(32),
    manifestSig,
    sha(manifest),
    M,
  );
  const genesis = await f.connection.getGenesisHash(),
    options = {
      db,
      connection: f.connection,
      iqProgram: iq,
      program: f.program,
      operator: f.operator,
      vrf: f.vrf,
      chain: "solana:localnet" as const,
      expectedGenesis: genesis,
      gateway: origin,
      origin,
      stagingRoot: new URL("staging/", out).pathname,
      renderRoot: new URL("render/", out).pathname,
      providerTreasury: f.providerTreasury.publicKey.toBase58(),
      window: 100000,
      timeout: 1000,
      operationsReserveLamports: 300000000,
      requestFundingLamports: 10000000,
      maxWindowsPerDay: 3,
    };
  runtime = await createPackRuntime(options);
  assert.equal(runtime.pages.size, 0);
  kit.input.definitions[0].supply = 6;
  kit.input.definitions.push({
    ...kit.input.definitions[0],
    id: 1,
    name: "Original red hair",
    sourceId: "hair-a",
    creatorTier: "rare",
  });
  const files = [];
  for (const name of [
    "bg.png",
    "body.png",
    "hair-a.png",
    "hair-b.png",
    "base/1.png",
  ])
    files.push({
      name,
      base64: (await readFile(kit.root + "/" + name)).toString("base64"),
    });
  const creatorHttp=async(action:string,value:any,token?:string)=>runtime.creator.handle(new Request(origin+'/creator/packs/'+action,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(value)}));
  assert.equal((await creatorHttp('validate',{})).status,401);
  const challenge=await(await creatorHttp('auth',{owner:f.creator.publicKey.toBase58()})).json();
  const proof={owner:f.creator.publicKey.toBase58(),message:challenge.message,signature:bs58.encode(nacl.sign.detached(Buffer.from(challenge.message),f.creator.secretKey))};
  const login=await(await creatorHttp('auth',proof)).json();assert(login.token);
  assert.equal((await creatorHttp('auth',proof)).status,409);
  assert.equal((await creatorHttp('validate',{owner:f.buyer.publicKey.toBase58()},login.token)).status,403);
  async function creatorRequest(action:string,value:any) {
    const response=await creatorHttp(action,value,login.token),result=await response.json();
    if(!response.ok)throw Error(result.error);return result;
  }
  report.scenarios.push('creator HTTP ingress verifies wallet proof, rejects replay and different-owner requests before staging');
  const checked = await creatorRequest("validate",{
      owner: f.creator.publicKey.toBase58(),
      sourceConsent: false,
      manifest: kit.input,
      files,
      settings: { priceLamports: 100000000 },
      final: true,
    }),
    checkpoint = {};
  await assert.rejects(
    creatorRequest("publish",{
      draftId: checked.draftId,
      owner: f.creator.publicKey.toBase58(),
      sourceConsent: false,
    }),
    /source publication/,
  );
  await publishKitArtifacts(
    checked.publicationKit,
    (name: string) => readFile(kit.root + "/" + name),
    {
      gateway: origin,
      connection: f.connection,
      expectedGenesis: genesis,
      owner: f.creator.publicKey.toBase58(),
      writeArtifact,
      readArtifact: runtime.readArtifact,
      saveCheckpoint: async () => {},
    },
    checkpoint,
  );
  const body = {
      draftId: checked.draftId,
      owner: f.creator.publicKey.toBase58(),
      collection: collectionKey.toBase58(),
      registry: registry.toBase58(),
      publicationCheckpoint: checkpoint,
      sourceConsent: true,
    },
    setup = await creatorRequest("publish",body),
    deployment = {
      program: f.program.toBase58(),
      nftProgram: f.iqId.toBase58(),
      provider: ORAO_ID,
      providerTreasury: f.providerTreasury.publicKey.toBase58(),
    };
  await publishPackSetup({
    connection: f.connection,
    ...creatorWallet,
    chain: "solana:localnet",
    localGenesis: genesis,
    setup,
    operationsReserveLamports: 300000000,
    pendingTransactions: pending,
    deployment,
    expectedCollection: collectionKey.toBase58(),
  });
  await creatorRequest("finalize",body);
  assert(runtime.pages.has(body.collection));
  assert(runtime.sales.has(body.collection));
  assert(runtime.views.has(body.collection));
  assert(runtime.markets.has(body.collection));
  assert((await runtime.sales.get(body.collection).readSale()).canPurchase);
  report.scenarios.push(
    "actual creator publication finalization registers native live maps",
  );
  const avatar = Keypair.generate(),
    rawC = Buffer.from(bs58.decode(C)),
    record = PublicKey.findProgramAddressSync(
      [Buffer.from("inscription"), rawC.subarray(0, 32), rawC.subarray(32)],
      f.iqId,
    )[0],
    register = await iq.methods
      .registerItem(
        1,
        Array(32).fill(9),
        Array.from(rawC),
        Array.from(bs58.decode(M)),
        "Creator #1",
        origin + "/token-meta/" + M,
      )
      .accountsStrict({
        minter: f.creator.publicKey,
        owner: f.buyer.publicKey,
        registrar: f.creator.publicKey,
        registry,
        inscriptionRecord: record,
        collection: collectionKey,
        collectionAuth: auth,
        treasury: f.treasury.publicKey,
        platformTreasury: new PublicKey(
          "EWNSTD8tikwqHMcRNuuNbZrnYJUiJdKq9UXLXSEU4wZ1",
        ),
        asset: avatar.publicKey,
        mplCoreProgram: new PublicKey(CORE_ID),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  await f.send("native-fresh-base-mint", [register], [f.creator, avatar]);
  assert(await runtime.viewForAsset(avatar.publicKey.toBase58()));
  assert.equal(db.query("SELECT count(*) AS n FROM slot").get().n, 0);
  report.scenarios.push(
    "fresh Core mint routes without slot-index reconciliation",
  );
  const client = createPackClient({
      connection: f.connection,
      program: f.program,
      collection: collectionKey,
      chain: "solana:localnet",
      localGenesis: genesis,
      pendingPurchases: pending,
    }),
    purchase = await client.purchase({
      ...buyerWallet,
      expectedTotal: (await client.readSale()).pool.totalPrice,
    }),
    market = runtime.markets.get(body.collection),
    page = runtime.pages.get(body.collection);
  const selected = await page.read(f.buyer.publicKey.toBase58(), { asset: avatar.publicKey.toBase58() });
  assert.equal(selected.avatar.address, avatar.publicKey.toBase58());
  await assert.rejects(() => page.read(f.creator.publicKey.toBase58(), { asset: avatar.publicKey.toBase58() }), /not owned/);
  report.scenarios.push("selected NFT deep links verify actual Core owner and collection on Surfpool");
  let state;
  async function settleEpoch() {
    state = await market.readState();
    f.surf.timeTravelToSlot(state.epoch.closeSlot + 1);
    for (let tick = 0; tick < 80; tick++) {
      state = await market.readState();
      if (state.epoch.status === 3 && state.providerStatus === "pending")
        await f.fulfillLocalProvider(state.epoch.seed);
      const results = await runtime.runJobs();
      for (const result of results)
        if (result.signature)
          await f.connection.confirmTransaction(result.signature, "confirmed");
      state = await market.readState();
      if (
        state.epoch.status === 6 &&
        !db.query("SELECT 1 FROM pack_operator_job WHERE state IN ('prepared','submitted') LIMIT 1").get()
      ) return;
    }
    throw Error("Native jobs did not settle");
  }
  await settleEpoch();
  const inventory = await page.read(f.buyer.publicKey.toBase58(), {
    afterSignature: purchase.signature,
  });
  assert.equal(inventory.traits.length, 4);
  assert.equal(inventory.packs.length, 1);
  report.scenarios.push(
    "native SQLite runner delivers four verified rewards and settles payment",
  );
  const context = await runtime.creator.outfitContext({
    owner: f.buyer.publicKey.toBase58(),
    collection: body.collection,
    asset: avatar.publicKey.toBase58(),
  });
  const consentArgs = {
    connection: f.connection,
    ...buyerWallet,
    creatorWallet: creatorWallet.wallet,
    creatorAccount: creatorWallet.account,
    chain: "solana:localnet",
    localGenesis: genesis,
    context,
    expectedAsset: avatar.publicKey.toBase58(),
    deployment,
    collection: body.collection,
  };
  const consent=await enableOutfits(consentArgs);
  await page.read(f.buyer.publicKey.toBase58(), { afterSignature: consent });
  const trait = inventory.traits[0].address,
    eq = await client.changeEquipment({
      ...buyerWallet,
      avatar: avatar.publicKey,
      trait: new PublicKey(trait),
    }),
    equipped = await page.read(f.buyer.publicKey.toBase58(), {
      afterSignature: eq.signature,
    });
  assert(equipped.avatar.outfitURL);
  const response = await runtime.views
    .get(body.collection)
    .handle(new Request(equipped.avatar.outfitURL));
  assert.equal(response.status, 200);
  assert((await response.arrayBuffer()).byteLength > 0);
  // A dressed avatar sale transfers control of its custody-bound traits.
  // Guard the exact quoted loadout in the same transaction as payment/Core transfer.
  const outfitBuyer = Keypair.generate();
  f.surf.fundSol(outfitBuyer.publicKey.toBase58(), 2000000000);
  const tradeReader = createWardrobeReader({ connection: f.connection, program: f.program, collection: collectionKey });
  const quoted = await tradeReader.read(avatar.publicKey);
  const signerFor = (key: any) => createSignerFromKeypair(f.umi, f.umi.eddsa.createKeypairFromSecretKey(key.secretKey));
  const transferAvatar = (from: any, to: any) => core.transferV1(f.umi, { asset: publicKey(avatar.publicKey.toBase58()), collection: publicKey(collectionKey.toBase58()), authority: signerFor(from), payer: signerFor(from), newOwner: publicKey(to.publicKey.toBase58()) }).getInstructions().map(toWeb3JsInstruction);
  const saleInstructions = (snapshot: any) => guardedTrade({ program: f.program, collection: collectionKey, avatar: avatar.publicKey, revision: snapshot.loadout.revision, loadoutHash: snapshot.loadoutHash, settlement: [...tradePayments({ buyer: outfitBuyer.publicKey, seller: f.buyer.publicKey, price: 1000000n, royaltyBps: 500, creators: [{ address: f.creator.publicKey.toBase58(), percentage: 100 }] }), ...transferAvatar(f.buyer, outfitBuyer)] });
  await client.changeEquipment({ ...buyerWallet, avatar: avatar.publicKey, trait: new PublicKey(trait), remove: true });
  const sellerBeforeRejected = await f.connection.getBalance(f.buyer.publicKey);
  await assert.rejects(() => f.send("reject-stale-dressed-sale", saleInstructions(quoted), [outfitBuyer, f.buyer]), /custom program error: 0xa/);
  assert.equal(await f.connection.getBalance(f.buyer.publicKey), sellerBeforeRejected);
  assert.equal((await core.fetchAsset(f.umi, publicKey(avatar.publicKey.toBase58()))).owner, f.buyer.publicKey.toBase58());
  await client.changeEquipment({ ...buyerWallet, avatar: avatar.publicKey, trait: new PublicKey(trait) });
  tradeReader.invalidate(avatar.publicKey);const currentQuote = await tradeReader.read(avatar.publicKey);
  const sellerBeforeSale = await f.connection.getBalance(f.buyer.publicKey);
  const royaltyBeforeSale = await f.connection.getBalance(f.creator.publicKey);
  await f.send("guarded-dressed-avatar-sale", saleInstructions(currentQuote), [outfitBuyer, f.buyer]);
  assert.equal((await f.connection.getBalance(f.buyer.publicKey)) - sellerBeforeSale, 950000);
  assert.equal((await f.connection.getBalance(f.creator.publicKey)) - royaltyBeforeSale, 50000);
  assert.equal((await core.fetchAsset(f.umi, publicKey(avatar.publicKey.toBase58()))).owner, outfitBuyer.publicKey.toBase58());
  await assert.rejects(() => client.changeEquipment({ ...buyerWallet, avatar: avatar.publicKey, trait: new PublicKey(trait), remove: true }));
  await client.changeEquipment({ ...walletFor(outfitBuyer), avatar: avatar.publicKey, trait: new PublicKey(trait), remove: true });
  assert.equal((await core.fetchAsset(f.umi, publicKey(trait))).owner, outfitBuyer.publicKey.toBase58());
  await f.send("return-disposable-avatar-after-sale-proof", transferAvatar(outfitBuyer, f.buyer), [outfitBuyer]);
  const returnTrait = core.transferV1(f.umi, { asset: publicKey(trait), authority: signerFor(outfitBuyer), payer: signerFor(outfitBuyer), newOwner: publicKey(f.buyer.publicKey.toBase58()) }).getInstructions().map(toWeb3JsInstruction);
  await f.send("return-disposable-trait-after-sale-proof", returnTrait, [outfitBuyer]);
  await client.changeEquipment({ ...buyerWallet, avatar: avatar.publicKey, trait: new PublicKey(trait) });
  report.scenarios.push("atomic dressed sale rejects stale outfits before payment; confirmed sale pays seller/royalty, transfers avatar and equipped-trait control, rejects old owner and allows new-holder withdrawal");
  const removed = await client.changeEquipment({
    ...buyerWallet,
    avatar: avatar.publicKey,
    trait: new PublicKey(trait),
    remove: true,
  });
  await page.read(f.buyer.publicKey.toBase58(), {
    afterSignature: removed.signature,
  });
  const restored = await client.restoreOriginal({
    ...buyerWallet,
    avatar: avatar.publicKey,
    nftProgram: f.iqId,
  });
  await page.read(f.buyer.publicKey.toBase58(), {
    afterSignature: restored.signature,
  });
  report.scenarios.push(
    "native permanent kit consent/equip/render/remove/restore with confirmed cache refresh",
  );
  async function openWindow() {
  const challengeResponse = await runtime.windowApi.handle(
    new Request(origin + "/packs/" + body.collection + "/window", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ owner: f.buyer.publicKey.toBase58() }),
    }),
  );
  const challenge: any = await challengeResponse.json();
  assert.equal(challengeResponse.status, 200, JSON.stringify(challenge));
  assert.equal(challenge.message, packWindowMessage(challenge.challenge));
  const accepted = await runtime.windowApi.handle(
    new Request(origin + "/packs/" + body.collection + "/window", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        owner: f.buyer.publicKey.toBase58(),
        message: challenge.message,
        signature: bs58.encode(
          nacl.sign.detached(Buffer.from(challenge.message), f.buyer.secretKey),
        ),
      }),
    }),
  );
  assert.equal(accepted.status, 200, await accepted.text());
  }
  await openWindow();
  state = await market.readState();
  assert.equal(state.pool.activeEpoch, 1);
  report.scenarios.push(
    "signed budgeted window intent opens the next bounded sale",
  );
  const secondPurchase = await client.purchase({
    ...buyerWallet,
    expectedTotal: (await client.readSale()).pool.totalPrice,
  });
  await settleEpoch();
  const completedInventory = await page.read(f.buyer.publicKey.toBase58(), {
    afterSignature: secondPurchase.signature,
  });
  assert.equal(completedInventory.packs.length, 2);
  assert.equal(completedInventory.traits.length, 8);
  assert.equal(completedInventory.availablePacks, 1);
  await enableOutfits(consentArgs);
  await client.changeEquipment({...buyerWallet,avatar:avatar.publicKey,trait:new PublicKey(trait)});
  await openWindow();
  const thirdPurchase=await client.purchase({...buyerWallet,expectedTotal:(await client.readSale()).pool.totalPrice});
  await settleEpoch();
  const latest=await page.read(f.buyer.publicKey.toBase58(),{afterSignature:thirdPurchase.signature});
  assert.equal(latest.pagination.nextBefore,1);assert.equal(latest.packs.length,2);
  assert(latest.traits.some((row:any)=>row.address===trait&&row.avatar===avatar.publicKey.toBase58()),'off-page equipped trait must remain removable');
  const older=await page.read(f.buyer.publicKey.toBase58(),{before:latest.pagination.nextBefore});
  assert.equal(older.packs.length,1);assert.equal(older.packs[0].epoch,0);assert.equal(older.pagination.nextBefore,null);
  const issued=new Map([...latest.traits,...older.traits].map((row:any)=>[row.address,row]));
  assert.equal(issued.size,12);assert.equal(latest.availablePacks,0);
  for(const definition of latest.stock){assert.equal(definition.remaining,0);assert.equal([...issued.values()].filter((row:any)=>row.definition===definition.id).length,6);}
  const removedOld=await client.changeEquipment({...buyerWallet,avatar:avatar.publicKey,trait:new PublicKey(trait),remove:true});
  await page.read(f.buyer.publicKey.toBase58(),{afterSignature:removedOld.signature,before:1});
  report.scenarios.push('three real sale epochs paginate without missing rewards; off-page equipped trait survives paging and is removed successfully');
  const emptyWindow = await runtime.windowApi.handle(new Request(origin + "/packs/" + body.collection + "/window", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ owner: f.buyer.publicKey.toBase58() }),
  }));
  assert.equal(emptyWindow.status, 200); // A challenge alone authorizes nothing.
  const emptyChallenge = await emptyWindow.json();
  const emptyIntent = await runtime.windowApi.handle(new Request(origin + "/packs/" + body.collection + "/window", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      owner: f.buyer.publicKey.toBase58(),
      message: emptyChallenge.message,
      signature: bs58.encode(nacl.sign.detached(Buffer.from(emptyChallenge.message), f.buyer.secretKey)),
    }),
  }));
  assert.equal(emptyIntent.status, 409, "An exhausted pool must not authorize another operator window");
  report.scenarios.push("three sale windows conserve both trait supplies and exhausted stock refuses another window");
  await runtime.stop();
  runtime = null;
  await rm(options.stagingRoot, { recursive: true, force: true });
  await rm(options.renderRoot, { recursive: true, force: true });
  artifactCache.clear();
  runtime = await createPackRuntime(options);
  assert(runtime.pages.has(body.collection));
  assert(await runtime.viewForAsset(avatar.publicKey.toBase58()));
  assert.equal(runtime.creator.listFinalized().length, 1);
  report.scenarios.push(
    "cold restart rebuilds registration and render sources using confirmed IQ artifacts without staging/cache",
  );
  assert.deepEqual(await snapshotSource(), report.sourceHashes, "Source changed during native proof");
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  report.receipts = f.receipts;
  await writeFile(
    new URL("RESULTS.json", out),
    JSON.stringify(report, null, 2),
  );
  await runtime?.stop();
  gateway.stop();
  db.close();
  await kit.stop();
  f.stop();
  console.log(new URL("RESULTS.json", out).pathname);
}
