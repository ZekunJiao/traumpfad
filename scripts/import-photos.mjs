import { ExifTool } from 'exiftool-vendored';
import { readdir, readFile, writeFile, mkdir, access, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hashFile, normalizeCaptureTime, matchStage } from './photo-utils.mjs';

const exec = promisify(execFile), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('npm run import -- [--source /absoluter/Fotoordner]\nStandard: Material/fotos-originale (oder material/fotos-originale).\nLiest JPEG, HEIC, PNG und TIFF. Schreibt nur Webkopien, Importbericht und neue Manifest-Einträge.'); process.exit(0);
}
const custom = args.indexOf('--source');
if (custom >= 0 && !args[custom + 1]) throw new Error('--source benötigt einen Ordner.');
const source = path.resolve(custom >= 0 ? args[custom + 1] : path.join(root, 'Material/fotos-originale'));
const manifestPath = path.join(root, 'app/data/journey.json');
const journey = JSON.parse(await readFile(manifestPath, 'utf8'));
const output = path.join(root, 'app/assets/photos');
await mkdir(output, { recursive: true });
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.isFile() && /\.(jpe?g|heic|heif|png|tiff?)$/i.test(entry.name)) files.push(file);
  }
}
await walk(source);
if (process.platform !== 'darwin' && files.length) throw new Error('Der Bildimport nutzt macOS sips. Bitte auf dem Mac ausführen.');
const report = { imported: [], existing: [], needsReview: [], errors: [] };
const exiftool = new ExifTool({ maxProcs: 2, taskTimeoutMillis: 60000 });
const known = new Map(journey.photos.filter(p => p.sha256).map(p => [p.sha256, p]));
let originalManifest = JSON.stringify(journey);
try {
  for (const [index, file] of files.entries()) {
    console.log(`[${index + 1}/${files.length}] ${path.basename(file)}`);
    try {
      const sha256 = await hashFile(file), existing = known.get(sha256), id = existing?.id || `foto-${sha256.slice(0, 16)}`;
      let tags;
      try { tags = await exiftool.read(file, ['-G1']); } catch { tags = null; }
      // Read raw EXIF wall time, avoiding timezone inference by a metadata library.
      const rawTags = tags ? {
        DateTimeOriginal: tags['ExifIFD:DateTimeOriginal'] || tags.DateTimeOriginal,
        SubSecDateTimeOriginal: tags['Composite:SubSecDateTimeOriginal'] || tags.SubSecDateTimeOriginal,
        OffsetTimeOriginal: tags['ExifIFD:OffsetTimeOriginal'] || tags.OffsetTimeOriginal
      } : {};
      const capturedAt = normalizeCaptureTime(rawTags, journey.timezone);
      const assigned = matchStage(capturedAt, journey.stages);
      const full = path.join(output, `${id}.jpg`), thumbnail = path.join(output, `${id}-thumb.jpg`);
      for (const [destination, size] of [[full, '2560'], [thumbnail, '560']]) {
        try { await access(destination); } catch {
          const temporary = destination + '.tmp.jpg';
          let longest = Math.max(Number(tags?.['File:ImageWidth']) || 0, Number(tags?.['File:ImageHeight']) || 0);
          if (!longest) {
            const { stdout } = await exec('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
            longest = Math.max(...[...stdout.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map(m => Number(m[1])));
          }
          const boundedSize = String(Math.min(Number(size), longest || Number(size)));
          await exec('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', boundedSize, file, '--out', temporary], { timeout: 60000 });
          // Preserve the orientation written by sips; browsers honor EXIF orientation.
          await rename(temporary, destination);
        }
      }
      if (existing) {
        // Never overwrite user-edited captions, IDs, stage assignments or timestamps.
        if (!existing.stageId && existing.assignment !== 'manual' && assigned.stageId) { existing.stageId = assigned.stageId; existing.assignment = 'date'; }
        report.existing.push({ id, file: path.relative(source, file) });
      } else {
        const photo = { id, sha256, originalName: path.relative(source, file), file: `assets/photos/${id}.jpg`, thumbnail: `assets/photos/${id}-thumb.jpg`, capturedAt, stageId: assigned.stageId, assignment: assigned.stageId ? 'date' : 'unassigned', title: path.parse(file).name, caption: '', placeholder: false };
        journey.photos.push(photo); known.set(sha256, photo); report.imported.push({ id, file: path.relative(source, file), stageId: assigned.stageId });
      }
      const photo = known.get(sha256);
      if (!photo.stageId) report.needsReview.push({ id, file: path.relative(source, file), capturedAt, reason: assigned.reason });
      if (!tags) report.needsReview.push({ id, file: path.relative(source, file), reason: 'Metadaten konnten nicht gelesen werden; Bildkopie wurde erstellt.' });
    } catch (error) { report.errors.push({ file: path.relative(source, file), reason: error.message }); }
  }
} finally { await exiftool.end(); }

if (JSON.stringify(journey) !== originalManifest) {
  await writeFile(manifestPath + '.tmp', JSON.stringify(journey, null, 2) + '\n');
  await rename(manifestPath + '.tmp', manifestPath);
}
await mkdir(path.join(root, 'Material'), { recursive: true });
await writeFile(path.join(root, 'Material/import-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`${report.imported.length} neu, ${report.existing.length} bereits vorhanden, ${report.needsReview.length} zu prüfen, ${report.errors.length} Fehler.\nBericht: Material/import-report.json`);
if (!files.length) console.log('Noch keine Bilder im Quellordner. Exportiere zuerst deine Originale aus Fotos.');
if (report.errors.length) process.exitCode = 1;
