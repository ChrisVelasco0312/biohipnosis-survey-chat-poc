import { test, expect } from '@playwright/test';
import {
  acceptGate,
  answerCurrent,
  clickQuick,
  createInterview,
  gotoApp,
  humanPause,
  sendText,
  snap,
} from './helpers';

/**
 * Recorrido completo de la sección A con ritmo humano.
 * La ventana queda visible para que se pueda observar cómo se usa la aplicación.
 */
test.describe('Entrevista inicial · recorrido visual', () => {
  test('crear entrevista, consentir y responder la sección A', async ({ page }) => {
    await test.step('Abrir la aplicación y alternar el tema', async () => {
      await gotoApp(page);
      await snap(page, '01-inicio');

      await page.locator('#theme-toggle').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await humanPause(page, 1400);
      await snap(page, '02-tema-oscuro');

      await page.locator('#theme-toggle').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await humanPause(page, 700);
    });

    await test.step('Crear la conversación desde el modal', async () => {
      await createInterview(page, 'Ana María Restrepo', '+57 300 123 4567');
      await snap(page, '03-saludo-y-verificacion-de-edad');
    });

    await test.step('Confirmar 18+ y aceptar el consentimiento', async () => {
      await clickQuick(page, 'age_yes');
      await expect(page.locator('.quick-btn[data-button-id="consent_yes"]').last()).toBeVisible();
      await humanPause(page, 1600);
      await snap(page, '04-consentimiento-informado');

      await clickQuick(page, 'consent_yes');
      await expect(page.locator('#messages')).toContainText('D01');
      await humanPause(page, 900);
      await snap(page, '05-primera-pregunta');
    });

    const sectionA = [
      {
        id: 'D01',
        label: 'Datos iniciales',
        text: 'Me llamo Ana María Restrepo, tengo 34 años y nací el 3 de mayo de 1990 en Bogotá',
      },
      { id: 'D06', label: 'Estado civil', text: 'soltera' },
      { id: 'D07', label: 'Hijos', text: 'no tengo' },
      { id: 'D08', label: 'Actividad actual', text: 'trabajo como diseñadora' },
      { id: 'D09', label: 'Estudios', text: 'estudios universitarios en diseño' },
      { id: 'D10', label: 'Enfermedades en la infancia', text: 'ninguna enfermedad importante' },
      { id: 'D11', label: 'Cirugías', text: 'no me han practicado ninguna cirugía' },
      { id: 'D12', label: 'Accidentes', text: 'no he tenido accidentes de ningún tipo' },
      { id: 'D13', label: 'Hobbies', text: 'me gusta leer y caminar' },
      { id: 'D14', label: 'Mano dominante', text: 'diestra' },
    ];

    for (const item of sectionA) {
      await test.step(`${item.id} · ${item.label}`, async () => {
        await answerCurrent(page, item.text);
        await snap(page, `seccion-a-${item.id.toLowerCase()}-${item.label.split(' ')[0].toLowerCase()}`);
      });
    }

    await test.step('Revisar el resumen de la sección A', async () => {
      const reviewYes = page.locator('.quick-btn[data-button-id="review_yes"]').last();
      await expect(reviewYes).toBeVisible({ timeout: 30_000 });
      await humanPause(page, 1800);
      await snap(page, '06-revision-seccion-a');
      await reviewYes.click();
      await humanPause(page, 1600);
      await expect(page.locator('#messages')).toContainText('motivo principal', { timeout: 30_000 });
      await snap(page, '07-inicio-seccion-b');
    });

    await test.step('Responder el motivo de consulta', async () => {
      await sendText(page, 'Siento ansiedad y problemas para dormir desde hace meses');
      await snap(page, '08-motivo-de-consulta');
    });

    await test.step('Pausar desde el menú de la conversación', async () => {
      await page.locator('#btn-chat-menu').click();
      await expect(page.locator('.modal')).toBeVisible();
      await humanPause(page, 1300);
      await snap(page, '09-menu-conversacion');
      await page.locator('.modal [data-menu="pause"]').click();
      await expect(page.locator('#closed-banner')).not.toHaveClass(/hidden/, { timeout: 30_000 });
      await expect(page.locator('#closed-banner')).toContainText('pausada');
      await humanPause(page, 1600);
      await snap(page, '10-entrevista-pausada');
    });

    await test.step('Reanudar donde quedó', async () => {
      await sendText(page, 'Continuar');
      await expect(page.locator('#closed-banner')).toHaveClass(/hidden/, { timeout: 30_000 });
      await humanPause(page, 1400);
      await snap(page, '11-entrevista-reanudada');
    });
  });
});
