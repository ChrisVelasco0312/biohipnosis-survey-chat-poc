import { test, expect } from '@playwright/test';
import { gotoApp, humanPause, sendText, snap } from './helpers';

/** Prueba libre: saltar a preguntas, repetir el intento y salir sin sesión real. */
test.describe('Simulador · prueba libre por pregunta', () => {
  test('salta a una pregunta, la repite y cambia a una sección sin guardar sesión', async ({ page }) => {
    await test.step('Abrir el laboratorio y elegir una pregunta', async () => {
      await gotoApp(page);
      await page.locator('#btn-testlab').click();
      await expect(page.locator('#testlab')).toHaveClass(/open/);
      await page.locator('#lab-test-question').click();
      await expect(page.locator('.modal')).toBeVisible();
      await page.locator('#picker-filter').fill('M01');
      await expect(page.locator('.picker-item')).toHaveCount(1);
      await humanPause(page, 600);
      await snap(page, 'libre-01-selector-pregunta');
      await page.locator('.picker-item').click();
    });

    await test.step('La sesión de prueba salta directo a M01', async () => {
      await expect(page.locator('#sandbox-bar')).toBeVisible();
      await expect(page.locator('#chat-name')).toHaveText('Prueba libre');
      await expect(page.locator('#messages')).toContainText(/motivo principal/i);
      await expect(page.locator('#testlab')).not.toHaveClass(/open/);
      await humanPause(page, 700);
      await snap(page, 'libre-02-pregunta-aislada');
    });

    await test.step('Responder y repetir el intento con el historial limpio', async () => {
      await sendText(page, 'Me siento muy ansioso y no puedo dormir desde hace meses.');
      await expect(page.locator('#messages .msg-row.out').last()).not.toContainText(/motivo principal/i);
      await page.locator('#sandbox-repeat').click();
      await expect(page.locator('#messages .msg-row.out').last()).toContainText(/motivo principal/i);
      await expect(page.locator('#messages .msg-row.in')).toHaveCount(0);
      await humanPause(page, 700);
      await snap(page, 'libre-03-repetir-pregunta');
    });

    await test.step('Cambiar a una sección completa y salir', async () => {
      await page.locator('#sandbox-change').click();
      await expect(page.locator('.modal')).toBeVisible();
      await page.locator('[data-section="B"]').click();
      await expect(page.locator('#sandbox-target')).toContainText(/sección completa/i);
      await expect(page.locator('#messages')).toContainText(/motivo principal/i);
      await humanPause(page, 700);
      await snap(page, 'libre-04-seccion-completa');
      await page.locator('#sandbox-exit').click();
      await expect(page.locator('#sandbox-bar')).toHaveClass(/hidden/);
      await expect(page.locator('#empty-chat')).toBeVisible();
    });
  });
});
