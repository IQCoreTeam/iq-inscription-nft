// The co-signer: build the register instruction and partial-sign it as the
// registrar. The burner is the fee payer, the asset is a fresh keypair the
// client holds, the owner is the user's wallet. We add only the registrar
// signature and return the rest for the client to complete.

import { PublicKey, Transaction } from "@solana/web3.js";
import { config } from "./config.ts";
import { withConnection } from "./rpcpool.ts";
import { buildRegisterItemIx, buildRegisterSingleIx, sigBytes } from "./program.ts";
import { assetUri } from "./metadata.ts";
import type { CollectionRow, ItemRow, ReservationRow } from "./db.ts";

export type CoSigned = { transaction: string; lastValidBlockHeight: number };

async function finish(ix: Awaited<ReturnType<typeof buildRegisterItemIx>>, feePayer: PublicKey): Promise<CoSigned> {
  const { blockhash, lastValidBlockHeight } = await withConnection((c) => c.getLatestBlockhash("confirmed"));
  const tx = new Transaction().add(ix);
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  tx.partialSign(config.registrar);
  return {
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    lastValidBlockHeight,
  };
}

export async function coSignRegisterItem(c: CollectionRow, item: ItemRow, r: ReservationRow, inscriptionSig: string, metaSig: string, asset: string): Promise<CoSigned> {
  const ix = await buildRegisterItemIx(
    { collection: new PublicKey(c.core_collection), treasury: new PublicKey(c.treasury) },
    {
      index: item.item_index,
      contentHash: Buffer.from(item.image_sha256, "hex"),
      inscriptionSig: sigBytes(inscriptionSig),
      metaSig: sigBytes(metaSig),
      name: item.name,
      uri: assetUri(metaSig),
      minter: new PublicKey(r.burner),
      owner: new PublicKey(r.wallet),
      asset: new PublicKey(asset),
    }
  );
  return finish(ix, new PublicKey(r.burner));
}

export async function coSignRegisterSingle(c: CollectionRow, a: { wallet: string; burner: string; inscriptionSig: string; metaSig: string; name: string; asset: string }): Promise<CoSigned> {
  const ix = await buildRegisterSingleIx(
    { collection: new PublicKey(c.core_collection), treasury: new PublicKey(c.treasury) },
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
