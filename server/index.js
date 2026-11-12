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
  createSessionReply,
  handleInbound,
  inspectorSession,
  isFinal,
  publicSession,
  sessionEraseOnReply,
} from './engine.js';
import { createSession, deleteSession, getMetrics, getSession, init as initStore, listSessions, readAudit, retentionReport, saveSession, verifyAudit } from './store.js';
import { appendAudit, dailySpend, listOutbox, logSecurity, readOutboxFile } from './store.js';
import { validateEmail, validatePhone, detectCrisis } from './validators.js';
import { checkAdmin, checkInbound, getSessionState, llmQueueDepth, recordAdminFailure, recordAdminSuccess } from './ratelimit.js';
import { clearCooldowns, getStatus } from './llm.js';
import { createSimulatedEmail, exportHtml, exportJson } from './export.js';
import { removeSessionMedia } from './media.js';
import { runSecuritySuite } from './securitySuite.js';
import { randomId, timingSafeEqual } from './crypto.js';

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
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; " +
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

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  return origin === `http://${host}` || origin === `https://${host}`;
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
  const ip = req.socket.remoteAddress || 'local';
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
  const ip = req.socket.remoteAddress || 'local';

  if (method === 'GET' && pathname === '/api/health') {
    const llm = getStatus();
    sendJson(res, 200, {
      ok: true,
      version: config.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      llm,
      queue: llmQueueDepth(),
      adminTokenDefault: config.adminTokenIsDefault,
      surveyVersion: catalogSummary().version,
      totalItems: catalogSummary().total,
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/config') {
    sendJson(res, 200, { ...publicConfig(), catalog: catalogSummary() });
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

  // Admin routes
  if (pathname.startsWith('/api/admin/')) {
    if (!requireAdmin(req, res, url)) return;

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
      await api(req, res, url);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) {
      logSecurity({ actor: 'system', action: 'server_error', payload: { message: err.message } });
    }
    if (!res.headersSent) {
      sendError(res, status, status === 500 ? 'internal_error' : 'bad_request', status === 500 ? 'Error interno.' : err.message);
    } else {
      res.end();
    }
  } finally {
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
  initStore();
  return http.createServer(handler);
}

export async function startServer() {
  initStore();
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
  if (config.adminTokenIsDefault) {
    console.log(`Token admin de demo: ${config.adminToken} (cámbialo con POC_ADMIN_TOKEN).`);
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
