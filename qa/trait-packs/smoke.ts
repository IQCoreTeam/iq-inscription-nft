import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import * as core from "@metaplex-foundation/mpl-core";
import { publicKey } from "@metaplex-foundation/umi";
import {
  inputsFromEnvironment,
  startSyntheticFixture,
  snapshotSource,
  CORE_ID,
  ORAO_ID,
} from "./fixture.mjs";
import { catalogSetup } from "../../extensions/trait-packs/creator/catalog.mjs";
import {
  addresses,
  account,
  instruction,
  readPool,
  readEpoch,
  PLATFORM_TREASURY,
} from "../../extensions/trait-packs/client/protocol.mjs";
import { createPackClient } from "../../extensions/trait-packs/client/market.mjs";
import { createPackOperatorMarket } from "../../extensions/trait-packs/operator/market.mjs";
import { createPackPageStateReader } from "../../extensions/trait-packs/service/pack-state.mjs";
import {
  createPackJobStore,
  runPackJobs,
} from "../../backend/src/pack-jobs.ts";

const inputs = await inputsFromEnvironment(),
  out = new URL("./.evidence/" + Date.now() + "/", import.meta.url);
await mkdir(out, { recursive: true });
const report: any = {
  passed: false,
  scope:
    "Synthetic offline Surfpool; no public writes, input wallets or source artwork",
  inputs: Object.fromEntries(
    Object.entries(inputs).map(([name, value]: any) => [
      name,
      { sha256: value.sha256, bytes: value.bytes },
    ]),
  ),
  scenarios: [],
  sourceHashes: await snapshotSource(),
};
const hash = (bytes: any) => createHash("sha256").update(bytes).digest("hex");
for (const timeout of [false, true]) {
  const f = await startSyntheticFixture(inputs);
  let db: Database | undefined;
  try {
    const count = timeout ? 1 : 9,
      traitMetadata = Buffer.from(
        JSON.stringify({
          name: "Synthetic blue hair",
          image: "http://127.0.0.1/synthetic-trait.png",
          attributes: [
            { trait_type: "Initial supply", value: count * 4 },
            { trait_type: "Creator tier", value: "common" },
          ],
        }),
      );
    const spec = {
      program: f.program,
      collection: f.collection,
      registry: f.registry,
      nftProgram: f.iqId,
      authority: f.creator.publicKey,
      treasury: f.treasury.publicKey,
      provider: new PublicKey(ORAO_ID),
      providerTreasury: f.providerTreasury.publicKey,
      price: 100000000,
      window: 100000,
      timeout: 1000,
      definitions: [
        {
          id: 0,
          name: "Synthetic blue hair",
          slot: 0,
          bodyMask: 1,
          supply: count * 4,
          hash: hash(traitMetadata),
          uri: "http://127.0.0.1/synthetic-trait.json",
          requiredSlot: 255,
          requiredDefinition: 255,
        },
      ],
    };
    const keys = addresses(f.program, f.collection);
    for (const step of catalogSetup(spec, null))
      await f.send("catalog-" + step.stage, [step.instruction]);
    await f.send("creator-funds-operations", [
      SystemProgram.transfer({
        fromPubkey: f.creator.publicKey,
        toPubkey: keys.ops,
        lamports: 2000000000,
      }),
    ]);
    await f.send("initial-sale-window", [
      instruction(f.program, 1, [
        account(f.creator.publicKey, true, true),
        account(keys.pool, true),
        account(keys.epoch, true),
        account(SystemProgram.programId),
      ]),
    ]);
    const genesis = await f.connection.getGenesisHash(),
      pending = new Map();
    const pendingPurchases = {
      load: async (key: string) => pending.get(key),
      save: async (key: string, value: any) => {
        pending.set(key, value);
        await writeFile(
          new URL(
            "buyer-pending-" + (timeout ? "timeout" : "delivery") + ".json",
            out,
          ),
          JSON.stringify([...pending]),
        );
      },
      clear: async (key: string) => {
        pending.delete(key);
      },
    };
    const client = createPackClient({
      connection: f.connection,
      program: f.program,
      collection: f.collection,
      chain: "solana:localnet",
      localGenesis: genesis,
      pendingPurchases,
    });
    const buyerAccount = {
      address: f.buyer.publicKey.toBase58(),
      publicKey: f.buyer.publicKey.toBytes(),
      chains: ["solana:localnet"],
      features: ["solana:signTransaction"],
    };
    const wallet = {
      accounts: [buyerAccount],
      chains: ["solana:localnet"],
      features: {
        "solana:signTransaction": {
          supportedTransactionVersions: ["legacy"],
          async signTransaction({ transaction }: any) {
            const tx = Transaction.from(transaction);
            tx.partialSign(f.buyer);
            return [{ signedTransaction: tx.serialize() }];
          },
        },
      },
    };
    const purchases = [];
    for (let ticket = 0; ticket < count; ticket++)
      purchases.push(
        await client.purchase({
          wallet,
          account: buyerAccount,
          expectedTotal: 105000000,
        }),
      );
    const balance = (key: any) => f.connection.getBalance(key, "confirmed");
    const before = {
      creator: await balance(f.treasury.publicKey),
      iq: await balance(PLATFORM_TREASURY),
      operator: await balance(f.operator.publicKey),
      buyer: await balance(f.buyer.publicKey),
    };
    const market = createPackOperatorMarket({
      connection: f.connection,
      program: f.program,
      collection: f.collection,
      signer: f.operator,
      expectedGenesis: genesis,
      vrf: f.vrf,
      requestFundingLamports: 10000000,
    });
    const markets = new Map([[f.collection.toBase58(), market]]),
      database = new URL(timeout ? "timeout.sqlite" : "delivery.sqlite", out)
        .pathname;
    let lostResponse = false,
      fulfilled = false,
      advanced = false,
      completed = false;
    const originalSend = f.connection.sendRawTransaction.bind(f.connection),
      iterations = [];
    f.connection.sendRawTransaction = async (...args: any[]) => {
      const signature = await originalSend(...args);
      if (!lostResponse) {
        lostResponse = true;
        throw Error("Synthetic lost broadcast response");
      }
      return signature;
    };
    for (let tick = 0; tick < 256; tick++) {
      const state = await market.readState();
      if (state.epoch.status === 3 && state.providerStatus === "pending") {
        if (timeout && !advanced) {
          f.surf.timeTravelToSlot(state.epoch.deadlineSlot + 1);
          advanced = true;
        }
        if (!timeout && !fulfilled) {
          await f.fulfillLocalProvider(state.epoch.seed);
          fulfilled = true;
        }
      }
      db = new Database(database);
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA busy_timeout=5000");
      const store = createPackJobStore(db);
      const iteration = await runPackJobs({
        store,
        markets,
        workerId: "synthetic-restart-" + tick,
        limit: 1,
      });
      iterations.push(iteration);
      for (const item of iteration)
        if (item.signature)
          await f.connection.confirmTransaction(item.signature, "confirmed");
      const pendingJob = store.pending(f.collection.toBase58()),
        jobs = db
          .query(
            "SELECT job_key,state,signature,task_json FROM pack_operator_job ORDER BY created_at,job_key",
          )
          .all() as any[];
      db.close();
      db = undefined;
      const final = await market.readState();
      if (
        !pendingJob &&
        (timeout
          ? final.epoch.status === 5 &&
            final.epoch.tickets.every((ticket: any) => ticket.refunded)
          : final.epoch.status === 6)
      ) {
        assert(jobs.every((job) => job.state === "confirmed"));
        assert.equal(
          new Set(jobs.map((job) => job.signature)).size,
          jobs.length,
        );
        assert.equal(final.requesterLamports, 0);
        assert(final.epoch.requestSponsor.equals(f.operator.publicKey));
        const chain = [];
        let fees = 0,
          surplus = 0;
        for (const job of jobs) {
          const receipt = await f.connection.getTransaction(job.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          assert(receipt && !receipt.meta.err);
          const task = JSON.parse(job.task_json);
          fees += receipt.meta.fee;
          if (task.kind === "sweep") surplus += task.balance;
          chain.push({
            task,
            signature: job.signature,
            slot: receipt.slot,
            fee: receipt.meta.fee,
          });
        }
        const after = {
          creator: await balance(f.treasury.publicKey),
          iq: await balance(PLATFORM_TREASURY),
          operator: await balance(f.operator.publicKey),
          buyer: await balance(f.buyer.publicKey),
        };
        assert.equal(
          after.creator - before.creator,
          timeout ? 0 : count * 100000000,
        );
        assert.equal(after.iq - before.iq, timeout ? 0 : count * 5000000);
        assert.equal(
          after.operator - before.operator,
          -10000000 + surplus - fees,
        );
        if (timeout) assert.equal(after.buyer - before.buyer, 105000000);
        if (!timeout) {
          assert.deepEqual(
            chain
              .filter((row) => row.task.kind === "allocate")
              .map((row) => row.task.cursor),
            [0, 8],
          );
          assert.equal(
            chain.filter((row) => row.task.kind === "claim").length,
            36,
          );
        }
        const reader = createPackPageStateReader({
          connection: f.connection,
          program: f.program,
          collection: f.collection,
          chain: "solana:localnet",
          expectedGenesis: genesis,
          appearance: { title: "Synthetic QA" },
          collectionSlug: "synthetic-qa",
          getAvatar: async (owner: string) =>
            owner === f.buyer.publicKey.toBase58() ? f.avatar.toBase58() : null,
          outfitUrl: (id: string, revision: number) =>
            "http://127.0.0.1/wardrobe/" + id + "?r=" + revision,
          readMetadata: async () => traitMetadata,
          readCoreAssets: async (assetKeys: any[], options: any) => {
            if (!assetKeys.length) return new Map();
            const raw = await f.umi.rpc.getAccounts(
              assetKeys.map((key) => publicKey(key.toBase58())),
              {
                commitment: "confirmed",
                minContextSlot: options.minContextSlot,
              },
            );
            return new Map(
              raw.map((item: any, index: number) => {
                if (!item.exists) return [assetKeys[index].toBase58(), null];
                assert.equal(item.owner, CORE_ID);
                if (item.data.length === 1 && item.data[0] === 0)
                  return [assetKeys[index].toBase58(), null];
                assert(item.data.length > 1 && item.data[0] === 1);
                return [
                  assetKeys[index].toBase58(),
                  core.deserializeAssetV1(item),
                ];
              }),
            );
          },
        });
        const snapshot = await reader.read(f.buyer.publicKey.toBase58());
        assert.equal(snapshot.packs.length, count);
        assert.equal(snapshot.traits.length, timeout ? 0 : 36);
        assert(!("actors" in snapshot));
        if (!timeout)
          assert(
            snapshot.packs.every(
              (pack: any) =>
                pack.status === "settled" && pack.traitAddresses.length === 4,
            ),
          );
        report.scenarios.push({
          name: timeout
            ? "pending provider timeout and full refund"
            : "nine tickets, two allocation prefixes and 36 Core rewards",
          passed: true,
          sqliteReopenedEveryTick: true,
          lostBroadcastResponseRecovered: lostResponse,
          syntheticProviderFulfilled: fulfilled,
          localClockAdvanced: advanced,
          purchases,
          before,
          after,
          operatorSurplusRecovered: surplus,
          requesterBalance: final.requesterLamports,
          chain,
          iterations,
          pageState: {
            packs: snapshot.packs.length,
            traits: snapshot.traits.length,
            noActors: true,
          },
        });
        completed = true;
        break;
      }
      if (["idle", "awaiting-chain-state"].includes(iteration[0].state))
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(completed, "Synthetic bounded operator flow did not complete");
  } finally {
    db?.close();
    f.stop();
  }
}
assert.deepEqual(await snapshotSource(), report.sourceHashes, "Source changed during pack proof");
report.passed = true;
await writeFile(
  new URL("RESULTS.json", out),
  JSON.stringify(report, null, 2) + "\n",
);
console.log("Synthetic offline pack smoke passed: " + out.pathname);
