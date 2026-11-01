import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mountPackWalletUI } from "../wallet-ui.mjs";
const { JSDOM } = process.env.IQ_STUDIO_TEST_DEPS
  ? createRequire(process.env.IQ_STUDIO_TEST_DEPS + "/package.json")("jsdom")
  : await import("jsdom");
async function settle() {
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
}
test("wallet UI uses host registry, displays fee, disconnects and blocks unresolved retry", async () => {
  const dom = new JSDOM("<section></section>");
  const root = dom.window.document.querySelector("section");
  const account = {
    address: "public-address",
    chains: ["solana:devnet"],
    features: ["solana:signTransaction"],
  };
  let onChange;
  const wallet = {
    name: "Test Wallet",
    chains: ["solana:devnet"],
    accounts: [account],
    features: {
      "standard:connect": { connect: async () => ({ accounts: [account] }) },
      "standard:events": {
        on: (_, cb) => {
          onChange = cb;
          return () => {};
        },
      },
      "standard:disconnect": { disconnect: async () => {} },
      "solana:signTransaction": { supportedTransactionVersions: ["legacy"] },
    },
  };
  let buys = 0;
  const client = {
    reconcilePurchase: async () => ({
      state: buys ? "unresolved" : "none",
      signature: "saved-signature",
    }),
    invalidate() {},
    readSale: async () => ({
      canPurchase: true,
      pool: { price: 100000000, platformFee: 5000000, totalPrice: 105000000 },
    }),
    purchase: async (input) => {
      buys++;
      assert.equal(input.expectedTotal, 105000000);
      throw Object.assign(Error("lost response"), {
        signature: "saved-signature",
      });
    },
  };
  const dispose = mountPackWalletUI(root, {
    registry: { get: () => [wallet], on: () => () => {} },
    client,
    chain: "solana:devnet",
  });
  await settle();
  assert.equal(root.querySelector("select"), null);
  const button = (name) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent === name);
  assert.match(root.querySelector(".checkout-price").textContent, /0.105 SOL/);
  assert.match(
    root.querySelector(".checkout-fees").textContent,
    /0.005 SOL IQ fee/,
  );
  assert.equal(button("Buy pack").disabled, true);
  button("Connect wallet").click();
  await settle();
  assert.equal(button("Buy pack").disabled, false);
  assert.equal(button("Connect wallet").hidden, true);
  assert.equal(button("Disconnect").hidden, false);
  button("Buy pack").click();
  await settle();
  assert.equal(buys, 1);
  assert.equal(button("Buy pack").disabled, true);
  assert.match(root.textContent, /saved-signature/);
  button("Refresh price").click();
  await settle();
  assert.equal(button("Buy pack").disabled, true);
  wallet.accounts = [];
  onChange();
  assert.equal(button("Disconnect").disabled, true);
  dispose();
  assert.equal(root.children.length, 0);
  dom.window.close();
});

