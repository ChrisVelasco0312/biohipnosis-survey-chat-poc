import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { totalItems } from './catalog.js';
import { ensureKey, hashEntry, open, randomId, seal, sha256, stableStringify } from './crypto.js';

const paths = {
  sessions: path.join(config.dataDir, 'sessions'),
  media: path.join(config.dataDir, 'media'),
  outbox: path.join(config.dataDir, 'outbox'),
  index: path.join(config.dataDir, 'index.json'),
  audit: path.join(config.dataDir, 'audit.jsonl'),
  metrics: path.join(config.dataDir, 'metrics.json'),
  retention: path.join(config.dataDir, 'retention.json'),
};

let index = { sessions: {} };
let lastAuditHash = 'GENESIS';
let metrics = { totals: emptyMetrics(), daily: {}, models: {} };

function emptyMetrics() {
  return {
    sessionsStarted: 0,
    sessionsCompleted: 0,
    messagesIn: 0,
    messagesOut: 0,
    llmCalls: 0,
    fallbacks: 0,
    tokensIn: 0,
    tokensOut: 0,
    audioMinutes: 0,
    costUsd: 0,
  };
}

function atomicWrite(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function init() {
  ensureKey();
  for (const dir of [config.dataDir, paths.sessions, paths.media, paths.outbox]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Best effort on non-POSIX filesystems.
    }
  }
  index = loadJson(paths.index, { sessions: {} });
  index.sessions ||= {};
  metrics = loadJson(paths.metrics, { totals: emptyMetrics(), daily: {}, models: {} });
  metrics.totals ||= emptyMetrics();
  metrics.daily ||= {};
  metrics.models ||= {};

  if (fs.existsSync(paths.audit)) {
    const lines = fs.readFileSync(paths.audit, 'utf8').trim().split('\n').filter(Boolean);
    const last = lines.at(-1);
    if (last) {
      try {
        lastAuditHash = JSON.parse(last).hash || 'GENESIS';
      } catch {
        lastAuditHash = 'GENESIS';
      }
    }
  }
}

export function dataPaths() {
  return { ...paths };
}

export function maskPhone(phone) {
  if (!phone) return '—';
  const digits = String(phone).replace(/[^\d+]/g, '');
  if (digits.length <= 4) return '••••';
  return `${digits.slice(0, 3)}•••••${digits.slice(-3)}`;
}

export function maskName(name) {
  if (!name) return 'Sin nombre';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return `${parts[0].slice(0, 2)}•••`;
  return `${parts[0]} ${parts[1][0]}.`;
}

