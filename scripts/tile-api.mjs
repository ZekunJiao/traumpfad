import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TileCache, parseTile, digest, failure } from './tile-cache.mjs';
import { TileJobs } from './tile-jobs.mjs';

export function sharedCacheDirectory(root) {
  if (process.env.TRAUMPFAD_TILE_CACHE_DIR) return path.resolve(process.env.TRAUMPFAD_TILE_CACHE_DIR);
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.join(path.dirname(common), '.cache', 'map-tiles');
  } catch { return path.join(root, '.cache', 'map-tiles'); }
}
async function jsonBody(request) {
  let body = '';
  for await (const chunk of request) { body += chunk; if (body.length > 8192) throw failure(413, 'Anfrage zu groß.'); }
  try { return body ? JSON.parse(body) : {}; } catch { throw failure(400, 'Ungültige JSON-Anfrage.'); }
}
export async function createTileAPI(root, options = {}) {
  const cache = await TileCache.open(options.directory || sharedCacheDirectory(root), options);
  const jobs = new TileJobs(cache, path.join(root, 'app/data/routes/gesamtstrecke.geojson'));
  const send = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
  return {
    cache, jobs,
    async handle(request, response) {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname !== '/api/map-tiles' && !url.pathname.startsWith('/api/tile-cache/')) return false;
      try {
        const host = request.headers.host || '', origin = 'http://' + host;
        if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host) || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') throw failure(403, 'Nur lokale Anfragen dieser App sind erlaubt.');
        if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.origin !== origin) throw failure(403, 'Lokaler Ursprung fehlt.');
        const token = request.headers['x-mapbox-token'] || '';
        if (url.pathname === '/api/map-tiles') {
          if (!['GET', 'HEAD'].includes(request.method)) throw failure(405, 'Nur GET und HEAD sind erlaubt.');
          const resource = url.searchParams.get('resource'), tile = parseTile(resource, token);
          const controller = new AbortController();
          response.once('close', () => { if (!response.writableEnded) controller.abort(); });
          let result;
          if (request.method === 'HEAD') {
            const stored = await cache.read(tile);
            if (!stored?.fresh) throw failure(404, 'Keine gültige Kachel gespeichert.');
            result = { ...stored, fetched: stored.row.fetched, expires: stored.row.expires, cache: 'hit' };
          } else result = await cache.get(resource, token, { signal: controller.signal, referer: origin + '/' });
          if (response.destroyed) return true;
          const age = Math.max(0, Math.floor((cache.now() - (Date.parse(result.headers.date || '') || result.fetched)) / 1000), (Number(result.headers.age) || 0) + Math.floor((cache.now() - result.fetched) / 1000));
          response.writeHead(200, { 'Content-Type': result.headers['content-type'], 'Content-Length': result.body.length, 'Cache-Control': result.headers['cache-control'] || 'no-cache', 'Age': String(age), 'X-Traumpfad-Cache': result.cache, ...(result.headers.etag ? { ETag: result.headers.etag } : {}), ...(result.headers.expires ? { Expires: result.headers.expires } : {}) });
          response.end(request.method === 'HEAD' ? undefined : result.body); return true;
        }
        const namespace = token ? parseTile('/v4/mapbox.satellite/0/0/0.webp', token).namespace : '';
        const action = url.pathname.slice('/api/tile-cache/'.length);
        if (action === 'status' && request.method === 'GET') { send(response, 200, { ...await cache.status(namespace), job: jobs.summary(namespace) }); return true; }
        if (request.method !== 'POST') throw failure(405, 'Diese Aktion benötigt POST.');
        if (!namespace) throw failure(401, 'Bitte zuerst den Mapbox-Schlüssel verbinden.');
        const body = await jsonBody(request);
        if (action === 'plan') send(response, 200, await jobs.plan(token));
        else if (action === 'start') send(response, 200, await jobs.start(token, body, origin + '/'));
        else if (action === 'pause') { jobs.pause(namespace); send(response, 200, jobs.summary(namespace)); }
        else if (action === 'clear') {
          if (cache.db.prepare("SELECT 1 FROM jobs WHERE state='running' AND lease>? LIMIT 1").get(cache.now())) throw failure(409, 'Vor dem Leeren alle Vorabdownloads pausieren.');
          await cache.clear(); send(response, 200, await cache.status(namespace));
        } else throw failure(404, 'Unbekannte Cache-Aktion.');
      } catch (error) {
        if (!response.destroyed && !response.headersSent) send(response, error.status || 502, { error: error.status ? error.message : 'Lokaler Kachelcache derzeit nicht verfügbar.', ...(error.retryAt ? { retryAt: error.retryAt } : {}) });
        else if (!response.destroyed) response.end();
      }
      return true;
    },
    async close() { await jobs.close(); await cache.close(); }
  };
}
