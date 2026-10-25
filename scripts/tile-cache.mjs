import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { unlinkSync } from 'node:fs';

export const SOURCES = ['mapbox.satellite', 'mapbox.mapbox-terrain-dem-v1'];
export const digest = value => createHash('sha256').update(value).digest('hex');
export const failure = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const abortError = () => new DOMException('Abgebrochen', 'AbortError');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const HEADER_NAMES = ['content-type', 'cache-control', 'expires', 'date', 'age', 'etag', 'last-modified', 'vary'];
export function parseTile(resource, token) {
  if (!/^pk\.[A-Za-z0-9._-]+$/.test(token || '')) throw failure(401, 'Öffentlicher Mapbox-Schlüssel fehlt.');
  if (typeof resource !== 'string' || resource.length > 3000 || !/^\/(?:v4|raster\/v1)\//.test(resource) || resource.includes('\\')) throw failure(400, 'Ungültige Kachelanfrage.');
  const url = new URL(resource, 'https://api.mapbox.com');
  const match = /^\/(v4|raster\/v1)\/(mapbox\.satellite|mapbox\.mapbox-terrain-dem-v1)\/(\d+)\/(\d+)\/(\d+)(@2x)?\.(webp|jpg(?:70|80|90)?|pngraw|png(?:32|64|128|256)?)$/.exec(url.pathname);
  if (!match || url.hash || url.searchParams.has('access_token')) throw failure(400, 'Kachelquelle oder Format nicht erlaubt.');
  const [, apiPrefix, source, zs, xs, ys, retina = '', format] = match;
  const prefix = '/' + apiPrefix + '/';
  const z = Number(zs), x = Number(xs), y = Number(ys);
  if (z > 22 || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x >= 2 ** z || y >= 2 ** z) throw failure(400, 'Ungültige Kachelkoordinaten.');
  for (const key of url.searchParams.keys()) if (!['sku', 'language', 'worldview', 'jobid'].includes(key)) throw failure(400, 'Unbekannter Kachelparameter.');
  const semantic = new URLSearchParams(url.searchParams); semantic.delete('sku'); semantic.sort();
  const namespace = digest(token);
  const canonical = url.pathname + (semantic.size ? '?' + semantic : '');
  url.searchParams.set('access_token', token);
  return { key: digest(namespace + ':' + canonical), namespace, source, z, x, y, variant: retina + '.' + format, prefix, canonical, upstream: url.href };
}
export function expiresAt(headers, now) {
  const cc = headers['cache-control'] || '';
  if (/\b(no-cache|no-store)\b/i.test(cc) || headers.vary === '*') return now;
  // This is a private, single-user device cache, not a shared CDN cache.
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(cc);
  const date = Date.parse(headers.date || '') || now;
  const age = Math.max(0, Number(headers.age) || 0, (now - date) / 1000);
  if (maxAge) return now + Math.max(0, Number(maxAge[1]) - age) * 1000;
  return Math.min(Date.parse(headers.expires || '') || now, now + 43200000);
}

export class TileCache {
  static async open(directory, options = {}) {
    await mkdir(path.join(directory, 'blobs'), { recursive: true });
    const cache = new TileCache(directory, options);
    await cache.maintenance();
    cache.maintenanceTimer = setInterval(() => cache.maintenance().catch(() => {}), 60000);
    cache.maintenanceTimer.unref();
    return cache;
  }
  constructor(directory, { fetcher = fetch, now = Date.now, limitBytes = 20_000_000_000, intervalMs = 150, maxTileBytes = 8_000_000 } = {}) {
    Object.assign(this, { directory, fetcher, now, limitBytes, intervalMs });
    this.maxTileBytes = Math.min(maxTileBytes, Math.floor(limitBytes / 4));
    this.owner = randomUUID(); this.pending = new Map(); this.closing = false;
    this.db = new DatabaseSync(path.join(directory, 'index.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=32; PRAGMA journal_size_limit=262144;
      CREATE TABLE IF NOT EXISTS tiles(key TEXT PRIMARY KEY, namespace TEXT, source TEXT, z INTEGER, x INTEGER, y INTEGER, variant TEXT, size INTEGER, sha TEXT, fetched INTEGER, expires INTEGER, used INTEGER, headers TEXT);
      CREATE INDEX IF NOT EXISTS tile_scope ON tiles(namespace,source);
      CREATE TABLE IF NOT EXISTS inflight(key TEXT PRIMARY KEY, owner TEXT, until INTEGER);
      CREATE TABLE IF NOT EXISTS queue(id TEXT PRIMARY KEY, priority INTEGER, state TEXT, until INTEGER);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value INTEGER);
      CREATE TABLE IF NOT EXISTS counters(key TEXT PRIMARY KEY,value INTEGER);
      CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, bytes INTEGER, until INTEGER);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, namespace TEXT, state TEXT, created INTEGER, updated INTEGER, lease INTEGER, owner TEXT, message TEXT, budgets TEXT, attempts INTEGER DEFAULT 0, satelliteAttempts INTEGER DEFAULT 0, terrainAttempts INTEGER DEFAULT 0, transferred INTEGER DEFAULT 0, retryAt INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS items(job TEXT, key TEXT, resource TEXT, source TEXT, done INTEGER DEFAULT 0, PRIMARY KEY(job,key));
      CREATE INDEX IF NOT EXISTS item_job ON items(job,done);`);
    if (!this.db.prepare('PRAGMA table_info(tiles)').all().some(column => column.name === 'prefix')) this.db.exec("ALTER TABLE tiles ADD COLUMN prefix TEXT NOT NULL DEFAULT '/v4/'");
    this.db.prepare("UPDATE jobs SET state='paused',message='Server wurde unterbrochen. Fortsetzen ist erforderlich.' WHERE state='running' AND lease < ?").run(this.now());
  }
  deleteBlobSync(key) { try { unlinkSync(this.blob(key)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = callback(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  count(name, increment = 1) { this.db.prepare('INSERT INTO counters VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value').run(name, increment); }
  blob(key) { return path.join(this.directory, 'blobs', key); }
  async indexSize() {
    let bytes = 0;
    for (const name of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm']) bytes += (await stat(path.join(this.directory, name)).catch(() => ({ size: 0 }))).size;
    return bytes;
  }
  async maintenance() {
    const now = this.now();
    // Only remove abandoned temporary files, never another server's active write.
    for (const name of await readdir(path.join(this.directory, 'blobs'))) {
      if (!/^[a-f0-9]{64}(?:\.[a-f0-9-]+\.tmp)?$/.test(name)) continue;
      const file = path.join(this.directory, 'blobs', name);
      if (name.endsWith('.tmp')) { if ((await stat(file)).mtimeMs < now - 120000) await unlink(file).catch(() => {}); }
      else if (!this.db.prepare('SELECT 1 FROM tiles WHERE key=?').get(name) && (await stat(file)).mtimeMs < now - 120000) await unlink(file).catch(() => {});
    }
    this.db.prepare('DELETE FROM reservations WHERE until < ?').run(now - 120000);
  }
  async read(tile) {
    const row = this.db.prepare('SELECT * FROM tiles WHERE key=?').get(tile.key);
    if (!row) return null;
    try {
      const body = await readFile(this.blob(tile.key));
      if (body.length !== row.size || digest(body) !== row.sha) throw new Error('corrupt');
      // Reuse saved imagery indefinitely. Expiry metadata is retained only as
      // provenance; it no longer causes requests back to Mapbox.
      return { row, body, headers: JSON.parse(row.headers), cached: true };
    } catch {
      this.transaction(() => {
        if (!this.db.prepare('SELECT 1 FROM inflight WHERE key=? AND until>?').get(tile.key, this.now())) {
          const removed = this.db.prepare('DELETE FROM tiles WHERE key=? AND sha=? AND fetched=?').run(tile.key, row.sha, row.fetched);
          if (removed.changes) this.deleteBlobSync(tile.key);
        }
      });
      this.count('corrupt'); return null;
    }
  }
  async reserve(bytes) {
    const metadata = await this.indexSize();
    const id = randomUUID(), now = this.now();
    this.transaction(() => {
      let used = this.db.prepare('SELECT coalesce(sum(size),0) AS n FROM tiles').get().n;
      const reserved = this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM reservations').get().n;
      const overhead = metadata + 65536;
      for (const row of this.db.prepare('SELECT key,size FROM tiles WHERE key NOT IN(SELECT key FROM inflight WHERE until>?) ORDER BY used').all(now)) {
        if (used + reserved + bytes + overhead <= this.limitBytes) break;
        // Delete while holding the transaction, so other processes cannot reserve the same space.
        // Synchronous unlink is limited to one bounded image file at a time.
        this.deleteBlobSync(row.key);
        this.db.prepare('DELETE FROM tiles WHERE key=?').run(row.key); used -= row.size;
      }
      if (used + reserved + bytes + overhead > this.limitBytes) throw failure(507, 'Festplattencache ist voll.');
      this.db.prepare('INSERT INTO reservations VALUES(?,?,?)').run(id, bytes, now + 60000);
    });
    return id;
  }
  async schedule(priority, signal) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO queue VALUES(?,?,?,?)').run(id, priority, 'pending', this.now() + 60000);
    try {
      while (true) {
        if (signal?.aborted || this.closing) throw abortError();
        const acquired = this.transaction(() => {
          const now = this.now();
          this.db.prepare('DELETE FROM queue WHERE until < ?').run(now);
          this.db.prepare('UPDATE queue SET until=? WHERE id=?').run(now + 60000, id);
          const running = this.db.prepare("SELECT count(*) AS n FROM queue WHERE state='running'").get().n;
          const ahead = this.db.prepare("SELECT count(*) AS n FROM queue WHERE state='pending' AND priority < ?").get(priority).n;
          const last = this.db.prepare("SELECT value FROM settings WHERE key='last-start'").get()?.value ?? -Infinity;
          if (running >= 2 || ahead || now - last < this.intervalMs) return false;
          this.db.prepare("UPDATE queue SET state='running' WHERE id=?").run(id);
          this.db.prepare("INSERT INTO settings VALUES('last-start',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(now);
          return true;
        });
        if (acquired) return () => this.db.prepare('DELETE FROM queue WHERE id=?').run(id);
        await sleep(Math.max(5, Math.min(40, this.intervalMs)));
      }
    } catch (error) { this.db.prepare('DELETE FROM queue WHERE id=?').run(id); throw error; }
  }
  async get(resource, token, { signal, priority = 0, referer, onAttempt } = {}) {
    const tile = parseTile(resource, token);
    const cached = await this.read(tile);
    if (cached?.cached) {
      this.db.prepare('UPDATE tiles SET used=? WHERE key=?').run(this.now(), tile.key); this.count('hits');
      return { ...cached, cache: 'hit', fetched: cached.row.fetched, expires: cached.row.expires };
    }
    let operation = this.pending.get(tile.key);
    if (!operation) {
      const controller = new AbortController();
      operation = { controller, users: 0 };
      operation.promise = this.load(tile, { signal: controller.signal, priority, referer, onAttempt }).finally(() => this.pending.delete(tile.key));
      this.pending.set(tile.key, operation);
    }
    operation.users++;
    try {
      if (signal?.aborted) throw abortError();
      return await new Promise((resolve, reject) => {
        const abort = () => reject(abortError());
        signal?.addEventListener('abort', abort, { once: true });
        operation.promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
      });
    } finally { if (--operation.users === 0) operation.controller.abort(); }
  }
  async load(tile, { signal, priority, referer, onAttempt }) {
    let ownsLease = false, release, reservation, heartbeat;
    try {
      while (!ownsLease) {
        if (signal.aborted || this.closing) throw abortError();
        ownsLease = this.transaction(() => {
          this.db.prepare('DELETE FROM inflight WHERE until < ?').run(this.now());
          return this.db.prepare('INSERT OR IGNORE INTO inflight VALUES(?,?,?)').run(tile.key, this.owner, this.now() + 60000).changes === 1;
        });
        if (!ownsLease) { await sleep(50); const shared = await this.read(tile); if (shared?.cached) { this.count('hits'); return { ...shared, cache: 'hit', fetched: shared.row.fetched, expires: shared.row.expires }; } }
      }
      heartbeat = setInterval(() => this.db.prepare('UPDATE inflight SET until=? WHERE key=? AND owner=?').run(this.now() + 60000, tile.key, this.owner), 10000);
      heartbeat.unref();
      const old = await this.read(tile);
      if (old?.cached) { this.count('hits'); return { ...old, cache: 'hit', fetched: old.row.fetched, expires: old.row.expires }; }
      release = await this.schedule(priority, signal);
      const headers = {};
      if (old?.headers.etag) headers['If-None-Match'] = old.headers.etag;
      else if (old?.headers['last-modified']) headers['If-Modified-Since'] = old.headers['last-modified'];
      if (referer) headers.Referer = referer;
      if (signal.aborted) throw abortError();
      onAttempt?.(tile.source);
      this.count('upstream');
      const response = await this.fetcher(tile.upstream, { headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) });
      const now = this.now();
      const savedHeaders = Object.fromEntries(HEADER_NAMES.map(name => [name, response.headers.get(name)]).filter(([, value]) => value !== null));
      if (response.status === 304 && old) {
        const merged = { ...old.headers, ...savedHeaders, date: savedHeaders.date || new Date(now).toUTCString(), age: savedHeaders.age || '0' };
        const expires = expiresAt(merged, now);
        if (/\bno-store\b/i.test(merged['cache-control'] || '')) {
          this.db.prepare('DELETE FROM tiles WHERE key=?').run(tile.key); this.deleteBlobSync(tile.key);
          return { body: old.body, headers: merged, fetched: now, expires, cache: 'bypass' };
        }
        this.db.prepare('UPDATE tiles SET headers=?,fetched=?,expires=?,used=? WHERE key=?').run(JSON.stringify(merged), now, expires, now, tile.key);
        this.count('revalidated'); return { body: old.body, headers: merged, fetched: now, expires, networkBytes: 0, cache: 'revalidated' };
      }
      if (!response.ok) {
        await response.body?.cancel();
        const raw = response.headers.get('retry-after');
        const retryMs = raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : Math.max(1000, (Date.parse(raw || '') || now + 60000) - now);
        throw failure(response.status, `Mapbox-Kachelanfrage fehlgeschlagen (HTTP ${response.status}).`, { retryAt: now + retryMs });
      }
      if (!/^image\/(jpeg|png|webp)(?:;|$)/i.test(savedHeaders['content-type'] || '')) { await response.body?.cancel(); throw failure(502, 'Mapbox lieferte kein Kartenbild.'); }
      if (Number(response.headers.get('content-length')) > this.maxTileBytes) { await response.body?.cancel(); throw failure(502, 'Kachel überschreitet die Größenbegrenzung.'); }
      let persist = !/\bno-store\b/i.test(savedHeaders['cache-control'] || '') && !(savedHeaders.vary || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean).some(value => !['accept-encoding', 'origin', 'accept'].includes(value));
      let reason;
      if (persist) {
        try { reservation = await this.reserve(this.maxTileBytes); }
        catch (error) {
          if (error.status !== 507) { await response.body?.cancel(); throw error; }
          persist = false; reason = 'capacity'; this.count('capacity-bypass');
        }
      }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > this.maxTileBytes) throw failure(502, 'Kachel überschreitet die Größenbegrenzung.'); chunks.push(chunk); }
      const body = Buffer.concat(chunks), expires = expiresAt(savedHeaders, now);
      const png = body.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const jpeg = body[0] === 255 && body[1] === 216 && body[2] === 255;
      const webp = body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP';
      if (!(png || jpeg || webp)) throw failure(502, 'Ungültige Kartenbilddaten.');
      if (persist) {
        const temp = this.blob(tile.key) + '.' + randomUUID() + '.tmp';
        try {
          await writeFile(temp, body, { flag: 'wx', mode: 0o600 }); await rename(temp, this.blob(tile.key));
          this.db.prepare('INSERT OR REPLACE INTO tiles(key,namespace,source,z,x,y,variant,size,sha,fetched,expires,used,headers,prefix) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(tile.key, tile.namespace, tile.source, tile.z, tile.x, tile.y, tile.variant, size, digest(body), now, expires, now, JSON.stringify(savedHeaders), tile.prefix);
        } finally { await unlink(temp).catch(() => {}); }
      }
      this.count('misses'); return { body, headers: savedHeaders, fetched: now, expires, networkBytes: body.length, reason, cache: persist ? 'miss' : 'bypass' };
    } finally {
      clearInterval(heartbeat);
      release?.();
      if (reservation) this.db.prepare('DELETE FROM reservations WHERE id=?').run(reservation);
      if (ownsLease) this.db.prepare('DELETE FROM inflight WHERE key=? AND owner=?').run(tile.key, this.owner);
    }
  }
  variant(namespace, source) { return this.db.prepare('SELECT variant,prefix FROM tiles WHERE namespace=? AND source=? ORDER BY fetched DESC LIMIT 1').get(namespace, source); }
  async status(namespace) {
    const summary = this.db.prepare('SELECT count(*) AS total,coalesce(sum(size),0) AS bytes FROM tiles').get();
    return { ...summary, diskBytes: summary.bytes + await this.indexSize(), limitBytes: this.limitBytes, counters: Object.fromEntries(this.db.prepare('SELECT * FROM counters').all().map(row => [row.key, row.value])), sources: this.db.prepare('SELECT source,avg(size) AS averageBytes FROM tiles WHERE namespace=? GROUP BY source').all(namespace) };
  }
  async clear() {
    if (this.pending.size || this.db.prepare('SELECT count(*) AS n FROM inflight WHERE until>?').get(this.now()).n) throw failure(409, 'Kartenanfragen laufen noch. Bitte kurz warten und erneut versuchen.');
    this.transaction(() => { for (const { key } of this.db.prepare('SELECT key FROM tiles').all()) this.deleteBlobSync(key); this.db.exec("DELETE FROM tiles; DELETE FROM counters WHERE key NOT LIKE 'prefetch-%' AND key!='upstream';"); });
  }
  async close() {
    this.closing = true; clearInterval(this.maintenanceTimer);
    for (const operation of this.pending.values()) operation.controller.abort();
    await Promise.allSettled([...this.pending.values()].map(operation => operation.promise));
    this.db.close();
  }
}
