import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRoute, feature } from '../app/js/route.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
if (args.includes('--help') || !value('--stage') || !value('--file')) {
  console.log('npm run route -- --stage tag-01 --file /Pfad/route.gpx [--kind reconstructed|recorded] [--source-url https://…]\nAuch zusammenhängende GeoJSON-LineStrings sind möglich.');
  process.exit(args.includes('--help') ? 0 : 1);
}
const manifestPath = path.join(root, 'app/data/journey.json'), journey = JSON.parse(await readFile(manifestPath, 'utf8'));
const stage = journey.stages.find(s => s.id === value('--stage'));
if (!stage) throw new Error('Diese Etappen-ID existiert nicht. Zuerst im Reisemanifest ergänzen.');
const inputPath = path.resolve(value('--file')), content = await readFile(inputPath, 'utf8');
const kind = value('--kind') || 'reconstructed';
if (!['reconstructed', 'recorded'].includes(kind)) throw new Error('--kind muss reconstructed oder recorded sein.');
let geometry;
if (/\.gpx$/i.test(inputPath)) {
  if (XMLValidator.validate(content) !== true) throw new Error('Die GPX-Datei ist kein gültiges XML.');
  const gpx = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true }).parse(content).gpx;
  const array = x => x === undefined ? [] : Array.isArray(x) ? x : [x];
  const segments = array(gpx?.trk).flatMap(t => array(t.trkseg).map(seg => array(seg.trkpt)));
  if (!segments.length) segments.push(...array(gpx?.rte).map(r => array(r.rtept)));
  const valid = segments.filter(s => s.length > 1);
  if (valid.length !== 1) throw new Error('Bitte genau einen zusammenhängenden Track pro Etappe verwenden. Getrennte Segmente werden nicht mit erfundenen Geraden verbunden.');
  geometry = { type: 'LineString', coordinates: valid[0].map(p => [Number(p.lon), Number(p.lat)]) };
} else {
  const geo = JSON.parse(content); geometry = geo.type === 'Feature' ? geo.geometry : geo;
  if (geometry.type !== 'LineString') throw new Error('Bitte einen einzelnen GeoJSON-LineString oder ein Feature mit LineString verwenden.');
}
const route = prepareRoute(geometry.coordinates);
const provenance = { kind, source: path.basename(inputPath), url: value('--source-url'), note: kind === 'recorded' ? 'Bereitgestellte GPS-Aufzeichnung.' : 'Rekonstruierte Strecke; mit tatsächlichen Etappen abgleichen.' };
const target = path.resolve(root, 'app/data', stage.routeFile);
if (!target.startsWith(path.join(root, 'app/data/routes') + path.sep)) throw new Error('Routendatei muss im Ordner data/routes liegen.');
const output = feature(route.points); output.properties = provenance;
await writeFile(target, JSON.stringify(output, null, 2) + '\n'); stage.routeProvenance = provenance;
await writeFile(manifestPath, JSON.stringify(journey, null, 2) + '\n');
console.log(`Route für ${stage.title} importiert (${(route.length / 1000).toFixed(1)} km). Fotostopps anschließend mit der neuen Strecke abgleichen.`);
