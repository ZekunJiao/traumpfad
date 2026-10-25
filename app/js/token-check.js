const messages = {
  TokenValid: 'Mapbox bestätigt: Dieser Schlüssel ist gültig und aktiv. Falls die Karte weiter abgelehnt wird, müssen wir den Zugriff auf die Kartenressourcen oder den Kontostatus prüfen.',
  TokenMalformed: 'Der Schlüssel ist unvollständig oder hat ein ungültiges Format. Kopiere den vollständigen öffentlichen Token direkt aus deiner Mapbox-Konsole.',
  TokenInvalid: 'Mapbox bestätigt: Die Signatur dieses Schlüssels ist ungültig. Kopiere den vollständigen aktuellen Token erneut aus deiner Mapbox-Konsole.',
  TokenRevoked: 'Mapbox bestätigt: Dieser Schlüssel wurde widerrufen oder gelöscht. Verwende einen anderen aktiven öffentlichen Token aus deiner Mapbox-Konsole.',
  TokenExpired: 'Mapbox bestätigt: Dieser Schlüssel ist abgelaufen. Verwende einen aktuellen öffentlichen Token aus deiner Mapbox-Konsole.'
};

function responseDiagnostics(response) {
  const names = ['retry-after', 'x-rate-limit-limit', 'x-rate-limit-interval', 'x-rate-limit-reset', 'x-request-id', 'x-mapbox-request-id', 'x-amz-cf-id', 'date', 'x-cache'];
  return Object.fromEntries(names.map(name => [name, response.headers.get(name)]).filter(([, value]) => value));
}

function formatDiagnostics(headers) {
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\n');
}

export async function checkMapboxToken(value, request = fetch) {
  const token = value.trim();
  if (!token) return { valid: false, code: 'Missing', message: 'Bitte einen öffentlichen Mapbox-Schlüssel eingeben oder zuerst in der App hinterlegen.' };
  if (!/^pk\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return { valid: false, code: 'TokenMalformed', message: messages.TokenMalformed };
  try {
    const response = await request(`https://api.mapbox.com/tokens/v2?access_token=${encodeURIComponent(token)}`, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10000) });
    const body = await response.json().catch(() => ({}));
    if (response.ok && messages[body.code]) return { valid: body.code === 'TokenValid', code: body.code, message: messages[body.code] };
    if (response.status === 401) return { valid: false, code: 'Unauthorized', message: 'Auch die direkte Schlüsselprüfung wird von Mapbox mit HTTP 401 abgelehnt. Bitte einen aktuellen vollständigen öffentlichen Token aus deiner Konsole verwenden.' };
    if (response.status === 403) return { valid: false, code: 'Forbidden', message: 'Die Schlüsselprüfung ist nicht erlaubt (HTTP 403). Prüfe die URL-Freigabe für http://localhost:5173 und die Schlüsselberechtigungen.' };
    if (response.status === 429) return { valid: false, code: 'RateLimited', message: 'Mapbox begrenzt gerade die Anfragen (HTTP 429). Bitte etwas warten. Die Gültigkeit des Schlüssels konnte noch nicht geprüft werden.' };
    return { valid: false, code: 'Unknown', message: `Die Schlüsselprüfung lieferte keine eindeutige Antwort (HTTP ${response.status}). Die Gültigkeit ist noch nicht bestätigt.` };
  } catch {
    return { valid: false, code: 'NetworkError', message: 'Die Schlüsselprüfung konnte Mapbox nicht erreichen. Das sagt noch nichts über die Gültigkeit des Schlüssels aus. Bitte Verbindung und Browserblocker prüfen.' };
  }
}

export async function checkMapboxConnection(value, request = fetch, failedRequest) {
  const result = await checkMapboxToken(value, request);
  if (!result.valid) return result;
  const token = encodeURIComponent(value.trim());
  let probes = [
    ['Satellitenbild (JPEG)', `https://api.mapbox.com/v4/mapbox.satellite/1/0/0@2x.jpg90?access_token=${token}`],
    ['Satellitenbild (WebP)', `https://api.mapbox.com/v4/mapbox.satellite/1/0/0@2x.webp?access_token=${token}`],
    ['3D-Höhendaten', `https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1.json?secure&access_token=${token}`]
  ];
  if (/^https:\/\/api\.mapbox\.com\/v4\/mapbox\.satellite\/\d+\/\d+\/\d+\.webp$/.test(failedRequest?.resource || '')) {
    const url = `${failedRequest.resource}?access_token=${token}`;
    probes = [['Betroffene Satellitenkachel (direkt)', url]];
    if (/^[A-Za-z0-9]+$/.test(failedRequest.sku || '')) probes.push(['Betroffene Satellitenkachel (Karten-Sitzung)', `${url}&sku=${encodeURIComponent(failedRequest.sku)}`]);
  }
  const resources = [];
  // Sequential requests keep the check small even on a rate-limited demo account.
  for (const [name, url] of probes) {
    try {
      const response = await request(url, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10000) });
      let detail = '';
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        detail = String(body.message || '').replace(/\b(?:pk|sk|tk)\.[A-Za-z0-9._-]+/g, '[entfernt]').slice(0, 200);
      } else await response.body?.cancel().catch(() => {});
      resources.push({ name, ok: response.ok, status: response.status, detail, headers: responseDiagnostics(response) });
      if (response.status === 429) break;
    } catch { resources.push({ name, ok: false, status: 0, detail: 'Netzwerkfehler' }); }
  }
  const access = resources.map(r => `${r.name}: ${r.ok ? 'erreichbar' : r.status ? `HTTP ${r.status}${r.detail ? ' · ' + r.detail : ''}` : 'nicht erreichbar'}${r.headers && Object.keys(r.headers).length ? '\n' + formatDiagnostics(r.headers) : ''}`).join('\n');
  const satelliteDenied = resources.some(r => r.name.includes('Satelliten') && [401, 402, 403, 429].includes(r.status));
  const accountHint = satelliteDenied ? '\n\nFalls dein Konto noch im Testzugang ohne Zahlungsmethode ist: Die Raster Tiles API für Satellitenbilder ist dort nicht verfügbar. Die E-Mail-Bestätigung allein schaltet sie nicht frei. Prüfe den Kontostatus in der Mapbox-Konsole. HTTP 429 kann außerdem auf ein Anfragelimit hinweisen; die App wiederholt diese Prüfung nicht automatisch.' : '';
  const rateLimited = resources.some(r => r.status === 429);
  const rateHint = rateLimited ? '\n\nEine gezielte Satelliten-Testanfrage wurde begrenzt. Nach dieser Antwort wurden keine weiteren Kartenressourcen angefragt. Falls das Konto bereits freigeschaltet ist, muss die noch aktive Begrenzung bei Mapbox geklärt werden.' : '';
  return { ...result, checkedAt: new Date().toISOString(), resources, message: `Mapbox bestätigt: Der Schlüssel ist gültig und aktiv.\n\n${access}${accountHint}${rateHint}` };
}
