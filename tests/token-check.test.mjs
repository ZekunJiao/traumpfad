import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMapboxToken, checkMapboxConnection } from '../app/js/token-check.js';

const token = 'pk.ZGVtbw.signature';
test('local format failures never make an API request', async () => {
  let called = false;
  const response = await checkMapboxToken('pk.incomplete', () => { called = true; });
  assert.equal(response.code, 'TokenMalformed'); assert.equal(called, false);
});
test('HTTP 200 does not mean a token is valid: Mapbox validation code decides', async () => {
  const result = await checkMapboxToken(token, async () => new Response(JSON.stringify({ code: 'TokenInvalid' }), { status: 200 }));
  assert.equal(result.valid, false); assert.match(result.message, /Signatur/);
  const valid = await checkMapboxToken(token, async () => new Response(JSON.stringify({ code: 'TokenValid' }), { status: 200 }));
  assert.equal(valid.valid, true);
});
test('rate limits and network failures are not mislabeled as invalid credentials', async () => {
  const limited = await checkMapboxToken(token, async () => new Response('{}', { status: 429 }));
  assert.equal(limited.code, 'RateLimited');
  const network = await checkMapboxToken(token, async () => { throw new Error('offline'); });
  assert.equal(network.code, 'NetworkError');
});
test('a valid token is distinguished from denied satellite access', async () => {
  const result = await checkMapboxConnection(token, async url => {
    if (url.includes('/tokens/v2')) return new Response(JSON.stringify({ code: 'TokenValid' }));
    if (url.includes('mapbox.satellite')) return new Response(JSON.stringify({ message: 'Not Authorized' }), { status: 401 });
    return new Response('{}');
  });
  assert.equal(result.valid, true); assert.equal(result.resources[0].status, 401); assert.equal(result.resources[2].ok, true);
  assert.match(result.message, /Schlüssel ist gültig/); assert.match(result.message, /JPEG.*401/);
  assert.match(result.message, /Testzugang ohne Zahlungsmethode/);
});
test('a satellite rate limit stops subsequent probes without blaming a valid token', async () => {
  const requests = [];
  const result = await checkMapboxConnection(token, async url => {
    requests.push(url);
    return url.includes('/tokens/v2')
      ? new Response(JSON.stringify({ code: 'TokenValid' }))
      : new Response(JSON.stringify({ message: 'Too Many Requests' }), { status: 429, headers: { 'Retry-After': '60', 'X-Rate-Limit-Limit': '100000', 'X-Rate-Limit-Reset': '1792875000' } });
  });
  assert.equal(result.valid, true);
  assert.equal(requests.length, 2);
  assert.equal(result.resources.length, 1);
  assert.match(result.message, /Anfragelimit/);
  assert.match(result.message, /Falls dein Konto/);
  assert.equal(result.resources[0].headers['retry-after'], '60');
  assert.match(result.message, /x-rate-limit-limit: 100000/);
});
test('a failed tile can be compared with its original map session without exposing its key', async () => {
  const urls = [];
  const result = await checkMapboxConnection(token, async url => {
    urls.push(url);
    if (url.includes('/tokens/v2')) return new Response(JSON.stringify({ code: 'TokenValid' }));
    return new Response('{}', { status: url.includes('&sku=') ? 429 : 200 });
  }, { resource: 'https://api.mapbox.com/v4/mapbox.satellite/12/2177/1425.webp', sku: '101Example' });
  assert.equal(result.resources[0].ok, true);
  assert.equal(result.resources[1].status, 429);
  assert.equal(urls.length, 3);
  assert.ok(urls[2].includes('&sku=101Example'));
  assert.ok(!result.message.includes(token));
});
