// Read the native Mapbox GL JS 3.33 cache; Mapbox remains responsible for fetching and expiry.
function isFresh(response, now) {
  return Boolean(response?.ok && Date.parse(response.headers.get('expires') || '') > now && !/(?:^|,)\s*(?:no-cache|no-store)\b/i.test(response.headers.get('cache-control') || ''));
}

export async function isBrowserMapTileCached(url, { storage, now = Date.now() } = {}) {
  try {
    storage ??= globalThis.caches;
    if (!storage?.has || !await storage.has('mapbox-tiles')) return false;
    const parsed = new URL(url);
    if (parsed.origin !== 'https://api.mapbox.com') return false;
    // Match the native cache's key, including its content-specific parameters.
    // Only the lookup key is normalized; the outgoing URL stays completely unchanged.
    const query = new URLSearchParams();
    for (const name of ['language', 'worldview', 'jobid']) {
      const value = parsed.searchParams.get(name);
      if (value) query.set(name, value);
    }
    parsed.search = query.toString();
    const cache = await storage.open('mapbox-tiles');
    return isFresh(await cache.match(parsed.href), now);
  } catch { return false; }
}

export async function readBrowserMapCache({ storage, now = Date.now() } = {}) {
  try {
    storage ??= globalThis.caches;
    if (!storage?.has) return { status: 'unavailable' };
    if (!await storage.has('mapbox-tiles')) return { status: 'available', total: 0, fresh: 0, satellite: 0, terrain: 0 };
    const cache = await storage.open('mapbox-tiles');
    const requests = await cache.keys();
    const entries = await Promise.all(requests.map(async request => {
      const response = await cache.match(request);
      if (!response) return null;
      const path = new URL(request.url).pathname;
      return {
        fresh: isFresh(response, now),
        satellite: /^\/v4\/mapbox\.satellite\//.test(path),
        terrain: /\/(?:mapbox\.)?(?:mapbox-terrain-dem-v1|terrain-rgb)\//.test(path)
      };
    }));
    const present = entries.filter(Boolean);
    return { status: 'available', total: present.length, fresh: present.filter(e => e.fresh).length, satellite: present.filter(e => e.satellite).length, terrain: present.filter(e => e.terrain).length };
  } catch { return { status: 'unavailable' }; }
}

export function describeBrowserMapCache(result) {
  if (result.status !== 'available') return 'Der zusätzliche Mapbox-Speicher ist in diesem Browser nicht zugänglich. Die Karte bleibt nutzbar; der normale Browser-Cache wird weiterhin vom Browser verwaltet.';
  if (!result.total) return 'Noch keine Kacheln im Mapbox-Browsercache. Öffne eine Etappe, warte auf die Karte und prüfe anschließend erneut.';
  return `${result.total} Kacheln im Browser gespeichert · ${result.fresh} noch gültig. Darunter ${result.satellite} Satellitenbilder${result.terrain ? ` und ${result.terrain} Höhenkacheln` : ''}. Abgelaufene Kacheln müssen beim erneuten Aufruf aktualisiert werden.`;
}
