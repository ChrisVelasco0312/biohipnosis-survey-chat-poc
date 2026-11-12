import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.E2E_DATA_DIR
  ? path.resolve(process.env.E2E_DATA_DIR)
  : path.resolve(here, '..', '.data');
const artifactsDir = path.resolve(here, '..', 'artifacts');

// Cada corrida visual debe empezar sin sesiones de la corrida anterior.
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.rmSync(artifactsDir, { recursive: true, force: true });
fs.mkdirSync(artifactsDir, { recursive: true });

console.log(`[e2e] datos limpios: ${dataDir}`);
console.log(`[e2e] capturas:      ${artifactsDir}`);
