import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { composeRouteCoordinates } from '../app/js/route-composition.js';
import { distance, prepareRoute } from '../app/js/route.js';
import { buildJourneyTimeline } from '../app/js/timeline.js';

test('composite route joins all 27 day sources and keeps the Venice finish', async () => {
  const base = new URL('../app/data/', import.meta.url);
  const journey = JSON.parse(await readFile(new URL('journey.json', base), 'utf8'));
  const days = journey.stages.filter(stage => !stage.isFullRoute && !stage.isPointStage).sort((a, b) => a.day - b.day);
  const sourceRoutes = await Promise.all(days.map(async stage => {
    const geo = JSON.parse(await readFile(new URL(stage.routeFile, base), 'utf8'));
    return { stage, coordinates: geo.geometry.coordinates };
  }));
  const composed = composeRouteCoordinates(sourceRoutes);
  const full = journey.stages.find(stage => stage.isFullRoute);
  const stored = JSON.parse(await readFile(new URL(full.routeFile, base), 'utf8')).geometry.coordinates;
  const timeline = buildJourneyTimeline(journey.stages, [prepareRoute(stored)]);

  assert.equal(days.length, 27);
  assert.deepEqual(composed.coordinates, stored);
  assert.deepEqual(composed.coordinates[0].slice(0, 2), sourceRoutes[0].coordinates[0].slice(0, 2));
  assert.deepEqual(composed.coordinates.at(-1).slice(0, 2), sourceRoutes.at(-1).coordinates.at(-1).slice(0, 2));
  assert.match(full.end, /Markusplatz, Venedig/);
  assert.equal(composed.stageRanges.length, 27);
  assert.equal(timeline.segments.length, 27);
  assert.equal(timeline.segments[0].id, 'tag-01');
  assert.equal(timeline.segments.at(-1).id, 'tag-27');
  assert.equal(timeline.segments[0].start, 0);
  assert.equal(timeline.segments.at(-1).end, 1);
  assert.equal(composed.stageRanges[0].startPointIndex, 0);
  assert.equal(composed.stageRanges.at(-1).endPointIndex, composed.coordinates.length - 1);
  for (let index = 0; index < days.length; index++) {
    assert.deepEqual(days[index].routeProvenance.startPointIndex, composed.stageRanges[index].startPointIndex);
    assert.deepEqual(days[index].routeProvenance.endPointIndex, composed.stageRanges[index].endPointIndex);
  }
  assert.equal(composed.connectors.length, 1);
  assert.ok(composed.connectors[0].distanceMeters > 150 && composed.connectors[0].distanceMeters < 200);
  assert.equal(composed.stageRanges[21].endPointIndex + 1, composed.stageRanges[22].startPointIndex);
  assert.ok(distance(composed.coordinates[composed.stageRanges[21].endPointIndex], composed.coordinates[composed.stageRanges[22].startPointIndex]) < 200);
});
