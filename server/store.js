/* Storage facade. Callers keep the original synchronous API; persistence is
   delegated to either the filesystem driver (local) or the Firestore + GCS
   driver (Cloud Run). The cloud driver loads into memory on init() and writes
   through asynchronously; handler() awaits ready()/flush(). */
import { config } from './config.js';
import { ensureKey, hashEntry, open, randomId, seal, sha256 } from './crypto.js';
import { createFsDriver } from './store-fs.js';
import { createCloudDriver } from './store-cloud.js';
import { defaultSession, emptyMetrics, maskEmail, maskName, maskPhone, migrateSession } from './store-shared.js';

let driver = createFsDriver();
let index = { sessions: {} };
let metrics = { totals: emptyMetrics(), daily: {}, models: {} };
let auditEntries = [];
let lastAuditHash = 'GENESIS';
let loading = null;

function applyLoaded(data) {
  index = data.index || { sessions: {} };
  index.sessions ||= {};
  metrics = data.metrics || { totals: emptyMetrics(), daily: {}, models: {} };
  metrics.totals ||= emptyMetrics();
  metrics.daily ||= {};
  metrics.models ||= {};
  auditEntries = Array.isArray(data.audit) ? data.audit : [];
  lastAuditHash = auditEntries.at(-1)?.hash || 'GENESIS';
}

export function init() {
  ensureKey();
  driver = config.store === 'cloud' ? createCloudDriver() : createFsDriver();
  index = { sessions: {} };
  metrics = { totals: emptyMetrics(), daily: {}, models: {} };
  auditEntries = [];
  lastAuditHash = 'GENESIS';
  loading = null;

  if (driver.sync) {
    applyLoaded(driver.load());
  } else {
    loading = driver.load().then(applyLoaded);
    loading.catch((err) => {
      console.error(`[store] cloud load failed: ${err.message}`);
    });
  }
}

/** Resolves once the cloud driver has loaded Firestore/GCS state. */
export function ready() {
  return loading || Promise.resolve();
}

/** Waits for pending write-through operations (GCS/Firestore). */
export function flush() {
  return driver.flush();
}

export function dataPaths() {
  return driver.dataPaths();
}

export { defaultSession, maskEmail, maskName, maskPhone };

export function createSession(input) {
  const session = defaultSession(input);
  saveSession(session);
  recordSessionStart(session.id);
  appendAudit({
    type: 'session.created',
    actor: 'system',
    action: 'create',
    entity: 'session',
    entityId: session.id,
    payload: { status: session.status },
  });
  return session;
}

export function sessionPath(id) {
  if (!/^ses_[A-Za-z0-9_-]+$/.test(String(id))) throw new Error('Invalid session id');
  if (driver.kind === 'cloud') return `gs://${config.gcp.bucket}/sessions/${id}.enc`;
  return driver.sessionPath(id);
}

export function getSession(id) {
  let sealed;
  try {
    sealed = driver.readSession(id);
  } catch {
    return null;
  }
  if (!sealed) return null;
  try {
    return migrateSession(open(sealed));
  } catch {
    return null;
  }
}

export function saveSession(session) {
  session.updatedAt = new Date(Date.now() + (session.clockOffsetMs || 0)).toISOString();
  driver.writeSession(session.id, seal(session));
  const prev = index.sessions[session.id] || {};
  index.sessions[session.id] = {
    id: session.id,
    maskedName: maskName(session.name),
    maskedPhone: maskPhone(session.phoneE164),
    status: session.status,
    currentSectionId: session.currentSectionId,
    currentItemId: session.currentItemId,
    progress: session.progress,
    riskLevel: session.riskLevel,
    ownerEmail: session.ownerEmail || null,
    createdAt: prev.createdAt || session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt,
    costUsd: Number(session.budget?.spentUsd || 0),
  };
  driver.saveIndex(index);
  return session;
}

