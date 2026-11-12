import {
  detectCrisis,
  detectDiagnosisRequest,
  detectInjection,
  detectOtherDataRequest,
  sanitizeOutbound,
  screenOutbound,
} from './validators.js';

export const CRISIS_MESSAGE = sanitizeOutbound(
  'Siento mucho que estés pasando por esto. No estás solo/a. Si estás en peligro inmediato, llama al 123. ' +
    'Para apoyo emocional, la línea 106. Si sufres violencia, llama al 155; si hay un menor en riesgo, al 141. ' +
    'Voy a pausar la entrevista y avisar a un profesional. ¿Quieres que te contacten?',
);

export function crisisReply() {
  return CRISIS_MESSAGE;
}

export function injectionReply() {
  return sanitizeOutbound(
    'No puedo cambiar mis instrucciones ni mostrar información interna. Puedo continuar con la entrevista. ' +
      'Si necesitas ayuda con otra cosa, díselo a tu profesional.',
  );
}

export function diagnosisReply() {
  return sanitizeOutbound(
    'No puedo darte un diagnóstico ni recomendarte tratamientos; eso le corresponde a un profesional de salud. ' +
      'Puedo registrar cómo te sientes y continuar con la entrevista para que tu profesional lo revise.',
  );
}

export function otherDataReply() {
  return sanitizeOutbound(
    'No puedo mostrar datos de otras personas ni de otras sesiones. La información de cada entrevista es confidencial. ' +
      'Podemos continuar con tu propia entrevista.',
  );
}

export function offTopicReply() {
  return sanitizeOutbound('Puedo ayudarte con esta entrevista. Retomemos la pregunta que teníamos.');
}

/** Pregunta reprocesada a un saludo/ack breve; no consume intentos. */
export function smallTalkAckReply(itemLabel, promptText) {
  return sanitizeOutbound(`Estamos en «${itemLabel}»: ${promptText}`);
}

/** Aviso de galimatías antes de pedir la respuesta de nuevo. */
export function nonsenseClarifyReply(item, missing = []) {
  const falta = missing.length ? ` Para «${item.label}» me falta: ${missing.join(', ')}.` : ` Sobre «${item.label}».`;
  return sanitizeOutbound(
    `Ese mensaje no logro interpretarlo: no encuentro su sentido para la pregunta.${falta} ` +
      `${item.clarify || '¿Me lo escribes con otras palabras?'} ${item.example || ''}`.trim(),
  );
}

/** Parcial informado como “sin sentido claro”, no como respuesta válida. */
export function nonsensePartialReply(missing = []) {
  const falta = missing.length ? ` (aún falta: ${missing.join(', ')})` : '';
  return sanitizeOutbound(
    `No pude encontrar un sentido claro en tus últimas respuestas para esta pregunta, así que la registro como parcial${falta}. ` +
      'Tu profesional podrá aclararla contigo en la revisión.',
  );
}

export function spamWarningReply() {
  return sanitizeOutbound(
    'Veo que me está llegando el mismo mensaje varias veces seguidas. ' +
      'Lo proceso una sola vez; si hubo un error, escríbelo de nuevo y respondo a esa versión.',
  );
}

/** Pausa por comportamiento anómalo: spam o sin sentido sostenido. */
export function reviewPausedReply(reason) {
  const cause =
    reason === 'spam'
      ? 'Recibí el mismo mensaje demasiadas veces seguidas, así que detengo la entrevista aquí.'
      : 'No estoy logrando entender tus últimas respuestas, así que detengo la entrevista aquí.';
  return sanitizeOutbound(
    `${cause} Voy a pausarla y avisar a un profesional para que revise esta conversación. ` +
      'Cuando quieras continuar, escribe “Continuar”.',
  );
}

export function humanReply() {
  return sanitizeOutbound(
    'Entendido. Voy a pausar la entrevista y avisar a un profesional para que se comunique contigo. ' +
      'Mientras tanto, puedes seguir escribiendo y lo verá una persona.',
  );
}

export function pauseReply() {
  return sanitizeOutbound(
    'Está bien. Pauso la entrevista aquí. Cuando quieras continuar, escríbeme y retomamos donde quedamos.',
  );
}

export function optOutReply() {
  return sanitizeOutbound(
    'Entendido. Detengo la entrevista y no te enviaré más preguntas. Si quieres eliminar tus datos, escribe “borra mis datos”.',
  );
}

export function erasureReply() {
  return sanitizeOutbound(
    'Entendido. Eliminaré la entrevista y los datos asociados. Conservaré únicamente el registro mínimo exigido por la ley, sin el contenido de tus respuestas.',
  );
}

export function consentDeclineReply() {
  return sanitizeOutbound(
    'Entendido. No guardaré tus datos ni iniciaré la entrevista. Si cambias de opinión, puedes escribirme de nuevo. Cuídate.',
  );
}

export function minorReply() {
  return sanitizeOutbound(
    'Esta entrevista es solo para personas de 18 años o más. Si eres menor de edad, necesitamos un flujo de autorización de un adulto responsable, que no está disponible en esta prueba. No guardaré tus datos.',
  );
}

export function screenInbound(text, itemId = null) {
  const crisis = detectCrisis(text, itemId);
  const injection = detectInjection(text);
  const diagnosis = detectDiagnosisRequest(text);
  const otherData = detectOtherDataRequest(text);
  return {
    crisis,
    injection,
    diagnosis,
    otherData,
    blocked: crisis.level === 'critical' || crisis.level === 'high' || injection.detected || diagnosis.detected || otherData.detected,
  };
}

export function safeMessage(text, maxChars = 700) {
  const sanitized = sanitizeOutbound(text, maxChars);
  const screen = screenOutbound(sanitized);
  if (!screen.safe) {
    return {
      text: 'Gracias. Sigamos con la entrevista.',
      blocked: true,
      issues: screen.issues,
    };
  }
  return { text: sanitized, blocked: false, issues: [] };
}
