import { clamp } from './route.js';

export function interpolateCamera(from, to, progress) {
  const t = clamp(progress), u = t * t * (3 - 2 * t);
  if (t === 0 || t === 1) {
    const pose = t === 0 ? from : to;
    return { position: { ...pose.position }, orientation: [...pose.orientation] };
  }
  const a = from.orientation, b = [...to.orientation];
  let dot = a.reduce((sum, value, i) => sum + value * b[i], 0);
  if (dot < 0) { dot = -dot; b.forEach((value, i) => { b[i] = -value; }); }
  const angle = Math.acos(Math.min(1, dot));
  const weights = dot > .9995 ? [1 - u, u] : [Math.sin((1 - u) * angle) / Math.sin(angle), Math.sin(u * angle) / Math.sin(angle)];
  const orientation = a.map((value, i) => value * weights[0] + b[i] * weights[1]);
  const length = Math.hypot(...orientation);
  const lift = Math.hypot(to.position.x - from.position.x, to.position.y - from.position.y) * .2 * 16 * u * u * (1 - u) * (1 - u);
  return {
    position: {
      x: from.position.x + (to.position.x - from.position.x) * u,
      y: from.position.y + (to.position.y - from.position.y) * u,
      z: from.position.z + (to.position.z - from.position.z) * u + lift
    },
    orientation: orientation.map(value => value / length)
  };
}
