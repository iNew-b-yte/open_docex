import { defineConfig, devices } from '@playwright/test';

const browsers = (process.env.S3_BROWSERS ?? 'chromium').split(',');

export default defineConfig({
  testDir: 'tests',
  timeout: 600_000,
  workers: 1,
  reporter: 'list',
  projects: browsers.map((name) => ({
    name,
    use: {
      ...devices[{ chromium: 'Desktop Chrome', firefox: 'Desktop Firefox', webkit: 'Desktop Safari' }[name]],
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
    },
  })),
});
