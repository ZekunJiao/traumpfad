import test from 'node:test';
import assert from 'node:assert/strict';
import { JourneyMap } from '../app/js/map.js';
import { prepareRoute } from '../app/js/route.js';
import { findRouteHit, nearestRouteProgress } from '../app/js/route-hit-test.js';

const project = ([lng, lat]) => [lng * 1000, lat * 1000];
const full = prepareRoute([[0, 0], [.1, 0], [1, 0]]);
const day = prepareRoute([[.1, 0], [1, 0]]);
const stages = [{ isFullRoute: true }, { isFullRoute: false }, { isFullRoute: false }];

test('route hit interpolates by travelled distance between GPS points', () => {
  const hit = nearestRouteProgress(full, [550, 4], project, 15);
  const expected = (full.cumulative[1] + (full.cumulative[2] - full.cumulative[1]) * .5) / full.length;
  assert.equal(hit.segmentIndex, 1);
  assert.ok(Math.abs(hit.progress - expected) < 1e-9);
  assert.equal(hit.distance, 4);
});

test('route hit accepts the 15px boundary and rejects points outside it', () => {
  assert.equal(nearestRouteProgress(full, [550, 15], project, 15)?.distance, 15);
  assert.equal(nearestRouteProgress(full, [550, 15.01], project, 15), null);
});

test('current route wins an overlap, then a day route wins over the full route', () => {
  const dayTwo = prepareRoute([[.1, .2], [1, .2]]);
  const routes = [full, day, dayTwo];
  const currentHit = findRouteHit({ routes, stages, currentStageIndex: 0, point: [550, 0], project, tolerance: 15 });
  assert.equal(currentHit.stageIndex, 0);

  const otherDayHit = findRouteHit({ routes, stages, currentStageIndex: 2, point: [550, 0], project, tolerance: 120 });
  assert.equal(otherDayHit.stageIndex, 1);
});

test('schematic clicks use the screen-space hit area and ignore misses', () => {
  const calls = [];
  const view = Object.create(JourneyMap.prototype);
  Object.assign(view, {
    routes: [full, day], stages: stages.slice(0, 2), stageIndex: 0,
    project, onRouteSeek: (...args) => calls.push(args),
    container: { querySelector: () => ({ getScreenCTM: () => ({ a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 }) }) }
  });
  const event = (clientX, clientY) => ({ clientX, clientY, target: { closest: () => null }, preventDefault() { this.prevented = true; } });
  const hit = event(1110, 28); // SVG x=550, 4px from the route after its 2x screen transform.
  view.handleSchematicRouteClick(hit);
  assert.deepEqual(calls[0]?.[0], 0);
  assert.equal(hit.prevented, true);
  const miss = event(1110, 52); // 16px from the route in screen pixels.
  view.handleSchematicRouteClick(miss);
  assert.equal(calls.length, 1);
});

test('Mapbox clicks resolve visible route features and seek to the nearest position', () => {
  const listeners = new Map(), calls = [], queries = [];
  const map = {
    on: (name, callback) => listeners.set(name, callback),
    queryRenderedFeatures: (geometry, options) => {
      queries.push({ geometry, options });
      return [{ properties: { stageIndex: 0 } }, { properties: { stageIndex: 1 } }];
    },
    project: point => ({ x: point[0] * 1000, y: point[1] * 1000 }),
    getCanvas: () => ({ style: {} })
  };
  const view = Object.create(JourneyMap.prototype);
  Object.assign(view, { map, ready: true, stageIndex: 0, routes: [full, day], stages: stages.slice(0, 2), onRouteSeek: (...args) => calls.push(args) });
  view.bindRouteInteractions(map);
  listeners.get('click')({ point: { x: 550, y: 4 }, originalEvent: { target: { closest: () => null } } });
  assert.equal(queries[0].geometry[0][0], 535);
  assert.deepEqual(queries[0].options.layers, ['journey-active', 'journey-all']);
  assert.equal(calls[0][0], 0);
  assert.ok(Math.abs(calls[0][1] - .55) < .01);

  const beforeMiss = calls.length;
  listeners.get('click')({ point: { x: 550, y: 20 }, originalEvent: { target: { closest: () => null } } });
  assert.equal(calls.length, beforeMiss);
  const beforeMarker = queries.length;
  listeners.get('click')({ point: { x: 550, y: 4 }, originalEvent: { target: { closest: () => ({}) } } });
  assert.equal(calls.length, beforeMiss);
  assert.equal(queries.length, beforeMarker);
});

