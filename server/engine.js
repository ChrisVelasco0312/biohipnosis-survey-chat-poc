import { config } from './config.js';
import {
  ITEMS,
  SECTIONS,
  SURVEY_VERSION,
  firstItemOfSection,
  getItem,
  getSection,
  nextItemId,
  nextSectionId,
  sectionItems,
  totalItems,
} from './catalog.js';
import { randomId } from './crypto.js';
import { analyze } from './llm.js';
import {
  cleanText,
  coverageFromNormalized,
  detectNonsense,
  heuristicCoverage,
  heuristicScores,
  isAffirmative,
  isConfusion,
  isConsentNo,
  isConsentYes,
  isCorrectionRequest,
  isErasure,
  isHumanRequest,
  isNegative,
  isNegativeComplete,
  isOptOut,
  isPause,
  isRepeat,
  isResume,
  isSkip,
  isSmallTalk,
  maskPhone,
  missingSubfields,
  normalizeForMatch,
  sanitizeAck,
  screenOutbound,
  validateField,
  weightedScore,
} from './validators.js';
import {
  consentDeclineReply,
  crisisReply,
  diagnosisReply,
  erasureReply,
  humanReply,
  injectionReply,
  minorReply,
  nonsenseClarifyReply,
  nonsensePartialReply,
  offTopicReply,
  optOutReply,
  otherDataReply,
  pauseReply,
  reviewPausedReply,
  safeMessage,
  screenInbound,
  smallTalkAckReply,
  spamWarningReply,
} from './safety.js';
import { storeAttachment, validateAttachment, validateVoice } from './media.js';
import { chunkLines, fullSummaryChunks, summaryLines, summaryRecord } from './export.js';
import {
  appendAudit,
  dailySpend,
  recordSessionCompleted,
  recordTurn,
  saveSession,
} from './store.js';

const FINAL_STATUS = new Set(['COMPLETED', 'OPTED_OUT', 'ERASED']);

function nowMs(session) {
  return Date.now() + (session.clockOffsetMs || 0);
}

function iso(session) {
  return new Date(nowMs(session)).toISOString();
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'hola';
}

function addMessage(session, { direction, type = 'text', text, meta = {}, waMessageId = null, status = 'sent' }) {
  const message = {
    id: randomId('msg_', 9),
    direction,
    type,
    text: String(text ?? ''),
    createdAt: iso(session),
    waMessageId,
    status,
    meta,
  };
  session.messages.push(message);
  return message;
}

function reply(session, text, meta = {}, type = 'text') {
  const safe = safeMessage(text, config.limits.maxOutboundChars);
  if (safe.blocked) {
    event(session, 'output.blocked', { issues: safe.issues });
    audit(session, 'security.output_blocked', { issues: safe.issues }, 'system', 'block');
  }
  recordTurn({ direction: 'out' });
  return addMessage(session, { direction: 'out', type, text: safe.text, meta });
}

function humanValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, val]) => `${key.replaceAll('_', ' ')}: ${val ?? '—'}`)
      .join(', ');
  }
  return String(value);
}

function event(session, type, data = {}) {
  session.events.push({ id: randomId('evt_', 6), at: iso(session), type, data });
  if (session.events.length > 1000) session.events = session.events.slice(-1000);
}

function audit(session, type, payload = {}, actor = 'system', action = '') {
  appendAudit({
    type,
    actor,
    action,
    entity: 'session',
    entityId: session.id,
    payload,
  });
}

function updateProgress(session) {
  const records = Object.values(session.items || {});
  const answered = records.filter((r) => ['ACCEPTED', 'CONFIRMED', 'PARTIAL', 'SKIPPED', 'EDITED'].includes(r.status)).length;
  const partial = records.filter((r) => r.status === 'PARTIAL').length;
  session.progress = { answered, partial, total: totalItems() };
}

/**
 * Contador de ráfaga: cuántas veces consecutivas se repitió el mismo mensaje
 * corto. 0 = mensaje nuevo; N = N repeticiones idénticas seguidas del último.
 */
function spamBurstStep(session, text) {
  const n = normalizeForMatch(text);
  session.meta.lastInboundNorm = n || '';
  if (!n || n.length > 60 || isSkip(text)) {
    session.meta.spamBurst = 0;
    return 0;
  }
  if (n && n === session.meta.previousInboundNorm) {
    session.meta.spamBurst = (session.meta.spamBurst || 0) + 1;
  } else {
    session.meta.spamBurst = 0;
  }
  session.meta.previousInboundNorm = n;
  return session.meta.spamBurst;
}

/**
 * Pausa de la entrevista por comportamiento anómalo (spam sostenido o
 * respuestas sin sentido reiteradas). Queda en PAUSED para revisión
 * profesional y el usuario puede retomarla escribiendo “Continuar”.
 */
function pauseForReview(session, reason) {
  session.status = 'PAUSED';
  session.meta.pausedAt = iso(session);
  session.meta.reminderDueAt = new Date(nowMs(session) + 24 * 3_600_000).toISOString();
  session.meta.reminderSent = false;
  session.meta.reviewPausedReason = reason;
  session.flags = { ...(session.flags || {}), [`${reason}Suspected`]: true };
  reply(session, reviewPausedReply(reason));
  event(session, 'session.review_paused', { reason });
  audit(session, `security.${reason}_paused`, {}, 'system', 'pause');
}

function setRisk(session, level, signals = [], source = 'deterministic') {  const order = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
  if ((order[level] || 0) >= (order[session.riskLevel] || 0)) {
    session.riskLevel = level;
  }
  session.escalations.push({
    id: randomId('esc_', 6),
    at: iso(session),
    level,
    signals,
    source,
    status: 'open',
  });
  event(session, 'risk.detected', { level, signals, source });
  audit(session, 'safety.risk', { level, signals, source }, 'system', 'escalate');
}

function addBudget(session, meta) {
  if (!meta) return;
  session.budget.tokensIn += Number(meta.tokensIn || 0);
  session.budget.tokensOut += Number(meta.tokensOut || 0);
  session.budget.spentUsd = Number((session.budget.spentUsd + Number(meta.costUsd || 0)).toFixed(6));
  recordTurn({
    direction: 'llm',
    model: meta.model || 'deterministic',
    tokensIn: meta.tokensIn || 0,
    tokensOut: meta.tokensOut || 0,
    costUsd: meta.costUsd || 0,
    latencyMs: meta.latencyMs || 0,
    fallback: !!meta.fallback,
  });
  if (!session.budget.warned && session.budget.spentUsd >= session.budget.limitUsd * config.limits.budgetWarnRatio) {
    session.budget.warned = true;
    event(session, 'budget.warning', { spentUsd: session.budget.spentUsd, limitUsd: session.budget.limitUsd });
    audit(session, 'cost.warning', { spentUsd: session.budget.spentUsd }, 'system', 'warn');
  }
  if (session.budget.spentUsd >= session.budget.limitUsd && !session.budget.exhausted) {
    session.budget.exhausted = true;
    event(session, 'budget.exhausted', { spentUsd: session.budget.spentUsd, limitUsd: session.budget.limitUsd });
    audit(session, 'cost.exhausted', { spentUsd: session.budget.spentUsd }, 'system', 'stop');
  }
}

function budgetAllowsLlm(session) {
  if (session.budget.exhausted) return false;
  if (session.budget.spentUsd >= session.budget.limitUsd) return false;
  if (dailySpend() >= config.limits.dailyBudgetUsd) return false;
  return true;
}

function buttonsFor(item, extra = {}) {
  if (extra.buttons) return extra.buttons;
  if (item?.id === 'C01') {
    return [
      { id: 'summary_yes', label: 'Sí, está correcto' },
      { id: 'summary_no', label: 'Quiero corregir algo' },
    ];
  }
  return [];
}

function resolveButton(session, buttonId) {
  const map = {
    age_yes: 'Sí, tengo 18 años o más',
    age_no: 'No',
    consent_yes: 'Acepto',
    consent_no: 'No acepto',
    review_yes: 'Todo correcto',
    review_no: 'Quiero corregir',
    summary_yes: 'Sí, está correcto',
    summary_no: 'Quiero corregir algo',
    crisis_contact: 'Quiero que me contacten',
    crisis_ok: 'Ya estoy bien, continuar',
    resume: 'Continuar',
    confirm_yes: 'Sí, es correcto',
    confirm_no: 'No, corregir',
    voice_yes: 'Sí, es correcto',
    voice_no: 'No, repetir',
  };
  return map[buttonId] || null;
}

