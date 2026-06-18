// @ts-check
/**
 * Audit-7 v0.89.1 ship verification — admin endpoints E2E.
 *
 * Confirms the two new admin GET endpoints respond 200 with the
 * documented JSON shape, AND that the new /admin/metrics page
 * renders without a JS error. Self-cleaning: registers a per-test
 * sandbox via the existing helper; demo nightly prune removes it.
 *
 * Will get throttled by the per-IP registrationLimiter (3/hour) on
 * back-to-back retries; that''s working as designed.
 */
const { test, expect, request } = require('@playwright/test');
const { registerFreshAccount } = require('./helpers');

test.describe('admin endpoints (v0.89.1)', () => {
  test('db-pool-health + metrics/overview + /admin/metrics page', async ({ page, baseURL }) => {
    // 1. Register a fresh sandbox. DEMO_MODE grants admin role to the
    //    registering user, so subsequent /api/admin/* calls are allowed.
    await registerFreshAccount(page);

    // 2. Pull the JWT the SPA persisted (servicecycle_token key in localStorage).
    const token = await page.evaluate(() => window.localStorage.getItem('servicecycle_token'));
    expect(token, 'JWT should be in localStorage after register').toBeTruthy();

    // 3. Open a clean HTTP context with the Bearer header.
    const api = await request.newContext({
      baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    // ── db-pool-health ────────────────────────────────────────────────
    const poolResp = await api.get('/api/admin/db-pool-health');
    expect(poolResp.status(), `db-pool-health body: ${await poolResp.text()}`).toBe(200);
    const pool = await poolResp.json();
    expect(pool).toHaveProperty('success', true);
    expect(pool.data).toMatchObject({
      total: expect.any(Number),
      active: expect.any(Number),
      idle: expect.any(Number),
      max: expect.any(Number),
    });
    expect(pool.data.max).toBeGreaterThan(0);

    // ── metrics/overview ─────────────────────────────────────────────
    const mResp = await api.get('/api/admin/metrics/overview');
    expect(mResp.status(), `metrics body: ${await mResp.text()}`).toBe(200);
    const m = await mResp.json();
    expect(m).toHaveProperty('success', true);
    expect(m.data).toHaveProperty('totals');
    expect(m.data).toHaveProperty('signupsByDay');
    expect(m.data).toHaveProperty('contractsByDay');
    expect(m.data).toHaveProperty('dauByDay');
    expect(m.data).toHaveProperty('retention');
    expect(m.data).toHaveProperty('topActions7d');
    expect(m.data.totals.users).toBeGreaterThanOrEqual(1); // at least us
    expect(m.data.retention).toHaveProperty('cohortSize');
    expect(Array.isArray(m.data.topActions7d)).toBeTruthy();

    // ── /admin/metrics page ───────────────────────────────────────────
    const jsErrors = [];
    page.on('pageerror', err => jsErrors.push(err.message));
    await page.goto('/admin/metrics');
    // The Totals card always renders even with empty data.
    await expect(page.getByText(/totals/i).first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/Users/i).first()).toBeVisible();
    expect(jsErrors, `JS errors on /admin/metrics: ${jsErrors.join(' | ')}`).toEqual([]);
  });
});