import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biohipnosis-sandbox-'));
process.env.POC_DATA_DIR = dir;
process.env.POC_LLM = 'off';
process.env.POC_RATE_LIMIT = 'off';
process.env.POC_ADMIN_TOKEN = 'test-admin-token';

const { createServer } = await import('../../server/index.js');
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function json(pathname, options = {}) {
  const response = await fetch(base + pathname, options);
  const body = await response.json().catch(() => null);
  return { response, body };
}

const headers = (token) => ({ 'content-type': 'application/json', 'x-session-token': token });

test('sandbox catalog exposes every question and rejects unknown targets', async () => {
  const catalog = await json('/api/sandbox/catalog');
  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.body.sections.length, 8);
  assert.equal(
    catalog.body.sections.reduce((total, section) => total + section.items.length, 0),
    39,
  );

  const invalid = await json('/api/sandbox/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itemId: 'NOPE' }),
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error, 'invalid_target');
});

test('sandbox item test answers without being persisted as a real session', async () => {
  const created = await json('/api/sandbox/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itemId: 'M01' }),
  });
  assert.equal(created.response.status, 201);
  const { session, token } = created.body;
  assert.equal(session.testMode, true);
  assert.equal(session.testTarget.kind, 'item');
  assert.equal(session.currentItemId, 'M01');
  assert.equal(session.status, 'IN_PROGRESS');
  assert.match(session.messages.at(-1).text, /motivo principal/i);

  const unauthorized = await json(`/api/sandbox/sessions/${session.id}`);
  assert.equal(unauthorized.response.status, 401);

  const answered = await json(`/api/sandbox/sessions/${session.id}/messages`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ text: 'Me siento muy ansioso y no puedo dormir desde hace meses.' }),
  });
  assert.equal(answered.response.status, 200);
  assert.ok(answered.body.session.messages.length > session.messages.length);

  const adminList = await json('/api/admin/sessions', {
    headers: { 'x-admin-token': 'test-admin-token' },
  });
  assert.equal(adminList.response.status, 200);
  assert.ok(!adminList.body.sessions.some((entry) => entry.id === session.id));

  const sessionsDir = path.join(dir, 'sessions');
  const files = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
  assert.ok(!files.some((file) => file.includes(session.id)));

  const auditFile = path.join(dir, 'audit.jsonl');
  const auditLog = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8') : '';
  assert.ok(!auditLog.includes(session.id));

  const removed = await json(`/api/sandbox/sessions/${session.id}`, {
    method: 'DELETE',
    headers: { 'x-session-token': token },
  });
  assert.equal(removed.response.status, 200);
  const gone = await json(`/api/sandbox/sessions/${session.id}`, {
    headers: { 'x-session-token': token },
  });
  assert.equal(gone.response.status, 404);
});

test('sandbox reset clears the attempt and a section test starts with its intro', async () => {
  const created = await json('/api/sandbox/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sectionId: 'B' }),
  });
  assert.equal(created.response.status, 201);
  const { session, token } = created.body;
  assert.equal(session.testTarget.kind, 'section');
  assert.equal(session.currentSectionId, 'B');
  assert.equal(session.currentItemId, 'M01');
  const initialCount = session.messages.length;

  const answered = await json(`/api/sandbox/sessions/${session.id}/messages`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ text: 'Me siento muy ansioso y no puedo dormir desde hace meses.' }),
  });
  assert.equal(answered.response.status, 200);

  const reset = await json(`/api/sandbox/sessions/${session.id}/reset`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({}),
  });
  assert.equal(reset.response.status, 200);
  assert.equal(reset.body.reset, true);
  assert.equal(reset.body.session.currentItemId, 'M01');
  assert.equal(reset.body.session.messages.length, initialCount);
  assert.match(reset.body.session.messages.at(-1).text, /motivo principal/i);
});
