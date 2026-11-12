import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const ALLOWED = {
  'application/pdf': { ext: '.pdf', kind: 'document', magic: [[0x25, 0x50, 0x44, 0x46]] },
  'image/jpeg': { ext: '.jpg', kind: 'image', magic: [[0xff, 0xd8, 0xff]] },
  'image/png': { ext: '.png', kind: 'image', magic: [[0x89, 0x50, 0x4e, 0x47]] },
  'image/webp': { ext: '.webp', kind: 'image', magic: [[0x52, 0x49, 0x46, 0x46]] },
  'audio/ogg': { ext: '.ogg', kind: 'audio', magic: [[0x4f, 0x67, 0x67, 0x53]] },
  'audio/mpeg': { ext: '.mp3', kind: 'audio', magic: [[0x49, 0x44, 0x33], [0xff, 0xfb], [0xff, 0xf3]] },
  'audio/wav': { ext: '.wav', kind: 'audio', magic: [[0x52, 0x49, 0x46, 0x46]] },
  'audio/mp4': { ext: '.m4a', kind: 'audio', magic: [[0x00, 0x00, 0x00]] },
  'audio/webm': { ext: '.webm', kind: 'audio', magic: [[0x1a, 0x45, 0xdf, 0xa3]] },
};

function matchesMagic(buffer, magic) {
  return magic.some((bytes) => bytes.every((byte, idx) => buffer[idx] === byte));
}

export function sanitizeFilename(name) {
  const base = String(name || 'archivo')
    .replace(/[/\\]/g, '_')
    .replace(/[^\w.\-áéíóúÁÉÍÓÚñÑ ]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return base || 'archivo';
}

export function validateAttachment(input) {
  if (!input || typeof input !== 'object') return { ok: false, issue: 'No recibí el archivo.' };
  const name = sanitizeFilename(input.name);
  const mime = String(input.mime || '').toLowerCase().split(';')[0].trim();
  const spec = ALLOWED[mime];
  if (!spec) {
    return {
      ok: false,
      issue: 'Solo acepto PDF, imágenes (JPG, PNG, WebP) o audio (OGG, MP3, WAV, M4A).',
      code: 'unsupported_type',
    };
  }
  if (typeof input.dataBase64 !== 'string' || !input.dataBase64) {
    return { ok: false, issue: 'El archivo llegó vacío.', code: 'empty' };
  }
  if (input.dataBase64.length > Math.ceil((config.limits.attachmentMaxBytes * 4) / 3) + 16) {
    return { ok: false, issue: 'El archivo supera el límite de 8 MB.', code: 'too_large' };
  }
  let buffer;
  try {
    buffer = Buffer.from(input.dataBase64, 'base64');
  } catch {
    return { ok: false, issue: 'El archivo no se pudo decodificar.', code: 'bad_base64' };
  }
  if (!buffer.length) return { ok: false, issue: 'El archivo llegó vacío.', code: 'empty' };
  if (buffer.length > config.limits.attachmentMaxBytes) {
    return { ok: false, issue: 'El archivo supera el límite de 8 MB.', code: 'too_large' };
  }
  if (!matchesMagic(buffer, spec.magic)) {
    return {
      ok: false,
      issue: 'El contenido del archivo no coincide con su tipo. Por seguridad, no lo acepté.',
      code: 'magic_mismatch',
    };
  }
  return {
    ok: true,
    name,
    mime,
    kind: spec.kind,
    bytes: buffer.length,
    buffer,
    ext: spec.ext,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

export function storeAttachment(sessionId, attachment, fileId) {
  if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session id');
  if (!/^fil_[A-Za-z0-9_-]+$/.test(fileId)) throw new Error('Invalid file id');
  const dir = path.join(config.dataDir, 'media', sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${fileId}${attachment.ext}`);
  fs.writeFileSync(file, attachment.buffer, { mode: 0o600 });
  return file;
}

export function validateVoice(input) {
  const durationSec = Number(input?.durationSec);
  const confidence = Number(input?.confidence);
  const transcript = String(input?.transcript || '').trim();
  if (!Number.isFinite(durationSec) || durationSec < 0.5 || durationSec > config.limits.audioMaxSeconds) {
    return { ok: false, issue: `La nota de voz debe durar entre 1 segundo y ${config.limits.audioMaxSeconds / 60} minutos.` };
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, issue: 'La confianza de la transcripción debe estar entre 0 y 1.' };
  }
  if (transcript.length < 1) return { ok: false, issue: 'La transcripción simulada está vacía.' };
  if (transcript.length > config.limits.maxInputChars) {
    return { ok: false, issue: `La transcripción supera ${config.limits.maxInputChars} caracteres.` };
  }
  return {
    ok: true,
    durationSec: Math.round(durationSec),
    confidence: Number(confidence.toFixed(2)),
    transcript,
    needsConfirmation: confidence < 0.6,
  };
}

export function removeSessionMedia(sessionId) {
  if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionId)) return;
  const dir = path.join(config.dataDir, 'media', sessionId);
  fs.rmSync(dir, { recursive: true, force: true });
}

export function allowedMimeTypes() {
  return Object.keys(ALLOWED);
}
