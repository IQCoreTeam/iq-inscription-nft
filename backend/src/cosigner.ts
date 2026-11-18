// The co-signer: build the register instruction and partial-sign it as the
// registrar. SOL mints use the burner as payer. Stock mints use the buyer as
// payer and keep the stock in that wallet until mint. We add only the registrar
// signature and return the rest for the client to complete.

import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { config } from "./config.ts";
import { withConnection } from "./rpcpool.ts";
import { buildRegisterItemIx, buildRegisterSingleIx, PLATFORM_TREASURY, sigBytes } from "./program.ts";
import { createPaymentAccount, isSol } from "./currencies.ts";
import { assetUri } from "./metadata.ts";
import type { CollectionRow, ItemRow, ReservationRow } from "./db.ts";

export type CoSigned = { transaction: string; lastValidBlockHeight: number };

async function finish(ix: TransactionInstruction, feePayer: PublicKey, prepare: TransactionInstruction[] = []): Promise<CoSigned> {
  const { blockhash, lastValidBlockHeight } = await withConnection((c) => c.getLatestBlockhash("confirmed"));
  const tx = new Transaction().add(...prepare, ix);
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  tx.partialSign(config.registrar);
  return {
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    lastValidBlockHeight,
  };
}

export async function coSignRegisterItem(c: CollectionRow, item: ItemRow, r: ReservationRow, inscriptionSig: string, metaSig: string, asset: string): Promise<CoSigned> {
  const burner = new PublicKey(r.burner), buyer = new PublicKey(r.wallet), treasury = new PublicKey(c.treasury);
  const currency = isSol(c.currency_mint) ? null : new PublicKey(c.currency_mint!);
  const ix = await buildRegisterItemIx(
    { collection: new PublicKey(c.core_collection), treasury, currencyMint: c.currency_mint },
    {
      index: item.item_index,
      contentHash: Buffer.from(item.image_sha256, "hex"),
      inscriptionSig: sigBytes(inscriptionSig),
      metaSig: sigBytes(metaSig),
      name: item.name,
      uri: assetUri(metaSig),
      // A stock buyer signs the register transaction directly. Stock never
      // moves into the inscription burner or leaves the buyer on failure.
      minter: currency ? buyer : burner,
      owner: buyer,
      asset: new PublicKey(asset),
    }
  );
  const recipients = treasury.equals(PLATFORM_TREASURY) ? [treasury] : [treasury, PLATFORM_TREASURY];
  if (!currency) return finish(ix, burner);
  const setup = recipients.map(owner => createPaymentAccount(buyer, owner, currency));
  const accounts = await withConnection((c) => c.getMultipleAccountsInfo(setup.map(ix => ix.keys[1].pubkey), "confirmed"));
  return finish(ix, buyer, setup.filter((_, i) => !accounts[i]));
}

export async function coSignRegisterSingle(c: CollectionRow, a: { wallet: string; burner: string; inscriptionSig: string; metaSig: string; name: string; asset: string }): Promise<CoSigned> {
  const ix = await buildRegisterSingleIx(
    { collection: new PublicKey(c.core_collection), treasury: new PublicKey(c.treasury), currencyMint: c.currency_mint },
    {
      inscriptionSig: sigBytes(a.inscriptionSig),
      metaSig: sigBytes(a.metaSig),
      name: a.name,
      uri: assetUri(a.metaSig),
      minter: new PublicKey(a.burner),
      owner: new PublicKey(a.wallet),
      asset: new PublicKey(a.asset),
    }
  );
  return finish(ix, new PublicKey(a.burner));
}
