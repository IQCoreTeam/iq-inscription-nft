import {
  PublicKey,
  SystemProgram,
  Keypair,
  Transaction,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import {
  addresses,
  account as a,
  instruction as ix,
  readPool,
  readEpoch,
  u16,
  candidateRequestSeed,
  encodeRequest,
  PLATFORM_TREASURY,
  PROVIDER_RESERVE_LAMPORTS,
} from "../client/protocol.mjs";
import { nextEpochTask } from "./epoch-task.mjs";

const ORAO = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
const CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const requestAddress = (seed) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("orao-vrf-randomness-request"), seed],
    ORAO,
  )[0];
const network = PublicKey.findProgramAddressSync(
  [Buffer.from("orao-vrf-network-configuration")],
  ORAO,
)[0];

// Host supplies its existing operator signer and ORAO SDK instance. The buyer
// never signs here. This adapter constructs and simulates; only the durable
// leased job runner may broadcast its returned signed bytes.
export function createPackOperatorMarket({
  connection,
  program,
  collection,
  signer,
  expectedGenesis,
  vrf,
  requestFundingLamports,
}) {
  program = new PublicKey(program);
  collection = new PublicKey(collection);
  if (
    !vrf.programId.equals(ORAO) ||
    !Number.isSafeInteger(requestFundingLamports) ||
    requestFundingLamports <= 0 ||
    requestFundingLamports > PROVIDER_RESERVE_LAMPORTS
  )
    throw Error("Invalid pinned ORAO operator configuration");
  const keys = addresses(program, collection),
    operator = new PublicKey(signer.publicKey);
  let saleDemandUntil = 0,
    demandEpoch = null;
  const requestSaleWindow = (accepted) => {
    if(accepted){
      if(!Number.isSafeInteger(accepted.epoch)||accepted.epoch<0||!Number.isSafeInteger(accepted.until)||accepted.until<=Date.now()||accepted.until>Date.now()+300000)throw Error("Invalid durable sale-window demand");
      saleDemandUntil=accepted.until;demandEpoch=accepted.epoch;
    }else{saleDemandUntil = Date.now() + 30000;demandEpoch = null;}
  };
  async function readState(minContextSlot=0) {
    if(!Number.isSafeInteger(minContextSlot)||minContextSlot<0)throw Error("Invalid operator context floor");
    if ((await connection.getGenesisHash()) !== expectedGenesis)
      throw Error("Pack operator RPC chain mismatch");
    const initial = await connection.getMultipleAccountsInfoAndContext(
      [keys.pool, program, ORAO],
      { commitment: "confirmed",minContextSlot },
    );
    const [info, programInfo, providerInfo] = initial.value;
    if (
      !info?.owner.equals(program) ||
      !programInfo?.executable ||
      !providerInfo?.executable
    )
      throw Error("Wrong operator program owner");
    const pool = readPool(info.data);
    if (
      !pool.collection.equals(collection) ||
      !pool.provider.equals(ORAO) ||
      !pool.sealed ||
      pool.definitionCount < 1 ||
      pool.definitionCount > 16 ||
      pool.pulls !== 4
    )
      throw Error("Wrong operator pool identity");
    const k = addresses(program, collection, pool.activeEpoch);
    const latest = await connection.getMultipleAccountsInfoAndContext([k.epoch,k.requester], {
      commitment: "confirmed",
      minContextSlot: initial.context.slot,
    });
    const [epochInfo,requester] = latest.value;
    if (!epochInfo?.owner.equals(program)) throw Error("Wrong operator epoch owner");
    if(requester && (!requester.owner.equals(SystemProgram.programId) || requester.data.length || requester.executable))
      throw Error("Wrong operator requester account");
    const requesterLamports=requester?.lamports??0;
    if(!Number.isSafeInteger(requesterLamports)||requesterLamports<0)throw Error("Invalid requester balance");
    const epoch = readEpoch(epochInfo.data);
    if(epoch.requested && epoch.requestSponsor.equals(PublicKey.default))throw Error("Missing confirmed request sponsor");
    if (
      !epoch.pool.equals(keys.pool) ||
      epoch.id !== pool.activeEpoch ||
      epoch.ticketCount > 32
    )
      throw Error("Wrong operator epoch identity");
    if (
      saleDemandUntil <= Date.now() ||
      (demandEpoch !== null && pool.activeEpoch !== demandEpoch) ||
      (epoch.status === 1 && latest.context.slot < epoch.closeSlot)
    ) {
      saleDemandUntil = 0;
      demandEpoch = null;
    } else if (saleDemandUntil > 0 && demandEpoch === null)
      demandEpoch = pool.activeEpoch;
    const saleDemand = saleDemandUntil > Date.now();
    let providerStatus = "unknown";
    if (epoch.status === 3) {
      try {
        const record = await vrf.getRandomness(epoch.seed, "confirmed");
        if (
          record.getVersion() !== "V2" ||
          !Buffer.from(record.getSeed()).equals(epoch.seed) ||
          !record.getClient()?.equals(k.requester)
        )
          throw Error("Wrong provider record identity");
        const entropy = record.getFulfilledRandomness();
        if (entropy !== null && Buffer.from(entropy).length !== 64)
          throw Error("Invalid provider entropy");
        providerStatus = entropy === null ? "pending" : "fulfilled";
      } catch {
        /* A missing/unreadable provider record is not timeout proof. */
      }
    }
    return {
      pool,
      epoch,
      slot: latest.context.slot,
      providerStatus,
      saleDemand,
      requesterLamports,
    };
  }
  async function buildSigned(task, state) {
    if ((await connection.getGenesisHash()) !== expectedGenesis)
      throw Error("Pack operator RPC chain mismatch");
    const expected = nextEpochTask(state);
    if (
      JSON.stringify(expected) !== JSON.stringify(task) ||
      !state.pool.collection.equals(collection)
    )
      throw Error("Operator task no longer matches confirmed state");
    const { pool, epoch } = state,
      k = addresses(program, collection, epoch.id),
      extra = [], prefix = [];
    let instruction;
    switch (task.kind) {
      case "open": {
        const next = addresses(program, collection, pool.epochCount);
        // Recovery and new-window proof share one atomic transaction. A late
        // requester donation cannot strand sponsor funds or race the zero check.
        if(epoch.requested)prefix.push(ix(program,9,[a(keys.pool),a(k.epoch),a(k.requester,true),a(epoch.requestSponsor,true),a(SystemProgram.programId)]));
        instruction = ix(program, 1, [
          a(operator, true, true),
          a(keys.pool, true),
          a(next.epoch, true),
          a(SystemProgram.programId),
          a(k.epoch),
          a(k.requester),
        ]);
        break;
      }
      case "freeze":
        instruction = ix(program, 3, [a(keys.pool), a(k.epoch, true)]);
        break;
      case "request": {
        const live = await vrf.getNetworkState("confirmed"),
          configuration = live.config;
        const fee = BigInt(configuration.requestFee.toString());
        if (
          !configuration.treasury.equals(pool.providerTreasury) ||
          fee < 0n ||
          fee >= BigInt(requestFundingLamports) ||
          !configuration.fulfillmentAuthorities?.length
        )
          throw Error("ORAO configuration differs from the funded pack pool");
        const nonce = randomBytes(32),
          seed = candidateRequestSeed(
            epoch.seed,
            nonce,
            program,
            keys.pool,
            k.epoch,
            k.requester,
          );
        instruction = ix(
          program,
          4,
          [
            a(operator, true, true),
            a(keys.pool),
            a(k.epoch, true),
            a(k.requester, true),
            a(network, true),
            a(pool.providerTreasury, true),
            a(requestAddress(seed), true),
            a(ORAO),
            a(SystemProgram.programId),
          ],
          encodeRequest(requestFundingLamports, nonce),
        );
        break;
      }
      case "capture":
        instruction = ix(program, 5, [
          a(keys.pool),
          a(k.epoch, true),
          a(k.requester),
          a(requestAddress(epoch.seed)),
        ]);
        break;
      case "allocate":
        instruction = ix(
          program,
          6,
          [a(keys.pool, true), a(k.epoch, true)],
          Buffer.from([task.limit]),
        );
        break;
      case "void":
        instruction = ix(program, 8, [
          a(keys.pool),
          a(k.epoch, true),
          a(k.requester),
          a(requestAddress(epoch.seed)),
        ]);
        break;
      case "refund":
        instruction = ix(
          program,
          7,
          [
            a(keys.pool, true),
            a(k.epoch, true),
            a(epoch.tickets[task.ticket].buyer, true),
          ],
          u16(task.ticket),
        );
        break;
      case "sweep":
        instruction=ix(program,9,[a(keys.pool),a(k.epoch),a(k.requester,true),a(epoch.requestSponsor,true),a(SystemProgram.programId)]);
        break;
      case "payout":
        instruction = ix(program, 10, [
          a(keys.pool),
          a(k.epoch, true),
          a(pool.treasury, true),
          a(PLATFORM_TREASURY, true),
        ]);
        break;
      case "claim": {
        const asset = Keypair.generate();
        extra.push(asset);
        instruction = ix(
          program,
          20,
          [
            a(operator, true, true),
            a(keys.pool, true),
            a(k.epoch, true),
            a(epoch.tickets[task.ticket].buyer),
            a(asset.publicKey, true, true),
            a(keys.issuance(asset.publicKey), true),
            a(keys.gearAuthority),
            a(keys.ops, true),
            a(CORE),
            a(SystemProgram.programId),
          ],
          Buffer.concat([u16(task.ticket), Buffer.from([task.pull])]),
        );
        break;
      }
      default:
        throw Error("Unsupported operator task");
    }
    const validity = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({
      feePayer: operator,
      recentBlockhash: validity.blockhash,
    }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1200000 }),
      ...prefix,
      instruction,
    );
    const message = tx.serializeMessage();
    if (extra.length) tx.partialSign(...extra);
    let signed;
    if (typeof signer.signTransaction === "function")
      signed = await signer.signTransaction(tx);
    else {
      tx.partialSign(signer);
      signed = tx;
    }
    if (
      !signer.publicKey.equals(operator) ||
      !signed.serializeMessage().equals(message) ||
      !signed.verifySignatures()
    )
      throw Error("Operator signer changed transaction");
    const bytes = signed.serialize();
    const simulation = await connection.simulateTransaction(
      VersionedTransaction.deserialize(bytes),
      { sigVerify: true, commitment: "confirmed" },
    );
    if (simulation.value.err)
      throw Error(
        "Operator simulation rejected: " + JSON.stringify(simulation.value.err),
      );
    return {
      state: "prepared",
      signature: bs58.encode(signed.signature),
      signedTransaction: bytes.toString("base64"),
      blockhash: validity.blockhash,
      lastValidBlockHeight: validity.lastValidBlockHeight,
    };
  }
  return {
    program,
    collection,
    connection,
    expectedGenesis,
    readState,
    buildSigned,
    requestSaleWindow,
    };
}
