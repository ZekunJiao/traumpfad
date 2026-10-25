import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { SOURCES, parseTile, digest, failure } from './tile-cache.mjs';

export function computePlan(routeFile) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./tile-plan-worker.mjs', import.meta.url), { workerData: { routeFile }, execArgv: [] });
    worker.once('message', result => result.error ? reject(failure(400, result.error)) : resolve(result));
    worker.once('error', () => reject(failure(500, 'Korridorplanung fehlgeschlagen.')));
    worker.once('exit', code => { if (code !== 0) reject(failure(500, 'Korridorplanung wurde unterbrochen.')); });
  });
}

export class TileJobs {
  constructor(cache, routeFile) { this.cache = cache; this.db = cache.db; this.routeFile = routeFile; this.runs = new Map(); }
  current(namespace) {
    this.db.prepare("UPDATE jobs SET state='paused',message='Server wurde unterbrochen. Bitte fortsetzen.' WHERE state='running' AND lease < ?").run(this.cache.now());
    return this.db.prepare('SELECT * FROM jobs WHERE namespace=? ORDER BY created DESC LIMIT 1').get(namespace);
  }
  summary(namespace) {
    const job = this.current(namespace);
    if (!job) return null;
    const groups = this.db.prepare(`SELECT i.source,count(*) AS total,sum(CASE WHEN t.expires>? THEN 1 ELSE 0 END) AS fresh,sum(CASE WHEN i.done=2 THEN 1 ELSE 0 END) AS unavailable FROM items i LEFT JOIN tiles t ON t.key=i.key WHERE i.job=? GROUP BY i.source`).all(this.cache.now(), job.id);
    const planned = groups.reduce((n, row) => n + row.total, 0), fresh = groups.reduce((n, row) => n + row.fresh, 0);
    const unavailable = groups.reduce((n, row) => n + row.unavailable, 0);
    const remaining = Object.fromEntries(groups.map(row => [row.source, row.total - row.fresh - row.unavailable]));
    const averages = Object.fromEntries(this.db.prepare('SELECT source,avg(size) AS n FROM tiles WHERE namespace=? GROUP BY source').all(namespace).map(row => [row.source, row.n]));
    const estimatedBytes = groups.reduce((n, row) => n + row.total * (averages[row.source] || (row.source === SOURCES[0] ? 100000 : 150000)), 0);
    return { id: job.id, state: job.state, message: job.message, planned, fresh, unavailable, remaining, attempts: job.attempts, transferred: job.transferred, retryAt: job.retryAt, estimatedBytes: Math.ceil(estimatedBytes), estimatedSeconds: Math.ceil(Object.values(remaining).reduce((a, b) => a + b, 0) * Math.max(.15, this.cache.intervalMs / 1000)), estimateBasedOnCache: groups.every(row => Boolean(averages[row.source])), variantsReady: !this.db.prepare("SELECT 1 FROM items WHERE job=? AND resource='' LIMIT 1").get(job.id) };
  }
  async plan(token) {
    const namespace = digest(token), old = this.current(namespace);
    if (old?.state === 'running') throw failure(409, 'Vor der Neuplanung den Download pausieren.');
    if (!this.planning) this.planning = computePlan(this.routeFile).finally(() => { this.planning = null; });
    const result = await this.planning;
    const rows = [];
    for (const source of SOURCES) {
      const variant = this.cache.variant(namespace, source);
      for (const { z, x, y } of result.tiles) {
        // Capture the exact SDK image variant rather than prefetching an unused format.
        const resource = variant ? `${variant.prefix}${source}/${z}/${x}/${y}${variant.variant}` : '';
        const key = resource ? parseTile(resource, token).key : digest(`${namespace}:${source}:${z}/${x}/${y}`);
        rows.push({ resource, key, source });
      }
    }
    // SQLite pages and WAL grow too; reserve conservatively before inserting the plan.
    const reservation = await this.cache.reserve(Math.max(262144, rows.length * 1500));
    const id = randomUUID(), now = this.cache.now();
    try {
      this.cache.transaction(() => {
        const active = this.current(namespace);
        if (active?.state === 'running') throw failure(409, 'Ein Download läuft bereits.');
        for (const row of this.db.prepare('SELECT id FROM jobs WHERE namespace=?').all(namespace)) this.db.prepare('DELETE FROM items WHERE job=?').run(row.id);
        this.db.prepare('DELETE FROM jobs WHERE namespace=?').run(namespace);
        this.db.prepare('INSERT INTO jobs(id,namespace,state,created,updated,lease,owner,message,budgets) VALUES(?,?,?,?,?,?,?,?,?)').run(id, namespace, 'paused', now, now, 0, '', 'Plan erstellt. Freikontingent vor dem Download bestätigen.', '{}');
        const insert = this.db.prepare('INSERT OR IGNORE INTO items(job,key,resource,source) VALUES(?,?,?,?)');
        for (const row of rows) insert.run(id, row.key, row.resource, row.source);
      });
    } finally { this.db.prepare('DELETE FROM reservations WHERE id=?').run(reservation); }
    return { ...this.summary(namespace), routeMeters: result.routeMeters, radiusKm: result.radiusKm, maxZoom: result.maxZoom, marginMeters: result.marginMeters };
  }
  async start(token, confirmation, referer) {
    const namespace = digest(token), summary = this.summary(namespace), job = this.current(namespace);
    if (!job) throw failure(409, 'Bitte zuerst die Route planen.');
    if (summary.state === 'running') throw failure(409, 'Der Download läuft bereits.');
    if (!summary.variantsReady) throw failure(409, 'Bitte zuerst Satellitenkarte und Gelände laden, danach die Route neu planen.');
    if (summary.retryAt > this.cache.now()) throw failure(429, 'Mapbox-Wartezeit ist noch nicht abgelaufen.');
    if (summary.estimatedBytes + await this.cache.indexSize() > this.cache.limitBytes) throw failure(409, 'Das geschätzte Routenpaket überschreitet das Speicherlimit. Kein Download gestartet.');
    // These are manually verified account allowances, NOT HTTP rate-limit headers.
    // Use only 80% to leave room for normal map use. Every attempt consumes a unit.
    const budget = {};
    for (const name of ['satellite', 'terrain', 'combined']) {
      if (!Number.isSafeInteger(confirmation?.[name]) || confirmation[name] < 0) throw failure(409, 'Kostenloses Restkontingent für beide Quellen und insgesamt ist unbekannt.');
      budget[name] = Math.floor(confirmation[name] * .8);
    }
    if (confirmation?.verified !== true || !Number.isFinite(confirmation?.checkedAt) || Math.abs(this.cache.now() - confirmation.checkedAt) > 15 * 60000) throw failure(409, 'Restkontingent aktuell im Mapbox-Konto prüfen und bestätigen.');
    const needSatellite = summary.remaining[SOURCES[0]] || 0, needTerrain = summary.remaining[SOURCES[1]] || 0;
    if (needSatellite > budget.satellite || needTerrain > budget.terrain || needSatellite + needTerrain > budget.combined) throw failure(409, 'Bestätigtes kostenloses Restkontingent reicht mit 20 % Reserve nicht aus. Kein Download gestartet.');
    if (this.cache.closing) throw failure(503, 'Server wird beendet.');
    const absoluteBudget = { satellite: job.satelliteAttempts + budget.satellite, terrain: job.terrainAttempts + budget.terrain, combined: job.attempts + budget.combined };
    this.cache.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM jobs WHERE state='running' AND lease>? LIMIT 1").get(this.cache.now())) throw failure(409, 'Ein anderer Vorabdownload läuft bereits.');
      this.db.prepare("UPDATE items SET done=0 WHERE job=? AND done=1 AND key NOT IN(SELECT key FROM tiles WHERE expires>?)").run(job.id, this.cache.now());
      this.db.prepare("UPDATE jobs SET state='running',updated=?,lease=?,owner=?,budgets=?,message='',retryAt=0 WHERE id=?").run(this.cache.now(), this.cache.now() + 60000, this.cache.owner, JSON.stringify(absoluteBudget), job.id);
    });
    const controller = new AbortController();
    const promise = this.run(job.id, namespace, token, controller, referer).finally(() => this.runs.delete(job.id));
    this.runs.set(job.id, { controller, promise });
    return this.summary(namespace);
  }
  pause(namespace, message = 'Download pausiert.') {
    const job = this.current(namespace);
    if (!job) return;
    this.db.prepare("UPDATE jobs SET state='paused',message=?,updated=? WHERE id=? AND state='running'").run(message, this.cache.now(), job.id);
    this.runs.get(job.id)?.controller.abort();
  }
  attempt(jobId, source) {
    this.cache.transaction(() => {
      const job = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId), budget = JSON.parse(job.budgets);
      const field = source === SOURCES[0] ? 'satelliteAttempts' : 'terrainAttempts', cap = source === SOURCES[0] ? budget.satellite : budget.terrain;
      if (job.state !== 'running' || job.attempts >= budget.combined || job[field] >= cap) throw failure(409, 'Bestätigtes kostenloses Downloadbudget ausgeschöpft.');
      this.cache.count('prefetch-attempts');
      this.cache.count(source === SOURCES[0] ? 'prefetch-satellite' : 'prefetch-terrain');
      this.db.prepare(`UPDATE jobs SET attempts=attempts+1,${field}=${field}+1,updated=?,lease=? WHERE id=?`).run(this.cache.now(), this.cache.now() + 60000, jobId);
    });
  }
  async run(jobId, namespace, token, controller, referer) {
    const heartbeat = setInterval(() => {
      const row = this.db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId);
      if (row?.state !== 'running') controller.abort();
      else this.db.prepare('UPDATE jobs SET lease=? WHERE id=?').run(this.cache.now() + 60000, jobId);
    }, 500);
    const claimed = new Set(); let firstError;
    const work = async () => {
      while (!controller.signal.aborted) {
        const candidates = this.db.prepare('SELECT * FROM items WHERE job=? AND done=0 LIMIT 4').all(jobId);
        const item = candidates.find(row => !claimed.has(row.key));
        if (!item) return;
        claimed.add(item.key);
        try {
          const result = await this.cache.get(item.resource, token, { signal: controller.signal, priority: 1, referer, onAttempt: source => this.attempt(jobId, source) });
          if (result.cache === 'bypass' || result.expires <= this.cache.now()) throw failure(409, result.reason === 'capacity' ? 'Speicherlimit erreicht. Vorbereitung pausiert.' : 'Quelle erlaubt keine ausreichend lange Zwischenspeicherung. Vorbereitung pausiert.');
          this.db.prepare('UPDATE items SET done=1 WHERE job=? AND key=?').run(jobId, item.key);
          const networkBytes = result.networkBytes || 0;
          this.db.prepare('UPDATE jobs SET transferred=transferred+? WHERE id=?').run(networkBytes, jobId);
          this.cache.count('prefetch-bytes', networkBytes);
        } catch (error) {
          if (error.status === 404) {
            // Missing provider coverage (for example DEM over sea) is not a cached image.
            this.db.prepare('UPDATE items SET done=2 WHERE job=? AND key=?').run(jobId, item.key);
          } else { firstError ??= error; controller.abort(); throw error; }
        }
        finally { claimed.delete(item.key); }
      }
    };
    try {
      const outcomes = await Promise.allSettled([work(), work()]);
      const failed = outcomes.find(result => result.status === 'rejected');
      if (failed) throw firstError || failed.reason;
      const current = this.db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId);
      if (current?.state === 'running') this.db.prepare("UPDATE jobs SET state='complete',message='Downloadlauf beendet. Gültigkeit vor der Präsentation erneut prüfen.',lease=0 WHERE id=?").run(jobId);
    } catch (error) {
      controller.abort();
      const status = error.status === 401 || error.status === 403 ? 'error' : 'paused';
      const message = error.name === 'AbortError' ? 'Download pausiert.' : error.status ? error.message : 'Netzwerkfehler; Download pausiert.';
      this.db.prepare('UPDATE jobs SET state=?,message=?,retryAt=?,lease=0 WHERE id=?').run(status, message, error.retryAt || 0, jobId);
    } finally { clearInterval(heartbeat); }
  }
  async close() {
    for (const [id, run] of this.runs) { this.db.prepare("UPDATE jobs SET state='paused',message='Server beendet; Fortsetzen erforderlich.' WHERE id=?").run(id); run.controller.abort(); }
    await Promise.allSettled([...this.runs.values()].map(run => run.promise));
  }
}
