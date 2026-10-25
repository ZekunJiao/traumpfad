// Keep the SDK's real session parameters on upstream requests. Only the public
// token is moved to a same-origin header, never to local URLs or cache filenames.
export function localTileRequest(url, type, origin = globalThis.location?.origin) {
  if (type !== 'Tile' || !origin) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.origin !== 'https://api.mapbox.com' || !/^\/(?:v4|raster\/v1)\/(mapbox\.satellite|mapbox\.mapbox-terrain-dem-v1)\/\d+\/\d+\/\d+(?:@2x)?\.(?:webp|jpg(?:70|80|90)?|pngraw|png(?:32|64|128|256)?)$/.test(parsed.pathname)) return null;
  const token = parsed.searchParams.get('access_token');
  if (!token) return null;
  parsed.searchParams.delete('access_token');
  return { url: origin + '/api/map-tiles?resource=' + encodeURIComponent(parsed.pathname + parsed.search), headers: { 'X-Mapbox-Token': token } };
}
