import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};
const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const ROOT = root;

export const config = {
  version: '0.1.0',
  host: process.env.POC_HOST || '127.0.0.1',
  port: int(process.env.POC_PORT, 3210),
  dataDir: process.env.POC_DATA_DIR || path.join(root, 'data'),
  publicDir: path.join(root, 'public'),
  root,
  adminToken: process.env.POC_ADMIN_TOKEN || 'poc-admin',
  adminTokenIsDefault: !process.env.POC_ADMIN_TOKEN,
  sessionTtlDays: 30,
  maxSessions: 200,

  llm: {
    mode: process.env.POC_LLM || 'opencode',
    model: process.env.POC_MODEL || 'opencode-go/glm-5.3-flash',
    fallbackModel: process.env.POC_FALLBACK_MODEL || 'opencode-go/deepseek-v4.1-flash',
    timeoutMs: int(process.env.POC_LLM_TIMEOUT_MS, 9000),
    retryTimeoutMs: int(process.env.POC_LLM_RETRY_TIMEOUT_MS, 7000),
    maxOutputBytes: 16 * 1024,
    maxConcurrent: int(process.env.POC_LLM_CONCURRENCY, 4),
    queueWaitMs: int(process.env.POC_LLM_QUEUE_WAIT_MS, 8000),
    agent: 'interviewer',
  },

  limits: {
    maxInputChars: int(process.env.POC_MAX_INPUT_CHARS, 2000),
    maxOutboundChars: int(process.env.POC_MAX_OUTBOUND_CHARS, 700),
    maxTurnsPerSession: int(process.env.POC_MAX_TURNS, 400),
    maxClarificationsPerItem: 2,
    maxSpamBurst: int(process.env.POC_MAX_SPAM_BURST, 4),
    maxNonsenseMessages: int(process.env.POC_MAX_NONSENSE, 4),
    maxReminders: 1,
    maxCorrections: 3,
    maxAnalysisAttempts: 2,
    maxSectionSummaryMessages: 2,
    attachmentMaxBytes: int(process.env.POC_ATTACHMENT_MAX_BYTES, 8 * 1024 * 1024),
    audioMaxSeconds: 300,
    sessionBudgetUsd: num(process.env.POC_SESSION_BUDGET_USD, 0.15),
    dailyBudgetUsd: num(process.env.POC_DAILY_BUDGET_USD, 5),
    budgetWarnRatio: 0.8,
    bodyLimitBytes: int(process.env.POC_BODY_LIMIT_BYTES, 12 * 1024 * 1024),
  },

  rate: {
    enabled: process.env.POC_RATE_LIMIT !== 'off',
    ipCapacity: 60,
    ipRefillPerSec: 1,
    sessionCapacity: 15,
    sessionRefillPerSec: 0.25,
    sessionHourly: 100,
    sessionDaily: 300,
    duplicateWindowMs: 30_000,
    duplicateLimit: 3,
    softCooldownMs: 60_000,
    hardCooldownMs: 5 * 60_000,
    adminAttempts: 5,
    adminWindowMs: 5 * 60_000,
    adminLockMs: 10 * 60_000,
  },

  retention: {
    audioDays: 30,
    transcriptMonths: 24,
    answersMonths: 24,
    messagesMonths: 12,
    logsDays: 90,
    auditYears: 5,
    consentsYears: 5,
  },

  // Shadow prices in USD per 1M tokens. The models are free in this POC; these
  // rates are used only to demonstrate per-session cost controls and alerting.
  modelPrices: {
    'opencode-go/glm-5.3-flash': { input: 0.15, output: 0.5 },
    'opencode-go/deepseek-v4.1-flash': { input: 0.15, output: 0.6 },
    'opencode/glm-5.3-flash-free': { input: 0.05, output: 0.15 },
    'opencode/deepseek-v4.1-flash-free': { input: 0.15, output: 0.6 },
    'opencode/mimo-v2.6-flash-free': { input: 0.08, output: 0.24 },
    'opencode/big-pickle': { input: 0, output: 0 },
    deterministic: { input: 0, output: 0 },
  },

  consent: {
    version: 'poc-consent-1.0',
    text:
      'Esta entrevista recoge datos personales y de salud para preparar tu consulta. ' +
      'Se guardan de forma confidencial y los usa únicamente tu profesional. ' +
      'Puedes pausar, pedir acceso o eliminar tus datos cuando quieras. ' +
      'No reemplaza la atención médica. En esta prueba local, el texto se envía a un modelo ' +
      'de lenguaje gratuito mediante OpenCode y puede salir de tu equipo. ' +
      '¿Aceptas continuar?',
    privacyPath: '/privacy.html',
  },
};

export function publicConfig() {
  return {
    version: config.version,
    llm: {
      mode: config.llm.mode,
      model: config.llm.model,
      fallbackModel: config.llm.fallbackModel,
      timeoutMs: config.llm.timeoutMs,
    },
    limits: {
      maxInputChars: config.limits.maxInputChars,
      maxOutboundChars: config.limits.maxOutboundChars,
      sessionBudgetUsd: config.limits.sessionBudgetUsd,
      maxClarificationsPerItem: config.limits.maxClarificationsPerItem,
    },
    consentVersion: config.consent.version,
  };
}
