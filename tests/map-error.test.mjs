import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMapError } from '../app/js/map-error.js';
import { JourneyMap } from '../app/js/map.js';

test('URL restrictions and account errors get distinct, actionable diagnostics', () => {
  assert.match(describeMapError({ status: 403, message: 'Forbidden' }).message, /localhost:5173/);
  assert.match(describeMapError({ status: 401, message: 'Unauthorized' }).message, /Kartenanfrage/);
  assert.match(describeMapError({ status: 402, message: 'Payment required' }).message, /Kontostatus/);
});
test('diagnostics never expose access tokens from failed resource URLs', () => {
  const diagnostic = describeMapError({ message: 'Failed https://api.mapbox.com/style?access_token=pk.private-example-123&fresh=true' });
  assert.ok(!diagnostic.message.includes('private-example-123'));
  assert.match(diagnostic.message, /entfernt/);
  const resource = describeMapError({ status: 401, url: 'https://api.mapbox.com/v4/terrain.json?access_token=pk.private-example-123' });
  assert.equal(resource.resource, 'https://api.mapbox.com/v4/terrain.json'); assert.ok(!resource.message.includes('private-example-123'));
});
test('a rejected connection is disposed so stale requests cannot obscure its cause', () => {
  let removed = false, message;
  const map = Object.create(JourneyMap.prototype);
  Object.assign(map, { map: { stop() {}, remove() { removed = true; } }, ready: true, markers: [], landmarkMarkers: [], container: { hidden: true }, onStatus: (_, text) => { message = text; } });
  map.fail('HTTP 401');
  assert.equal(removed, true); assert.equal(map.map, null); assert.equal(map.ready, false);
  assert.equal(map.container.hidden, false); assert.equal(message, 'HTTP 401');
});
