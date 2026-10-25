import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { planCorridor } from './tile-plan.mjs';
try {
  const data = JSON.parse(await readFile(workerData.routeFile, 'utf8'));
  parentPort.postMessage(planCorridor(data.geometry.coordinates));
} catch { parentPort.postMessage({ error: 'Die vollständige GPX-Route konnte nicht geplant werden.' }); }
