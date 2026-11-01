// Local UI acceptance host. Generated actors only; never accepts wallet keys.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as core from "@metaplex-foundation/mpl-core";
import { publicKey } from "@metaplex-foundation/umi";
import {
  inputsFromEnvironment,
  startSyntheticFixture,
  ORAO_ID,
} from "./fixture.mjs";
import { catalogSetup } from "../../extensions/trait-packs/creator/catalog.mjs";
import {
  addresses,
  account,
  instruction,
} from "../../extensions/trait-packs/client/protocol.mjs";
import {
  sealedAddresses,
  initializeSealedRelease,
  buySealedPack,
  openSealedPack,
  readSealedRelease,
  readSealedPack,
} from "../../extensions/trait-packs/client/sealed.mjs";
import { createPackOperatorMarket } from "../../extensions/trait-packs/operator/market.mjs";
import {
  createPackJobStore,
  runPackJobs,
} from "../../backend/src/pack-jobs.ts";
import {
  readTensorListings,
  tensorListingInstruction,
  tensorCancelInstruction,
  tensorPurchaseInstructions,
  TENSOR_PROGRAM,
} from "../../extensions/trait-packs/client/tensor-market.mjs";
import { createRequire } from "node:module";
import { verifyPackRandomness } from "../../extensions/trait-packs/client/randomness.mjs";
const previewPort=Number(process.env.IQ_QA_PREVIEW_PORT??4590);if(!Number.isInteger(previewPort)||previewPort<4590||previewPort>4599)throw Error("Set a local QA port 4590–4599");
const previewOrigin="http://127.0.0.1:"+previewPort;
const inputs = await inputsFromEnvironment(),
  f = await startSyntheticFixture(inputs);
const out = new URL(
  "./.evidence/sealed-preview-" + Date.now() + "/",
  import.meta.url,
);
await mkdir(out, { recursive: true });
const secondary = Keypair.generate();
f.surf.fundSol(secondary.publicKey.toBase58(), 50000000000);
const actors = { a: f.buyer, b: secondary };
const binary = process.env.IQ_QA_TENSOR_BINARY!;
if (
  createHash("sha256")
    .update(await readFile(binary))
    .digest("hex") !== process.env.IQ_QA_TENSOR_SHA256
)
  throw Error("Tensor binary differs");
f.surf.deploy({ programId: TENSOR_PROGRAM.toBase58(), soPath: binary });
const packCollection = Keypair.generate(),
  k = sealedAddresses(f.program, f.collection),
  price = 105000000;
const metadata = {
  name: "Local cosmetic",
  image: "/trait.svg",
  attributes: [
    { trait_type: "Initial supply", value: 32 },
    { trait_type: "Creator tier", value: "common" },
  ],
};
const spec = {
  program: f.program,
  collection: f.collection,
  registry: f.registry,
  nftProgram: f.iqId,
  authority: f.creator.publicKey,
  treasury: f.treasury.publicKey,
  provider: new PublicKey(ORAO_ID),
  providerTreasury: f.providerTreasury.publicKey,
  price: 100000000,
  window: 250,
  timeout: 500,
  definitions: [
    {
      id: 0,
      name: "Local cosmetic",
      slot: 0,
      bodyMask: 1,
      supply: 32,
      hash: createHash("sha256").update(JSON.stringify(metadata)).digest("hex"),
      uri: previewOrigin+"/trait.json",
      requiredSlot: 255,
      requiredDefinition: 255,
    },
  ],
};
for (const step of catalogSetup(spec, null))
  await f.send("catalog-" + step.stage, [step.instruction]);
await f.send("operations-reserve", [
  SystemProgram.transfer({
    fromPubkey: f.creator.publicKey,
    toPubkey: k.ops,
    lamports: 2000000000,
  }),
]);
await f.send(
  "sealed-release",
  [
    initializeSealedRelease({
      program: f.program,
      collection: f.collection,
      creator: f.creator.publicKey,
      packCollection: packCollection.publicKey,
      supply: 8,
      name: "IQ local sealed pack",
      uri: previewOrigin+"/pack.json",
    }),
  ],
  [f.creator, packCollection],
);
await f.send("first-epoch", [
  instruction(f.program, 1, [
    account(f.creator.publicKey, true, true),
    account(k.pool, true),
    account(k.epoch, true),
    account(SystemProgram.programId),
  ]),
]);
const genesis = await f.connection.getGenesisHash(),
  market = createPackOperatorMarket({
    connection: f.connection,
    program: f.program,
    collection: f.collection,
    signer: f.operator,
    expectedGenesis: genesis,
    vrf: f.vrf,
    requestFundingLamports: 10000000,
  });
