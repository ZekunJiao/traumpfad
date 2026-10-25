import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { composeRouteCoordinates } from '../app/js/route-composition.js';
import { prepareRoute } from '../app/js/route.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = resolve(root, 'app/data');
const journeyPath = resolve(dataDirectory, 'journey.json');
const journey = JSON.parse(await readFile(journeyPath, 'utf8'));
const days = journey.stages.filter(stage => !stage.isFullRoute && !stage.isPointStage).sort((a, b) => a.day - b.day);
if (days.length !== journey.totalDays) throw new Error(`Erwartet werden ${journey.totalDays} Tagesetappen, gefunden wurden ${days.length}.`);

const sources = await Promise.all(days.map(async stage => {
  const sourcePath = resolve(dataDirectory, stage.routeFile);
  const geo = JSON.parse(await readFile(sourcePath, 'utf8'));
  const geometry = geo.type === 'Feature' ? geo.geometry : geo;
  if (geometry?.type !== 'LineString') throw new Error(`${stage.title}: Die Quelldatei muss ein LineString sein.`);
  return { stage, coordinates: geometry.coordinates };
}));
const composed = composeRouteCoordinates(sources);
const route = prepareRoute(composed.coordinates);
const fullRoute = journey.stages.find(stage => stage.isFullRoute);
if (!fullRoute) throw new Error('Die Gesamtstrecke fehlt in journey.json.');

for (const range of composed.stageRanges) {
  const stage = days.find(item => item.id === range.stageId);
  const provenance = stage.routeProvenance || (stage.routeProvenance = {});
  if (!provenance.sourcePointRange && Number.isInteger(provenance.startPointIndex) && Number.isInteger(provenance.endPointIndex)) {
    provenance.sourcePointRange = { startPointIndex: provenance.startPointIndex, endPointIndex: provenance.endPointIndex };
  }
  Object.assign(provenance, range, { coordinateSpace: 'composite-route' });
}

const routeProperties = {
  kind: 'composite',
  title: 'München bis Markusplatz, Venedig',
  sourceStages: days.map(stage => stage.id),
  connectors: composed.connectors
};
const routeFeature = { type: 'Feature', properties: routeProperties, geometry: { type: 'LineString', coordinates: composed.coordinates } };
await writeFile(resolve(dataDirectory, fullRoute.routeFile), `${JSON.stringify(routeFeature)}\n`);

fullRoute.description = `Eine durchgehende Route aus ${days.length} Tagesetappen von München bis zum Markusplatz in Venedig. Länge: ${(route.length / 1000).toFixed(1)} km. Die Tagesdateien bleiben als Quellen erhalten.`;
fullRoute.routeProvenance = {
  ...(fullRoute.routeProvenance || {}),
  kind: 'composite',
  source: 'Tagesrouten 01–27',
  note: `Zusammengesetzt aus den ${days.length} Tagesrouten in chronologischer Reihenfolge. ${composed.connectors.length ? 'Kurze direkte Verbindungen schließen kleine Lücken zwischen aufeinanderfolgenden Tagesrouten.' : 'Aufeinanderfolgende Tagesrouten schließen direkt aneinander an.'}`,
  connectorCount: composed.connectors.length
};
await writeFile(journeyPath, `${JSON.stringify(journey, null, 2)}\n`);
console.log(`Gesamtlinie: ${days.length} Tage, ${route.points.length.toLocaleString('de-DE')} Punkte, ${(route.length / 1000).toFixed(1)} km, ${composed.connectors.length} Verbindungen.`);
