import test from 'node:test';
import assert from 'node:assert/strict';
import { overnightPlaces } from '../app/js/overnight-places.js';
import { prepareRoute } from '../app/js/route.js';

test('sleep places resolve to their day endpoint on the one combined route', () => {
  const stages = [
    { day: 1, id: 'tag-01', end: 'Village', overnight: null, routeProvenance: { endPointIndex: 1 } },
    { day: 2, id: 'tag-02', end: 'Pass', overnight: 'Hut', routeProvenance: { endPointIndex: 2 } }
  ];
  const route = prepareRoute([[11,47],[11.5,47.5],[12,48,1000]]);
  const places = overnightPlaces(stages, route);
  assert.equal(places.length, 2);
  assert.equal(places[0].confirmed, false);
  assert.equal(places[0].name, 'Village');
  assert.deepEqual(places[0].coordinates, [11.5,47.5]);
  assert.equal(places[1].confirmed, true);
  assert.equal(places[1].name, 'Hut');
  assert.deepEqual(places[1].coordinates, [12,48]);
  assert.equal(places[1].progress, 1);
});
