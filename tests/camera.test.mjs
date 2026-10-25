import test from 'node:test';
import assert from 'node:assert/strict';
import { JourneyMap } from '../app/js/map.js';
import { prepareRoute } from '../app/js/route.js';

function cameraFixture(elevations) {
  let altitude, updates = 0, queries = 0, retry;
  globalThis.window = { matchMedia: () => ({ matches: false }), mapboxgl: { MercatorCoordinate: { fromLngLat: (position, height) => { altitude = height; return { position, height }; } } } };
  const view = Object.create(JourneyMap.prototype);
  Object.assign(view, {
    progress: 0, ready: true, stageIndex: 0, exploring: false, cameraPosition: null, cameraAltitude: null,
    routes: [prepareRoute([[11, 47], [11.05, 47.05], [11.1, 47.1]])], updateSchema() {},
    map: {
      getSource: () => ({ setData() {} }), stop() {},
      queryTerrainElevation: () => elevations[queries++ % elevations.length],
      getFreeCameraOptions: () => ({ lookAtPoint() {} }), setFreeCameraOptions() { updates++; },
      once: (_, callback) => { retry = callback; }
    }
  });
  return { view, stats: () => ({ altitude, updates, queries, retry }) };
}
test('camera clearance considers a ridge between the camera and its target', () => {
  const { view, stats } = cameraFixture([800, 900, 1100, 1500, 2800, 1300, 900, 800, 700, 800, 900, 950, 1000]);
  view.setProgress(.5);
  assert.equal(stats().queries, 13); assert.equal(stats().altitude, 4500); assert.equal(stats().updates, 1);
});
test('missing terrain never becomes an assumed sea-level camera height', () => {
  const { view, stats } = cameraFixture([null]); view.setProgress(.5);
  assert.equal(stats().updates, 0); assert.equal(typeof stats().retry, 'function');
  view.ready = false; stats().retry(); assert.equal(stats().updates, 0);
});

function transitionFixture() {
  const { view } = cameraFixture(Array(13).fill(1000));
  class Coordinate {
    constructor(x, y, z) { Object.assign(this, { x, y, z }); }
    static fromLngLat(position, height) { return new Coordinate(position[0] / 360, (90 - position[1]) / 180, height / 40000000); }
  }
  window.mapboxgl.MercatorCoordinate = Coordinate;
  let pose = { position: new Coordinate(.02, .2, .001), orientation: [0, 0, 0, 1] }, updates = 0;
  view.map.getFreeCameraOptions = () => ({ position: { ...pose.position }, orientation: [...pose.orientation], lookAtPoint() { this.orientation = [.3, 0, 0, Math.sqrt(.91)]; } });
  view.map.setFreeCameraOptions = camera => { pose = { position: { ...camera.position }, orientation: [...camera.orientation] }; updates++; };
  return { view, stats: () => ({ pose, updates }) };
}
test('first play animates from the displayed camera and holds route progress until arrival', () => {
  const { view, stats } = transitionFixture();
  const start = stats().pose;
  view.setProgress(0);
  assert.equal(stats().updates, 0);
  const entry = view.entry;
  assert.deepEqual(entry.from, { position: { ...start.position }, orientation: start.orientation });
  view.setProgress(0);
  assert.equal(view.entry, entry);
  assert.equal(view.advanceCamera(entry.startedAt + 1100), true);
  assert.notDeepEqual(stats().pose.position, entry.from.position);
  assert.notDeepEqual(stats().pose.position, entry.to.position);
  assert.equal(view.progress, 0);
  assert.equal(view.advanceCamera(entry.startedAt + entry.duration), false);
  assert.deepEqual(stats().pose.position, entry.to.position);
  view.setProgress(.01);
  assert.equal(view.entry, null);
  assert.equal(view.following, true);
});
test('pause cancels an approach and resume starts from the visible intermediate pose', () => {
  const { view, stats } = transitionFixture();
  view.setProgress(0);
  const entry = view.entry;
  view.advanceCamera(entry.startedAt + 700);
  const midway = stats().pose;
  view.pauseCamera();
  const count = stats().updates;
  view.advanceCamera(entry.startedAt + 4000);
  assert.equal(stats().updates, count);
  view.setProgress(0);
  assert.deepEqual(view.entry.from, midway);
});
test('a cancelled navigation cannot finish a later stage transition', () => {
  const { view } = transitionFixture();
  view.map.on = () => {}; view.map.off = () => {}; view.map.flyTo = () => {};
  view.flyToRoutePoint(0);
  const oldFinish = view.nativeMotion;
  view.flyToRoutePoint(.5);
  const currentFinish = view.nativeMotion;
  oldFinish();
  assert.equal(view.nativeMotion, currentFinish);
  currentFinish();
  assert.equal(view.nativeMotion, null);
});
