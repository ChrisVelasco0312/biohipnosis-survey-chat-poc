'use strict';

/* Bloqueo de inicio de sesión por allowlist.
 *
 * Se ejecuta antes de que Identity Platform emita el token. La lista se lee de
 * Firestore (`system/allowlist`, campo `emails`) y de las variables de entorno
 * POC_ALLOWED_EMAILS / POC_ADMIN_EMAILS. Si no hay ninguna fuente disponible,
 * falla cerrado: es preferible negar el acceso a abrirlo por accidente. */

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { beforeUserSignedIn } = require('firebase-functions/v2/identity');
const { HttpsError } = require('firebase-functions/v2/https');

initializeApp();

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

exports.beforeSignIn = beforeUserSignedIn({ region: 'us-central1' }, async (event) => {
  const email = String(event.data?.email || '').trim().toLowerCase();
  if (!email) {
    throw new HttpsError('invalid-argument', 'La cuenta de Google no tiene un correo verificable.');
  }

  const allowed = new Set([
    ...parseList(process.env.POC_ALLOWED_EMAILS),
    ...parseList(process.env.POC_ADMIN_EMAILS),
  ]);

  try {
    const snap = await getFirestore().doc('system/allowlist').get();
    for (const entry of snap.get('emails') || []) {
      allowed.add(String(entry).trim().toLowerCase());
    }
  } catch (error) {
    console.error('No se pudo leer la allowlist de Firestore', error);
  }

  if (!allowed.size) {
    throw new HttpsError('permission-denied', 'La lista de acceso aún no está configurada.');
  }

  if (!allowed.has(email)) {
    console.warn('Inicio de sesión bloqueado para', email);
    throw new HttpsError('permission-denied', 'Esta cuenta no está autorizada para esta entrevista.');
  }

  return {};
});
