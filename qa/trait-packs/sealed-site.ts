// Mounts the actual IQ packs module with generated Wallet Standard actors.
// No production source is patched or injected with a server-side wallet key.
import { readFile, realpath, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transaction, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import nacl from "tweetnacl";
import * as core from "@metaplex-foundation/mpl-core";
import { createSealedPackIndex } from "../../extensions/trait-packs/service/sealed-state.mjs";
import { createPackPageStateReader } from "../../extensions/trait-packs/service/pack-state.mjs";
import { createPackWindowApi } from "../../backend/src/pack-window.ts";
import { TENSOR_PROGRAM } from "../../extensions/trait-packs/client/tensor-market.mjs";
process.env.IQ_QA_PREVIEW_PORT = "4591";
const { sealedQa: q } = await import("./sealed-preview.ts");
const origin = "http://127.0.0.1:4592",
  front = process.env.IQ_QA_FRONTEND_ROOT;
if (!front) throw Error("Set the reviewed frontend root");
const assets = await realpath(path.join(front, "assets"));
async function readCoreAssets(keys: any[], { minContextSlot = 0 } = {}) {
  const infos = await q.f.connection.getMultipleAccountsInfoAndContext(
    keys.map((x) => new PublicKey(x)),
    { commitment: "confirmed", minContextSlot },
  );
  return new Map(
    keys.map((key, i) => {
      const account = infos.value[i],
        id = new PublicKey(key).toBase58();
      if (!account || (account.data[0] === 0 && account.data.length === 1))
        return [id, null];
      if (
        account.owner.toBase58() !==
        "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
      )
        throw Error("Wrong Core owner");
      return [
        id,
        core.deserializeAssetV1({
          publicKey: id,
          exists: true,
          executable: false,
          owner: account.owner.toBase58(),
          lamports: BigInt(account.lamports),
          data: account.data,
        }),
      ];
    }),
  );
}
const sealed = createSealedPackIndex({
  db: q.db,
  connection: q.f.connection,
  program: q.f.program,
  collection: q.f.collection,
  expectedGenesis: q.genesis,
  chain: "solana:localnet",
  readCoreAssets,
});
const page = createPackPageStateReader({
  connection: q.f.connection,
  program: q.f.program,
  collection: q.f.collection,
  nftProgram: q.f.iqId,
  chain: "solana:localnet",
  expectedGenesis: q.genesis,
  collectionSlug: "local-sealed-review",
  appearance: { collectionName: "IQ sealed review" },
  readCoreAssets,
  readMetadata: async () => Buffer.from(JSON.stringify(q.metadata)),
  getAvatar: async () => null,
  outfitUrl: () => "",
});
const windows = createPackWindowApi({
  db: q.db,
  origin,
  markets: new Map([
    [
      q.f.collection.toBase58(),
      {
        market: q.market,
        program: q.f.program.toBase58(),
        chain: "solana:localnet",
        maxWindowsPerDay: 8,
      },
    ],
  ]),
  runJobs: async () => {
    windows.refreshDemands();
    await q.jobs();
  },
});
const bootstrap = `import{Connection,PublicKey}from'/pack-client.js';import{createPackPendingStorage}from'/js/codein/pack_bootstrap.mjs';const value=await(await fetch('/qa/config')).json();function wallet(role,address){const account={address,publicKey:new PublicKey(address).toBytes(),chains:['solana:localnet'],features:['solana:signTransaction','solana:signMessage']};return{name:'Local collector '+role.toUpperCase(),accounts:[account],chains:account.chains,features:{'standard:connect':{connect:async()=>({accounts:[account]})},'standard:disconnect':{disconnect:async()=>{}},'standard:events':{on:()=>()=>{}},'solana:signTransaction':{supportedTransactionVersions:['legacy'],signTransaction:async({transaction})=>[{signedTransaction:new Uint8Array((await post('sign',{role,bytes:[...transaction]})).bytes)}]},'solana:signMessage':{signMessage:async({message})=>[{signedMessage:message,signature:new Uint8Array((await post('message',{role,bytes:[...message]})).signature)}]}}};}async function post(action,body){const r=await fetch('/qa/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),v=await r.json();if(!r.ok)throw Error(v.error);return v;}const wallets=Object.entries(value.actors).map(([role,address])=>wallet(role,address));window.iqPackConfig={...value,apiBase:location.origin,gateway:location.origin,apiOrigins:[location.origin],mediaOrigins:[location.origin],clientModule:'/pack-client.js',chain:'solana:localnet',sealedPacks:true,connection:new Connection(value.rpc,{commitment:'confirmed',wsEndpoint:value.wsEndpoint}),registry:{get:()=>wallets,on:()=>()=>{}},windowRequests:true,pendingPurchases:createPackPendingStorage(()=>localStorage,'sealed:')};window.iqPackBootstrap=Promise.resolve();await(await import('/js/sections/pages/nft_packs.js')).mountPacks();`;
Bun.serve({
  hostname: "127.0.0.1",
  port: 4592,
  idleTimeout: 120,
  maxRequestBodySize: 12000,
  async fetch(req) {
    const url = new URL(req.url);
    if (
      url.host !== "127.0.0.1:4592" ||
      (req.headers.get("origin") && req.headers.get("origin") !== origin)
    )
      return new Response("Local only", { status: 403 });
    try {
      if (req.method === "POST" && req.headers.get("origin") !== origin)
        return new Response("Local origin required", { status: 403 });
      if (url.pathname === "/qa/config")
        return Response.json({
          rpc: q.f.connection.rpcEndpoint,
          wsEndpoint: q.f.surf.wsUrl,
          program: q.f.program.toBase58(),
          collection: q.f.collection.toBase58(),
          nftProgram: q.f.iqId.toBase58(),
          localGenesis: q.genesis,
          actors: {
            a: q.actors.a.publicKey.toBase58(),
            b: q.actors.b.publicKey.toBase58(),
          },
        });
      if (url.pathname === "/qa/sign" || url.pathname === "/qa/message") {
        if (req.method !== "POST")
          return new Response("POST required", { status: 405 });
        const body = await req.json(),
          actor = q.actors[body.role as "a" | "b"];
        if (
          !actor ||
          !Array.isArray(body.bytes) ||
          body.bytes.length > 10000 ||
          body.bytes.some((x: any) => !Number.isInteger(x) || x < 0 || x > 255)
        )
          throw Error("Invalid generated actor input");
        const bytes = new Uint8Array(body.bytes);
        if (url.pathname === "/qa/message") {
          const text = new TextDecoder().decode(bytes);
          if (
            !text.startsWith("Request one IQ pack sale window\n") ||
            !text.includes("\nOrigin: " + origin + "\n") ||
            !text.includes("\nWallet: " + actor.publicKey.toBase58() + "\n")
          )
            throw Error("Only a local sale-window message can be signed");
          return Response.json({
            signature: [...nacl.sign.detached(bytes, actor.secretKey)],
          });
        }
        const tx = Transaction.from(bytes);
        if (!tx.feePayer?.equals(actor.publicKey))
          throw Error("Wrong local fee payer");
        for (const ix of tx.instructions) {
          if (ix.programId.equals(q.f.program)) {
            if (
              ![31, 32].includes(ix.data[0]) ||
              !ix.keys[1].pubkey.equals(q.k.pool)
            )
              throw Error("Only local sealed operations allowed");
          } else if (
            !ix.programId.equals(TENSOR_PROGRAM) &&
            !ix.programId.equals(ComputeBudgetProgram.programId)
          )
            throw Error("Unapproved local program");
        }
        tx.partialSign(actor);
        return Response.json({
          bytes: [
            ...tx.serialize({
              requireAllSignatures: false,
              verifySignatures: false,
            }),
          ],
        });
      }
      const prefix = "/packs/" + q.f.collection.toBase58();
      if (url.pathname === prefix + "/sealed" && req.method === "GET")
        return Response.json(
          await sealed.read({
            before: url.searchParams.has("before")
              ? Number(url.searchParams.get("before"))
              : undefined,
          }),
        );
      if (url.pathname === prefix + "/sealed/notify" && req.method === "POST") {
        const value = await req.json();
        return Response.json(await sealed.notify(value.assets));
      }
      if (url.pathname === prefix + "/state")
        return Response.json(
          await page.read(url.searchParams.get("owner"), {
            afterSignature: url.searchParams.get("after") ?? undefined,
            before: url.searchParams.has("before")
              ? Number(url.searchParams.get("before"))
              : undefined,
          }),
        );
      if (url.pathname === prefix + "/window") return windows.handle(req);
      if (url.pathname === "/qa/bootstrap.mjs")
        return new Response(bootstrap, {
          headers: { "Content-Type": "application/javascript" },
        });
      if (url.pathname === "/trait.svg")
        return fetch("http://127.0.0.1:4591/trait.svg");
      if (url.pathname === "/")
        return new Response(
          '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IQ sealed packs · local source review</title><link rel="stylesheet" href="/css/fonts.css"><link href="https://fonts.googleapis.com/css2?family=Zen+Dots&display=swap" rel="stylesheet"><link rel="stylesheet" href="/css/nft_packs.css"><style>body{margin:0;background:#090b06;color:#e8e4d6}body>p{font:12px monospace;text-align:center;padding:12px;border-bottom:1px solid #444}</style><p>LOCAL SURFPOOL · GENERATED WALLETS · TEST SOL · ACTUAL IQ PACKS MODULE</p><main id="main_section"></main><script type="module" src="/qa/bootstrap.mjs"></script></html>',
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      const file = await realpath(
        path.resolve(assets, "." + decodeURIComponent(url.pathname)),
      );
      if (!file.startsWith(assets + path.sep))
        throw Error("Static path escaped");
      const bytes = await readFile(file),
        ext = path.extname(file);
      return new Response(bytes, {
        headers: {
          "Content-Type":
            (
              {
                ".js": "application/javascript",
                ".mjs": "application/javascript",
                ".css": "text/css",
                ".html": "text/html; charset=utf-8",
                ".webp": "image/webp",
                ".png": "image/png",
                ".woff2": "font/woff2",
                ".svg": "image/svg+xml",
              } as any
            )[ext] ?? "application/octet-stream",
          "Cache-Control": "no-store",
        },
      });
    } catch (e: any) {
      return Response.json({ error: e.message }, { status: 400 });
    }
  },
});
console.log(
  "Actual source sealed UI: " +
    origin +
    "/?menu=packs&collection=" +
    q.f.collection.toBase58(),
);