const db = new Database(new URL("jobs.sqlite", out).pathname),
  store = createPackJobStore(db),
  markets = new Map([[f.collection.toBase58(), market]]),
  known: PublicKey[] = [];
let worker: Promise<any> | null = null,
  mutation = false;
async function jobs() {
  if (worker) return worker;
  worker = (async () => {
    const current = await market.readState();
    if (current.epoch.status === 3 && current.providerStatus === "pending")
      await f.fulfillLocalProvider(current.epoch.seed);
    await runPackJobs({ store, markets, workerId: "sealed-preview", limit: 2 });
  })();
  try {
    return await worker;
  } finally {
    worker = null;
  }
}
const ticker = setInterval(
  () => jobs().catch((error) => console.error("Local worker", error.message)),
  500,
);
async function state() {
  const info = await f.connection.getAccountInfo(k.release),
    release = readSealedRelease(info!.data),
    rows = [];
  for (const asset of known) {
    const receiptInfo = await f.connection.getAccountInfo(
        sealedAddresses(f.program, f.collection, asset).receipt!,
      ),
      r = readSealedPack(receiptInfo!.data);
    let owner = null;
    if (!r.opened) {
      try {
        owner = (await core.fetchAsset(f.umi, publicKey(asset.toBase58())))
          .owner;
      } catch {}
    }
    const s = r.opened
      ? (await f.connection.getAccountInfo(
          addresses(f.program, f.collection, Number(r.epoch)).epoch,
        ))!.data
      : null;
    const ticketOffset = 256 + r.ticket * 48;
    rows.push({
      asset: asset.toBase58(),
      serial: r.serial,
      owner,
      opened: r.opened,
      opener: r.opener.toBase58(),
      epoch: Number(r.epoch),
      ticket: r.ticket,
      status: !r.opened
        ? "sealed"
        : s![48] === 5
          ? "refunded"
          : s![ticketOffset + 44] === 15
            ? "ready"
            : "preparing",
    });
  }
  const listings = await readTensorListings(f.connection, known);
  return {
    release: {
      supply: release.supply,
      minted: release.minted,
      opened: release.opened,
      sealed: release.sealed,
      unminted: release.unminted,
    },
    price: price / 1e9,
    actors: {
      a: actors.a.publicKey.toBase58(),
      b: actors.b.publicKey.toBase58(),
    },
    packs: rows,
    listings: listings.map((x) => ({
      ...x,
      price: Number(x.price) / 1e9,
      expiry: Number(x.expiry),
    })),
  };
}
async function action(body: any) {
  const actor = actors[body.actor as "a" | "b"];
  if (!actor) throw Error("Select a generated test actor");
  if (body.action === "buy") {
    const r = readSealedRelease(
        (await f.connection.getAccountInfo(k.release))!.data,
      ),
      asset = Keypair.generate();
    await f.send(
      "browser-buy-sealed",
      [
        buySealedPack({
          program: f.program,
          collection: f.collection,
          buyer: actor.publicKey,
          packCollection: packCollection.publicKey,
          asset: asset.publicKey,
          serial: r.minted,
          expectedTotal: price,
        }),
      ],
      [actor, asset],
    );
    known.push(asset.publicKey);
    await writeFile(
      new URL("assets.json", out),
      JSON.stringify(known.map((x) => x.toBase58())),
    );
  } else {
    if (
      typeof body.asset !== "string" ||
      !known.some((x) => x.toBase58() === body.asset)
    )
      throw Error("Unknown local pack");
    const asset = new PublicKey(body.asset);
    if (body.action === "list") {
      const amount = body.price;
      if (
        typeof amount !== "number" ||
        !Number.isFinite(amount) ||
        amount <= 0 ||
        amount > 10 ||
        !Number.isSafeInteger(amount * 1e9)
      )
        throw Error("Set an exact test price up to 10 SOL");
      await f.send(
        "browser-list-sealed",
        [
          await tensorListingInstruction({
            asset,
            collection: packCollection.publicKey,
            seller: actor.publicKey,
            price: BigInt(amount * 1e9),
            expiresInSeconds: 3600,
          }),
        ],
        [actor],
      );
    } else if (body.action === "purchase" || body.action === "cancel") {
      const listing = (await readTensorListings(f.connection, [asset]))[0];
      if (!listing) throw Error("The pack is not listed");
      if (body.action === "cancel")
        await f.send(
          "browser-cancel-listing",
          [
            await tensorCancelInstruction({
              listing,
              collection: packCollection.publicKey,
              seller: actor.publicKey,
            }),
          ],
          [actor],
        );
      else {
        if (Number(listing.price) !== body.expectedLamports)
          throw Error("Listing price changed");
        const { findFeeVaultPda } = createRequire(
          new URL(
            "../../extensions/trait-packs/client/package.json",
            import.meta.url,
          ),
        )("@tensor-foundation/marketplace");
        const [vault] = await findFeeVaultPda({ address: listing.address });
        if (!(await f.connection.getAccountInfo(new PublicKey(vault))))
          f.surf.fundSol(vault, 1000000);
        await f.send(
          "browser-buy-listed",
          await tensorPurchaseInstructions({
            listing,
            collection: packCollection.publicKey,
            buyer: actor.publicKey,
            creators: [],
            maximumAmount: listing.price,
          }),
          [actor],
        );
      }
    } else if (body.action === "open") {
      let s = await market.readState();
      if ([5, 6].includes(s.epoch.status)) {
        market.requestSaleWindow();
        for (let i = 0; i < 8 && [5, 6].includes(s.epoch.status); i++) {
          await jobs();
          s = await market.readState();
        }
      }
      if (s.epoch.status !== 1)
        throw Error("The next opening window is not ready. Try again.");
      await f.send(
        "browser-open-sealed",
        [
          openSealedPack({
            program: f.program,
            collection: f.collection,
            holder: actor.publicKey,
            packCollection: packCollection.publicKey,
            asset,
            epoch: s.epoch.id,
            ticket: s.epoch.ticketCount,
            expectedTotal: price,
          }),
        ],
        [actor],
      );
      f.surf.timeTravelToSlot(s.epoch.closeSlot + 1);
      await jobs();
    } else if (body.action === "proof") {
      const r = readSealedPack(
        (await f.connection.getAccountInfo(
          sealedAddresses(f.program, f.collection, asset).receipt!,
        ))!.data,
      );
      return await verifyPackRandomness({
        connection: f.connection,
        program: f.program,
        collection: f.collection,
        chain: "solana:localnet",
        localGenesis: genesis,
        epochId: Number(r.epoch),
        ticket: r.ticket,
      });
    } else throw Error("Unknown action");
  }
  return await state();
}
Bun.serve({
  hostname: "127.0.0.1",
  port: previewPort,
  maxRequestBodySize: 2048,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.host !== "127.0.0.1:"+previewPort)
      return new Response("Local only", { status: 403 });
    if (req.method === "GET") {
      if (u.pathname === "/state")
        return Response.json(await state(), {
          headers: { "Cache-Control": "no-store" },
        });
      if (u.pathname === "/pack.json")
        return Response.json({
          name: "IQ local sealed pack",
          image: "/pack.svg",
        });
      if (u.pathname === "/trait.json") return Response.json(metadata);
      if (u.pathname === "/pack.svg" || u.pathname === "/trait.svg")
        return new Response(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 340"><rect x="8" y="8" width="224" height="324" rx="10" fill="#12130e" stroke="#00ef00" stroke-width="2"/><path d="M20 26h200M20 314h200" stroke="#00ef00"/><text x="120" y="160" text-anchor="middle" font-family="monospace" font-size="24" fill="#e8e4d6">${u.pathname === "/pack.svg" ? "SEALED" : "TRAIT"}</text><text x="120" y="188" text-anchor="middle" font-family="monospace" font-size="11" fill="#00ef00">LOCAL TEST EDITION</text></svg>`,
          { headers: { "Content-Type": "image/svg+xml" } },
        );
      if (u.pathname === "/")
        return new Response(
          await readFile(new URL("./sealed-preview.html", import.meta.url)),
          { headers: { "Content-Type": "text/html" } },
        );
    }
    if (req.method === "POST" && u.pathname === "/action") {
      if (
        req.headers.get("origin") !== previewOrigin ||
        req.headers.get("content-type") !== "application/json"
      )
        return new Response("Local JSON origin required", { status: 403 });
      if (mutation)
        return Response.json(
          { error: "An action is already running" },
          { status: 409 },
        );
      mutation = true;
      try {
        return Response.json(await action(await req.json()));
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 400 });
      } finally {
        mutation = false;
      }
    }
    return new Response("Not found", { status: 404 });
  },
});
console.log(
  "Sealed-pack browser QA: http://127.0.0.1:4590 — generated wallets and test SOL only.",
);

// Private generated-actor context for the actual-source UI acceptance host.
// This export is never exposed by HTTP and is not production authentication.
export const sealedQa={f,actors,packCollection,k,price,genesis,market,db,known,jobs,metadata};
