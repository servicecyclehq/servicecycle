// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * ServiceCycle End-to-End tests.
 *
 * Defaults to running against the live demo at https://servicecycle.app.
 * Override with E2E_BASE_URL=http://localhost:5173 to point at a local
 * docker-compose stack. Demo prunes new accounts nightly, so tests that
 * register fresh visitors are self-cleaning.
 *
 * One project: Chromium. Cross-browser is post-launch hardening.
 *
 * Retries are 1 because the demo is shared infra; transient 429s on the
 * registrationLimiter (3/hour/IP) are recovered by retry. If retries
 * mask a real regression, set CI=true (which disables retries in
 * Playwright's recommended config).
 */
module.exports = defineConfig({
  testDir: './e2e',
  timeout: 60 * 1000,
  expect: { timeout: 10 * 1000 },
  fullyParallel: false,                          // demo registrationLimiter: 3/hour/IP
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 0 : 1,
  workers: 1,                                    // serialise so tests don''t race rate-limiter budget
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'https://servicecycle.app',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    headless: true,
    actionTimeout: 15 * 1000,
    navigationTimeout: 30 * 1000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});