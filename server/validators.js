const MONTHS = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

export function normalizeForMatch(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanText(value) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n > 1 && n <= 5) return Math.min(1, n / 5);
  if (n > 5 && n <= 100) return Math.min(1, n / 100);
  return Math.max(0, Math.min(1, n));
}

export function weightedScore(validation = {}) {
  return Number(
    (
      0.3 * clamp01(validation.relevance) +
      0.25 * clamp01(validation.completeness) +
      0.2 * clamp01(validation.specificity) +
      0.15 * clamp01(validation.coherence) +
      0.1 * clamp01(validation.safety)
    ).toFixed(3),
  );
}

const KEYBOARD_PATTERNS = /\b(qwerty|asdf|zxcv|qaz|poiuy|lkjh|mnbv|aoeu)\b/;
const VOWELS = /[aeiouáéíóúü]/i;

/**
 * Detección determinista de mensajes sin contenido interpretable (galimatías).
 * Captura ruido evidente (zzz, ~~~, qwerty, palabras sin vocal, eco de tokens)
 * pero no castiga frases reales en español: esas se degradan por cobertura de
 * palabras clave en `heuristicScores`.
 */
export function detectNonsense(text) {
  const value = cleanText(text);
  if (!value) return { detected: false, signals: [] };
  const signals = [];
  if (/([a-z])\1{2,}/i.test(value)) signals.push('caracteres-repetidos');
  if (KEYBOARD_PATTERNS.test(normalizeForMatch(value))) signals.push('secuencia-teclado');
  const letters = value.match(/[a-záéíóúüñ]/gi) || [];
  const symbols = (value.match(/[^\w\sáéíóúüñ]/g) || []).length;
  if (symbols >= 2 && letters.length <= 8) signals.push('simbolos-sin-texto');
  const words = value.split(/\s+/).filter(Boolean);
  const vowelless = words.filter((w) => /[a-záéíóúüñ]/i.test(w) && w.length >= 3 && !VOWELS.test(w));
  if (vowelless.length) signals.push('palabras-sin-vocal');
  const letterTokens = words.filter((w) => /[a-záéíóúüñ]/i.test(w));
  if (letterTokens.length >= 2 && new Set(letterTokens.map((w) => normalizeForMatch(w))).size <= 1) {
    signals.push('eco');
  }
  return { detected: signals.length > 0, signals };
}

const SMALLTALK_PATTERNS = /^(hola|holi|buenas|buenos dias|buenas tardes|buenas noches|que tal|como estas|hey|holaa|holaaa|gracias|muchas gracias|ok|okey|vale|de nada|disculpa|perdon|perdón|listo|dale|entendido)$/;
const SMALLTALK_MAX_WORDS = 2;

/**
 * Saludos y acks breves (“hola”, “gracias”, “ok”). No aportan respuesta:
 * el bot los saluda cordialmente y repite la pregunta sin consumir intentos.
 */
