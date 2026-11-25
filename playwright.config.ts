// Playwright configuration (LLD Part 3 §17, Part 1 §1.10). Each test starts its own engine, HTTP
// server and data folders on an ephemeral port (`e2e/harness/server.mjs`), so tests are
// independent and run in parallel. `npm run build` must come first: the harness serves the built
// client and runs the compiled server.
import { defineConfig, devices } from '@playwright/test';

const ci = process.env['CI'] !== undefined && process.env['CI'] !== '';

export default defineConfig({
  testDir: 'e2e/tests',
  testMatch: '**/*.spec.mjs',
  globalSetup: './e2e/harness/global-setup.mjs',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  workers: ci ? 2 : 3,
  outputDir: 'node_modules/.cache/open-docex-e2e-results',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: ci ? [['list'], ['html', { open: 'never', outputFolder: 'node_modules/.cache/open-docex-e2e-report' }]] : 'list',
  use: { trace: 'retain-on-failure', actionTimeout: 20_000, navigationTimeout: 30_000 },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
