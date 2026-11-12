// Optional pack setup on the existing creator API. Files are staged locally;
// creators sign publication/catalog/funding transactions in their browser.
import { mkdir, readFile, writeFile, rename, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createPackCreatorAuthApi } from "./pack-auth.ts";
import { validateRenderableKit } from "../../extensions/trait-packs/service/kit-cache.mjs";
import { prepareRenderKit } from "../../extensions/trait-packs/creator/kit.mjs";
import { publishRenderKit } from "../../extensions/trait-packs/creator/publish.mjs";
import { assertReviewedKit } from "../../extensions/trait-packs/client/kit-review.mjs";
import { validateKitSchema } from "../../extensions/trait-packs/client/kit-schema.mjs";
import { catalogSetup } from "../../extensions/trait-packs/creator/catalog.mjs";
import {
  addresses,
  account,
  instruction,
  readPool,
  packCharge,
} from "../../extensions/trait-packs/client/protocol.mjs";

const MAX_REQUEST = 32_000_000,
  MAX_IMAGE = 20_000_000,
  MAX_FILES = 11_000,
  MAX_BYTES = 512_000_000;
const hash = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const fault = (message: string, status = 400) =>
  Object.assign(Error(message), { status });
const object = (value: any, keys: string[]) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw fault("Unexpected pack creator fields");
};
function pubkey(value: any) {
  try {
    if (typeof value !== "string") throw Error();
    return new PublicKey(value).toBase58();
  } catch {
    throw fault("Invalid public address");
  }
}
function fileName(value: any) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 240 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /[\x00-\x1f]/.test(value) ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part.startsWith(".") ||
          ["__proto__", "prototype", "constructor"].includes(part),
      ) ||
    !/^.+\.(png|webp)$/i.test(value)
  )
    throw fault("Use plain relative PNG/WebP kit paths");
  return value;
}
function sourceNames(manifest: any) {
  if (
    manifest?.schema !== "iq-trait-kit/1" ||
    !Array.isArray(manifest.config?.groups) ||
    !Array.isArray(manifest.items)
  )
    throw fault("Choose a supported trait kit");
  const files = new Set<string>();
  for (const group of manifest.config.groups)
    for (const asset of group.assets ?? []) {
      if (asset.file !== null) files.add(fileName(asset.file));
      if (asset.occlusion) files.add(fileName(asset.occlusion.maskFile));
    }
  for (const item of manifest.items) files.add(fileName(item.file));
  for (const field of ["coverFile", "logoFile"])
    if (manifest.appearance?.[field])
      files.add(fileName(manifest.appearance[field]));
  if (!files.size || files.size > MAX_FILES)
    throw fault("Unsupported trait kit file count");
  return files;
}
function wire(step: any) {
  return {
    ...Object.fromEntries(
      Object.entries(step).filter(([key]) => key !== "instruction"),
    ),
    instruction: {
      programId: step.instruction.programId.toBase58(),
      keys: step.instruction.keys.map((key: any) => ({
        ...key,
        pubkey: key.pubkey.toBase58(),
      })),
      data: Buffer.from(step.instruction.data).toString("base64"),
    },
  };
}

