export const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const radians = x => x * Math.PI / 180;
export function distance(a, b) {
  const dLat = radians(b[1] - a[1]), dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
export function prepareRoute(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) throw new Error('Eine Route braucht mindestens zwei Koordinaten.');
  const points = coordinates.map(p => {
    if (!Array.isArray(p) || p.length < 2 || !p.slice(0, 2).every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) throw new Error('Ungültige Routenkoordinaten.');
    return p.slice(0, 3);
  });
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
  const length = cumulative.at(-1);
  if (length < 1) throw new Error('Die Route muss länger als einen Meter sein.');
  return { points, cumulative, length };
}
export function pointStageCoordinates(stage) {
  const photoPoint = Array.isArray(stage?.stops) ? stage.stops.find(stop => Array.isArray(stop.coordinates)) : null;
  return photoPoint?.coordinates || stage?.location?.coordinates;
}
export function pointAt(route, progress) {
  const position = clamp(progress) * route.length;
  let low = 1, high = route.cumulative.length - 1;
  while (low < high) { const mid = (low + high) >> 1; if (route.cumulative[mid] < position) low = mid + 1; else high = mid; }
  const segment = route.cumulative[low] - route.cumulative[low - 1];
  const t = segment > 0 ? (position - route.cumulative[low - 1]) / segment : 0;
  const a = route.points[low - 1], b = route.points[low];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
export function nearestProgress(route, point) {
  const scale = Math.cos(radians(point[1]));
  const x = value => (value[0] - point[0]) * scale;
  const y = value => value[1] - point[1];
  let bestDistance = Infinity, bestProgress = 0;
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1], b = route.points[i];
    const ax = x(a), ay = y(a), dx = x(b) - ax, dy = y(b) - ay;
    const denominator = dx * dx + dy * dy;
    const t = denominator ? clamp(-((ax * dx) + (ay * dy)) / denominator) : 0;
    const distanceSquared = (ax + dx * t) ** 2 + (ay + dy * t) ** 2;
    if (distanceSquared < bestDistance) {
      bestDistance = distanceSquared;
      bestProgress = (route.cumulative[i - 1] + (route.cumulative[i] - route.cumulative[i - 1]) * t) / route.length;
    }
  }
  return clamp(bestProgress);
}
export function sliceRoute(route, progress) {
  const target = clamp(progress) * route.length;
  const points = route.points.filter((_, i) => route.cumulative[i] < target);
  points.push(pointAt(route, progress));
  if (points.length < 2) points.unshift([...points[0]]);
  return points;
}
export function bearing(a, b) {
  const p1 = radians(a[1]), p2 = radians(b[1]), dl = radians(b[0] - a[0]);
  return Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI;
}
export function destination(point, meters, heading) {
  const angular = meters / 6371008.8, b = radians(heading), lat = radians(point[1]), lon = radians(point[0]);
  const nextLat = Math.asin(Math.sin(lat) * Math.cos(angular) + Math.cos(lat) * Math.sin(angular) * Math.cos(b));
  const nextLon = lon + Math.atan2(Math.sin(b) * Math.sin(angular) * Math.cos(lat), Math.cos(angular) - Math.sin(lat) * Math.sin(nextLat));
  return [nextLon * 180 / Math.PI, nextLat * 180 / Math.PI];
}
export function feature(coordinates, properties = {}) { return { type: 'Feature', properties, geometry: { type: 'LineString', coordinates } }; }

export function validateJourney(journey) {
  const errors = [], stages = journey?.stages, photos = journey?.photos;
  if (!Array.isArray(stages) || !stages.length) return ['Die Reise enthält keine Etappen.'];
  if (!Array.isArray(photos)) errors.push('Die Fotoliste fehlt.');
  if (!Array.isArray(journey.chapters)) errors.push('Die Kapitelliste fehlt.');
  const stageIds = new Set(), photoIds = new Set(), stopIds = new Set();
  for (const p of photos || []) { if (!p.id || photoIds.has(p.id)) errors.push(`Doppelte oder fehlende Foto-ID: ${p.id}`); photoIds.add(p.id); }
  for (const s of stages) {
    if (!s.id || stageIds.has(s.id)) errors.push(`Doppelte oder fehlende Etappen-ID: ${s.id}`); stageIds.add(s.id);
    // Older saved journeys may serialize this flag as the string "true".
    // The editor already treats that value as truthy; validation must agree.
    const pointStage = s.isPointStage === true || s.isPointStage === 'true';
    if (!s.title || (!pointStage && !s.routeFile)) errors.push(`${s.id}: Titel oder Routendatei fehlt.`);
    if (pointStage) {
      const coordinates = pointStageCoordinates(s);
      if (!Array.isArray(coordinates) || coordinates.length < 2 || !coordinates.slice(0, 2).every(Number.isFinite)
        || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) errors.push(`${s.id}: Ungültige Fotopunktkoordinaten.`);
    }
    if (!Array.isArray(s.stops)) errors.push(`${s.id}: Die Fotostoppliste fehlt.`);
    if (s.date && (!/^\d{4}-\d{2}-\d{2}$/.test(s.date) || Number.isNaN(Date.parse(s.date)) || new Date(s.date).toISOString().slice(0, 10) !== s.date)) errors.push(`${s.id}: Ungültiges Datum.`);
    if (!pointStage && (!Number.isFinite(s.durationSeconds) || s.durationSeconds <= 0)) errors.push(`${s.id}: Die Flugdauer muss positiv sein.`);
    for (const stop of s.stops || []) {
      if (!stop.id || stopIds.has(stop.id)) errors.push(`Doppelte oder fehlende Fotostopp-ID: ${stop.id}`); stopIds.add(stop.id);
      if (!Number.isFinite(stop.progress) || stop.progress < 0 || stop.progress > 1) errors.push(`${stop.id}: Position muss zwischen 0 und 1 liegen.`);
      if (stop.photoIds !== undefined && !Array.isArray(stop.photoIds)) errors.push(`${stop.id}: Medienliste muss eine Liste sein.`);
      if (stop.coordinates !== undefined) {
        const coordinates = stop.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length < 2 || !coordinates.slice(0, 2).every(Number.isFinite)
          || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) errors.push(`${stop.id}: Ungültige Koordinaten für Fotopunkt.`);
      }
      for (const id of stop.photoIds || []) if (!photoIds.has(id)) errors.push(`${stop.id}: Foto ${id} fehlt.`);
    }
  }
  for (const p of photos || []) {
    if (p.stageId && !stageIds.has(p.stageId)) errors.push(`${p.id}: Etappe ${p.stageId} fehlt.`);
    if (p.galleryTarget && !['day', 'sleep', 'standpoint'].includes(p.galleryTarget)) errors.push(`${p.id}: Ungültiges Galerieziel.`);
  }
  for (const c of journey.chapters || []) for (const id of c.stageIds || []) if (!stageIds.has(id)) errors.push(`${c.id}: Etappe ${id} fehlt.`);
  return errors;
}
