import test from 'node:test';
import assert from 'node:assert/strict';
import { easeHeading, scenicPoint } from '../app/js/camera-follow.js';
import { prepareRoute, pointAt } from '../app/js/route.js';

test('heading crosses north by the short arc and bounds angular speed on sharp turns', () => {
  assert.ok(easeHeading(179, -179, .1) > 179);
  assert.ok(easeHeading(-179, 179, .1) < -179);
  assert.ok(Math.abs(easeHeading(0, 160, .1)) <= 1.2 + 1e-12);
  let heading = 0;
  for (let i = 0; i < 600; i++) heading = easeHeading(heading, 90, 1 / 60);
  assert.ok(heading > 75 && heading < 90);
  assert.equal(easeHeading(20, 90, 0), 20);
});
test('camera path softens a switchback without changing the displayed GPX route', () => {
  const points = [[11,47],[11.005,47.005],[11,47.01],[11.005,47.015]];
  const route = prepareRoute(points), original = structuredClone(route);
  const corner = route.cumulative[1] / route.length;
  const actual = pointAt(route, corner), camera = scenicPoint(route, corner);
  assert.ok(camera[0] < actual[0]);
  assert.deepEqual(route, original);
  assert.ok(camera.every(Number.isFinite));
});
