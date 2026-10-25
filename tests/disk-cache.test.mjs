import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, stat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { TileCache, parseTile, expiresAt, digest, SOURCES } from '../scripts/tile-cache.mjs';
import { TileJobs } from '../scripts/tile-jobs.mjs';
import { createTileAPI, sharedCacheDirectory } from '../scripts/tile-api.mjs';
import { planCorridor } from '../scripts/tile-plan.mjs';
import { localTileRequest } from '../app/js/local-tile-cache.js';

const token = 'pk.disk-cache-test', resource = '/v4/mapbox.satellite/1/0/0@2x.webp';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1sAAAAASUVORK5CYII=', 'base64');
const image = (headers = {}, body = png) => new Response(body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600', ...headers } });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'traumpfad-cache-'));
  const cache = await TileCache.open(directory, { intervalMs: 0, ...options });
  t.after(async () => { if (!cache.closing) await cache.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, cache };
}

test('tile routing excludes tokens from URLs, preserves real SKU, and rejects arbitrary upstreams', () => {
  const input = `https://api.mapbox.com${resource}?sku=real-session&access_token=${token}`;
  const request = localTileRequest(input, 'Tile', 'http://localhost:5174');
  assert.equal(request.headers['X-Mapbox-Token'], token);
  assert.ok(!request.url.includes(token));
  const forwarded = new URL(request.url).searchParams.get('resource');
  assert.ok(forwarded.includes('sku=real-session'));
  assert.equal(parseTile(forwarded, token).key, parseTile(resource, token).key);
  assert.notEqual(parseTile(resource, token).key, parseTile(resource, 'pk.other').key);
  const dem = '/raster/v1/mapbox.mapbox-terrain-dem-v1/10/10/10.webp';
  assert.equal(parseTile(dem, token).source, SOURCES[1]);
  assert.equal(parseTile(dem, token).prefix, '/raster/v1/');
  assert.ok(localTileRequest('https://api.mapbox.com' + dem + '?access_token=' + token, 'Tile', 'http://localhost:5174'));
  assert.equal(localTileRequest('https://evil.test' + resource, 'Tile', 'http://localhost:5174'), null);
  for (const bad of ['https://evil.test/x', '/v4/evil.tiles/1/0/0.webp', '/v4/mapbox.satellite/1/2/0.webp', resource + '?access_token=pk.x', resource + '?unknown=yes', '/v4/../secret']) assert.throws(() => parseTile(bad, token));
});

test('HTTP freshness respects Age, no-cache, no-store and already expired responses', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  assert.equal(expiresAt({ 'cache-control': 'max-age=100', age: '60', date: new Date(now).toUTCString() }, now), now + 40000);
  assert.equal(expiresAt({ 'cache-control': 'max-age=100', date: new Date(now - 80000).toUTCString() }, now), now + 20000);
  for (const cc of ['no-cache,max-age=100', 'no-store,max-age=100']) assert.equal(expiresAt({ 'cache-control': cc }, now), now);
});

test('fresh disk hits survive restart and are shared across worktree servers without upstream requests', async t => {
  let calls = 0;
  const { cache, directory } = await fixture(t, { fetcher: async () => { calls++; return image({ Vary: 'Origin, Accept-Encoding' }); } });
  assert.equal((await cache.get(resource, token)).cache, 'miss');
  const second = await TileCache.open(directory, { intervalMs: 0, fetcher: () => assert.fail('disk hit must not fetch') });
  assert.equal((await second.get(resource + '?sku=new-real-session', token)).cache, 'hit');
  await second.close(); await cache.close();
  const restarted = await TileCache.open(directory, { fetcher: () => assert.fail('restart must reuse the file') });
  assert.deepEqual((await restarted.get(resource, token)).body, png);
  assert.equal(calls, 1);
  await restarted.close();
  const metadata = await readFile(path.join(directory, 'index.sqlite'));
  assert.equal(metadata.includes(Buffer.from(token)), false);
});

test('stale entries revalidate with ETag and never extend freshness on a failed request', async t => {
  let now = Date.parse('2026-10-25T12:00:00Z'), calls = 0;
  const { cache } = await fixture(t, { now: () => now, fetcher: async (url, options) => {
    calls++;
    if (calls === 1) return image({ Date: new Date(now).toUTCString(), ETag: 'test-etag', 'Cache-Control': 'max-age=1' });
    assert.equal(options.headers['If-None-Match'], 'test-etag');
    if (calls === 2) return new Response(null, { status: 304, headers: { Date: new Date(now).toUTCString(), 'Cache-Control': 'max-age=30' } });
    return new Response('denied', { status: 403 });
  } });
  await cache.get(resource, token); now += 2000;
  assert.equal((await cache.get(resource, token)).cache, 'revalidated');
  now += 31000;
  await assert.rejects(cache.get(resource, token), error => error.status === 403);
  assert.equal((await cache.read(parseTile(resource, token))).fresh, false);
});

