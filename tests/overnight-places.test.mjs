import test from 'node:test';
import assert from 'node:assert/strict';
import { overnightPlaces } from '../app/js/overnight-places.js';

test('overnight labels distinguish actual sleeping places from provisional stage destinations', () => {
  const stages = [{ isFullRoute: true, end: 'Venice' }, { day: 1, end: 'Village', overnight: null }, { day: 2, end: 'Pass', overnight: 'Hut' }];
  const routes = stages.map(() => ({ points: [[11,47],[12,48,1000]] }));
  const places = overnightPlaces(stages, routes);
  assert.equal(places.length, 2);
  assert.equal(places[0].confirmed, false);
  assert.equal(places[0].name, 'Village');
  assert.equal(places[1].confirmed, true);
  assert.equal(places[1].name, 'Hut');
  assert.deepEqual(places[1].coordinates, [12,48]);
});
