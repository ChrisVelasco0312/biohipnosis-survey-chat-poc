import { config } from './config.js';
import { normalizeForMatch } from './validators.js';

const ipBuckets = new Map();
const sessionBuckets = new Map();
const sessionHistory = new Map();
const cooldowns = new Map();
const adminAttempts = new Map();

function bucket(map, key, capacity, refillPerSec, now) {
  let b = map.get(key);
  if (!b) {
    b = { tokens: capacity, last: now, capacity, refillPerSec };
    map.set(key, b);
  }
  const elapsed = Math.max(0, now - b.last) / 1000;
  b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerSec);
  b.last = now;
  return b;
}

export function checkInbound({ sessionId, ip = 'local', text = '', now = Date.now() }) {
  if (!config.rate.enabled) return { allowed: true, reason: null, retryAfterMs: 0, hard: false };
  const cool = cooldowns.get(sessionId);
  if (cool && cool.until > now) {
    return {
      allowed: false,
      reason: cool.reason,
      retryAfterMs: cool.until - now,
      hard: cool.hard,
    };
  }

  const ipB = bucket(ipBuckets, ip, config.rate.ipCapacity, config.rate.ipRefillPerSec, now);
  if (ipB.tokens < 1) {
    return { allowed: false, reason: 'ip-rate-limit', retryAfterMs: 1000, hard: false };
  }

  const sB = bucket(
    sessionBuckets,
    sessionId,
    config.rate.sessionCapacity,
    config.rate.sessionRefillPerSec,
    now,
  );
  if (sB.tokens < 1) {
    cooldowns.set(sessionId, {
      until: now + config.rate.softCooldownMs,
      reason: 'session-rate-limit',
      hard: false,
    });
    return { allowed: false, reason: 'session-rate-limit', retryAfterMs: config.rate.softCooldownMs, hard: false };
  }

  let history = sessionHistory.get(sessionId);
  if (!history) {
    history = { hourly: [], daily: [], recent: [] };
    sessionHistory.set(sessionId, history);
  }
  history.hourly = history.hourly.filter((t) => now - t < 3_600_000);
  history.daily = history.daily.filter((t) => now - t < 86_400_000);
  if (history.hourly.length >= config.rate.sessionHourly) {
    cooldowns.set(sessionId, {
      until: now + config.rate.hardCooldownMs,
      reason: 'hourly-message-cap',
      hard: true,
    });
    return { allowed: false, reason: 'hourly-message-cap', retryAfterMs: config.rate.hardCooldownMs, hard: true };
  }
  if (history.daily.length >= config.rate.sessionDaily) {
    cooldowns.set(sessionId, {
      until: now + config.rate.hardCooldownMs,
      reason: 'daily-message-cap',
      hard: true,
    });
    return { allowed: false, reason: 'daily-message-cap', retryAfterMs: config.rate.hardCooldownMs, hard: true };
  }

  const norm = normalizeForMatch(text).slice(0, 200);
  history.recent = history.recent.filter((r) => now - r.at < config.rate.duplicateWindowMs);
  const duplicates = history.recent.filter((r) => r.text === norm).length + 1;
  if (norm.length > 1 && duplicates >= config.rate.duplicateLimit) {
    cooldowns.set(sessionId, {
      until: now + config.rate.softCooldownMs,
      reason: 'duplicate-spam',
      hard: false,
    });
    return { allowed: false, reason: 'duplicate-spam', retryAfterMs: config.rate.softCooldownMs, hard: false };
  }

  ipB.tokens -= 1;
  sB.tokens -= 1;
  history.recent.push({ text: norm, at: now });
  history.hourly.push(now);
  history.daily.push(now);
  return { allowed: true, reason: null, retryAfterMs: 0, hard: false };
}

export function noteBlockedCooldown(sessionId, now = Date.now()) {
  cooldowns.set(sessionId, {
    until: now + config.rate.softCooldownMs,
    reason: 'blocked-content',
    hard: false,
  });
}

export function getSessionState(sessionId, now = Date.now()) {
  const b = sessionBuckets.get(sessionId);
  const h = sessionHistory.get(sessionId);
  return {
    tokens: b ? Number(b.tokens.toFixed(2)) : config.rate.sessionCapacity,
    hourly: h ? h.hourly.filter((t) => now - t < 3_600_000).length : 0,
    daily: h ? h.daily.filter((t) => now - t < 86_400_000).length : 0,
    cooldownUntil: cooldowns.get(sessionId)?.until || null,
  };
}

export function checkAdmin(ip = 'local', now = Date.now()) {
  const rec = adminAttempts.get(ip);
  if (rec?.lockedUntil && rec.lockedUntil > now) {
    return { allowed: false, retryAfterMs: rec.lockedUntil - now };
  }
  return { allowed: true, retryAfterMs: 0 };
}

export function recordAdminFailure(ip = 'local', now = Date.now()) {
  const rec = adminAttempts.get(ip) || { failures: [], lockedUntil: 0 };
  rec.failures = rec.failures.filter((t) => now - t < config.rate.adminWindowMs);
  rec.failures.push(now);
  if (rec.failures.length >= config.rate.adminAttempts) {
    rec.lockedUntil = now + config.rate.adminLockMs;
    rec.failures = [];
  }
  adminAttempts.set(ip, rec);
  return { locked: rec.lockedUntil > now, retryAfterMs: Math.max(0, rec.lockedUntil - now) };
}

export function recordAdminSuccess(ip = 'local') {
  adminAttempts.delete(ip);
}

let activeLlm = 0;
const waiters = [];

export function llmQueueDepth() {
  return { active: activeLlm, waiting: waiters.length, max: config.llm.maxConcurrent };
}

export function acquireLlmSlot(waitMs = config.llm.queueWaitMs) {
  if (activeLlm < config.llm.maxConcurrent) {
    activeLlm += 1;
    return Promise.resolve(release);
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      const idx = waiters.indexOf(waiter);
      if (idx >= 0) waiters.splice(idx, 1);
      reject(Object.assign(new Error('LLM queue timeout'), { code: 'queue_timeout' }));
    }, waitMs);
    waiters.push(waiter);
  });
}

let release = () => {
  activeLlm = Math.max(0, activeLlm - 1);
  const next = waiters.shift();
  if (next) {
    clearTimeout(next.timer);
    activeLlm += 1;
    next.resolve(release);
  }
};

export function reset() {
  ipBuckets.clear();
  sessionBuckets.clear();
  sessionHistory.clear();
  cooldowns.clear();
  adminAttempts.clear();
  activeLlm = 0;
  waiters.splice(0).forEach((w) => {
    clearTimeout(w.timer);
    w.reject(Object.assign(new Error('Rate limiter reset'), { code: 'reset' }));
  });
}
