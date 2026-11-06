import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { createSealedPackClient } from "../../extensions/trait-packs/client/sealed-wallet.mjs";
import { requestPackWindow } from "../../extensions/trait-packs/client/window.mjs";
import {
  readTensorListings,
  tensorListingInstruction,
  tensorCancelInstruction,
  tensorPurchaseInstructions,
} from "../../extensions/trait-packs/client/tensor-market.mjs";
import { sendWalletTransaction } from "../../extensions/trait-packs/client/transactions.mjs";
const origin = "http://127.0.0.1:4592";
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options = {}) => {
  if (new URL(String(url)).origin === origin && options.method === "POST") {
    const headers = new Headers(options.headers);
    headers.set("Origin", origin);
    return nativeFetch(url, { ...options, headers });
  }
  return nativeFetch(url, options);
};
const config = await (await fetch(origin + "/qa/config")).json();
assert.equal(new URL(config.rpc).hostname, "127.0.0.1");
assert.equal(new URL(config.wsEndpoint).hostname, "127.0.0.1");
const connection = new Connection(config.rpc, {
    commitment: "confirmed",
    wsEndpoint: config.wsEndpoint,
  }),
  prefix = origin + "/packs/" + config.collection;
async function post(path, body) {
  const r = await fetch(origin + path, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    v = await r.json();
  if (!r.ok) throw Error(v.error);
  return v;
}
function actor(role) {
  const address = config.actors[role],
    account = {
      address,
      publicKey: new PublicKey(address).toBytes(),
      chains: ["solana:localnet"],
      features: ["solana:signTransaction", "solana:signMessage"],
    };
  return {
    account,
    wallet: {
      accounts: [account],
      chains: account.chains,
      features: {
        "solana:signTransaction": {
          supportedTransactionVersions: ["legacy"],
          signTransaction: async ({ transaction }) => [
            {
              signedTransaction: new Uint8Array(
                (await post("/qa/sign", { role, bytes: [...transaction] }))
                  .bytes,
              ),
            },
          ],
        },
        "solana:signMessage": {
          signMessage: async ({ message }) => [
            {
              signedMessage: message,
              signature: new Uint8Array(
                (await post("/qa/message", { role, bytes: [...message] }))
                  .signature,
              ),
            },
          ],
        },
      },
    },
  };
}
const store = new Map(),
  pendingPurchases = {
    load: async (k) => store.get(k),
    save: async (k, v) => store.set(k, v),
    clear: async (k, sig) => {
      if (store.get(k)?.signature === sig) store.delete(k);
    },
  },
  notify = (assets) =>
    post("/packs/" + config.collection + "/sealed/notify", { assets });
const client = createSealedPackClient({
  connection,
  program: config.program,
  collection: config.collection,
  chain: "solana:localnet",
  localGenesis: config.localGenesis,
  pendingPurchases,
  notify,
  requestWindow: (wallet, account) =>
    requestPackWindow({
      wallet,
      account,
      chain: "solana:localnet",
      program: config.program,
      collection: config.collection,
      endpoint: prefix + "/window",
    }),
});
const a = actor("a"),
  b = actor("b"),
  sale = await client.readSale();
const bought = await client.purchase({
  ...a,
  expectedTotal: sale.pool.totalPrice,
});
assert.equal(store.size, 0);
let page = await (await fetch(prefix + "/sealed")).json();
assert.equal(
  page.packs.find((p) => p.asset === bought.asset).owner,
  a.account.address,
);
const terms = await client.readSale();
const send = async (w, ix) =>
  sendWalletTransaction({
    connection,
    ...w,
    chain: "solana:localnet",
    localGenesis: config.localGenesis,
    transaction: new Transaction().add(...ix),
  });
await send(a, [
  await tensorListingInstruction({
    asset: bought.asset,
    collection: terms.release.packCollection,
    seller: a.account.address,
    price: 200000000n,
    expiresInSeconds: 3600,
  }),
]);
let listing = (await readTensorListings(connection, [bought.asset]))[0];
assert.equal(listing.price, 200000000n);
await send(a, [
  await tensorCancelInstruction({
    listing,
    collection: terms.release.packCollection,
    seller: a.account.address,
  }),
]);
await send(a, [
  await tensorListingInstruction({
    asset: bought.asset,
    collection: terms.release.packCollection,
    seller: a.account.address,
    price: 200000000n,
    expiresInSeconds: 3600,
  }),
]);
listing = (await readTensorListings(connection, [bought.asset]))[0];
// Tensor's fee vault fixture is already provisioned in native smoke; this site
// fixture creates it via the real buy instruction instead of hiding a fee.
await send(
  b,
  await tensorPurchaseInstructions({
    listing,
    collection: terms.release.packCollection,
    buyer: b.account.address,
    creators: [],
    maximumAmount: listing.price,
  }),
);
await notify([bought.asset]);
page = await (await fetch(prefix + "/sealed")).json();
assert.equal(
  page.packs.find((p) => p.asset === bought.asset).owner,
  b.account.address,
);
await client.open({ ...b, asset: bought.asset });
assert.equal(store.size, 0);
let done = false;
for (let i = 0; i < 120; i++) {
  const state = await (
    await fetch(prefix + "/state?owner=" + b.account.address)
  ).json();
  const found = state.packs?.find((p) => p.owner === b.account.address);
  if (found?.status === "settled") {
    done = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
assert(done, "actual source UI client must reach delivery");
await notify([bought.asset]);
page = await (await fetch(prefix + "/sealed")).json();
assert.equal(page.packs.find((p) => p.asset === bought.asset).opened, true);
const out = new URL(
  "./.evidence/sealed-wallet-" + Date.now() + "/",
  import.meta.url,
);
await mkdir(out, { recursive: true });
await writeFile(
  new URL("RESULTS.json", out),
  JSON.stringify(
    {
      passed: true,
      bought,
      page,
      scope:
        "actual client and wallet sender over generated-signature HTTP adapter; local chain only",
    },
    null,
    2,
  ),
);
console.log(
  "PASS actual wallet sender, buy/list/cancel/resell/open/index/delivery",
  out.pathname,
);
