import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { createPackCreator } from "./pack-creator.ts";
import { fixture as kitFixture } from "../../extensions/trait-packs/creator/test/fixtures.mjs";
import { publishKitArtifacts } from "../../extensions/trait-packs/client/publish-kit.mjs";
import { validateCatalog } from "../../extensions/trait-packs/creator/catalog.mjs";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
async function fixture() {
  const source = await kitFixture(),
    directory = await mkdtemp(path.join(tmpdir(), "pack-creator-api-")),
    dbPath = path.join(directory, "state.sqlite"),
    db = new Database(dbPath, { create: true });
  const wallet=Keypair.generate();
  const owner = wallet.publicKey.toBase58(),
    collection = Keypair.generate().publicKey.toBase58(),
    program = Keypair.generate().publicKey.toBase58(),
    nftProgram = Keypair.generate().publicKey.toBase58(),
    registry = PublicKey.findProgramAddressSync(
      [Buffer.from("registry"), new PublicKey(collection).toBuffer()],
      new PublicKey(nftProgram),
    )[0].toBase58();
  const treasury = Keypair.generate().publicKey.toBase58(),
    provider = Keypair.generate().publicKey.toBase58(),
    providerTreasury = Keypair.generate().publicKey.toBase58(),
    state = {
      pool: null as any,
      ops: null as any,
      reads: 0,
      genesis: "pinned-local",
    };
  const actual = {
    collection,
    registry,
    admin: owner,
    treasury,
    itemCount: 1,
    items: source.input.items.map((item: any) => ({
      index: item.index,
      name: item.name,
      imageSha256: item.sha256,
    })),
  };
  const artifacts = new Map<string, Buffer>();
  const options = {
    db,
    stagingRoot: path.join(directory, "images"),
    connection: {
      getGenesisHash: async () => state.genesis,
      getMultipleAccountsInfo: async () => {
        state.reads++;
        return [state.pool, state.ops];
      },
    },
    expectedGenesis: "pinned-local",
    gateway: "http://127.0.0.1:4564",
    program,
    nftProgram,
    provider,
    providerTreasury,
    window: 100,
    timeout: 100,
    operationsReserveLamports: 148000000,
    readCollection: async () => actual,
    readArtifact: async (sig: string) => {
      if (!artifacts.has(sig)) throw Error("Missing confirmed artifact");
      return artifacts.get(sig)!;
    },
  };
  const api = createPackCreator(options),
    files = [];
  for (const name of [
    "bg.png",
    "body.png",
    "hair-a.png",
    "hair-b.png",
    "base/1.png",
  ])
    files.push({
      name,
      base64: (await readFile(path.join(source.root, name))).toString("base64"),
    });
  const body = {
    owner,
    sourceConsent: true,
    manifest: source.input,
    files,
    settings: { priceLamports: 100000000 },
    final: true,
  };
  return {
    api,
    wallet,
    options,
    state,
    actual,
    source,
    directory,
    dbPath,
    db,
    artifacts,
    body,
    owner,
    collection,
    registry,
    async stop() {
      db.close();
      await source.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
function sealedPool(spec: any, epochCount = 1) {
  const data = Buffer.alloc(4352);
  data.write("NUBSALE5");
  for (const [field, offset] of [
    ["authority", 8],
    ["collection", 40],
    ["treasury", 72],
    ["provider", 104],
    ["providerTreasury", 136],
  ] as const)
    new PublicKey(spec[field]).toBuffer().copy(data, offset);
  sha(validateCatalog(spec.definitions)).copy(data, 168);
  data.writeBigUInt64LE(BigInt(spec.price), 200);
  data[208] = spec.definitions.length;
  data[209] = 4;
  data.writeBigUInt64LE(BigInt(spec.window), 210);
  data.writeBigUInt64LE(BigInt(spec.timeout), 218);
  data.writeBigUInt64LE(BigInt(epochCount), 226);
  data[250] = 1;
  data[251] = spec.definitions.length;
  data[254] = 1;
  new PublicKey(spec.registry).toBuffer().copy(data, 255);
  new PublicKey(spec.nftProgram).toBuffer().copy(data, 287);
  validateCatalog(spec.definitions).copy(data, 384);
  return { owner: new PublicKey(spec.program), data };
}
async function publishBrowser(f: any, checked: any) {
  const checkpoint: any = {};
  const context = {
    owner: f.owner,
    gateway: f.options.gateway,
    connection: f.options.connection,
    expectedGenesis: f.options.expectedGenesis,
    saveCheckpoint: async () => {},
    writeArtifact: async (bytes: Uint8Array) => {
      const signature = bs58.encode(randomBytes(64));
      f.artifacts.set(signature, Buffer.from(bytes));
      return signature;
    },
    readArtifact: f.options.readArtifact,
  };
  const publication = await publishKitArtifacts(
    checked.publicationKit,
    async (file) => readFile(path.join(f.source.root, file)),
    context,
    checkpoint,
  );
  return {
    body: {
      draftId: checked.draftId,
      owner: f.owner,
      collection: f.collection,
      registry: f.registry,
      publicationCheckpoint: checkpoint,
      sourceConsent: true,
    },
    publication,
  };
}

test("SQLite creator draft survives restart and verifies browser publication before returning unsigned setup", async () => {
  const f = await fixture();
  try {
    const checked = await f.api.validate(f.body);
    expect(checked.status).toBe("validated");
    expect(checked.publicationKit.files.length).toBe(5);
    const browser = await publishBrowser(f, checked);
    const db2 = new Database(f.dbPath);
    try {
      const restarted = createPackCreator({ ...f.options, db: db2 });
      const plan = await restarted.publish(browser.body);
      expect(plan.stage).toBe("setup");
      expect(plan.plan.map((step: any) => step.stage)).toEqual([
        "initialize",
        "append",
        "seal",
        "fund-operations",
        "open-epoch",
      ]);
      expect(plan.cost.totalPrice).toBe(105000000);
      expect(plan.cost.operationsFundingLamports).toBe(148000000);
      expect(
        plan.plan.every(
          (step: any) => typeof step.instruction.data === "string",
        ),
      ).toBe(true);
      await expect(restarted.finalize(browser.body)).rejects.toThrow(
        /must confirm/,
      );
      f.state.pool = sealedPool(plan.spec);
      f.state.ops = {
        owner: SystemProgram.programId,
        data: Buffer.alloc(0),
        lamports: 148000000,
      };
      const result = await restarted.finalize(browser.body);
      expect(result.stage).toBe("confirmed");
      expect(result.renderKit).toBe(browser.publication.renderKit);
      f.state.ops.lamports = 0;
      const retried = await restarted.finalize(browser.body);
      expect(retried.pool).toBe(result.pool);
    } finally {
      db2.close();
    }
  } finally {
    await f.stop();
  }
});

test("unconfirmed, forged or missing media cannot be finalized or written by the server", async () => {
  const f = await fixture();
  try {
    const checked = await f.api.validate(f.body);
    const browser = await publishBrowser(f, checked);
    const saved = f.artifacts.get(browser.publication.renderKit);
    f.artifacts.set(browser.publication.renderKit, Buffer.from("forged"));
    await expect(f.api.publish(browser.body)).rejects.toThrow(
      /expected bytes|match/,
    );
    f.artifacts.set(browser.publication.renderKit, saved!);
    const incomplete = structuredClone(browser.body);
    delete incomplete.publicationCheckpoint.artifacts["render-kit"];
    await expect(f.api.publish(incomplete)).rejects.toThrow(/incomplete/);
    expect(
      f.db
        .query("SELECT result FROM pack_creator_draft WHERE id=?1")
        .get(checked.draftId),
    ).toEqual({ result: null });
  } finally {
    await f.stop();
  }
});

test("wrong admin, registry, immutable item hash, network or sealed pool fails closed", async () => {
  const f = await fixture();
  try {
    const checked = await f.api.validate(f.body),
      browser = await publishBrowser(f, checked);
    const admin = f.actual.admin;
    f.actual.admin = Keypair.generate().publicKey.toBase58();
    await expect(f.api.publish(browser.body)).rejects.toThrow(/authority/);
    f.actual.admin = admin;
    await expect(
      f.api.publish({
        ...browser.body,
        registry: Keypair.generate().publicKey.toBase58(),
      }),
    ).rejects.toThrow(/authority/);
    f.actual.items[0].imageSha256 = "0".repeat(64);
    await expect(f.api.publish(browser.body)).rejects.toThrow(/images/);
    f.actual.items[0].imageSha256 = f.body.manifest.items[0].sha256;
    f.state.genesis = "other";
    await expect(f.api.publish(browser.body)).rejects.toThrow(/chain mismatch/);
    f.state.genesis = "pinned-local";
    const plan = await f.api.publish(browser.body);
    f.state.pool = sealedPool(plan.spec);
    f.state.pool.data[254] = 0;
    await expect(f.api.finalize(browser.body)).rejects.toThrow(
      /authority configuration/,
    );
  } finally {
    await f.stop();
  }
});

test("draft upload rejects unreferenced files, changed source and owner mismatch", async () => {
  const f = await fixture();
  try {
    const draft = await f.api.validate({ ...f.body, files: [], final: false });
    await expect(
      f.api.validate({
        ...f.body,
        draftId: draft.draftId,
        owner: Keypair.generate().publicKey.toBase58(),
        manifest: undefined,
      }),
    ).rejects.toThrow(/owner/);
    await expect(
      f.api.validate({
        ...f.body,
        draftId: draft.draftId,
        manifest: undefined,
        files: [{ name: "../escape.png", base64: "eA==" }],
        final: false,
      }),
    ).rejects.toThrow(/relative/);
    await expect(
      f.api.validate({
        ...f.body,
        draftId: draft.draftId,
        manifest: undefined,
        files: [{ name: "private.png", base64: "eA==" }],
        final: false,
      }),
    ).rejects.toThrow(/not referenced/);
    await f.api.validate({
      ...f.body,
      draftId: draft.draftId,
      manifest: undefined,
      final: false,
    });
    await expect(
      f.api.validate({
        ...f.body,
        draftId: draft.draftId,
        manifest: undefined,
        files: [{ name: "bg.png", base64: "eA==" }],
        final: false,
      }),
    ).rejects.toThrow(/changed/);
  } finally {
    await f.stop();
  }
});

test("request handler is bounded, read-only for wrong methods and does not leak host paths", async () => {
  const f = await fixture();
  try {
    expect(
      (
        await f.api.handle(
          new Request("http://localhost/creator/packs/validate"),
        )
      ).status,
    ).toBe(405);
    const bad = await f.api.handle(
      new Request("http://localhost/creator/packs/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner:f.body.owner,draftId:"unpublished",sourceConsent:false }),
      }),
    );
    expect(bad.status).toBe(503);
    expect((await bad.json()).error).toMatch(/authentication is not configured/);
  } finally {
    await f.stop();
  }
});

test("SQLite lease prevents concurrent setup and staging budgets reject before writes", async () => {
  const f = await fixture();
  try {
    const checked = await f.api.validate(f.body),
      browser = await publishBrowser(f, checked);
    let release: any, entered: any;
    const gate = new Promise((resolve) => (release = resolve)),
      entry = new Promise((resolve) => (entered = resolve)),
      baseRead = f.options.readCollection;
    const other = createPackCreator({
      ...f.options,
      readCollection: async (value) => {
        entered();
        await gate;
        return baseRead(value);
      },
    });
    const running = other.publish(browser.body);
    await entry;
    await expect(f.api.publish(browser.body)).rejects.toThrow(/busy/);
    release();
    await running;
    const limited = createPackCreator({
      ...f.options,
      limits: { draftBytes: 1, totalBytes: 1, drafts: 32 },
    });
    await expect(
      limited.validate({
        ...f.body,
        owner: Keypair.generate().publicKey.toBase58(),
      }),
    ).rejects.toThrow(/budget/);
  } finally {
    await f.stop();
  }
});

test("expired staging frees its quota and files without deleting an active lease", async () => {
  const f = await fixture();
  try {
    const api = createPackCreator({ ...f.options, limits: { draftBytes: 512000000, totalBytes: 512000000, drafts: 1 } });
    const old = await api.validate(f.body);
    const image = path.join(f.options.stagingRoot, old.draftId, f.body.files[0].name);
    f.db.query("UPDATE pack_creator_draft SET expires_at=0,lease_token='active',lease_until=?1 WHERE id=?2").run(Date.now() + 300000, old.draftId);
    await api.reapExpired();
    expect((await readFile(image)).length).toBeGreaterThan(0);
    await expect(api.validate(f.body)).rejects.toThrow(/draft budget/);
    f.db.query("UPDATE pack_creator_draft SET lease_until=0 WHERE id=?1").run(old.draftId);
    const fresh = await api.validate(f.body);
    expect(fresh.draftId).not.toBe(old.draftId);
    expect(f.db.query("SELECT id FROM pack_creator_draft WHERE id=?1").get(old.draftId)).toBeNull();
    expect(f.db.query("SELECT name FROM pack_creator_file WHERE draft_id=?1").all(old.draftId)).toHaveLength(0);
    await expect(readFile(image)).rejects.toThrow();
  } finally {
    await f.stop();
  }
});

test("finalized recovery ledgers survive expiry and do not consume unfinished staging quotas", async () => {
  const f = await fixture();
  try {
    const totalBytes = f.body.files.reduce((sum, file) => sum + Buffer.from(file.base64, "base64").length, 0);
    const api = createPackCreator({ ...f.options, limits: { draftBytes: totalBytes, totalBytes, drafts: 1 } });
    const checked = await api.validate(f.body), browser = await publishBrowser(f, checked), plan = await api.publish(browser.body);
    f.state.pool = sealedPool(plan.spec);
    f.state.ops = { owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: 148000000 };
    const finalized = await api.finalize(browser.body);
    f.db.query("UPDATE pack_creator_draft SET expires_at=0 WHERE id=?1").run(checked.draftId);
    await api.reapExpired();
    expect(JSON.parse(f.db.query("SELECT result FROM pack_creator_draft WHERE id=?1").get(checked.draftId).result)).toEqual(finalized);
    expect(f.db.query("SELECT name FROM pack_creator_file WHERE draft_id=?1").all(checked.draftId)).toHaveLength(f.body.files.length);
    expect((await api.readVerifiedPublishedKit(f.collection)).renderKit).toBe(finalized.renderKit);
    expect((await api.validate(f.body)).status).toBe("validated");
  } finally {
    await f.stop();
  }
});

test("expired draft cleanup is bounded to 32 rows per pass", async () => {
  const f = await fixture();
  try {
    const api = createPackCreator({ ...f.options, limits: { draftBytes: 512000000, totalBytes: 512000000, drafts: 40 } });
    for (let i = 0; i < 33; i++) await api.validate({ ...f.body, files: [], final: false });
    f.db.query("UPDATE pack_creator_draft SET expires_at=0").run();
    await api.reapExpired();
    expect(f.db.query("SELECT COUNT(*) AS n FROM pack_creator_draft").get().n).toBe(1);
    await api.reapExpired();
    expect(f.db.query("SELECT COUNT(*) AS n FROM pack_creator_draft").get().n).toBe(0);
  } finally {
    await f.stop();
  }
});

test("publication cannot accept a matching pool whose current reserve or initial epoch is missing", async () => {
  const f = await fixture();
  try {
    const checked = await f.api.validate(f.body),
      browser = await publishBrowser(f, checked),
      plan = await f.api.publish(browser.body);
    f.state.pool = sealedPool(plan.spec, 0);
    f.state.ops = {
      owner: SystemProgram.programId,
      data: Buffer.alloc(0),
      lamports: 148000000,
    };
    await expect(f.api.finalize(browser.body)).rejects.toThrow(/must confirm/);
    f.state.pool = sealedPool(plan.spec, 1);
    f.state.ops.lamports = 1;
    await expect(f.api.finalize(browser.body)).rejects.toThrow(/must confirm/);
  } finally {
    await f.stop();
  }
});

test("outfit context requires the confirmed registry, current holder and reviewed base hash", async () => {
  const f = await fixture();
  try {
    const checked = await f.api.validate(f.body),
      browser = await publishBrowser(f, checked),
      plan = await f.api.publish(browser.body);
    f.state.pool = sealedPool(plan.spec, 1);
    f.state.ops = {
      owner: SystemProgram.programId,
      data: Buffer.alloc(0),
      lamports: 148000000,
    };
    await f.api.finalize(browser.body);
    const owner = Keypair.generate().publicKey.toBase58(),
      asset = Keypair.generate().publicKey.toBase58();
    const nft = {
      collection: f.collection,
      owner,
      index: 1,
      imageSha256: f.actual.items[0].imageSha256,
      inscription: bs58.encode(randomBytes(64)),
    };
    const api = createPackCreator({
      ...f.options,
      readAsset: async () => nft,
      outfitBase: "http://127.0.0.1:4564",
    });
    const context = await api.outfitContext({
      collection: f.collection,
      asset,
      owner,
    });
    expect(context.admin).toBe(f.owner);
    expect(context.bodyClass).toBe(0);
    expect(context.metadataUri).toEndWith("/wardrobe/metadata/" + asset);
    await expect(
      api.outfitContext({ collection: f.collection, asset, owner: f.owner }),
    ).rejects.toThrow(/current registered holder/);
    nft.imageSha256 = "00".repeat(32);
    await expect(
      api.outfitContext({ collection: f.collection, asset, owner }),
    ).rejects.toThrow(/reviewed recipe/);
  } finally {
    await f.stop();
  }
});

test("finalized outfit consent recovers its permanent recipe after staging removal and API restart", async () => {
  const f = await fixture();
  let reopened: Database | undefined;
  try {
    const checked = await f.api.validate(f.body),
      browser = await publishBrowser(f, checked),
      plan = await f.api.publish(browser.body);
    f.state.pool = sealedPool(plan.spec, 1);
    f.state.ops = {
      owner: SystemProgram.programId,
      data: Buffer.alloc(0),
      lamports: 148000000,
    };
    const finalized = await f.api.finalize(browser.body);
    expect(finalized.renderKitHash).toBe(
      sha(f.artifacts.get(finalized.renderKit)!).toString("hex"),
    );
    await rm(path.join(f.options.stagingRoot, checked.draftId), {
      recursive: true,
      force: true,
    });
    f.db
      .query("UPDATE pack_creator_draft SET expires_at=0 WHERE id=?1")
      .run(checked.draftId);
    const owner = Keypair.generate().publicKey.toBase58(),
      asset = Keypair.generate().publicKey.toBase58(),
      nft = {
        collection: f.collection,
        owner,
        index: 1,
        imageSha256: f.actual.items[0].imageSha256,
        inscription: bs58.encode(randomBytes(64)),
      };
    reopened = new Database(f.dbPath);
    const api = createPackCreator({
      ...f.options,
      db: reopened,
      readAsset: async () => nft,
    });
    const context = await api.outfitContext({
      collection: f.collection,
      asset,
      owner,
    });
    expect(context.bodyClass).toBe(0);
    expect(context.inscription).toBe(nft.inscription);
    expect(context.admin).toBe(f.owner);
    // Previously finalized local rows can be upgraded from their reviewed ledger
    // plus the exact recipe reference committed by each sealed trait metadata.
    const legacy = { ...finalized };
    delete legacy.renderKitHash;
    f.db
      .query("UPDATE pack_creator_draft SET result=?2 WHERE id=?1")
      .run(checked.draftId, JSON.stringify(legacy));
    await api.outfitContext({ collection: f.collection, asset, owner });
    expect(
      JSON.parse(
        f.db
          .query("SELECT result FROM pack_creator_draft WHERE id=?1")
          .get(checked.draftId).result,
      ).renderKitHash,
    ).toBe(finalized.renderKitHash);
  } finally {
    reopened?.close();
    await f.stop();
  }
});

test("permanent consent recovery rejects modified recipe or sealed metadata without staging", async () => {
  const f = await fixture();
  try {
    const checked = await f.api.validate(f.body),
      browser = await publishBrowser(f, checked),
      plan = await f.api.publish(browser.body);
    f.state.pool = sealedPool(plan.spec, 1);
    f.state.ops = {
      owner: SystemProgram.programId,
      data: Buffer.alloc(0),
      lamports: 148000000,
    };
    const finalized = await f.api.finalize(browser.body);
    await rm(path.join(f.options.stagingRoot, checked.draftId), {
      recursive: true,
      force: true,
    });
    const owner = Keypair.generate().publicKey.toBase58(),
      asset = Keypair.generate().publicKey.toBase58(),
      nft = {
        collection: f.collection,
        owner,
        index: 1,
        imageSha256: f.actual.items[0].imageSha256,
        inscription: bs58.encode(randomBytes(64)),
      },
      api = createPackCreator({ ...f.options, readAsset: async () => nft });
    const R = f.artifacts.get(finalized.renderKit)!;
    f.artifacts.set(finalized.renderKit, Buffer.concat([R, Buffer.from(" ")]));
    await expect(
      api.outfitContext({ collection: f.collection, asset, owner }),
    ).rejects.toThrow(/permanent recipe hash/);
    f.artifacts.set(finalized.renderKit, R);
    const M = browser.publication.definitions[0].uri.split("/").at(-1)!;
    const metadata = f.artifacts.get(M)!;
    f.artifacts.set(M, Buffer.from("{}"));
    await expect(
      api.outfitContext({ collection: f.collection, asset, owner }),
    ).rejects.toThrow(/metadata hash/);
    f.artifacts.set(M, metadata);
    expect(
      (await api.outfitContext({ collection: f.collection, asset, owner }))
        .bodyClass,
    ).toBe(0);
  } finally {
    await f.stop();
  }
});

test("outfit API handles missing assets and primitive callback failures without leaking or throwing", async () => {
  const f = await fixture();
  try {
    const checked = await f.api.validate(f.body),
      browser = await publishBrowser(f, checked),
      plan = await f.api.publish(browser.body);
    f.state.pool = sealedPool(plan.spec, 1);
    f.state.ops = {
      owner: SystemProgram.programId,
      data: Buffer.alloc(0),
      lamports: 148000000,
    };
    await f.api.finalize(browser.body);
    const owner = Keypair.generate().publicKey.toBase58(),
      asset = Keypair.generate().publicKey.toBase58();
    const url =
      "http://127.0.0.1/creator/packs/outfit-context?collection=" +
      f.collection +
      "&asset=" +
      asset +
      "&owner=" +
      owner;
    const missing = await createPackCreator({
      ...f.options,
      readAsset: async () => null,
    }).handle(new Request(url));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toMatch(/not registered/);
    const primitive = await createPackCreator({
      ...f.options,
      readAsset: async () => {
        throw null;
      },
    }).handle(new Request(url));
    expect(primitive.status).toBe(400);
    expect((await primitive.json()).error).toBe(
      "Pack setup could not complete; preserve its receipt and retry",
    );
  } finally {
    await f.stop();
  }
});

test("finalized collections expose verified read-only recovery and notify native registration after commit", async () => {
  const f = await fixture();
  try {
    const checked = await f.api.validate(f.body),
      browser = await publishBrowser(f, checked),
      plan = await f.api.publish(browser.body);
    f.state.pool = sealedPool(plan.spec, 1);
    f.state.ops = {
      owner: SystemProgram.programId,
      data: Buffer.alloc(0),
      lamports: 148000000,
    };
    const registered: string[] = [];
    let api: any;
    api = createPackCreator({
      ...f.options,
      onFinalized: async (collection) => {
        expect(
          f.db
            .query("SELECT result FROM pack_creator_draft WHERE collection=?1")
            .get(collection).result,
        ).not.toBeNull();
        const verified = await api.readVerifiedPublishedKit(collection);
        expect(verified.published.renderKit).toBe(
          browser.publication.renderKit,
        );
        registered.push(collection);
      },
    });
    const result = await api.finalize(browser.body);
    expect(registered).toEqual([f.collection]);
    expect(api.listFinalized()).toEqual([f.collection]);
    await rm(path.join(f.options.stagingRoot, checked.draftId), {
      recursive: true,
      force: true,
    });
    const verified = await api.readVerifiedPublishedKit(f.collection);
    expect(verified.recipe.schema).toBe("iq-trait-kit/1");
    expect(verified.kit.edition.items[0].id).toBe(1);
    expect(verified.owner).toBe(f.owner);
    expect((await api.finalize(browser.body)).renderKit).toBe(result.renderKit);
    expect(registered).toHaveLength(2);
  } finally {
    await f.stop();
  }
});

test("paginated history allows a larger catalog without publishing it", async () => {
  const f = await fixture();
  try {
    f.body.manifest.definitions[0].supply = 260;
    expect((await f.api.validate(f.body)).status).toBe("validated");
    const rows = f.db.query("SELECT validated FROM pack_creator_draft").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ validated: 1 });
    expect(f.artifacts.size).toBe(0);
  } finally {
    await f.stop();
  }
});

