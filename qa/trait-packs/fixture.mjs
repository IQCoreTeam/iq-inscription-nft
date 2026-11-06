// Synthetic QA only. No input wallet, secret file, public RPC or source artwork.
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as web3 from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as core from "@metaplex-foundation/mpl-core";
import * as umi from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import { Surfnet } from "@solana/surfpool";
import * as orao from "@orao-network/solana-vrf";
import nacl from "tweetnacl";

export const CORE_ID = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
export const ORAO_ID = "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y";
const IQ_ID = "FCGhsCf5sMM7Z5APta1hi76WGTvrfMJnBr4QSR3w13Fu";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Bind a receipt to the reviewed source, not just the supplied program binaries.
export async function snapshotSource() {
  const root = new URL("../../", import.meta.url), result = {};
  async function visit(relative) {
    for (const entry of await readdir(new URL(relative, root), { withFileTypes: true })) {
      if (["node_modules", "target", ".evidence"].includes(entry.name)) continue;
      const file = relative + entry.name;
      if (entry.isDirectory()) await visit(file + "/");
      else if (entry.isFile() && (/\.(?:ts|mjs|cjs|js|rs|json|toml)$/.test(entry.name) || entry.name === "Cargo.lock"))
        result[file] = hash(await readFile(new URL(file, root)));
    }
  }
  for (const directory of ["backend/src/", "extensions/trait-packs/", "programs/iq-inscription-nft/", "qa/trait-packs/"])
    await visit(directory);
  for (const file of ["Cargo.toml", "Cargo.lock", "target/idl/iq_inscription_nft.json"])
    result[file] = hash(await readFile(new URL(file, root)));
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

async function artifact(label, path, sha) {
  if (!path || !sha || !/^[a-f0-9]{64}$/.test(sha))
    throw Error(`Set explicit ${label} binary path and SHA256; see README`);
  const info = await stat(path);
  if (!info.isFile() || info.size > 16000000)
    throw Error(`${label} must be a bounded ELF binary`);
  const bytes = await readFile(path);
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
    throw Error(`${label} is not an ELF binary`);
  if (hash(bytes) !== sha) throw Error(`${label} binary hash mismatch`);
  return { path, sha256: sha, bytes: bytes.length };
}
export async function inputsFromEnvironment() {
  const env = process.env;
  return {
    core: await artifact("Core", env.IQ_QA_CORE_BINARY, env.IQ_QA_CORE_SHA256),
    orao: await artifact("ORAO", env.IQ_QA_ORAO_BINARY, env.IQ_QA_ORAO_SHA256),
    iq: await artifact(
      "IQ",
      env.IQ_QA_IQ_BINARY ??
        fileURLToPath(
          new URL("../../target/deploy/iq_inscription_nft.so", import.meta.url),
        ),
      env.IQ_QA_IQ_SHA256,
    ),
    packs: await artifact(
      "packs",
      env.IQ_QA_PACKS_BINARY ??
        fileURLToPath(
          new URL(
            "../../extensions/trait-packs/program/target/deploy/nubbies_paid_v6.so",
            import.meta.url,
          ),
        ),
      env.IQ_QA_PACKS_SHA256,
    ),
  };
}

export async function startSyntheticFixture(inputs) {
  const surf = Surfnet.startWithConfig({
    offline: true,
    blockProductionMode: "clock",
    slotTimeMs: 100,
  });
  const connection = new web3.Connection(surf.rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: surf.wsUrl,
  });
  assert.equal(new URL(connection.rpcEndpoint).hostname, "127.0.0.1");
  const creator = web3.Keypair.fromSecretKey(surf.payerSecretKey),
    buyer = web3.Keypair.generate(),
    operator = web3.Keypair.generate(),
    treasury = web3.Keypair.generate(),
    providerTreasury = web3.Keypair.generate();
  const program = web3.Keypair.generate().publicKey,
    iqId = new web3.PublicKey(IQ_ID),
    authorities = Array.from({ length: 4 }, () => web3.Keypair.generate()),
    receipts = [];
  const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(creator),
      { commitment: "confirmed", preflightCommitment: "confirmed" },
    ),
    vrf = new orao.Orao(provider);
  const u = createUmi(surf.rpcUrl)
    .use(core.mplCore())
    .use(
      umi.keypairIdentity(
        createUmi(surf.rpcUrl).eddsa.createKeypairFromSecretKey(
          creator.secretKey,
        ),
      ),
    );
  const idl = JSON.parse(
    await readFile(
      new URL("../../target/idl/iq_inscription_nft.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(idl.address, IQ_ID);
  const iq = new anchor.Program(idl, provider);
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    connection._rpcWebSocket.close();
    surf.stop();
  };
  async function send(label, instructions, signers = [creator]) {
    const tx =
      instructions instanceof web3.Transaction
        ? instructions
        : new web3.Transaction().add(...instructions);
    tx.instructions = tx.instructions.filter(
      (ix) => !ix.programId.equals(web3.ComputeBudgetProgram.programId),
    );
    tx.instructions.unshift(
      web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1200000 }),
    );
    const validity = await connection.getLatestBlockhash("confirmed");
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = validity.blockhash;
    tx.sign(
      ...[
        ...new Map(
          signers.map((signer) => [signer.publicKey.toBase58(), signer]),
        ).values(),
      ],
    );
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 0,
    });
    await connection.confirmTransaction(
      { signature, ...validity },
      "confirmed",
    );
    const receipt = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    assert(receipt && !receipt.meta.err, `${label} did not land successfully`);
    receipts.push({
      label,
      signature,
      slot: receipt.slot,
      fee: receipt.meta.fee,
    });
    return receipts.at(-1);
  }
  try {
    for (const [id, input] of [
      [CORE_ID, inputs.core],
      [ORAO_ID, inputs.orao],
      [IQ_ID, inputs.iq],
      [program.toBase58(), inputs.packs],
    ]) {
      assert.equal(
        hash(await readFile(input.path)),
        input.sha256,
        "Artifact changed before deployment",
      );
      surf.deploy({ programId: id, soPath: input.path });
      assert.equal(
        hash(await readFile(input.path)),
        input.sha256,
        "Artifact changed during deployment",
      );
    }
    for (const wallet of [buyer, operator, treasury, providerTreasury])
      surf.fundSol(wallet.publicKey.toBase58(), 50000000000);
    surf.fundSol("EWNSTD8tikwqHMcRNuuNbZrnYJUiJdKq9UXLXSEU4wZ1", 1000000);
    const initialize = await new orao.InitBuilder(
      vrf,
      creator.publicKey,
      providerTreasury.publicKey,
      authorities.map((authority) => authority.publicKey),
      new anchor.BN(1000000),
    )
      .withComputeUnitPrice(0)
      .withComputeUnitLimit(400000)
      .build();
    await send(
      "synthetic-local-provider-config",
      await initialize.transaction(),
    );
    const collection = umi.generateSigner(u),
      collectionKey = new web3.PublicKey(collection.publicKey),
      registry = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("registry"), collectionKey.toBuffer()],
        iqId,
      )[0],
      collectionAuth = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("collection-auth"), registry.toBuffer()],
        iqId,
      )[0];
    const create = core
      .createCollectionV1(u, {
        collection,
        updateAuthority: umi.publicKey(collectionAuth.toBase58()),
        name: "Synthetic pack QA collection",
        uri: "http://127.0.0.1/synthetic-collection.json",
      })
      .getInstructions()
      .map(toWeb3JsInstruction);
    const initializeRegistry = await iq.methods
      .initializeRegistry(
        1,
        Array(32).fill(8),
        Array(64).fill(8),
        Array(32).fill(7),
        creator.publicKey,
        creator.publicKey,
        new anchor.BN(0),
        new anchor.BN(0),
        treasury.publicKey,
      )
      .accountsStrict({
        payer: creator.publicKey,
        collection: collectionKey,
        registry,
        collectionAuth,
        systemProgram: web3.SystemProgram.programId,
      })
      .instruction();
    await send(
      "synthetic-collection-and-IQ-registry",
      [...create, initializeRegistry],
      [creator, web3.Keypair.fromSecretKey(collection.secretKey)],
    );
    const avatar = web3.Keypair.generate(),
      C = randomBytes(64),
      record = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("inscription"), C.subarray(0, 32), C.subarray(32)],
        iqId,
      )[0];
    const register = await iq.methods
      .registerItem(
        1,
        Array(32).fill(9),
        Array.from(C),
        Array.from(randomBytes(64)),
        "Synthetic base #1",
        "http://127.0.0.1/synthetic-base.json",
      )
      .accountsStrict({
        minter: creator.publicKey,
        owner: buyer.publicKey,
        registrar: creator.publicKey,
        registry,
        inscriptionRecord: record,
        collection: collectionKey,
        collectionAuth,
        treasury: treasury.publicKey,
        platformTreasury: new web3.PublicKey(
          "EWNSTD8tikwqHMcRNuuNbZrnYJUiJdKq9UXLXSEU4wZ1",
        ),
        asset: avatar.publicKey,
        mplCoreProgram: new web3.PublicKey(CORE_ID),
        systemProgram: web3.SystemProgram.programId,
      })
      .instruction();
    await send("synthetic-base-NFT", [register], [creator, avatar]);
    async function fulfillLocalProvider(seed) {
      for (let i = 0; i < 3; i++) {
        const signature = Buffer.from(
          nacl.sign.detached(Buffer.from(seed), authorities[i].secretKey),
        );
        const tx = await (
          await new orao.FulfillBuilder(vrf, seed)
            .withComputeUnitPrice(0)
            .withComputeUnitLimit(400000)
            .build(authorities[i].publicKey, signature)
        ).transaction();
        await send("synthetic-provider-quorum-" + i, tx);
      }
    }
    return {
      surf,
      connection,
      umi: u,
      creator,
      buyer,
      operator,
      treasury,
      providerTreasury,
      program,
      collection: collectionKey,
      registry,
      collectionAuth,
      iqId,
      avatar: avatar.publicKey,
      vrf,
      send,
      fulfillLocalProvider,
      receipts,
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}
