import test from 'node:test';
import assert from 'node:assert/strict';
import { JourneyMap } from '../app/js/map.js';
import { prepareRoute } from '../app/js/route.js';
import { TourPlayer } from '../app/js/player.js';

function cameraFixture(elevations) {
  let altitude, updates = 0, queries = 0, retry;
  globalThis.window = { matchMedia: () => ({ matches: false }), mapboxgl: { MercatorCoordinate: { fromLngLat: (position, height) => { altitude = height; return { position, height }; } } } };
  const view = Object.create(JourneyMap.prototype);
  Object.assign(view, {
    progress: 0, ready: true, stageIndex: 0, exploring: false, cameraPosition: null, cameraAltitude: null, viewPitch: null, viewBearing: 0, onBearing() {},
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
  let pose = { position: new Coordinate(.02, .2, .001), orientation: [0, 0, 0, 1] }, updates = 0, angles;
  view.map.getFreeCameraOptions = () => ({ position: { ...pose.position }, orientation: [...pose.orientation], lookAtPoint() { this.orientation = [.3, 0, 0, Math.sqrt(.91)]; }, setPitchBearing(pitch, bearing) { angles = { pitch, bearing }; this.orientation = [Math.sin(pitch * Math.PI / 360), 0, 0, Math.cos(pitch * Math.PI / 360)]; } });
  view.map.setFreeCameraOptions = camera => { pose = { position: { ...camera.position }, orientation: [...camera.orientation] }; updates++; };
  view.map.getPitch = () => angles?.pitch ?? 55;
  return { view, stats: () => ({ pose, updates, angles }) };
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

function manualNavigationFixture() {
  const { view, stats } = transitionFixture();
  const enabled = new Set();
  for (const key of ['scrollZoom', 'boxZoom', 'dragRotate', 'dragPan', 'keyboard', 'doubleClickZoom', 'touchZoomRotate', 'touchPitch']) {
    view.map[key] = { enable: () => enabled.add(key), disable: () => enabled.delete(key) };
  }
  view.appliedExplore = null;
  view.fitStage = () => assert.fail('manual takeover must not reframe the map');
  const player = new TourPlayer([{ id: 'one', durationSeconds: 10, stops: [] }], state => {
    view.setExplore(state.mode === 'explore');
    view.setProgress(state.progress, state.mode === 'presentation' && state.started);
  });
  let takeovers = 0;
  view.onExplore = () => { takeovers++; player.setMode('explore'); };
  view.setExplore(false);
  return { view, player, stats, enabled, takeovers: () => takeovers };
}
test('presentation keeps mouse and touch gestures available without stealing tour arrow shortcuts', () => {
  const { enabled } = manualNavigationFixture();
  for (const gesture of ['scrollZoom', 'dragPan', 'dragRotate', 'doubleClickZoom', 'touchZoomRotate', 'touchPitch']) assert.ok(enabled.has(gesture));
  assert.equal(enabled.has('keyboard'), false);
});
test('automatic camera movements do not interrupt the presentation', () => {
  const { view, player, takeovers } = manualNavigationFixture();
  player.play();
  const entry = view.entry;
  view.handleUserNavigation({ type: 'movestart' });
  assert.equal(takeovers(), 0);
  assert.equal(player.state.mode, 'presentation');
  assert.equal(player.state.status, 'playing');
  assert.equal(view.entry, entry);
});
test('a gesture cancels camera flight, freezes progress, and allows return from the visible pose', () => {
  const { view, player, stats, takeovers } = manualNavigationFixture();
  player.play();
  const entry = view.entry;
  view.advanceCamera(entry.startedAt + 700);
  const visible = stats().pose;
  view.map.stop = () => assert.fail('takeover must not cancel the active mouse gesture');
  const gesture = { type: 'movestart', originalEvent: { type: 'wheel' } };
  view.handleUserNavigation(gesture);
  view.handleUserNavigation(gesture);
  assert.equal(takeovers(), 1);
  assert.equal(view.entry, null);
  assert.equal(player.state.mode, 'explore');
  assert.equal(player.state.status, 'paused');
  const progress = player.state.progress, updates = stats().updates;
  player.tick(5);
  view.advanceCamera(entry.startedAt + 3000);
  assert.equal(player.state.progress, progress);
  assert.equal(stats().updates, updates);
  assert.deepEqual(stats().pose, visible);
  view.map.stop = () => {};
  player.setMode('presentation');
  assert.equal(player.state.progress, progress);
  assert.equal(player.state.status, 'paused');
  assert.deepEqual(view.entry.from, visible);
  view.advanceCamera(view.entry.startedAt + view.entry.duration);
  player.play(); player.tick(.5);
  assert.equal(player.state.status, 'playing');
  assert.ok(player.state.progress > progress);
});

test('pitch control keeps a running tour playing and clamps the available viewing angles', () => {
  const { view, player, takeovers, stats } = manualNavigationFixture();
  player.play();
  const entry = view.entry;
  view.setPitch(85);
  assert.equal(stats().angles.pitch, 85);
  assert.equal(player.state.mode, 'presentation');
  assert.equal(player.state.status, 'playing');
  assert.equal(view.entry, entry);
  view.setPitch(0);
  assert.equal(stats().angles.pitch, 0);
  view.setPitch(120);
  assert.equal(stats().angles.pitch, 85);
  view.setPitch(-10);
  assert.equal(stats().angles.pitch, 0);
  assert.equal(takeovers(), 0);
  view.setPitch(NaN);
  assert.equal(stats().angles.pitch, 0);
});
test('pitch control does nothing until the terrain map is ready', () => {
  const { view, player } = manualNavigationFixture();
  view.ready = false;
  view.map.setPitch = () => assert.fail('unavailable maps cannot change pitch');
  view.setPitch(85);
  assert.equal(player.state.mode, 'presentation');
});

test('route advances while looking sideways and up, retaining the offset through route turns', () => {
  const { view, player, stats, takeovers } = manualNavigationFixture();
  player.play();
  view.advanceCamera(view.entry.startedAt + view.entry.duration);
  view.lookBy(160, -80);
  assert.equal(stats().angles.pitch, 75);
  assert.equal(view.viewBearing, 40);
  const position = { ...stats().pose.position };
  player.tick(1);
  assert.equal(player.state.status, 'playing');
  assert.equal(player.state.mode, 'presentation');
  assert.equal(player.state.progress, .1);
  assert.notDeepEqual(stats().pose.position, position);
  assert.equal(stats().angles.pitch, 75);
  assert.equal(stats().angles.bearing, view.followHeading + 40);
  player.tick(1);
  assert.equal(stats().angles.bearing, view.followHeading + 40);
  assert.equal(takeovers(), 0);
  view.resetView();
  assert.equal(view.viewPitch, null);
  assert.equal(view.viewBearing, 0);
  assert.equal(player.state.status, 'playing');
  assert.equal(player.state.progress, .2);
});
test('view adjustments during the approach survive arrival without cancelling its position transition', () => {
  const { view, player, stats } = manualNavigationFixture();
  player.play();
  const entry = view.entry;
  view.setPitch(80); view.setBearing(-60);
  view.advanceCamera(entry.startedAt + 1100);
  assert.equal(view.entry, entry);
  assert.equal(stats().angles.pitch, 80);
  assert.equal(stats().angles.bearing, view.followHeading - 60);
  view.advanceCamera(entry.startedAt + entry.duration);
  player.tick(.5);
  assert.equal(stats().angles.pitch, 80);
  assert.equal(stats().angles.bearing, view.followHeading - 60);
  assert.equal(player.state.progress, .05);
});
test('pausing and resuming preserve a chosen direction, while explore still permits free panning', () => {
  const { view, player, stats } = manualNavigationFixture();
  player.play(); view.advanceCamera(view.entry.startedAt + view.entry.duration);
  view.setPitch(70); view.setBearing(90);
  player.pause(); player.tick(2);
  assert.equal(player.state.progress, 0);
  player.play(); player.tick(.5);
  assert.equal(player.state.progress, .05);
  assert.equal(stats().angles.pitch, 70);
  assert.equal(stats().angles.bearing, view.followHeading + 90);
  player.setMode('explore');
  let pitch;
  view.map.setPitch = value => { pitch = value; };
  view.setPitch(45);
  assert.equal(pitch, 45);
  assert.equal(player.state.mode, 'explore');
});

test('right-button pointer gestures adjust the view without activating native pan or pausing playback', () => {
  const { view, player, stats } = manualNavigationFixture();
  const listeners = new Map(); let captured;
  const surface = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    setPointerCapture(id) { captured = id; }, hasPointerCapture(id) { return captured === id; },
    releasePointerCapture() { captured = null; }
  };
  view.map.getCanvasContainer = () => surface;
  view.bindLookControls(view.map);
  const event = (extra = {}) => ({ button: 2, pointerId: 1, clientX: 100, clientY: 100, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; }, ...extra });
  player.play(); view.advanceCamera(view.entry.startedAt + view.entry.duration);
  const down = event(); listeners.get('pointerdown')(down);
  assert.equal(down.stopped, true); assert.equal(captured, 1);
  listeners.get('pointermove')(event({ clientX: 140, clientY: 80 }));
  assert.equal(view.viewBearing, 10);
  assert.equal(stats().angles.pitch, 60);
  assert.equal(player.state.status, 'playing');
  player.tick(.5);
  assert.equal(player.state.progress, .05);
  listeners.get('pointerup')(event());
  assert.equal(captured, null);
  listeners.get('pointermove')(event({ clientX: 200 }));
  assert.equal(view.viewBearing, 10);
  const left = event({ button: 0 }); listeners.get('pointerdown')(left);
  assert.equal(left.stopped, undefined);
});
