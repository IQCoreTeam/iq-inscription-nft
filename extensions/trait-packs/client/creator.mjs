import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { catalogSetup } from "../creator/catalog.mjs";
import { addresses, account, instruction, readPool, assertPackDeployment } from "./protocol.mjs";
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
}) {
  assertPackDeployment(setup.spec,deployment,expectedCollection);
  await assertConnectionChain(connection, chain, localGenesis);
  if (
    setup.cost.operationsReserveTargetLamports !== operationsReserveLamports ||
    !Number.isSafeInteger(operationsReserveLamports) ||
    operationsReserveLamports < 148000000
  )
    throw Error("Review the operations reserve before signing");
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
  const send = async (ix) => {
    const signature = await sendWalletTransaction({
      connection,
      wallet,
      account: selected,
      chain,
      localGenesis,
      transaction: new Transaction().add(ix),
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
    operationsReserveLamports -
      (await connection.getBalance(keys.ops, "confirmed")),
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