export function isSmallTalk(text) {
  const n = normalizeForMatch(text)
    .replace(/[.!¡¿?,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = n.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > SMALLTALK_MAX_WORDS) return false;
  return SMALLTALK_PATTERNS.test(n);
}

const SKIP_PATTERNS = [
  /^no se$/,
  /^no lo se$/,
  /^no lo se$/,
  /^no se nada$/,
  /^prefiero no (responder|contestar|hablar de eso)$/,
  /^no quiero (responder|contestar|hablar de eso)$/,
  /^omitir$/,
  /^saltar( esta pregunta)?$/,
  /^siguiente( pregunta)?$/,
  /^paso$/,
  /^no aplica$/,
  /^sin informacion$/,
  /^no tengo informacion$/,
  /^no tengo informacion sobre eso$/,
  /^no tengo$/,
  /^ninguno$/,
  /^ninguna$/,
  /^no recuerdo$/,
  /^no me acuerdo$/,
  /^ns\/nc$/,
];

export function isSkip(text) {
  const n = normalizeForMatch(text).replace(/[.!¡¿?]/g, '').trim();
  return SKIP_PATTERNS.some((re) => re.test(n));
}

export function isPause(text) {
  const n = normalizeForMatch(text).replace(/[.!¡¿?]/g, '').trim();
  if (!n) return false;
  // A long message is almost always a narrative answer that merely mentions
  // pausing ("pausé mis actividades"), not an instruction to pause the interview.
  if (n.split(/\s+/).length > 12) return false;
  if (/^(pausa|pausar|pausemos|pause)( (la|esta))?( (entrevista|conversacion|charla))?$/.test(n)) {
    return true;
  }
  if (/^(parar|lo dejamos aqui|lo vemos luego|sigo luego|continuamos luego|ahora no|no puedo ahora|otro dia|hablemos luego)$/.test(n)) {
    return true;
  }
  if (/\b(quiero|prefiero|vamos a|podemos|dejemos|dejamos)\s+(pausar|la pausa|parar|dejarlo)\b/.test(n)) return true;
  if (/\b(mas tarde|despues|manana|otro dia)\b/.test(n) && /\b(seguimos|continuamos|retomamos|hablamos|lo dejamos)\b/.test(n)) {
    return true;
  }
  return false;
}

export function isConfusion(text) {
  const n = normalizeForMatch(text).replace(/[.!¡¿?]/g, '').trim();
  return /\b(no entiendo|no entendi|no comprendo|no me queda claro|no me quedo claro|no se de que|no se a que te refieres|a que te refieres|explicame|explicame mejor|me lo explicas|puedes explicar|mas claro|da un ejemplo|dame un ejemplo|pon un ejemplo)\b/.test(
    n,
  );
}

export function isNegativeComplete(text) {
  const n = normalizeForMatch(text).replace(/[.!¡¿?]/g, '').trim();
  if (/^(no se|no lo se|ns\/nc|no recuerdo|no me acuerdo)$/.test(n)) return false;
  return /\b(no (hubo|tuvo|tuvieron|hay|existen?|existe|tengo|tienen|tenia|tenian|aplica|paso|ocurrio)|ningun[oa]s?|nunca|jamas|sin (hijos|parejas|antecedentes|informacion|datos|temas))\b/.test(
    n,
  );
}

export function isResume(text) {
  return /\b(continuemos|continuar|retomemos|retomar|sigamos|seguir|volvi|estoy de vuelta|aqui estoy|dale|listo|ok|bueno)\b/.test(
    normalizeForMatch(text),
  );
}

export function isHumanRequest(text) {
  return /\b(hablar con (una )?persona|hablar con (un )?(humano|asesor|profesional|psicologo|terapeuta)|atencion humana|alguien real|quiero un humano|pasame con|comunicarme con)\b/.test(
    normalizeForMatch(text),
  );
}

export function isOptOut(text) {
  return /\b(no quiero continuar|no quiero seguir|cancelar( la entrevista)?|detener( la entrevista)?|parar|basta|no mas|no quiero hacer esto|me quiero salir|salir de la entrevista|darme de baja)\b/.test(
    normalizeForMatch(text),
  );
}

export function isErasure(text) {
  return /\b(borra(r)? mis datos|elimina(r)? mis datos|suprimir mis datos|derecho de supresion|derecho al olvido|borra(r)? todo|elimina(r)? todo)\b/.test(
    normalizeForMatch(text),
  );
}

export function isRepeat(text) {
  return /\b(repite|repetir|no entendi|no te entendi|cual era la pregunta|de nuevo|otra vez|no me quedo claro)\b/.test(
    normalizeForMatch(text),
  );
}

export function isConsentYes(text) {
  return /^(si|sí|acepto|autorizo|de acuerdo|confirmo|claro|dale|ok|esta bien|está bien|por supuesto)$/.test(
    normalizeForMatch(text).replace(/[.!¡¿?]/g, '').trim(),
  );
}

export function isConsentNo(text) {
  return /^(no|no acepto|rechazo|no autorizo|no quiero|no gracias|prefiero no)$/.test(
    normalizeForMatch(text).replace(/[.!¡¿?]/g, '').trim(),
  );
}

export function isAffirmative(text) {
  const n = normalizeForMatch(text).replace(/[.!¡¿?]/g, '').trim();
  if (/^(no\b|incorrecto|corregir|corrija|cambiar|revisar|hay un error)/.test(n)) return false;
  return /^(si|claro|por supuesto|de acuerdo|confirmo|ok|asi es|exacto|correcto|todo correcto|esta bien|si,? (esta|es|todo) correcto|si,? confirmo|confirmado)$/.test(
    n,
  );
}

export function isNegative(text) {
  const n = normalizeForMatch(text).replace(/[.!¡¿?]/g, '').trim();
  return /^(no|incorrecto|corregir|corrija|cambiar|revisar|hay un error|tiene un error|no esta bien|no es correcto|quiero corregir|no,? corregir|no,? cambiar)$/.test(
    n,
  );
}

export function isCorrectionRequest(text) {
  return /\b(corregir|corrija|corrijo|cambiar|editar|enmienda|hay un error|esta mal|está mal|no es correcto|revisar)\b/.test(
    normalizeForMatch(text),
  );
}

export function detectInjection(text) {
  const n = normalizeForMatch(text);
  const patterns = [
    /ignora (todas )?(las )?instrucciones/,
    /ignore (all )?(previous )?instructions/,
    /system prompt/,
    /prompt del sistema/,
    /revela (el|tu|las) (prompt|instrucciones|configuracion|reglas)/,
    /actua como/,
    /jailbreak/,
    /developer mode/,
    /modo desarrollador/,
    /cambia (el|tu) (esquema|formato|rol)/,
    /devuelve (otro|un) json/,
    /ejecuta (este|el) (comando|script)/,
    /api key/,
    /access token/,
    /muestrame (el|tu) codigo/,
    /repite (tus|las) instrucciones/,
  ];
  const signals = patterns.filter((re) => re.test(n)).map((re) => re.source);
  return { detected: signals.length > 0, signals };
}

export function detectDiagnosisRequest(text) {
  const n = normalizeForMatch(text);
  const patterns = [
    /^(que tengo|que enfermedad tengo|cual es mi diagnostico|dime mi diagnostico|dame un diagnostico|cual es mi enfermedad)/,
    /(dime|dame|revela|confirmame) (mi|el|un) (diagnostico|enfermedad|tratamiento|medicamento)/,
    /^(recetame|formulame|que medicamento|que pastilla|que dosis)/,
    /(esto|lo que tengo) (tiene|se cura|es grave|cura)/,
    /(dime|dame) (un|el) tratamiento/,
    /(que|qué) debo tomar/,
  ];
  const signals = patterns.filter((re) => re.test(n)).map((re) => re.source);
  return { detected: signals.length > 0, signals };
}

export function detectOtherDataRequest(text) {
  const n = normalizeForMatch(text);
  const patterns = [
    /datos.*(otro|otra|otra persona|otra sesion|otra entrevista)/,
    /(historial|respuestas|telefono|correo|email) de (otro|otra|un|una) (usuario|persona|paciente|consultante)/,
    /(dame|muestrame|revela|ensename) (la|otra) (sesion|entrevista|base de datos)/,
    /(wa_id|firestore|base de datos|dashboard|admin token)/,
    /(otro|otra) (usuario|paciente|consultante)/,
    /sesion de (otro|otra)/,
  ];
  const signals = patterns.filter((re) => re.test(n)).map((re) => re.source);
  return { detected: signals.length > 0, signals };
}

export function detectOffTopic(text) {
  const n = normalizeForMatch(text);
  return /\b(clima|futbol|fútbol|chiste|receta de cocina|politica|política|noticias|precio del dolar|precio del dólar|quien eres|que eres|como funcionas|cómo funcionas|eres una ia|eres un bot|modelo de lenguaje)\b/.test(
    n,
  );
}

export function detectCrisis(text, itemId = null) {
  const n = normalizeForMatch(text);
  const signals = [];
  const historicalItems = new Set(['Q19', 'Q21', 'Q22']);
  const historicalMarkers =
    /\b(hace \d+ anos|hace muchos anos|cuando era (nino|nina|joven)|en aquel entonces|fallecio|murio|suicid\w*|aborto|perdio|perdimos|mi abuel|mi tia|mi tio|mi primo|mi hermano|mi padre|mi madre)\b/.test(
      n,
    );

  const immediate = [
    [/(?<!no )quiero (morir|matarme|desaparecer|quitarme la vida)/, 'suicidal-ideation'],
    [/no quiero (vivir|seguir viviendo)/, 'suicidal-ideation'],
    [/(?<!no )voy a (matarme|suicidarme|quitarme la vida)/, 'suicidal-ideation'],
    [/(?<!no )he pensado en (matarme|suicidarme|hacerme dano)/, 'suicidal-ideation'],
    [/(?<!no )quiero (hacerme|hacer(me)?) dano/, 'self-harm'],
    [/(me estoy|me quiero|voy a) cort(ar|ando)/, 'self-harm'],
    [/(me estoy|me quiero) (matando|suicidando)/, 'imminent-risk'],
    [/(me esta|me están|me estan) (golpeando|pegando|amenazando)/, 'domestic-violence'],
    [/(mi pareja|mi esposo|mi esposa|mi novio|mi novia) me (golpea|pega|amenaza)/, 'domestic-violence'],
    [/(abuso sexual|me violo|me violaron|violacion)/, 'sexual-violence'],
    [/(no puedo respirar|dolor (muy )?fuerte en el pecho|me estoy muriendo|estoy sangrando (mucho|sin parar))/, 'medical-emergency'],
    [/(sobredosis|tome (muchas|demasiadas) pastillas|me tome todo)/, 'medical-emergency'],
    [/(voy a matar|quiero matar|le voy a hacer dano) a/, 'threat-to-others'],
  ];

  for (const [re, signal] of immediate) {
    if (re.test(n)) signals.push(signal);
  }

  if (/\bsuicid/.test(n)) {
    if (historicalItems.has(itemId) && historicalMarkers && !/quiero|voy a|pienso|he pensado/.test(n)) {
      return { level: 'low', signals: ['historical-family-loss'], historical: true };
    }
    signals.push('suicide-mention');
  }

  if (signals.length === 0) {
    if (historicalItems.has(itemId) && historicalMarkers) {
      return { level: 'low', signals: ['historical-family-event'], historical: true };
    }
    return { level: 'none', signals: [], historical: false };
  }

  const critical = signals.some((s) =>
    ['imminent-risk', 'suicidal-ideation', 'medical-emergency', 'threat-to-others', 'sexual-violence'].includes(s),
  );
  return {
    level: critical ? 'critical' : 'high',
    signals: [...new Set(signals)],
    historical: false,
  };
}

export function validateEmail(text) {
  const value = cleanText(text).replace(/^mailto:/i, '').toLowerCase();
  if (value.length > 254) return { ok: false, issue: 'El correo es demasiado largo.' };
  if (/[<>"'();:,\s\\]/.test(value)) {
    return { ok: false, issue: 'El correo contiene caracteres no permitidos.' };
  }
  if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(value)) {
    return { ok: false, issue: 'No logré reconocer ese correo. ¿Me lo escribes de nuevo? Debe verse así: nombre@dominio.com.' };
  }
  return { ok: true, normalized: value };
}

export function validatePhone(text) {
  const raw = cleanText(text);
  const compact = raw.replace(/[^\d+]/g, '');
  let digits = compact.replace(/\D/g, '');
  if (compact.startsWith('+57') || (digits.length === 12 && digits.startsWith('57'))) {
    if (digits.startsWith('57')) digits = digits.slice(2);
    if (!/^3\d{9}$/.test(digits)) return { ok: false, issue: 'El celular colombiano debe tener 10 dígitos y empezar por 3.' };
    return { ok: true, normalized: `+57${digits}` };
  }
  if (digits.length === 10 && digits.startsWith('3')) {
    return { ok: true, normalized: `+57${digits}` };
  }
  if (digits.length >= 8 && digits.length <= 15 && compact.startsWith('+')) {
    return { ok: true, normalized: `+${digits}` };
  }
  return { ok: false, issue: 'No reconozco un número de celular válido. Incluye el indicativo, por ejemplo +57 300 123 4567.' };
}

export function parseDate(text, now = new Date()) {
  const value = normalizeForMatch(text);
  let year = null;
  let month = null;
  let day = null;

  let m = value.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  }
  if (!m) {
    m = value.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/);
    if (m) {
      day = Number(m[1]);
      month = Number(m[2]);
      year = Number(m[3]);
      if (year < 100) year += year > 30 ? 1900 : 2000;
    }
  }
  if (!m) {
    m = value.match(/\b(\d{1,2}) de ([a-z]+) (?:de |del )?(\d{4})\b/);
    if (m) {
      day = Number(m[1]);
      month = MONTHS[m[2]];
      year = Number(m[3]);
    }
  }
  if (!m) {
    m = value.match(/\b([a-z]+) (?:de |del )?(\d{4})\b/);
    if (m) {
      month = MONTHS[m[1]];
      year = Number(m[2]);
    }
  }
  if (!m) {
    m = value.match(/\b(19|20)\d{2}\b/);
    if (m) year = Number(m[0]);
  }
  if (!year && !month && !day) return { ok: false, issue: 'No encontré una fecha reconocible.' };
  if (year && (year < 1900 || year > now.getUTCFullYear())) {
    return { ok: false, issue: 'El año no es coherente: no puede ser futuro ni anterior a 1900.' };
  }
  if (month && (month < 1 || month > 12)) return { ok: false, issue: 'El mes no es válido.' };
  if (day && (day < 1 || day > 31)) return { ok: false, issue: 'El día no es válido.' };
  if (year && month && day) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
      return { ok: false, issue: 'La fecha no existe en el calendario.' };
    }
    if (d > now) return { ok: false, issue: 'La fecha no puede estar en el futuro.' };
    return { ok: true, iso: d.toISOString().slice(0, 10), year, month, day, partial: false };
  }
  if (year && month) {
    return { ok: true, iso: `${year}-${String(month).padStart(2, '0')}`, year, month, partial: true };
  }
  return { ok: true, iso: String(year), year, partial: true };
}

