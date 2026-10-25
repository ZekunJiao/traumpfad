import { clamp } from './route.js';

function coordinates(point) {
  return Array.isArray(point) ? point : [point?.x, point?.y];
}

export function nearestRouteProgress(route, targetPoint, project, maxDistance = Infinity) {
  const [targetX, targetY] = coordinates(targetPoint);
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY) || typeof project !== 'function') return null;

  let closest = null;
  for (let i = 1; i < route.points.length; i++) {
    const a = coordinates(project(route.points[i - 1]));
    const b = coordinates(project(route.points[i]));
    if (![a[0], a[1], b[0], b[1]].every(Number.isFinite)) continue;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0 ? clamp(((targetX - a[0]) * dx + (targetY - a[1]) * dy) / lengthSquared) : 0;
    const x = a[0] + dx * t, y = a[1] + dy * t;
    const pixelDistance = Math.hypot(targetX - x, targetY - y);
    if (pixelDistance > maxDistance || (closest && pixelDistance >= closest.distance)) continue;

    const routeMeters = route.cumulative[i - 1] + (route.cumulative[i] - route.cumulative[i - 1]) * t;
    closest = { progress: clamp(routeMeters / route.length), distance: pixelDistance, segmentIndex: i - 1 };
  }
  return closest;
}

export function findRouteHit({ routes, stages, currentStageIndex, candidateIndices, point, project, tolerance = 15 }) {
  const candidates = candidateIndices || routes.map((_, index) => index);
  const seen = new Set();
  const hits = [];
  for (const index of candidates) {
    if (!Number.isInteger(index) || index < 0 || index >= routes.length || seen.has(index)) continue;
    seen.add(index);
    const position = nearestRouteProgress(routes[index], point, project, tolerance);
    if (position) hits.push({ stageIndex: index, ...position });
  }

  const current = hits.find(hit => hit.stageIndex === currentStageIndex);
  if (current) return current;

  const dayRoutes = hits.filter(hit => !stages[hit.stageIndex]?.isFullRoute);
  dayRoutes.sort((a, b) => a.distance - b.distance || a.stageIndex - b.stageIndex);
  if (dayRoutes.length) return dayRoutes[0];

  hits.sort((a, b) => a.distance - b.distance || a.stageIndex - b.stageIndex);
  return hits[0] || null;
}
