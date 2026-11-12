import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biohipnosis-smoke-'));
process.env.POC_DATA_DIR = dir;
process.env.POC_LLM = 'off';
process.env.POC_RATE_LIMIT = 'off';
process.env.POC_ADMIN_TOKEN = 'smoke-token';

const { createServer } = await import('../server/index.js');
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
const created = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Smoke Test', phone: '3001234567' }),
}).then((r) => r.json());

console.log(JSON.stringify({ health, session: created.session.id, status: created.session.status }, null, 2));
await new Promise((resolve) => server.close(resolve));
fs.rmSync(dir, { recursive: true, force: true });
