// Program tests for iq-inscription-nft, ported from bible-nft's registrar test
// table. Runs against a localnet started by `anchor test` with mpl-core and the
// platform treasury cloned from mainnet (Anchor.toml). Plain asserts, no
// framework: each row prints one line, any throw fails the run.

import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity, publicKey as umiPk, generateSigner } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair, toWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import {
  createCollection,
  createCollectionV2,
  createV2,
  fetchAssetV1,
  fetchCollection,
  fetchCollectionV1,
  ruleSet,
} from "@metaplex-foundation/mpl-core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- harness ----------

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const connection = provider.connection;
const idl = JSON.parse(readFileSync(join(ROOT, "target/idl/iq_inscription_nft.json"), "utf8"));
const program = new anchor.Program(idl, provider);
const PROGRAM_ID: PublicKey = program.programId;
const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const PLATFORM_TREASURY = new PublicKey("EWNSTD8tikwqHMcRNuuNbZrnYJUiJdKq9UXLXSEU4wZ1");
const PLATFORM_FEE_BPS = 500;
const MAX_SUPPLY = 20;
const URI = "https://gateway.iqlabs.dev/nft/" + "M".repeat(88); // 119 bytes, the real shape
const URI_MAX = "u".repeat(160);

const adminKp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET!, "utf8")))
);
const registrarKp = Keypair.generate();
const registrar2Kp = Keypair.generate();
const minterKp = Keypair.generate(); // the user's burner: fee payer
const ownerKp = Keypair.generate(); // the user's wallet: receives the asset
const attackerKp = Keypair.generate();
const treasuryPk = Keypair.generate().publicKey;

const umi = createUmi(connection.rpcEndpoint, { commitment: "confirmed" }).use(
  keypairIdentity(fromWeb3JsKeypair(adminKp))
);
const collectionSigner = generateSigner(umi);
const collectionPk = toWeb3JsPublicKey(collectionSigner.publicKey);

const registryOf = (collection: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("registry"), collection.toBuffer()], PROGRAM_ID)[0];
const authOf = (registry: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("collection-auth"), registry.toBuffer()], PROGRAM_ID)[0];
const registryPda = registryOf(collectionPk);
const collectionAuthPda = authOf(registryPda);
const itemSlotPda = (index: number, registry = registryPda) => {
  const le = Buffer.alloc(4);
  le.writeUInt32LE(index);
  return PublicKey.findProgramAddressSync([Buffer.from("item"), registry.toBuffer(), le], PROGRAM_ID)[0];
};
const inscriptionPda = (sig: number[]) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("inscription"), Buffer.from(sig.slice(0, 32)), Buffer.from(sig.slice(32))],
    PROGRAM_ID
  )[0];
// Deterministic fake 64-byte signatures, distinct per seed.
const sigOf = (seed: number) => Array.from({ length: 64 }, (_, i) => (seed * 7 + i) % 256);
const hashOf = (seed: number) => Array.from({ length: 32 }, (_, i) => (seed * 3 + i) % 256);
const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

