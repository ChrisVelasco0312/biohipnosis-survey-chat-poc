/* Filesystem persistence driver. This is the original local POC behaviour and
   remains the default for development and the test suite. */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { emptyMetrics } from './store-shared.js';

function atomicWrite(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readAuditLines(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({ type: 'audit.corrupt', raw: line.slice(0, 200) });
    }
  }
  return entries;
}

export function createFsDriver() {
  const dataDir = config.dataDir;
  const paths = {
    dataDir,
    sessions: path.join(dataDir, 'sessions'),
    media: path.join(dataDir, 'media'),
    outbox: path.join(dataDir, 'outbox'),
    index: path.join(dataDir, 'index.json'),
    audit: path.join(dataDir, 'audit.jsonl'),
    metrics: path.join(dataDir, 'metrics.json'),
    retention: path.join(dataDir, 'retention.json'),
  };

  function sessionPath(id) {
    if (!/^ses_[A-Za-z0-9_-]+$/.test(String(id))) throw new Error('Invalid session id');
    return path.join(paths.sessions, `${id}.enc`);
  }

  return {
    kind: 'fs',
    sync: true,
    sessionPath,
    dataPaths: () => ({ ...paths }),

    load() {
      for (const dir of [dataDir, paths.sessions, paths.media, paths.outbox]) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        try {
          fs.chmodSync(dir, 0o700);
        } catch {
          // Best effort on non-POSIX filesystems.
        }
      }
      const index = loadJson(paths.index, { sessions: {} });
      index.sessions ||= {};
      const metrics = loadJson(paths.metrics, { totals: emptyMetrics(), daily: {}, models: {} });
      metrics.totals ||= emptyMetrics();
      metrics.daily ||= {};
      metrics.models ||= {};
      return { index, metrics, audit: readAuditLines(paths.audit) };
    },

    readSession(id) {
      const file = sessionPath(id);
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file, 'utf8');
    },

    writeSession(id, sealed) {
      atomicWrite(sessionPath(id), sealed);
    },

    removeSession(id) {
      const file = sessionPath(id);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    },

    saveIndex(index) {
      atomicWrite(paths.index, JSON.stringify(index, null, 2));
    },

    saveMetrics(metrics) {
      atomicWrite(paths.metrics, JSON.stringify(metrics, null, 2));
    },

    appendAudit(entry) {
      fs.appendFileSync(paths.audit, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    },

    saveOutbox(name, contents) {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Invalid outbox filename');
      const file = path.join(paths.outbox, name);
      atomicWrite(file, contents);
      return file;
    },

    listOutbox() {
      if (!fs.existsSync(paths.outbox)) return [];
      return fs
        .readdirSync(paths.outbox)
        .filter((name) => /^[A-Za-z0-9._-]+$/.test(name))
        .map((name) => {
          const stat = fs.statSync(path.join(paths.outbox, name));
          return { name, bytes: stat.size, createdAt: stat.mtime.toISOString() };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    readOutbox(name) {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Invalid outbox filename');
      const file = path.join(paths.outbox, name);
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file, 'utf8');
    },

    saveMedia(sessionId, fileId, ext, buffer) {
      if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session id');
      if (!/^fil_[A-Za-z0-9_-]+$/.test(fileId)) throw new Error('Invalid file id');
      const dir = path.join(paths.media, sessionId);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${fileId}${ext}`);
      fs.writeFileSync(file, buffer, { mode: 0o600 });
      return file;
    },

    removeMedia(sessionId) {
      if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionId)) return;
      fs.rmSync(path.join(paths.media, sessionId), { recursive: true, force: true });
    },

    async flush() {},
  };
}
