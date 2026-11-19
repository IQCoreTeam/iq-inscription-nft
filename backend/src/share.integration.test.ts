import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';

// Follow the existing backend tests: temporary SQLite and a generated fixture
// signer only; never open an operator database or registrar file.
const dir = mkdtempSync(join(tmpdir(), 'nft-share-test-'));
process.env.DB_PATH = join(dir, 'test.sqlite');
process.env.REGISTRAR_KEYPAIR = join(dir, 'registrar.json');
writeFileSync(process.env.REGISTRAR_KEYPAIR, JSON.stringify(Array.from(Keypair.generate().secretKey)));
const { db } = await import('./db.ts');
const { recordCollection } = await import('./creator.ts');
const { getAssetSlot, latestMintSignature } = await import('./collections.ts');
const { app } = await import('./server.ts');

test('mounted share routes use SQLite helpers while incumbent asset JSON stays compatible', async () => {
  const slug = 'share-integration';
  const sig = 'S'.repeat(88);
  const address = Keypair.generate().publicKey.toBase58();
  recordCollection({
    spec: { slug, name: 'Cached collection', symbol: 'CACHE', description: 'From the mirror', price: 0, deposit: 0, royaltyBps: 0, sequential: true },
    items: [{ index: 1, name: 'Cached item', bytes: Buffer.alloc(0), mime: 'image/png', template: {} }],
    collectionPubkey: Keypair.generate().publicKey, registry: Keypair.generate().publicKey,
    creatorPubkey: Keypair.generate().publicKey, manifestSig: 'manifest', metaSig: 'metadata',
    staged: { seed: Buffer.alloc(32), shuffleCommit: 'commit', manifestHash: 'hash', manifestJson: '', collectionJson: '', itemCount: 1,
      manifestItems: [{ index: 1, name: 'Cached item', image_sha256: 'image', image_mime: 'image/png', meta_sha256: 'meta', arweave_id: 'arweave' }] },
  });
  db.run('INSERT INTO slot (slug, item_index, asset, owner, inscription_sig, meta_sig, registered_at) VALUES (?, 1, ?, ?, ?, ?, 1)', [slug, address, 'owner', sig, 'metadata']);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('no network in cached share requests'); }) as typeof fetch;
  try {
    expect(getAssetSlot(address)?.inscription_sig).toBe(sig);
    expect(latestMintSignature(slug)).toBe(sig);
    const col = await app.request('/share/c/' + slug);
    expect(col.status).toBe(200);
    expect(await col.text()).toContain('/render/' + sig + '?v=media-3');
    const asset = await app.request('/share/asset/' + address);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('<title>Cached item</title>');
    const json = await (await app.request('/asset/' + address)).json();
    expect(json.name).toBe('Cached item');
    expect(json.inscriptionSig).toBe(sig);
    expect(json.collectionName).toBe('Cached collection');
    expect((await app.request('/share')).status).toBe(200);
    expect((await (await app.request('/health')).json()).shareCards).toBe(true);
    expect((await app.request('/share/asset/not-mirrored')).status).toBe(404);
    expect(db.query('EXPLAIN QUERY PLAN SELECT * FROM slot WHERE asset = ? LIMIT 1').all(address).map((r: any) => r.detail).join(' ')).toContain('slot_asset_idx');
  } finally {
    globalThis.fetch = originalFetch;
    db.run('DELETE FROM slot WHERE slug = ?', [slug]);
    db.run('DELETE FROM item WHERE slug = ?', [slug]);
    db.run('DELETE FROM collection WHERE slug = ?', [slug]);
  }
});
