import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, publicConfig } from './config.js';
import { catalogSummary } from './catalog.js';
import {
  adminEditAnswer,
  adminForceReminder,
  adminHandoff,
  adminMessage,
  adminPause,
  adminResume,
  adminTimeTravel,
  beginTestSession,
  createSessionReply,
  handleInbound,
  inspectorSession,
  isFinal,
  publicSession,
  sessionEraseOnReply,
} from './engine.js';
import { createSession, deleteSession, flush as flushStore, getMetrics, getSession, init as initStore, listSessions, readAudit, ready as storeReady, retentionReport, saveSession, verifyAudit } from './store.js';
import { createTestSession, deleteTestSession, getTestSession } from './sandbox.js';
import { SECTIONS, sectionItems } from './catalog.js';
import { appendAudit, dailySpend, listOutbox, logSecurity, readOutboxFile } from './store.js';
import { validateEmail, validatePhone, detectCrisis } from './validators.js';
import { checkAdmin, checkInbound, getSessionState, llmQueueDepth, recordAdminFailure, recordAdminSuccess } from './ratelimit.js';
import { clearCooldowns, getStatus } from './llm.js';
import { createSimulatedEmail, exportHtml, exportJson } from './export.js';
import { removeSessionMedia } from './media.js';
import { runSecuritySuite } from './securitySuite.js';
import { randomId, timingSafeEqual } from './crypto.js';
import { authStatus, initAuth, verifyRequest } from './auth.js';
import { expiryWarning, getKey, initKeyManager, keyInfo, keyReady, markInvalid, markValid, setKey, validateKey } from './keyManager.js';
import { notificationsEnabled, requestKeyRenewal } from './notify.js';

const startedAt = Date.now();
const locks = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
      "script-src 'self' https://www.gstatic.com https://apis.google.com; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "img-src 'self' data: https://*.googleusercontent.com; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com; " +
      "frame-src 'self' https://accounts.google.com https://biohipnosis-poc-2026.firebaseapp.com; " +
      "media-src 'self' blob:; object-src 'none'; base-uri 'self'; " +
      "form-action 'self'; frame-ancestors 'none'",
  );
}

function sendJson(res, status, payload, extra = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(body);
}

function sendError(res, status, code, message, extra = {}) {
  sendJson(res, status, { error: code, message, requestId: randomId('req_', 5) }, extra);
}

function requestHost(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = requestHost(req);
  const allowed = [`http://${host}`, `https://${host}`];
  if (config.publicOrigin) allowed.push(config.publicOrigin);
  return allowed.includes(origin);
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return forwarded || req.socket.remoteAddress || 'local';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
      req.destroy();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const type = String(req.headers['content-type'] || '');
  if (!type.includes('application/json')) {
    throw Object.assign(new Error('Content-Type debe ser application/json'), { statusCode: 415 });
  }
  const body = await readBody(req, config.limits.bodyLimitBytes);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON inválido'), { statusCode: 400 });
  }
}

function adminToken(req, url) {
  return req.headers['x-admin-token'] || url.searchParams.get('token') || '';
}

function requireAdmin(req, res, url) {
  if (config.auth.mode === 'on') {
    if (req.user?.isAdmin) return true;
    sendError(res, 403, 'forbidden', 'Solo el propietario puede acceder a esta consola.');
    return false;
  }
  const ip = clientIp(req);
  const gate = checkAdmin(ip, Date.now());
  if (!gate.allowed) {
    sendError(res, 429, 'admin_locked', 'Demasiados intentos. Espera antes de volver a intentar.', {
      'Retry-After': Math.ceil(gate.retryAfterMs / 1000),
    });
    return false;
  }
  const token = adminToken(req, url);
  if (!timingSafeEqual(token, config.adminToken)) {
    const fail = recordAdminFailure(ip, Date.now());
    logSecurity({ actor: 'anonymous', action: 'admin_auth_failed', entityId: ip, payload: { locked: fail.locked } });
    if (fail.locked) {
      sendError(res, 429, 'admin_locked', 'Token bloqueado temporalmente por intentos fallidos.', {
        'Retry-After': Math.ceil(fail.retryAfterMs / 1000),
      });
    } else {
      sendError(res, 401, 'unauthorized', 'Token de administración inválido.');
    }
    return false;
  }
  recordAdminSuccess(ip);
  return true;
}