export function validateAge(text, min = 18, max = 100) {
  const m = cleanText(text).match(/\b(\d{1,3})\b/);
  if (!m) return { ok: false, issue: 'Necesito tu edad en años, por ejemplo 34.' };
  const age = Number(m[1]);
  if (!Number.isFinite(age)) return { ok: false, issue: 'La edad no es válida.' };
  if (age < min) {
    return {
      ok: false,
      minor: age < 18,
      issue: age < 18 ? 'La entrevista es solo para personas de 18 años o más.' : `La edad debe ser al menos ${min}.`,
    };
  }
  if (age > max) return { ok: false, issue: `La edad debe ser máximo ${max}.` };
  return { ok: true, normalized: age };
}

export function validateYesNo(text) {
  const n = normalizeForMatch(text).replace(/[.!¡¿?]/g, '').trim();
  if (/^(si|sí|claro|por supuesto|correcto|afirmativo|obvio|así es|asi es)$/.test(n)) {
    return { ok: true, normalized: 'sí' };
  }
  if (/^(no|nunca|jamas|jamás|negativo|para nada|en absoluto)$/.test(n)) {
    return { ok: true, normalized: 'no' };
  }
  return { ok: false, issue: 'Responde sí o no, por favor.' };
}

/**
 * Pregunta de mano dominante en una sola pregunta: diestro, zurdo o
 * ambidiestro. Acepta también menciones de mano derecha/izquierda.
 */
