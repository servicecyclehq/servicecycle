// @ts-check
/**
 * Shared helpers for ServiceCycle E2E tests.
 *
 * The demo droplet prunes per-visitor accounts nightly (DEMO_MAX_ACCOUNTS
 * + 03:25 UTC sweep), so tests that register fresh visitors are
 * self-cleaning. Each test generates a unique email so reruns don''t
 * collide.
 */
const { expect } = require('@playwright/test');

function freshEmail(prefix = 'pw') {
  const ts = Date.now();
  const r = Math.floor(Math.random() * 9000) + 1000;
  return `${prefix}-${ts}-${r}@example.com`;
}

/**
 * Build a strong unique password that passes the Day-2 zxcvbn (score>=3)
 * + HIBP breach check. Embedding a timestamp guarantees uniqueness; the
 * three uncommon English words give zxcvbn enough entropy.
 */
function freshPassword() {
  return `Wombat-River-Quartz-72-${Date.now()}`;
}

/**
 * Register a fresh demo account end-to-end via the UI. Returns the
 * credentials so the caller can log back in for the same session.
 *
 * Caller is responsible for being on a clean page (Playwright spawns
 * a fresh context per test by default).
 */
async function registerFreshAccount(page) {
  const email = freshEmail();
  const password = freshPassword();
  const name = 'Playwright Test User';
  const companyName = 'PW E2E Co';

  await page.goto('/register');

  await page.fill('#register-your-name', name);
  await page.fill('#register-work-email', email);
  await page.fill('#register-company', companyName);
  await page.fill('#register-password', password);

  // Check every checkbox in the form. On the demo (DEMO_MODE=true) there
  // are two: US-scope attestation + ToS. On self-host there''s one (ToS).
  // Either way, "all checkboxes ticked" is the right state to submit.
  const checkboxes = page.locator('form input[type="checkbox"]');
  const count = await checkboxes.count();
  for (let i = 0; i < count; i++) {
    await checkboxes.nth(i).check();
  }

  await page.click('button[type="submit"]');

  // Successful register lands on /dashboard. The countryGate middleware
  // returns 403 instead of 200, in which case the URL doesn''t change --
  // the timeout below surfaces that as a clear failure.
  await page.waitForURL(/\/(dashboard|contracts)/, { timeout: 30000 });

  // After register, the demo runs seed-demo asynchronously and shows a
  // transient "Setting up..." toast/spinner. Wait for the network to
  // settle so subsequent clicks aren't intercepted by the overlay.
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  return { email, password, name, companyName };
}

/**
 * Log in with the given credentials. Assumes a logged-out state.
 */
async function login(page, email, password) {
  await page.goto('/login');
  await page.fill('#login-email', email);
  await page.fill('#login-password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(dashboard|contracts)/, { timeout: 30000 });
}

module.exports = { registerFreshAccount, login, freshEmail, freshPassword };