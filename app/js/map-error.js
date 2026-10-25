export function describeMapError(error = {}) {
  const raw = String(error.message || error.error?.message || 'Keine weiteren Fehlerdetails vom Kartenanbieter.');
  const detail = raw.replace(/([?&]access_token=)[^&\s"')]+/gi, '$1[entfernt]').replace(/\b(?:pk|sk|tk)\.[A-Za-z0-9._-]+/g, '[Schlüssel entfernt]').slice(0, 500);
  const status = Number(error.status || error.statusCode || error.response?.status || raw.match(/(?:HTTP\s+|\()([45]\d\d)\b/i)?.[1]) || 0;
  let message;
  if (status === 401) message = 'Mapbox hat eine Kartenanfrage abgelehnt (HTTP 401). Prüfe den Schlüssel direkt bei Mapbox; ein gültiger Schlüssel kann auch bei einem gesperrten Ressourcenzugriff abgelehnt werden.';
  else if (status === 403) message = 'Mapbox verweigert den Zugriff (HTTP 403). Prüfe die URL-Freigabe für http://localhost:5173 und die Berechtigungen des Schlüssels.';
  else if (status === 402) message = 'Mapbox verlangt eine Kontofreigabe (HTTP 402). Prüfe den Kontostatus und die Abrechnung in deiner Mapbox-Konsole.';
  else if (status === 429) message = 'Mapbox meldet zu viele Anfragen (HTTP 429). Bitte etwas später erneut versuchen und die Kontolimits prüfen.';
  else if (status === 404) message = 'Eine Kartenressource wurde nicht gefunden (HTTP 404).';
  else message = 'Eine Kartenressource konnte nicht geladen werden.';
  let resource = '';
  try { const url = new URL(error.url); resource = `${url.origin}${url.pathname}`; } catch { /* No resource URL was supplied. */ }
  return { status, resource, message: `${message}${resource ? ` Ressource: ${resource}.` : ''} Details: ${detail}` };
}