test('no-store and invalid image responses never become disk hits', async t => {
  let calls = 0;
  const { cache } = await fixture(t, { fetcher: async () => { calls++; return image({ 'Cache-Control': 'no-store' }); } });
  assert.equal((await cache.get(resource, token)).cache, 'bypass');
  await cache.get(resource, token); assert.equal(calls, 2);
  cache.fetcher = async () => image({}, Buffer.from('<html>not an image</html>'));
  await assert.rejects(cache.get(resource, token), /Kartenbilddaten/);
  assert.equal((await cache.status(digest(token))).total, 0);
});

test('parallel same-tile requests are deduplicated within and between server processes', async t => {
  let calls = 0;
  const { cache, directory } = await fixture(t, { fetcher: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 40)); return image(); } });
  const second = await TileCache.open(directory, { intervalMs: 0, fetcher: async () => { calls++; return image(); } });
  t.after(() => second.close());
  const responses = await Promise.all([cache.get(resource, token), cache.get(resource, token), second.get(resource, token)]);
  assert.equal(calls, 1);
  assert.ok(responses.every(response => response.body.equals(png)));
});

test('a cancelled subscriber does not abort an identical foreground request', async t => {
  let calls = 0;
  const { cache } = await fixture(t, { fetcher: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 40)); return image(); } });
  const controller = new AbortController();
  const cancelled = cache.get(resource, token, { signal: controller.signal });
  const remaining = cache.get(resource, token);
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  setTimeout(() => controller.abort(), 10);
  await rejected;
  assert.equal((await remaining).body.length, png.length);
  assert.equal(calls, 1);
});

test('a corrupt file is detected, replaced, and never served as a valid cache hit', async t => {
  let calls = 0;
  const { cache } = await fixture(t, { fetcher: async () => { calls++; return image(); } });
  await cache.get(resource, token);
  await writeFile(cache.blob(parseTile(resource, token).key), 'broken');
  assert.deepEqual((await cache.get(resource, token)).body, png);
  assert.equal(calls, 2);
});

test('disk eviction accounts for metadata and temporary reservations and evicts expired files first', async t => {
  let now = Date.now();
  const bigImage = Buffer.concat([png, Buffer.alloc(80000)]);
  const { cache, directory } = await fixture(t, { limitBytes: 700000, maxTileBytes: 90000, now: () => now, fetcher: async () => image({ 'Cache-Control': 'max-age=1' }, bigImage) });
  cache.db.exec('PRAGMA wal_autocheckpoint=1;');
  for (let x = 0; x < 8; x++) { await cache.get(`/v4/mapbox.satellite/4/${x}/0.webp`, token); now += 2000; }
  const files = await readdir(path.join(directory, 'blobs'));
  const total = (await Promise.all(files.map(file => stat(path.join(directory, 'blobs', file))))).reduce((n, row) => n + row.size, 0) + await cache.indexSize();
  assert.ok(total <= cache.limitBytes, `${total} exceeds ${cache.limitBytes}`);
  assert.ok(files.length < 8);
  assert.equal(files.some(file => file.endsWith('.tmp')), false);
});

test('route corridor covers sparse segments and endpoints without downloading its whole bounding rectangle', () => {
  const { tiles } = planCorridor([[0, 0], [0, 1], [1, 1]]);
  const keys = new Set(tiles.map(tile => `${tile.z}/${tile.x}/${tile.y}`));
  assert.equal(keys.size, tiles.length);
  const key = (lon, lat, z = 14) => `${z}/${Math.floor((lon + 180) / 360 * 2 ** z)}/${Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z)}`;
  for (const point of [[0, 0], [0, .5], [0, 1], [.5, 1], [1, 1], [.17, .5], [-.17, .5]]) assert.ok(keys.has(key(...point)), String(point));
  assert.equal(keys.has(key(1, 0)), false);
});

function seedJob(cache, resources) {
  const namespace = digest(token), id = 'job-test';
  cache.db.prepare('INSERT INTO jobs(id,namespace,state,created,updated,lease,owner,message,budgets) VALUES(?,?,?,?,?,?,?,?,?)').run(id, namespace, 'paused', cache.now(), cache.now(), 0, '', '', '{}');
  for (const resource of resources) { const tile = parseTile(resource, token); cache.db.prepare('INSERT INTO items(job,key,resource,source) VALUES(?,?,?,?)').run(id, tile.key, resource, tile.source); }
  return { id, namespace, jobs: new TileJobs(cache, '') };
}
const allowance = () => ({ satellite: 100, terrain: 100, combined: 100, verified: true, checkedAt: Date.now() });