function sectionIntro(session, sectionId) {
  session.meta.introsSent ||= [];
  if (session.meta.introsSent.includes(sectionId)) return false;
  const section = getSection(sectionId);
  if (!section) return false;
  session.meta.introsSent.push(sectionId);
  reply(session, section.intro, { kind: 'section', sectionId });
  return true;
}

function askQuestion(session, item, { clarify = false, clarifyText = null, issues = [], step = null, buttons = null } = {}) {
  if (!item) return;
  if (!clarify) {
    session.currentSectionId = item.sectionId;
    session.currentItemId = item.id;
    sectionIntro(session, item.sectionId);
  }
  const promptText = step && item.q21Steps ? step.prompt : item.prompt;
  const text = clarify
    ? `Gracias. ${clarifyText || item.clarify || '¿Me lo explicas un poco más?'}`
    : promptText;
  const meta = {
    kind: 'question',
    itemId: item.id,
    sectionId: item.sectionId,
    step: step?.key || null,
    buttons: buttons || buttonsFor(item),
    issues: issues.slice(0, 3),
  };
  reply(session, text, meta);
  if (clarify) {
    // La aclaración invita a volver a responder; un reenvío idéntico no es spam.
    session.meta.spamBurst = 0;
    session.meta.previousInboundNorm = '';
  }
  event(session, 'question.asked', { itemId: item.id, clarify, step: step?.key || null });
}

function q21Step(session) {
  const item = getItem('Q21');
  return item?.q21Steps?.[session.q21Step] || null;
}

function currentPrompt(session) {
  const item = getItem(session.currentItemId);
  if (!item) return null;
  if (item.id === 'Q21') {
    const step = q21Step(session);
    return step ? { item, step, text: step.prompt } : null;
  }
  return { item, step: null, text: item.prompt };
}

