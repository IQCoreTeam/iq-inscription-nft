import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  readTensorListings,
  tensorListingInstruction,
  tensorCancelInstruction,
  tensorPurchaseInstructions,
  TENSOR_PROGRAM,
} from "../../extensions/trait-packs/client/tensor-market.mjs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import * as core from "@metaplex-foundation/mpl-core";
import { publicKey, createNoopSigner } from "@metaplex-foundation/umi";
import { toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import {
  inputsFromEnvironment,
  startSyntheticFixture,
  snapshotSource,
  ORAO_ID,
} from "./fixture.mjs";
import { publishPackSetup } from "../../extensions/trait-packs/client/creator.mjs";
import { catalogSetup } from "../../extensions/trait-packs/creator/catalog.mjs";
import {
  addresses,
  account,
  instruction,
  readPool,
  u64,
  readEpoch,
} from "../../extensions/trait-packs/client/protocol.mjs";
import {
  sealedAddresses,
  buySealedPack,
  openSealedPack,
  readSealedRelease,
  readSealedPack,
} from "../../extensions/trait-packs/client/sealed.mjs";
import { createPackOperatorMarket } from "../../extensions/trait-packs/operator/market.mjs";
import {
  createPackJobStore,
  runPackJobs,
} from "../../backend/src/pack-jobs.ts";
const inputs = await inputsFromEnvironment(),
  out = new URL("./.evidence/sealed-" + Date.now() + "/", import.meta.url);
await mkdir(out, { recursive: true });
const report: any = {
  passed: false,
  scope: "offline Surfpool generated actors; simulated ORAO; no public writes",
  cases: [],
  inputs: Object.fromEntries(
    Object.entries(inputs).map(([name, value]: any) => [
      name,
      { sha256: value.sha256, bytes: value.bytes },
    ]),
  ),
  sourceHashes: await snapshotSource(),
};
for (const timeout of [false, true]) {
  const f = await startSyntheticFixture(inputs),
    second = Keypair.generate();
  f.surf.fundSol(second.publicKey.toBase58(), 50000000000);
  const buyerSigner = createNoopSigner(publicKey(f.buyer.publicKey.toBase58()));
  const originalSend = f.send;
  f.send = async (label: any, ...rest: any[]) => {
    console.log(label);
    return originalSend(label, ...rest);
  };
  let packs: { publicKey: PublicKey };
  const k = sealedAddresses(f.program, f.collection),
    ep = addresses(f.program, f.collection);
  const readRelease = async () =>
    readSealedRelease((await f.connection.getAccountInfo(k.release))!.data);
  const receipt = async (asset: PublicKey) =>
    readSealedPack(
      (await f.connection.getAccountInfo(
        sealedAddresses(f.program, f.collection, asset).receipt!,
      ))!.data,
    );
  let db: any;
  async function reject(label: string, ix: any, signers: any[]) {
    let failed = false;
    try {
      await f.send(label, [ix], signers);
    } catch {
      failed = true;
    }
    assert(failed, label + " must reject");
    report.cases.push(label);
  }
  try {
    const binary = process.env.IQ_QA_TENSOR_BINARY;
    assert(binary);
    assert.equal(
      createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
      process.env.IQ_QA_TENSOR_SHA256,
    );
    f.surf.deploy({ programId: TENSOR_PROGRAM.toBase58(), soPath: binary });
    const meta = Buffer.from("{}");
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
          name: "Test hat",
          slot: 0,
          bodyMask: 1,
          supply: 8,
          hash: createHash("sha256").update(meta).digest("hex"),
          uri: "http://127.0.0.1/trait.json",
          requiredSlot: 255,
          requiredDefinition: 255,
        },
      ],
    };
    for (const step of catalogSetup(spec, null))
      await f.send("catalog-" + step.stage, [step.instruction]);
    await f.send("fund-operations", [
      SystemProgram.transfer({
        fromPubkey: f.creator.publicKey,
        toPubkey: k.ops,
        lamports: 2000000000,
      }),
    ]);
    const pending = new Map(),
      accountCreator = {
        address: f.creator.publicKey.toBase58(),
        publicKey: f.creator.publicKey.toBytes(),
        chains: ["solana:localnet"],
        features: ["solana:signTransaction"],
      };
    const walletCreator = {
      accounts: [accountCreator],
      chains: accountCreator.chains,
      features: {
        "solana:signTransaction": {
          supportedTransactionVersions: ["legacy"],
          signTransaction: async ({ transaction }: any) => {
            const tx = Transaction.from(transaction);
            tx.partialSign(f.creator);
            return [{ signedTransaction: tx.serialize() }];
          },
        },
      },
    };
    const setup = {
      spec,
      collection: f.collection.toBase58(),
      cost: { operationsReserveTargetLamports: 148000000 },
    };
    const creatorReceipts = await publishPackSetup({
      connection: f.connection,
      wallet: walletCreator,
      account: accountCreator,
      chain: "solana:localnet",
      localGenesis: await f.connection.getGenesisHash(),
      setup,
      expectedCollection: f.collection.toBase58(),
      deployment: {
        program: f.program.toBase58(),
        nftProgram: f.iqId.toBase58(),
        provider: ORAO_ID,
        providerTreasury: f.providerTreasury.publicKey.toBase58(),
      },
      operationsReserveLamports: 148000000,
      sealedRelease: {
        supply: 2,
        name: "Local sealed pack",
        uri: "http://127.0.0.1/pack.json",
      },
      pendingTransactions: {
        load: async (key) => pending.get(key),
        save: async (key, value) => pending.set(key, value),
        clear: async (key) => pending.delete(key),
      },
    });
    assert.equal(pending.size, 0);
    packs = { publicKey: (await readRelease()).packCollection };
    report.cases.push({ creatorWalletSetup: true, receipts: creatorReceipts });
    const assets = [Keypair.generate(), Keypair.generate()];
    const beforeBuys = await f.connection.getBalance(f.buyer.publicKey);
    for (let i = 0; i < 2; i++)
      await f.send(
        "buy-sealed-" + i,
        [
          buySealedPack({
            program: f.program,
            collection: f.collection,
            buyer: f.buyer.publicKey,
            packCollection: packs.publicKey,
            asset: assets[i].publicKey,
            serial: i,
            expectedTotal: 105000000,
          }),
        ],
        [f.buyer, assets[i]],
      );
    const afterBuys = await f.connection.getBalance(f.buyer.publicKey);
    report.cases.push({
      measurement: "two sealed purchases",
      totalLamports: beforeBuys - afterBuys,
      prepaidPriceLamports: 210000000,
      rentAndNetworkLamports: beforeBuys - afterBuys - 210000000,
    });
    const buyerEscrow = await f.connection.getBalance(
      sealedAddresses(f.program, f.collection, assets[0].publicKey).receipt!,
    );
    assert.ok(buyerEscrow >= 105000000);
    await reject(
      "unopened-reserve-withdrawal-blocked",
      instruction(
        f.program,
        13,
        [
          account(f.creator.publicKey, false, true),
          account(k.pool, true),
          account(k.ops, true),
          account(f.treasury.publicKey, true),
          account(SystemProgram.programId),
        ],
        u64(2000000000),
      ),
      [f.creator],
    );
    await reject(
      "retirement-with-unopened-packs-blocked",
      instruction(f.program, 14, [
        account(f.creator.publicKey, false, true),
        account(k.pool, true),
      ]),
      [f.creator],
    );
    assert.equal((await readRelease()).sealed, 2);
    assert.equal(
      readPool((await f.connection.getAccountInfo(k.pool))!.data)
        .outstandingTraits,
      8,
    );
    const extra = Keypair.generate();
    await reject(
      "supply-cap",
      buySealedPack({
        program: f.program,
        collection: f.collection,
        buyer: f.buyer.publicKey,
        packCollection: packs.publicKey,
        asset: extra.publicKey,
        serial: 2,
        expectedTotal: 105000000,
      }),
      [f.buyer, extra],
    );
    const asset = assets[0].publicKey,
      packReceipt = sealedAddresses(f.program, f.collection, asset).receipt!;
    const burner = core
      .burnV1(f.umi, {
        asset: publicKey(asset.toBase58()),
        collection: publicKey(packs.publicKey.toBase58()),
        authority: buyerSigner,
        payer: buyerSigner,
      })
      .getInstructions()
      .map(toWeb3JsInstruction)[0];
    burner.keys.push(account(packReceipt));
    await reject("external-burn-blocked", burner, [f.buyer]);
    const resale = 200000000n;
    await f.send(
      "tensor-list-sealed",
      [
        await tensorListingInstruction({
          asset,
          collection: packs.publicKey,
          seller: f.buyer.publicKey,
          price: resale,
          expiresInSeconds: 3600,
        }),
      ],
      [f.buyer],
    );
    await reject(
      "listed-pack-cannot-open",
      openSealedPack({
        program: f.program,
        collection: f.collection,
        holder: f.buyer.publicKey,
        packCollection: packs.publicKey,
        asset,
        epoch: 0,
        ticket: 0,
        expectedTotal: 105000000,
      }),
      [f.buyer],
    );
    let listing = (await readTensorListings(f.connection, [asset]))[0];
    assert(listing.supported);
    assert.equal(listing.price, resale);
    await f.send(
      "tensor-cancel-sealed",
      [
        await tensorCancelInstruction({
          listing,
          collection: packs.publicKey,
          seller: f.buyer.publicKey,
        }),
      ],
      [f.buyer],
    );
    assert.equal(
      (await core.fetchAsset(f.umi, publicKey(asset.toBase58()))).owner,
      f.buyer.publicKey.toBase58(),
    );
    await f.send(
      "tensor-relist-sealed",
      [
        await tensorListingInstruction({
          asset,
          collection: packs.publicKey,
          seller: f.buyer.publicKey,
          price: resale,
          expiresInSeconds: 3600,
        }),
      ],
      [f.buyer],
    );
    listing = (await readTensorListings(f.connection, [asset]))[0];
    const { findFeeVaultPda } = createRequire(
      new URL(
        "../../extensions/trait-packs/client/package.json",
        import.meta.url,
      ),
    )("@tensor-foundation/marketplace");
    const [feeVault] = await findFeeVaultPda({ address: listing.address });
    f.surf.fundSol(feeVault, 1000000);
    const sellerBefore = await f.connection.getBalance(f.buyer.publicKey);
    await f.send(
      "tensor-buy-sealed",
      await tensorPurchaseInstructions({
        listing,
        collection: packs.publicKey,
        buyer: second.publicKey,
        creators: [],
        maximumAmount: resale,
      }),
      [second],
    );
    assert.equal(
      (await core.fetchAsset(f.umi, publicKey(asset.toBase58()))).owner,
      second.publicKey.toBase58(),
    );
    assert.ok(
      (await f.connection.getBalance(f.buyer.publicKey)) >=
        sellerBefore + Number(resale),
    );
    report.cases.push(
      "real Tensor listing, cancellation, relisting and independent-price purchase transfer unopened pack",
    );
    const open = (holder: PublicKey) =>
      openSealedPack({
        program: f.program,
        collection: f.collection,
        holder,
        packCollection: packs.publicKey,
        asset,
        epoch: 0,
        ticket: 0,
        expectedTotal: 105000000,
      });
    await reject("old-owner-open-blocked", open(f.buyer.publicKey), [f.buyer]);
    await reject(
      "direct-ticket-bypass-blocked",
      instruction(
        f.program,
        2,
        [
          account(second.publicKey, true, true),
          account(k.pool, true),
          account(ep.epoch, true),
          account(k.ops, true),
          account(SystemProgram.programId),
        ],
        Buffer.concat([Buffer.from([0, 0]), u64(105000000)]),
      ),
      [second],
    );
    const wrong = open(second.publicKey);
    wrong.data.writeBigUInt64LE(104000000n, 3);
    await reject("wrong-price-does-not-burn", wrong, [second]);
    assert.equal((await receipt(asset)).opened, false);
    const wrongTicket = open(second.publicKey);
    wrongTicket.data.writeUInt16LE(1, 1);
    const escrowBefore = await f.connection.getBalance(packReceipt);
    await reject("admission-failure-rolls-back-burn-and-escrow", wrongTicket, [
      second,
    ]);
    assert.equal((await receipt(asset)).opened, false);
    assert.equal(
      (await core.fetchAsset(f.umi, publicKey(asset.toBase58()))).owner,
      second.publicKey.toBase58(),
    );
    assert.equal(await f.connection.getBalance(packReceipt), escrowBefore);
    await f.send("open-current-holder", [open(second.publicKey)], [second]);
    assert.equal(
      (await receipt(asset)).opener.toBase58(),
      second.publicKey.toBase58(),
    );
    assert.equal((await receipt(asset)).opened, true);
    assert.equal((await readRelease()).sealed, 1);
    assert.equal((await f.connection.getAccountInfo(asset))!.data[0], 0);
    assert.equal(
      readPool((await f.connection.getAccountInfo(k.pool))!.data)
        .outstandingTraits,
      8,
    );
    await reject("double-open-blocked", open(second.publicKey), [second]);
    const market = createPackOperatorMarket({
      connection: f.connection,
      program: f.program,
      collection: f.collection,
      signer: f.operator,
      expectedGenesis: await f.connection.getGenesisHash(),
      vrf: f.vrf,
      requestFundingLamports: 10000000,
    });
    db = new Database(
      new URL(timeout ? "timeout.sqlite" : "delivery.sqlite", out).pathname,
    );
    const store = createPackJobStore(db),
      markets = new Map([[f.collection.toBase58(), market]]);
    f.surf.timeTravelToSlot((await market.readState()).epoch.closeSlot + 1);
    let fulfilled = false,
      complete = false;
    const openerBefore = await f.connection.getBalance(second.publicKey),
      treasuryBefore = await f.connection.getBalance(f.treasury.publicKey),
      iqTreasury = new PublicKey(
        "EWNSTD8tikwqHMcRNuuNbZrnYJUiJdKq9UXLXSEU4wZ1",
      ),
      iqBefore = await f.connection.getBalance(iqTreasury);
    for (let i = 0; i < 100; i++) {
      const s = await market.readState();
      if (s.epoch.status === 3 && !fulfilled) {
        if (timeout) f.surf.timeTravelToSlot(s.epoch.deadlineSlot + 1);
        else await f.fulfillLocalProvider(s.epoch.seed);
        fulfilled = true;
      }
      await runPackJobs({ store, markets, workerId: "sealed-" + i, limit: 1 });
      const latest = await market.readState();
      if (
        timeout
          ? latest.epoch.status === 5 && latest.epoch.tickets[0].refunded
          : latest.epoch.status === 6
      ) {
        complete = true;
        break;
      }
    }
    assert(complete, "settlement must complete");
    if (timeout) {
      assert.equal(
        await f.connection.getBalance(second.publicKey),
        openerBefore + 105000000,
      );
      report.cases.push(
        "timeout refunds prepaid price to opener after resale; pack remains consumed",
      );
    } else {
      assert.equal(
        await f.connection.getBalance(f.treasury.publicKey),
        treasuryBefore + 100000000,
      );
      assert.equal(
        await f.connection.getBalance(iqTreasury),
        iqBefore + 5000000,
      );
      const e = readEpoch((await f.connection.getAccountInfo(ep.epoch))!.data);
      assert.equal(e.tickets[0].buyer.toBase58(), second.publicKey.toBase58());
      const issued = await f.connection.getProgramAccounts(f.program, {
        filters: [
          { dataSize: 140 },
          { memcmp: { offset: 8, bytes: k.pool.toBase58() } },
        ],
      });
      assert.equal(issued.length, 4);
      for (const row of issued) {
        const pk = new PublicKey(row.account.data.subarray(76, 108)),
          actual = await core.fetchAsset(f.umi, publicKey(pk.toBase58()));
        assert.equal(actual.owner, second.publicKey.toBase58());
      }
      report.cases.push(
        "all four actual Core trait NFTs delivered to current holder, not original buyer",
      );
    }
    assert.equal(
      readPool((await f.connection.getAccountInfo(k.pool))!.data)
        .outstandingTraits,
      4,
      "the unopened second pack retains its operations reserve",
    );
    report.cases.push({
      timeout,
      release: await readRelease(),
      receipts: f.receipts,
    });
  } finally {
    db?.close();
    f.stop();
  }
}
report.passed = true;
await writeFile(new URL("RESULTS.json", out), JSON.stringify(report, null, 2));
console.log("PASS", new URL("RESULTS.json", out).pathname);
