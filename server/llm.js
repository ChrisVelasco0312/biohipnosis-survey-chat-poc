import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, ROOT } from './config.js';
import { sanitizeAck, clamp01, coverageFromExtracted, heuristicCoverage, heuristicScores } from './validators.js';
import { llmQueueDepth, acquireLlmSlot } from './ratelimit.js';
import { getKey, keyInfo, markInvalid, markValid } from './keyManager.js';

const SYSTEM_PROMPT = (() => {
  try {
    return fs.readFileSync(path.join(ROOT, 'prompts', 'interviewer.txt'), 'utf8');
  } catch {
    return 'Eres el entrevistador inicial de Biohipnosis Sistémica. Analiza el mensaje y devuelve solo el JSON solicitado.';
  }
})();

/* OpenCode Go routes each conversation with this header; without it the
   endpoint rejects the request with 400 MissingSessionID. */
const FALLBACK_SESSION_ID = `biohipnosis-poc-${crypto.randomUUID()}`;

const status = {
  lastError: null,
  lastModel: null,
  lastLatencyMs: null,
  lastCallAt: null,
  cooldowns: {},
  calls: 0,
  failures: 0,
};

function providerError(statusCode, message, extra = {}) {
  const code =
    statusCode === 401 || statusCode === 403
      ? 'key_invalid'
      : statusCode === 402
        ? 'provider.quota'
        : statusCode === 429
          ? 'provider.free-limit'
          : statusCode === 408
            ? 'timeout'
            : 'provider_error';
  return Object.assign(new Error(message), { code, status: statusCode, ...extra });
}

async function callInference({ model, prompt, timeoutMs, sessionId }) {
  const key = await getKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const modelId = String(model || '').replace(/^opencode-go\//, '');

  try {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'x-opencode-session': sessionId || FALLBACK_SESSION_ID,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 900,
      }),
      signal: controller.signal,
    });

    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      // Some gateways return HTML/plain text on errors; handled below.
    }

    if (!res.ok) {
      const message =
        data?.error?.message || data?.message || raw.slice(0, 300) || res.statusText || 'Error del proveedor';
      const retryAfterSec = Number(res.headers.get('retry-after') || 0);
      const err = providerError(res.status, message, { retryAfterMs: retryAfterSec * 1000 });
      if (err.code === 'key_invalid') markInvalid(message);
      throw err;
    }

    markValid();
    const text = String(data?.choices?.[0]?.message?.content || '');
    if (!text.trim()) {
      throw Object.assign(new Error('El proveedor devolvió una respuesta vacía.'), { code: 'empty_output' });
    }
    const usage = data?.usage || {};
    return {
      text,
      tokensIn: Number(usage.prompt_tokens || 0),
      tokensOut: Number(usage.completion_tokens || 0),
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(new Error(`OpenCode timed out after ${timeoutMs}ms`), { code: 'timeout' });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function extractJson(text) {
  let value = String(text)
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  const first = value.indexOf('{');
  const last = value.lastIndexOf('}');
  if (first < 0 || last <= first) throw Object.assign(new Error('No JSON object in response'), { code: 'invalid_json' });
  value = value.slice(first, last + 1);
  try {
    return JSON.parse(value);
  } catch (err) {
    const repaired = value
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
    try {
      return JSON.parse(repaired);
    } catch {
      throw Object.assign(new Error(`Invalid JSON response: ${err.message}`), { code: 'invalid_json' });
    }
  }
}

function normalizeToken(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return JSON.stringify(value).slice(0, 400);
  return String(value ?? '');
}

export function normalizeAnalysis(raw, allowedSubfields = []) {
  if (!raw || typeof raw !== 'object') throw Object.assign(new Error('Analysis is not an object'), { code: 'invalid_response' });
  const allowedKeys = new Set(allowedSubfields.map((s) => s.key));
  const extracted = {};
  if (raw.extracted && typeof raw.extracted === 'object' && !Array.isArray(raw.extracted)) {
    for (const [key, value] of Object.entries(raw.extracted)) {
      if (allowedKeys.size && !allowedKeys.has(key)) continue;
      if (value === null || value === undefined) continue;
      const text = normalizeToken(value).trim();
      if (text) extracted[key] = text.slice(0, 1200);
    }
  }
  const coverage = {};
  if (raw.coverage && typeof raw.coverage === 'object') {
    for (const field of allowedSubfields) {
      coverage[field.key] = clamp01(raw.coverage[field.key] ?? (extracted[field.key] ? 1 : 0));
    }
  } else {
    for (const field of allowedSubfields) coverage[field.key] = extracted[field.key] ? 1 : 0;
  }
  const scores = raw.validation || raw.scores || {};
  const validation = {
    relevance: clamp01(scores.relevance),
    completeness: clamp01(scores.completeness),
    specificity: clamp01(scores.specificity),
    coherence: clamp01(scores.coherence),
    safety: scores.safety === undefined ? 1 : clamp01(scores.safety),
  };
  const riskLevel = ['none', 'low', 'medium', 'high', 'critical'].includes(raw.risk?.level)
    ? raw.risk.level
    : 'none';
  return {
    ack: sanitizeAck(raw.ack || ''),
    extracted,
    coverage,
    validation,
    risk: {
      level: riskLevel,
      signals: Array.isArray(raw.risk?.signals) ? raw.risk.signals.map((s) => String(s).slice(0, 80)).slice(0, 8) : [],
    },
    off_topic: raw.off_topic === true,
    language: typeof raw.language === 'string' ? raw.language.slice(0, 8) : 'es',
    notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 300) : '',
  };
}

