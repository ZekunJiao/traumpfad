import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import { prepareRoute } from '../app/js/route.js';

test('the GPX source stays intact and reference sections preserve their source point ranges', async () => {
  const base = new URL('../app/data/', import.meta.url);
  const journey = JSON.parse(await readFile(new URL('journey.json', base), 'utf8'));
  const gpx = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })
    .parse(await readFile(new URL('routes/traumpfad-muenchen-venedig.gpx', base), 'utf8'));
  const expected = gpx.gpx.trk.trkseg.trkpt.map(p => [Number(p.lon), Number(p.lat), Number(p.ele)]);
  const full = journey.stages.find(s => s.isFullRoute);
  assert.equal(expected.length, 35524);
  const route = prepareRoute(expected);
  assert.ok(route.length > 540000 && route.length < 550000);
  let previousEnd = 0;
  for (const stage of journey.stages.filter(s => s.referenceSection && !s.isFullRoute)) {
    const { startPointIndex, endPointIndex } = stage.routeProvenance;
    assert.equal(startPointIndex, previousEnd);
    const section = JSON.parse(await readFile(new URL(stage.routeFile, base), 'utf8'));
    assert.deepEqual(section.geometry.coordinates, expected.slice(startPointIndex, endPointIndex + 1));
    previousEnd = endPointIndex;
  }
  assert.equal(full.date, null);
  assert.equal(full.stops[0]?.title, 'Start Marienplatz');
});