export function validateHandedness(text) {
  const n = normalizeForMatch(text).replace(/[.!¡¿?]/g, ' ').trim();
  if (/ambidiestr|ambas manos|ambos|los dos|las dos/.test(n)) {
    return { ok: true, normalized: 'ambidiestro' };
  }
  if (/diestr|derecha|derecho/.test(n)) return { ok: true, normalized: 'diestro' };
  if (/zurd|izquierda/.test(n)) return { ok: true, normalized: 'zurdo' };
  return { ok: false, issue: 'Responde “diestro”, “zurdo” o “ambidiestro”, por favor.' };
}

const MARITAL = [
  { key: 'soltero/a', re: /solter/ },
  { key: 'casado/a', re: /casad/ },
  { key: 'unión libre', re: /union libre|union de hecho|conviv/ },
  { key: 'separado/a', re: /separad/ },
  { key: 'divorciado/a', re: /divorciad/ },
  { key: 'viudo/a', re: /viud/ },
];

export function validateMaritalStatus(text) {
  const n = normalizeForMatch(text);
  const found = MARITAL.find((option) => option.re.test(n));
  if (!found) return { ok: false, issue: 'Elige una opción: soltero/a, casado/a, unión libre, separado/a, divorciado/a o viudo/a.' };
  return { ok: true, normalized: found.key };
}

