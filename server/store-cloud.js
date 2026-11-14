/* Cloud persistence driver: encrypted session blobs, media and outbox files in
   GCS; index, metrics and the audit hash chain in Firestore.

   The public store API is synchronous, so this driver keeps everything in
   memory after load() and writes through asynchronously. `flush()` lets the
   HTTP layer wait for pending writes before the request finishes. */
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import { config } from './config.js';
import { emptyMetrics } from './store-shared.js';

const SESSION_PREFIX = 'sessions/';
const MEDIA_PREFIX = 'media/';
const OUTBOX_PREFIX = 'outbox/';

function safeIdFromSessionFile(name) {
  const base = String(name).slice(SESSION_PREFIX.length);
  if (!base.endsWith('.enc')) return null;
  const id = base.slice(0, -4);
  return /^ses_[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

export function createCloudDriver() {
  const db = new Firestore({ projectId: config.gcp.projectId });
  const bucket = new Storage({ projectId: config.gcp.projectId }).bucket(config.gcp.bucket);
  const sessions = new Map();
  const outbox = new Map();
  const pending = new Set();

  function enqueue(label, work) {
    const task = Promise.resolve()
      .then(work)
      .catch((err) => {
        console.error(`[store-cloud] ${label}: ${err.message}`);
      })
      .finally(() => pending.delete(task));
    pending.add(task);
    return task;
  }

  return {
    kind: 'cloud',
    sync: false,
    dataPaths: () => ({
      dataDir: `gs://${config.gcp.bucket}`,
      sessions: `gs://${config.gcp.bucket}/${SESSION_PREFIX}`,
      media: `gs://${config.gcp.bucket}/${MEDIA_PREFIX}`,
      outbox: `gs://${config.gcp.bucket}/${OUTBOX_PREFIX}`,
      index: 'firestore:system/index',
      audit: 'firestore:audit',
      metrics: 'firestore:system/metrics',
      retention: 'firestore:system/retention',
    }),

    async load() {
      const [indexSnap, metricsSnap, auditSnap, sessionFiles, outboxFiles] = await Promise.all([
        db.doc('system/index').get(),
        db.doc('system/metrics').get(),
        db.collection('audit').orderBy('seq', 'asc').limit(5000).get(),
        bucket.getFiles({ prefix: SESSION_PREFIX }),
        bucket.getFiles({ prefix: OUTBOX_PREFIX }),
      ]);

      const index = indexSnap.exists ? indexSnap.data() : { sessions: {} };
      index.sessions ||= {};

      const metrics = metricsSnap.exists
        ? metricsSnap.data()
        : { totals: emptyMetrics(), daily: {}, models: {} };
      metrics.totals ||= emptyMetrics();
      metrics.daily ||= {};
      metrics.models ||= {};

      const audit = auditSnap.docs.map((doc) => doc.data());

      await Promise.allSettled(
        sessionFiles[0].map(async (file) => {
          const id = safeIdFromSessionFile(file.name);
          if (!id) return;
          const [buffer] = await file.download();
          sessions.set(id, buffer.toString('utf8'));
        }),
      );

      await Promise.allSettled(
        outboxFiles[0].map(async (file) => {
          const name = String(file.name).slice(OUTBOX_PREFIX.length);
          if (!/^[A-Za-z0-9._-]+$/.test(name)) return;
          const [buffer] = await file.download();
          outbox.set(name, {
            contents: buffer.toString('utf8'),
            bytes: buffer.length,
            createdAt: file.metadata?.timeCreated || file.metadata?.updated || new Date().toISOString(),
          });
        }),
      );

      console.log(
        `[store-cloud] loaded ${sessions.size} sessions, ${audit.length} audit entries, ${outbox.size} outbox files`,
      );
      return { index, metrics, audit };
    },

    readSession(id) {
      if (!/^ses_[A-Za-z0-9_-]+$/.test(String(id))) throw new Error('Invalid session id');
      return sessions.get(id) || null;
    },

    writeSession(id, sealed) {
      if (!/^ses_[A-Za-z0-9_-]+$/.test(String(id))) throw new Error('Invalid session id');
      sessions.set(id, sealed);
      enqueue(`write ${id}`, () =>
        bucket.file(`${SESSION_PREFIX}${id}.enc`).save(sealed, {
          resumable: false,
          contentType: 'application/octet-stream',
          metadata: { cacheControl: 'no-store' },
        }),
      );
    },

    removeSession(id) {
      if (!/^ses_[A-Za-z0-9_-]+$/.test(String(id))) return;
      sessions.delete(id);
      enqueue(`delete ${id}`, () =>
        bucket.file(`${SESSION_PREFIX}${id}.enc`).delete({ ignoreNotFound: true }),
      );
    },

    saveIndex(index) {
      const snapshot = JSON.parse(JSON.stringify(index));
      enqueue('save index', () => db.doc('system/index').set(snapshot));
    },

    saveMetrics(metrics) {
      const snapshot = JSON.parse(JSON.stringify(metrics));
      enqueue('save metrics', () => db.doc('system/metrics').set(snapshot));
    },

    appendAudit(entry) {
      const seq = Number(entry.seq || 0);
      const docId = String(seq).padStart(8, '0');
      enqueue('append audit', () => db.collection('audit').doc(docId).set(entry));
    },

    saveOutbox(name, contents) {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Invalid outbox filename');
      const bytes = Buffer.byteLength(contents);
      outbox.set(name, { contents, bytes, createdAt: new Date().toISOString() });
      enqueue(`save outbox ${name}`, () =>
        bucket.file(`${OUTBOX_PREFIX}${name}`).save(contents, {
          resumable: false,
          contentType: 'text/html; charset=utf-8',
          metadata: { cacheControl: 'no-store' },
        }),
      );
      return `gs://${config.gcp.bucket}/${OUTBOX_PREFIX}${name}`;
    },

    listOutbox() {
      return [...outbox.entries()]
        .map(([name, value]) => ({ name, bytes: value.bytes, createdAt: value.createdAt }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    readOutbox(name) {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Invalid outbox filename');
      return outbox.get(name)?.contents ?? null;
    },

    saveMedia(sessionId, fileId, ext, buffer) {
      if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session id');
      if (!/^fil_[A-Za-z0-9_-]+$/.test(fileId)) throw new Error('Invalid file id');
      const key = `${MEDIA_PREFIX}${sessionId}/${fileId}${ext}`;
      enqueue(`save media ${key}`, () =>
        bucket.file(key).save(buffer, {
          resumable: false,
          contentType: 'application/octet-stream',
          metadata: { cacheControl: 'no-store' },
        }),
      );
      return `gs://${config.gcp.bucket}/${key}`;
    },

    removeMedia(sessionId) {
      if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionId)) return;
      enqueue(`delete media ${sessionId}`, async () => {
        const [files] = await bucket.getFiles({ prefix: `${MEDIA_PREFIX}${sessionId}/` });
        await Promise.all(files.map((file) => file.delete({ ignoreNotFound: true })));
      });
    },

    async flush() {
      // Persist a stable snapshot; new writes scheduled meanwhile are picked up
      // by the next loop iteration.
      while (pending.size) {
        await Promise.allSettled([...pending]);
      }
    },
  };
}
