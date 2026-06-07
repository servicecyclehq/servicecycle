// @ts-check
/**
 * Audit-7 / item 1.1.5 + 5.2.4 — non-stateful smoke.
 *
 * Catches the broadest regression class (entire SPA fails to boot, /login
 * doesn''t render, helmet/CSP blocks the bundle, demo droplet down) using
 * only public GET requests. Always safe to run, never trips the per-IP
 * registration rate limit (registrationLimiter: 3/hour). Run this BEFORE
 * register/CRUD/api-key tests to confirm the demo is reachable + the
 * client bundle is healthy; if smoke fails, the other tests are guaranteed
 * to fail too and there''s no point burning the per-IP budget.
 */
const { test, expect, request } = require('@playwright/test');

test.describe('smoke (read-only, no auth)', () => {
  test('GET /api/health returns ok', async ({ baseURL }) => {
    const api = await request.newContext({ baseURL });
    const resp = await api.get('/api/health');
    expect(resp.status()).toBe(200);
    const json = await resp.json();
    expect(json).toMatchObject({ success: true, data: { status: 'ok' } });
    expect(json.data).toHaveProperty('uptime');
  });

  test('/login renders the form without JS errors', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', err => jsErrors.push(err.message));

    await page.goto('/login');
    await expect(page.locator('#login-email')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#login-password')).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in|log in/i }).first()).toBeVisible();

    expect(jsErrors, `JS errors on /login: ${jsErrors.join(' | ')}`).toEqual([]);
  });

  test('/register renders the form without JS errors', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', err => jsErrors.push(err.message));

    await page.goto('/register');
    await expect(page.locator('#register-your-name')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#register-work-email')).toBeVisible();
    await expect(page.locator('#register-password')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();

    expect(jsErrors, `JS errors on /register: ${jsErrors.join(' | ')}`).toEqual([]);
  });

  // Audit 5.2.4 -- reset-password flow smoke. We do not actually submit
  // the form because the per-email forgot-reset rate limit (60s window)
  // would throttle repeated test runs. Asserting the form renders + the
  // submit affordance exists is the cheapest catch for a bundle break or
  // CSP regression on the reset surface.
  test('/forgot-password renders the form without JS errors', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', err => jsErrors.push(err.message));

    await page.goto('/forgot-password');
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('button[type="submit"]')).toBeVisible();

    expect(jsErrors, `JS errors on /forgot-password: ${jsErrors.join(' | ')}`).toEqual([]);
  });
});