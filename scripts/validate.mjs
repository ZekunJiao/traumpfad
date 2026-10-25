import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateJourney, prepareRoute } from '../app/js/route.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
try {
  const journey = JSON.parse(await readFile(path.join(root, 'data/journey.json'), 'utf8'));
  const errors = validateJourney(journey);
  for (const s of journey.stages) {
    try { const data = JSON.parse(await readFile(path.join(root, 'data', s.routeFile), 'utf8')); const geo = data.type === 'Feature' ? data.geometry : data; if (geo.type !== 'LineString') throw new Error('LineString erwartet.'); prepareRoute(geo.coordinates); }
    catch (e) { errors.push(`${s.id}: ${e.message}`); }
  }
  for (const p of journey.photos.filter(p => !p.placeholder)) {
    for (const file of [p.file, p.thumbnail].filter(Boolean)) { try { await access(path.join(root, file)); } catch { errors.push(`${p.id}: Bilddatei fehlt: ${file}`); } }
  }
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`Reise gültig: ${journey.stages.length} Etappen, ${journey.stages.reduce((n, s) => n + s.stops.length, 0)} Fotostopps, ${journey.photos.length} Fotoeinträge.\n${journey.demo ? 'Beispielreise – echte Daten noch ergänzen.' : 'Eigene Reise.'}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
