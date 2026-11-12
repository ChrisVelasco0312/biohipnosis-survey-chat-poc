import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biohipnosis-crypto-'));
process.env.POC_DATA_DIR = dir;
process.env.POC_LLM = 'off';
process.env.POC_RATE_LIMIT = 'off';

const crypto = await import('../../server/crypto.js');
const store = await import('../../server/store.js');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('AES-256-GCM seals and opens session payloads', () => {
  const sealed = crypto.seal({ hello: 'mundo', n: 1 });
  assert.match(sealed, /^POC1\./);
  assert.equal(sealed.includes('mundo'), false);
  assert.deepEqual(crypto.open(sealed), { hello: 'mundo', n: 1 });
});

test('tampered ciphertext is rejected', () => {
  const sealed = crypto.seal({ hello: 'mundo' });
  const parts = sealed.split('.');
  const last = parts[3];
  parts[3] = `${last.slice(0, -2)}${last.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
  assert.throws(() => crypto.open(parts.join('.')));
});

test('sessions are encrypted at rest and indexed with masked metadata', () => {
  store.init();
  const session = store.createSession({ name: 'Ana María Gómez', phoneE164: '+573001234567' });
  store.saveSession(session);
  const raw = fs.readFileSync(store.dataPaths().sessions + '/' + session.id + '.enc', 'utf8');
  assert.equal(raw.includes('Ana María'), false);
  assert.equal(raw.includes('3001234567'), false);

  const indexRaw = fs.readFileSync(store.dataPaths().index, 'utf8');
  assert.equal(indexRaw.includes('Ana María'), false);
  assert.equal(indexRaw.includes('3001234567'), false);
  assert.equal(indexRaw.includes('Ana M.'), true);

  const loaded = store.getSession(session.id);
  assert.equal(loaded.name, 'Ana María Gómez');
  assert.equal(loaded.phoneE164, '+573001234567');
});

test('audit hash chain verifies and detects tampering', () => {
  store.appendAudit({ type: 'test.event', actor: 'test', action: 'create', entity: 'test', entityId: '1', payload: { ok: true } });
  const result = store.verifyAudit();
  assert.equal(result.valid, true);
  assert.ok(result.entries >= 1);
});
