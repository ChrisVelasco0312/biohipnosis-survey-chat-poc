import { SECTIONS, sectionItems, getItem, totalItems } from './catalog.js';
import { maskName, sanitizeOutbound } from './validators.js';
import { writeOutboxFile } from './store.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function displayValue(item, record, { reveal = false } = {}) {
  if (!record) return 'Sin responder';
  if (record.status === 'SKIPPED') {
    return record.meta?.conditionalSkip ? 'No aplica: no hay diagnóstico para compartir' : 'No respondido';
  }
  const raw = record.displayValue ?? record.rawText ?? record.normalized ?? '';
  let value =
    typeof raw === 'object' && raw !== null
      ? Object.entries(raw)
          .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
          .map(([k, v]) => `${k.replaceAll('_', ' ')}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join(' · ')
      : String(raw);
  if (!value.trim()) value = 'Sin responder';
  if (!reveal) {
    if (item.id === 'D01') {
      const normalized = record.normalized;
      if (normalized && typeof normalized === 'object' && normalized.nombre_completo) {
        value = value.replace(String(normalized.nombre_completo), maskName(normalized.nombre_completo));
      } else {
        value = maskName(normalized || value);
      }
    }
  }
  if (record.status === 'PARTIAL') value += ' (parcial)';
  return sanitizeOutbound(value, 400);
}

export function buildSummary(session, { reveal = false } = {}) {
  return SECTIONS.map((section) => ({
    id: section.id,
    name: section.name,
    items: sectionItems(section.id).map((item) => {
      const record = session.items?.[item.id];
      return {
        id: item.id,
        label: item.label,
        question: item.prompt,
        status: record?.status || 'UNANSWERED',
        score: record?.score ?? null,
        value: displayValue(item, record, { reveal }),
      };
    }),
  }));
}

export function summaryLines(session, { sectionId = null, reveal = false } = {}) {
  const sections = buildSummary(session, { reveal }).filter((s) => !sectionId || s.id === sectionId);
  const lines = [];
  for (const section of sections) {
    lines.push(`— ${section.name} —`);
    for (const item of section.items) {
      if (item.status === 'UNANSWERED') continue;
      lines.push(`${item.id}. ${item.label}: ${item.value}`);
    }
  }
  return lines;
}

export function chunkLines(lines, maxChars = 650) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function sectionSummaryChunks(session, sectionId, maxChars = 650) {
  const section = SECTIONS.find((s) => s.id === sectionId);
  if (!section) return [];
  return chunkLines(summaryLines(session, { sectionId, reveal: false }), maxChars).map((chunk, idx) => ({
    text: `Revisemos ${section.name.toLowerCase()}:\n${chunk}\n\n¿Está todo correcto?`,
    part: idx,
  }));
}

export function fullSummaryChunks(session, maxChars = 650) {
  return chunkLines(summaryLines(session, { reveal: false }), maxChars);
}

export function summaryRecord(session, { reveal = false } = {}) {
  const consent = session.consent
    ? {
        version: session.consent.version,
        grantedAt: session.consent.grantedAt,
        evidenceType: session.consent.evidenceType,
        textHash: session.consent.textHash,
        channel: session.consent.channel,
        ...(reveal ? { waMessageId: session.consent.waMessageId } : {}),
      }
    : null;
  return {
    sessionId: session.id,
    name: reveal ? session.name : maskName(session.name),
    status: session.status,
    surveyVersion: session.surveyVersion,
    createdAt: session.createdAt,
    completedAt: session.completedAt,
    consent,
    riskLevel: session.riskLevel,
    budget: session.budget,
    progress: session.progress,
    sections: buildSummary(session, { reveal }),
    disclaimer:
      'Este resumen es una transcripción estructurada de la entrevista inicial. No es un diagnóstico, no reemplaza una evaluación clínica y no contiene recomendaciones médicas.',
  };
}

export function exportJson(session, { reveal = true } = {}) {
  return JSON.stringify(
    {
      ...summaryRecord(session, { reveal }),
      items: Object.fromEntries(
        Object.entries(session.items || {}).map(([id, value]) => [
          id,
          {
            status: value.status,
            rawText: reveal ? value.rawText : '[protegido]',
            normalized: reveal ? value.normalized : '[protegido]',
            score: value.score,
            coverage: value.coverage,
            issues: value.issues,
            answeredAt: value.answeredAt,
            source: value.source,
            attachment: value.attachment,
          },
        ]),
      ),
      messages: (session.messages || []).map((m) => ({
        id: m.id,
        direction: m.direction,
        type: m.type,
        text: reveal ? m.text : '[protegido]',
        createdAt: m.createdAt,
        meta: m.meta,
      })),
    },
    null,
    2,
  );
}

export function exportHtml(session, { reveal = true, autoPrint = false } = {}) {
  const summary = summaryRecord(session, { reveal });
  const sectionsHtml = summary.sections
    .map((section) => {
      const items = section.items
        .map(
          (item) => `
        <tr>
          <td class="id">${escapeHtml(item.id)}</td>
          <td class="label">
            ${escapeHtml(item.label)}
            <div class="question">${escapeHtml(item.question || '')}</div>
          </td>
          <td class="value">${escapeHtml(item.value)}</td>
          <td class="status">${escapeHtml(item.status)}</td>
        </tr>`,
        )
        .join('');
      return `<section><h2>${escapeHtml(section.name)}</h2><table>${items}</table></section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Resumen de entrevista — ${escapeHtml(session.name)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; color: #1f2933; background: #f6f7f8; }
  main { max-width: 900px; margin: 0 auto; padding: 40px 28px 72px; background: #fff; }
  header { border-bottom: 2px solid #0f766e; padding-bottom: 20px; margin-bottom: 28px; }
  h1 { font-size: 26px; margin: 0 0 6px; color: #0f3d39; }
  h2 { font-size: 18px; margin: 28px 0 10px; color: #0f3d39; }
  .meta { color: #52606d; font-size: 13px; line-height: 1.7; }
  .badge { display: inline-block; background: #e6fffb; color: #0f766e; border: 1px solid #99f6e4; border-radius: 999px; padding: 3px 10px; font-size: 12px; margin-right: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  tr { border-bottom: 1px solid #e4e7eb; }
  td { padding: 8px 6px; vertical-align: top; }
  td.id { width: 56px; color: #7b8794; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  td.label { width: 34%; font-weight: 600; }
  td.label .question { font-weight: 400; color: #52606d; font-size: 11px; margin-top: 3px; }
  td.status { width: 92px; color: #52606d; font-size: 11px; text-align: right; }
  .notice { background: #fffbeb; border: 1px solid #fde68a; border-radius: 12px; padding: 16px 18px; margin-top: 32px; font-size: 12px; color: #78350f; line-height: 1.6; }
  .risk { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
  footer { margin-top: 28px; font-size: 11px; color: #7b8794; }
  @media print { body { background: #fff; } main { padding: 0; max-width: none; } .no-print { display: none; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>Resumen de entrevista inicial</h1>
    <div class="meta">
      <span class="badge">${escapeHtml(session.surveyVersion)}</span>
      <span class="badge">${escapeHtml(session.status)}</span>
      ${session.riskLevel !== 'none' ? `<span class="badge">Riesgo: ${escapeHtml(session.riskLevel)}</span>` : ''}<br>
      Consultante: ${escapeHtml(session.name)} · Sesión: ${escapeHtml(session.id)}<br>
      Creada: ${escapeHtml(session.createdAt)} · Completada: ${escapeHtml(session.completedAt || '—')}<br>
      Progreso: ${escapeHtml(session.progress?.answered ?? 0)}/${escapeHtml(session.progress?.total ?? totalItems())} ítems · Costo simulado: USD ${escapeHtml(Number(session.budget?.spentUsd || 0).toFixed(4))}
    </div>
  </header>
  ${sectionsHtml}
  <div class="notice">
    <strong>Aviso:</strong> ${escapeHtml(summary.disclaimer)}
  </div>
  ${summary.riskLevel !== 'none' ? `<div class="notice risk"><strong>Alerta de seguridad:</strong> la sesión tiene riesgo ${escapeHtml(summary.riskLevel)}. Revisa las señales y el protocolo de crisis antes de continuar.</div>` : ''}
  <footer>Documento generado localmente por el POC de Biohipnosis Sistémica. No contiene recomendaciones clínicas.</footer>
</main>
${autoPrint ? '<script>window.addEventListener("load",()=>setTimeout(()=>window.print(),250));</script>' : ''}
</body>
</html>`;
}

export function emailHtml(session, reveal = true) {
  return exportHtml(session, { reveal, autoPrint: false })
    .replace('Resumen de entrevista inicial', 'Resumen de tu entrevista inicial')
    .replace(
      '<footer>',
      `<footer><p>Este correo fue generado de forma simulada por el POC local. En producción se enviaría desde un dominio verificado y con enlaces de caducidad.</p>`,
    );
}

export function createSimulatedEmail(session, email, { reveal = true } = {}) {
  const sentAt = new Date(Date.now() + (session.clockOffsetMs || 0)).toISOString();
  const safeId = session.id.replace(/[^A-Za-z0-9_-]/g, '');
  const name = `resumen_${safeId}_${Date.now()}.html`;
  const html = emailHtml(session, reveal);
  const file = writeOutboxFile(name, html);
  return {
    to: email,
    file,
    fileName: name,
    sentAt,
    simulated: true,
    subject: `Resumen de entrevista — ${session.name}`,
  };
}
