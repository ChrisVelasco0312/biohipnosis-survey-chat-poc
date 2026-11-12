import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let cachedKey = null;

export function ensureKey() {
  if (cachedKey) return cachedKey;
  const envKey = process.env.POC_MASTER_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, 'base64');
    if (buf.length !== 32) throw new Error('POC_MASTER_KEY must be 32 bytes encoded as base64');
    cachedKey = buf;
    return cachedKey;
  }
  const keyPath = path.join(config.dataDir, '.key');
  if (fs.existsSync(keyPath)) {
    const buf = fs.readFileSync(keyPath);
    if (buf.length !== 32) throw new Error('Invalid local encryption key');
    cachedKey = buf;
    return cachedKey;
  }
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const buf = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, buf, { mode: 0o600 });
  cachedKey = buf;
  return cachedKey;
}

export function seal(value) {
  const key = ensureKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `POC1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function open(sealed) {
  if (typeof sealed !== 'string' || !sealed.startsWith('POC1.')) {
    throw new Error('Invalid sealed payload');
  }
  const [, ivB64, tagB64, dataB64] = sealed.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed sealed payload');
  const key = ensureKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomId(prefix = '', bytes = 12) {
  return `${prefix}${crypto.randomBytes(bytes).toString('base64url')}`;
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function hashEntry(prevHash, entry) {
  return sha256(`${prevHash}|${stableStringify(entry)}`);
}

export function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
