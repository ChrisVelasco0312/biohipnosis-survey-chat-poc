import { test, expect, type Page } from '@playwright/test';
import {
  acceptGate,
  answerCurrent,
  createInterview,
  gotoApp,
  humanPause,
  humanType,
  sendText,
  snap,
  waitForBotIdle,
} from './helpers';

/**
 * Casos borde del chatbot, ejecutados a ritmo humano y tipeo real:
 *  1. Spam: ráfaga de mensajes repetidos mientras la entrevista corre.
 *  2. Mensajes sin sentido: entrada incoherente sobre una pregunta válida.
 *  3. Pedidos de claridad: el usuario no entiende la pregunta y pide repetirla o explicarla.
 *
 * Con el motor nuevo el bot REACCIONA en vez de tragarse todo:
 *  - El spam se advierte ("lo proceso una sola vez") y, en caso extremo, la
 *    entrevista se pausa para revisión profesional y se recupera con "Continuar".
 *    Los ítems NO quedan comidos por el spam ni con parciales falsos.
 *  - Los mensajes sin sentido generan aclaraciones específicas ("no logro
 *    interpretarlo") y, acumulados, también llevan a pausa de revisión.
 *  - Texto libre (D08) ya no acepta disparates en silencio: pide aclaración.
 *
 * Ejecutar solo esta suite:
 *   pnpm test:borde
 */

/** Envío sin pausas de "respiro": spam real, tan rápido como la UI lo permita. */
async function sendBurst(page: Page, text: string): Promise<void> {
  const outBefore = await page.locator('#messages .msg-row.out').count();
  await humanType(page.locator('#message-input'), text);
  await humanPause(page, 120);
  await page.locator('#btn-send').click();
  await expect
    .poll(() => page.locator('#messages .msg-row.out').count(), { timeout: 60_000 })
    .toBeGreaterThan(outBefore);
  await waitForBotIdle(page);
}

