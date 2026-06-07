// @ts-check
/**
 * Audit-7 / item 1.1.5 — contract list smoke.
 *
 * After auth, the /contracts page is the canonical landing surface for
 * the core product (it is what every paying user opens first). This
 * test asserts the page renders without a JS error and either shows
 * the contracts table or the empty-state CTA. Catches: SPA route
 * bundle regression, API-side findMany() blowing up, server middleware
 * breaking the request, CSP blocking a critical asset.
 *
 * Does NOT exercise the create-contract form. The form is intentionally
 * out of scope for the smoke pass -- it has many fields that change with
 * each Phase 4 / Phase 5 release and would generate fragile-test churn.
 * If create-contract is genuinely broken, the dashboard-load surface
 * normally surfaces it first.
 */
const { test, expect } = require('@playwright/test');
const { registerFreshAccount } = require('./helpers');

test.describe('contracts page', () => {
  test('renders without error after register', async ({ page }) => {
    await registerFreshAccount(page);

    // Capture any uncaught JS errors during the navigation. These are the
    // class of regression that doesn''t show up in server logs but breaks
    // the SPA for every visitor.
    const jsErrors = [];
    page.on('pageerror', err => jsErrors.push(err.message));

    await page.goto('/contracts');

    // Either the empty state or the contracts table must be present.
    // A fresh demo signup gets seeded ~30 contracts via seed-demo.js, so
    // the table is the expected path; we keep the empty-state alternative
    // for self-host smoke runs that don''t pre-seed.
    const tableOrEmpty = page.getByRole('table')
      .or(page.getByText(/no contracts|let''s add your first/i));
    await expect(tableOrEmpty.first()).toBeVisible({ timeout: 15000 });

    expect(jsErrors, `JS errors on /contracts: ${jsErrors.join(' | ')}`).toEqual([]);
  });
});