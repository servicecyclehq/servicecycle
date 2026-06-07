// @ts-check
/**
 * Audit-7 / item 1.1.5 — register + login E2E.
 *
 * The single most valuable browser-driven test: confirms a brand-new
 * visitor can complete the demo signup, land in the authenticated app,
 * sign out cleanly, and sign back in. Catches any regression that breaks
 * the auth wiring (JWT format, refresh-token issuance, CORS, CSP,
 * cookie flags, redirect handling) without needing to inspect each
 * surface individually.
 */
const { test, expect } = require('@playwright/test');
const { registerFreshAccount, login } = require('./helpers');

test.describe('auth round-trip', () => {
  test('register, logout, login again', async ({ page }) => {
    // Register
    const { email, password } = await registerFreshAccount(page);
    await expect(page).toHaveURL(/\/(dashboard|contracts)/);

    // Log out via the sidebar "Sign out" button. force:true bypasses any
    // transient seed-demo overlay / toast that may still be fading out
    // after the registration network burst.
    const logout = page.locator('.logout-btn')
      .or(page.getByRole('button', { name: /sign\s*out|log\s*out/i }));
    await logout.first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await logout.first().click({ timeout: 15000, force: true });
    await page.waitForURL(/\/login|\/$/, { timeout: 15000 });

    // Log back in with the same credentials
    await login(page, email, password);
    await expect(page).toHaveURL(/\/(dashboard|contracts)/);
  });
});