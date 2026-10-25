import http from 'node:http';
import { createTileAPI } from './tile-api.mjs';
import { readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const vendor = { '/vendor/mapbox-gl.js': path.join(root, 'node_modules/mapbox-gl/dist/mapbox-gl.js'), '/vendor/mapbox-gl.css': path.join(root, 'node_modules/mapbox-gl/dist/mapbox-gl.css') };
const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (await tileAPI.handle(request, response)) return;
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
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': /\.(jpg|jpeg|webp|png)$/.test(file) ? 'private, max-age=3600' : 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : await readFile(resolved));
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