// Host callbacks are trusted boundaries: readCollection must verify confirmed
// Core/registry ownership and return its immutable staged item hashes;
// readArtifact must read successful IQ bytes on this same configured cluster.
// Neither callback receives a caller-supplied RPC, gateway URL or signer.
// Draft IDs locate staging; HTTP access additionally requires the authenticated
// wallet session. Direct host callbacks are trusted internal calls. Only
// the actual registry admin and sealed on-chain catalog can finalize success.
// Staging quotas apply to unfinished drafts. Finalized receipt/hash ledgers are
// retained for permanent-media recovery; the host controls completed-file retention.
export function createPackCreator(options: {
  db: any;
  stagingRoot: string;
  connection: any;
  expectedGenesis: string;
  gateway: string;
  program: string;
  nftProgram: string;
  provider: string;
  providerTreasury: string;
  window: number;
  timeout: number;
  operationsReserveLamports: number;
  limits?: { draftBytes: number; totalBytes: number; drafts: number };
  readCollection: (collection: string) => Promise<any>;
  readAsset?: (asset: string) => Promise<any>;
  outfitBase?: string;
  readArtifact: (signature: string) => Promise<Uint8Array>;
  onFinalized?: (collection: string) => Promise<void>;
  auth?: { origin: string; requestOrigins: string[]; chain: string };
}) {
  const { db, connection } = options,
    root = path.resolve(options.stagingRoot),
    gateway = new URL(options.gateway);
  const limits = options.limits ?? {
    draftBytes: MAX_BYTES,
    totalBytes: 2_000_000_000,
    drafts: 32,
  };
  for (const limit of Object.values(limits))
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw Error("Invalid pack staging budget");
  if (
    !["https:", "http:"].includes(gateway.protocol) ||
    gateway.username ||
    gateway.password ||
    gateway.search ||
    gateway.hash ||
    (gateway.protocol === "http:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(gateway.hostname))
  )
    throw Error("Pack gateway must be pinned to its cluster");
  for (const field of [
    "program",
    "nftProgram",
    "provider",
    "providerTreasury",
  ] as const)
    pubkey(options[field]);
  for (const value of [
    options.window,
    options.timeout,
    options.operationsReserveLamports,
  ])
    if (!Number.isSafeInteger(value) || value <= 0)
      throw Error("Invalid configured pack setup terms");
  if (options.operationsReserveLamports < 148_000_000)
    throw Error("Configured pack reserve cannot support one pack");
  db.exec(`CREATE TABLE IF NOT EXISTS pack_creator_draft (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, manifest TEXT NOT NULL, price INTEGER NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    validated INTEGER NOT NULL DEFAULT 0, collection TEXT, result TEXT
  ); CREATE TABLE IF NOT EXISTS pack_creator_file (
    draft_id TEXT NOT NULL REFERENCES pack_creator_draft(id), name TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
    PRIMARY KEY(draft_id,name)
  );`);
  const get = db.query("SELECT * FROM pack_creator_draft WHERE id=?1");
  const auth = options.auth ? createPackCreatorAuthApi({db, ...options.auth, program:options.program, genesis:options.expectedGenesis}) : null;
  async function reapExpired() {
    const now = Date.now();
    const expired = db.query(
      "SELECT id FROM pack_creator_draft WHERE result IS NULL AND expires_at<=?1 AND lease_until<?1 ORDER BY expires_at LIMIT 32",
    ).all(now);
    for (const { id } of expired) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      const token = randomUUID();
      if (db.query(
        "UPDATE pack_creator_draft SET lease_token=?2,lease_until=?3 WHERE id=?1 AND result IS NULL AND expires_at<=?4 AND lease_until<?4",
      ).run(id, token, now + 300_000, now).changes !== 1) continue;
      try {
        await rm(path.join(root, id), { recursive: true, force: true });
        db.transaction(() => {
          db.query("DELETE FROM pack_creator_file WHERE draft_id=?1 AND EXISTS (SELECT 1 FROM pack_creator_draft WHERE id=?1 AND result IS NULL AND lease_token=?2)").run(id, token);
          db.query("DELETE FROM pack_creator_draft WHERE id=?1 AND result IS NULL AND lease_token=?2").run(id, token);
        }).immediate();
      } finally {
        db.query("UPDATE pack_creator_draft SET lease_token=NULL,lease_until=0 WHERE id=?1 AND lease_token=?2").run(id, token);
      }
    }
  }
  async function network() {
    if ((await connection.getGenesisHash()) !== options.expectedGenesis)
      throw fault("Pack creator RPC chain mismatch", 503);
  }
  async function lease(
    id: string,
    owner: string,
    operation: (row: any) => Promise<any>,
  ) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw fault("Invalid pack draft");
    const token = randomUUID(),
      now = Date.now();
    const changed = db
      .query(
        "UPDATE pack_creator_draft SET lease_token=?3,lease_until=?4 WHERE id=?1 AND owner=?2 AND lease_until<?5 AND expires_at>?5",
      )
      .run(id, owner, token, now + 300_000, now).changes;
    if (changed !== 1) {
      const row = get.get(id);
      throw fault(
        !row
          ? "Pack draft not found"
          : row.owner !== owner
            ? "Pack draft owner does not match"
            : row.expires_at <= now
              ? "Pack draft expired"
              : "Pack draft is busy",
        !row ? 404 : 409,
      );
    }
    try {
      return await operation(get.get(id));
    } finally {
      db.query(
        "UPDATE pack_creator_draft SET lease_token=NULL,lease_until=0 WHERE id=?1 AND lease_token=?2",
      ).run(id, token);
    }
  }
  async function prepare(row: any) {
    const kit = await prepareRenderKit(
      JSON.parse(row.manifest),
      path.join(root, row.id),
    );
    if (!kit) throw fault("Trait-enabled kit required");
    return kit;
  }
  async function validate(body: any) {
    object(body, [
      "owner",
      "sourceConsent",
      "manifest",
      "files",
      "settings",
      "draftId",
      "final",
    ]);
    const owner = pubkey(body.owner);
    // Temporary validation does not publish source layers. Publication and
    // finalization require the explicit consent checked by identity().
    object(body.settings, ["priceLamports"]);
    packCharge(body.settings.priceLamports);
    if (!Array.isArray(body.files) || body.files.length > MAX_FILES)
      throw fault("Invalid bounded kit upload");
    let id = body.draftId;
    if (!id) {
      if (!body.manifest) throw fault("Choose a trait kit recipe");
      sourceNames(body.manifest);
      const manifest = JSON.stringify(body.manifest);
      if (Buffer.byteLength(manifest) > 2_000_000)
        throw fault("Trait kit recipe exceeds 2 MB");
      await reapExpired();
      id = randomUUID();
      const now = Date.now();
      db.transaction(() => {
        if (
          db.query("SELECT COUNT(*) AS count FROM pack_creator_draft WHERE result IS NULL").get()
            .count >= limits.drafts
        )
          throw fault("Pack staging draft budget is full", 429);
        db.query(
          "INSERT INTO pack_creator_draft(id,owner,manifest,price,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6)",
        ).run(
          id,
          owner,
          manifest,
          body.settings.priceLamports,
          now,
          now + 24 * 60 * 60_000,
        );
      }).immediate();
    }
    return lease(id, owner, async (row) => {
      if (row.result) throw fault("This draft is already finalized", 409);
      if (
        row.price !== body.settings.priceLamports ||
        (body.manifest && JSON.stringify(body.manifest) !== row.manifest)
      )
        throw fault("Start a new draft after changing its kit or price", 409);
      const allowed = sourceNames(JSON.parse(row.manifest)),
        directory = path.join(root, id);
      await mkdir(directory, { recursive: true });
      for (const file of body.files) {
        object(file, ["name", "base64"]);
        const name = fileName(file.name);
        if (!allowed.has(name))
          throw fault("An uploaded file is not referenced by the kit");
        if (
          typeof file.base64 !== "string" ||
          file.base64.length > Math.ceil((MAX_IMAGE * 4) / 3) + 4 ||
          file.base64.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)
        )
          throw fault("Invalid bounded image encoding");
        const bytes = Buffer.from(file.base64, "base64");
        if (
          !bytes.length ||
          bytes.length > MAX_IMAGE ||
          bytes.toString("base64") !== file.base64
        )
          throw fault("Invalid bounded image encoding");
        const digest = hash(bytes),
          previous = db
            .query(
              "SELECT * FROM pack_creator_file WHERE draft_id=?1 AND name=?2",
            )
            .get(id, name);
        if (
          previous &&
          (previous.sha256 !== digest || previous.bytes !== bytes.length)
        )
          throw fault("An uploaded source image changed", 409);
        if (!previous)
          db.transaction(() => {
            const draft = db
              .query(
                "SELECT COALESCE(SUM(bytes),0) AS total,COUNT(*) AS count FROM pack_creator_file WHERE draft_id=?1",
              )
              .get(id);
            const stagedTotal = db
              .query(
                "SELECT COALESCE(SUM(f.bytes),0) AS total FROM pack_creator_file f JOIN pack_creator_draft d ON d.id=f.draft_id WHERE d.result IS NULL",
              )
              .get();
            if (
              draft.total + bytes.length > limits.draftBytes ||
              draft.count + 1 > MAX_FILES ||
              stagedTotal.total + bytes.length > limits.totalBytes
            )
              throw fault("Kit upload budget exceeded", 413);
            db.query(
              "INSERT INTO pack_creator_file(draft_id,name,sha256,bytes) VALUES(?1,?2,?3,?4)",
            ).run(id, name, digest, bytes.length);
          }).immediate();
        const destination = path.join(directory, name);
        await mkdir(path.dirname(destination), { recursive: true });
        const parent = await realpath(path.dirname(destination)),
          relative = path.relative(await realpath(directory), parent);
        if (
          relative === ".." ||
          relative.startsWith(".." + path.sep) ||
          path.isAbsolute(relative)
        )
          throw fault("Staged image path is outside this draft");
        try {
          if (hash(await readFile(destination)) !== digest)
            throw fault("Staged source does not match this draft", 409);
          continue;
        } catch (error: any) {
          if (error.code !== "ENOENT") throw error;
        }
        const temporary = destination + "." + randomUUID() + ".tmp";
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        await rename(temporary, destination);
      }
      if (body.final !== true) return { draftId: id, status: "uploading" };
      await network();
      const kit = await prepare(row);
      validateRenderableKit(kit);
      if (
        db
          .query(
            "UPDATE pack_creator_draft SET validated=1 WHERE id=?1 AND lease_token=?2",
          )
          .run(id, row.lease_token).changes !== 1
      )
        throw fault(
          "Pack draft lease changed; retry from its saved state",
          409,
        );
      const supply = kit.catalog.definitions.reduce(
        (sum: number, definition: any) => sum + definition.supply,
        0,
      );
      return {
        draftId: id,
        status: "validated",
        publicationKit: kit,
        summary: {
          itemCount: kit.edition.items.length,
          eligibleCount: kit.edition.items.filter((item: any) => item.dressable)
            .length,
          definitionCount: kit.catalog.definitions.length,
          initialSupply: supply,
          packCount: Math.floor(supply / 4),
          priceLamports: row.price,
        },
        cost: {
          description:
            "Creator signs source inscriptions, catalog setup and the disclosed operations reserve. Network fees and account rent are additional.",
          operationsReserveLamports: options.operationsReserveLamports,
          catalogSetupSignatures:
            Math.ceil(kit.catalog.definitions.length / 2) + 2,
        },
        publication: {
          owner,
          gateway: gateway.origin,
          expectedGenesis: options.expectedGenesis,
        },
      };
    });
  }
  function catalogSpec(row: any, actual: any, definitions: any[]) {
    return {
      program: options.program,
      nftProgram: options.nftProgram,
      collection: pubkey(actual.collection),
      registry: pubkey(actual.registry),
      authority: row.owner,
      treasury: pubkey(actual.treasury),
      provider: options.provider,
      providerTreasury: options.providerTreasury,
      price: row.price,
      window: options.window,
      timeout: options.timeout,
      definitions,
    };
  }
  async function verify(body: any, row: any) {
    if (!row.validated) throw fault("Check the trait kit before publishing");
    await network();
    const collection = pubkey(body.collection),
      registry = pubkey(body.registry);
    if (row.collection && row.collection !== collection)
      throw fault("This finalized draft belongs to another collection", 409);
    const actual = await options.readCollection(collection);
    if (
      !actual ||
      pubkey(actual.collection) !== collection ||
      pubkey(actual.registry) !== registry ||
      pubkey(actual.admin) !== row.owner
    )
      throw fault(
        "Collection registry authority does not match this draft",
        403,
      );
    const expected = PublicKey.findProgramAddressSync(
      [Buffer.from("registry"), new PublicKey(collection).toBuffer()],
      new PublicKey(options.nftProgram),
    )[0].toBase58();
    if (registry !== expected) throw fault("Wrong collection registry", 403);
    const kit = await prepare(row);
    if (actual.itemCount !== kit.edition.items.length)
      throw fault("Kit item count does not match the deployed collection");
    if (
      !Array.isArray(actual.items) ||
      actual.items.length !== kit.edition.items.length
    )
      throw fault("The immutable collection manifest is unavailable");
    for (const item of kit.edition.items) {
      const source = actual.items.find((entry: any) => entry.index === item.id);
      if (
        !source ||
        source.name !== item.name ||
        source.imageSha256 !== item.sha256
      )
        throw fault("Kit does not match the deployed collection images");
    }
    const checkpoint = structuredClone(
      body.publicationCheckpoint ?? body.checkpoint,
    );
    if (!checkpoint || typeof checkpoint !== "object")
      throw fault("Browser publication receipts are required");
    if (Buffer.byteLength(JSON.stringify(checkpoint)) > 250_000)
      throw fault("Publication receipts exceed their bound");
    // The finalizer only reads receipts. A missing receipt rejects before any
    // write is started or recorded as pending.
    const published = await publishRenderKit(
      kit,
      path.join(root, row.id),
      {
        gateway: gateway.origin,
        connection,
        expectedGenesis: options.expectedGenesis,
        owner: row.owner,
        saveCheckpoint: async () => {},
        beforeWrite: async () => {
          throw fault("Browser publication is incomplete");
        },
        readArtifact: options.readArtifact,
      },
      checkpoint,
    );
    const spec = catalogSpec(row, actual, published.definitions);
    const keys = addresses(
      new PublicKey(options.program),
      new PublicKey(collection),
    );
    const infos = await connection.getMultipleAccountsInfo(
      [keys.pool, keys.ops],
      "confirmed",
    );
    const [pool, ops] = infos;
    if (
      ops &&
      (!new PublicKey(ops.owner).equals(SystemProgram.programId) ||
        ops.data.length)
    )
      throw fault("Operations reserve account is invalid");
    const balance = ops?.lamports ?? 0;
    if (!Number.isSafeInteger(balance) || balance < 0)
      throw fault("Operations reserve balance is invalid");
    const plan = catalogSetup(spec, pool);
    const parsed = pool ? readPool(pool.data) : null;
    const deficit = row.result
      ? 0
      : Math.max(0, options.operationsReserveLamports - balance);
    if (deficit)
      plan.push({
        stage: "fund-operations",
        instruction: SystemProgram.transfer({
          fromPubkey: new PublicKey(row.owner),
          toPubkey: keys.ops,
          lamports: deficit,
        }),
      });
    if (!parsed || parsed.epochCount === 0)
      plan.push({
        stage: "open-epoch",
        instruction: instruction(new PublicKey(options.program), 1, [
          account(new PublicKey(row.owner), true, true),
          account(keys.pool, true),
          account(keys.epoch, true),
          account(SystemProgram.programId),
        ]),
      });
    return {
      collection,
      registry,
      kit,
      published,
      renderKitHash: checkpoint.artifacts["render-kit"].sha256,
      spec,
      pool: keys.pool.toBase58(),
      plan,
      deficit,
    };
  }
  function identity(body: any) {
    object(body, [
      "draftId",
      "owner",
      "collection",
      "registry",
      "publicationCheckpoint",
      "checkpoint",
      "sourceConsent",
      "collectionReceipt",
      "settings",
      "normalId",
    ]);
    if (body.sourceConsent !== true)
      throw fault("Review source publication before publishing packs");
    return pubkey(body.owner);
  }
  async function publish(body: any) {
    const owner = identity(body);
    return lease(body.draftId, owner, async (row) => {
      const checked = await verify(body, row);
      return {
        stage: "setup",
        draftId: row.id,
        collection: checked.collection,
        registry: checked.registry,
        pool: checked.pool,
        renderKit: checked.published.renderKit,
        appearance: checked.published.appearance,
        spec: checked.spec,
        plan: checked.plan.map(wire),
        cost: {
          operationsReserveTargetLamports: options.operationsReserveLamports,
          operationsFundingLamports: checked.deficit,
          ...packCharge(row.price),
          creatorPrice: row.price,
        },
      };
    });
  }
  async function finalize(body: any) {
    const owner = identity(body);
    return lease(body.draftId, owner, async (row) => {
      if (row.result) {
        if (pubkey(body.collection) !== row.collection)
          throw fault(
            "This finalized draft belongs to another collection",
            409,
          );
        const existing = await readVerifiedPublishedKit(row.collection);
        if (existing.registry !== pubkey(body.registry))
          throw fault("Wrong collection registry", 403);
        try {
          await options.onFinalized?.(row.collection);
        } catch {
          throw fault(
            "Pack confirmed; application registration is temporarily unavailable. Retry without redeploying.",
            503,
          );
        }
        return JSON.parse(get.get(row.id).result);
      }
      const checked = await verify(body, row);
      if (checked.plan.length)
        throw fault(
          "Catalog setup, reserve funding and initial epoch must confirm first",
          409,
        );
      const result = {
        stage: "confirmed",
        draftId: row.id,
        collection: checked.collection,
        registry: checked.registry,
        pool: checked.pool,
        renderKit: checked.published.renderKit,
        renderKitHash: checked.renderKitHash,
        appearance: checked.published.appearance,
        priceLamports: row.price,
      };
      if (
        db
          .query(
            "UPDATE pack_creator_draft SET collection=?2,result=?3 WHERE id=?1 AND lease_token=?4",
          )
          .run(
            row.id,
            checked.collection,
            JSON.stringify(result),
            row.lease_token,
          ).changes !== 1
      )
        throw fault(
          "Pack draft lease changed; recheck the confirmed setup",
          409,
        );
      try {
        await options.onFinalized?.(result.collection);
      } catch {
        throw fault(
          "Pack confirmed; application registration is temporarily unavailable. Retry without redeploying.",
          503,
        );
      }
      return result;
    });
  }
  async function readVerifiedPublishedKit(collection: string) {
    await network();
    collection = pubkey(collection);
    const row = db
      .query(
        "SELECT * FROM pack_creator_draft WHERE collection=?1 AND result IS NOT NULL LIMIT 1",
      )
      .get(collection);
    if (!row) throw fault("This collection has no confirmed pack setup", 404);
    const actual = await options.readCollection(collection);
    if (
      !actual ||
      pubkey(actual.collection) !== collection ||
      pubkey(actual.admin) !== row.owner
    )
      throw fault("Confirmed collection registry authority changed", 403);
    const finalized = JSON.parse(row.result);
    const signature = finalized.renderKit;
    if (
      typeof signature !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)
    )
      throw fault("Confirmed permanent recipe reference is invalid", 409);
    const raw = Buffer.from(await options.readArtifact(signature));
    if (
      raw.length > 8_000_000 ||
      (finalized.renderKitHash && hash(raw) !== finalized.renderKitHash)
    )
      throw fault("Confirmed permanent recipe hash changed", 409);
    const recipe = JSON.parse(raw.toString("utf8")),
      reviewed = JSON.parse(row.manifest);
    validateKitSchema(reviewed);
    object(recipe, [
      "schema",
      "config",
      "edition",
      "slotGroups",
      "definitions",
      "media",
      "appearance",
    ]);
    object(recipe.edition, ["sourceHashes", "maskSourceHashes", "items"]);
    if (
      !Array.isArray(recipe.edition.items) ||
      !recipe.media ||
      typeof recipe.media !== "object" ||
      Array.isArray(recipe.media)
    )
      throw fault("Confirmed permanent recipe is invalid", 409);
    const files = db
      .query(
        "SELECT name,sha256,bytes FROM pack_creator_file WHERE draft_id=?1",
      )
      .all(row.id);
    const layers = new Set(
      reviewed.config.groups
        .flatMap((group: any) => group.assets.map((source: any) => source.file))
        .filter(Boolean),
    );
    const kit = {
      schema: recipe.schema,
      config: recipe.config,
      edition: {
        ...recipe.edition,
        items: recipe.edition.items.map((item: any) => {
          object(item, [
            "id",
            "name",
            "bodyClass",
            "dressable",
            "sha256",
            "sourceDna",
          ]);
          return {
            id: item.id,
            name: item.name,
            bodyClass: item.bodyClass,
            dressable: item.dressable,
            sha256: item.sha256,
            file: reviewed.items[item.id - 1]?.file,
            sourceDna: item.sourceDna,
          };
        }),
      },
      catalog: {
        slotGroups: recipe.slotGroups,
        definitions: recipe.definitions,
      },
      appearance: recipe.appearance,
      files: files.map((file: any) => ({
        file: file.name,
        sha256: file.sha256,
        bytes: file.bytes,
        kind: layers.has(file.name) ? "layer" : "base",
        mime:
          recipe.media[file.name]?.mime ??
          (file.name.endsWith(".webp") ? "image/webp" : "image/png"),
      })),
    };
    assertReviewedKit(reviewed, kit);
    // Trait metadata is already committed by the sealed pool. Bind each shared
    // recipe to that exact permanent R and its original layer, not staging files.
    const keys = addresses(
      new PublicKey(options.program),
      new PublicKey(collection),
    );
    const [poolInfo] = await connection.getMultipleAccountsInfo(
      [keys.pool],
      "confirmed",
    );
    if (!poolInfo) throw fault("Confirmed pack catalog is unavailable", 409);
    const pool = readPool(poolInfo.data),
      definitions = [];
    for (const definition of kit.catalog.definitions) {
      const sealed = pool.definitions[definition.id];
      if (!sealed) throw fault("Confirmed trait catalog is incomplete", 409);
      const uri = new URL(sealed.uri);
      const prefix = new URL("/token-meta/", gateway).href;
      if (
        !uri.href.startsWith(prefix) ||
        uri.username ||
        uri.password ||
        uri.search ||
        uri.hash
      )
        throw fault("Trait metadata gateway changed", 409);
      const M = uri.pathname.slice("/token-meta/".length);
      if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(M))
        throw fault("Invalid confirmed trait metadata reference", 409);
      const bytes = Buffer.from(await options.readArtifact(M));
      if (bytes.length > 65536 || hash(bytes) !== sealed.hash)
        throw fault("Confirmed trait metadata hash changed", 409);
      const metadata = JSON.parse(bytes.toString("utf8"));
      const source = kit.config.groups
        .flatMap((group: any) => group.assets)
        .find((source: any) => source.id === definition.sourceId);
      if (
        metadata.name !== definition.name ||
        metadata.properties?.iqTraitKit !== signature ||
        metadata.properties?.definition !== definition.id ||
        metadata.properties?.iqLayer !== recipe.media[source?.file]?.signature
      )
        throw fault(
          "Confirmed trait metadata does not match its permanent recipe",
          409,
        );
      definitions.push({ ...definition, uri: sealed.uri, hash: sealed.hash });
    }
    if (catalogSetup(catalogSpec(row, actual, definitions), poolInfo).length)
      throw fault("Confirmed pack catalog no longer matches its recipe", 409);
    if (!finalized.renderKitHash) {
      // Legacy local finalized rows can be pinned after the same reviewed
      // recipe and sealed-metadata checks; no image staging is needed.
      finalized.renderKitHash = hash(raw);
      db.query(
        "UPDATE pack_creator_draft SET result=?2 WHERE id=?1 AND result=?3",
      ).run(row.id, JSON.stringify(finalized), row.result);
    }
    return {
      collection,
      registry: pubkey(actual.registry),
      owner: row.owner,
      renderKit: signature,
      renderKitHash: hash(raw),
      kit,
      recipe,
      published: {
        renderKit: signature,
        definitions,
        appearance: finalized.appearance,
      },
      spec: catalogSpec(row, actual, definitions),
    };
  }
  function listFinalized() {
    return db
      .query(
        "SELECT DISTINCT collection FROM pack_creator_draft WHERE collection IS NOT NULL AND result IS NOT NULL ORDER BY collection",
      )
      .all()
      .map((row: any) => pubkey(row.collection));
  }
  async function outfitContext({
    collection,
    asset,
    owner,
  }: {
    collection: string;
    asset: string;
    owner: string;
  }) {
    collection = pubkey(collection);
    asset = pubkey(asset);
    owner = pubkey(owner);
    if (!options.readAsset)
      throw fault("Creator and holder consent is not configured", 503);
    const nft = await options.readAsset(asset);
    if (!nft) throw fault("This NFT is not registered for outfits", 404);
    if (pubkey(nft.collection) !== collection || pubkey(nft.owner) !== owner)
      throw fault("The current registered holder must approve this NFT", 403);
    const verified = await readVerifiedPublishedKit(collection),
      kit = verified.kit;
    const item = kit.edition.items.find((item: any) => item.id === nft.index);
    if (!item?.dressable || nft.imageSha256 !== item.sha256)
      throw fault("This NFT does not match an eligible reviewed recipe", 403);
    return {
      program: options.program,
      nftProgram: options.nftProgram,
      collection,
      admin: verified.owner,
      owner,
      asset,
      inscription: nft.inscription,
      bodyClass: item.bodyClass,
      metadataUri: new URL(
        "/wardrobe/metadata/" + asset,
        options.outfitBase ?? gateway,
      ).href,
    };
  }
  const apiError = (error: any) => {
    const controlled =
      Number.isInteger(error?.status) &&
      error.status >= 400 &&
      error.status <= 599;
    const message = controlled
      ? String(error?.message ?? "Pack request could not complete")
      : "Pack setup could not complete; preserve its receipt and retry";
    return Response.json(
      {
        error:
          /ENOENT|\/Users\/|secretKey|privateKey|SQLITE|https?:\/\/|api.?key=|Bearer/.test(
            message,
          )
            ? "Pack setup needs a fresh checked draft"
            : message.slice(0, 240),
      },
      {
        status: controlled ? error.status : 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  };
  const handle = async (request: Request) => {
    const url = new URL(request.url);
    try {
      if (
        request.method === "GET" &&
        url.pathname === "/creator/packs/outfit-context"
      ) {
        if (
          [...url.searchParams.keys()].some(
            (key) => !["collection", "asset", "owner"].includes(key),
          )
        )
          throw fault("Unexpected consent parameters");
        return Response.json(
          await outfitContext({
            collection: url.searchParams.get("collection") ?? "",
            asset: url.searchParams.get("asset") ?? "",
            owner: url.searchParams.get("owner") ?? "",
          }),
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      const match = /^\/creator\/packs\/(validate|publish|finalize)$/.exec(
        url.pathname,
      );
      if(url.pathname==='/creator/packs/auth') {
        if(!auth)throw fault('Creator authentication is not configured',503);
        return Response.json(await auth.handle(request),{headers:{'Cache-Control':'no-store'}});
      }
      if (!match) return Response.json({ error: "Not found" }, { status: 404 });
      if (request.method !== "POST")
        return Response.json({ error: "POST required" }, { status: 405 });
      if(!auth)throw fault('Creator authentication is not configured',503);
      const authenticatedOwner=auth.owner(request);
      if (
        url.search ||
        request.headers.get("content-type")?.split(";")[0] !==
          "application/json"
      )
        throw fault("JSON body required");
      const reader = request.body?.getReader();
      if (!reader) throw fault("JSON body required");
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_REQUEST)
            throw fault("Pack creator request exceeds 32 MB", 413);
          parts.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if(body?.owner!==authenticatedOwner)throw fault('Creator session wallet does not match this request',403);
      return Response.json(
        await { validate, publish, finalize }[match[1]](body),
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return apiError(error);
    }
  };
  return {
    validate,
    publish,
    finalize,
    outfitContext,
    readVerifiedPublishedKit,
    listFinalized,
    reapExpired,
    handle,
  };
}
