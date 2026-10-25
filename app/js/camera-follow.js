import { bearing, clamp, pointAt } from './route.js';

// Average by travelled distance so dense GPX samples and switchbacks do not shake the camera.
export function scenicPoint(route, progress, radius = 600) {
  const sum = [0, 0]; let total = 0;
  for (let i = -4; i <= 4; i++) {
    const weight = 5 - Math.abs(i), point = pointAt(route, progress + i * radius / (4 * route.length));
    sum[0] += point[0] * weight; sum[1] += point[1] * weight; total += weight;
  }
  return sum.map(value => value / total);
}
export function scenicHeading(route, progress) {
  return bearing(scenicPoint(route, clamp(progress - 600 / route.length)), scenicPoint(route, clamp(progress + 900 / route.length)));
}
export function easeHeading(previous, desired, seconds) {
  if (!Number.isFinite(previous)) return desired;
  const difference = ((desired - previous + 540) % 360 + 360) % 360 - 180;
  const dt = clamp(seconds, 0, .1);
  return previous + clamp(difference * (1 - Math.exp(-dt * .8)), -12 * dt, 12 * dt);
}