function formatIsoDateEs(value) {
  const text = String(value || '');
  const MONTH_NAMES = [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre',
  ];
  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${Number(m[3])} de ${MONTH_NAMES[Number(m[2]) - 1]} de ${m[1]}`;
  m = text.match(/^(\d{4})-(\d{2})$/);
  if (m) return `${MONTH_NAMES[Number(m[2]) - 1]} de ${m[1]}`;
  return text;
}

function currentClarifyItem(session, current) {
  if (!current) return null;
  const subfields = current.step?.subfields || current.item.subfields;
  return {
    ...current.item,
    label: current.step?.label || current.item.label,
    clarify: current.item.clarify,
    example: current.item.example,
    subfields,
  };
}

function clarifyPrompt(item, { missing = [], issue = '', normalized = null } = {}) {
  const parts = [];
  // Si hay un error concreto, ese mensaje ya explica qué pasó y cómo
  // corregirlo. No añadimos "me falta…" ni repetimos la aclaración.
  if (issue) {
    parts.push(issue);
  } else {
    const labelNorm = String(item.label || '').toLowerCase().trim();
    const pending = missing.filter((fieldLabel) => String(fieldLabel || '').toLowerCase().trim() !== labelNorm);
    if (pending.length) parts.push(`Para completar «${item.label}» me falta: ${pending.join(', ')}.`);
    if (item.clarify) parts.push(item.clarify);
    if (item.example) parts.push(item.example);
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text || '¿Me lo explicas con un poco más de detalle?';
}

function confirmationText(item, value) {
  if (item.format === 'personal_data' && value && typeof value === 'object') {
    const parts = [];
    if (value.nombre_completo) parts.push(String(value.nombre_completo));
    if (value.edad) parts.push(`${value.edad} años`);
    if (value.fecha_nacimiento) parts.push(formatIsoDateEs(value.fecha_nacimiento));
    if (value.lugar_nacimiento) parts.push(`nacido(a) en ${value.lugar_nacimiento}`);
    return parts.join(', ') || '—';
  }
  return humanValue(value).slice(0, 180);
}

function commitAnswer(session, item, data) {
  const existing = session.items[item.id] || {};
  const record = {
    ...existing,
    status: data.status,
    rawText: data.rawText ?? existing.rawText ?? '',
    displayValue: data.displayValue ?? data.rawText ?? existing.displayValue ?? '',
    normalized: data.normalized ?? existing.normalized ?? null,
    extracted: data.extracted || existing.extracted || {},
    validation: data.validation || existing.validation || null,
    score: data.score ?? existing.score ?? null,
    coverage: data.coverage ?? existing.coverage ?? null,
    issues: data.issues || [],
    attempts: data.attempts ?? existing.attempts ?? 1,
    source: data.source || existing.source || 'text',
    voice: data.voice || existing.voice || null,
    attachment: data.attachment || existing.attachment || null,
    answeredAt: iso(session),
    updatedAt: iso(session),
    editedAt: existing.editedAt || null,
    meta: data.meta || {},
  };
  session.items[item.id] = record;
  // La respuesta fue procesada: un próximo mensaje idéntico no es spam.
  session.meta.spamBurst = 0;
  session.meta.previousInboundNorm = '';
  updateProgress(session);
  event(session, `answer.${data.status.toLowerCase()}`, {
    itemId: item.id,
    score: record.score,
    coverage: record.coverage,
  });
  audit(
    session,
    `answer.${data.status.toLowerCase()}`,
    { itemId: item.id, score: record.score, coverage: record.coverage, source: record.source },
    data.actor || 'system',
    data.status.toLowerCase(),
  );
  return record;
}

function markSkipped(session, item, text, source = 'text') {
  commitAnswer(session, item, {
    status: 'SKIPPED',
    rawText: text,
    displayValue: 'No respondido',
    score: 0,
    coverage: 0,
    issues: [],
    source,
  });
  reply(session, 'Está bien, lo dejo pendiente.');
  advance(session, item);
}

function nextSectionStart(session, sectionId) {
  const item = firstItemOfSection(sectionId);
  if (!item) return;
  askQuestion(session, item);
}

function sendSectionReview(session, sectionId) {
  const section = getSection(sectionId);
  if (!section) return;
  session.sectionReview = { sectionId, at: iso(session) };
  session.currentItemId = null;
  const lines = summaryLines(session, { sectionId });
  const chunks = chunkLines(lines, 620);
  if (!chunks.length) chunks.push(`— ${section.name} —\nSin respuestas registradas.`);
  chunks.forEach((chunk, idx) => {
    const last = idx === chunks.length - 1;
    reply(
      session,
      `${idx === 0 ? `Revisemos ${section.name.toLowerCase()}:\n` : ''}${chunk}${last ? '\n\n¿Está todo correcto?' : ''}`,
      {
        kind: 'section_review',
        sectionId,
        part: idx,
        buttons: last
          ? [
              { id: 'review_yes', label: 'Todo correcto' },
              { id: 'review_no', label: 'Corregir' },
            ]
          : [],
      },
    );
  });
  event(session, 'section.review', { sectionId });
}

function sendFullSummary(session) {
  session.sectionIntro ||= true;
  sectionIntro(session, 'H');
  const chunks = fullSummaryChunks(session, 620);
  if (!chunks.length) chunks.push('Todavía no hay respuestas registradas.');
  chunks.forEach((chunk, idx) => {
    reply(
      session,
      `${idx === 0 ? 'Este es el resumen de tu entrevista:\n' : ''}${chunk}`,
      { kind: 'summary', part: idx },
    );
  });
  session.currentItemId = 'C01';
  session.currentSectionId = 'H';
  session.sectionReview = null;
  askQuestion(session, getItem('C01'), {
    buttons: [
      { id: 'summary_yes', label: 'Sí, está correcto' },
      { id: 'summary_no', label: 'Quiero corregir algo' },
    ],
  });
  event(session, 'summary.shown', { chunks: chunks.length });
}

function advance(session, item) {
  if (session.correctionReturn) {
    const destination = session.correctionReturn;
    session.correctionReturn = null;
    if (destination.type === 'section') return sendSectionReview(session, destination.sectionId);
    return sendFullSummary(session);
  }
  if (!item) return;
  if (item.id === 'C01') {
    completeSession(session);
    return;
  }
  const section = getSection(item.sectionId);
  if (!section) return;
  const items = sectionItems(section.id);
  const lastInSection = items[items.length - 1].id === item.id;
  if (lastInSection) {
    if (section.id === 'H') return completeSession(session);
    return sendSectionReview(session, section.id);
  }
  const next = nextItemId(item.id);
  if (next) askQuestion(session, getItem(next));
}

function startConversation(session) {
  if (session.status !== 'NEW') return;
  const name = firstName(session.name);
  reply(
    session,
    `Hola, ${name}. Soy el asistente de entrevista inicial de Biohipnosis Sistémica.`,
    { kind: 'greeting' },
  );
  reply(
    session,
    `Te haré ${totalItems()} preguntas breves, una por mensaje, para que tu profesional llegue mejor preparado. Puedes responder por texto o nota de voz, pausar y continuar después. No reemplaza la atención médica.`,
    { kind: 'greeting' },
  );
  session.status = 'AGE_PENDING';
  reply(session, 'Antes de empezar: ¿confirmas que tienes 18 años o más?', {
    kind: 'age_check',
    buttons: [
      { id: 'age_yes', label: 'Sí, tengo 18 años o más' },
      { id: 'age_no', label: 'No' },
    ],
  });
  event(session, 'conversation.started', {});
  audit(session, 'conversation.started', {}, 'system', 'start');
}

function handleAge(session, text) {
  if (isConsentYes(text) || /18|mayor de edad|adulto/i.test(text)) {
    session.ageConfirmed = true;
    session.ageConfirmedAt = iso(session);
    session.status = 'CONSENT_PENDING';
    reply(
      session,
      `Gracias. ${config.consent.text}`,
      {
        kind: 'consent',
        privacy: true,
        privacyPath: config.consent.privacyPath,
        buttons: [
          { id: 'consent_yes', label: 'Acepto' },
          { id: 'consent_no', label: 'No acepto' },
        ],
      },
    );
    event(session, 'age.confirmed', {});
    audit(session, 'consent.age_confirmed', {}, 'data-subject', 'confirm');
    return;
  }
  if (isConsentNo(text) || /\bno\b/.test(normalizeForMatch(text))) {
    reply(session, minorReply());
    session.status = 'OPTED_OUT';
    session.meta.eraseOnReply = true;
    event(session, 'age.declined', {});
    audit(session, 'consent.minor_blocked', {}, 'system', 'block');
    return;
  }
  reply(session, 'Para continuar necesito que confirmes si tienes 18 años o más. Responde “sí” o “no”.', {
    kind: 'age_check',
    buttons: [
      { id: 'age_yes', label: 'Sí, tengo 18 años o más' },
      { id: 'age_no', label: 'No' },
    ],
  });
}

function handleConsent(session, text) {
  if (isConsentYes(text)) {
    session.consent = {
      version: config.consent.version,
      granted: true,
      grantedAt: iso(session),
      channel: 'whatsapp-simulated',
      evidence: {
        waId: session.waId,
        ageConfirmedAt: session.ageConfirmedAt,
        textHash: 'sha256:' + randomId('', 16),
      },
    };
    session.status = 'IN_PROGRESS';
    session.currentSectionId = 'A';
    session.currentItemId = 'D01';
    reply(session, 'Gracias. Empecemos. Puedes responder con tus palabras; si algo no aplica, dilo.', {
      kind: 'consent_accepted',
    });
    event(session, 'consent.granted', { version: config.consent.version });
    audit(session, 'consent.granted', { version: config.consent.version }, 'data-subject', 'grant');
    askQuestion(session, getItem('D01'));
    return;
  }
  if (isConsentNo(text)) {
    reply(session, consentDeclineReply());
    session.status = 'OPTED_OUT';
    session.consent = { version: config.consent.version, granted: false, declinedAt: iso(session) };
    session.meta.eraseOnReply = true;
    event(session, 'consent.declined', {});
    audit(session, 'consent.declined', {}, 'data-subject', 'decline');
    return;
  }
  reply(session, 'Para empezar necesito tu consentimiento. Responde “Acepto” o “No acepto”.', {
    kind: 'consent',
    privacy: true,
    buttons: [
      { id: 'consent_yes', label: 'Acepto' },
      { id: 'consent_no', label: 'No acepto' },
    ],
  });
}

function pause(session, reason = 'user') {
  session.status = 'PAUSED';
  session.meta.pausedAt = iso(session);
  session.meta.reminderDueAt = new Date(nowMs(session) + 24 * 3_600_000).toISOString();
  session.meta.reminderSent = false;
  reply(session, pauseReply(), {
    kind: 'pause',
    buttons: [{ id: 'resume', label: 'Continuar' }],
  });
  event(session, 'session.paused', { reason });
  audit(session, 'session.paused', { reason }, reason === 'user' ? 'data-subject' : 'system', 'pause');
}

function resume(session, actor = 'data-subject') {
  session.status = 'IN_PROGRESS';
  session.meta.resumedAt = iso(session);
  const current = currentPrompt(session);
  reply(session, 'Retomamos donde quedamos.');
  if (session.sectionReview) {
    sendSectionReview(session, session.sectionReview.sectionId);
  } else if (current) {
    askQuestion(session, current.item, { step: current.step });
  } else {
    const first = firstItemOfSection(session.currentSectionId || 'A');
    if (first) askQuestion(session, first);
  }
  event(session, 'session.resumed', {});
  audit(session, 'session.resumed', {}, actor, 'resume');
}

function maybeReminder(session) {
  if (session.status !== 'PAUSED') return false;
  if (session.meta.reminderSent) return false;
  const due = session.meta.reminderDueAt ? Date.parse(session.meta.reminderDueAt) : Infinity;
  if (nowMs(session) < due) return false;
  session.meta.reminderSent = true;
  session.counters.reminders += 1;
  recordTurn({ direction: 'out' });
  addMessage(session, {
    direction: 'out',
    type: 'template',
    text: 'Hola. Han pasado 24 horas desde que pausamos tu entrevista. Cuando puedas, responde “Continuar” y retomamos donde quedamos. Si prefieres no seguir, escribe “detener”.',
    meta: {
      kind: 'template',
      template: 'recordatorio_entrevista_24h',
      buttons: [{ id: 'resume', label: 'Continuar' }],
    },
  });
  event(session, 'reminder.sent', {});
  audit(session, 'reminder.sent', { template: 'recordatorio_entrevista_24h' }, 'system', 'send');
  return true;
}

function handleCrisis(session, screen, text, source = 'deterministic') {
  const level = screen.crisis.level === 'critical' ? 'critical' : 'high';
  setRisk(session, level, screen.crisis.signals, source);
  session.status = 'ESCALATED';
  session.meta.crisisAt = iso(session);
  session.meta.pendingCrisisText = text.slice(0, 200);
  const existing = session.meta.escalationNotified;
  if (!existing) {
    session.meta.escalationNotified = iso(session);
    reply(session, crisisReply(), {
      kind: 'crisis',
      buttons: [
        { id: 'crisis_contact', label: 'Quiero que me contacten' },
        { id: 'crisis_ok', label: 'Ya estoy bien, continuar' },
      ],
    });
  } else {
    reply(
      session,
      'Sigo aquí. Si estás en peligro inmediato, llama al 123. Para apoyo emocional, la línea 106; violencia, 155; menores, 141. La entrevista sigue en pausa y un profesional fue alertado.',
      {
        kind: 'crisis',
        buttons: [
          { id: 'crisis_contact', label: 'Quiero que me contacten' },
          { id: 'crisis_ok', label: 'Ya estoy bien, continuar' },
        ],
      },
    );
  }
  audit(session, 'safety.crisis_escalated', { signals: screen.crisis.signals, level }, 'system', 'escalate');
}

function safeToResume(text) {
  return /\b(ya estoy bien|estoy mejor|no estoy en peligro|puedo continuar|sigamos|continuemos|continuar)\b/.test(
    normalizeForMatch(text),
  );
}

function handleEscalated(session, text) {
  if (/contact|llam|profesional|ayuda/i.test(normalizeForMatch(text)) && !safeToResume(text)) {
    session.status = 'HANDOFF';
    session.meta.contactRequestedAt = iso(session);
    reply(session, 'Avisé a un profesional para que se comunique contigo. Mientras tanto, si estás en peligro inmediato, llama al 123.', {
      kind: 'handoff',
    });
    event(session, 'handoff.crisis', {});
    audit(session, 'handoff.crisis', {}, 'system', 'handoff');
    return;
  }
  if (safeToResume(text)) {
    session.status = 'IN_PROGRESS';
    session.riskLevel = 'medium';
    session.escalations = session.escalations.map((e) => (e.status === 'open' ? { ...e, status: 'acknowledged', resolvedAt: iso(session) } : e));
    reply(session, 'Gracias por decírmelo. Retomamos con calma. Si en algún momento el riesgo vuelve, dime “pausa” y llamamos a un profesional.');
    const current = currentPrompt(session);
    if (current) askQuestion(session, current.item, { step: current.step });
    else {
      const first = firstItemOfSection(session.currentSectionId || 'A');
      if (first) askQuestion(session, first);
    }
    event(session, 'crisis.acknowledged', {});
    audit(session, 'safety.crisis_acknowledged', {}, 'data-subject', 'resume');
    return;
  }
  handleCrisis(
    session,
    { crisis: { level: 'high', signals: ['follow-up-during-escalation'] } },
    text,
    'follow-up',
  );
}

function handleHuman(session) {
  session.status = 'HANDOFF';
  session.meta.handoffAt = iso(session);
  session.escalations.push({
    id: randomId('esc_', 6),
    at: iso(session),
    level: 'medium',
    signals: ['human-requested'],
    source: 'deterministic',
    status: 'open',
  });
  reply(session, humanReply(), { kind: 'handoff' });
  event(session, 'handoff.requested', {});
  audit(session, 'handoff.requested', {}, 'data-subject', 'handoff');
}

function handleErasure(session) {
  session.status = 'ERASED';
  session.meta.eraseOnReply = true;
  reply(session, erasureReply());
  event(session, 'erasure.requested', {});
  audit(session, 'erasure.requested', {}, 'data-subject', 'erase');
}

function handleOptOut(session) {
  session.status = 'OPTED_OUT';
  reply(session, optOutReply());
  event(session, 'optout', {});
  audit(session, 'optout', {}, 'data-subject', 'optout');
}

function buildPendingConfirmation(session, item, data) {
  session.pendingConfirmation = {
    type: 'critical',
    itemId: item.id,
    data,
    at: iso(session),
  };
  const label = confirmationText(item, data.displayValue ?? data.rawText);
  reply(session, `Entendí: ${label}. ¿Es correcto?`, {
    kind: 'confirm',
    itemId: item.id,
    buttons: [
      { id: 'confirm_yes', label: 'Sí, es correcto' },
      { id: 'confirm_no', label: 'No, corregir' },
    ],
  });
  event(session, 'answer.confirm_requested', { itemId: item.id });
}

function commitFromPending(session, pending) {
  const item = getItem(pending.itemId);
  if (!item) return null;
  const record = commitAnswer(session, item, { ...pending.data, status: 'CONFIRMED' });
  session.pendingConfirmation = null;
  return record;
}

function handlePendingConfirmation(session, text) {
  const pending = session.pendingConfirmation;
  if (!pending) return false;

  if (isAffirmative(text) || /correcto|confirmo|sí, es correcto/.test(normalizeForMatch(text))) {
    const item = getItem(pending.itemId);
    const record = commitFromPending(session, pending);
    if (record) {
      reply(session, 'Gracias, queda confirmado.');
      advance(session, item);
    }
    return true;
  }
  if (isNegative(text) || isCorrectionRequest(text)) {
    session.pendingConfirmation = null;
    const item = getItem(pending.itemId);
    if (item) {
      session.items[item.id] = {
        ...(session.items[item.id] || {}),
        status: 'CLARIFYING',
        attempts: (session.items[item.id]?.attempts || 0) + 1,
        issues: ['El consultante rechazó la confirmación.'],
        updatedAt: iso(session),
      };
      askQuestion(session, item, { clarify: true, clarifyText: clarifyPrompt(item) });
    }
    return true;
  }
  // A direct corrected value is treated as a fresh answer.
  session.pendingConfirmation = null;
  return false;
}

function handleSectionReview(session, text) {
  if (!session.sectionReview) return false;
  if (isAffirmative(text) || /todo correcto|correcto/.test(normalizeForMatch(text))) {
    const sectionId = session.sectionReview.sectionId;
    session.sectionReview = null;
    const next = nextSectionId(sectionId);
    if (!next) return sendFullSummary(session), true;
    if (next === 'H') return sendFullSummary(session), true;
    const first = firstItemOfSection(next);
    if (first) askQuestion(session, first);
    event(session, 'section.confirmed', { sectionId });
    audit(session, 'section.confirmed', { sectionId }, 'data-subject', 'confirm');
    return true;
  }
  if (isNegative(text) || isCorrectionRequest(text) || /corregir/.test(normalizeForMatch(text))) {
    const sectionId = session.sectionReview.sectionId;
    session.pendingCorrection = { scope: 'section', sectionId };
    session.sectionReview = null;
    const items = sectionItems(sectionId);
    const list = items.map((item, idx) => `${idx + 1}. ${item.label} (${item.id})`).join('\n');
    reply(session, `Dime el número o el nombre del dato que quieres corregir:\n${list}`, {
      kind: 'correction_list',
      sectionId,
      items: items.map((i) => ({ id: i.id, label: i.label })),
    });
    return true;
  }
  const match = matchItemByText(text, { scope: 'section', sectionId: session.sectionReview.sectionId });
  if (match) {
    startCorrection(session, match.item, { type: 'section', sectionId: session.sectionReview.sectionId });
    return true;
  }
  reply(session, 'Responde “Todo correcto” o dime qué dato quieres corregir.');
  return true;
}

function matchItemByText(text, { scope = 'all', sectionId = null } = {}) {
  const n = normalizeForMatch(text);
  const pool = scope === 'section' ? sectionItems(sectionId) : ITEMS;
  const num = n.match(/\b(\d{1,2})\b/);
  if (num) {
    const idx = Number(num[1]) - 1;
    if (idx >= 0 && idx < pool.length) return { item: pool[idx], index: idx };
  }
  for (const item of pool) {
    if (n.includes(normalizeForMatch(item.id))) return { item, index: pool.indexOf(item) };
  }
  const exact = pool.find((item) => n.includes(normalizeForMatch(item.label)));
  if (exact) return { item: exact, index: pool.indexOf(exact) };
  const keywordMatches = pool
    .map((item) => ({
      item,
      score: (item.subfields || []).reduce(
        (sum, f) => sum + (f.keywords || []).filter((k) => n.includes(normalizeForMatch(k))).length,
        0,
      ),
    }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);
  if (keywordMatches.length) return { item: keywordMatches[0].item, index: pool.indexOf(keywordMatches[0].item) };
  return null;
}

function startCorrection(session, item, returnTo) {
  session.pendingCorrection = null;
  session.correctionReturn = returnTo;
  session.counters.corrections += 1;
  session.currentSectionId = item.sectionId;
  session.currentItemId = item.id;
  if (item.id === 'Q21') session.q21Step = 0;
  reply(session, `Vamos a corregir “${item.label}”.`);
  askQuestion(session, item, {
    clarify: true,
    clarifyText: item.clarify || '¿Cuál es el dato correcto?',
  });
  event(session, 'correction.started', { itemId: item.id, returnTo: returnTo.type });
  audit(session, 'answer.correction_started', { itemId: item.id }, 'data-subject', 'correct');
}

function handleCorrectionTarget(session, text) {
  if (!session.pendingCorrection) return false;
  const { scope, sectionId } = session.pendingCorrection;
  const match = matchItemByText(text, { scope, sectionId });
  if (!match) {
    reply(session, 'No identifiqué ese dato. Escribe el nombre exacto o el número de la lista.');
    return true;
  }
  startCorrection(session, match.item, scope === 'section' ? { type: 'section', sectionId } : { type: 'full' });
  return true;
}

function handleSummaryAnswer(session, text) {
  if (isAffirmative(text)) {
    commitAnswer(session, getItem('C01'), {
      status: 'CONFIRMED',
      rawText: text,
      displayValue: 'Confirmado',
      score: 1,
      coverage: 1,
    });
    session.sectionReview = null;
    completeSession(session);
    event(session, 'summary.confirmed', {});
    audit(session, 'summary.confirmed', {}, 'data-subject', 'confirm');
    return;
  }
  if (isNegative(text) || isCorrectionRequest(text)) {
    session.pendingCorrection = { scope: 'full' };
    session.sectionReview = null;
    const sections = SECTIONS.map((s) => `${s.id}. ${s.name}`).join('\n');
    reply(session, `Dime qué dato quieres corregir. Puedes escribir el nombre del dato o su número de ítem.\n\nSecciones:\n${sections}`, {
      kind: 'correction_list',
      scope: 'full',
    });
    return;
  }
  reply(session, 'Responde “Sí, está correcto” o dime qué quieres corregir.', {
    kind: 'question',
    itemId: 'C01',
    buttons: [
      { id: 'summary_yes', label: 'Sí, está correcto' },
      { id: 'summary_no', label: 'Quiero corregir algo' },
    ],
  });
}

function completeSession(session) {
  if (session.status === 'COMPLETED') return;
  session.summary = summaryRecord(session, { reveal: false });
  session.summary.generatedAt = iso(session);
  session.completedAt = iso(session);
  session.status = 'COMPLETED';
  updateProgress(session);
  reply(
    session,
    `Listo, ${firstName(session.name)}. El resumen de tu entrevista quedó guardado y tu profesional podrá consultarlo. Si necesitas corregir algo, escribe “corregir”. Para eliminar tus datos, escribe “borra mis datos”.`,
    { kind: 'completed' },
  );
  event(session, 'session.completed', {});
  audit(session, 'session.completed', { items: session.progress.answered }, 'data-subject', 'complete');
  recordSessionCompleted();
}

async function handleVoiceConfirmation(session, text) {
  const n = normalizeForMatch(text);
  if (isAffirmative(text) || /\b(correcto|confirmo|si, es correcto|asi es)\b/.test(n)) {
    const pending = session.pendingVoice;
    session.pendingVoice = null;
    if (pending) {
      const input = { ...pending.input, voice: { ...pending.input.voice, needsConfirmation: false } };
      await processAnswer(session, pending.text, input, { fromVoiceConfirm: true });
    }
    return true;
  }
  if (isNegative(text) || /\b(repetir|no, repetir|incorrecto|no es correcto)\b/.test(n)) {
    session.pendingVoice = null;
    reply(session, 'Entendido. Graba de nuevo la nota de voz o escríbela.');
    return true;
  }
  return false;
}

async function processAnswer(session, text, input, ctx) {
  const item = getItem(session.currentItemId);
  if (!item) {
    const first = firstItemOfSection(session.currentSectionId || 'A');
    if (first) askQuestion(session, first);
    return;
  }
  if (item.id === 'C01') return handleSummaryAnswer(session, text);

  // Saludos y acks breves (“hola”, “gracias”, “ok”) no son respuesta:
  // se saluda cordialmente y se repite la pregunta sin consumir intentos.
  if (!input.voice && item.id !== 'Q21' && isSmallTalk(text)) {
    const smallCurrent = currentPrompt(session);
    reply(session, smallTalkAckReply(item.label, smallCurrent?.text || item.prompt), {
      kind: 'smalltalk_ack',
      itemId: item.id,
    });
    event(session, 'message.smalltalk_ack', { itemId: item.id });
    return;
  }

  if (input.attachment) {
    const validation = validateAttachment(input.attachment);
    if (!validation.ok) {
      reply(session, `${validation.issue} Intenta de nuevo o escribe “no tengo”.`, {
        kind: 'attachment_error',
      });
      event(session, 'attachment.rejected', { code: validation.code });
      audit(session, 'security.attachment_rejected', { code: validation.code }, 'data-subject', 'block');
      askQuestion(session, item, { clarify: true, clarifyText: item.clarify });
      return;
    }
    const fileId = randomId('fil_', 9);
    const file = storeAttachment(session.id, validation, fileId);
    const attachment = {
      id: fileId,
      name: validation.name,
      mime: validation.mime,
      kind: validation.kind,
      bytes: validation.bytes,
      sha256: validation.sha256,
      file,
      storedAt: iso(session),
    };
    input.extraAttachment = attachment;
  }
  if (item.id === 'Q21') return processFamilyTree(session, text, input, ctx);

  if (isSkip(text) && !item.critical && item.id !== 'D07') {
    return markSkipped(session, item, text, input.voice ? 'voice' : 'text');
  }

  const source = input.voice ? 'voice' : 'text';
  if (input.voice?.needsConfirmation) {
    session.pendingVoice = { text, input };
    reply(
      session,
      `La transcripción tiene confianza ${Math.round(input.voice.confidence * 100)}% y puede tener errores. ¿Es correcto esto: “${text.slice(0, 240)}”?`,
      {
        kind: 'voice_confirm',
        buttons: [
          { id: 'voice_yes', label: 'Sí, es correcto' },
          { id: 'voice_no', label: 'No, repetir' },
        ],
      },
    );
    return;
  }

  const existing = session.items[item.id] || {};
  const attempts = existing.attempts || 0;
  const recent = (session.messages || [])
    .filter((m) => m.type !== 'template' && m.text)
    .slice(-6)
    .map((m) => ({ rol: m.direction === 'in' ? 'usuario' : 'asistente', texto: m.text.slice(0, 200) }));

  const useLlm = budgetAllowsLlm(session);
  let analysis;
  let meta;
  if (useLlm) {
    const result = await analyze({ item, text, session, recent });
    analysis = result.analysis;
    meta = result.meta;
    addBudget(session, meta);
  } else {
    analysis = {
      ack: 'Gracias.',
      extracted: {},
      coverage: {},
      validation: heuristicScores(item, text, {}),
      risk: { level: 'none', signals: [] },
      off_topic: false,
      notes: session.budget.exhausted ? 'budget-exhausted' : 'daily-budget-exhausted',
      heuristic: true,
    };
    meta = {
      model: 'deterministic',
      fallback: true,
      latencyMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      failureReason: analysis.notes,
    };
  }

  if (analysis.risk?.level === 'high' || analysis.risk?.level === 'critical') {
    handleCrisis(
      session,
      { crisis: { level: analysis.risk.level, signals: analysis.risk.signals || ['model-risk'] } },
      text,
      'model',
    );
    return;
  }

  const validation = validateField(item, text, analysis.extracted);
  if (validation.minor) {
    reply(session, minorReply());
    session.status = 'OPTED_OUT';
    session.meta.eraseOnReply = true;
    audit(session, 'consent.minor_blocked', { itemId: item.id }, 'system', 'block');
    return;
  }

  const coverageFields = (item.subfields || []).filter((field) => !field.optional);
  const coverageValues = coverageFields.map((field) => Number(analysis.coverage?.[field.key] || 0));
  const avgCoverage = coverageValues.length
    ? coverageValues.reduce((a, b) => a + Number(b || 0), 0) / coverageValues.length
    : 0;
  const negativeComplete =
    coverageFields.length > 1 && isNegativeComplete(text);
  let coverage = Math.max(avgCoverage, heuristicCoverage(text, item.subfields || []));
  const normCoverage = coverageFromNormalized(validation.normalized, item);
  if (normCoverage != null) coverage = Math.max(coverage, normCoverage);
  if (negativeComplete) coverage = 1;
  if (validation.ok) {
    const choiceFormats = new Set([
      'date_place',
      'date_text',
      'children',
      'option',
      'yesno',
      'handedness',
      'short',
      'email',
      'phone',
      'age',
      'age_autonomy',
      'number',
    ]);
    if (choiceFormats.has(item.format || item.type)) coverage = 1;
  }
  const heuristic = heuristicScores(item, text, analysis.extracted);
  const allZero = ['relevance', 'completeness', 'specificity', 'coherence'].every(
    (k) => Number(analysis.validation?.[k] || 0) === 0,
  );
  const modelScores = allZero ? heuristic : analysis.validation || heuristic;
  const merged = {
    relevance: Number(modelScores.relevance ?? heuristic.relevance),
    completeness: Math.max(Number(modelScores.completeness ?? 0), coverage, heuristic.completeness),
    specificity: Number(modelScores.specificity ?? heuristic.specificity),
    coherence: Number(modelScores.coherence ?? heuristic.coherence),
    safety: Number(modelScores.safety ?? 1),
  };
  let score = weightedScore(merged);
  const issues = [...validation.issues];
  if (coverage < 0.7 && (item.subfields?.length || 0) > 1) issues.push('Faltan partes de la respuesta.');
  if (validation.hardFail) score = Math.min(score, 0.44);
  else if (issues.length && coverage < 0.7) score = Math.min(score, 0.62);

  if (analysis.off_topic && merged.relevance < 0.35 && text.length > 10) {
    reply(session, offTopicReply());
    const missing = missingSubfields(item, text, analysis.extracted, validation.normalized);
    askQuestion(session, item, { clarify: true, clarifyText: clarifyPrompt(item, { missing }) });
    event(session, 'answer.off_topic', { itemId: item.id });
    return;
  }

  const nonsense = analysis.heuristic ? detectNonsense(text) : { detected: false, signals: [] };
  const looksNonsense = analysis.heuristic && nonsense.detected;
  if (looksNonsense) {
    session.counters.nonsense = (session.counters.nonsense || 0) + 1;
    if (session.counters.nonsense >= config.limits.maxNonsenseMessages) {
      pauseForReview(session, 'nonsense');
      return;
    }
    event(session, 'answer.nonsense', { itemId: item.id, signals: nonsense.signals });
    audit(session, 'security.nonsense_input', { itemId: item.id, signals: nonsense.signals }, 'system', 'flag');
  }

  const displayValue = validation.normalized ?? text;
  const data = {
    rawText: text,
    displayValue,
    normalized: validation.normalized ?? text,
    extracted: analysis.extracted || {},
    validation: merged,
    score,
    coverage,
    issues,
    attempts: attempts + 1,
    source,
    voice: input.voice || null,
    attachment: input.extraAttachment || null,
  };

  const canAccept = !validation.hardFail && issues.length === 0 && score >= 0.75 && coverage >= 0.7;
  if (canAccept) {
    if (!ctx.fromVoiceConfirm && (item.critical || source === 'voice')) {
      buildPendingConfirmation(session, item, data);
      return;
    }
    commitAnswer(session, item, { ...data, status: 'ACCEPTED' });
    const ack = sanitizeAck(analysis.ack || '');
    if (ack && ack !== 'Gracias.') reply(session, ack);
    advance(session, item);
    return;
  }

  const shouldClarify = attempts < config.limits.maxClarificationsPerItem;
  if (shouldClarify) {
    session.items[item.id] = {
      ...existing,
      status: 'CLARIFYING',
      rawText: text,
      displayValue,
      normalized: validation.normalized ?? text,
      extracted: analysis.extracted || {},
      validation: merged,
      score,
      coverage,
      issues,
      attempts: attempts + 1,
      updatedAt: iso(session),
      source,
    };
    updateProgress(session);
    session.counters.clarifications += 1;
    const missing = missingSubfields(item, text, analysis.extracted, validation.normalized);
    const clarifyText = looksNonsense
      ? nonsenseClarifyReply(item, missing)
      : clarifyPrompt(item, {
        missing,
        issue: validation.hardFail ? validation.issues[0] || issues[0] : missing.length ? '' : issues[0] || '',
      });
    askQuestion(session, item, { clarify: true, clarifyText, issues });
    event(session, 'answer.clarify', { itemId: item.id, score, coverage, missing });
    audit(session, 'answer.clarify', { itemId: item.id, score, coverage, missing }, 'system', 'clarify');
    return;
  }

  const missing = missingSubfields(item, text, analysis.extracted, validation.normalized);
  commitAnswer(session, item, { ...data, status: 'PARTIAL' });
  if (looksNonsense) {
    reply(session, nonsensePartialReply(missing));
  } else {
    reply(
      session,
      missing.length
        ? `Gracias. Registro esta respuesta como parcial porque aún falta: ${missing.join(', ')}. Tu profesional podrá ampliarlo.`
        : 'Gracias, lo registro como respuesta parcial. Tu profesional podrá ampliarlo.',
    );
  }
  advance(session, item);
}

async function processFamilyTree(session, text, input, ctx) {
  const item = getItem('Q21');
  const step = q21Step(session);
  if (!step) {
    commitAnswer(session, item, {
      status: 'PARTIAL',
      rawText: 'Árbol incompleto',
      displayValue: 'Árbol incompleto',
      score: 0,
      coverage: 0,
    });
    advance(session, item);
    return;
  }
  const normalized = normalizeForMatch(text);
  const noInfo = isSkip(text) || /no tengo informacion|no se|sin datos|no conozco/.test(normalized);
  const tooShort = cleanText(text).split(/\s+/).filter(Boolean).length < 3 && !noInfo;
  if (tooShort && (session.meta.q21Attempts?.[step.key] || 0) < 1) {
    session.meta.q21Attempts ||= {};
    session.meta.q21Attempts[step.key] = (session.meta.q21Attempts[step.key] || 0) + 1;
    askQuestion(session, item, {
      step,
      clarify: true,
      clarifyText: 'Puedes darme solo lo que sepas, aunque sea parcial. Si falta algo, escribe “no tengo información”.',
    });
    return;
  }
  const record = {
    key: step.key,
    label: step.label,
    status: noInfo ? 'SKIPPED' : 'ACCEPTED',
    text: noInfo ? '' : text,
    at: iso(session),
  };
  session.q21Steps.push(record);
  session.q21Step += 1;
  session.meta.spamBurst = 0;
  session.meta.previousInboundNorm = '';
  event(session, 'family_tree.step', { key: step.key, status: record.status });
  if (session.q21Step < item.q21Steps.length) {
    reply(session, noInfo ? 'Está bien, lo dejo así.' : 'Gracias.');
    askQuestion(session, item, { step: q21Step(session) });
    return;
  }
  const skipped = session.q21Steps.filter((s) => s.status === 'SKIPPED').length;
  commitAnswer(session, item, {
    status: skipped >= 4 ? 'SKIPPED' : skipped > 0 ? 'PARTIAL' : 'ACCEPTED',
    rawText: session.q21Steps.map((s) => `${s.label}: ${s.text || 'sin información'}`).join('\n'),
    displayValue: `${session.q21Steps.length} generaciones registradas`,
    extracted: { personas: session.q21Steps.map((s) => s.text).filter(Boolean) },
    score: skipped ? 0.6 : 0.8,
    coverage: 1 - skipped / 4,
    issues: skipped ? ['Partes del árbol sin información.'] : [],
    source: input.voice ? 'voice' : 'text',
  });
  reply(session, 'Gracias. Con esto queda armada la estructura de tu árbol familiar.');
  advance(session, item);
}

export async function handleInbound(session, input = {}, ctx = {}) {
  const button = input.buttonId ? resolveButton(session, input.buttonId) : null;
  const text = cleanText(button || input.text || input.voice?.transcript || '');
  const actor = ctx.actor || 'data-subject';
  const origin = ctx.origin || 'chat';

  if (input.waMessageId) {
    const duplicate = session.messages.find(
      (m) => m.direction === 'in' && m.waMessageId === input.waMessageId,
    );
    if (duplicate) {
      event(session, 'message.duplicate', { waMessageId: input.waMessageId });
      audit(session, 'message.duplicate', { waMessageId: input.waMessageId }, actor, 'ignore');
      return { replies: [], duplicate: true, session, erase: false };
    }
  }

  if (input.attachment) {
    // Validate before persisting the message so malicious files never enter chat.
    const check = validateAttachment(input.attachment);
    if (!check.ok) {
      const msg = addMessage(session, {
        direction: 'in',
        type: 'text',
        text: '[archivo rechazado]',
        meta: { rejectedAttachment: input.attachment.name, code: check.code },
        waMessageId: input.waMessageId || null,
      });
      reply(session, `${check.issue} No guardé el archivo.`);
      session.counters.blocked += 1;
      event(session, 'attachment.rejected', { code: check.code });
      audit(session, 'security.attachment_rejected', { code: check.code, name: input.attachment.name }, actor, 'block');
      updateProgress(session);
      recordTurn({ direction: 'in' });
      return { replies: [msg], session, erase: false };
    }
  }

  if (input.voice) {
    const check = validateVoice(input.voice);
    if (!check.ok) {
      reply(session, check.issue);
      session.counters.blocked += 1;
      audit(session, 'security.voice_rejected', { reason: check.issue }, actor, 'block');
      return { replies: [], session, erase: false };
    }
    input.voice = check;
  }

  if (!text && !input.attachment) {
    reply(session, 'No recibí un mensaje. ¿Puedes escribirlo o enviarlo de nuevo?');
    return { replies: [], session, erase: false };
  }

  const inboundType = input.attachment ? 'document' : input.voice ? 'audio' : 'text';
  addMessage(session, {
    direction: 'in',
    type: inboundType,
    text: text || `[archivo: ${input.attachment?.name || 'adjunto'}]`,
    meta: {
      voice: input.voice
        ? { durationSec: input.voice.durationSec, confidence: input.voice.confidence, transcript: input.voice.transcript }
        : undefined,
      attachment: input.attachment ? { name: input.attachment.name, mime: input.attachment.mime } : undefined,
      buttonId: input.buttonId || null,
      origin,
    },
    waMessageId: input.waMessageId || randomId('wam_', 9),
  });
  session.lastInboundAt = iso(session);
  session.counters.turns += 1;
  session.meta.lastOrigin = origin;
  recordTurn({ direction: 'in' });

  maybeReminder(session);

  if (session.counters.turns > config.limits.maxTurnsPerSession) {
    session.status = 'PAUSED';
    session.meta.reminderDueAt = new Date(nowMs(session) + 24 * 3_600_000).toISOString();
    reply(session, 'Alcanzamos el límite de mensajes de esta sesión. La dejo en pausa para que un profesional la revise. Puedes escribir “continuar” más tarde.');
    audit(session, 'security.turn_cap', { turns: session.counters.turns }, 'system', 'pause');
    return { replies: [], session, erase: false };
  }

  const itemBefore = getItem(session.currentItemId);
  const screen = screenInbound(text, itemBefore?.id || null);

  if (screen.crisis.level === 'high' || screen.crisis.level === 'critical') {
    handleCrisis(session, screen, text);
    saveSession(session);
    return { replies: [], session, erase: false };
  }

  if (screen.injection.detected) {
    session.counters.blocked += 1;
    reply(session, injectionReply());
    const current = currentPrompt(session);
    if (current && session.status === 'IN_PROGRESS') askQuestion(session, current.item, { step: current.step });
    audit(session, 'security.prompt_injection', { signals: screen.injection.signals }, actor, 'block');
    event(session, 'security.blocked', { kind: 'prompt_injection' });
    saveSession(session);
    return { replies: [], session, erase: false };
  }
  if (screen.diagnosis.detected) {
    session.counters.blocked += 1;
    reply(session, diagnosisReply());
    const current = currentPrompt(session);
    if (current && session.status === 'IN_PROGRESS') askQuestion(session, current.item, { step: current.step });
    audit(session, 'security.diagnosis_request', {}, actor, 'block');
    event(session, 'security.blocked', { kind: 'diagnosis_request' });
    saveSession(session);
    return { replies: [], session, erase: false };
  }
  if (screen.otherData.detected) {
    session.counters.blocked += 1;
    reply(session, otherDataReply());
    const current = currentPrompt(session);
    if (current && session.status === 'IN_PROGRESS') askQuestion(session, current.item, { step: current.step });
    audit(session, 'security.other_data_request', {}, actor, 'block');
    event(session, 'security.blocked', { kind: 'other_data_request' });
    saveSession(session);
    return { replies: [], session, erase: false };
  }

  if (isErasure(text)) {
    handleErasure(session);
    saveSession(session);
    return { replies: [], session, erase: true };
  }
  if (isOptOut(text)) {
    handleOptOut(session);
    saveSession(session);
    return { replies: [], session, erase: false };
  }
  if (isHumanRequest(text)) {
    handleHuman(session);
    saveSession(session);
    return { replies: [], session, erase: false };
  }

  // Ráfagas de spam: el mismo mensaje corto repetido. Primero se avisa y no se
  // procesa el eco; si persiste, se pausa la entrevista para revisión.
  const burst = spamBurstStep(session, text);
  if (burst >= config.limits.maxSpamBurst) {
    session.counters.blocked = (session.counters.blocked || 0) + 1;
    pauseForReview(session, 'spam');
    saveSession(session);
    return { replies: [], session, erase: false };
  }
  if (burst >= 2) {
    session.counters.spam = (session.counters.spam || 0) + 1;
    reply(session, spamWarningReply());
    event(session, 'message.spam_burst', { burst });
    audit(session, 'security.spam_burst', { burst }, actor, 'warn');
    const spamCurrent = currentPrompt(session);
    if (spamCurrent && session.status === 'IN_PROGRESS') {
      askQuestion(session, spamCurrent.item, { step: spamCurrent.step });
    }
    saveSession(session);
    return { replies: [], session, erase: false };
  }

  if (session.status === 'NEW') {
    startConversation(session);
    saveSession(session);
    return { replies: [], session, erase: false };
  }

  if (session.status === 'AGE_PENDING') {
    handleAge(session, text);
    saveSession(session);
    return { replies: [], session, erase: !!session.meta.eraseOnReply };
  }
  if (session.status === 'CONSENT_PENDING') {
    handleConsent(session, text);
    saveSession(session);
    return { replies: [], session, erase: !!session.meta.eraseOnReply };
  }
  if (session.status === 'ESCALATED') {
    if (session.pendingConfirmation) session.pendingConfirmation = null;
    handleEscalated(session, text);
    saveSession(session);
    return { replies: [], session, erase: false };
  }
  if (session.status === 'HANDOFF') {
    reply(session, 'Un profesional revisará tu conversación y se comunicará contigo. Mientras tanto, puedes dejar tu mensaje y quedará registrado.');
    event(session, 'handoff.message', {});
    saveSession(session);
    return { replies: [], session, erase: false };
  }
  if (session.status === 'OPTED_OUT') {
    reply(session, 'No estoy enviando más preguntas. Si quieres eliminar tus datos, escribe “borra mis datos”.');
    saveSession(session);
    return { replies: [], session, erase: false };
  }
  if (session.status === 'COMPLETED') {
    if (isCorrectionRequest(text)) {
      session.status = 'IN_PROGRESS';
      session.pendingCorrection = { scope: 'full' };
      reply(session, 'Claro. Dime el nombre o el número del dato que quieres corregir.');
      saveSession(session);
      return { replies: [], session, erase: false };
    }
    reply(session, 'La entrevista ya está completa. Puedes escribir “corregir” para ajustar un dato, “hablar con una persona” o “borra mis datos”.');
    saveSession(session);
    return { replies: [], session, erase: false };
  }
  if (session.status === 'PAUSED') {
    if (isResume(text) || /continuar|retomar|sigamos/.test(normalizeForMatch(text))) {
      resume(session);
      saveSession(session);
      return { replies: [], session, erase: false };
    }
    reply(session, 'La entrevista está en pausa. Cuando quieras, escribe “Continuar”.');
    saveSession(session);
    return { replies: [], session, erase: false };
  }
  if (session.status !== 'IN_PROGRESS') {
    reply(session, 'No puedo continuar en este estado. Escribe “ayuda” si necesitas asistencia.');
    saveSession(session);
    return { replies: [], session, erase: false };
  }

  if (isPause(text)) {
    pause(session);
    saveSession(session);
    return { replies: [], session, erase: false };
  }

  if (session.pendingVoice) {
    const handled = await handleVoiceConfirmation(session, text);
    if (handled) {
      saveSession(session);
      return { replies: [], session, erase: false };
    }
  }

  if (session.pendingCorrection) {
    if (handleCorrectionTarget(session, text)) {
      saveSession(session);
      return { replies: [], session, erase: false };
    }
  }

  if (session.sectionReview && handleSectionReview(session, text)) {
    saveSession(session);
    return { replies: [], session, erase: false };
  }

  if (session.pendingConfirmation) {
    if (handlePendingConfirmation(session, text)) {
      saveSession(session);
      return { replies: [], session, erase: false };
    }
  }

  if (session.currentItemId === 'C01') {
    handleSummaryAnswer(session, text);
    saveSession(session);
    return { replies: [], session, erase: false };
  }

  if (isConfusion(text)) {
    const current = currentPrompt(session);
    if (current) {
      const helpItem = currentClarifyItem(session, current);
      const missing = missingSubfields(helpItem, '', {});
      askQuestion(session, current.item, {
        step: current.step,
        clarify: true,
        clarifyText: clarifyPrompt(helpItem, { missing }),
      });
      event(session, 'question.explained', { itemId: current.item.id });
      saveSession(session);
      return { replies: [], session, erase: false };
    }
  }

  if (isRepeat(text)) {
    const current = currentPrompt(session);
    if (current) askQuestion(session, current.item, { step: current.step });
    saveSession(session);
    return { replies: [], session, erase: false };
  }

  await processAnswer(session, text, input, ctx);
  saveSession(session);
  return { replies: [], session, erase: !!session.meta.eraseOnReply };
}

export function createSessionReply(session) {
  if (session.status === 'NEW') startConversation(session);
  return session;
}

export function publicSession(session, { reveal = true } = {}) {
  return {
    id: session.id,
    name: reveal ? session.name : firstName(session.name),
    phone: reveal ? session.phoneE164 : maskPhone(session.phoneE164),
    status: session.status,
    surveyVersion: session.surveyVersion,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt,
    currentSectionId: session.currentSectionId,
    currentItemId: session.currentItemId,
    q21Step: session.q21Step,
    ageConfirmed: session.ageConfirmed,
    consent: session.consent,
    progress: session.progress,
    riskLevel: session.riskLevel,
    pendingConfirmation: session.pendingConfirmation
      ? { type: session.pendingConfirmation.type, itemId: session.pendingConfirmation.itemId }
      : null,
    sectionReview: session.sectionReview,
    pendingCorrection: session.pendingCorrection,
    budget: {
      spentUsd: session.budget.spentUsd,
      limitUsd: session.budget.limitUsd,
      tokensIn: session.budget.tokensIn,
      tokensOut: session.budget.tokensOut,
      exhausted: session.budget.exhausted,
      warned: session.budget.warned,
    },
    counters: session.counters,
    flags: session.flags,
    lastError: session.lastError,
    messages: session.messages,
    events: session.events.slice(-80),
    summary: session.summary
      ? {
          generatedAt: session.summary.generatedAt,
        }
      : null,
    reminder: {
      dueAt: session.meta.reminderDueAt || null,
      sent: !!session.meta.reminderSent,
    },
  };
}

export function inspectorSession(session, { reveal = false } = {}) {
  return {
    ...publicSession(session, { reveal }),
    items: Object.fromEntries(
      Object.entries(session.items || {}).map(([id, record]) => [
        id,
        {
          status: record.status,
          rawText: reveal ? record.rawText : record.rawText ? '[protegido]' : '',
          displayValue: record.displayValue,
          normalized: reveal ? record.normalized : record.normalized ? '[protegido]' : null,
          extracted: reveal ? record.extracted : undefined,
          validation: record.validation,
          score: record.score,
          coverage: record.coverage,
          issues: record.issues,
          attempts: record.attempts,
          source: record.source,
          answeredAt: record.answeredAt,
          updatedAt: record.updatedAt,
          attachment: record.attachment
            ? { id: record.attachment.id, name: record.attachment.name, mime: record.attachment.mime, bytes: record.attachment.bytes }
            : null,
        },
      ]),
    ),
    q21Steps: session.q21Steps,
    escalations: session.escalations,
    consent: session.consent
      ? reveal
        ? session.consent
        : {
            version: session.consent.version,
            granted: session.consent.granted,
            grantedAt: session.consent.grantedAt,
            declinedAt: session.consent.declinedAt,
            channel: session.consent.channel,
            evidence: session.consent.evidence ? { textHash: session.consent.evidence.textHash } : undefined,
          }
      : null,
    messages: reveal
      ? session.messages
      : session.messages.map((message) => ({
          ...message,
          text:
            message.direction === 'in'
              ? '[contenido protegido]'
              : message.meta?.kind === 'question' || message.meta?.kind === 'section'
                ? message.text
                : '[contenido protegido]',
          meta: message.meta
            ? {
                ...message.meta,
                transcript: undefined,
                attachmentName: message.meta.attachmentName ? '[archivo]' : undefined,
              }
            : message.meta,
        })),
    events: session.events,
    summary: session.summary,
    meta: {
      ...session.meta,
      pendingCrisisText: undefined,
      lastOrigin: session.meta.lastOrigin,
    },
  };
}

export function adminPause(session, actor = 'practitioner') {
  if (FINAL_STATUS.has(session.status)) return false;
  session.status = 'PAUSED';
  session.meta.pausedAt = iso(session);
  session.meta.reminderDueAt = new Date(nowMs(session) + 24 * 3_600_000).toISOString();
  session.meta.reminderSent = false;
  event(session, 'admin.pause', { actor });
  audit(session, 'session.paused', { actor }, actor, 'pause');
  return true;
}

export function adminResume(session, actor = 'practitioner') {
  if (FINAL_STATUS.has(session.status)) return false;
  session.status = 'IN_PROGRESS';
  session.meta.resumedAt = iso(session);
  event(session, 'admin.resume', { actor });
  audit(session, 'session.resumed', { actor }, actor, 'resume');
  const current = currentPrompt(session);
  if (current) askQuestion(session, current.item, { step: current.step });
  return true;
}

export function adminHandoff(session, actor = 'practitioner') {
  session.status = 'HANDOFF';
  session.meta.handoffAt = iso(session);
  event(session, 'admin.handoff', { actor });
  audit(session, 'handoff.requested', { actor }, actor, 'handoff');
  return true;
}

export function adminMessage(session, text, actor = 'practitioner') {
  const safe = screenOutbound(text);
  if (!safe.safe) return { ok: false, issues: safe.issues };
  const message = addMessage(session, {
    direction: 'out',
    type: 'text',
    text: cleanText(text).slice(0, config.limits.maxOutboundChars),
    meta: { kind: 'practitioner', actor },
  });
  event(session, 'practitioner.message', { actor });
  audit(session, 'practitioner.message', { length: text.length }, actor, 'send');
  saveSession(session);
  return { ok: true, message };
}

export function adminEditAnswer(session, itemId, text, actor = 'practitioner') {
  const item = getItem(itemId);
  if (!item) return { ok: false, issue: 'Ítem inexistente.' };
  const validation = validateField(item, text, {});
  const record = {
    ...(session.items[itemId] || {}),
    status: 'EDITED',
    rawText: text,
    displayValue: validation.normalized ?? text,
    normalized: validation.normalized ?? text,
    score: validation.ok ? 1 : 0.5,
    coverage: 1,
    issues: validation.issues,
    updatedAt: iso(session),
    editedAt: iso(session),
    editedBy: actor,
  };
  session.items[itemId] = record;
  updateProgress(session);
  event(session, 'answer.edited', { itemId, actor });
  audit(session, 'answer.edited', { itemId, actor }, actor, 'edit');
  saveSession(session);
  return { ok: true, record };
}

export function adminTimeTravel(session, hours) {
  const delta = Number(hours) * 3_600_000;
  if (!Number.isFinite(delta)) return false;
  session.clockOffsetMs = (session.clockOffsetMs || 0) + delta;
  session.meta.timeTravelHours = (session.meta.timeTravelHours || 0) + Number(hours);
  event(session, 'admin.time_travel', { hours: Number(hours) });
  audit(session, 'admin.time_travel', { hours: Number(hours) }, 'practitioner', 'simulate');
  saveSession(session);
  return true;
}

export function adminForceReminder(session, actor = 'practitioner') {
  if (session.status !== 'PAUSED') return false;
  session.meta.reminderDueAt = new Date(nowMs(session) - 1000).toISOString();
  session.meta.reminderSent = false;
  maybeReminder(session);
  audit(session, 'reminder.forced', { actor }, actor, 'send');
  saveSession(session);
  return true;
}

export function sessionEraseOnReply(session) {
  return !!session.meta.eraseOnReply;
}

export function isFinal(session) {
  return FINAL_STATUS.has(session.status);
}

export { maybeReminder as runReminder };
