import { prepareRoute, pointAt } from '../app/js/route.js';

// A union of overlapping geodesic disks covers every route segment, including
// sparse GPX sections. The half-spacing margin makes coverage conservative.
export function planCorridor(coordinates, { radiusKm = 20, maxZoom = 14, spacingMeters = 1000 } = {}) {
  if (!(radiusKm > 0 && radiusKm <= 20) || !Number.isInteger(maxZoom) || maxZoom < 0 || maxZoom > 14 || spacingMeters <= 0) throw new Error('Ungültiges Korridorprofil.');
  const route = prepareRoute(coordinates), count = Math.ceil(route.length / spacingMeters);
  if (count > 20000) throw new Error('Route überschreitet das Planungslimit.');
  const points = Array.from({ length: count + 1 }, (_, i) => pointAt(route, i / count));
  const keys = new Set(), tiles = [], radius = radiusKm * 1000 + spacingMeters / 2;
  for (let z = 0; z <= maxZoom; z++) {
    const n = 2 ** z;
    for (const [lon, lat] of points) {
      const latitude = Math.max(-85, Math.min(85, lat)), rads = latitude * Math.PI / 180;
      const cx = (lon + 180) / 360 * n, cy = (1 - Math.asinh(Math.tan(rads)) / Math.PI) / 2 * n;
      const outerLat = Math.min(85, Math.abs(latitude) + radius / 111000);
      const r = radius / (40075016.686 * Math.cos(outerLat * Math.PI / 180)) * n;
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(n - 1, Math.floor(cy + r)); y++) {
        for (let rawX = Math.floor(cx - r); rawX <= Math.floor(cx + r); rawX++) {
          const dx = cx - Math.max(rawX, Math.min(rawX + 1, cx));
          const dy = cy - Math.max(y, Math.min(y + 1, cy));
          if (dx * dx + dy * dy > r * r) continue;
          const x = ((rawX % n) + n) % n, key = `${z}/${x}/${y}`;
          if (!keys.has(key)) { keys.add(key); tiles.push({ z, x, y }); }
        }
      }
    }
  }
  return { tiles, routeMeters: route.length, radiusKm, maxZoom, marginMeters: spacingMeters / 2 };
}
