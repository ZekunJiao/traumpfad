import test from 'node:test';
import assert from 'node:assert/strict';
import { routePosition } from '../app/js/map.js';
import { prepareRoute, sliceRoute } from '../app/js/route.js';

test('white position point stays at the end of the travelled line when seeking forward or backwards', () => {
  const route = prepareRoute([[11,47],[11.1,47],[11.1,47.1]]);
  for (const progress of [0,.3,.9,.2,1]) {
    const point = routePosition(route, progress);
    assert.equal(point.geometry.type, 'Point');
    assert.deepEqual(point.geometry.coordinates, sliceRoute(route, progress).at(-1));
  }
});
