import {
  PublicKey,
  SystemProgram,
  Transaction,
  Keypair,
} from "@solana/web3.js";
import {
  sealedAddresses,
  initializeSealedRelease,
  readSealedRelease,
} from "./sealed.mjs";
import { catalogSetup } from "../creator/catalog.mjs";
import {
  addresses,
  account,
  instruction,
  readPool,
  assertPackDeployment,
} from "./protocol.mjs";
import {
  sendWalletTransaction,
  assertConnectionChain,
} from "./transactions.mjs";

// Rebuild the creator instructions from reviewed terms and current accounts;
// do not blindly sign a transaction supplied by a staging server.
export async function publishPackSetup({
  connection,
  wallet,
  account: selected,
  chain,
  localGenesis,
  setup,
  operationsReserveLamports,
  pendingTransactions,
  deployment,
  expectedCollection,
  sealedRelease,
}) {
  assertPackDeployment(setup.spec, deployment, expectedCollection);
  await assertConnectionChain(connection, chain, localGenesis);
  if (
    sealedRelease &&
    Object.keys(sealedRelease).some(
      (key) => !["supply", "name", "uri"].includes(key),
    )
  )
    throw Error("Unexpected sealed release terms");
  const reserveTarget = sealedRelease
    ? Math.max(
        operationsReserveLamports,
        sealedRelease.supply * 48000000 + 100000000,
      )
    : operationsReserveLamports;
  if (
    setup.cost.operationsReserveTargetLamports !== operationsReserveLamports ||
    !Number.isSafeInteger(reserveTarget) ||
    reserveTarget < 148000000
  )
    throw Error("Review the operations reserve before signing");
  if (sealedRelease) {
    initializeSealedRelease({
      program: setup.spec.program,
      collection: expectedCollection,
      creator: selected.address,
      packCollection: selected.address,
      ...sealedRelease,
    });
    const old = await connection.getAccountInfo(
      addresses(
        new PublicKey(setup.spec.program),
        new PublicKey(expectedCollection),
      ).pool,
      "confirmed",
    );
    if (old) {
      const decoded = readPool(old.data);
      if (decoded.epochCount > 0 && !decoded.sealedPacks)
        throw Error("Sealed mode must be chosen before the first sale window");
    }
  }
  const spec = { ...setup.spec };
  for (const key of [
    "program",
    "collection",
    "registry",
    "nftProgram",
    "authority",
    "treasury",
    "provider",
    "providerTreasury",
  ])
    spec[key] = new PublicKey(spec[key]);
  if (
    !spec.authority.equals(new PublicKey(selected.address)) ||
    !spec.collection.equals(new PublicKey(setup.collection))
  )
    throw Error("Creator identity does not match the reviewed setup");
  const keys = addresses(spec.program, spec.collection),
    id = [
      "iq-pack-setup",
      chain,
      spec.program,
      spec.collection,
      selected.address,
    ].join(":");
  const pending = await pendingTransactions.load(id);
  if (pending) {
    const status = (
      await connection.getSignatureStatuses([pending.signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (
      !status ||
      (!status.err &&
        !["confirmed", "finalized"].includes(status.confirmationStatus))
    )
      throw Object.assign(
        Error("Reconcile the previous setup transaction before retrying"),
        { signature: pending.signature },
      );
    await pendingTransactions.clear(id, pending.signature);
  }
  const send = async (ix, additionalSigners = []) => {
    const signature = await sendWalletTransaction({
      connection,
      wallet,
      account: selected,
      chain,
      localGenesis,
      transaction: new Transaction().add(ix),
      additionalSigners,
      beforeSubmit: (value) => pendingTransactions.save(id, value),
    });
    await pendingTransactions.clear(id, signature);
    return signature;
  };
  const receipts = [];
  for (const step of catalogSetup(
    spec,
    await connection.getAccountInfo(keys.pool, "confirmed"),
  ))
    receipts.push(await send(step.instruction));
  const deficit = Math.max(
    0,
    reserveTarget - (await connection.getBalance(keys.ops, "confirmed")),
  );
  if (deficit)
    receipts.push(
      await send(
        SystemProgram.transfer({
          fromPubkey: new PublicKey(selected.address),
          toPubkey: keys.ops,
          lamports: deficit,
        }),
      ),
    );
  const info = await connection.getAccountInfo(keys.pool, "confirmed");
  if (!info?.owner.equals(spec.program))
    throw Error("Setup pool owner changed");
  if (sealedRelease) {
    const k = sealedAddresses(spec.program, spec.collection),
      existing = await connection.getAccountInfo(k.release, "confirmed");
    if (existing) {
      if (!existing.owner.equals(spec.program))
        throw Error("Wrong sealed release owner");
      const release = readSealedRelease(existing.data);
      if (
        release.supply !== sealedRelease.supply ||
        release.uri !== sealedRelease.uri ||
        release.name !== sealedRelease.name
      )
        throw Error("Sealed release terms cannot change after publication");
    } else {
      const packCollection = Keypair.generate();
      receipts.push(
        await send(
          initializeSealedRelease({
            program: spec.program,
            collection: spec.collection,
            creator: selected.address,
            packCollection: packCollection.publicKey,
            ...sealedRelease,
          }),
          [packCollection],
        ),
      );
    }
  }
  if (readPool(info.data).epochCount === 0)
    receipts.push(
      await send(
        instruction(spec.program, 1, [
          account(new PublicKey(selected.address), true, true),
          account(keys.pool, true),
          account(keys.epoch, true),
          account(SystemProgram.programId),
        ]),
      ),
    );
  return receipts;
}
