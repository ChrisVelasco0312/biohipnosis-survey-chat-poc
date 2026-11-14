#!/usr/bin/env node
/* Actualiza la allowlist de correos en Firestore (`system/allowlist`).
 *
 * Uso:
 *   npm run allowlist -- persona1@gmail.com persona2@gmail.com
 *
 * Requiere credenciales de aplicación por defecto (ADC):
 *   gcloud auth application-default login
 */
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const projectId = process.env.POC_GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'biohipnosis-poc-2026';
const emails = process.argv
  .slice(2)
  .map((email) => String(email).trim().toLowerCase())
  .filter(Boolean);

if (!emails.length) {
  console.error('Uso: npm run allowlist -- correo1@gmail.com [correo2@gmail.com ...]');
  process.exit(1);
}

const invalid = emails.filter((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
if (invalid.length) {
  console.error(`Correos inválidos: ${invalid.join(', ')}`);
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId });

await getFirestore().doc('system/allowlist').set(
  {
    emails: [...new Set(emails)].sort(),
    updatedAt: new Date().toISOString(),
  },
  { merge: true },
);

console.log(`Allowlist actualizada en ${projectId}:`);
for (const email of [...new Set(emails)].sort()) console.log(`  · ${email}`);
process.exit(0);
