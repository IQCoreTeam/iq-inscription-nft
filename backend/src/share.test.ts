import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createSharePages } from './share.ts';
import { networkFor } from './networks.ts';
import type { CollectionRow, ItemRow } from './db.ts';

const logo = 'L'.repeat(88), minted = 'M'.repeat(88), assetImage = 'N'.repeat(88);
const collection = { slug: 'test', name: 'Art <script>alert("x")</script> & friends', description: 'A "quoted" description <&>', logo_sig: logo } as CollectionRow;
const item = { name: 'Item <1> "one"' } as ItemRow;
function fixture(cluster: 'mainnet' | 'devnet' = 'mainnet', siteBase = 'https://iqlabs.dev', logoSig: string | null = logo) {
  const calls: string[] = [];
  const app = new Hono();
  app.route('/share', createSharePages({ cluster, siteBase, gatewayBase: networkFor(cluster).gatewayBase }, {
    getCollection: (slug) => { calls.push('collection:' + slug); return slug === 'test' ? { ...collection, logo_sig: logoSig } : null; },
    getItem: (slug, index) => { calls.push('item:' + slug + ':' + index); return index === 1 ? item : null; },
    getAssetSlot: (address) => { calls.push('asset:' + address); return address === 'known' || address === 'single' ? { slug: 'test', item_index: address === 'single' ? 0 : 1, inscription_sig: assetImage } : null; },
    latestMintSignature: (slug) => { calls.push('latest:' + slug); return minted; },
  }));
  return { app, calls };
}

test('share HTML has distinct launchpad, collection, and asset cards without RPC or image fetches', async () => {
  const { app, calls } = fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('share handler must never fetch'); }) as typeof fetch;
  try {
    const home = await app.request('/share');
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type')).toContain('text/html');
    expect(home.headers.get('cache-control')).toBe('public, max-age=60');
    const homeHtml = await home.text();
    expect(homeHtml).toContain('<title>IQ Labs NFT Launchpad</title>');
    expect(homeHtml).toContain('href="https://iqlabs.dev/?menu=nft"');
    expect(homeHtml).not.toContain('property="og:image"');
    expect(calls).toEqual([]);
    const colHtml = await (await app.request('/share/c/test')).text();
    expect(colHtml).toContain('Art &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; friends');
    expect(colHtml).toContain('A &quot;quoted&quot; description &lt;&amp;&gt;');
    expect(colHtml).not.toContain('<script>alert');
    expect(colHtml).toContain('href="https://iqlabs.dev/?menu=nft&amp;nft=test"');
    expect(colHtml).toContain(`content="https://gateway.iqlabs.dev/render/${logo}?v=media-3"`);
    expect(calls).toEqual(['collection:test']);
    calls.length = 0;
    const assetHtml = await (await app.request('/share/asset/known')).text();
    expect(assetHtml).toContain('<title>Item &lt;1&gt; &quot;one&quot;</title>');
    expect(assetHtml).toContain('href="https://iqlabs.dev/?menu=nft&amp;asset=known"');
    expect(assetHtml).toContain(`content="https://gateway.iqlabs.dev/render/${assetImage}?v=media-3"`);
    expect(assetHtml).toContain('name="twitter:card" content="summary_large_image"');
    expect(calls).toEqual(['asset:known', 'collection:test', 'item:test:1']);
  } finally { globalThis.fetch = originalFetch; }
});

test('unknown ids return 404 after one lookup; no fallback cards', async () => {
  for (const route of ['/share/c/missing', '/share/asset/missing']) {
    const { app, calls } = fixture();
    const response = await app.request(route);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('og:title');
    expect(calls.length).toBe(1);
  }
});

test('missing or invalid logo uses a known minted cover, not a stored remote URL', async () => {
  for (const badLogo of [null, 'https://attacker.invalid/tracker.png']) {
    const { app, calls } = fixture('mainnet', 'https://iqlabs.dev', badLogo);
    const html = await (await app.request('/share/c/test')).text();
    expect(html).toContain(`/render/${minted}?v=media-3`);
    expect(html).not.toContain('attacker.invalid');
    expect(calls).toEqual(['collection:test', 'latest:test']);
  }
});

test('devnet uses its gateway and explicitly configured frontend without invented network parameters', async () => {
  const { app } = fixture('devnet', 'https://dev.example.test/app/');
  const html = await (await app.request('/share/c/test')).text();
  expect(html).toContain(`https://dev-gateway.iqlabs.dev/render/${logo}?v=media-3`);
  expect(html).toContain('href="https://dev.example.test/app/?menu=nft&amp;nft=test"');
  expect(html).toContain('Solana devnet');
  expect(html).not.toContain('cluster=');
  expect(html).not.toContain('net=');
});

test('single-NFT slots without an item template use the actual asset address as title', async () => {
  const { app } = fixture();
  const html = await (await app.request('/share/asset/single')).text();
  expect(html).toContain('<title>single</title>');
  expect(html).not.toContain('Item #0');
});

test('unsafe deployment URLs fail configuration validation', () => {
  expect(() => createSharePages({ cluster: 'mainnet', siteBase: 'javascript:alert(1)', gatewayBase: 'https://gateway.iqlabs.dev' }, {} as never)).toThrow();
});


test('browser redirect targets the encoded frontend canonical and serves identical HTML to crawlers', async () => {
  const { app } = fixture('mainnet', 'https://iqlabs.dev/a%22%3Cscript%3E/');
  const browserHtml = await (await app.request('/share/c/test', { headers: { 'user-agent': 'Browser' } })).text();
  const crawlerHtml = await (await app.request('/share/c/test', { headers: { 'user-agent': 'TelegramBot' } })).text();
  expect(browserHtml).toBe(crawlerHtml);
  const script = browserHtml.match(/<script>window\.location\.replace\((.*?)\);<\/script>/)?.[1];
  expect(script).toBeDefined();
  const target = JSON.parse(script!);
  expect(target).toBe('https://iqlabs.dev/a%22%3Cscript%3E/?menu=nft&nft=test');
  expect(script).not.toContain('<');
  expect(browserHtml).toContain('href="https://iqlabs.dev/a%22%3Cscript%3E/?menu=nft&amp;nft=test"');
  expect(browserHtml).not.toContain('Art <script>');
});
