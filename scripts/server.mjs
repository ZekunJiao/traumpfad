import http from 'node:http';
import { createTileAPI } from './tile-api.mjs';
import { readFile, stat, realpath, writeFile, mkdir, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { validateJourney } from '../app/js/route.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'app');
try {
  const env = await readFile(path.join(root, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }

const tileAPI = await createTileAPI(root);

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8', '.gpx': 'application/gpx+xml; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
Object.assign(types, { '.gif': 'image/gif', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' });
const vendor = { '/vendor/mapbox-gl.js': path.join(root, 'node_modules/mapbox-gl/dist/mapbox-gl.js'), '/vendor/mapbox-gl.css': path.join(root, 'node_modules/mapbox-gl/dist/mapbox-gl.css') };
const json = (response, status, data) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); };
async function readBody(request, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Datei ist zu groß.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function sameOrigin(request) {
  if (!request.headers.origin) return true;
  try { const origin = new URL(request.headers.origin); return origin.protocol === 'http:' && origin.host === request.headers.host; }
  catch { return false; }
}
const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (await tileAPI.handle(request, response)) return;
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/api/media' || pathname === '/api/journey') {
    if (request.method !== 'POST') { json(response, 405, { error: 'Nur POST ist erlaubt.' }); return; }
    if (!sameOrigin(request)) { json(response, 403, { error: 'Anfrage muss von dieser Traumpfad-Seite kommen.' }); return; }
    try {
      if (pathname === '/api/media') {
        const id = request.headers['x-asset-id'], variant = request.headers['x-asset-variant'] || 'original';
        if (!/^[0-9a-f-]{36}$/i.test(id || '') || !['original', 'thumbnail'].includes(variant)) throw Object.assign(new Error('Ungültige Datei-ID.'), { statusCode: 400 });
        const mime = String(request.headers['content-type'] || '').split(';')[0].toLowerCase();
        const originalTypes = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
        const ext = variant === 'thumbnail' ? (mime === 'image/jpeg' ? 'jpg' : null) : originalTypes[mime];
        if (!ext) throw Object.assign(new Error('Dieses Bild- oder Videoformat wird nicht unterstützt.'), { statusCode: 415 });
        const body = await readBody(request, 200 * 1024 * 1024);
        if (!body.length) throw Object.assign(new Error('Die Datei ist leer.'), { statusCode: 400 });
        const folder = path.join(publicRoot, 'assets/photos'); await mkdir(folder, { recursive: true });
        const name = `${id}${variant === 'thumbnail' ? '-thumb' : ''}.${ext}`, destination = path.join(folder, name), temporary = `${destination}.${randomUUID()}.tmp`;
        await writeFile(temporary, body, { flag: 'wx' }); await rename(temporary, destination);
        json(response, 201, { file: `assets/photos/${name}` }); return;
      }
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('JSON erwartet.'), { statusCode: 415 });
      const journey = JSON.parse((await readBody(request, 12 * 1024 * 1024)).toString('utf8'));
      if (!journey || typeof journey !== 'object' || Array.isArray(journey)) { json(response, 400, { error: 'Reisedaten müssen ein JSON-Objekt sein.' }); return; }
      const errors = validateJourney(journey);
      for (const photo of journey.photos || []) if (!photo.placeholder) {
        for (const file of [photo.file, photo.thumbnail].filter(Boolean)) {
          if (typeof file !== 'string' || !/^assets\/photos\/[a-zA-Z0-9._-]+$/.test(file) || file.includes('..')) errors.push(`${photo.id}: Ungültiger Medienpfad.`);
          else try { await access(path.join(publicRoot, file)); } catch { errors.push(`${photo.id}: Datei fehlt: ${file}`); }
        }
      }
      if (errors.length) { json(response, 400, { error: errors.join(' ') }); return; }
      const destination = path.join(publicRoot, 'data/journey.json'), temporary = `${destination}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(journey, null, 2) + '\n', { flag: 'wx' }); await rename(temporary, destination);
      json(response, 200, { saved: true }); return;
    } catch (error) { json(response, error.statusCode || (error instanceof SyntaxError ? 400 : 500), { error: error.statusCode ? error.message : error instanceof SyntaxError ? 'Reisedaten sind kein gültiges JSON.' : 'Speichern fehlgeschlagen.' }); return; }
  }
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') {
      response.writeHead(302, { Location: '/assets/favicon.svg', 'Cache-Control': 'private, max-age=3600' });
      response.end(); return;
    }
    if (pathname === '/api/config') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      const token = process.env.MAPBOX_PUBLIC_TOKEN || '';
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ mapboxToken: token.startsWith('pk.') ? token : '' })); return;
    }
    const file = vendor[pathname] || path.resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!vendor[pathname] && (!file.startsWith(publicRoot + path.sep) || pathname.split('/').some(p => p.startsWith('.')))) { response.writeHead(404); response.end('Nicht gefunden'); return; }
    const resolved = await realpath(file);
    if (!vendor[pathname] && !resolved.startsWith(publicRoot + path.sep)) { response.writeHead(404); response.end('Nicht gefunden'); return; }
    const info = await stat(resolved);
    if (!info.isFile()) throw Object.assign(new Error(), { code: 'ENOENT' });
    const extension = path.extname(file).toLowerCase(), isVideo = ['.mp4', '.mov', '.webm'].includes(extension), range = request.headers.range;
    const headers = { 'Content-Type': types[extension] || 'application/octet-stream', 'Cache-Control': /\.(jpg|jpeg|webp|png|avif|gif)$/.test(file) ? 'private, max-age=3600' : 'no-cache' };
    if (isVideo) headers['Accept-Ranges'] = 'bytes';
    if (isVideo && range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return; }
      let start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
      let end = match[2] && match[1] ? Number(match[2]) : info.size - 1;
      if (start > end || start >= info.size) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return; }
      end = Math.min(end, info.size - 1);
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`; headers['Content-Length'] = end - start + 1;
      response.writeHead(206, headers);
      if (request.method === 'HEAD') response.end(); else createReadStream(resolved, { start, end }).pipe(response);
      return;
    }
    headers['Content-Length'] = info.size;
    response.writeHead(200, headers);
    if (request.method === 'HEAD') response.end();
    else if (isVideo) createReadStream(resolved).pipe(response);
    else response.end(await readFile(resolved));
  } catch (error) {
    response.writeHead(error instanceof URIError ? 400 : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500);
    response.end('Datei nicht verfügbar');
  }
});
const port = Number(process.env.PORT || 5173);
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} wird bereits verwendet. Nutze PORT=5174 npm start.` : error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Traumpfad läuft auf http://localhost:${port}\nNur auf diesem Mac erreichbar. Beenden mit Ctrl+C.`));
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return; stopping = true;
  server.close(); await tileAPI.close(); process.exit(0);
});