function requireSession(req, res, sessionId) {
  const token = req.headers['x-session-token'] || '';
  const session = getSession(sessionId);
  if (!session) {
    sendError(res, 404, 'not_found', 'Sesión no encontrada.');
    return null;
  }
  if (
    config.auth.mode === 'on' &&
    session.ownerUid &&
    req.user &&
    !req.user.isAdmin &&
    session.ownerUid !== req.user.uid
  ) {
    sendError(res, 403, 'forbidden', 'Esta sesión pertenece a otra cuenta.');
    return null;
  }
  if (!timingSafeEqual(token, session.clientToken)) {
    sendError(res, 401, 'unauthorized', 'Token de sesión inválido.');
    return null;
  }
  return session;
}

function requireTestSession(req, res, sessionId) {
  const token = req.headers['x-session-token'] || '';
  const session = getTestSession(sessionId);
  if (!session) {
    sendError(res, 404, 'not_found', 'Sesión de prueba no encontrada o expirada.');
    return null;
  }
  if (!timingSafeEqual(token, session.clientToken)) {
    sendError(res, 401, 'unauthorized', 'Token de sesión inválido.');
    return null;
  }
  return session;
}

function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const job = prev.then(fn, fn);
  locks.set(key, job.catch(() => {}));
  return job;
}

function safeName(value) {
  return String(value || '').replace(/[\u0000-\u001f<>]/g, '').trim();
}

