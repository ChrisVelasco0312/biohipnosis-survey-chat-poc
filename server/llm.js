import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { config, ROOT } from './config.js';
import { sanitizeAck, clamp01, coverageFromExtracted, heuristicCoverage, heuristicScores } from './validators.js';
import { llmQueueDepth, acquireLlmSlot } from './ratelimit.js';

const status = {
  lastError: null,
  lastModel: null,
  lastLatencyMs: null,
  lastCallAt: null,
  cooldowns: {},
  calls: 0,
  failures: 0,
};

function safeEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('POC_')) continue;
    env[key] = value;
  }
  return env;
}

function runOpenCode(prompt, model, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = [
      'run',
      '--agent',
      config.llm.agent,
      '--format',
      'json',
      '--log-level',
      'error',
      '--model',
      model,
    ];
    const child = spawn('opencode', args, {
      cwd: ROOT,
      env: safeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const started = Date.now();

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      finish(Object.assign(new Error(`OpenCode timed out after ${timeoutMs}ms`), { code: 'timeout' }));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 64 * 1024) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
        finish(Object.assign(new Error('OpenCode output exceeded limit'), { code: 'output_limit' }));
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 16 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => finish(Object.assign(err, { code: 'spawn_failed' })));
    child.on('close', (code) => {
      if (settled) return;
      const parsed = parseNdjson(stdout);
      if (parsed.error) {
        const error = Object.assign(new Error(parsed.error.message || 'OpenCode provider error'), {
          code: parsed.error.type || 'provider_error',
          retryAfterMs: parsed.error.retryAfterMs || 0,
          status: parsed.error.status,
        });
        return finish(error);
      }
      if (!parsed.text.trim()) {
        return finish(
          Object.assign(new Error(`OpenCode returned no text (exit ${code})${stderr ? `: ${stderr.slice(0, 300)}` : ''}`), {
            code: 'empty_output',
          }),
        );
      }
      finish(null, {
        text: parsed.text,
        tokensIn: parsed.tokensIn,
        tokensOut: parsed.tokensOut,
        latencyMs: Date.now() - started,
        exitCode: code,
      });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(prompt, 'utf8');
  });
}

function parseNdjson(raw) {
  const out = { text: '', tokensIn: 0, tokensOut: 0, error: null };
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (evt.type === 'text' && evt.part?.text) out.text += evt.part.text;
    if (evt.type === 'error' && evt.error) {
      out.error = {
        type: evt.error.type || 'provider_error',
        message: evt.error.message || 'Provider error',
        retryAfterMs: evt.error.retryAfterMs || 0,
        status: evt.error.status,
      };
    }
    if (evt.type === 'step_finish' && evt.part?.tokens) {
      out.tokensIn += Number(evt.part.tokens.input || 0) + Number(evt.part.tokens.cache?.read || 0);
      out.tokensOut += Number(evt.part.tokens.output || 0) + Number(evt.part.tokens.reasoning || 0);
    }
  }
  return out;
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
    subcampos: subfields.map((f) => ({ clave: f.key, etiqueta: f.label, opcional: !!f.optional })),
    respuestas_previas: Object.fromEntries(
      Object.entries(session.items || {})
        .filter(([, v]) => v.status === 'ACCEPTED' || v.status === 'CONFIRMED' || v.status === 'PARTIAL')
        .slice(-14)
        .map(([k, v]) => [k, String(v.displayValue ?? v.rawText ?? '').slice(0, 180)]),
    ),
    turnos_recientes: recent,
  };
  return [
    'Analiza el mensaje del usuario para el ítem actual.',
    'Devuelve únicamente el objeto JSON del esquema. No expliques, no saludes, no preguntes.',
    `CONTEXTO_JSON: ${JSON.stringify(context)}`,
    start,
    safeText,
    end,
  ].join('\n');
}

function shadowCost(model, tokensIn, tokensOut) {
  const price = config.modelPrices[model] || config.modelPrices['opencode/glm-5.3-flash-free'];
  return Number(((tokensIn / 1_000_000) * price.input + (tokensOut / 1_000_000) * price.output).toFixed(6));
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text).length / 3.6));
}

async function callModel({ model, prompt, timeoutMs, item, allowedSubfields, text, extracted, session }) {
  const release = await acquireLlmSlot();
  try {
    const result = await runOpenCode(prompt, model, timeoutMs);
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
  return {
    mode: config.llm.mode,
    model: config.llm.model,
    fallbackModel: config.llm.fallbackModel,
    available: config.llm.mode === 'opencode' && !(status.cooldowns[config.llm.model] > now),
    lastError: status.lastError,
    lastModel: status.lastModel,
    lastLatencyMs: status.lastLatencyMs,
    lastCallAt: status.lastCallAt,
    calls: status.calls,
    failures: status.failures,
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