export function heuristicAnalysis({ item, text, extracted = {}, reason = 'heuristic' }) {
  const scores = heuristicScores(item, text, extracted);
  const coverage = {};
  for (const field of item.subfields || []) {
    coverage[field.key] = clamp01(coverageFromExtracted(extracted, [field]));
  }
  return {
    ack: 'Gracias.',
    extracted,
    coverage,
    validation: scores,
    risk: { level: 'none', signals: [] },
    off_topic: false,
    language: 'es',
    notes: reason,
    heuristic: true,
    heuristicCoverage: heuristicCoverage(text, item.subfields || []),
  };
}

function buildPrompt({ item, subfields, text, session, recent }) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const start = `<<<MENSAJE_USUARIO_${nonce}_INICIO>>>`;
  const end = `<<<MENSAJE_USUARIO_${nonce}_FIN>>>`;
  const safeText = String(text).replaceAll(start, '[marcador eliminado]').replaceAll(end, '[marcador eliminado]');
  const context = {
    item: item.id,
    etiqueta: item.label,
    pregunta: item.prompt,
    tipo: item.type,
    formato: item.format || item.type,
    subcampos: subfields.map((f) => ({ clave: f.key, etiqueta: f.label, opcional: !!f.optional })),
    respuestas_previas: Object.fromEntries(
      Object.entries(session.items || {})
        .filter(([, v]) => v.status === 'ACCEPTED' || v.status === 'CONFIRMED' || v.status === 'PARTIAL')
        .slice(-14)
        .map(([k, v]) => [k, String(v.displayValue ?? v.rawText ?? '').slice(0, 180)]),
    ),
    turnos_recientes: recent,
  };
  if (item.example) context.ejemplo = item.example;
  const extractionHint = EXTRACTION_HINTS[item.format || item.type];
  return [
    'Analiza el mensaje del usuario para el ítem actual.',
    'Devuelve únicamente el objeto JSON del esquema. No expliques, no saludes, no preguntes.',
    'Tu tarea principal es EXTRAER los datos: en "extracted" devuelve los valores que dijo el usuario, ya normalizados por subcampo; no los resumas ni los parafrasees.',
    extractionHint ? `NORMALIZACIÓN: ${extractionHint}` : '',
    `CONTEXTO_JSON: ${JSON.stringify(context)}`,
    start,
    safeText,
    end,
  ].filter(Boolean).join('\n');
}

/**
 * Indica, por formato, cómo debe normalizar el modelo los valores de
 * "extracted". La extracción semántica del modelo es la fuente primaria; el
 * parser determinista solo cubre los campos que faltaron.
 */
const EXTRACTION_HINTS = {
  personal_data:
    'Devuelve los cuatro subcampos con valores normalizados: nombre_completo como texto literal completo (nombres y apellidos), edad como número simple de años, fecha_nacimiento como AAAA-MM-DD y lugar_nacimiento como ciudad y región sin conectores ("nacido en", "en").',
  date_place:
    'Devuelve fecha_nacimiento como AAAA-MM-DD y lugar_nacimiento como ciudad y región sin conectores.',
  date_text:
    'Devuelve las fechas como AAAA-MM-DD cuando sea posible y las edades como números simples.',
  children:
    'Devuelve cantidad como número y edades como lista de números simples.',
  handedness:
    'Devuelve solo el valor normalizado: "diestro", "zurdo" o "ambidiestro".',
  yesno:
    'Devuelve solo "sí" o "no".',
  short:
    'Una respuesta breve tipo "sí", "no" o "no sé" es completa para este ítem: devuélvela tal cual y coverage 1.0.',
};

function shadowCost(model, tokensIn, tokensOut) {  const price = config.modelPrices[model] || config.modelPrices['opencode/glm-5.3-flash-free'];
  return Number(((tokensIn / 1_000_000) * price.input + (tokensOut / 1_000_000) * price.output).toFixed(6));
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text).length / 3.6));
}

