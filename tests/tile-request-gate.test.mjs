import test from 'node:test';
import assert from 'node:assert/strict';
import { createTileRequestGate } from '../app/js/tile-request-gate.js';

const tile = 'https://api.mapbox.com/v4/mapbox.satellite/12/2177/1425.webp?access_token=example&sku=session';
test('tile starts are paced while request URLs and billing parameters stay intact', async () => {
  const gate = createTileRequestGate({ intervalMs: 20 });
  const first = await gate(tile, 'Tile');
  const start = performance.now();
  const next = await gate(tile + '&second=1', 'Tile');
  assert.ok(performance.now() - start >= 18);
  assert.equal(first.url, tile);
  assert.equal(next.url, tile + '&second=1');
  assert.deepEqual(gate('https://api.mapbox.com/styles/v1/mapbox/standard-satellite', 'Style'), { url: 'https://api.mapbox.com/styles/v1/mapbox/standard-satellite' });
});
test('cancelled camera requests leave the queue without being sent or holding later tiles', async () => {
  const gate = createTileRequestGate({ intervalMs: 20 });
  await gate(tile, 'Tile');
  const controller = new AbortController();
  const cancelled = gate(tile + '&old=1', 'Tile', { signal: controller.signal });
  const rejection = assert.rejects(cancelled, { name: 'AbortError' });
  controller.abort();
  await rejection;
  assert.equal((await gate(tile + '&live=1', 'Tile')).url, tile + '&live=1');
});
test('fresh native cache hits bypass a waiting network tile and do not change its URL', async () => {
  const gate = createTileRequestGate({ intervalMs: 25, isCached: url => url.includes('cached=1') });
  await gate(tile, 'Tile');
  const order = [];
  const network = gate(tile + '&network=1', 'Tile').then(() => order.push('network'));
  const cachedUrl = tile + '&cached=1';
  const cached = await gate(cachedUrl, 'Tile');
  order.push('cached');
  assert.equal(cached.url, cachedUrl);
  await network;
  assert.deepEqual(order, ['cached', 'network']);
});