test("one Buy action prepares if needed then pays once, preserving reviewed price and wallet", async (t) => {
  for (const variant of [
    "ready",
    "prepare",
    "price-change",
    "wallet-change",
    "rejected",
    "timeout",
  ])
    await t.test(variant, async (t) => {
      const dom = new JSDOM("<section></section>"),
        root = dom.window.document.querySelector("section");
      t.after(() => dom.window.close());
      dom.window.setTimeout = (callback) => {
        queueMicrotask(callback);
        return 0;
      };
      const account = {
        address: "test-owner",
        chains: ["solana:devnet"],
        features: ["solana:signTransaction", "solana:signMessage"],
      };
      const wallet = {
        name: "Wallet",
        accounts: [account],
        chains: account.chains,
        features: {
          "standard:connect": {
            connect: async () => ({ accounts: [account] }),
          },
          "standard:events": { on: () => () => {} },
          "standard:disconnect": { disconnect: async () => {} },
          "solana:signTransaction": {
            supportedTransactionVersions: ["legacy"],
          },
          "solana:signMessage": {},
        },
      };
      let requests = 0,
        payments = 0,
        reads = 0;
      const client = {
        reconcilePurchase: async () => ({ state: "none" }),
        invalidate() {},
        readSale: async () => {
          reads++;
          return {
            canPurchase:
              variant === "ready" || (requests > 0 && variant !== "timeout"),
            epoch: { status: 6 },
            pool: {
              price: 100,
              platformFee: 5,
              totalPrice: variant === "price-change" && requests ? 106 : 105,
              definitions: [{ remaining: 4 }],
            },
          };
        },
        purchase: async (input) => {
          payments++;
          assert.equal(input.expectedTotal, 105);
          return { signature: "confirmed" };
        },
      };
      const dispose = mountPackWalletUI(root, {
        registry: { get: () => [wallet], on: () => () => {} },
        client,
        chain: "solana:devnet",
        requestWindow: async () => {
          requests++;
          if (variant === "wallet-change") wallet.accounts = [];
          if (variant === "rejected") throw Error("User rejected preparation");
        },
      });
      t.after(dispose);
      const button = (name) =>
        [...root.querySelectorAll("button")].find(
          (node) => node.textContent === name,
        );
      await settle();
      button("Connect wallet").click();
      await settle();
      assert.equal(button("Prepare packs"), undefined);
      const buy = button("Buy pack");
      buy.click();
      buy.click();
      await settle();
      assert.equal(requests, variant === "ready" ? 0 : 1);
      assert.equal(payments, ["ready", "prepare"].includes(variant) ? 1 : 0);
      assert.equal(buy.textContent, "Buy pack");
      assert.ok(reads <= 17);
      if (variant === "price-change")
        assert.match(root.textContent, /price changed/);
      if (variant === "wallet-change")
        assert.match(root.textContent, /Wallet changed/);
      if (variant === "rejected") assert.match(root.textContent, /rejected/);
      if (variant === "timeout")
        assert.match(root.textContent, /Nothing was charged/);
    });
});

test("multiple wallets use a cancellable dialog and removal before selection cannot connect", async (t) => {
  const dom = new JSDOM("<section></section>"),
    root = dom.window.document.querySelector("section");
  t.after(() => dom.window.close());
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function (value = "") {
    this.returnValue = value;
    this.open = false;
    this.dispatchEvent(new dom.window.Event("close"));
  };
  let connected = [],
    wallets, registryChanged;
  const account = {
    address: "selected-public-address",
    chains: ["solana:devnet"],
    features: ["solana:signTransaction"],
  };
  const make = (name) => ({
    name,
    chains: ["solana:devnet"],
    accounts: [account],
    features: {
      "standard:connect": {
        connect: async () => {
          connected.push(name);
          return { accounts: [account] };
        },
      },
      "standard:events": { on: () => () => {} },
      "standard:disconnect": { disconnect: async () => {} },
      "solana:signTransaction": { supportedTransactionVersions: ["legacy"] },
    },
  });
  wallets = [make("Wallet A"), make("Wallet B")];
  const dispose = mountPackWalletUI(root, {
    registry: { get: () => wallets, on: (_,callback) => { registryChanged=callback; return()=>{}; } },
    chain: "solana:devnet",
    client: {
      readSale: async () => ({
        canPurchase: true,
        pool: { price: 1, platformFee: 0, totalPrice: 1 },
      }),
      reconcilePurchase: async () => ({ state: "none" }),
    },
  });
  t.after(dispose);
  const button = (name) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent === name);
  await settle();
  assert.equal(root.querySelector("select"), null);
  button("Connect wallet").click();
  await settle();
  assert.equal(root.querySelector("dialog").open, true);
  registryChanged();
  await settle();
  assert.equal(root.querySelector("dialog").open, false);
  assert.deepEqual(connected, []);
  button("Connect wallet").click();
  await settle();
  button("Cancel").click();
  await settle();
  assert.deepEqual(connected, []);
  assert.equal(button("Connect wallet").disabled, false);
  button("Connect wallet").click();
  await settle();
  button("Wallet B").click();
  await settle();
  assert.deepEqual(connected, ["Wallet B"]);
  assert.equal(button("Connect wallet").hidden, true);
  button("Disconnect").click();
  await settle();
  button("Connect wallet").click();
  await settle();
  wallets = [];
  button("Wallet A").click();
  await settle();
  assert.deepEqual(connected, ["Wallet B"]);
  assert.match(root.textContent, /unavailable/);
});
