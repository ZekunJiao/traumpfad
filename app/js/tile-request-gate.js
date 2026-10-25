import { isBrowserMapTileCached } from './browser-cache.js';

// Spread network tile starts over time; native cache hits do not need this delay.
export function createTileRequestGate({ intervalMs = 150, isCached = isBrowserMapTileCached } = {}) {
  const pending = [];
  let lastStart = -Infinity, timer;
  function pump() {
    clearTimeout(timer);
    if (!pending.length) return;
    const delay = lastStart + intervalMs - performance.now();
    if (delay > 0) { timer = setTimeout(pump, Math.ceil(delay)); return; }
    const item = pending.shift();
    item.signal?.removeEventListener('abort', item.abort);
    lastStart = performance.now();
    item.resolve({ url: item.url });
    pump();
  }
  return (url, type, { signal } = {}) => {
    if (type !== 'Tile' || !/^https:\/\/api\.mapbox\.com\/v4\//.test(url)) return { url };
    if (signal?.aborted) return Promise.reject(new DOMException('Abgebrochene Kartenanfrage', 'AbortError'));
    return Promise.resolve().then(() => isCached(url)).catch(() => false).then(cached => {
      if (signal?.aborted) throw new DOMException('Abgebrochene Kartenanfrage', 'AbortError');
      if (cached) return { url };
      return new Promise((resolve, reject) => {
      const item = { url, signal, resolve, abort: () => {
        const index = pending.indexOf(item);
        if (index === -1) return;
        pending.splice(index, 1);
        signal.removeEventListener('abort', item.abort);
        reject(new DOMException('Abgebrochene Kartenanfrage', 'AbortError'));
        pump();
      } };
      signal?.addEventListener('abort', item.abort, { once: true });
      pending.push(item);
      pump();
      });
    });
  };
}
