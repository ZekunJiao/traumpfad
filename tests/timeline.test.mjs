import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJourneyTimeline, timelineSegmentAt, visibleTimelineMarkerGroups } from '../app/js/timeline.js';
import { prepareRoute } from '../app/js/route.js';

const full = prepareRoute([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]);
const slice = (start, end) => prepareRoute(full.points.slice(start, end + 1));
const wholeRoute = { id: 'gesamt', isFullRoute: true };
function day(number, startPointIndex, endPointIndex, stops = [], overnight = null) {
  return {
    id: `tag-${number}`, day: number, title: `Tag ${number} Strecke`,
    start: `Ort ${number}`, end: `Ort ${number + 1}`, overnight,
    description: `Beschreibung Tag ${number}`,
    routeProvenance: { startPointIndex, endPointIndex }, stops
  };
}

test('maps day sections and local photo stops by cumulative full-route distance', () => {
  const stages = [wholeRoute, day(1, 0, 1, [{ id: 'foto-1', progress: .5, title: 'Aussicht', caption: 'Fotobeschreibung', photoIds: ['bild-1'] }]), day(2, 1, 3)];
  const timeline = buildJourneyTimeline(stages, [full, slice(0, 1), slice(1, 3)]);

  assert.equal(timeline.fullRouteIndex, 0);
  assert.equal(timeline.segments.length, 2);
  assert.ok(Math.abs(timeline.segments[0].start - 0) < 1e-12);
  assert.ok(Math.abs(timeline.segments[0].end - .25) < 1e-12);
  assert.ok(Math.abs(timeline.segments[1].start - .25) < 1e-12);
  assert.ok(Math.abs(timeline.segments[1].end - .75) < 1e-12);
  assert.ok(Math.abs(timeline.markers.find(group => group.items[0].kind === 'photo').progress - .125) < 1e-12);
  assert.equal(timelineSegmentAt(timeline.segments, .3).day, 2);
  assert.equal(timelineSegmentAt(timeline.segments, .9), null);
  assert.equal(timelineSegmentAt(timeline.segments, 1), null);
});

test('groups a photo stop with its coincident day boundary and keeps sleeping-place details', () => {
  const stages = [wholeRoute,
    day(1, 0, 1, [{ id: 'foto-ende', progress: 1, title: 'Ankunft', caption: 'Am Ziel angekommen.', photoIds: ['bild-ende'] }]),
    day(2, 1, 2, [], 'Berghütte')];
  const timeline = buildJourneyTimeline(stages, [full, slice(0, 1), slice(1, 2)]);
  const boundary = timeline.markers.find(group => Math.abs(group.progress - .25) < 1e-12);

  assert.deepEqual(boundary.items.map(item => item.kind), ['day', 'photo']);
  assert.equal(boundary.items[0].segment.sleepPlace, 'Ort 2');
  assert.equal(boundary.items[0].segment.confirmedSleepPlace, false);
  assert.equal(timeline.segments[1].sleepPlace, 'Berghütte');
  assert.equal(timeline.segments[1].confirmedSleepPlace, true);
});

test('newly added days appear from stage data and stages without GPX bounds stay unassigned', () => {
  const stages = [wholeRoute, day(1, 0, 1), day(2, 1, 3), day(3, 3, 4), { ...day(4, 4, 4), routeProvenance: {} }];
  const timeline = buildJourneyTimeline(stages, [full, slice(0, 1), slice(1, 3), slice(3, 4), slice(3, 4)]);

  assert.deepEqual(timeline.segments.map(segment => segment.day), [1, 2, 3]);
  assert.ok(Math.abs(timeline.segments[2].end - 1) < 1e-12);
  assert.equal(timelineSegmentAt(timeline.segments, 1).day, 3);
  assert.equal(timeline.markers.length, 3);
});

test('visually close marks group without chaining and keep each exact jump position selectable', () => {
  const marker = (id, progress) => ({ progress, items: [{ kind: 'photo', id, progress }] });
  const timeline = { routeLength: 1000, markers: [marker('a', .1), marker('b', .25), marker('c', .4)] };
  const groups = visibleTimelineMarkerGroups(timeline, 100, 20);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.items.map(item => item.id)), [['a', 'b'], ['c']]);
  assert.equal(groups[0].needsChoice, true);
  assert.ok(Math.abs(groups[0].progress - .175) < 1e-12);
  assert.equal(groups[0].items[0].progress, .1);
  assert.equal(groups[0].items[1].progress, .25);
});

test('touch targets cluster at a wider spacing than desktop marks', () => {
  const timeline = { routeLength: 1000, markers: [
    { progress: .1, items: [{ kind: 'day', id: 'a', progress: .1 }] },
    { progress: .5, items: [{ kind: 'day', id: 'b', progress: .5 }] }
  ] };

  assert.equal(visibleTimelineMarkerGroups(timeline, 100, 24).length, 2);
  assert.equal(visibleTimelineMarkerGroups(timeline, 100, 44).length, 1);
});
