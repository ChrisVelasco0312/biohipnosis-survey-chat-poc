import { test, expect } from '@playwright/test';
import {
  acceptGate,
  closeModal,
  createInterview,
  gotoApp,
  humanPause,
  loginAdmin,
  runLabScenario,
  snap,
} from './helpers';

/** Laboratorio de pruebas: ataques, crisis, voz, suite, auditoría y costos. */
test.describe('Laboratorio de pruebas · recorrido visual', () => {
  test('ejecutar escenarios deterministas y observar los resultados', async ({ page }) => {
    await test.step('Preparar una sesión y desbloquear la administración', async () => {
      await gotoApp(page);
      await createInterview(page, 'Laura Sofía Cárdenas', '+57 320 444 1122');
      await acceptGate(page);
      await loginAdmin(page, 'poc-admin');
      await expect(page.locator('#inspector-content')).toBeVisible();
    });

    await test.step('Abrir el laboratorio', async () => {
      await page.locator('#btn-testlab').click();
      await expect(page.locator('#testlab')).toHaveClass(/open/);
      await expect(page.locator('#drawer-backdrop')).toHaveClass(/show/);
      await humanPause(page, 1300);
      await snap(page, 'lab-01-panel');
    });

    await test.step('Inyección de prompt', async () => {
      await runLabScenario(page, 'injection');
      await expect(page.locator('#messages')).toContainText(/No puedo cambiar mis instrucciones/i, {
        timeout: 30_000,
      });
      await humanPause(page, 1200);
      await snap(page, 'lab-02-inyeccion-bloqueada');
    });

    await test.step('Solicitud de diagnóstico', async () => {
      await runLabScenario(page, 'diagnosis');
      await expect(page.locator('#messages')).toContainText(/No puedo darte un diagnóstico/i, {
        timeout: 30_000,
      });
      await humanPause(page, 1200);
      await snap(page, 'lab-03-diagnostico-bloqueado');
    });

    await test.step('Voz con confianza baja', async () => {
      await runLabScenario(page, 'voice-low');
      await expect(page.locator('#messages')).toContainText(/confianza 32%/i, {
        timeout: 30_000,
      });
      await humanPause(page, 1200);
      await snap(page, 'lab-04-voz-baja-confianza');
    });

    await test.step('Crisis actual', async () => {
      await runLabScenario(page, 'crisis');
      await expect(page.locator('#messages')).toContainText(/Atención prioritaria|123|106|155/i, {
        timeout: 30_000,
      });
      await humanPause(page, 2000);
      await snap(page, 'lab-05-crisis');
    });

    await test.step('Suite de seguridad 22 controles', async () => {
      await runLabScenario(page, 'suite');
      await expect(page.locator('.modal')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.modal .check-row').first()).toBeVisible();
      await expect.poll(() => page.locator('.modal .check-row').count()).toBeGreaterThanOrEqual(22);
      await humanPause(page, 1600);
      await snap(page, 'lab-06-suite-seguridad');
      await closeModal(page);
    });

    await test.step('Verificar la cadena de auditoría', async () => {
      await runLabScenario(page, 'audit');
      await expect(page.locator('.modal')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.modal')).toContainText(/Auditoría (válida|rota)/i);
      await humanPause(page, 1600);
      await snap(page, 'lab-07-auditoria');
      await closeModal(page);
    });

    await test.step('Costos y uso', async () => {
      await runLabScenario(page, 'metrics');
      await expect(page.locator('.modal')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.modal')).toContainText(/Costos y uso/i);
      await humanPause(page, 1600);
      await snap(page, 'lab-08-costos');
      await closeModal(page);
    });
  });
});