export function listSessions() {
  return Object.values(index.sessions).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function getIndexEntry(id) {
  return index.sessions[id] || null;
}

export function deleteSession(id) {
  driver.removeSession(id);
  delete index.sessions[id];
  driver.saveIndex(index);
  appendAudit({
    type: 'session.erased',
    actor: 'data-subject',
    action: 'erase',
    entity: 'session',
    entityId: id,
    payload: { tombstone: sha256(id) },
  });
}

export function appendAudit({ type, actor = 'system', action = '', entity = '', entityId = '', payload = {} }) {
  const core = {
    id: randomId('aud_', 8),
    at: new Date().toISOString(),
    type,
    actor,
    action,
    entity,
    entityId,
    payload,
    prevHash: lastAuditHash,
  };
  const entry = { ...core, hash: hashEntry(lastAuditHash, core) };
  auditEntries.push(entry);
  lastAuditHash = entry.hash;
  // `seq` is storage metadata only: never part of the hashed payload.
  driver.appendAudit({ ...entry, seq: auditEntries.length });
  return entry;
}

export function readAudit(limit = 200) {
  return auditEntries.slice(-Math.max(1, Number(limit) || 200));
}

export function verifyAudit() {
  let prev = 'GENESIS';
  for (let i = 0; i < auditEntries.length; i += 1) {
    const entry = auditEntries[i];
    if (!entry || typeof entry !== 'object') {
      return { valid: false, entries: auditEntries.length, brokenAt: i, reason: 'invalid-json' };
    }
    if (entry.prevHash !== prev) {
      return { valid: false, entries: auditEntries.length, brokenAt: i, reason: 'broken-chain' };
    }
    const { hash, seq, ...core } = entry;
    if (hashEntry(prev, core) !== hash) {
      return { valid: false, entries: auditEntries.length, brokenAt: i, reason: 'hash-mismatch' };
    }
    prev = hash;
  }
  return { valid: true, entries: auditEntries.length, head: prev };
}

export function recordSessionStart(id) {
  metrics.totals.sessionsStarted += 1;
  const day = today();
  metrics.daily[day] ||= emptyMetrics();
  metrics.daily[day].sessionsStarted += 1;
  metrics.lastSessionId = id;
  persistMetrics();
}

export function recordSessionCompleted() {
  metrics.totals.sessionsCompleted += 1;
  const day = today();
  metrics.daily[day] ||= emptyMetrics();
  metrics.daily[day].sessionsCompleted += 1;
  persistMetrics();
}

export function recordTurn({
  direction,
  model = 'deterministic',
  tokensIn = 0,
  tokensOut = 0,
  costUsd = 0,
  latencyMs = 0,
  fallback = false,
  audioMinutes = 0,
}) {
  const apply = (bucket) => {
    if (direction === 'in') bucket.messagesIn += 1;
    if (direction === 'out') bucket.messagesOut += 1;
    if (direction === 'llm') {
      bucket.llmCalls += 1;
      bucket.tokensIn += tokensIn;
      bucket.tokensOut += tokensOut;
      bucket.costUsd += costUsd;
      bucket.audioMinutes += audioMinutes;
      if (fallback) bucket.fallbacks += 1;
    }
  };
  apply(metrics.totals);
  const day = today();
  metrics.daily[day] ||= emptyMetrics();
  apply(metrics.daily[day]);
  if (direction === 'llm') {
    metrics.models[model] ||= { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0, fallbacks: 0 };
    const m = metrics.models[model];
    m.calls += 1;
    m.tokensIn += tokensIn;
    m.tokensOut += tokensOut;
    m.costUsd += costUsd;
    m.latencyMs += latencyMs;
    if (fallback) m.fallbacks += 1;
  }
  persistMetrics();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function persistMetrics() {
  driver.saveMetrics(metrics);
}

export function getMetrics() {
  return JSON.parse(JSON.stringify(metrics));
}

export function dailySpend() {
  return Number(metrics.daily[today()]?.costUsd || 0);
}

export function writeOutboxFile(name, contents) {
  return driver.saveOutbox(name, contents);
}

export function listOutbox() {
  return driver.listOutbox();
}

export function readOutboxFile(name) {
  return driver.readOutbox(name);
}

export function saveMedia(sessionId, fileId, ext, buffer) {
  return driver.saveMedia(sessionId, fileId, ext, buffer);
}

export function deleteMedia(sessionId) {
  return driver.removeMedia(sessionId);
}

export function retentionReport(now = Date.now()) {
  const report = {
    audio: { eligible: 0, retentionDays: config.retention.audioDays },
    messages: { eligible: 0, retentionMonths: config.retention.messagesMonths },
    answers: { eligible: 0, retentionMonths: config.retention.answersMonths },
    logs: { eligible: 0, retentionDays: config.retention.logsDays },
    audit: { retained: true, retentionYears: config.retention.auditYears },
    consents: { retained: true, retentionYears: config.retention.consentsYears },
  };
  const msgCutoff = now - config.retention.messagesMonths * 30 * 86_400_000;
  const ansCutoff = now - config.retention.answersMonths * 30 * 86_400_000;
  for (const id of Object.keys(index.sessions)) {
    const session = getSession(id);
    if (!session) continue;
    for (const m of session.messages || []) {
      if (m.direction === 'in' && m.type === 'audio' && Date.parse(m.createdAt) < now - config.retention.audioDays * 86_400_000) {
        report.audio.eligible += 1;
      }
      if (Date.parse(m.createdAt) < msgCutoff) report.messages.eligible += 1;
    }
    for (const item of Object.values(session.items || {})) {
      if (item.answeredAt && Date.parse(item.answeredAt) < ansCutoff) report.answers.eligible += 1;
    }
  }
  return report;
}

export function logSecurity(event) {
  appendAudit({
    type: 'security',
    actor: event.actor || 'anonymous',
    action: event.action || 'blocked',
    entity: 'request',
    entityId: event.entityId || '',
    payload: event.payload || {},
  });
}
