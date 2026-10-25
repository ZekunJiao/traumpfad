import test from 'node:test';
import assert from 'node:assert/strict';
import { JourneyMap } from '../app/js/map.js';
import { prepareRoute, pointAt } from '../app/js/route.js';
import { TourPlayer } from '../app/js/player.js';

function cameraFixture(elevations) {
  let altitude, updates = 0, queries = 0, retry;
  globalThis.window = { matchMedia: () => ({ matches: false }), mapboxgl: { MercatorCoordinate: { fromLngLat: (position, height) => { altitude = height; return { position, height }; } } } };
  const view = Object.create(JourneyMap.prototype);
  Object.assign(view, {
    progress: 0, ready: true, stageIndex: 0, exploring: false, cameraPosition: null, cameraAltitude: null, viewPitch: null, viewBearing: 0, heightOffset: 0, onBearing() {}, onHeight() {},
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
    static fromLngLat(position, height) {
      const [lng, lat] = Array.isArray(position) ? position : [position.lng, position.lat];
      return new Coordinate(lng / 360, (90 - lat) / 180, height / 40000000);
    }
    toLngLat() { return { lng: this.x * 360, lat: 90 - this.y * 180 }; }
    toAltitude() { return this.z * 40000000; }
  }
  window.mapboxgl.MercatorCoordinate = Coordinate;
  let pose = { position: new Coordinate(.02, .2, .001), orientation: [0, 0, 0, 1] }, updates = 0, angles;
  view.map.getFreeCameraOptions = () => ({ position: new Coordinate(pose.position.x, pose.position.y, pose.position.z), orientation: [...pose.orientation], lookAtPoint() { this.orientation = [.3, 0, 0, Math.sqrt(.91)]; }, setPitchBearing(pitch, bearing) { angles = { pitch, bearing }; this.orientation = [Math.sin(pitch * Math.PI / 360), 0, 0, Math.cos(pitch * Math.PI / 360)]; } });
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
test('explicit explore freezes progress and allows return from the visible pose', () => {
  const { view, player, stats, takeovers } = manualNavigationFixture();
  player.play();
  const entry = view.entry;
  view.advanceCamera(entry.startedAt + 700);
  const visible = stats().pose;
  view.map.stop = () => assert.fail('takeover must not cancel the active mouse gesture');
  const gesture = { type: 'movestart', originalEvent: { type: 'wheel' } };
  view.setExplore(true, { userGesture: true });
  view.onExplore();
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

test('right-button dragging inverts both viewing axes without panning or pausing', () => {
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
  assert.equal(view.viewBearing, -10);
  assert.equal(stats().angles.pitch, 50);
  assert.equal(player.state.status, 'playing');
  player.tick(.5);
  assert.equal(player.state.progress, .05);
  listeners.get('pointerup')(event());
  assert.equal(captured, null);
  listeners.get('pointermove')(event({ clientX: 200 }));
  assert.equal(view.viewBearing, -10);
  const left = event({ button: 0 }); listeners.get('pointerdown')(left);
  assert.equal(left.stopped, true);
});

test('zoom distance persists while route playback continues and keeps terrain clearance', () => {
  const { view, player, takeovers, stats } = manualNavigationFixture();
  player.play(); view.advanceCamera(view.entry.startedAt + view.entry.duration);
  view.zoomBy(1);
  assert.equal(view.viewDistance, .5);
  player.tick(1);
  assert.equal(player.state.progress, .1);
  assert.equal(player.state.status, 'playing');
  assert.equal(player.state.mode, 'presentation');
  assert.equal(takeovers(), 0);
  assert.ok(stats().pose.position.z >= 1850 / 40000000);
  view.zoomBy(100); assert.equal(view.viewDistance, .3);
  view.zoomBy(-100); assert.equal(view.viewDistance, 4);
  view.exploring = true; view.zoomBy(1); assert.equal(view.viewDistance, 4);
});
test('wheel and zoom buttons change follow distance without invoking native map gestures', () => {
  const { view, player, takeovers } = manualNavigationFixture();
  const surfaceListeners = new Map(), containerListeners = new Map();
  view.map.getCanvasContainer = () => ({ addEventListener(type, handler) { surfaceListeners.set(type, handler); } });
  view.map.getContainer = () => ({ addEventListener(type, handler) { containerListeners.set(type, handler); } });
  view.bindZoomControls(view.map);
  player.play(); const approach = view.entry;
  const wheel = { deltaY: -250, deltaMode: 0, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  surfaceListeners.get('wheel')(wheel);
  assert.equal(wheel.prevented, true); assert.equal(wheel.stopped, true);
  assert.notEqual(view.entry, approach); assert.ok(view.entry); assert.ok(view.viewDistance < 1);
  const zoomed = view.viewDistance;
  containerListeners.get('click')({ target: { closest: () => ({ classList: { contains: () => false } }) }, preventDefault() {}, stopImmediatePropagation() {} });
  assert.ok(view.viewDistance > zoomed);
  assert.equal(takeovers(), 0); assert.equal(player.state.status, 'playing');
  view.exploring = true;
  const freeWheel = { ...wheel, prevented: false, stopped: false };
  surfaceListeners.get('wheel')(freeWheel); assert.equal(freeWheel.prevented, false);
});

test('dragging pauses playback and limits high-altitude pan distance', () => {
  const { view, player, takeovers } = manualNavigationFixture();
  view.map.getCanvasContainer = () => ({ clientWidth: 1000, clientHeight: 800 });
  view.map.unproject = ([x, y]) => ({ lng: 11 + x / 100, lat: 47 - y / 100 });
  let center = { lng: 11, lat: 47 };
  view.map.getCenter = () => center;
  view.map.setCenter = ([lng, lat]) => { center = { lng, lat }; };
  player.play(); view.advanceCamera(view.entry.startedAt + view.entry.duration);
  view.panBy(100, 0);
  assert.equal(player.state.status, 'paused');
  assert.equal(player.state.mode, 'explore');
  assert.equal(takeovers(), 1);
  const frozen = player.state.progress;
  player.tick(1); assert.equal(player.state.progress, frozen);
  assert.ok(center.lng < 11 && center.lng > 10.9);
  view.panBy(100, 0); assert.equal(takeovers(), 1);
});
test('50x playback still stops at the first photo instead of skipping intervening stories', () => {
  const player = new TourPlayer([{ durationSeconds: 10, stops: [{ id: 'first', progress: .2 }, { id: 'second', progress: .4 }] }]);
  player.state.speed = 50; player.play(); player.tick(.1);
  assert.equal(player.state.status, 'stop'); assert.equal(player.state.stopId, 'first');
  assert.equal(player.state.progress, .2);
  player.play(); player.tick(.1);
  assert.equal(player.state.stopId, 'second');
});

test('a panned approach targets the offset and cannot repeat forever outside viewport bounds', () => {
  const { view } = transitionFixture();
  view.viewOffset = [.02, .01];
  view.map.getBounds = () => ({ contains: () => false });
  let flights = 0, center;
  view.animateNavigation = action => action();
  view.map.flyTo = options => { flights++; center = options.center; };
  view.setProgress(.3);
  assert.equal(flights, 1);
  assert.equal(view.routeFramed, true);
  assert.ok(center[0] > 11.04 && center[1] > 47.03);
  view.setProgress(.3);
  assert.equal(flights, 1);
  assert.ok(view.entry);
  view.advanceCamera(view.entry.startedAt + view.entry.duration);
  assert.equal(view.following, true);
});
test('an interrupted native transition releases its playback gate even without moveend', () => {
  const { view } = transitionFixture();
  let completions = 0;
  view.nativeMotionStarted = 100;
  view.nativeMotion = () => { completions++; view.nativeMotion = null; };
  assert.equal(view.advanceCamera(2000), true);
  assert.equal(view.advanceCamera(3200), false);
  assert.equal(completions, 1);
});
test('terrain preparation recovers when tiles arrive without an idle event', () => {
  const { view } = transitionFixture();
  view.map.queryTerrainElevation = () => null;
  view.setProgress(.3);
  assert.equal(view.preparingFollow, true);
  assert.equal(view.advanceCamera(100), true);
  view.map.queryTerrainElevation = () => 1000;
  view.advanceCamera(400);
  assert.equal(view.preparingFollow, false);
  assert.ok(view.entry);
  view.advanceCamera(view.entry.startedAt + view.entry.duration);
  assert.equal(view.following, true);
});

test('height changes move the camera independently of orientation while route playback continues', () => {
  const { view, player, stats } = manualNavigationFixture();
  player.play(); view.advanceCamera(view.entry.startedAt + view.entry.duration);
  view.setPitch(70); view.setBearing(25);
  const orientation = [...stats().pose.orientation], originalHeight = view.cameraAltitude;
  view.setHeight(1200);
  assert.equal(view.cameraAltitude, originalHeight + 1200);
  assert.deepEqual(stats().pose.orientation, orientation);
  player.tick(.5);
  assert.equal(player.state.mode, 'presentation');
  assert.equal(player.state.status, 'playing');
  assert.equal(player.state.progress, .05);
  assert.equal(view.cameraAltitude, originalHeight + 1200);
  assert.equal(stats().angles.pitch, 70);
  assert.equal(stats().angles.bearing, view.followHeading + 25);
  view.setHeight(0);
  assert.equal(view.cameraAltitude, originalHeight);
  assert.equal(player.state.status, 'playing');
});
test('height limits preserve clearance when terrain rises and reject invalid input', () => {
  const { view, player } = manualNavigationFixture();
  player.play(); view.advanceCamera(view.entry.startedAt + view.entry.duration);
  view.setHeight(-9000);
  assert.equal(view.heightOffset, -1200);
  assert.equal(view.cameraAltitude, 1500);
  view.map.queryTerrainElevation = () => 3000;
  player.tick(.5);
  assert.equal(view.cameraAltitude, 3500);
  view.setHeight(100000);
  assert.equal(view.heightOffset, 6000);
  view.setHeight(NaN);
  assert.equal(view.heightOffset, 6000);
});
test('height adjustment during an approach updates its destination and preserves playback', () => {
  const { view, player } = manualNavigationFixture();
  player.play();
  const entry = view.entry, originalZ = entry.to.position.z;
  view.setHeight(600);
  assert.equal(view.entry, entry);
  assert.ok(Math.abs(entry.to.position.z - originalZ - 600 / 40000000) < 1e-12);
  view.advanceCamera(entry.startedAt + entry.duration);
  player.tick(.5);
  assert.equal(view.cameraAltitude, 3300);
  assert.equal(player.state.progress, .05);
});
test('Shift and left-drag change height without box zoom, looking around, or pausing', () => {
  const { view, player } = manualNavigationFixture();
  const listeners = new Map(); let captured;
  const surface = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    setPointerCapture(id) { captured = id; }, hasPointerCapture(id) { return captured === id; },
    releasePointerCapture() { captured = null; }
  };
  view.map.getCanvasContainer = () => surface;
  view.bindLookControls(view.map);
  const event = (extra = {}) => ({ button: 0, shiftKey: true, pointerId: 1, clientX: 100, clientY: 100, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; }, ...extra });
  player.play(); view.advanceCamera(view.entry.startedAt + view.entry.duration);
  const down = event(); listeners.get('pointerdown')(down);
  assert.equal(down.stopped, true);
  const mouse = event(); listeners.get('mousedown')(mouse);
  assert.equal(mouse.stopped, true);
  listeners.get('pointermove')(event({ clientX: 160, clientY: 50 }));
  assert.equal(view.heightOffset, 600);
  assert.equal(view.viewPitch, null);
  assert.equal(view.viewBearing, 0);
  player.tick(.5);
  assert.equal(player.state.status, 'playing');
  assert.equal(player.state.progress, .05);
  listeners.get('pointerup')(event());
  assert.equal(captured, null);
});

test('looking around while paused in explore rotates at the observer without moving its position', () => {
  const { view, player, stats } = manualNavigationFixture();
  player.play(); view.advanceCamera(view.entry.startedAt + view.entry.duration);
  player.setMode('explore');
  const position = { ...stats().pose.position }, progress = player.state.progress;
  view.map.getBearing = () => 30;
  view.map.setBearing = () => assert.fail('native bearing would orbit the ground centre');
  view.map.setPitch = () => assert.fail('native pitch would orbit the ground centre');
  view.lookBy(40, -20);
  assert.deepEqual(stats().pose.position, position);
  assert.equal(stats().angles.bearing, 40);
  assert.equal(stats().angles.pitch, 60);
  assert.equal(player.state.status, 'paused');
  assert.equal(player.state.progress, progress);
});

test('cursor zoom scales the route target with the camera without turning its orientation', () => {
  const { view, player, stats } = manualNavigationFixture();
  player.play(); view.advanceCamera(view.entry.startedAt + view.entry.duration);
  view.map.zoomTo = () => assert.fail('the SDK must not take over the route camera');
  const orientation = [...stats().pose.orientation];
  const anchor = { lng: 11.02, lat: 47.01 };
  for (const step of [.5, .5, -.5, -.5, 1, -1]) {
    const beforeTarget = [...view.cameraTarget], beforePosition = [...view.cameraPosition];
    const previousDistance = view.viewDistance ?? 1;
    view.zoomBy(step, anchor);
    const ratio = view.viewDistance / previousDistance;
    assert.deepEqual(stats().pose.orientation, orientation);
    for (let axis = 0; axis < 2; axis++) {
      assert.ok(Math.abs((view.cameraTarget[axis] - view.cameraPosition[axis]) - (beforeTarget[axis] - beforePosition[axis]) * ratio) < 1e-10);
    }
    assert.ok(!view.nativeMotion);
  }
  player.tick(.5);
  assert.equal(player.state.status, 'playing');
  assert.equal(player.state.mode, 'presentation');
  assert.equal(player.state.progress, .05);
});

test('zoom during an approach starts a new approach rather than treating an intermediate pose as following', () => {
  const { view, player } = manualNavigationFixture();
  player.play();
  const first = view.entry;
  view.advanceCamera(first.startedAt + 500);
  view.zoomBy(.5, { lng: 11.02, lat: 47.01 });
  assert.ok(view.entry);
  assert.notEqual(view.entry, first);
  assert.equal(view.following, false);
  assert.equal(view.progress, 0);
  view.advanceCamera(view.entry.startedAt + view.entry.duration);
  assert.equal(view.following, true);
  player.tick(.5);
  assert.equal(player.state.progress, .05);
});

test('a distant seek discards the old target and loads the destination before entering follow mode', () => {
  const { view } = transitionFixture();
  view.setProgress(.1); view.advanceCamera(view.entry.startedAt + view.entry.duration);
  let complete, destination;
  view.map.getBounds = () => ({ contains: () => false });
  view.map.on = (_, callback) => { complete = callback; };
  view.map.off = () => {};
  view.map.flyTo = options => { destination = options.center; };
  view.focusStop(.9);
  assert.deepEqual(destination, pointAt(view.routes[0], .9));
  assert.equal(view.following, false);
  assert.equal(view.progress, .9);
  complete();
  assert.ok(view.entry);
  view.advanceCamera(view.entry.startedAt + view.entry.duration);
  assert.equal(view.following, true);
  assert.equal(view.preparingFollow, false);
});

test('a synchronous flight completion frames the destination before follow resumes and completes only once', () => {
  const { view } = transitionFixture();
  let complete, flights = 0;
  view.map.getBounds = () => ({ contains: () => false });
  view.map.on = (_, callback) => { complete = callback; };
  view.map.off = () => {};
  view.map.flyTo = () => { flights++; complete(); };
  view.followRequested = true;
  view.setProgress(.5);
  assert.equal(flights, 1);
  view.setProgress(.5);
  assert.ok(view.entry);
  const entry = view.entry;
  complete();
  assert.equal(view.entry, entry);
  assert.equal(flights, 1);
});

test('recenter clears manual camera offsets and returns from far away to the same route progress', () => {
  const { view } = transitionFixture();
  Object.assign(view, { exploring: true, appliedExplore: true, progress: .6, viewOffset: [4, -2], viewDistance: 8, viewBearing: 130, viewPitch: 12, heightOffset: 4000, cameraTarget: [15, 40], cameraPosition: [15, 40], cameraAltitude: 9000 });
  let navigation, complete, bearing, height;
  view.onBearing = value => { bearing = value; };
  view.onHeight = value => { height = value; };
  view.map.on = (_, callback) => { complete = callback; };
  view.map.off = () => {};
  view.map.getBounds = () => ({ contains: () => false });
  view.map.flyTo = options => { navigation = options; };
  view.recenter();
  assert.equal(view.progress, .6);
  assert.equal(view.stageIndex, 0);
  assert.equal(view.exploring, false);
  assert.deepEqual(view.viewOffset, [0, 0]);
  assert.equal(view.viewDistance, 1);
  assert.equal(view.viewPitch, null);
  assert.equal(bearing, 0); assert.equal(height, 0);
  assert.equal(navigation.zoom, 12.4);
  assert.deepEqual(navigation.center, pointAt(view.routes[0], .6));
  assert.equal(view.followRequested, true);
  complete();
  assert.ok(view.entry);
  assert.equal(view.progress, .6);
});
test('photo focus saves the visible camera and returns through a controlled flight', () => {
  const { view, player, stats } = manualNavigationFixture();
  player.play(); view.advanceCamera(view.entry.startedAt + view.entry.duration);
  player.pause();
  const before = structuredClone(stats().pose);
  let request;
  view.map.on = () => {};
  view.map.off = () => {};
  view.map.getZoom = () => 12;
  view.map.getBearing = () => 20;
  view.map.flyTo = options => { request = options; };
  view.beginPhotoFocus({ id:'photo', progress:.3 });
  assert.equal(request.zoom,19);
  assert.equal(request.duration,3000);
  assert.equal(view.photoCamera.id,'photo');
  const saved = view.photoCamera;
  view.beginPhotoFocus({ id:'photo', progress:.3 });
  assert.equal(view.photoCamera,saved);
  view.endPhotoFocus();
  assert.equal(view.photoCamera,null);
  assert.equal(view.entry.duration,900);
  assert.deepEqual(view.entry.to,before);
  view.advanceCamera(view.entry.startedAt + 900);
  assert.deepEqual(stats().pose,before);
  assert.equal(player.state.status,'paused');
});

test('photo descent targets ten metres above terrain and checks clearance during descent', () => {
  const { view, player, stats } = manualNavigationFixture();
  const Coordinate = window.mapboxgl.MercatorCoordinate, from = Coordinate.fromLngLat;
  Coordinate.fromLngLat = (point, height) => from(Array.isArray(point) ? point : [point.lng,point.lat],height);
  Coordinate.prototype.toLngLat = function () { return { lng:this.x*360, lat:90-this.y*180 }; };
  view.map.on = () => {}; view.map.off = () => {};
  view.map.getBearing = () => 20; view.map.flyTo = () => {};
  player.play(); view.advanceCamera(view.entry.startedAt + view.entry.duration); player.pause();
  view.beginPhotoFocus({id:'near',progress:.3});
  view.nativeMotion();
  assert.equal(view.entry.duration,1800);
  assert.equal(view.entry.lockView,true);
  assert.ok(Math.abs(view.entry.to.position.z - 1010/40000000) < 1e-12);
  view.map.queryTerrainElevation = () => 1020;
  const entry=view.entry;
  view.advanceCamera(entry.startedAt+1800);
  assert.equal(view.entry,null);
  assert.ok(stats().pose.position.z >= 1030/40000000);
  assert.equal(player.state.status,'paused');
});
test('missing terrain leaves the Mapbox photo approach intact rather than inventing ground height', () => {
  const { view } = transitionFixture();
  view.map.on = () => {}; view.map.off = () => {};
  view.map.getBearing = () => 20; view.map.flyTo = () => {};
  view.map.queryTerrainElevation = () => null;
  view.beginPhotoFocus({id:'missing',progress:.3});
  view.nativeMotion();
  assert.equal(view.entry,null);
  assert.equal(view.nativeMotion,null);
});
