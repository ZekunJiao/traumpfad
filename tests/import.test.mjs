import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExifTool } from 'exiftool-vendored';
import { hashFile } from '../scripts/photo-utils.mjs';

const exec = promisify(execFile), project = path.resolve(import.meta.dirname, '..');
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'traumpfad-test-'));
  for (const folder of ['scripts', 'app/js', 'app/data/routes', 'source']) await mkdir(path.join(dir, folder), { recursive: true });
  await symlink(path.join(project, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  for (const file of ['scripts/import-photos.mjs', 'scripts/photo-utils.mjs', 'scripts/import-route.mjs', 'app/js/route.js']) await copyFile(path.join(project, file), path.join(dir, file));
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  const manifest = JSON.parse(await readFile(path.join(project, 'app/data/journey.json'), 'utf8'));
  manifest.stages[0].date = '2025-07-12';
  await writeFile(path.join(dir, 'app/data/journey.json'), JSON.stringify(manifest));
  return dir;
}
test('photo import preserves originals, orientation, captions and assignments across reimports', { skip: process.platform !== 'darwin', timeout: 60000 }, async () => {
  const dir = await fixture(), source = path.join(dir, 'source');
  await writeFile(path.join(source, 'image.ppm'), Buffer.concat([Buffer.from('P6\n20 10\n255\n'), Buffer.alloc(600, 120)]));
  const file = path.join(source, 'image.jpg');
  await exec('/usr/bin/sips', ['-s', 'format', 'jpeg', path.join(source, 'image.ppm'), '--out', file]);
  const et = new ExifTool();
  try {
    await et.write(file, { DateTimeOriginal: '2025:07:12 08:30:00', OffsetTimeOriginal: '+02:00', 'Orientation#': 6 }, ['-overwrite_original']);
    const before = await hashFile(file);
    await exec(process.execPath, [path.join(dir, 'scripts/import-photos.mjs'), '--source', source], { timeout: 30000 });
    const manifestPath = path.join(dir, 'app/data/journey.json');
    const journey = JSON.parse(await readFile(manifestPath, 'utf8'));
    const imported = journey.photos.filter(p => !p.placeholder);
    assert.equal(imported.length, 1); assert.equal(imported[0].stageId, 'tag-01'); assert.equal(imported[0].capturedAt, '2025-07-12T08:30:00');
    const outputTags = await et.read(path.join(dir, 'app', imported[0].file), ['-G1']);
    assert.equal(outputTags['IFD0:Orientation'], 6); assert.equal(outputTags['File:ImageWidth'], 20); // No upscaling or double rotation.
    imported[0].caption = 'Meine persönliche Erinnerung'; imported[0].stageId = 'tag-02'; imported[0].assignment = 'manual';
    await writeFile(manifestPath, JSON.stringify(journey));
    await copyFile(file, path.join(source, 'duplicate.jpg'));
    await exec(process.execPath, [path.join(dir, 'scripts/import-photos.mjs'), '--source', source], { timeout: 30000 });
    const again = JSON.parse(await readFile(manifestPath, 'utf8')).photos.filter(p => !p.placeholder);
    assert.equal(again.length, 1); assert.equal(again[0].caption, 'Meine persönliche Erinnerung'); assert.equal(again[0].stageId, 'tag-02');
    assert.equal(await hashFile(file), before);
  } finally { await et.end(); }
});

test('route import accepts a GPX track and refuses to bridge disconnected segments', { timeout: 10000 }, async () => {
  const dir = await fixture(), file = path.join(dir, 'source/route.gpx');
  const segment = '<trkseg><trkpt lat="47.1" lon="11.1"/><trkpt lat="47.2" lon="11.2"/></trkseg>';
  await writeFile(file, `<gpx><trk>${segment}</trk></gpx>`);
  await exec(process.execPath, [path.join(dir, 'scripts/import-route.mjs'), '--stage', 'tag-01', '--file', file]);
  const resultPath = path.join(dir, 'app/data/routes/tag-01.geojson');
  const before = await readFile(resultPath, 'utf8');
  assert.equal(JSON.parse(before).geometry.coordinates.length, 2);
  await writeFile(file, `<gpx><trk>${segment}${segment}</trk></gpx>`);
  await assert.rejects(exec(process.execPath, [path.join(dir, 'scripts/import-route.mjs'), '--stage', 'tag-01', '--file', file]), /zusammenhängenden/);
  assert.equal(await readFile(resultPath, 'utf8'), before);
});
