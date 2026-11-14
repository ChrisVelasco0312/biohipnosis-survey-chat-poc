/* Owner notifications through Resend.

   Testers can ask the owner to rotate the OpenCode key when inference starts
   failing. Emails are rate limited in memory (one per user every 6 hours and
   one global per hour) to avoid inbox flooding. */
import { config } from './config.js';

const lastGlobalAt = { at: 0 };
const lastByUser = new Map();

export function notificationsEnabled() {
  return Boolean(config.notifications.resendApiKey);
}

async function sendEmail({ to, subject, text }) {
  if (!notificationsEnabled()) {
    return { sent: false, reason: 'email_not_configured' };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.notifications.resendApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: config.notifications.from, to: [to], subject, text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[notify] Resend ${res.status}: ${detail.slice(0, 200)}`);
    return { sent: false, reason: 'email_failed' };
  }
  const data = await res.json().catch(() => ({}));
  return { sent: true, id: data.id || null };
}

export async function requestKeyRenewal({ user, reason = 'key_invalid' }) {
  const now = Date.now();
  const userKey = String(user?.email || 'unknown').toLowerCase();
  const lastUser = lastByUser.get(userKey) || 0;

  if (now - lastGlobalAt.at < config.notifications.globalCooldownMs) {
    return { sent: false, reason: 'rate_limited', retryAfterSec: Math.ceil((config.notifications.globalCooldownMs - (now - lastGlobalAt.at)) / 1000) };
  }
  if (now - lastUser < config.notifications.userCooldownMs) {
    return { sent: false, reason: 'rate_limited', retryAfterSec: Math.ceil((config.notifications.userCooldownMs - (now - lastUser)) / 1000) };
  }

  lastGlobalAt.at = now;
  lastByUser.set(userKey, now);

  const subject = '[Biohipnosis POC] Solicitud de renovación de clave OpenCode';
  const text = [
    'La entrevista no puede usar el modelo de lenguaje porque la clave de OpenCode no es válida o expiró.',
    '',
    `Solicitado por: ${user?.email || 'desconocido'}`,
    `Motivo reportado: ${reason}`,
    `Fecha: ${new Date(now).toISOString()}`,
    '',
    'Para renovarla:',
    '1. Entra a https://opencode.ai/auth y crea una clave nueva (Go → API keys).',
    '2. Abre la consola de administración de la POC.',
    '3. Pega la clave en “Clave de OpenCode” y guarda.',
    '',
    'La clave anterior quedará deshabilitada automáticamente en Secret Manager.',
  ].join('\n');

  const result = await sendEmail({ to: config.notifications.ownerEmail, subject, text });
  return { ...result, ownerEmail: config.notifications.ownerEmail };
}

export async function sendExpiryWarning({ expiresAt, state }) {
  const subject = '[Biohipnosis POC] La clave de OpenCode está por expirar';
  const text = [
    `La clave de OpenCode de la POC está en estado "${state}".`,
    `Expira: ${expiresAt || 'sin fecha registrada'}`,
    '',
    'Renueva la clave en https://opencode.ai/auth y pégala en la consola de administración.',
  ].join('\n');
  return sendEmail({ to: config.notifications.ownerEmail, subject, text });
}
