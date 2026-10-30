import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";
import { Buffer } from "buffer";
const digest = (bytes) => Buffer.from(sha256(bytes)).toString("hex");
const address = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const slots = [
  "Hair",
  "Clothing",
  "Headwear",
  "Accessory",
  "Background",
  "Border",
];

// Read adapters are the host's existing Core/IQ gateway/SDK readers, already
// bounded by its RPC budget. No arbitrary metadata URL is fetched here.
export function createOutfitView({
  origin,
  program,
  collection,
  readAsset,
  wardrobe,
  readBaseMetadata,
  render,
}) {
  const host = new URL(origin);
  if (
    host.origin !== origin ||
    host.username ||
    host.password ||
    !(
      host.protocol === "https:" ||
      (host.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(host.hostname))
    )
  )
    throw Error("Invalid outfit origin");
  const bases = new Map();
  async function state(id) {
    if (!address.test(id))
      throw Object.assign(Error("Invalid NFT address"), { status: 400 });
    const [asset, equipment] = await Promise.all([
      readAsset(id),
      wardrobe.read(id),
    ]);
    if (
      asset.updateAuthority?.type !== "Collection" ||
      asset.updateAuthority.address !== collection
    )
      throw Object.assign(Error("Wrong NFT collection"), { status: 409 });
    const name = Buffer.from(asset.name),
      uri = Buffer.from(asset.uri),
      n = Buffer.alloc(4),
      u = Buffer.alloc(4);
    n.writeUInt32LE(name.length);
    u.writeUInt32LE(uri.length);
    if (digest(Buffer.concat([n, name, u, uri])) !== equipment.loadout.baseHash)
      throw Object.assign(Error("Bound NFT identity changed"), { status: 409 });
    const hex = asset.attributes?.attributeList.find(
      (a) => a.key === "metadata",
    )?.value;
    if (!/^[a-fA-F0-9]{128}$/.test(hex ?? ""))
      throw Object.assign(Error("Missing IQ metadata reference"), {
        status: 409,
      });
    const signature = bs58.encode(Buffer.from(hex, "hex"));
    if (!bases.has(signature)) {
      const entry = {};
      entry.work = Promise.resolve()
        .then(() => readBaseMetadata(signature))
        .then((raw) => {
          const bytes = Buffer.from(raw);
          if (bytes.length > 65536)
            throw Error("Original metadata exceeds read budget");
          const base = JSON.parse(bytes.toString("utf8"));
          if (
            !base ||
            typeof base !== "object" ||
            Array.isArray(base) ||
            !Array.isArray(base.attributes ?? []) ||
            (base.attributes ?? []).length > 256
          )
            throw Error("Invalid original metadata");
          return base;
        })
        .catch((error) => {
          if (bases.get(signature) === entry) bases.delete(signature);
          throw error;
        });
      bases.set(signature, entry);
      if (bases.size > 128) bases.delete(bases.keys().next().value);
    }
    const base = await bases.get(signature).work;
    if (base.name !== asset.name)
      throw Object.assign(Error("Original NFT name differs"), { status: 409 });
    return { ...equipment, asset, base, metadataSignature: signature };
  }
  async function metadata(id) {
    const s = await state(id),
      base = structuredClone(s.base),
      image = `${origin}/wardrobe/image/${id}?r=${s.loadout.revision}&h=${s.loadoutHash}`;
    return {
      ...base,
      image,
      attributes: [
        ...(base.attributes ?? []),
        ...s.loadout.definitionIds.flatMap((id, slot) => {
          if (id === 255) return [];
          const d = s.pool.definitions[id];
          if (!d || d.slot !== slot)
            throw Object.assign(Error("Invalid equipped trait"), {
              status: 409,
            });
          return [{ trait_type: "Equipped " + slots[slot], value: d.name }];
        }),
      ],
      properties: {
        ...base.properties,
        files: [{ uri: image, type: "image/webp" }],
        iqBaseMetadata: s.metadataSignature,
        iqLoadout: {
          program,
          revision: s.loadout.revision,
          hash: s.loadoutHash,
        },
      },
    };
  }
  async function image(id, revision, hash) {
    const s = await state(id);
    if (
      !/^(0|[1-9][0-9]{0,9})$/.test(String(revision)) ||
      Number(revision) !== s.loadout.revision ||
      hash !== s.loadoutHash
    )
      throw Object.assign(Error("Outfit changed; refresh NFT metadata"), {
        status: 409,
      });
    return render({ address: id, ...s });
  }
  // Fetch-standard adapter is usable in the existing gateway/router. Caller
  // applies its normal request/rate limits; immutable IQ routes are unaffected.
  async function handle(request) {
    const url = new URL(request.url),
      match = url.pathname.match(/^\/wardrobe\/(metadata|image)\/([^/]+)$/);
    if (!match) return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    try {
      const bytes =
        match[1] === "metadata"
          ? JSON.stringify(await metadata(match[2]))
          : await image(
              match[2],
              url.searchParams.get("r"),
              url.searchParams.get("h"),
            );
      return new Response(request.method === "HEAD" ? null : bytes, {
        headers: {
          "Content-Type":
            match[1] === "metadata"
              ? "application/json; charset=utf-8"
              : "image/webp",
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      const status = [400, 409].includes(error.status) ? error.status : 503;
      return Response.json(
        {
          error:
            status === 503
              ? "Outfit data is temporarily unavailable"
              : error.message,
        },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    }
  }
  return {
    state,
    metadata,
    image,
    handle,
    invalidate: (id) => wardrobe.invalidate(id),
  };
}