test("temporary kit validation does not claim permanent-publication consent", async () => {
  const f = await fixture();
  try {
    const checked = await f.api.validate({ ...f.body, sourceConsent: false });
    expect(checked.status).toBe("validated");
    await expect(f.api.publish({
      draftId: checked.draftId,
      owner: f.body.owner,
      sourceConsent: false,
    })).rejects.toThrow(/source publication/);
  } finally {
    await f.stop();
  }
});

test('HTTP staging requires a creator signature and rejects an authenticated different owner before any draft writes',async()=>{
 const f=await fixture();try{
  const origin='http://127.0.0.1:4564',api=createPackCreator({...f.options,auth:{origin,requestOrigins:[origin],chain:'solana:localnet'}});
  const req=(action:string,body:any,token?:string)=>new Request(origin+'/creator/packs/'+action,{method:'POST',headers:{origin,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  expect((await api.handle(req('validate',f.body))).status).toBe(401);
  expect(f.db.query('SELECT COUNT(*) AS n FROM pack_creator_draft').get().n).toBe(0);
  const challenge=await(await api.handle(req('auth',{owner:f.owner}))).json();
  const login=await(await api.handle(req('auth',{owner:f.owner,message:challenge.message,signature:bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message),f.wallet.secretKey))}))).json();
  expect((await api.handle(req('validate',{...f.body,owner:Keypair.generate().publicKey.toBase58()},login.token))).status).toBe(403);
  expect(f.db.query('SELECT COUNT(*) AS n FROM pack_creator_draft').get().n).toBe(0);
  const valid=await api.handle(req('validate',f.body,login.token));expect(valid.status).toBe(200);expect((await valid.json()).draftId).toBeTruthy();
  for(const action of ['publish','finalize'])expect((await api.handle(req(action,f.body))).status).toBe(401);
 }finally{await f.stop();}
});
