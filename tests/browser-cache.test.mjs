import test from 'node:test';
import assert from 'node:assert/strict';
import { readBrowserMapCache, describeBrowserMapCache, isBrowserMapTileCached } from '../app/js/browser-cache.js';

test('cache inspection distinguishes fresh, expired and revalidation-required tiles without requests', async () => {
  const now = Date.parse('2026-10-25T09:00:00Z');
  const entries = [
    ['https://api.mapbox.com/v4/mapbox.satellite/9/1/1.webp', { expires: 'Sun, 25 Oct 2026 10:00:00 GMT' }],
    ['https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/9/1/1.pngraw', { expires: 'Sun, 25 Oct 2026 08:00:00 GMT' }],
    ['https://api.mapbox.com/v4/mapbox.satellite/9/2/1.webp', { expires: 'Sun, 25 Oct 2026 10:00:00 GMT', 'cache-control': 'max-age=43200, no-cache' }]
  ];
  const responses = new Map(entries.map(([url, headers]) => [url, new Response('tile', { headers })]));
  const result = await readBrowserMapCache({ now, storage: {
    has: async () => true,
    open: async () => ({ keys: async () => entries.map(([url]) => new Request(url)), match: async request => responses.get(request.url) })
  } });
  assert.deepEqual(result, { status: 'available', total: 3, fresh: 1, satellite: 2, terrain: 1 });
  assert.match(describeBrowserMapCache(result), /3 Kacheln.*1 noch gültig/);
});
test('inspection does not create an empty cache and handles blocked storage', async () => {
  let opened = false;
  const empty = await readBrowserMapCache({ storage: { has: async () => false, open: () => { opened = true; } } });
  assert.equal(empty.total, 0);
  assert.equal(opened, false);
  const blocked = await readBrowserMapCache({ storage: { has: async () => { throw new Error('Storage blocked'); } } });
  assert.equal(blocked.status, 'unavailable');
});
test('native lookup ignores credentials and session but preserves content variants and expiry', async () => {
  const now = Date.parse('2026-10-25T09:00:00Z');
  let lookup;
  const headers = new Headers({ expires: 'Sun, 25 Oct 2026 10:00:00 GMT' });
  const storage = { has: async () => true, open: async () => ({ match: async key => { lookup = key; return new Response('tile', { headers }); } }) };
  const url = 'https://api.mapbox.com/v4/mapbox.satellite/9/1/1.webp?access_token=pk.example&sku=101session&worldview=US&language=de';
  assert.equal(await isBrowserMapTileCached(url, { storage, now }), true);
  assert.equal(lookup, 'https://api.mapbox.com/v4/mapbox.satellite/9/1/1.webp?language=de&worldview=US');
  assert.equal(await isBrowserMapTileCached(url, { storage, now: now + 7200000 }), false);
  headers.set('cache-control', 'no-store');
  assert.equal(await isBrowserMapTileCached(url, { storage, now }), false);
});