test.describe('Casos borde · spam, mensajes sin sentido y pedidos de claridad', () => {
  test('1. spam: advertencia, pausa de revisión y recuperación con "Continuar"', async ({ page }) => {
    await test.step('Preparar la entrevista hasta D06 (estado civil)', async () => {
      await gotoApp(page);
      await createInterview(page, 'Xiomara Peñaloza', '+57 304 666 9021');
      await acceptGate(page);
      await answerCurrent(page, 'Me llamo Xiomara Peñaloza, tengo 34 años y nací el 3 de mayo de 1990 en Bogotá');
      await humanPause(page, 700);
      await snap(page, 'edge-01-en-d06');
    });

    await test.step('Ráfaga de "hola": dos saludos, dos advertencias, pausa', async () => {
      // Saludo 1: el bot reconoce smalltalk y reconduce ("Estamos en «Estado civil»…").
      await sendBurst(page, 'hola');
      await expect(page.locator('#messages')).toContainText('Estamos en «Estado civil»', { timeout: 30_000 });
      await snap(page, 'edge-01-spam-1-ack');

      // Saludo 2 idéntico: burst de 1, sigue solo el ack.
      await sendBurst(page, 'hola');
      await humanPause(page, 300);
      await snap(page, 'edge-01-spam-2-ack');

      // Saludo 3: burst de 2 → advertencia de spam + re-pregunta de D06.
      await sendBurst(page, 'hola');
      await expect(page.locator('#messages')).toContainText(/mismo mensaje varias veces/i, {
        timeout: 30_000,
      });
      await humanPause(page, 500);
      await snap(page, 'edge-01-spam-3-advertencia');

      // Saludo 4: otra advertencia.
      await sendBurst(page, 'hola');
      await humanPause(page, 500);
      await snap(page, 'edge-01-spam-4-advertencia');

      // Saludo 5: burst de 4 (máx) → la entrevista se PAUSA para revisión
      // profesional. Nada se registra como parcial ni se come ítems.
      await sendBurst(page, 'hola');
      await expect(page.locator('#messages')).toContainText('Voy a pausarla y avisar a un profesional', {
        timeout: 30_000,
      });
      await humanPause(page, 900);
      await snap(page, 'edge-01-spam-5-pausa');
    });

    await test.step('Recuperación: "Continuar" retoma D06 y una respuesta válida avanza', async () => {
      await expect(page.locator('#closed-banner')).toBeVisible({ timeout: 10_000 });
      await sendText(page, 'Continuar');
      await expect(page.locator('#messages')).toContainText(/Retomamos/i, { timeout: 30_000 });
      await snap(page, 'edge-01-recuperacion-retomamos');

      // D06 está intacto: el estado civil entra limpio y la entrevista
      // continúa hacia D07 (hijos).
      await answerCurrent(page, 'soltera');
      await expect(page.locator('#messages')).toContainText(/D07|hijos/i, { timeout: 30_000 });
      await humanPause(page, 1200);
      await snap(page, 'edge-01-recuperacion-d07');
    });
  });

  test('2. mensajes sin sentido: aclaraciones específicas, parcial informado y pausa', async ({ page }) => {
    await test.step('Preparar la entrevista hasta D07 (hijos)', async () => {
      await gotoApp(page);
      await createInterview(page, 'Nicolás Brathwaite', '+57 317 555 0340');
      await acceptGate(page);
      await answerCurrent(page, 'Me llamo Nicolás Brathwaite, tengo 41 años y nací el 12 de marzo de 1985 en Barranquilla');
      await answerCurrent(page, 'casado');
      await humanPause(page, 700);
      await snap(page, 'edge-02-en-d07');
    });

    await test.step('Galimatías sobre D07: aclaraciones y registro parcial avisado', async () => {
      // 1º: sin sentido pero interpretado como fuera de tema → aclaración.
      await sendText(page, 'inario ento selva redonda');
      await humanPause(page, 600);
      await snap(page, 'edge-02-sin-sentido-1');

      // 2º: detectado como nonsense (teclado, símbolos, ecos) → aclaración
      // específica de nonsense ("ese mensaje no logro interpretarlo").
      await sendText(page, 'zzz ~~~ qwerty');
      await expect(page.locator('#messages')).toContainText(/no logro interpretarlo/i, {
        timeout: 30_000,
      });
      await humanPause(page, 600);
      await snap(page, 'edge-02-sin-sentido-2');

      // 3º: se agotan los intentos de D07 → PARCIAL, pero avisado con calma.
      await sendText(page, 'ionionq wefer plunion es tu, cumpango');
      await expect(page.locator('#messages')).toContainText('parcial', { timeout: 30_000 });
      await expect(page.locator('#messages')).toContainText(/D08|dedicas/i, { timeout: 30_000 });
      await humanPause(page, 1300);
      await snap(page, 'edge-02-sin-sentido-parcial');
    });

    await test.step('Texto libre (D08) ya no acepta disparates en silencio', async () => {
      // El mismo galimatías sobre un ítem de texto libre ahora genera
      // aclaración (con el motor viejo se aceptaba y avanzaba a D09).
      await sendText(page, 'zzz 78452 ~~~ qwerty');
      await expect(page.locator('#messages')).toContainText(/no logro interpretarlo|me falta/i, {
        timeout: 30_000,
      });
      await humanPause(page, 600);
      await snap(page, 'edge-02-texto-libre-aclara');

      // Segundo disparate en la fila → segunda aclaración (el parcial ya se
      // vio en D07; aquí el texto libre insiste en pedir sentido también).
      await sendText(page, 'zzz zzz');
      await expect(page.locator('#messages')).toContainText(/no logro interpretarlo/i, {
        timeout: 30_000,
      });
      await humanPause(page, 1100);
      await snap(page, 'edge-02-texto-libre-aclara-2');
    });

    await test.step('Acumulación de nonsense en D08 → pausa de revisión profesional', async () => {
      // Cuarto mensaje sin sentido de la entrevista: el contador llega al
      // máximo y la entrevista se pausa para que un profesional la revise.
      await sendText(page, 'zzz zzz zzz');
      await expect(page.locator('#messages')).toContainText('Voy a pausarla y avisar a un profesional', {
        timeout: 30_000,
      });
      await expect(page.locator('#closed-banner')).toBeVisible({ timeout: 10_000 });
      await humanPause(page, 900);
      await snap(page, 'edge-02-pausa-sin-sentido');
    });

    await test.step('Recuperación: "Continuar" retoma D08 y una respuesta válida avanza', async () => {
      await sendText(page, 'Continuar');
      await expect(page.locator('#messages')).toContainText(/Retomamos/i, { timeout: 30_000 });
      await snap(page, 'edge-02-recuperacion-retomamos');
      // D08 quedó sin commit: tras retomar la pregunta, una respuesta válida
      // de texto libre entra limpia y la entrevista continúa hacia D09.
      await answerCurrent(page, 'estudios universitarios en diseño');
      await expect(page.locator('#messages')).toContainText(/D09|estudios/i, { timeout: 30_000 });
      await humanPause(page, 1100);
      await snap(page, 'edge-02-recuperacion-d09');
    });
  });

  test('3. pedidos de claridad: repetir, explicar y ejemplificar', async ({ page }) => {
    await test.step('Preparar la entrevista hasta D06 (estado civil)', async () => {
      await gotoApp(page);
      await createInterview(page, 'Ofelia Triviño', '+57 321 777 8899');
      await acceptGate(page);
      await answerCurrent(page, 'Me llamo Ofelia Triviño, tengo 37 años y nací el 9 de octubre de 1989 en Bucaramanga');
      await humanPause(page, 700);
      await snap(page, 'edge-03-en-d06');
    });

    await test.step('Pedir que repita la pregunta', async () => {
      await sendText(page, 'Disculpa, ¿puedes repetir la pregunta? Se me borró');
      // isRepeat: se reenvía el mismo prompt sin consumir intentos ni penalizar.
      await humanPause(page, 1100);
      await snap(page, 'edge-03-repetir-pregunta');
    });

    await test.step('Pedir una explicación más clara', async () => {
      await sendText(page, 'No entiendo esa pregunta, ¿me la puedes explicar mejor?');
      // isConfusion: aclara qué se espera y trae un ejemplo.
      await humanPause(page, 1300);
      await snap(page, 'edge-03-explicar-mejor');
    });

    await test.step('Pedir un ejemplo concreto', async () => {
      await sendText(page, 'No queda claro el formato, ¿me das un ejemplo?');
      await humanPause(page, 1300);
      await snap(page, 'edge-03-ejemplo');
    });

    await test.step('Responder ya con calma y avanzar', async () => {
      await answerCurrent(page, 'soltera');
      await expect(page.locator('#messages')).toContainText(/D07|Hijos/i, { timeout: 30_000 });
      await humanPause(page, 1100);
      await snap(page, 'edge-03-recuperacion');
    });
  });
});
