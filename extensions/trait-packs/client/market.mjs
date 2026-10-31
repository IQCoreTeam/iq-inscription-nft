import { Transaction, PublicKey } from "@solana/web3.js";
import { createWardrobeReader } from "./state.mjs";
import { restoreOutfitInstruction } from "./outfits.mjs";
import {
  packPurchase,
  outfitChange,
  sendWalletTransaction,
  assertConnectionChain,
} from "./transactions.mjs";

// The host supplies its existing Wallet Standard wallet/account and explicit
// network. No wallet discovery singleton, fixture signer or backend buyer key.
export function createPackClient({
  connection,
  program,
  collection,
  chain,
  localGenesis,
  pendingPurchases,
}) {
  program = new PublicKey(program);
  collection = new PublicKey(collection);
  if (
    !pendingPurchases?.load ||
    !pendingPurchases?.save ||
    !pendingPurchases?.clear
  )
    throw Error("Durable pending-purchase storage is required");
  const reader = createWardrobeReader({ connection, program, collection });
  let chainCheck;
  async function readSale() {
    chainCheck ??= assertConnectionChain(connection, chain, localGenesis).catch(
      (error) => {
        chainCheck = null;
        throw error;
      },
    );
    await chainCheck;
    return reader.sale();
  }
  return {
    readSale,
    invalidate: reader.invalidate,
    async reconcilePurchase(account) {
      await assertConnectionChain(connection, chain, localGenesis);
      const key = [
        chain,
        program.toBase58(),
        collection.toBase58(),
        account.address,
      ].join(":");
      const pending = await pendingPurchases.load(key);
      if (!pending) return { state: "none" };
      const status = (
        await connection.getSignatureStatuses([pending.signature], {
          searchTransactionHistory: true,
        })
      ).value[0];
      if (
        status?.err ||
        (status &&
          ["confirmed", "finalized"].includes(status.confirmationStatus))
      ) {
        await pendingPurchases.clear(key, pending.signature);
        reader.invalidate();
        return {
          state: status.err ? "failed" : "confirmed",
          signature: pending.signature,
        };
      }
      return { state: "unresolved", signature: pending.signature };
    },
    async restoreOriginal({ wallet, account, avatar }) {
      const state = await reader.read(new PublicKey(avatar));
      if (
        !state.pool.iqIntegration ||
        state.loadout.definitionIds.some((id) => id !== 255)
      )
        throw Error(
          "Remove every equipped trait before restoring the original metadata",
        );
      const signature = await sendWalletTransaction({
        connection,
        wallet,
        account,
        chain,
        localGenesis,
        transaction: new Transaction().add(
          restoreOutfitInstruction({
            nftProgram: state.pool.nftProgram,
            collection,
            owner: account.address,
            asset: avatar,
          }),
        ),
      });
      reader.invalidate(avatar);
      return { signature };
    },
    async changeEquipment({ wallet, account, avatar, trait, remove = false }) {
      const signature = await sendWalletTransaction({
        wallet,
        account,
        connection,
        chain,
        localGenesis,
        transaction: new Transaction().add(
          outfitChange(
            program,
            collection,
            new PublicKey(account.address),
            new PublicKey(avatar),
            new PublicKey(trait),
            remove,
          ),
        ),
      });
      reader.invalidate(avatar);
      return { signature };
    },
    async purchase({ wallet, account, expectedTotal }) {
      const key = [
        chain,
        program.toBase58(),
        collection.toBase58(),
        account.address,
      ].join(":");
      const pending = await pendingPurchases.load(key);
      if (pending)
        throw Object.assign(
          Error("Reconcile the previous purchase before signing again"),
          { signature: pending.signature },
        );
      reader.invalidate();
      const sale = await readSale();
      if (!sale.canPurchase) throw Error("This pack sale is not open");
      if (expectedTotal !== sale.pool.totalPrice)
        throw Error("Review the current pack price and IQ fee before signing");
      const transaction = new Transaction().add(
        packPurchase(
          program,
          collection,
          new PublicKey(account.address),
          sale.epoch.ticketCount,
          sale.epoch.id,
          expectedTotal,
        ),
      );
      try {
        const signature = await sendWalletTransaction({
          wallet,
          account,
          connection,
          transaction,
          chain,
          localGenesis,
          beforeSubmit: (receipt) =>
            pendingPurchases.save(key, {
              ...receipt,
              epoch: sale.epoch.id,
              ticket: sale.epoch.ticketCount,
              totalPrice: expectedTotal,
            }),
        });
        await pendingPurchases.clear(key, signature);
        return {
          signature,
          epoch: sale.epoch.id,
          ticket: sale.epoch.ticketCount,
          creatorPrice: sale.pool.price,
          platformFee: sale.pool.platformFee,
          totalPrice: expectedTotal,
        };
      } finally {
        reader.invalidate();
      }
    },
  };
}
