/* Pure session/metrics helpers shared by the filesystem and cloud drivers.
   Keeping them here avoids a circular import between store.js and the drivers. */
import { config } from './config.js';
import { totalItems } from './catalog.js';
import { randomId } from './crypto.js';

export function emptyMetrics() {
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
    ownerUid: null,
    ownerEmail: null,
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

export function migrateSession(session) {
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