export function validateChildren(text) {
  const n = normalizeForMatch(text);
  if (/^(no tengo|ninguno|ninguna|no|sin hijos)$/.test(n.replace(/[.!¡¿?]/g, '').trim())) {
    return { ok: true, normalized: { cantidad: 0, edades: [] } };
  }
  const numbers = [...n.matchAll(/\b(\d{1,2})\b/g)].map((m) => Number(m[1]));
  const looksLikeAges = /(ano|edad|hijo|hija)/.test(n);
  if (!looksLikeAges && !/\b(hijo|hija|tengo)\b/.test(n)) {
    return { ok: false, issue: 'Cuéntame cuántos hijos tienes y sus edades, o escribe “no tengo”.' };
  }
  return { ok: true, normalized: { cantidad: numbers[0] ?? null, edades: numbers.slice(1) }, partial: numbers.length < 2 };
}

export function validateName(text) {
  const value = cleanText(text);
  if (value.length < 3) return { ok: false, issue: 'El nombre es demasiado corto.' };
  if (value.length > 120) return { ok: false, issue: 'El nombre es demasiado largo.' };
  if (/https?:|@|<|>/.test(value)) return { ok: false, issue: 'El nombre no puede contener enlaces ni símbolos raros.' };
  if (!/[a-zA-ZÁÉÍÓÚÜÑáéíóúüñ]/.test(value)) return { ok: false, issue: 'El nombre debe contener letras.' };
  return { ok: true, normalized: value.replace(/\s+/g, ' ') };
}

function requiredFields(subfields = []) {
  const required = subfields.filter((field) => !field.optional);
  return required.length ? required : subfields;
}

export function coverageFromExtracted(extracted, subfields = []) {
  if (!subfields.length) return 1;
  const fields = requiredFields(subfields);
  let covered = 0;
  for (const field of fields) {
    const value = extracted?.[field.key];
    if (value !== undefined && value !== null && String(value).trim() !== '') covered += 1;
  }
  return covered / fields.length;
}

export function heuristicCoverage(text, subfields = []) {
  if (!subfields.length) return text.trim().length >= 2 ? 1 : 0;
  if (subfields.length === 1) {
    const len = text.trim().length;
    return len >= 8 ? 1 : len >= 2 ? 0.25 : 0;
  }
  // A clear "no hubo / ninguno / nunca" answers every part of a compound
  // yes/no question, even if it does not repeat each keyword.
  if (isNegativeComplete(text)) return 1;
  const n = normalizeForMatch(text);
  let covered = 0;
  for (const field of requiredFields(subfields)) {
    const keys = [field.key, field.label, ...(field.keywords || [])].map(normalizeForMatch).filter(Boolean);
    if (keys.some((key) => key.length > 1 && n.includes(key))) covered += 1;
  }
  return covered / requiredFields(subfields).length;
}

export function missingSubfields(item, text, extracted = {}, normalized = null) {
  const subfields = (item.subfields || []).filter((field) => !field.optional);
  if (!subfields.length) return [];
  if (item.format === 'date_place' && normalized && typeof normalized === 'object') {
    const missing = [];
    if (!normalized.fecha) missing.push(subfields[0]?.label || 'fecha de nacimiento');
    if (!normalized.lugar) missing.push(subfields[1]?.label || 'lugar de nacimiento');
    return missing;
  }
  if (item.format === 'personal_data' && normalized && typeof normalized === 'object') {
    const missing = [];
    for (const field of subfields) {
      const value = normalized[field.key];
      if (value === null || value === undefined || String(value).trim() === '') missing.push(field.label);
    }
    return missing;
  }
  if (isNegativeComplete(text)) return [];
  const n = normalizeForMatch(text);
  return subfields
    .filter((field) => {
      const value = extracted?.[field.key];
      if (value !== undefined && value !== null && String(value).trim() !== '') return false;
      const keys = [field.key, field.label, ...(field.keywords || [])].map(normalizeForMatch).filter(Boolean);
      return !keys.some((key) => key.length > 1 && n.includes(key));
    })
    .map((field) => field.label);
}