test('unknown, insufficient, stale or unconfirmed allowances block prefetch before any network call', async t => {
  const { cache } = await fixture(t, { fetcher: () => assert.fail('budget gate must run first') });
  const { jobs } = seedJob(cache, [resource]); t.after(() => jobs.close());
  for (const confirmation of [{}, { ...allowance(), verified: false }, { ...allowance(), combined: 0 }, { ...allowance(), checkedAt: Date.now() - 3600000 }]) await assert.rejects(jobs.start(token, confirmation), error => error.status === 409);
});

test('prefetch counts upstream attempts, resumes disk hits, and pauses immediately on 429', async t => {
  let calls = 0;
  const { cache } = await fixture(t, { fetcher: async () => { calls++; return new Response('rate limit', { status: 429, headers: { 'Retry-After': '60' } }); } });
  const { jobs, id, namespace } = seedJob(cache, Array.from({ length: 8 }, (_, x) => `/v4/mapbox.satellite/4/${x}/0.webp`));
  t.after(() => jobs.close());
  await jobs.start(token, allowance());
  await jobs.runs.get(id)?.promise;
  const status = jobs.summary(namespace);
  assert.equal(status.state, 'paused');
  assert.ok(calls <= 2); assert.equal(status.attempts, calls);
  assert.ok(status.retryAt > Date.now());
  await assert.rejects(jobs.start(token, allowance()), error => error.status === 429);
});

test('completed work survives a server restart and fresh tiles are not requested again', async t => {
  let calls = 0;
  const { cache, directory } = await fixture(t, { fetcher: async () => { calls++; return image(); } });
  const { jobs, id, namespace } = seedJob(cache, [resource, '/v4/mapbox.mapbox-terrain-dem-v1/1/0/0.webp']);
  await jobs.start(token, allowance()); await jobs.runs.get(id)?.promise;
  assert.equal(jobs.summary(namespace).fresh, 2);
  await jobs.close(); await cache.close();
  const restarted = await TileCache.open(directory, { intervalMs: 0, fetcher: () => assert.fail('fresh planned tiles must not fetch') });
  const resumed = new TileJobs(restarted, '');
  await resumed.start(token, allowance()); await resumed.runs.get(id)?.promise;
  assert.equal(resumed.summary(namespace).fresh, 2);
  assert.equal(calls, 2);
  await resumed.close(); await restarted.close();
});

test('network queue enforces foreground priority and at most two active requests', async t => {
  let active = 0, peak = 0;
  const releases = [], starts = [];
  const { cache } = await fixture(t, { intervalMs: 5, fetcher: async url => {
    active++; peak = Math.max(peak, active); starts.push(new URL(url).pathname);
    await new Promise(resolve => releases.push(resolve)); active--; return image();
  } });
  const paths = Array.from({ length: 4 }, (_, x) => `/v4/mapbox.satellite/4/${x}/0.webp`);
  const pending = [cache.get(paths[0], token), cache.get(paths[1], token)];
  while (starts.length < 2) await new Promise(resolve => setTimeout(resolve, 10));
  pending.push(cache.get(paths[2], token, { priority: 1 })); pending.push(cache.get(paths[3], token, { priority: 0 }));
  await new Promise(resolve => setTimeout(resolve, 10)); releases[0]();
  while (starts.length < 3) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(starts[2], paths[3]); releases[1](); releases[2]();
  while (starts.length < 4) await new Promise(resolve => setTimeout(resolve, 10)); releases[3]();
  await Promise.all(pending); assert.equal(peak, 2);
});

