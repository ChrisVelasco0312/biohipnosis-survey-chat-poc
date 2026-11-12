import { test, expect } from '@playwright/test';
import {
  acceptGate,
  answerCurrent,
  createInterview,
  gotoApp,
  humanPause,
  humanType,
  loginAdmin,
  snap,
} from './helpers';

/** Consola del profesional: respuestas, eventos, seguridad, costos y exportación. */
test.describe('Consola del profesional · recorrido visual', () => {
  test('desbloquear la consola y revisar todas las pestañas', async ({ page }) => {
    await test.step('Crear una sesión con dos respuestas', async () => {
      await gotoApp(page);
      await createInterview(page, 'Carlos Andrés Mejía', '+57 311 555 7788');
      await acceptGate(page);
      await answerCurrent(page, 'Me llamo Carlos Andrés Mejía, tengo 41 años y nací el 12 de julio de 1984 en Medellín');
      await answerCurrent(page, 'soltero');
    });

    await test.step('Desbloquear el inspector con el token de la POC', async () => {
      await loginAdmin(page, 'poc-admin');
      await expect(page.locator('.session-headline h3')).toContainText('Carlos');
      await humanPause(page, 1200);
      await snap(page, 'consola-01-sesion');
    });

    await test.step('Revelar PII (queda auditado)', async () => {
      await page.locator('.protected-banner [data-action="reveal"]').click();
      await expect(page.locator('.protected-banner.reveal')).toBeVisible({ timeout: 30_000 });
      await humanPause(page, 1300);
      await snap(page, 'consola-02-pii-revelada');
    });

    await test.step('Cuadrícula de respuestas', async () => {
      await page.locator('.tabs [data-tab="answers"]').click();
      await expect(page.locator('#inspector-body .answer-grid')).toBeVisible();
      await humanPause(page, 700);
      await page.locator('#inspector-body .answer-grid [data-item="D01"]').click();
      await expect(page.locator('#inspector-body .answer-detail h4')).toContainText('D01');
      await humanPause(page, 1300);
      await snap(page, 'consola-03-respuestas');
    });

    await test.step('Eventos y auditoría', async () => {
      await page.locator('.tabs [data-tab="events"]').click();
      await expect(page.locator('#inspector-body .event-list').first()).toBeVisible();
      await humanPause(page, 1300);
      await snap(page, 'consola-04-eventos');
    });

    await test.step('Ejecutar la suite de seguridad', async () => {
      await page.locator('.tabs [data-tab="security"]').click();
      await page.locator('#inspector-body [data-action="run-suite"]').click();
      await expect(page.locator('#inspector-body .check-row').first()).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => page.locator('#inspector-body .check-row').count()).toBeGreaterThanOrEqual(22);
      await humanPause(page, 1600);
      await snap(page, 'consola-05-seguridad-suite');
    });

    await test.step('Costos y presupuesto', async () => {
      await page.locator('.tabs [data-tab="costs"]').click();
      await expect(page.locator('#inspector-body .metric-card').first()).toBeVisible({ timeout: 30_000 });
      await humanPause(page, 1400);
      await snap(page, 'consola-06-costos');
    });

    await test.step('Exportar y generar el correo simulado', async () => {
      await page.locator('.tabs [data-tab="export"]').click();
      await expect(page.locator('#export-email')).toBeVisible({ timeout: 30_000 });
      await humanPause(page, 600);
      await humanType(page.locator('#export-email'), 'ana.restrepo@example.com');
      await humanPause(page, 500);
      await page.locator('#email-form button[type="submit"]').click();
      await expect(page.locator('#inspector-body .outbox-row').first()).toBeVisible({ timeout: 30_000 });
      await humanPause(page, 1400);
      await snap(page, 'consola-07-exportar');
    });
  });
});
