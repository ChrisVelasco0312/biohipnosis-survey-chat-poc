import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ARTIFACTS_DIR = path.resolve(here, '..', 'artifacts');

/** Multiplier for every deliberate pause. `E2E_PACE=fast` acelera sin quitar la demo visual. */
const PACE = process.env.E2E_PACE === 'fast' ? 0.3 : 1;

export async function humanPause(page: Page, ms = 900): Promise<void> {
  await page.waitForTimeout(Math.max(40, Math.round(ms * PACE)));
}

export async function snap(page: Page, name: string): Promise<void> {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(ARTIFACTS_DIR, `${name}.png`),
    animations: 'disabled',
  });
}

/** Escribe como una persona: clic, foco y una tecla cada ~45 ms. */
export async function humanType(locator: Locator, text: string): Promise<void> {
  const delay = Math.max(1, Math.round(Number(process.env.E2E_TYPE_DELAY ?? 45) * PACE));
  await locator.click();
  await locator.pressSequentially(text, { delay });
}

export async function waitForBotIdle(page: Page): Promise<void> {
  await expect(page.locator('#typing')).toHaveClass(/hidden/, { timeout: 60_000 });
  await expect(page.locator('#btn-send')).toBeEnabled({ timeout: 60_000 });
}

/** Escribe en el composer, envía y espera la respuesta del bot. */
export async function sendText(page: Page, text: string): Promise<void> {
  const outBefore = await page.locator('#messages .msg-row.out').count();
  await humanType(page.locator('#message-input'), text);
  await humanPause(page, 550);
  await page.locator('#btn-send').click();
  await expect
    .poll(() => page.locator('#messages .msg-row.out').count(), { timeout: 60_000 })
    .toBeGreaterThan(outBefore);
  await waitForBotIdle(page);
  await humanPause(page, 850);
}

export async function clickQuick(page: Page, buttonId: string): Promise<void> {
  const button = page.locator(`.quick-btn[data-button-id="${buttonId}"]`).last();
  await expect(button).toBeVisible({ timeout: 30_000 });
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.scrollIntoViewIfNeeded();
  await humanPause(page, 900);
  await button.click();
  await waitForBotIdle(page);
  await humanPause(page, 800);
}

export async function gotoApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveTitle(/Biohipnosis/);
  await expect(page.locator('#model-line')).not.toHaveText(/Comprobando modelo/, { timeout: 30_000 });
  await humanPause(page, 800);
}

/** Crea una entrevista desde la interfaz y espera el saludo con el botón de edad. */
export async function createInterview(
  page: Page,
  name: string,
  phone = '+57 300 123 4567',
): Promise<void> {
  await page.locator('#new-chat').click();
  await expect(page.locator('.modal')).toBeVisible();
  await humanPause(page, 700);
  await humanType(page.locator('#create-name'), name);
  await humanPause(page, 350);
  if (phone) await humanType(page.locator('#create-phone'), phone);
  await humanPause(page, 700);
  await page.locator('.modal button[type="submit"]').click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('.quick-btn[data-button-id="age_yes"]').last()).toBeVisible({
    timeout: 30_000,
  });
  await waitForBotIdle(page);
  await humanPause(page, 900);
}

/** Confirma 18+ y consentimiento; deja la sesión en D01. */
export async function acceptGate(page: Page): Promise<void> {
  await clickQuick(page, 'age_yes');
  await expect(page.locator('.quick-btn[data-button-id="consent_yes"]').last()).toBeVisible({
    timeout: 30_000,
  });
  await humanPause(page, 1200);
  await clickQuick(page, 'consent_yes');
  await expect(page.locator('#messages')).toContainText('D01', { timeout: 30_000 });
  await humanPause(page, 700);
}

/**
 * Responde la pregunta actual. Si es un ítem crítico, el bot pide confirmación
 * y el helper pulsa «Sí, es correcto».
 */
export async function answerCurrent(page: Page, text: string): Promise<void> {
  await sendText(page, text);
  const lastMessage = page.locator('#messages .msg-row').last();
  const confirm = lastMessage.locator('.quick-btn[data-button-id="confirm_yes"]');
  if ((await confirm.count()) > 0) {
    await expect(confirm).toBeEnabled({ timeout: 30_000 });
    await humanPause(page, 1100);
    await confirm.click();
    await waitForBotIdle(page);
    await humanPause(page, 800);
  }
}

/** Abre el inspector y desbloquea la consola con el token de la POC. */
export async function loginAdmin(page: Page, token = 'poc-admin'): Promise<void> {
  const content = page.locator('#inspector-content');
  if (!(await content.isVisible().catch(() => false))) {
    await page.locator('#btn-inspector').click();
    await humanPause(page, 500);
    await humanType(page.locator('#admin-token'), token);
    await humanPause(page, 400);
    await page.locator('#admin-login-form button[type="submit"]').click();
  }
  await expect(content).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#inspector-body')).not.toBeEmpty({ timeout: 30_000 });
  await humanPause(page, 900);
}

/** Ejecuta un escenario del laboratorio y espera a que el registro quede «Listo». */
export async function runLabScenario(page: Page, name: string): Promise<void> {
  const rowsBefore = await page.locator('#lab-log .lab-log-row').count();
  await humanPause(page, 700);
  await page.locator(`[data-scenario="${name}"]`).click();
  await expect(page.locator('#lab-status')).toHaveText('Listo', { timeout: 60_000 });
  await expect
    .poll(() => page.locator('#lab-log .lab-log-row').count(), { timeout: 30_000 })
    .toBeGreaterThan(rowsBefore);
  await humanPause(page, 900);
}

export async function closeModal(page: Page): Promise<void> {
  await page.locator('.modal-actions button').last().click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await humanPause(page, 500);
}
