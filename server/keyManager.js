/* OpenCode API key lifecycle.

   The key lives in Secret Manager on Cloud Run. The owner pastes a new key in
   the admin console; we validate it against the models endpoint, add a new
   secret version and disable the previous ones. Rotation of the upstream key
   itself remains a manual action in the OpenCode Console. */
import crypto from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { config } from './config.js';

const KEY_CACHE_MS = 60_000;
const STATE_TTL_MS = 30_000;

const state = {
  state: 'unknown',
  updatedAt: null,
  expiresAt: null,
  lastError: null,
  fingerprint: null,
  checkedAt: null,
};

let client = null;
let db = null;
let cache = { key: null, at: 0 };
let stateLoadedAt = 0;
let readyPromise = null;

function secretName() {
  return `projects/${config.gcp.projectId}/secrets/${config.llm.keySecret}`;
}

function fingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function httpError(status, code, message) {
  return Object.assign(new Error(message), { statusCode: status, code });
}

function applyRemoteState(data) {
  if (!data) return;
  state.state = data.state || 'unknown';
  state.updatedAt = data.updatedAt || null;
  state.expiresAt = data.expiresAt || null;
  state.lastError = data.lastError || null;
  state.fingerprint = data.fingerprint || null;
  state.checkedAt = data.checkedAt || null;
  stateLoadedAt = Date.now();
}

async function loadState(force = false) {
  if (config.store !== 'cloud') {
    state.state = config.llm.keyEnv ? 'unverified' : 'missing';
    return state;
  }
  if (!db) db = new Firestore({ projectId: config.gcp.projectId });
  if (!force && Date.now() - stateLoadedAt < STATE_TTL_MS) return state;
  try {
    const snap = await db.doc('system/llm').get();
    if (snap.exists) applyRemoteState(snap.data());
  } catch (err) {
    console.error(`[keys] state read failed: ${err.message}`);
  }
  stateLoadedAt = Date.now();
  return state;
}

async function persistState() {
  if (config.store !== 'cloud') return;
  if (!db) db = new Firestore({ projectId: config.gcp.projectId });
  try {
    await db.doc('system/llm').set({ ...state });
  } catch (err) {
    console.error(`[keys] state write failed: ${err.message}`);
  }
}

export function initKeyManager() {
  if (readyPromise) return readyPromise;
  if (config.store === 'cloud') {
    client = new SecretManagerServiceClient();
    db = new Firestore({ projectId: config.gcp.projectId });
  }
  readyPromise = loadState(true).catch((err) => {
    console.error(`[keys] init failed: ${err.message}`);
    return state;
  });
  return readyPromise;
}

export function keyReady() {
  return readyPromise || Promise.resolve(state);
}

export async function getKey() {
  if (config.store !== 'cloud') {
    if (config.llm.keyEnv) return config.llm.keyEnv;
    throw httpError(503, 'key_missing', 'No hay una clave de OpenCode configurada.');
  }
  if (cache.key && Date.now() - cache.at < KEY_CACHE_MS) return cache.key;
  try {
    const [version] = await client.accessSecretVersion({ name: `${secretName()}/versions/latest` });
    const key = String(version.payload?.data || '').trim();
    if (!key) throw new Error('secret version is empty');
    cache = { key, at: Date.now() };
    return key;
  } catch (err) {
    if (config.llm.keyEnv) return config.llm.keyEnv;
    throw httpError(503, 'key_missing', `No se pudo leer la clave: ${err.message}`);
  }
}

export async function validateKey(key) {
  const res = await fetch(config.llm.modelsUrl, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw httpError(
      res.status === 401 || res.status === 403 ? 401 : 502,
      'key_invalid',
      `La clave fue rechazada (${res.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`,
    );
  }
  return res.json().catch(() => ({}));
}

async function disableOldVersions(keepName) {
  try {
    const [versions] = await client.listSecretVersions({ parent: secretName() });
    await Promise.allSettled(
      versions
        .filter((version) => version.name !== keepName && version.state === 'ENABLED')
        .map((version) => client.disableSecretVersion({ name: version.name })),
    );
  } catch (err) {
    console.error(`[keys] could not disable old versions: ${err.message}`);
  }
}

export async function setKey(rawKey, { expiresAt = null, actor = 'owner' } = {}) {
  const key = String(rawKey || '').trim();
  if (key.length < 20 || /\s/.test(key)) {
    throw httpError(400, 'invalid_key', 'La clave no tiene un formato válido.');
  }
  const models = await validateKey(key);

  let versionName = null;
  if (config.store === 'cloud') {
    if (!client) client = new SecretManagerServiceClient();
    const payload = { data: Buffer.from(key, 'utf8') };
    try {
      const [version] = await client.addSecretVersion({ parent: secretName(), payload });
      versionName = version.name;
    } catch (err) {
      if (err.code === 5 || /not found/i.test(err.message)) {
        await client.createSecret({
          parent: `projects/${config.gcp.projectId}`,
          secretId: config.llm.keySecret,
          secret: { replication: { automatic: {} } },
        });
        const [version] = await client.addSecretVersion({ parent: secretName(), payload });
        versionName = version.name;
      } else {
        throw err;
      }
    }
    await disableOldVersions(versionName);
    cache = { key, at: Date.now() };
  }

  state.state = 'valid';
  state.updatedAt = new Date().toISOString();
  state.expiresAt = expiresAt || null;
  state.lastError = null;
  state.fingerprint = fingerprint(key);
  state.checkedAt = new Date().toISOString();
  await persistState();
  return { ...state, versions: Array.isArray(models?.data) ? models.data.length : null, actor, versionName };
}

export function markValid() {
  if (state.state === 'valid') {
    state.checkedAt = new Date().toISOString();
    return;
  }
  state.state = 'valid';
  state.lastError = null;
  state.checkedAt = new Date().toISOString();
  stateLoadedAt = Date.now();
  void persistState();
}

export function markInvalid(reason) {
  state.state = 'invalid';
  state.lastError = String(reason || 'La clave no es válida.').slice(0, 300);
  state.checkedAt = new Date().toISOString();
  stateLoadedAt = Date.now();
  void persistState();
}

export function keyInfo() {
  return { ...state };
}

export function expiryWarning() {
  if (!state.expiresAt) return null;
  const remaining = Date.parse(state.expiresAt) - Date.now();
  if (!Number.isFinite(remaining)) return null;
  if (remaining <= 0) return 'expired';
  if (remaining <= 72 * 60 * 60 * 1000) return 'expiring';
  return null;
}