test('local tile HTTP API rejects cross-origin writes and serves a second request from disk', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'traumpfad-api-')); let calls = 0;
  const root = new URL('..', import.meta.url).pathname;
  const api = await createTileAPI(root, { directory, intervalMs: 0, fetcher: async () => { calls++; return image(); } });
  const server = http.createServer((request, response) => api.handle(request, response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await api.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'X-Mapbox-Token': token };
  const url = origin + '/api/map-tiles?resource=' + encodeURIComponent(resource);
  assert.equal((await fetch(url, { headers })).headers.get('x-traumpfad-cache'), 'miss');
  assert.equal((await fetch(url, { headers })).headers.get('x-traumpfad-cache'), 'hit');
  assert.equal(calls, 1);
  const forbidden = await fetch(origin + '/api/tile-cache/clear', { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' } });
  assert.equal(forbidden.status, 403);
  const blocked = await fetch(origin + '/api/tile-cache/start', { method: 'POST', headers: { ...headers, Origin: origin }, body: '{}' });
  assert.equal(blocked.status, 409);
  assert.equal(calls, 1);
  assert.equal(sharedCacheDirectory(root), sharedCacheDirectory('/Users/zek/Documents/ChatGPT/Traumpfad'));
});

test('the complete GPX plan uses observed satellite and raster-v1 DEM variants without downloading route tiles', async t => {
  let calls = 0;
  const { cache } = await fixture(t, { fetcher: async () => { calls++; return image(); } });
  await cache.get(resource, token);
  await cache.get('/raster/v1/mapbox.mapbox-terrain-dem-v1/1/0/0.webp', token);
  const jobs = new TileJobs(cache, new URL('../app/data/routes/gesamtstrecke.geojson', import.meta.url).pathname);
  t.after(() => jobs.close());
  const plan = await jobs.plan(token);
  assert.equal(plan.planned, 17014);
  assert.equal(plan.variantsReady, true);
  assert.equal(plan.state, 'paused');
  assert.equal(calls, 2);
  const dem = cache.db.prepare('SELECT resource FROM items WHERE job=? AND source=? LIMIT 1').get(plan.id, SOURCES[1]);
  assert.ok(dem.resource.startsWith('/raster/v1/'));
  assert.equal(cache.db.prepare("SELECT count(*) AS n FROM items WHERE resource LIKE '%access_token%' OR resource LIKE '%sku=%'").get().n, 0);
  await assert.rejects(jobs.start(token, {}), error => error.status === 409);
  assert.equal(calls, 2);
});

test('missing provider coverage is reported separately and is never counted as a valid image', async t => {
  const { cache } = await fixture(t, { fetcher: async url => new URL(url).pathname.includes('terrain') ? new Response('no coverage', { status: 404 }) : image() });
  const { jobs, id, namespace } = seedJob(cache, [resource, '/raster/v1/mapbox.mapbox-terrain-dem-v1/1/0/0.webp']);
  t.after(() => jobs.close());
  await jobs.start(token, allowance()); await jobs.runs.get(id)?.promise;
  const summary = jobs.summary(namespace);
  assert.equal(summary.state, 'complete');
  assert.equal(summary.fresh, 1); assert.equal(summary.unavailable, 1);
  assert.equal((await cache.status(namespace)).total, 1);
  assert.equal(Object.values(summary.remaining).reduce((a, b) => a + b), 0);
});

test('full disk reservations bypass cache for visible maps instead of breaking their image requests', async t => {
  const { cache } = await fixture(t, { limitBytes: 2_000_000, maxTileBytes: 500000, fetcher: async () => image() });
  const reservation = await cache.reserve(1_600_000);
  const result = await cache.get(resource, token);
  assert.equal(result.cache, 'bypass'); assert.equal(result.reason, 'capacity');
  assert.deepEqual(result.body, png);
  cache.db.prepare('DELETE FROM reservations WHERE id=?').run(reservation);
});

test('pausing an incomplete download cancels its body and releases temporary reservations', async t => {
  const { cache, directory } = await fixture(t, { fetcher: async (_, options) => image({}, new ReadableStream({ start(controller) {
    controller.enqueue(png.subarray(0, 12));
    options.signal.addEventListener('abort', () => controller.error(new DOMException('cancelled', 'AbortError')), { once: true });
  } })) });
  const { jobs, id, namespace } = seedJob(cache, [resource]);
  t.after(() => jobs.close());
  await jobs.start(token, allowance());
  while (!cache.db.prepare('SELECT count(*) AS n FROM reservations').get().n) await new Promise(resolve => setTimeout(resolve, 5));
  const run = jobs.runs.get(id)?.promise;
  jobs.pause(namespace); await run;
  await Promise.allSettled([...cache.pending.values()].map(operation => operation.promise));
  assert.equal(jobs.summary(namespace).state, 'paused');
  assert.equal(cache.db.prepare('SELECT count(*) AS n FROM reservations').get().n, 0);
  assert.equal((await readdir(path.join(directory, 'blobs'))).length, 0);
});

test('expired running leases recover as paused after restart; authorization failures stop prefetch', async t => {
  const { cache } = await fixture(t, { fetcher: async () => new Response('denied', { status: 403 }) });
  const { jobs, id, namespace } = seedJob(cache, [resource]);
  t.after(() => jobs.close());
  cache.db.prepare("UPDATE jobs SET state='running',lease=? WHERE id=?").run(Date.now() - 1, id);
  assert.equal(jobs.summary(namespace).state, 'paused');
  await jobs.start(token, allowance()); await jobs.runs.get(id)?.promise;
  assert.equal(jobs.summary(namespace).state, 'error');
  assert.equal(jobs.summary(namespace).attempts, 1);
});