async function api(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  const ip = clientIp(req);

  // Only the health probe and the public config are reachable without a
  // Firebase session. Everything else runs with req.user set.
  const isPublic = method === 'GET' && (pathname === '/api/health' || pathname === '/api/config');
  if (!isPublic) {
    req.user = await verifyRequest(req);
  }

  if (method === 'GET' && pathname === '/api/health') {
    const llm = getStatus();
    sendJson(res, 200, {
      ok: true,
      version: config.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      llm,
      queue: llmQueueDepth(),
      adminTokenDefault: config.adminTokenIsDefault,
      authMode: config.auth.mode,
      surveyVersion: catalogSummary().version,
      totalItems: catalogSummary().total,
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/config') {
    sendJson(res, 200, { ...publicConfig(), catalog: catalogSummary() });
    return;
  }

  if (method === 'GET' && pathname === '/api/me') {
    sendJson(res, 200, {
      uid: req.user.uid,
      email: req.user.email,
      name: req.user.name,
      picture: req.user.picture,
      isAdmin: !!req.user.isAdmin,
      dev: !!req.user.dev,
      authMode: config.auth.mode,
      notificationsEnabled: notificationsEnabled(),
      key: keyInfo(),
      keyWarning: expiryWarning(),
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/key/request') {
    const body = await readJson(req);
    const result = await requestKeyRenewal({
      user: req.user,
      reason: String(body.reason || keyInfo().state || 'key_invalid').slice(0, 120),
    });
    appendAudit({
      type: 'key.renewal_requested',
      actor: req.user.email,
      action: 'request',
      entity: 'llm',
      entityId: 'opencode',
      payload: { sent: !!result.sent, reason: result.reason || 'requested' },
    });
    sendJson(res, result.sent ? 202 : 200, result);
    return;
  }

  if (method === 'POST' && pathname === '/api/admin/login') {
    const body = await readJson(req);
    const gate = checkAdmin(ip, Date.now());
    if (!gate.allowed) {
      sendError(res, 429, 'admin_locked', 'Espera antes de intentar de nuevo.', {
        'Retry-After': Math.ceil(gate.retryAfterMs / 1000),
      });
      return;
    }
    if (!timingSafeEqual(body.token, config.adminToken)) {
      const fail = recordAdminFailure(ip, Date.now());
      logSecurity({ actor: 'anonymous', action: 'admin_login_failed', entityId: ip, payload: { locked: fail.locked } });
      sendError(res, fail.locked ? 429 : 401, fail.locked ? 'admin_locked' : 'unauthorized', 'Token inválido.');
      return;
    }
    recordAdminSuccess(ip);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'POST' && pathname === '/api/sessions') {
    const body = await readJson(req);
    if (listSessions().length >= config.maxSessions) {
      sendError(res, 429, 'session_limit', 'Se alcanzó el límite de sesiones de la POC.');
      return;
    }
    const name = safeName(body.name) || 'Consultante';
    if (name.length < 2 || name.length > 120) {
      sendError(res, 400, 'invalid_name', 'El nombre debe tener entre 2 y 120 caracteres.');
      return;
    }
    let phone = '';
    if (body.phone) {
      const p = validatePhone(body.phone);
      if (!p.ok) {
        sendError(res, 400, 'invalid_phone', p.issue);
        return;
      }
      phone = p.normalized;
    }
    const session = createSession({ name, phoneE164: phone });
    session.ownerUid = req.user.uid;
    session.ownerEmail = req.user.email;
    createSessionReply(session);
    saveSession(session);
    appendAudit({
      type: 'session.started',
      actor: 'data-subject',
      action: 'start',
      entity: 'session',
      entityId: session.id,
      payload: { channel: 'poc-chat' },
    });
    sendJson(res, 201, {
      session: publicSession(session, { reveal: true }),
      token: session.clientToken,
    });
    return;
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (method === 'GET' && sessionMatch) {
    const session = requireSession(req, res, sessionMatch[1]);
    if (!session) return;
    sendJson(res, 200, { session: publicSession(session, { reveal: true }) });
    return;
  }

  const messageMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (method === 'POST' && messageMatch) {
    const sessionId = messageMatch[1];
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text : '';
    if (text.length > config.limits.maxInputChars) {
      logSecurity({ actor: 'data-subject', action: 'input_too_large', entityId: sessionId, payload: { length: text.length } });
      sendError(res, 413, 'input_too_large', `El mensaje supera ${config.limits.maxInputChars} caracteres.`);
      return;
    }
    const gate = checkInbound({ sessionId, ip, text, now: Date.now() });
    if (!gate.allowed) {
      logSecurity({ actor: 'data-subject', action: 'rate_limited', entityId: sessionId, payload: { reason: gate.reason } });
      sendError(res, 429, 'rate_limited', 'Espera un momento antes de enviar otro mensaje.', {
        'Retry-After': Math.ceil(gate.retryAfterMs / 1000),
        'X-RateLimit-Reason': gate.reason,
      });
      return;
    }
    if (!requireSession(req, res, sessionId)) return;
    const input = {
      text,
      buttonId: typeof body.buttonId === 'string' ? body.buttonId.slice(0, 40) : undefined,
      waMessageId: typeof body.waMessageId === 'string' ? body.waMessageId.slice(0, 120) : undefined,
      attachment: body.attachment || undefined,
      voice: body.voice || undefined,
    };
    const result = await withLock(sessionId, async () => {
      const session = getSession(sessionId);
      if (!session) {
        sendError(res, 404, 'not_found', 'Sesión no encontrada.');
        return null;
      }
      const outcome = await handleInbound(session, input, { ip, actor: 'data-subject', origin: 'chat' });
      const erase = outcome.erase || sessionEraseOnReply(outcome.session) || outcome.session.status === 'ERASED';
      if (erase) {
        const snapshot = publicSession(outcome.session, { reveal: true });
        saveSession(outcome.session);
        deleteSession(sessionId);
        removeSessionMedia(sessionId);
        appendAudit({
          type: 'session.erased',
          actor: 'data-subject',
          action: 'erase',
          entity: 'session',
          entityId: sessionId,
          payload: { reason: 'requested_or_consent' },
        });
        return { session: snapshot, erased: true, duplicate: !!outcome.duplicate };
      }
      saveSession(outcome.session);
      return { session: publicSession(outcome.session, { reveal: true }), erased: false, duplicate: !!outcome.duplicate };
    });
    if (!result) return;
    sendJson(res, 200, result);
    return;
  }

  // Free question sandbox. Sessions live only in memory and are never saved.
  if (method === 'GET' && pathname === '/api/sandbox/catalog') {
    sendJson(res, 200, {
      sections: SECTIONS.map((section) => ({
        id: section.id,
        name: section.name,
        short: section.short,
        items: sectionItems(section.id).map((item) => ({
          id: item.id,
          label: item.label,
          type: item.type,
          critical: !!item.critical,
        })),
      })),
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/sandbox/sessions') {
    const body = await readJson(req);
    const session = createTestSession({
      itemId: typeof body.itemId === 'string' ? body.itemId : undefined,
      sectionId: typeof body.sectionId === 'string' ? body.sectionId : undefined,
      name: typeof body.name === 'string' ? body.name.slice(0, 120) : undefined,
    });
    if (!session) {
      sendError(res, 400, 'invalid_target', 'La pregunta o sección solicitada no existe.');
      return;
    }
    beginTestSession(session);
    sendJson(res, 201, {
      session: publicSession(session, { reveal: true }),
      token: session.clientToken,
    });
    return;
  }

  const testSessionMatch = pathname.match(/^\/api\/sandbox\/sessions\/([^/]+)$/);
  if (testSessionMatch && (method === 'GET' || method === 'DELETE')) {
    const session = requireTestSession(req, res, testSessionMatch[1]);
    if (!session) return;
    if (method === 'DELETE') {
      deleteTestSession(session.id);
      sendJson(res, 200, { ok: true, deleted: true });
      return;
    }
    sendJson(res, 200, { session: publicSession(session, { reveal: true }) });
    return;
  }

  const testResetMatch = pathname.match(/^\/api\/sandbox\/sessions\/([^/]+)\/reset$/);
  if (method === 'POST' && testResetMatch) {
    const session = requireTestSession(req, res, testResetMatch[1]);
    if (!session) return;
    const body = await readJson(req);
    beginTestSession(session, {
      reset: true,
      itemId: typeof body.itemId === 'string' ? body.itemId : undefined,
      sectionId: typeof body.sectionId === 'string' ? body.sectionId : undefined,
    });
    sendJson(res, 200, { session: publicSession(session, { reveal: true }), reset: true });
    return;
  }

  const testMessageMatch = pathname.match(/^\/api\/sandbox\/sessions\/([^/]+)\/messages$/);
  if (method === 'POST' && testMessageMatch) {
    const sessionId = testMessageMatch[1];
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text : '';
    if (text.length > config.limits.maxInputChars) {
      sendError(res, 413, 'input_too_large', `El mensaje supera ${config.limits.maxInputChars} caracteres.`);
      return;
    }
    if (!requireTestSession(req, res, sessionId)) return;
    const input = {
      text,
      buttonId: typeof body.buttonId === 'string' ? body.buttonId.slice(0, 40) : undefined,
      waMessageId: typeof body.waMessageId === 'string' ? body.waMessageId.slice(0, 120) : undefined,
      attachment: body.attachment || undefined,
      voice: body.voice || undefined,
    };
    const result = await withLock(sessionId, async () => {
      const session = getTestSession(sessionId);
      if (!session) {
        sendError(res, 404, 'not_found', 'Sesión de prueba no encontrada o expirada.');
        return null;
      }
      const outcome = await handleInbound(session, input, { ip, actor: 'tester', origin: 'sandbox' });
      const erased = outcome.erase || sessionEraseOnReply(outcome.session) || outcome.session.status === 'ERASED';
      const snapshot = publicSession(outcome.session, { reveal: true });
      if (erased) deleteTestSession(sessionId);
      return { session: snapshot, erased, duplicate: !!outcome.duplicate };
    });
    if (!result) return;
    sendJson(res, 200, result);
    return;
  }

  // Admin routes
  if (pathname.startsWith('/api/admin/')) {
    if (!requireAdmin(req, res, url)) return;

    if (method === 'GET' && pathname === '/api/admin/key') {
      sendJson(res, 200, {
        key: keyInfo(),
        warning: expiryWarning(),
        notificationsEnabled: notificationsEnabled(),
        modelsUrl: config.llm.modelsUrl,
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/admin/key') {
      const body = await readJson(req);
      try {
        const result = await setKey(body.key, {
          expiresAt: body.expiresAt || null,
          actor: req.user?.email || 'owner',
        });
        appendAudit({
          type: 'key.rotated',
          actor: req.user?.email || 'owner',
          action: 'rotate',
          entity: 'llm',
          entityId: 'opencode',
          payload: { fingerprint: result.fingerprint, expiresAt: result.expiresAt, version: result.versionName },
        });
        sendJson(res, 200, { ok: true, key: result });
      } catch (err) {
        appendAudit({
          type: 'key.rotation_failed',
          actor: req.user?.email || 'owner',
          action: 'rotate',
          entity: 'llm',
          entityId: 'opencode',
          payload: { error: String(err.message).slice(0, 200) },
        });
        sendError(res, err.statusCode || 400, err.code || 'invalid_key', err.message);
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/admin/key/test') {
      try {
        const key = await getKey();
        const models = await validateKey(key);
        markValid();
        sendJson(res, 200, {
          ok: true,
          key: keyInfo(),
          models: Array.isArray(models?.data) ? models.data.length : null,
        });
      } catch (err) {
        markInvalid(err.message);
        sendError(res, err.statusCode || 502, err.code || 'key_invalid', err.message);
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/admin/sessions') {
      sendJson(res, 200, {
        sessions: listSessions(),
        llm: getStatus(),
        queue: llmQueueDepth(),
        dailySpendUsd: dailySpend(),
        dailyBudgetUsd: config.limits.dailyBudgetUsd,
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/admin/security/run') {
      const report = runSecuritySuite();
      appendAudit({
        type: 'security.suite',
        actor: 'practitioner',
        action: 'run',
        entity: 'system',
        entityId: 'security-suite',
        payload: { passed: report.passed, failed: report.failed },
      });
      sendJson(res, 200, report);
      return;
    }

    if (method === 'GET' && pathname === '/api/admin/metrics') {
      const metrics = getMetrics();
      sendJson(res, 200, {
        ...metrics,
        dailySpendUsd: dailySpend(),
        dailyBudgetUsd: config.limits.dailyBudgetUsd,
        queue: llmQueueDepth(),
        sessions: listSessions().length,
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/admin/audit') {
      sendJson(res, 200, { entries: readAudit(400), verification: verifyAudit() });
      return;
    }

    if (method === 'GET' && pathname === '/api/admin/outbox') {
      sendJson(res, 200, { files: listOutbox() });
      return;
    }

    const outboxMatch = pathname.match(/^\/api\/admin\/outbox\/([A-Za-z0-9._-]+)$/);
    if (method === 'GET' && outboxMatch) {
      const contents = readOutboxFile(outboxMatch[1]);
      if (contents === null) {
        sendError(res, 404, 'not_found', 'Archivo no encontrado.');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Disposition': `inline; filename="${outboxMatch[1]}"`,
      });
      res.end(contents);
      return;
    }

    if (method === 'GET' && pathname === '/api/admin/retention') {
      sendJson(res, 200, retentionReport());
      return;
    }

    if (method === 'POST' && pathname === '/api/admin/llm/reset') {
      clearCooldowns();
      appendAudit({
        type: 'llm.cooldown_reset',
        actor: 'practitioner',
        action: 'reset',
        entity: 'llm',
        entityId: 'provider',
        payload: {},
      });
      sendJson(res, 200, { ok: true, llm: getStatus() });
      return;
    }

    const adminSessionMatch = pathname.match(/^\/api\/admin\/sessions\/([^/]+)$/);
    if (adminSessionMatch) {
      const sessionId = adminSessionMatch[1];
      const session = getSession(sessionId);
      if (!session) {
        sendError(res, 404, 'not_found', 'Sesión no encontrada.');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, {
          session: inspectorSession(session, { reveal: false }),
          audit: readAudit(500).filter((e) => e.entityId === sessionId),
          rate: getSessionState(sessionId),
        });
        return;
      }
      if (method === 'DELETE') {
        const snapshot = { id: session.id, masked: true };
        deleteSession(sessionId);
        removeSessionMedia(sessionId);
        appendAudit({
          type: 'session.erased',
          actor: 'practitioner',
          action: 'erase',
          entity: 'session',
          entityId: sessionId,
          payload: { ...snapshot, reason: 'admin_delete' },
        });
        sendJson(res, 200, { ok: true, erased: true });
        return;
      }
      sendError(res, 405, 'method_not_allowed', 'Método no permitido.');
      return;
    }

    const revealMatch = pathname.match(/^\/api\/admin\/sessions\/([^/]+)\/reveal$/);
    if (method === 'POST' && revealMatch) {
      const session = getSession(revealMatch[1]);
      if (!session) {
        sendError(res, 404, 'not_found', 'Sesión no encontrada.');
        return;
      }
      appendAudit({
        type: 'pii.revealed',
        actor: 'practitioner',
        action: 'reveal',
        entity: 'session',
        entityId: session.id,
        payload: { scope: 'session_detail' },
      });
      sendJson(res, 200, { session: inspectorSession(session, { reveal: true }) });
      return;
    }

    const flagsMatch = pathname.match(/^\/api\/admin\/sessions\/([^/]+)\/flags$/);
    if (method === 'PATCH' && flagsMatch) {
      const body = await readJson(req);
      const session = getSession(flagsMatch[1]);
      if (!session) {
        sendError(res, 404, 'not_found', 'Sesión no encontrada.');
        return;
      }
      if (body.forceLlmFailure !== undefined) session.flags.forceLlmFailure = !!body.forceLlmFailure;
      if (body.forceBadJson !== undefined) session.flags.forceBadJson = !!body.forceBadJson;
      saveSession(session);
      appendAudit({
        type: 'session.flags',
        actor: 'practitioner',
        action: 'update',
        entity: 'session',
        entityId: session.id,
        payload: { ...session.flags },
      });
      sendJson(res, 200, { ok: true, session: inspectorSession(getSession(session.id), { reveal: false }) });
      return;
    }

    const answerMatch = pathname.match(/^\/api\/admin\/sessions\/([^/]+)\/answers\/([A-Za-z0-9]+)$/);
    if (method === 'PATCH' && answerMatch) {
      const body = await readJson(req);
      const session = getSession(answerMatch[1]);
      if (!session) {
        sendError(res, 404, 'not_found', 'Sesión no encontrada.');
        return;
      }
      const result = adminEditAnswer(session, answerMatch[2].toUpperCase(), String(body.value || ''), 'practitioner');
      if (!result.ok) {
        sendError(res, 400, 'invalid_answer', result.issue);
        return;
      }
      sendJson(res, 200, { ok: true, session: inspectorSession(getSession(session.id), { reveal: true }) });
      return;
    }

    const adminMessageMatch = pathname.match(/^\/api\/admin\/sessions\/([^/]+)\/messages$/);
    if (method === 'POST' && adminMessageMatch) {
      const body = await readJson(req);
      const text = String(body.text || '').slice(0, config.limits.maxOutboundChars);
      if (!text.trim()) {
        sendError(res, 400, 'empty_message', 'El mensaje está vacío.');
        return;
      }
      const session = getSession(adminMessageMatch[1]);
      if (!session) {
        sendError(res, 404, 'not_found', 'Sesión no encontrada.');
        return;
      }
      const result = adminMessage(session, text, 'practitioner');
      if (!result.ok) {
        sendError(res, 400, 'unsafe_message', 'El mensaje contiene contenido no permitido.', { issues: result.issues });
        return;
      }
      sendJson(res, 200, { ok: true, session: inspectorSession(getSession(session.id), { reveal: true }) });
      return;
    }

    const actionMatch = pathname.match(/^\/api\/admin\/sessions\/([^/]+)\/actions$/);
    if (method === 'POST' && actionMatch) {
      const body = await readJson(req);
      const session = getSession(actionMatch[1]);
      if (!session) {
        sendError(res, 404, 'not_found', 'Sesión no encontrada.');
        return;
      }
      if (isFinal(session) && !['handoff'].includes(body.action)) {
        sendError(res, 409, 'final_state', 'La sesión ya está cerrada.');
        return;
      }
      let ok = false;
      if (body.action === 'pause') ok = adminPause(session, 'practitioner');
      if (body.action === 'resume') ok = adminResume(session, 'practitioner');
      if (body.action === 'handoff') ok = adminHandoff(session, 'practitioner');
      if (!ok) {
        sendError(res, 400, 'invalid_action', 'Acción no válida.');
        return;
      }
      saveSession(session);
      sendJson(res, 200, { ok: true, session: inspectorSession(getSession(session.id), { reveal: false }) });
      return;
    }

    const timeMatch = pathname.match(/^\/api\/admin\/sessions\/([^/]+)\/time$/);
    if (method === 'POST' && timeMatch) {
      const body = await readJson(req);
      const session = getSession(timeMatch[1]);
      if (!session) {
        sendError(res, 404, 'not_found', 'Sesión no encontrada.');
        return;
      }
      const hours = Number(body.hours);
      if (!Number.isFinite(hours) || Math.abs(hours) > 24 * 365) {
        sendError(res, 400, 'invalid_hours', 'Horas inválidas.');
        return;
      }
      adminTimeTravel(session, hours);
      sendJson(res, 200, { ok: true, session: inspectorSession(getSession(session.id), { reveal: false }) });
      return;
    }

    const reminderMatch = pathname.match(/^\/api\/admin\/sessions\/([^/]+)\/reminder$/);
    if (method === 'POST' && reminderMatch) {
      const session = getSession(reminderMatch[1]);
      if (!session) {
        sendError(res, 404, 'not_found', 'Sesión no encontrada.');
        return;
      }
      const ok = adminForceReminder(session, 'practitioner');
      if (!ok) {
        sendError(res, 409, 'not_paused', 'La sesión debe estar en pausa para enviar el recordatorio.');
        return;
      }
      sendJson(res, 200, { ok: true, session: inspectorSession(getSession(session.id), { reveal: false }) });
      return;
    }

    const emailMatch = pathname.match(/^\/api\/admin\/sessions\/([^/]+)\/email$/);
    if (method === 'POST' && emailMatch) {
      const body = await readJson(req);
      const session = getSession(emailMatch[1]);
      if (!session) {
        sendError(res, 404, 'not_found', 'Sesión no encontrada.');
        return;
      }
      const email = validateEmail(body.email);
      if (!email.ok) {
        sendError(res, 400, 'invalid_email', email.issue);
        return;
      }
      session.destinationEmail = email.normalized;
      const sent = createSimulatedEmail(session, email.normalized, { reveal: true });
      session.summary = session.summary || {};
      session.summary.email = { to: `•••@${email.normalized.split('@')[1]}`, file: sent.fileName, sentAt: sent.sentAt };
      saveSession(session);
      appendAudit({
        type: 'email.sent',
        actor: 'practitioner',
        action: 'send',
        entity: 'session',
        entityId: session.id,
        payload: { simulated: true, file: sent.fileName },
      });
      sendJson(res, 200, { ok: true, simulated: true, file: sent.fileName, sentAt: sent.sentAt });
      return;
    }

    const exportMatch = pathname.match(/^\/api\/admin\/sessions\/([^/]+)\/export$/);
    if (method === 'GET' && exportMatch) {
      const session = getSession(exportMatch[1]);
      if (!session) {
        sendError(res, 404, 'not_found', 'Sesión no encontrada.');
        return;
      }
      const format = url.searchParams.get('format') || 'json';
      appendAudit({
        type: 'data.exported',
        actor: 'practitioner',
        action: 'export',
        entity: 'session',
        entityId: session.id,
        payload: { format },
      });
      if (format === 'html' || format === 'pdf') {
        const html = exportHtml(session, { reveal: true });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': `attachment; filename="${session.id}.html"`,
          'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
      }
      const json = exportJson(session, { reveal: true });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${session.id}.json"`,
        'Cache-Control': 'no-store',
      });
      res.end(json);
      return;
    }

    sendError(res, 404, 'not_found', 'Ruta de administración no encontrada.');
    return;
  }

  sendError(res, 404, 'not_found', 'Ruta no encontrada.');
}

async function handler(req, res) {
  const started = Date.now();
  securityHeaders(res);
  if (!sameOrigin(req)) {
    sendError(res, 403, 'origin_blocked', 'Origen no permitido.');
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await Promise.all([storeReady(), keyReady()]);
      await api(req, res, url);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logSecurity({ actor: 'system', action: 'server_error', payload: { message: err.message } });
    }
    const code = /^[a-z][a-z0-9_]*$/.test(String(err.code || ''))
      ? err.code
      : status === 500
        ? 'internal_error'
        : 'bad_request';
    if (!res.headersSent) {
      sendError(res, status, code, status === 500 ? 'Error interno.' : err.message);
    } else {
      res.end();
    }
  } finally {
    if (url.pathname.startsWith('/api/')) {
      await flushStore().catch((err) => console.error(`[store] flush failed: ${err.message}`));
    }
    const elapsed = Date.now() - started;
    console.log(`${req.method} ${url.pathname} ${res.statusCode} ${elapsed}ms`);
  }
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'method_not_allowed', 'Método no permitido.');
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendError(res, 400, 'bad_path', 'Ruta inválida.');
    return;
  }
  if (decoded.includes('\0') || decoded.includes('..') || decoded.includes('\\')) {
    sendError(res, 400, 'bad_path', 'Ruta inválida.');
    return;
  }
  const relative = decoded === '/' ? '/index.html' : decoded;
  const file = path.resolve(config.publicDir, `.${relative}`);
  if (!file.startsWith(`${config.publicDir}${path.sep}`)) {
    sendError(res, 403, 'forbidden', 'Acceso denegado.');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    sendError(res, 404, 'not_found', 'Archivo no encontrado.');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const data = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    // POC local: sin caché para que los cambios de CSS/JS se vean al recargar.
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(data);
}

export function createServer() {
  initAuth();
  initStore();
  void initKeyManager();
  return http.createServer(handler);
}

export async function startServer() {
  initAuth();
  initStore();
  await initKeyManager().catch(() => {});
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const status = getStatus();
  console.log(`\nBiohipnosis POC en http://${config.host}:${config.port}`);
  console.log(`Modelo: ${status.model} (fallback ${status.fallbackModel}) · modo ${status.mode}`);
  if (!status.available) {
    console.log(`LLM no disponible ahora: ${status.lastError || 'proveedor no disponible'}. Se usará fallback determinista.`);
  }
  if (config.adminTokenIsDefault && config.auth.mode !== 'on') {
    console.log(`Token admin de demo: ${config.adminToken} (cámbialo con POC_ADMIN_TOKEN).`);
  }
  if (config.auth.mode === 'on') {
    console.log(`Acceso con Google activo. Correos autorizados: ${config.auth.allowedEmails.length || 'allowlist de Firestore'}.`);
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