function stripPlaceFillers(value) {
  let place = cleanText(value).replace(/\s+/g, ' ').trim();
  // Remove connectors and frequently used lead-ins, but keep articles that are
  // part of a place name ("La Paz", "El Salvador").
  for (let i = 0; i < 6; i += 1) {
    const before = place;
    place = place
      .replace(/^[\s,;:.–—-]+/, '')
      .replace(/^(?:nac[ií]o?|nacimiento|fecha|lugar)[\s,;:]*/i, '')
      .replace(/^(?:el|la|los|las)\s+(?=(?:en|de|del)\b)/i, '')
      .replace(/^(?:en|de|del)\s+/i, '')
      .replace(/\b(?:el|la|los|las|en|del|de|nac[ií]o?)[\s,;:.–—-]*$/i, '')
      .replace(/[\s,;:.–—-]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (place === before) break;
  }
  return place;
}

export function extractPlace(text) {
  let value = cleanText(text);
  const datePatterns = [
    /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g,
    /\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g,
    /\b\d{1,2}\s+de\s+[a-záéíóúüñ]+\s+(?:de\s+|del\s+)?\d{4}\b/gi,
    /\b[a-záéíóúüñ]+\s+(?:de\s+|del\s+)?\d{4}\b/gi,
    /\b(?:19|20)\d{2}\b/g,
  ];
  for (const pattern of datePatterns) value = value.replace(pattern, ' ');
  const place = stripPlaceFillers(value);
  return /[a-záéíóúüñ]/i.test(place) ? place : '';
}

/** Edad en años dentro de una respuesta compuesta: “tengo 34 años”, “34 años”, “edad 34”. */
export function extractAgeFromText(text) {
  const n = normalizeForMatch(text);
  let m = n.match(/\btengo\s+(\d{1,3})\b/);
  if (!m) m = n.match(/\b(\d{1,3})\s*(?:anos|annos|agnos)\b/);
  if (!m) m = n.match(/\bedad(?: en anos| en años)?\D{0,10}(\d{1,3})\b/);
  return m ? Number(m[1]) : null;
}

/** Nombre al inicio de una respuesta compuesta, antes de la edad o la fecha. */
export function extractNameCandidate(text) {
  let value = cleanText(text).replace(/^(?:hola[,\s]+)?(?:me llamo|mi nombre (?:completo )?es|soy|nombre(?: completo)?)\s+/i, '');
  const cut = value.split(/[,;]|tengo|mi edad|nací|naci/i)[0].trim();
  return cut.replace(/\s*\d+.*$/, '').replace(/\s+/g, ' ').trim();
}

/** Lugar de nacimiento dentro de una respuesta compuesta. */
export function extractBirthPlace(text) {
  let value = cleanText(text)
    .replace(/\b\d{1,3}\s*(?:años|anos)\b/gi, ' ')
    .replace(/\btengo\s+\d{1,3}\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ');
  const enMatch = value.match(/\ben\s+(.+)$/i);
  if (enMatch) return stripPlaceFillers(enMatch[1]);
  const chunks = value.split(/[,;:.]+/).map((chunk) => stripPlaceFillers(chunk)).filter(Boolean);
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const chunk = chunks[i];
    if (/[a-záéíóúüñ]/i.test(chunk) && !/\b(llamo|soy|nombre|tengo|nací|naci|anos|años|edad)\b/i.test(chunk)) {
      return chunk;
    }
  }
  return '';
}

/** Cobertura calculada directamente sobre el valor normalizado estructurado. */
export function coverageFromNormalized(normalized, item) {
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return null;
  const fields = (item.subfields || []).filter((field) => !field.optional);
  if (!fields.length) return null;
  let covered = 0;
  for (const field of fields) {
    const value = normalized[field.key];
    if (value !== null && value !== undefined && String(value).trim() !== '') covered += 1;
  }
  return covered / fields.length;
}

export function validateField(item, text, extracted = {}) {
  const value = cleanText(text);
  const issues = [];
  let normalized = value;
  let hardFail = false;
  let minor = false;

  switch (item.format || item.type) {
    case 'name': {
      const r = validateName(value);
      if (!r.ok) {
        hardFail = true;
        issues.push(r.issue);
      } else normalized = r.normalized;
      break;
    }
    case 'email': {
      const r = validateEmail(value);
      if (!r.ok) {
        hardFail = true;
        issues.push(r.issue);
      } else normalized = r.normalized;
      break;
    }
    case 'phone': {
      const r = validatePhone(value);
      if (!r.ok) {
        hardFail = true;
        issues.push(r.issue);
      } else normalized = r.normalized;
      break;
    }
    case 'age': {
      const r = validateAge(value, item.min ?? 18, item.max ?? 100);
      if (!r.ok) {
        hardFail = true;
        minor = !!r.minor;
        issues.push(r.issue);
      } else normalized = r.normalized;
      break;
    }
    case 'age_autonomy': {
      const r = validateAge(value, item.min ?? 12, item.max ?? 100);
      if (!r.ok) {
        hardFail = true;
        issues.push(r.issue);
      } else normalized = r.normalized;
      break;
    }
    case 'date_place': {
      const r = parseDate(value);
      if (!r.ok) {
        hardFail = true;
        issues.push(r.issue);
      }
      const place = extractPlace(value);
      if (place.length < 2) {
        hardFail = true;
        issues.push('Falta el lugar de nacimiento. ¿En qué ciudad o municipio naciste?');
      }
      normalized = { fecha: r.iso || null, lugar: place || null };
      break;
    }
    case 'personal_data': {
      const nameCandidate = String(extracted?.nombre_completo || '').trim() || extractNameCandidate(value);
      const rName = validateName(nameCandidate);
      const nameOk = rName.ok && nameCandidate.trim().split(/\s+/).filter(Boolean).length >= 2;
      const ageCandidate = extracted?.edad != null && Number.isFinite(Number(extracted.edad)) && Number(extracted.edad) > 0
        ? Number(extracted.edad)
        : extractAgeFromText(value);
      const rAge = ageCandidate != null ? validateAge(String(ageCandidate)) : { ok: false, issue: 'Falta tu edad en años.' };
      const rDate = parseDate(value);
      const place = String(extracted?.lugar_nacimiento || '').trim() || extractBirthPlace(value);
      if (!nameOk) {
        hardFail = true;
        issues.push('Falta el nombre completo. ¿Cuál es tu nombre y tus apellidos?');
      }
      if (!rAge.ok) {
        hardFail = true;
        issues.push(rAge.issue);
      }
      if (!rDate.ok) {
        hardFail = true;
        issues.push(`Falta la fecha de nacimiento. ${rDate.issue}`);
      }
      if (place.length < 2) {
        hardFail = true;
        issues.push('Falta el lugar de nacimiento. ¿En qué ciudad o municipio naciste?');
      }
      normalized = {
        nombre_completo: nameOk ? rName.normalized : null,
        edad: rAge.ok ? ageCandidate : null,
        fecha_nacimiento: rDate.ok ? rDate.iso : null,
        lugar_nacimiento: place.length >= 2 ? place : null,
      };
      break;
    }
    case 'handedness': {
      const r = validateHandedness(value);
      if (!r.ok) {
        hardFail = true;
        issues.push(r.issue);
      } else normalized = r.normalized;
      break;
    }
    case 'option': {
      if (item.id === 'D06') {
        const r = validateMaritalStatus(value);
        if (!r.ok) {
          hardFail = true;
          issues.push(r.issue);
        } else normalized = r.normalized;
      }
      break;
    }
    case 'yesno': {
      const r = validateYesNo(value);
      if (!r.ok) {
        hardFail = true;
        issues.push(r.issue);
      } else normalized = r.normalized;
      break;
    }
    case 'children': {
      const r = validateChildren(value);
      if (!r.ok) {
        hardFail = true;
        issues.push(r.issue);
      } else normalized = r.normalized;
      break;
    }
    case 'date_text': {
      const hasDate = /\b(19|20)\d{2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/.test(value);
      const hasSkip = isSkip(value);
      if (!hasDate && !hasSkip) {
        hardFail = true;
        issues.push('Falta una fecha o un año aproximado del diagnóstico.');
      }
      break;
    }
    case 'confirmation': {
      if (!isAffirmative(value) && !isNegative(value)) {
        hardFail = true;
        issues.push('Responde “sí, está correcto” o dime qué quieres corregir.');
      }
      break;
    }
    case 'attachment': {
      if (!/no tengo|no aplica|ninguno|sin analisis|sin análisis/i.test(value)) {
        hardFail = true;
        issues.push('Adjunta un archivo PDF o imagen, o escribe “no tengo”.');
      }
      break;
    }
    case 'narrative': {
      const words = value.split(/\s+/).filter(Boolean);
      if (words.length < 3) {
        issues.push('La respuesta es muy corta; cuéntame un poco más.');
      }
      break;
    }
    case 'short': {
      // Pregunta que se puede responder con “sí”, “no”, “no sé” o una frase
      // breve: no se exige una respuesta elaborada.
      if (value.length < 2) {
        hardFail = true;
        issues.push('La respuesta es demasiado corta.');
      }
      break;
    }
    case 'number': {
      const m = value.match(/\b(\d{1,3})\b/);
      if (!m) {
        hardFail = true;
        issues.push('Necesito un número.');
      } else {
        const n = Number(m[1]);
        if (n < (item.min ?? 0) || n > (item.max ?? 120)) {
          hardFail = true;
          issues.push(`El número debe estar entre ${item.min ?? 0} y ${item.max ?? 120}.`);
        } else normalized = n;
      }
      break;
    }
    case 'text':
    default: {
      if (value.length < 2) {
        hardFail = true;
        issues.push('La respuesta es demasiado corta.');
      }
      break;
    }
  }

  if (item.subfields?.length > 1) {
    const coverage = Math.max(coverageFromExtracted(extracted, item.subfields), heuristicCoverage(value, item.subfields));
    const structuredFormat = [
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
    ].includes(item.format || item.type);
    if (coverage < 0.7 && !structuredFormat) issues.push('Faltan partes de la respuesta.');
  }

  return { ok: !hardFail && issues.length === 0, hardFail, minor, issues, normalized, value };
}

export function heuristicScores(item, text, extracted = {}) {
  const words = cleanText(text).split(/\s+/).filter(Boolean);
  const coverage = Math.max(
    coverageFromExtracted(extracted, item.subfields),
    heuristicCoverage(text, item.subfields),
  );
  const isChoice = ['yesno', 'option', 'number', 'email', 'phone', 'age', 'age_autonomy', 'handedness', 'short'].includes(item.format || item.type);
  // Un mensaje con palabras obtiene 0.8 base; el galimatías lo baja de golpe y
  // las respuestas sin ninguna relación con la pregunta, en forma de gradiente.
  let relevance = words.length > 0 ? 0.8 : 0;
  const nonsense = detectNonsense(text);
  if (nonsense.detected) {
    relevance = Math.min(relevance, 0.15);
  } else if (words.length > 0 && words.length <= 8 && !/\d/.test(text) && (item.format || item.type) !== 'name') {
    const keywordFields = (item.subfields || []).filter((field) => (field.keywords || []).length > 0);
    if (keywordFields.length) {
      const n = normalizeForMatch(text);
      const matched = keywordFields.some((field) =>
        (field.keywords || []).some((keyword) => n.includes(normalizeForMatch(keyword))),
      );
      if (!matched) relevance = Math.min(relevance, 0.45);
    }
  }
  return {
    relevance,
    completeness: coverage,
    specificity: isChoice ? 0.9 : Math.min(1, 0.25 + words.length / 25),
    coherence: 0.8,
    safety: 1,
  };
}

export function sanitizeOutbound(text, maxChars = 700) {
  let value = String(text ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b(?:system prompt|prompt del sistema)\b/gi, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!value) value = 'Gracias. Sigamos con la entrevista.';
  if (value.length > maxChars) {
    const cut = value.slice(0, maxChars);
    const lastStop = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('?'), cut.lastIndexOf('!'));
    value = lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : `${cut.slice(0, maxChars - 1)}…`;
  }
  return value;
}

export function sanitizeAck(text) {
  let value = sanitizeOutbound(text, 160)
    .split('?')[0]
    .split('¿')[0]
    .replace(/\b(diagnóstico|diagnostico|enfermedad|tratamiento|medicamento|receta|dosis|curar)\b/gi, '')
    .trim();
  if (!value || value.length < 3) value = 'Gracias.';
  return value;
}

const FORBIDDEN_OUTBOUND = [
  /(tienes|padeces|sufres) (un|una|el|la) (diagnostico|diagnóstico|enfermedad|trastorno)/i,
  /(debes|deberias|deberías) (tomar|aplicarte|usar) (un|una|el|la) (medicamento|pastilla|tratamiento)/i,
  /(te receto|te recomiendo tomar|la cura es|esto se cura con)/i,
  /(soy|como) (un|una) (medico|médico|psiquiatra|psicologo|psicólogo)/i,
  /(puedo|voy a) (diagnosticarte|recetarte|tratarte)/i,
];

export function screenOutbound(text) {
  const issues = FORBIDDEN_OUTBOUND.filter((re) => re.test(text)).map((re) => re.source);
  return { safe: issues.length === 0, issues };
}

export function redact(value) {
  return String(value ?? '')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\+?\d[\d\s-]{7,}\d/g, '[phone]')
    .replace(/\b\d{6,}\b/g, '[number]');
}

export function maskName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  if (parts.length === 1) return `${parts[0].slice(0, 2)}•••`;
  return `${parts[0]} ${parts[1][0]}.`;
}

export function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '—';
  return `${digits.startsWith('57') ? '+57 ' : ''}•••••${digits.slice(-3)}`;
}

export function maskEmail(email) {
  if (!email || !String(email).includes('@')) return '—';
  const [user, domain] = String(email).split('@');
  return `${user.slice(0, 2)}•••@${domain}`;
}

export function extractNumbers(text) {
  return [...String(text).matchAll(/\b\d{1,3}\b/g)].map((m) => Number(m[1]));
}
