// HTML previews over the registry mirror. No RPC, wallet, remote metadata,
// image fetch, or rarity scan belongs in this request path.
import { Hono } from "hono";
import type { CollectionRow, ItemRow } from "./db.ts";

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
// Only known inscription transaction signatures produce media URLs, never a
// stored remote image URL. Empty/invalid signatures leave the card text-only.
const signature = (value: string | null) => value && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value) ? value : null;

export function createSharePages(
  settings: { siteBase: string; gatewayBase: string; cluster: string },
  data: {
    getCollection(slug: string): CollectionRow | null;
    getItem(slug: string, index: number): ItemRow | null;
    getAssetSlot(address: string): { slug: string; item_index: number; inscription_sig: string } | null;
    latestMintSignature(slug: string): string | null;
  },
) {
  const app = new Hono();
  const site = new URL(settings.siteBase);
  const gateway = new URL(settings.gatewayBase);
  for (const url of [site, gateway]) {
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('share URLs must be HTTP(S) URLs without credentials');
  }
  const frontend = (params: Record<string, string>) => {
    const url = new URL(site);
    url.search = new URLSearchParams({ menu: 'nft', ...params }).toString();
    url.hash = '';
    return url.href;
  };
  function html(title: string, description: string, url: string, inscription: string | null = null) {
    const sig = signature(inscription);
    const image = sig ? `${gateway.href.replace(/\/$/, '')}/render/${sig}?v=media-3` : null;
    const redirect = JSON.stringify(url).replace(/</g, "\\u003c");
    const meta = (name: string, value: string, property = false) => `<meta ${property ? 'property' : 'name'}="${name}" content="${escape(value)}">`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><link rel="canonical" href="${escape(url)}">
${meta('description', description)}${meta('og:type', 'website', true)}${meta('og:title', title, true)}${meta('og:description', description, true)}${meta('og:url', url, true)}
${meta('twitter:card', image ? 'summary_large_image' : 'summary')}${meta('twitter:title', title)}${meta('twitter:description', description)}
${image ? meta('og:image', image, true) + meta('twitter:image', image) + meta('og:image:alt', title, true) + meta('twitter:image:alt', title) : ''}
</head><body><main><h1>${escape(title)}</h1><p>${escape(description)}</p><p>Solana ${escape(settings.cluster)}</p><a href="${escape(url)}">Open NFT launchpad</a></main><script>window.location.replace(${redirect});</script></body></html>`;
  }
  // No collection listing on the launchpad preview, and no invented cover art.
  app.get('/', (c) => {
    c.header('Cache-Control', 'public, max-age=60');
    return c.html(html('IQ Labs NFT Launchpad', 'Inscription NFTs on Solana.', frontend({})));
  });
  app.get('/c/:slug', (c) => {
    const collection = data.getCollection(c.req.param('slug'));
    if (!collection) return c.notFound();
    const cover = signature(collection.logo_sig) || data.latestMintSignature(collection.slug);
    c.header('Cache-Control', 'public, max-age=60');
    return c.html(html(collection.name, collection.description, frontend({ nft: collection.slug }), cover));
  });
  app.get('/asset/:address', (c) => {
    const address = c.req.param('address');
    const slot = data.getAssetSlot(address);
    if (!slot) return c.notFound();
    const collection = data.getCollection(slot.slug);
    const item = data.getItem(slot.slug, slot.item_index);
    c.header('Cache-Control', 'public, max-age=60');
    return c.html(html(item?.name || address, collection?.description || '', frontend({ asset: address }), slot.inscription_sig));
  });
  return app;
}
