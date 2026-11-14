/* Firebase Authentication integration.

   Local development keeps working with auth off (the current admin-token
   flow). On Cloud Run, POC_AUTH=on verifies the Firebase ID token and checks
   the email allowlist before any route runs. */
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from './config.js';

const ALLOWLIST_TTL_MS = 60_000;

let app = null;
let auth = null;
let db = null;
let allowlistCache = { at: 0, emails: [] };

function httpError(status, code, message) {
  return Object.assign(new Error(message), { statusCode: status, code });
}

export function initAuth() {
  if (config.auth.mode !== 'on' || getApps().length) {
    if (getApps().length && config.auth.mode === 'on') {
      app = getApps()[0];
      auth = getAuth(app);
      db = getFirestore(app);
    }
    return;
  }
  app = initializeApp({ credential: applicationDefault(), projectId: config.gcp.projectId });
  auth = getAuth(app);
  db = getFirestore(app);
}

function adminEmails() {
  return new Set(config.auth.adminEmails);
}

async function firestoreAllowlist() {
  if (!db) return [];
  const now = Date.now();
  if (now - allowlistCache.at < ALLOWLIST_TTL_MS) return allowlistCache.emails;
  try {
    const snap = await db.doc(config.auth.allowlistDoc).get();
    const emails = (snap.exists ? snap.data()?.emails : []) || [];
    allowlistCache = {
      at: now,
      emails: emails.map((email) => String(email).trim().toLowerCase()).filter(Boolean),
    };
  } catch (err) {
    console.error(`[auth] allowlist read failed: ${err.message}`);
    allowlistCache = { at: now, emails: allowlistCache.emails };
  }
  return allowlistCache.emails;
}

export async function allowedEmails() {
  const stored = await firestoreAllowlist();
  return new Set([...config.auth.allowedEmails, ...stored, ...adminEmails()]);
}

export function refreshAllowlist() {
  allowlistCache = { at: 0, emails: [] };
}

/**
 * Returns `{ uid, email, name, picture, isAdmin, dev }` or throws an error with
 * `statusCode` and `code` suitable for sendError().
 */
export async function verifyRequest(req) {
  if (config.auth.mode !== 'on') {
    return { uid: 'local-dev', email: 'local@biohipnosis.dev', name: 'Modo local', isAdmin: true, dev: true };
  }
  if (!auth) initAuth();
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw httpError(401, 'auth_required', 'Inicia sesión con Google para continuar.');

  let decoded;
  try {
    decoded = await auth.verifyIdToken(token, true);
  } catch (err) {
    throw httpError(401, 'invalid_token', 'La sesión expiró. Vuelve a iniciar sesión.');
  }

  const email = String(decoded.email || '').trim().toLowerCase();
  if (!email) throw httpError(403, 'email_required', 'La cuenta no tiene un correo verificado.');

  const allowed = await allowedEmails();
  if (!allowed.has(email)) {
    throw httpError(403, 'not_allowed', 'Esta cuenta no está autorizada para usar la entrevista.');
  }

  return {
    uid: decoded.uid,
    email,
    name: decoded.name || email.split('@')[0],
    picture: decoded.picture || '',
    isAdmin: adminEmails().has(email),
    dev: false,
  };
}

export function authStatus() {
  return {
    mode: config.auth.mode,
    adminEmails: [...adminEmails()],
    envAllowlist: config.auth.allowedEmails,
  };
}
