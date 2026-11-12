import {
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
} from "@solana/web3.js";
import {
  createPackClient,
  packPurchaseKey,
  reconcilePackTransaction,
} from "./market.mjs";
import {
  readPool,
  CLAIM_BUDGET_LAMPORTS,
  PROVIDER_RESERVE_LAMPORTS,
} from "./protocol.mjs";
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
  async function readTerms() {
    await assertConnectionChain(connection, chain, localGenesis);
    const result = await connection.getMultipleAccountsInfoAndContext(
      [keys.pool, keys.release, keys.ops],
      { commitment: "confirmed" },
    );
    if (
      !Number.isSafeInteger(result.context?.slot) ||
      result.value.length !== 3 ||
      result.value.slice(0, 2).some((info) => !info?.owner.equals(program))
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
    const ops = result.value[2],
      required =
        (pool.outstandingTraits + 4) * CLAIM_BUDGET_LAMPORTS +
        PROVIDER_RESERVE_LAMPORTS;
    if (
      !ops?.owner.equals(SystemProgram.programId) ||
      ops.data.length ||
      !Number.isSafeInteger(ops.lamports) ||
      !Number.isSafeInteger(required)
    )
      throw Error("Invalid sealed delivery reserve");
    return {
      pool,
      release,
      operationsLamports: ops.lamports,
      canPurchase: release.unminted > 0 && ops.lamports >= required,
    };
  }
  async function readSale() {
    const terms = await readTerms();
    if (terms.release.unminted > 0 && !terms.canPurchase)
      throw Error(
        "The creator must fund the delivery reserve before another pack can be sold.",
      );
    return terms;
  }
  async function reconcilePurchase(account) {
    return reconcilePackTransaction({
      connection,
      chain,
      localGenesis,
      pendingPurchases,
      key: packPurchaseKey(chain, program, collection, account.address),
      afterConfirmation: (pending) =>
        pending.asset ? notify([pending.asset]) : undefined,
    });
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
        { signature, confirmed: true },
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
        sale = await readTerms();
      if (
        sale.operationsLamports <
        sale.pool.outstandingTraits * CLAIM_BUDGET_LAMPORTS +
          PROVIDER_RESERVE_LAMPORTS
      )
        throw Error(
          "The creator must fund existing delivery obligations before opening.",
        );
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
