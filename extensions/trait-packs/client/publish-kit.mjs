import { sha256 } from "@noble/hashes/sha256";
import { Buffer } from "buffer";
import bs58 from "bs58";
const hash = (bytes) =>
  Buffer.from(
    sha256(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes),
  ).toString("hex");

// Shared publication graph, used after host kit validation. Browser sources
// are read from the user's selected Files, not fetched from arbitrary URLs.
// The finalizer must independently verify this result against the validated kit.
export async function publishKitArtifacts(
  input,
  readSource,
  context,
  checkpoint,
) {
  const kit = structuredClone(input);
  if (
    kit?.schema !== "iq-trait-kit/1" ||
    !Array.isArray(kit.files) ||
    kit.files.length > 11000
  )
    throw Error("Invalid validated publication kit");
  const gateway = new URL(context.gateway);
  if (
    !["https:", "http:"].includes(gateway.protocol) ||
    gateway.username ||
    gateway.password ||
    gateway.search ||
    gateway.hash
  )
    throw Error("Invalid gateway origin");
  if ((await context.connection.getGenesisHash()) !== context.expectedGenesis)
    throw Error("Wrong publication chain");
  const digest = hash(
    JSON.stringify({
      kit,
      owner: context.owner,
      genesis: context.expectedGenesis,
      gateway: gateway.origin,
    }),
  );
  if (checkpoint.digest && checkpoint.digest !== digest)
    throw Error(
      "This kit changed; preserve the old checkpoint and start a new draft",
    );
  checkpoint.digest = digest;
  checkpoint.artifacts ??= {};
  const signature = (value) => {
    if (
      typeof value !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value) ||
      bs58.decode(value).length !== 64
    )
      throw Error("Invalid confirmed inscription signature");
    return value;
  };
  async function store(key, bytes, name) {
    const expected = hash(bytes),
      existing = checkpoint.artifacts[key];
    if (existing) {
      if (existing.sha256 !== expected)
        throw Error("Checkpoint content changed");
      const actual = await context.readArtifact(signature(existing.signature));
      if (hash(actual) !== expected)
        throw Error("Saved inscription does not match its expected bytes");
      return existing.signature;
    }
    let sig;
    if (checkpoint.pending) {
      if (
        checkpoint.pending.key !== key ||
        checkpoint.pending.sha256 !== expected
      )
        throw Error("Another inscription outcome needs recovery first");
      if (!checkpoint.pending.signature)
        throw Error(
          "Previous write outcome is unknown; recover its receipt before retrying",
        );
      sig = signature(checkpoint.pending.signature);
    } else {
      checkpoint.pending = { key, sha256: expected };
      await context.saveCheckpoint(checkpoint);
      // If this throws, pending stays set. Never silently repeat an ambiguous write.
      try {
        sig = signature(await context.writeArtifact(bytes, name));
      } catch (error) {
        if (error.signature) {
          checkpoint.pending.signature = signature(error.signature);
          await context.saveCheckpoint(checkpoint);
        }
        throw error;
      }
      checkpoint.pending.signature = sig;
      await context.saveCheckpoint(checkpoint);
    }
    const actual = await context.readArtifact(sig);
    if (hash(actual) !== expected)
      throw Error("Confirmed inscription bytes did not match");
    checkpoint.artifacts[key] = { signature: sig, sha256: expected };
    delete checkpoint.pending;
    await context.saveCheckpoint(checkpoint);
    return sig;
  }
  const files = Object.create(null);
  for (const entry of kit.files) {
    // Original edition images keep the existing lazy-mint/staging path. Only
    // shared layers/masks and explicitly chosen pack branding go up here.
    if (
      entry.kind === "base" &&
      entry.file !== kit.appearance.coverFile &&
      entry.file !== kit.appearance.logoFile
    )
      continue;
    const bytes = Buffer.from(await readSource(entry.file));
    if (hash(bytes) !== entry.sha256)
      throw Error("Source image changed after review");
    const row = Buffer.from(
      JSON.stringify({
        kind: "image",
        body: "data:" + entry.mime + ";base64," + bytes.toString("base64"),
        who: context.owner,
      }),
    );
    const C = await store("image:" + entry.file, row, "trait-image.json");
    files[entry.file] = {
      signature: C,
      sha256: entry.sha256,
      mime: entry.mime,
      url: new URL("/img/" + C, gateway).href,
    };
  }
  const renderManifest = {
    schema: kit.schema,
    config: kit.config,
    edition: {
      ...kit.edition,
      items: kit.edition.items.map(({ file, ...item }) => item),
    },
    slotGroups: kit.catalog.slotGroups,
    definitions: kit.catalog.definitions,
    media: files,
    appearance: kit.appearance,
  };
  const recipeBytes = Buffer.from(JSON.stringify(renderManifest)),
    R = await store("render-kit", recipeBytes, "trait-kit.json");
  const definitions = [];
  for (const definition of kit.catalog.definitions) {
    const source = kit.config.groups
        .flatMap((group) => group.assets)
        .find((asset) => asset.id === definition.sourceId),
      image = files[source.file];
    if (!image) throw Error("Missing published trait source");
    const metadata = {
      name: definition.name,
      image: image.url,
      attributes: [
        { trait_type: "Equipment slot", value: definition.slot },
        { trait_type: "Initial supply", value: definition.supply },
        ...(definition.creatorTier
          ? [{ trait_type: "Creator tier", value: definition.creatorTier }]
          : []),
      ],
      properties: {
        category: "image",
        files: [{ uri: image.url, type: image.mime }],
        iqTraitKit: R,
        definition: definition.id,
        iqLayer: image.signature,
      },
    };
    const bytes = Buffer.from(JSON.stringify(metadata)),
      M = await store(
        "metadata:" + definition.id,
        bytes,
        "trait-" + definition.id + ".json",
      );
    definitions.push({
      ...definition,
      uri: new URL("/token-meta/" + M, gateway).href,
      hash: hash(bytes),
    });
  }
  return {
    renderKit: R,
    definitions,
    appearance: {
      title: kit.appearance.title,
      subtitle: kit.appearance.subtitle,
      accent: kit.appearance.accent,
      cover: kit.appearance.coverFile
        ? files[kit.appearance.coverFile]?.url
        : null,
      logo: kit.appearance.logoFile
        ? files[kit.appearance.logoFile]?.url
        : null,
    },
    artifacts: Object.keys(checkpoint.artifacts).length,
  };
}
