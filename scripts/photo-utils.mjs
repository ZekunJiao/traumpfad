import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function normalizeCaptureTime(tags, timezone = 'Europe/Berlin') {
  // EXIF DateTimeOriginal is the capture time. FileCreateDate is intentionally excluded.
  const raw = tags.SubSecDateTimeOriginal || tags.DateTimeOriginal;
  if (!raw) return null;
  const source = typeof raw === 'string' ? raw : raw.toISO?.() || raw.toString();
  const match = source.match(/^(\d{4})[:-](\d{2})[:-](\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = '', embeddedOffset] = match;
  const base = `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction}`;
  const offset = embeddedOffset || tags.OffsetTimeOriginal;
  const dateCheck = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(dateCheck.getTime()) || dateCheck.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) return null;
  const test = new Date(`${base}${offset || 'Z'}`);
  if (Number.isNaN(test.getTime()) || Number(month) > 12 || Number(day) > 31 || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  if (!offset) return base; // Without offset preserve the camera's local wall time.
  const parts = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(test).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
export function matchStage(capturedAt, stages) {
  if (!capturedAt) return { stageId: null, reason: 'Aufnahmezeit fehlt oder ist ungültig.' };
  const matches = stages.filter(stage => stage.date && stage.date === capturedAt.slice(0, 10));
  if (matches.length === 1) return { stageId: matches[0].id, reason: null };
  return { stageId: null, reason: matches.length ? 'Mehrere Etappen haben dieses Datum. Bitte manuell zuordnen.' : 'Für dieses Aufnahmedatum ist noch keine Etappe eingetragen.' };
}
