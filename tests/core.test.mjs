import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareRoute, pointAt, sliceRoute, validateJourney } from '../app/js/route.js';
import { TourPlayer } from '../app/js/player.js';
import { normalizeCaptureTime, matchStage } from '../scripts/photo-utils.mjs';

const stages = [
  { id: 'one', durationSeconds: 10, stops: [{ id: 'a', progress: .2 }, { id: 'b', progress: .6 }] },
  { id: 'two', durationSeconds: 20, stops: [{ id: 'c', progress: .5 }] }
];

test('route progress is measured by distance, not the number of GPS samples', () => {
  const route = prepareRoute([[0, 0], [.1, 0], [1, 0]]);
  assert.ok(Math.abs(pointAt(route, .5)[0] - .5) < 1e-9);
  assert.deepEqual(pointAt(route, 0), [0, 0]); assert.deepEqual(pointAt(route, 1), [1, 0]);
  const sliced = sliceRoute(route, .5);
  assert.deepEqual(sliced, [[0, 0], [.1, 0], [.5, 0]]);
  assert.equal(route.points.length, 3);
});
test('duplicate points and zero-progress lines stay valid', () => {
  const route = prepareRoute([[11, 47], [11, 47], [12, 48]]);
  assert.deepEqual(pointAt(route, 0), [11, 47]); assert.equal(sliceRoute(route, 0).length, 2);
  assert.throws(() => prepareRoute([[0, 0], [0, 0]]));
  assert.throws(() => prepareRoute([[181, 0], [1, 0]]));
  assert.throws(() => prepareRoute([[11, NaN], [12, 48]]));
});
test('a large tick stops at the first story and resume does not reopen it', () => {
  const p = new TourPlayer(stages); p.play(); p.tick(9);
  assert.equal(p.state.stopId, 'a'); assert.equal(p.state.progress, .2);
  p.play(); p.tick(9); assert.equal(p.state.stopId, 'b');
  p.play(); p.tick(9); assert.equal(p.state.status, 'stage-end'); assert.equal(p.state.progress, 1);
  p.play(); assert.equal(p.state.stageIndex, 1); assert.equal(p.state.status, 'playing');
});

test('single-route playback crosses bookmark boundaries and finishes at the route endpoint', () => {
  const player = new TourPlayer([{ id: 'gesamt', isFullRoute: true, durationSeconds: 1200, stops: [] }]);
  player.seek(.24); player.play(); player.tick(24);
  assert.equal(player.state.status, 'playing');
  assert.ok(Math.abs(player.state.progress - .26) < 1e-12);
  player.tick(888);
  assert.equal(player.state.status, 'stage-end');
  assert.equal(player.state.progress, 1);
});
test('pause prevents movement and repeated play never doubles time', () => {
  const p = new TourPlayer(stages); p.play(); p.play(); p.tick(1); assert.equal(p.state.progress, .1);
  p.pause(); p.tick(3); assert.equal(p.state.progress, .1);
});
test('exploration preserves the presentation stage and exact position', () => {
  const p = new TourPlayer(stages); p.play(); p.tick(1); p.setMode('explore'); p.selectStage(1); p.seek(.8); p.setMode('presentation');
  assert.equal(p.state.stageIndex, 0); assert.equal(p.state.progress, .1); assert.equal(p.state.status, 'paused');
});
test('next and previous cross stage boundaries predictably', () => {
  const p = new TourPlayer(stages); p.next(); assert.equal(p.state.stopId, 'a'); p.next(); assert.equal(p.state.stopId, 'b');
  p.next(); assert.equal(p.state.stageIndex, 1); p.previous(); assert.equal(p.state.stopId, 'b'); assert.equal(p.state.stageIndex, 0);
});
test('seeking never causes a stale stop to reopen', () => {
  const p = new TourPlayer(stages); p.next(); p.seek(.7); p.play(); p.tick(1);
  assert.equal(p.state.stopId, null); assert.ok(p.state.progress > .7);
});
test('route seeking changes stage and position while preserving playing or paused state', () => {
  const p = new TourPlayer(stages, () => {});
  p.play(); p.seekTo(1, .25);
  assert.equal(p.state.stageIndex, 1); assert.equal(p.state.progress, .25); assert.equal(p.state.status, 'playing');
  p.pause(); p.seekTo(0, .6);
  assert.equal(p.state.stageIndex, 0); assert.equal(p.state.progress, .6); assert.equal(p.state.status, 'paused');
  assert.equal(p.state.stopId, null);
});
test('route seeking during exploration updates the saved presentation position', () => {
  const p = new TourPlayer(stages);
  p.play(); p.tick(2); p.setMode('explore'); p.seekTo(1, .6); p.setMode('presentation');
  assert.equal(p.state.stageIndex, 1); assert.equal(p.state.progress, .6); assert.equal(p.state.status, 'paused');
});
test('a stop at the start opens once, and returning home resets the journey', () => {
  const p = new TourPlayer([{ id: 'one', durationSeconds: 10, stops: [{ id: 'start', progress: 0 }] }]);
  p.play(); assert.equal(p.state.stopId, 'start');
  p.play(); p.tick(1); assert.equal(p.state.progress, .1);
  p.setMode('explore'); p.seek(.8); p.home();
  assert.equal(p.state.mode, 'presentation'); assert.equal(p.state.started, false); assert.equal(p.state.progress, 0);
  p.play(); assert.equal(p.state.stopId, 'start');
});
test('photo dates use travel-local time including midnight and daylight saving', () => {
  assert.equal(normalizeCaptureTime({ DateTimeOriginal: '2025:07:12 23:30:00', OffsetTimeOriginal: 'Z' }), '2025-07-13T01:30:00');
  assert.equal(normalizeCaptureTime({ DateTimeOriginal: '2025:01:12 23:30:00Z' }), '2025-01-13T00:30:00');
  assert.equal(normalizeCaptureTime({ DateTimeOriginal: '2025:07:12 08:30:00' }), '2025-07-12T08:30:00');
  assert.equal(normalizeCaptureTime({ DateTimeOriginal: '2025-07-12T08:30:00+02:00' }), '2025-07-12T08:30:00');
});
test('file export dates never substitute for a missing capture time', () => {
  assert.equal(normalizeCaptureTime({ FileCreateDate: '2025:07:12 08:30:00' }), null);
  assert.equal(normalizeCaptureTime({ DateTimeOriginal: '2025:02:30 08:30:00' }), null);
  assert.equal(normalizeCaptureTime({ DateTimeOriginal: 'garbage' }), null);
  assert.equal(matchStage(null, []).stageId, null);
});
test('ambiguous days require review instead of guessing', () => {
  const s = [{ id: 'a', date: '2025-07-12' }];
  assert.equal(matchStage('2025-07-12T08:00:00', s).stageId, 'a');
  assert.equal(matchStage('2025-07-13T08:00:00', s).stageId, null);
  assert.equal(matchStage('2025-07-12T08:00:00', [...s, { id: 'b', date: '2025-07-12' }]).stageId, null);
});
test('journey validation catches broken stop references and invalid dates', async () => {
  const journey = JSON.parse(await readFile(new URL('../app/data/journey.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateJourney(journey), []);
  const stage = journey.stages.find(s => s.stops.length);
  stage.stops[0].photoIds.push('missing'); stage.date = '2025-02-30';
  const errors = validateJourney(journey);
  assert.ok(errors.some(e => e.includes('missing'))); assert.ok(errors.some(e => e.includes('Datum')));
});
