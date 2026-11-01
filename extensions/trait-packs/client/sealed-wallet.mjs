import {
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { createPackClient, packPurchaseKey } from "./market.mjs";
import { readPool } from "./protocol.mjs";
import {
  sealedAddresses,
  readSealedRelease,
  buySealedPack,
  openSealedPack,
} from "./sealed.mjs";
import {
  assertConnectionChain,
  sendWalletTransaction,
} from "./transactions.mjs";

// Same Wallet Standard sender and durable purchase checkpoint as ordinary packs.
// API notification receives only an already confirmed public asset address.
export function createSealedPackClient({
  connection,
  program,
  collection,
  chain,
  localGenesis,
  pendingPurchases,
  notify,
  requestWindow,
}) {
  if (typeof notify !== "function")
    throw Error("Confirmed sealed-asset notification is required");
  program = new PublicKey(program);
  collection = new PublicKey(collection);
  const keys = sealedAddresses(program, collection),
    incumbent = createPackClient({
      connection,
      program,
      collection,
      chain,
      localGenesis,
      pendingPurchases,
    });
  async function readSale() {
    await assertConnectionChain(connection, chain, localGenesis);
    const result = await connection.getMultipleAccountsInfoAndContext(
      [keys.pool, keys.release],
      { commitment: "confirmed" },
    );
    if (
      !Number.isSafeInteger(result.context?.slot) ||
      result.value.length !== 2 ||
      result.value.some((info) => !info?.owner.equals(program))
    )
      throw Error("Sealed pack terms unavailable");
    const pool = readPool(result.value[0].data),
      release = readSealedRelease(result.value[1].data);
    if (
      !pool.collection.equals(collection) ||
      !pool.sealedPacks ||
      !pool.sealed ||
      pool.retired ||
      !release.pool.equals(keys.pool)
    )
      throw Error("Wrong sealed release");
    return { pool, release, canPurchase: release.unminted > 0 };
  }
  async function reconcilePurchase(account) {
    const key = packPurchaseKey(chain, program, collection, account.address),
      prior = await pendingPurchases.load(key),
      result = await incumbent.reconcilePurchase(account);
    if (result.state === "confirmed" && prior?.asset) {
      try {
        await notify([prior.asset]);
      } catch (error) {
        await pendingPurchases.save(key, prior);
        throw Object.assign(
          Error(
            "Transaction confirmed; indexing is pending. Refresh before doing anything else.",
          ),
          { signature: prior.signature },
        );
      }
    }
    return result;
  }
  async function send({
    wallet,
    account,
    asset,
    transaction,
    additionalSigners = [],
  }) {
    const key = packPurchaseKey(chain, program, collection, account.address),
      prior = await pendingPurchases.load(key);
    if (prior)
      throw Object.assign(
        Error("Reconcile the previous action before signing again"),
        { signature: prior.signature },
      );
    const signature = await sendWalletTransaction({
      connection,
      wallet,
      account,
      chain,
      localGenesis,
      transaction,
      additionalSigners,
      beforeSubmit: (receipt) =>
        pendingPurchases.save(key, { ...receipt, asset: asset.toBase58() }),
    });
    try {
      await notify([asset.toBase58()]);
      await pendingPurchases.clear(key, signature);
    } catch {
      throw Object.assign(
        Error(
          "Confirmed on chain; indexing is pending. Refresh before retrying.",
        ),
        { signature },
      );
    }
    return { signature, asset: asset.toBase58() };
  }
  return {
    readSale,
    invalidate: incumbent.invalidate,
    reconcilePurchase,
    async purchase({ wallet, account, expectedTotal }) {
      const sale = await readSale();
      if (!sale.canPurchase || sale.pool.totalPrice !== expectedTotal)
        throw Error("Review the current sealed pack price");
      const asset = Keypair.generate(),
        transaction = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }),
          buySealedPack({
            program,
            collection,
            buyer: account.address,
            packCollection: sale.release.packCollection,
            asset: asset.publicKey,
            serial: sale.release.minted,
            expectedTotal,
          }),
        );
      return send({
        wallet,
        account,
        asset: asset.publicKey,
        transaction,
        additionalSigners: [asset],
      });
    },
    async open({ wallet, account, asset }) {
      const pinned = account.address,
        sale = await readSale();
      let current,
        requested = false;
      const check = () => {
        if (
          account.address !== pinned ||
          !wallet.accounts.some(
            (x) => x.address === pinned && x.chains.includes(chain),
          )
        )
          throw Error("Wallet changed before opening");
      };
      for (let attempt = 0; attempt < 16; attempt++) {
        check();
        incumbent.invalidate();
        current = await incumbent.readSale();
        if (
          current.epoch.status === 1 &&
          current.slot < current.epoch.closeSlot &&
          current.epoch.ticketCount < 32
        )
          break;
        if (
          !requested &&
          requestWindow &&
          [5, 6].includes(current.epoch.status)
        ) {
          await requestWindow(wallet, account);
          requested = true;
          check();
        } else if (attempt === 0 && !requestWindow)
          throw Error("The operator has not opened the next window");
        if (attempt === 15)
          throw Error(
            "The next opening window is not ready. Your NFT remains sealed.",
          );
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      check();
      const transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }),
        openSealedPack({
          program,
          collection,
          holder: pinned,
          packCollection: sale.release.packCollection,
          asset,
          epoch: current.epoch.id,
          ticket: current.epoch.ticketCount,
          expectedTotal: sale.pool.totalPrice,
        }),
      );
      return send({
        wallet,
        account,
        asset: new PublicKey(asset),
        transaction,
      });
    },
  };
}
