import {
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import { Buffer } from "buffer";
import bs58 from "bs58";
import { addresses, account, instruction, u16 } from "./protocol.mjs";

const genesis = {
  "solana:mainnet": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  "solana:devnet": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

// Public purchase/equipment builders only. Catalog administration, provider
// fulfillment and QA signers do not belong in a holder's browser client.
export function packPurchase(program, collection, buyer, ticket, epoch) {
  if (
    !Number.isInteger(ticket) ||
    ticket < 0 ||
    ticket >= 32 ||
    !Number.isSafeInteger(epoch) ||
    epoch < 0
  )
    throw Error("Invalid pack ticket or epoch");
  const k = addresses(program, collection, epoch);
  return instruction(
    program,
    2,
    [
      account(buyer, true, true),
      account(k.pool, true),
      account(k.epoch, true),
      account(k.ops),
      account(SystemProgram.programId),
    ],
    u16(ticket),
  );
}

export function outfitChange(
  program,
  collection,
  owner,
  avatar,
  trait,
  remove = false,
) {
  const k = addresses(program, collection);
  return instruction(program, remove ? 23 : 22, [
    account(owner, true, true),
    account(k.pool),
    account(avatar),
    account(k.loadout(avatar), true),
    account(trait, true),
    account(k.issuance(trait), true),
    account(k.gearAuthority),
    account(new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d")),
    account(SystemProgram.programId),
  ]);
}

export function outfitAssertion(
  program,
  collection,
  avatar,
  revision,
  loadoutHash,
) {
  if (
    !Number.isInteger(revision) ||
    revision < 0 ||
    revision > 0xffffffff ||
    !/^[a-f0-9]{64}$/.test(loadoutHash)
  )
    throw Error("Invalid outfit snapshot");
  const data = Buffer.alloc(36);
  data.writeUInt32LE(revision);
  Buffer.from(loadoutHash, "hex").copy(data, 4);
  const k = addresses(program, collection);
  return instruction(
    program,
    25,
    [account(k.pool), account(avatar), account(k.loadout(avatar))],
    data,
  );
}

// Host supplies the venue/Core transfer instructions. We cannot claim arbitrary
// venue orders or fee rules are safe just because this precondition is included.
export function guardedTrade({
  program,
  collection,
  avatar,
  revision,
  loadoutHash,
  settlement,
}) {
  if (!Array.isArray(settlement) || !settlement.length)
    throw Error("Settlement instructions are required");
  return [
    outfitAssertion(program, collection, avatar, revision, loadoutHash),
    ...settlement,
  ];
}

// Quote an explicit direct trade. Royalties use exact integer arithmetic;
// leftover fractional lamports stay with the seller. No invented venue fee.
export function tradePayments({ buyer, seller, price, royaltyBps, creators }) {
  if (
    typeof price !== "bigint" ||
    price < 0n ||
    price > 0xffffffffffffffffn ||
    !Number.isInteger(royaltyBps) ||
    royaltyBps < 0 ||
    royaltyBps > 10000 ||
    !Array.isArray(creators)
  )
    throw Error("Invalid sale terms");
  if (
    royaltyBps &&
    (!creators.length ||
      creators.reduce((sum, c) => sum + c.percentage, 0) !== 100)
  )
    throw Error("Royalty percentages must total 100");
  const seen = new Set();
  let royalties = 0n;
  const payments = [];
  for (const creator of creators) {
    const address = new PublicKey(creator.address);
    if (
      !Number.isInteger(creator.percentage) ||
      creator.percentage < 0 ||
      creator.percentage > 100 ||
      seen.has(address.toBase58())
    )
      throw Error("Invalid royalty creator");
    seen.add(address.toBase58());
    const lamports =
      (price * BigInt(royaltyBps) * BigInt(creator.percentage)) / 1000000n;
    royalties += lamports;
    if (lamports)
      payments.push(
        SystemProgram.transfer({
          fromPubkey: buyer,
          toPubkey: address,
          lamports,
        }),
      );
  }
  if (price - royalties)
    payments.push(
      SystemProgram.transfer({
        fromPubkey: buyer,
        toPubkey: seller,
        lamports: price - royalties,
      }),
    );
  return payments;
}

// Wallet Standard receives an explicit chain. Legacy injected signTransaction
// cannot reliably identify Devnet, which caused the misleading Phantom prompt.
export async function sendWalletTransaction({
  connection,
  wallet,
  account: selected,
  chain,
  transaction,
  localGenesis,
  additionalSigners = [],
}) {
  const expected =
    genesis[chain] ?? (chain === "solana:localnet" ? localGenesis : null);
  if (!expected || (await connection.getGenesisHash()) !== expected)
    throw Error("RPC chain mismatch");
  const feature = wallet.features["solana:signTransaction"];
  if (
    !wallet.chains.includes(chain) ||
    !selected.chains.includes(chain) ||
    !selected.features.includes("solana:signTransaction") ||
    !feature?.supportedTransactionVersions.includes("legacy")
  )
    throw Error("Wallet does not support this chain and transaction");
  const current = () =>
    wallet.accounts.find(
      (a) =>
        a.address === selected.address &&
        a.chains.includes(chain) &&
        a.features.includes("solana:signTransaction"),
    );
  if (!current()) throw Error("Wallet account changed");
  if (
    !transaction ||
    !Array.isArray(transaction.instructions) ||
    !transaction.instructions.length ||
    typeof transaction.serializeMessage !== "function"
  )
    throw Error("A nonempty legacy transaction is required");
  const owner = new PublicKey(selected.address);
  if (!owner.equals(new PublicKey(selected.publicKey)))
    throw Error("Wallet address and key differ");
  const validity = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = owner;
  transaction.recentBlockhash = validity.blockhash;
  if (additionalSigners.length) transaction.partialSign(...additionalSigners);
  const message = transaction.serializeMessage();
  const serialized = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  const [output] = await feature.signTransaction({
    account: selected,
    chain,
    transaction: new Uint8Array(serialized),
  });
  if (!current()) throw Error("Wallet account changed");
  if (!output?.signedTransaction)
    throw Error("Wallet returned no signed transaction");
  const signed = Transaction.from(output.signedTransaction);
  if (!signed.serializeMessage().equals(message))
    throw Error("Wallet changed the transaction message");
  if (!signed.verifySignatures())
    throw Error("Transaction signatures are invalid or incomplete");
  const expectedSignature = signed.signature;
  if (
    !expectedSignature ||
    !nacl.sign.detached.verify(message, expectedSignature, owner.toBytes())
  )
    throw Error("Wallet signature is invalid");
  // Preserve the exact signed legacy message during simulation. The legacy
  // web3 overload refreshes its blockhash and depends on constructor identity.
  const simulated = await connection.simulateTransaction(
    VersionedTransaction.deserialize(signed.serialize()),
    { sigVerify: true, commitment: "confirmed" },
  );
  if (simulated.value.err)
    throw Error(
      "Transaction simulation rejected: " + JSON.stringify(simulated.value.err),
    );
  let signature;
  try {
    signature = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (cause) {
    throw Object.assign(Error('Submission unresolved; check the signed transaction before retrying'), {signature:bs58.encode(expectedSignature),cause});
  }
  if (signature !== bs58.encode(expectedSignature))
    throw Object.assign(
      Error(
        "RPC returned a different signature; inspect the signed transaction before retrying",
      ),
      { signature: bs58.encode(expectedSignature) },
    );
  let result;
  try {
    result = await connection.confirmTransaction(
      { ...validity, signature },
      "confirmed",
    );
  } catch (error) {
    // Never silently re-sign or replay after ambiguous confirmation.
    const status = (
      await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      }).catch(cause => {throw Object.assign(Error('Confirmation lookup failed; check this signature before retrying'),{signature,cause});})
    ).value[0];
    if (status?.err)
      throw Error("Transaction failed: " + JSON.stringify(status.err));
    if (
      !status ||
      !["confirmed", "finalized"].includes(status.confirmationStatus)
    )
      throw Object.assign(
        Error(
          "Confirmation unresolved; check this signature before retrying: " +
            signature,
        ),
        { signature, cause: error },
      );
  }
  if(result?.value.err) throw Error('Transaction failed: '+JSON.stringify(result.value.err));
  return signature;
}
