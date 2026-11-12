import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.E2E_DATA_DIR
  ? path.resolve(process.env.E2E_DATA_DIR)
  : path.resolve(here, '.data');

const PORT = Number(process.env.E2E_PORT ?? 3310);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

// Ventana visible por defecto: el objetivo es poder *observar* la aplicación.
// E2E_HEADLESS=1 para CI. E2E_SLOWMO ajusta la pausa entre acciones de Playwright.
const headless = process.env.E2E_HEADLESS === '1';
const slowMo = Number(process.env.E2E_SLOWMO ?? 180);

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  globalTimeout: 45 * 60_000,
  timeout: 15 * 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // On NixOS the dev shell exports a patchelf'd Chromium (flake.nix);
    // the default ~/.cache/ms-playwright build cannot load system libs.
    launchOptions: {
      ...(process.env.CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
        : {}),
      slowMo,
    },
  },
  webServer: {
    command: 'node ../server/index.js',
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      POC_HOST: '127.0.0.1',
      POC_PORT: String(PORT),
      POC_DATA_DIR: dataDir,
      // Determinista y rápido para que la demo no dependa de la red ni de cuotas.
      // E2E_LLM=opencode para observar el modelo real.
      POC_LLM: process.env.E2E_LLM ?? 'off',
      POC_RATE_LIMIT: 'off',
      POC_ADMIN_TOKEN: 'poc-admin',
    },
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1600, height: 1000 },
        headless,
      },
    },
  ],
});
