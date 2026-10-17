// The marketplace metadata JSON that gets inscribed as M. Built here, in one
// fixed key order, so the verifier can compare the inscribed bytes to this exact
// string. Everything comes from the item template plus the image inscription C.

import { config } from "./config.ts";
import type { CollectionRow, ItemRow } from "./db.ts";

export function imageUrl(c: string): string {
  return `${config.gatewayBase}/img/${c}.png`;
}

export function assetUri(m: string): string {
  return `${config.gatewayBase}/nft/${m}`;
}

export function buildMetadata(collection: CollectionRow, item: ItemRow, c: string): string {
  const template = JSON.parse(item.template) as {
    name?: string;
    description?: string;
    attributes?: { trait_type: string; value: string | number }[];
  };
  const image = imageUrl(c);
  return JSON.stringify({
    name: item.name,
    symbol: collection.symbol,
    description: template.description ?? collection.description,
    image,
    external_url: `https://solscan.io/tx/${c}`,
    attributes: [
      ...(template.attributes ?? []).map((a) => ({ trait_type: a.trait_type, value: a.value })),
      { trait_type: "inscription", value: c },
      { trait_type: "kind", value: "image" },
      { trait_type: "chain", value: "solana" },
    ],
    properties: {
      files: [
        { uri: image, type: item.image_mime },
        { uri: `${config.arweaveGateway}/${item.arweave_id}`, type: item.image_mime },
      ],
      category: "image",
    },
  });
}
