import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biohipnosis-api-'));
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

async function json(path, options = {}) {
  const response = await fetch(base + path, options);
  const body = await response.json().catch(() => null);
  return { response, body };
}

test('health endpoint reports the local deterministic mode', async () => {
  const { response, body } = await json('/api/health');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.totalItems, 39);
  assert.equal(body.llm.mode, 'off');
});

test('session creation, owner auth, idempotency and input limits', async () => {
  const created = await json('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'API Test', phone: '3001234567' }),
  });
  assert.equal(created.response.status, 201);
  assert.ok(created.body.token);
  assert.equal(created.body.session.status, 'AGE_PENDING');
  const { id } = created.body.session;
  const token = created.body.token;

  const unauthorized = await json(`/api/sessions/${id}`);
  assert.equal(unauthorized.response.status, 401);

  const authorized = await json(`/api/sessions/${id}`, {
    headers: { 'x-session-token': token },
  });
  assert.equal(authorized.response.status, 200);
  assert.equal(authorized.body.session.id, id);

  const message = {
    text: 'Sí, tengo 18 años',
    buttonId: 'age_yes',
    waMessageId: 'wam_api_test_1',
  };
  const first = await json(`/api/sessions/${id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': token },
    body: JSON.stringify(message),
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.session.status, 'CONSENT_PENDING');
  const count = first.body.session.messages.length;

  const duplicate = await json(`/api/sessions/${id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': token },
    body: JSON.stringify(message),
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.session.messages.length, count);

  const oversized = await json(`/api/sessions/${id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': token },
    body: JSON.stringify({ text: 'a'.repeat(2500) }),
  });
  assert.equal(oversized.response.status, 413);
});

test('admin endpoints require a valid token and export HTML', async () => {
  const bad = await json('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'wrong' }),
  });
  assert.equal(bad.response.status, 401);

  const good = await json('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'test-admin-token' }),
  });
  assert.equal(good.response.status, 200);

  const sessions = await json('/api/admin/sessions', {
    headers: { 'x-admin-token': 'test-admin-token' },
  });
  assert.equal(sessions.response.status, 200);
  assert.ok(sessions.body.sessions.length >= 1);

  const id = sessions.body.sessions[0].id;
  const detail = await json(`/api/admin/sessions/${id}`, {
    headers: { 'x-admin-token': 'test-admin-token' },
  });
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.session.id, id);

  const exported = await fetch(`${base}/api/admin/sessions/${id}/export?format=html&token=test-admin-token`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type') || '', /text\/html/);
  const html = await exported.text();
  assert.match(html, /Resumen de entrevista/i);
});
