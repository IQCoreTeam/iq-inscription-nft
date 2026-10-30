import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha256";
import { createOutfitView } from "../outfit-view.mjs";
const digest = (b) => Buffer.from(sha256(b)).toString("hex"),
  id = "11111111111111111111111111111112",
  collection = "11111111111111111111111111111113";
function fixture() {
  const name = "Synthetic #1",
    uri = "https://example.invalid/original",
    n = Buffer.alloc(4),
    u = Buffer.alloc(4);
  n.writeUInt32LE(Buffer.byteLength(name));
  u.writeUInt32LE(Buffer.byteLength(uri));
  let revision = 0,
    reads = 0,
    rendered = 0,
    failure = false;
  const original = {
    name,
    image: "https://example.invalid/base.webp",
    attributes: [{ trait_type: "Original", value: "yes" }],
  };
  const asset = {
    name,
    uri,
    updateAuthority: { type: "Collection", address: collection },
    attributes: {
      attributeList: [{ key: "metadata", value: "ab".repeat(64) }],
    },
  };
  const wardrobe = {
    async read() {
      return {
        pool: { definitions: [{ slot: 0, name: "Synthetic hair" }] },
        loadout: {
          baseHash: digest(
            Buffer.concat([n, Buffer.from(name), u, Buffer.from(uri)]),
          ),
          revision,
          definitionIds: [revision ? 0 : 255, 255, 255, 255, 255, 255],
        },
        loadoutHash: "cd".repeat(32),
      };
    },
    invalidate() {},
  };
  const view = createOutfitView({
    origin: "http://127.0.0.1:4547",
    program: "test",
    collection,
    readAsset: async () => {
      if (failure) throw Error("private RPC token and operator path");
      return asset;
    },
    wardrobe,
    readBaseMetadata: async () => {
      reads++;
      return JSON.stringify(original);
    },
    render: async () => {
      rendered++;
      return Buffer.from("synthetic webp");
    },
  });
  return {
    view,
    asset,
    original,
    get reads() {
      return reads;
    },
    get rendered() {
      return rendered;
    },
    equip() {
      revision++;
    },
    fail() {
      failure = true;
    },
  };
}
test("derived view preserves immutable references and reuses cached base metadata", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.view.metadata(id), f.view.metadata(id)]);
  assert.equal(f.reads, 1);
  assert.equal(a.properties.iqBaseMetadata, b.properties.iqBaseMetadata);
  assert.equal(f.original.image, "https://example.invalid/base.webp");
  f.equip();
  const equipped = await f.view.metadata(id);
  assert(equipped.attributes.some((a) => a.trait_type === "Equipped Hair"));
  assert.notEqual(a.image, equipped.image);
  assert.equal(f.reads, 1);
  const old = new URL(a.image);
  const response = await f.view.handle(new Request(old));
  assert.equal(response.status, 409);
  assert.equal(f.rendered, 0);
  const image = await f.view.handle(new Request(equipped.image));
  assert.equal(image.status, 200);
  assert.equal(await image.text(), "synthetic webp");
  assert.equal(f.rendered, 1);
});
test("route sanitizes transient errors and restricts method/path/address", async () => {
  const f = fixture();
  assert.equal(
    (await f.view.handle(new Request("http://127.0.0.1:4547/other"))).status,
    404,
  );
  assert.equal(
    (
      await f.view.handle(
        new Request("http://127.0.0.1:4547/wardrobe/metadata/bad"),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.view.handle(
        new Request("http://127.0.0.1:4547/wardrobe/metadata/" + id, {
          method: "POST",
        }),
      )
    ).status,
    405,
  );
  f.fail();
  const response = await f.view.handle(
    new Request("http://127.0.0.1:4547/wardrobe/metadata/" + id),
  );
  assert.equal(response.status, 503);
  assert(!(await response.text()).includes("token"));
  assert.equal(response.headers.get("cache-control"), "no-store");
});
test("base URI, collection and metadata identity changes fail closed", async () => {
  const f = fixture();
  f.asset.uri = "https://example.invalid/replaced";
  await assert.rejects(() => f.view.metadata(id), /identity changed/);
  const c = fixture();
  c.asset.updateAuthority.address = id;
  await assert.rejects(() => c.view.metadata(id), /collection/);
  const m = fixture();
  m.asset.attributes.attributeList[0].value = "not-a-signature";
  await assert.rejects(() => m.view.metadata(id), /metadata reference/);
});
