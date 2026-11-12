/* Free-form question sandbox.
 *
 * Test sessions live only in this process memory: they are never written to
 * data/sessions, index.json, the audit chain or the metrics file. This lets a
 * tester jump straight to any question/section and retry it as many times as
 * needed without leaving traces that look like real interviews.
 */

import { firstItemOfSection, getItem, getSection } from './catalog.js';
import { randomId } from './crypto.js';
import { defaultSession } from './store.js';

const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 50;
const sessions = new Map();

function purgeExpired(now = Date.now()) {
  for (const [id, entry] of sessions) {
    if (now - entry.touchedAt > TTL_MS) sessions.delete(id);
  }
}

function evictOldest() {
  while (sessions.size >= MAX_SESSIONS) {
    sessions.delete(sessions.keys().next().value);
  }
}

export function resolveTestTarget({ itemId, sectionId } = {}) {
  if (itemId) {
    const item = getItem(String(itemId));
    if (!item) return null;
    return {
      kind: 'item',
      itemId: item.id,
      sectionId: item.sectionId,
      label: `${item.id} · ${item.label}`,
      prompt: item.prompt,
    };
  }
  if (sectionId) {
    const section = getSection(String(sectionId));
    const item = firstItemOfSection(String(sectionId));
    if (!section || !item) return null;
    return {
      kind: 'section',
      itemId: item.id,
      sectionId: section.id,
      label: `${section.id} · ${section.name}`,
      prompt: item.prompt,
    };
  }
  return null;
}

export function createTestSession({ itemId, sectionId, name } = {}) {
  purgeExpired();
  const target = resolveTestTarget({ itemId, sectionId });
  if (!target) return null;
  evictOldest();

  const session = defaultSession({ name: name || 'Prueba libre' });
  // A distinct prefix makes the origin obvious in logs and in the chat UI.
  session.id = randomId('tst_', 12);
  session.waId = randomId('twa_', 12);
  session.clientToken = randomId('ct_', 24);
  session.status = 'IN_PROGRESS';
  session.ageConfirmed = true;
  session.consent = {
    version: 'sandbox',
    granted: true,
    grantedAt: new Date().toISOString(),
    channel: 'simulator-sandbox',
    evidence: { sandbox: true },
  };
  session.currentSectionId = target.sectionId;
  session.currentItemId = target.itemId;
  session.meta.testSession = true;
  session.meta.testTarget = target;
  session.meta.testCreatedAt = new Date().toISOString();
  sessions.set(session.id, { session, touchedAt: Date.now() });
  return session;
}

export function getTestSession(id) {
  purgeExpired();
  const entry = sessions.get(String(id));
  if (!entry) return null;
  entry.touchedAt = Date.now();
  return entry.session;
}

export function deleteTestSession(id) {
  return sessions.delete(String(id));
}

export function listTestSessionCount() {
  purgeExpired();
  return sessions.size;
}