export function maskEmail(email) {
  if (!email || !email.includes('@')) return '—';
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}•••@${domain}`;
}

export function defaultSession({ name, phoneE164 }) {
  const now = new Date().toISOString();
  return {
    id: randomId('ses_', 12),
    waId: randomId('wa_', 12),
    clientToken: randomId('ct_', 24),
    name: String(name || 'Consultante').trim().slice(0, 120),
    phoneE164: phoneE164 || '',
    locale: 'es-CO',
    status: 'NEW',
    surveyVersion: 'poc-1.0',
    currentSectionId: null,
    currentItemId: null,
    q21Step: 0,
    q21Steps: [],
    createdAt: now,
    updatedAt: now,
    lastInboundAt: null,
    lastOutboundAt: null,
    csWindowExpiresAt: null,
    clockOffsetMs: 0,
    ageConfirmed: false,
    consent: null,
    items: {},
    messages: [],
    events: [],
    riskLevel: 'none',
    escalations: [],
    pendingConfirmation: null,
    sectionReview: null,
    pendingCorrection: null,
    correctionReturn: null,
    summary: null,
    destinationEmail: null,
    completedAt: null,
    lastTemplateAt: null,
    reminderSent: false,
    progress: { answered: 0, partial: 0, total: totalItems() },
    budget: {
      limitUsd: config.limits.sessionBudgetUsd,
      spentUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      audioMinutes: 0,
      exhausted: false,
      warned: false,
    },
    counters: { turns: 0, clarifications: 0, reminders: 0, blocked: 0, corrections: 0, spam: 0 },
    flags: { forceLlmFailure: false, forceBadJson: false },
    lastError: null,
    meta: {},
  };
}

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
  return path.join(paths.sessions, `${id}.enc`);
}

export function getSession(id) {
  const file = sessionPath(id);
  if (!fs.existsSync(file)) return null;
  const session = open(fs.readFileSync(file, 'utf8'));
  return migrateSession(session);
}

function migrateSession(session) {
  const base = defaultSession({ name: session.name, phoneE164: session.phoneE164 });
  const merged = { ...base, ...session };
  merged.budget = { ...base.budget, ...(session.budget || {}) };
  merged.counters = { ...base.counters, ...(session.counters || {}) };
  merged.flags = { ...base.flags, ...(session.flags || {}) };
  merged.progress = { ...base.progress, ...(session.progress || {}) };
  merged.meta = { ...(session.meta || {}) };
  merged.items ||= {};
  merged.messages ||= [];
  merged.events ||= [];
  return merged;
}

export function saveSession(session) {
  session.updatedAt = new Date(Date.now() + (session.clockOffsetMs || 0)).toISOString();
  atomicWrite(sessionPath(session.id), seal(session));
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
    createdAt: prev.createdAt || session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt,
    costUsd: Number(session.budget?.spentUsd || 0),
  };
  atomicWrite(paths.index, JSON.stringify(index, null, 2));
  return session;
}

export function listSessions() {
  return Object.values(index.sessions).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function getIndexEntry(id) {
  return index.sessions[id] || null;
}

export function deleteSession(id) {
  const file = sessionPath(id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  delete index.sessions[id];
  atomicWrite(paths.index, JSON.stringify(index, null, 2));
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
  fs.appendFileSync(paths.audit, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  lastAuditHash = entry.hash;
  return entry;
}

export function readAudit(limit = 200) {
  if (!fs.existsSync(paths.audit)) return [];
  const lines = fs.readFileSync(paths.audit, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { type: 'audit.corrupt', raw: line.slice(0, 200) };
    }
  });
}

export function verifyAudit() {
  if (!fs.existsSync(paths.audit)) return { valid: true, entries: 0 };
  const lines = fs.readFileSync(paths.audit, 'utf8').trim().split('\n').filter(Boolean);
  let prev = 'GENESIS';
  for (let i = 0; i < lines.length; i += 1) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return { valid: false, entries: lines.length, brokenAt: i, reason: 'invalid-json' };
    }
    if (entry.prevHash !== prev) {
      return { valid: false, entries: lines.length, brokenAt: i, reason: 'broken-chain' };
    }
    const { hash, ...core } = entry;
    if (hashEntry(prev, core) !== hash) {
      return { valid: false, entries: lines.length, brokenAt: i, reason: 'hash-mismatch' };
    }
    prev = hash;
  }
  return { valid: true, entries: lines.length, head: prev };
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
  atomicWrite(paths.metrics, JSON.stringify(metrics, null, 2));
}

export function getMetrics() {
  return JSON.parse(JSON.stringify(metrics));
}

export function dailySpend() {
  return Number(metrics.daily[today()]?.costUsd || 0);
}

export function writeOutboxFile(name, contents) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Invalid outbox filename');
  const file = path.join(paths.outbox, name);
  atomicWrite(file, contents);
  return file;
}

export function listOutbox() {
  if (!fs.existsSync(paths.outbox)) return [];
  return fs
    .readdirSync(paths.outbox)
    .filter((name) => /^[A-Za-z0-9._-]+$/.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(paths.outbox, name));
      return { name, bytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function readOutboxFile(name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Invalid outbox filename');
  const file = path.join(paths.outbox, name);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
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