let passed = 0;
async function test(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok ${label}`);
  } catch (e) {
    console.error(`FAIL ${label}`);
    throw e;
  }
}

async function expectFail(p: Promise<unknown>, needle: string, label: string) {
  try {
    await p;
  } catch (e: any) {
    const text = `${e}${e?.logs ? "\n" + e.logs.join("\n") : ""}`;
    assert.ok(
      text.includes(needle),
      `${label}: failed for the wrong reason.\nwanted: ${needle}\ngot: ${text.slice(0, 1200)}`
    );
    return;
  }
  assert.fail(`${label}: expected failure, but it succeeded`);
}

type ItemOpts = {
  index: number;
  asset: PublicKey;
  registry?: PublicKey;
  collection?: PublicKey;
  minter?: PublicKey;
  owner?: PublicKey;
  registrar?: PublicKey;
  treasury?: PublicKey;
  platformTreasury?: PublicKey;
  name?: string;
  uri?: string;
  contentHash?: number[];
  inscriptionSig?: number[];
  metaSig?: number[];
};

function registerItemIx(o: ItemOpts): Promise<TransactionInstruction> {
  const registry = o.registry ?? registryPda;
  const sig = o.inscriptionSig ?? sigOf(o.index);
  return program.methods
    .registerItem(o.index, o.contentHash ?? hashOf(o.index), sig, o.metaSig ?? sigOf(1000 + o.index), o.name ?? `Item #${o.index}`, o.uri ?? URI)
    .accountsStrict({
      minter: o.minter ?? minterKp.publicKey,
      owner: o.owner ?? ownerKp.publicKey,
      registrar: o.registrar ?? registrarKp.publicKey,
      registry,
      itemSlot: itemSlotPda(o.index, registry),
      inscriptionRecord: inscriptionPda(sig),
      collection: o.collection ?? collectionPk,
      collectionAuth: authOf(registry),
      treasury: o.treasury ?? treasuryPk,
      platformTreasury: o.platformTreasury ?? PLATFORM_TREASURY,
      asset: o.asset,
      mplCoreProgram: MPL_CORE,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

// Build, sign and send the way production will: the burner is the fee payer, the
// registrar co-signs, the asset is an ephemeral keypair. Plain legacy tx.
async function send(
  ix: TransactionInstruction,
  o: { minterKp?: Keypair; registrarKp?: Keypair; stripRegistrarSigner?: boolean; extraIxs?: TransactionInstruction[] },
  assetKp: Keypair
): Promise<{ sig: string; size: number }> {
  if (o.stripRegistrarSigner) {
    const meta = ix.keys.find((k) => k.pubkey.equals(o.registrarKp?.publicKey ?? registrarKp.publicKey));
    meta!.isSigner = false;
  }
  const payer = o.minterKp ?? minterKp;
  const tx = new Transaction().add(...(o.extraIxs ?? []), ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const signers = [payer, assetKp];
  if (!o.stripRegistrarSigner) signers.push(o.registrarKp ?? registrarKp);
  tx.sign(...signers);
  const raw = tx.serialize();
  const sig = await connection.sendRawTransaction(raw, { skipPreflight: false });
  await connection.confirmTransaction(sig, "confirmed");
  return { sig, size: raw.length };
}

const sendItem = (o: ItemOpts & Parameters<typeof send>[1], assetKp: Keypair) =>
  registerItemIx({ ...o, asset: assetKp.publicKey }).then((ix) => send(ix, o, assetKp));

const lamports = (pk: PublicKey) => connection.getBalance(pk, "confirmed");

async function waitAssetUri(pubkey: PublicKey, want: string, tries = 12): Promise<string> {
  let uri = "";
  for (let i = 0; i < tries; i++) {
    uri = (await fetchAssetV1(umi, umiPk(pubkey.toBase58()))).uri;
    if (uri === want) return uri;
    await new Promise((r) => setTimeout(r, 400));
  }
  return uri;
}

function initIx(o: {
  collection: PublicKey;
  maxSupply: number;
  price?: number;
  deposit?: number;
  admin?: PublicKey;
  registrar?: PublicKey;
}) {
  const registry = registryOf(o.collection);
  return program.methods
    .initializeRegistry(
      o.maxSupply,
      hashOf(99),
      sigOf(99),
      Array.from({ length: 32 }, () => 7), // shuffle commit, opaque to the program
      o.registrar ?? registrarKp.publicKey,
      o.admin ?? adminKp.publicKey,
      new BN(o.price ?? 0),
      new BN(o.deposit ?? 0),
      treasuryPk
    )
    .accountsStrict({
      payer: adminKp.publicKey,
      collection: o.collection,
      registry,
      collectionAuth: authOf(registry),
      systemProgram: SystemProgram.programId,
    });
}

async function newCollection(name: string, withRoyalties = true) {
  const signer = generateSigner(umi);
  const pk = toWeb3JsPublicKey(signer.publicKey);
  await createCollection(umi, {
    collection: signer,
    updateAuthority: umiPk(authOf(registryOf(pk)).toBase58()),
    name,
    uri: URI,
    plugins: withRoyalties
      ? [
          {
            type: "Royalties",
            basisPoints: 500,
            creators: [{ address: umiPk(adminKp.publicKey.toBase58()), percentage: 100 }],
            ruleSet: ruleSet("None"),
          },
        ]
      : [],
  }).sendAndConfirm(umi);
  return pk;
}

// ---------- run ----------

async function main() {
  console.log(`localnet ${connection.rpcEndpoint}, program ${PROGRAM_ID.toBase58()}`);

  for (const kp of [minterKp, attackerKp, registrarKp]) {
    const sig = await connection.requestAirdrop(kp.publicKey, 10_000_000_000);
    await connection.confirmTransaction(sig, "confirmed");
  }
  if ((await lamports(adminKp.publicKey)) < 2_000_000_000) {
    const sig = await connection.requestAirdrop(adminKp.publicKey, 10_000_000_000);
    await connection.confirmTransaction(sig, "confirmed");
  }

  // -- setup: collection born under the program PDA, Royalties plugin on it --
  await createCollection(umi, {
    collection: collectionSigner,
    updateAuthority: umiPk(collectionAuthPda.toBase58()),
    name: "Pixel Monks",
    uri: URI,
    plugins: [
      {
        type: "Royalties",
        basisPoints: 500,
        creators: [{ address: umiPk(adminKp.publicKey.toBase58()), percentage: 100 }],
        ruleSet: ruleSet("None"),
      },
    ],
  }).sendAndConfirm(umi);

  await test("initialize_registry accepts a PDA-owned collection and records every field", async () => {
    await initIx({ collection: collectionPk, maxSupply: MAX_SUPPLY }).rpc();
    const reg: any = await (program.account as any).registry.fetch(registryPda);
    assert.equal(reg.maxSupply, MAX_SUPPLY);
    assert.equal(reg.minted, 0);
    assert.equal(reg.frozen, false);
    assert.equal(reg.admin.toBase58(), adminKp.publicKey.toBase58());
    assert.equal(reg.registrar.toBase58(), registrarKp.publicKey.toBase58());
    assert.deepEqual(Array.from(reg.manifestHash), hashOf(99));
    assert.deepEqual(Array.from(reg.manifestSig), sigOf(99));
  });

  await test("initialize_registry rejects deposit over price", async () => {
    const pk = await newCollection("Bad deposit", false);
    await expectFail(initIx({ collection: pk, maxSupply: 5, price: 10, deposit: 11 }).rpc(), "DepositOverPrice", "deposit > price");
  });

  await test("initialize_registry rejects a collection not under the program PDA", async () => {
    const rogue = generateSigner(umi);
    await createCollectionV2(umi, { collection: rogue, name: "Rogue", uri: URI }).sendAndConfirm(umi);
    await expectFail(
      initIx({ collection: toWeb3JsPublicKey(rogue.publicKey), maxSupply: 5 }).rpc(),
      "CollectionNotUnderProgramAuthority",
      "rogue collection"
    );
  });

  // -- happy path: price 0, owner is not the payer --
  const asset1 = Keypair.generate();
  await test("register_item: asset to owner, slot + inscription record populated, 4 attributes, registrar pays nothing", async () => {
    const before = {
      registrar: await lamports(registrarKp.publicKey),
      minter: await lamports(minterKp.publicKey),
      treasury: await lamports(treasuryPk),
      platform: await lamports(PLATFORM_TREASURY),
    };
    await sendItem({ index: 1, asset: asset1.publicKey }, asset1);
    const after = {
      registrar: await lamports(registrarKp.publicKey),
      minter: await lamports(minterKp.publicKey),
      treasury: await lamports(treasuryPk),
      platform: await lamports(PLATFORM_TREASURY),
    };
    assert.equal(after.registrar - before.registrar, 0, "registrar must not fund mints");
    assert.equal(after.treasury - before.treasury, 0, "price 0 moves nothing");
    assert.equal(after.platform - before.platform, 0, "fee on price 0 is 0");
    assert.ok(before.minter - after.minter > 0, "the burner pays fees and rent");

    const slot: any = await (program.account as any).itemSlot.fetch(itemSlotPda(1));
    assert.equal(slot.index, 1);
    assert.equal(slot.registry.toBase58(), registryPda.toBase58());
    assert.equal(slot.owner.toBase58(), ownerKp.publicKey.toBase58());
    assert.equal(slot.asset.toBase58(), asset1.publicKey.toBase58());
    assert.deepEqual(Array.from(slot.contentHash), hashOf(1));
    assert.deepEqual(Array.from(slot.inscriptionSig), sigOf(1));
    assert.deepEqual(Array.from(slot.metaSig), sigOf(1001));

    const rec: any = await (program.account as any).inscriptionRecord.fetch(inscriptionPda(sigOf(1)));
    assert.equal(rec.asset.toBase58(), asset1.publicKey.toBase58());
    assert.equal(rec.collection.toBase58(), collectionPk.toBase58());

    const asset = await fetchAssetV1(umi, umiPk(asset1.publicKey.toBase58()));
    assert.equal(asset.owner.toString(), ownerKp.publicKey.toBase58(), "owner is the user wallet, not the burner");
    assert.equal(asset.updateAuthority.type, "Collection");
    assert.equal(asset.updateAuthority.address?.toString(), collectionPk.toBase58());
    assert.equal(asset.name, "Item #1");
    assert.equal(asset.uri, URI);
    const list = (asset as any).attributes?.attributeList ?? [];
    assert.deepEqual(
      list.map((a: any) => [a.key, a.value]),
      [
        ["index", "1"],
        ["inscription", hex(sigOf(1))],
        ["metadata", hex(sigOf(1001))],
        ["std", "iqnft-0.1"],
      ]
    );
    const reg: any = await (program.account as any).registry.fetch(registryPda);
    assert.equal(reg.minted, 1);
  });

  await test("duplicate index fails (slot already in use)", async () => {
    await expectFail(sendItem({ index: 1, asset: PublicKey.default, inscriptionSig: sigOf(500) }, Keypair.generate()), "already in use", "index 1 twice");
  });

  await test("duplicate inscription fails on a fresh index (one NFT per inscription)", async () => {
    await expectFail(sendItem({ index: 2, asset: PublicKey.default, inscriptionSig: sigOf(1) }, Keypair.generate()), "already in use", "sig of item 1 again");
  });

  await test("duplicate index inside one transaction fails and rolls back", async () => {
    const a = Keypair.generate();
    const b = Keypair.generate();
    // Short name/uri so two full instructions fit one legacy tx; the point is the rollback.
    const first = await registerItemIx({ index: 2, asset: a.publicKey, name: "a", uri: "u" });
    const second = await registerItemIx({ index: 2, asset: b.publicKey, inscriptionSig: sigOf(501), name: "b", uri: "u" });
    const tx = new Transaction().add(first, second);
    tx.feePayer = minterKp.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(minterKp, a, b, registrarKp);
    await expectFail(connection.sendRawTransaction(tx.serialize()), "already in use", "double in one tx");
    assert.equal(await connection.getAccountInfo(itemSlotPda(2)), null, "rolled back");
  });

  await test("wrong registrar signer rejected", async () => {
    await expectFail(
      sendItem({ index: 2, asset: PublicKey.default, registrar: registrar2Kp.publicKey, registrarKp: registrar2Kp }, Keypair.generate()),
      "UnauthorizedRegistrar",
      "registrar2 before rotation"
    );
  });

  await test("missing registrar signature rejected", async () => {
    await expectFail(sendItem({ index: 2, asset: PublicKey.default, stripRegistrarSigner: true }, Keypair.generate()), "AccountNotSigner", "no registrar sig");
  });

  await test("index 0 and max_supply+1 rejected", async () => {
    await expectFail(sendItem({ index: 0, asset: PublicKey.default }, Keypair.generate()), "IndexOutOfRange", "index 0");
    await expectFail(sendItem({ index: MAX_SUPPLY + 1, asset: PublicKey.default }, Keypair.generate()), "IndexOutOfRange", "index max+1");
  });

  await test("frozen registry rejects mints, unfreeze restores", async () => {
    await program.methods.setFrozen(true).accountsStrict({ admin: adminKp.publicKey, registry: registryPda }).rpc();
    await expectFail(sendItem({ index: 2, asset: PublicKey.default }, Keypair.generate()), "Frozen", "frozen mint");
    await program.methods.setFrozen(false).accountsStrict({ admin: adminKp.publicKey, registry: registryPda }).rpc();
    await sendItem({ index: 2, asset: PublicKey.default }, Keypair.generate());
  });

  await test("rotate_registrar: old key rejected, new key accepted", async () => {
    await program.methods.rotateRegistrar(registrar2Kp.publicKey).accountsStrict({ admin: adminKp.publicKey, registry: registryPda }).rpc();
    await expectFail(sendItem({ index: 4, asset: PublicKey.default }, Keypair.generate()), "UnauthorizedRegistrar", "old registrar");
    await sendItem({ index: 4, asset: PublicKey.default, registrar: registrar2Kp.publicKey, registrarKp: registrar2Kp }, Keypair.generate());
    await program.methods.rotateRegistrar(registrarKp.publicKey).accountsStrict({ admin: adminKp.publicKey, registry: registryPda }).rpc();
  });

  await test("admin instructions reject a non-admin", async () => {
    const acc = { admin: attackerKp.publicKey, registry: registryPda };
    await expectFail(program.methods.setFrozen(true).accountsStrict(acc).signers([attackerKp]).rpc(), "UnauthorizedAdmin", "attacker set_frozen");
    await expectFail(program.methods.rotateRegistrar(attackerKp.publicKey).accountsStrict(acc).signers([attackerKp]).rpc(), "UnauthorizedAdmin", "attacker rotate");
    await expectFail(program.methods.setPrice(new BN(1), new BN(0), attackerKp.publicKey).accountsStrict(acc).signers([attackerKp]).rpc(), "UnauthorizedAdmin", "attacker set_price");
  });

  await test("no external key can create an asset into the collection", async () => {
    const umiAttacker = createUmi(connection.rpcEndpoint, { commitment: "confirmed" }).use(keypairIdentity(fromWeb3JsKeypair(attackerKp)));
    await expectFail(
      createV2(umiAttacker, { asset: generateSigner(umiAttacker), collection: { publicKey: umiPk(collectionPk.toBase58()) } as any, name: "forged", uri: URI }).sendAndConfirm(umiAttacker),
      "0x1a",
      "forged membership"
    );
  });

  await test("set_price: price minus deposit to the creator, 5% of price to the platform, wrong treasuries rejected", async () => {
    const PRICE = 50_000_000;
    const DEPOSIT = 10_000_000;
    await expectFail(
      program.methods.setPrice(new BN(PRICE), new BN(PRICE + 1), treasuryPk).accountsStrict({ admin: adminKp.publicKey, registry: registryPda }).rpc(),
      "DepositOverPrice",
      "deposit > price via set_price"
    );
    await program.methods.setPrice(new BN(PRICE), new BN(DEPOSIT), treasuryPk).accountsStrict({ admin: adminKp.publicKey, registry: registryPda }).rpc();

    await expectFail(sendItem({ index: 5, asset: PublicKey.default, treasury: attackerKp.publicKey }, Keypair.generate()), "WrongTreasury", "treasury swap");
    await expectFail(sendItem({ index: 5, asset: PublicKey.default, platformTreasury: attackerKp.publicKey }, Keypair.generate()), "WrongPlatformTreasury", "platform treasury swap");

    const before = { treasury: await lamports(treasuryPk), platform: await lamports(PLATFORM_TREASURY), minter: await lamports(minterKp.publicKey) };
    await sendItem({ index: 5, asset: PublicKey.default }, Keypair.generate());
    const after = { treasury: await lamports(treasuryPk), platform: await lamports(PLATFORM_TREASURY), minter: await lamports(minterKp.publicKey) };
    const fee = (PRICE * PLATFORM_FEE_BPS) / 10_000;
    assert.equal(after.treasury - before.treasury, PRICE - DEPOSIT, "creator gets price minus deposit");
    assert.equal(after.platform - before.platform, fee, "platform gets bps of the full price");
    assert.ok(before.minter - after.minter >= PRICE - DEPOSIT + fee, "minter paid both");

    await program.methods.setPrice(new BN(0), new BN(0), treasuryPk).accountsStrict({ admin: adminKp.publicKey, registry: registryPda }).rpc();
    const b2 = await lamports(treasuryPk);
    await sendItem({ index: 6, asset: PublicKey.default }, Keypair.generate());
    assert.equal(await lamports(treasuryPk), b2, "price back to 0 moves nothing");
  });

  await test("name over 80 bytes and uri over 160 bytes rejected", async () => {
    await expectFail(sendItem({ index: 7, asset: PublicKey.default, name: "n".repeat(81) }, Keypair.generate()), "NameTooLong", "81-byte name");
    await expectFail(sendItem({ index: 7, asset: PublicKey.default, uri: "u".repeat(161) }, Keypair.generate()), "UriTooLong", "161-byte uri");
  });

  await test("worst-case register_item (80-byte name, 160-byte uri) fits a plain legacy transaction and lands", async () => {
    const { size } = await sendItem({ index: 7, asset: PublicKey.default, name: "n".repeat(80), uri: URI_MAX }, Keypair.generate());
    console.log(`   worst-case tx size ${size} bytes`);
    assert.ok(size <= 1232, `tx is ${size} bytes`);
  });

  await test("update_asset_uri: admin only, record-bound, changes uri and never the name", async () => {
    const NEW_URI = "https://gateway2.iqlabs.dev/nft/" + "M".repeat(88);
    const acc = (admin: PublicKey, asset: PublicKey, record: PublicKey) => ({
      admin,
      registry: registryPda,
      asset,
      inscriptionRecord: record,
      collection: collectionPk,
      collectionAuth: collectionAuthPda,
      mplCoreProgram: MPL_CORE,
      systemProgram: SystemProgram.programId,
    });
    await expectFail(
      program.methods.updateAssetUri(NEW_URI).accountsStrict(acc(attackerKp.publicKey, asset1.publicKey, inscriptionPda(sigOf(1)))).signers([attackerKp]).rpc(),
      "UnauthorizedAdmin",
      "attacker update_asset_uri"
    );
    // item 2's record with item 1's asset must be rejected
    await expectFail(
      program.methods.updateAssetUri(NEW_URI).accountsStrict(acc(adminKp.publicKey, asset1.publicKey, inscriptionPda(sigOf(2)))).rpc(),
      "WrongAsset",
      "mismatched record and asset"
    );
    await program.methods.updateAssetUri(NEW_URI).accountsStrict(acc(adminKp.publicKey, asset1.publicKey, inscriptionPda(sigOf(1)))).rpc({ commitment: "confirmed" });
    assert.equal(await waitAssetUri(asset1.publicKey, NEW_URI), NEW_URI);
    const asset = await fetchAssetV1(umi, umiPk(asset1.publicKey.toBase58()));
    assert.equal(asset.name, "Item #1", "name must never change");
    assert.equal(((asset as any).attributes?.attributeList ?? []).length, 4, "attributes untouched");
  });

  const collectionAcc = (admin: PublicKey) => ({
    admin,
    registry: registryPda,
    collection: collectionPk,
    collectionAuth: collectionAuthPda,
    mplCoreProgram: MPL_CORE,
    systemProgram: SystemProgram.programId,
  });

  await test("update_collection_uri: admin only, uri changes", async () => {
    const NEW_URI = "https://gateway2.iqlabs.dev/nft/" + "C".repeat(88);
    await expectFail(program.methods.updateCollectionUri(NEW_URI).accountsStrict(collectionAcc(attackerKp.publicKey)).signers([attackerKp]).rpc(), "UnauthorizedAdmin", "attacker update_collection_uri");
    await program.methods.updateCollectionUri(NEW_URI).accountsStrict(collectionAcc(adminKp.publicKey)).rpc({ commitment: "confirmed" });
    let colUri = "";
    for (let i = 0; i < 12 && colUri !== NEW_URI; i++) {
      colUri = (await fetchCollectionV1(umi, umiPk(collectionPk.toBase58()))).uri;
      if (colUri !== NEW_URI) await new Promise((r) => setTimeout(r, 400));
    }
    assert.equal(colUri, NEW_URI);
  });

  await test("set_royalties: admin only, rewrites the Royalties plugin through the PDA", async () => {
    const creators = [{ address: ownerKp.publicKey, percentage: 100 }];
    await expectFail(program.methods.setRoyalties(750, creators).accountsStrict(collectionAcc(attackerKp.publicKey)).signers([attackerKp]).rpc(), "UnauthorizedAdmin", "attacker set_royalties");
    await program.methods.setRoyalties(750, creators).accountsStrict(collectionAcc(adminKp.publicKey)).rpc({ commitment: "confirmed" });
    let bps = 0;
    for (let i = 0; i < 12 && bps !== 750; i++) {
      bps = (await fetchCollection(umi, umiPk(collectionPk.toBase58()))).royalties?.basisPoints ?? 0;
      if (bps !== 750) await new Promise((r) => setTimeout(r, 400));
    }
    assert.equal(bps, 750);
    const col = await fetchCollection(umi, umiPk(collectionPk.toBase58()));
    assert.equal(col.royalties?.creators[0].address.toString(), ownerKp.publicKey.toBase58());
  });

  // -- single NFTs: a registry with max_supply 0 --
  const singlePk = await newCollection("IQ6900 Inscriptions", false);
  const singleRegistry = registryOf(singlePk);
  await test("register_single: record only, 3 attributes, owner is the wallet; wrong registry kinds rejected", async () => {
    await initIx({ collection: singlePk, maxSupply: 0 }).rpc();
    const assetKp = Keypair.generate();
    const sig = sigOf(700);
    const ix = await program.methods
      .registerSingle(sig, sigOf(1700), "My inscription", URI)
      .accountsStrict({
        minter: minterKp.publicKey,
        owner: ownerKp.publicKey,
        registrar: registrarKp.publicKey,
        registry: singleRegistry,
        inscriptionRecord: inscriptionPda(sig),
        collection: singlePk,
        collectionAuth: authOf(singleRegistry),
        treasury: treasuryPk,
        platformTreasury: PLATFORM_TREASURY,
        asset: assetKp.publicKey,
        mplCoreProgram: MPL_CORE,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    await send(ix, {}, assetKp);
    const asset = await fetchAssetV1(umi, umiPk(assetKp.publicKey.toBase58()));
    assert.equal(asset.owner.toString(), ownerKp.publicKey.toBase58());
    assert.deepEqual(
      ((asset as any).attributes?.attributeList ?? []).map((a: any) => [a.key, a.value]),
      [
        ["inscription", hex(sig)],
        ["metadata", hex(sigOf(1700))],
        ["std", "iqnft-0.1"],
      ]
    );
    const rec: any = await (program.account as any).inscriptionRecord.fetch(inscriptionPda(sig));
    assert.equal(rec.collection.toBase58(), singlePk.toBase58());

    // the same inscription again, anywhere, is refused
    await expectFail(sendItem({ index: 8, asset: PublicKey.default, inscriptionSig: sig }, Keypair.generate()), "already in use", "single's sig as an item");

    // register_single on an item registry, register_item on a single registry
    const wrongAsset = Keypair.generate();
    const wrongKind = await program.methods
      .registerSingle(sigOf(701), sigOf(1701), "x", URI)
      .accountsStrict({
        minter: minterKp.publicKey,
        owner: ownerKp.publicKey,
        registrar: registrarKp.publicKey,
        registry: registryPda,
        inscriptionRecord: inscriptionPda(sigOf(701)),
        collection: collectionPk,
        collectionAuth: collectionAuthPda,
        treasury: treasuryPk,
        platformTreasury: PLATFORM_TREASURY,
        asset: wrongAsset.publicKey,
        mplCoreProgram: MPL_CORE,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    await expectFail(send(wrongKind, {}, wrongAsset), "NotASingleRegistry", "single into item registry");
    await expectFail(
      sendItem({ index: 1, asset: PublicKey.default, registry: singleRegistry, collection: singlePk, inscriptionSig: sigOf(702) }, Keypair.generate()),
      "IndexOutOfRange",
      "item into single registry"
    );
  });

  console.log(`\n${passed} tests passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