async function callModel({ model, prompt, timeoutMs, item, allowedSubfields, text, extracted, session }) {
  const release = await acquireLlmSlot();
  try {
    const result = await callInference({ model, prompt, timeoutMs, sessionId: session?.id });
    const raw = extractJson(result.text);
    const analysis = normalizeAnalysis(raw, allowedSubfields);
    const tokensIn = result.tokensIn || estimateTokens(prompt);
    const tokensOut = result.tokensOut || estimateTokens(result.text);
    return {
      analysis,
      meta: {
        model,
        fallback: false,
        latencyMs: result.latencyMs,
        tokensIn,
        tokensOut,
        costUsd: shadowCost(model, tokensIn, tokensOut),
        failureReason: null,
      },
    };
  } catch (err) {
    // A syntactically valid but empty analysis is not worth retrying; malformed
    // output is, within the single retry budget.
    if (err.code === 'invalid_json' || err.code === 'invalid_response') {
      throw err;
    }
    throw err;
  } finally {
    release();
  }
}

export async function analyze({ item, text, session, subfields = null, extracted = {}, recent = [] }) {
  const allowedSubfields = subfields || item.subfields || [];
  const started = Date.now();
  status.calls += 1;
  status.lastCallAt = new Date().toISOString();

  if (config.llm.mode === 'off' || config.llm.mode === 'heuristic') {
    const analysis = heuristicAnalysis({ item, text, extracted, reason: 'mode-off' });
    return {
      analysis,
      meta: {
        model: 'deterministic',
        fallback: true,
        latencyMs: Date.now() - started,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        failureReason: 'mode-off',
      },
    };
  }
  if (session?.flags?.forceLlmFailure) {
    const analysis = heuristicAnalysis({ item, text, extracted, reason: 'forced-failure' });
    return {
      analysis,
      meta: {
        model: 'deterministic',
        fallback: true,
        latencyMs: Date.now() - started,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        failureReason: 'forced-failure',
      },
    };
  }

  const now = Date.now();
  const candidates = [config.llm.model, config.llm.fallbackModel].filter(
    (m, i, arr) => m && arr.indexOf(m) === i && !(status.cooldowns[m] > now),
  );

  if (!candidates.length) {
    status.lastError = 'Todos los modelos están en enfriamiento por límite de proveedor.';
    const analysis = heuristicAnalysis({ item, text, extracted, reason: 'provider-cooldown' });
    return {
      analysis,
      meta: {
        model: 'deterministic',
        fallback: true,
        latencyMs: Date.now() - started,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        failureReason: 'provider-cooldown',
      },
    };
  }

  let lastError = null;
  for (let attempt = 0; attempt < candidates.length; attempt += 1) {
    const model = candidates[attempt];
    const timeoutMs = attempt === 0 ? config.llm.timeoutMs : config.llm.retryTimeoutMs;
    const prompt = buildPrompt({ item, subfields: allowedSubfields, text, session, recent });
    try {
      const result = await callModel({
        model,
        prompt,
        timeoutMs,
        item,
        allowedSubfields,
        text,
        extracted,
        session,
      });
      status.lastModel = model;
      status.lastLatencyMs = result.meta.latencyMs;
      status.lastError = null;
      return result;
    } catch (err) {
      lastError = err;
      status.failures += 1;
      status.lastError = `${model}: ${err.message}`;
      if (err.code === 'key_invalid' || err.code === 'key_missing' || err.status === 401 || err.status === 403) {
        // Same credential for every model: retrying the fallback is pointless.
        break;
      }
      if (err.code === 'provider.free-limit' || err.code === 'provider.quota' || err.status === 429 || err.status === 402) {
        status.cooldowns[model] = Date.now() + Math.max(err.retryAfterMs || 0, 5 * 60_000);
      }
      if (err.code === 'invalid_json' || err.code === 'invalid_response') {
        // One retry with the fallback model, then heuristics.
        continue;
      }
    }
  }

  const analysis = heuristicAnalysis({ item, text, extracted, reason: lastError?.code || 'llm-failed' });
  return {
    analysis,
    meta: {
      model: 'deterministic',
      fallback: true,
      latencyMs: Date.now() - started,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      failureReason: lastError?.code || 'llm-failed',
      error: lastError?.message || 'unknown',
    },
  };
}

export function getStatus() {
  const now = Date.now();
  const key = keyInfo();
  return {
    mode: config.llm.mode,
    model: config.llm.model,
    fallbackModel: config.llm.fallbackModel,
    available:
      config.llm.mode === 'opencode' &&
      key.state !== 'invalid' &&
      key.state !== 'missing' &&
      !(status.cooldowns[config.llm.model] > now),
    lastError: status.lastError,
    lastModel: status.lastModel,
    lastLatencyMs: status.lastLatencyMs,
    lastCallAt: status.lastCallAt,
    calls: status.calls,
    failures: status.failures,
    keyState: key.state,
    keyExpiresAt: key.expiresAt,
    keyUpdatedAt: key.updatedAt,
    key,
    cooldowns: Object.fromEntries(
      Object.entries(status.cooldowns)
        .filter(([, until]) => until > now)
        .map(([model, until]) => [model, new Date(until).toISOString()]),
    ),
    queue: llmQueueDepth(),
  };
}

export function clearCooldowns() {
  status.cooldowns = {};
  status.lastError = null;
}
