// @ts-check
/**
 * Audit-7 / item 1.1.5 — API key issuance + use.
 *
 * Closes the enterprise / public-API surface. Steps:
 *   1. Register a fresh demo account (via UI).
 *   2. Navigate to /settings, find the API Keys tab, click "Create" or
 *      similar.
 *   3. Capture the one-time-display key value.
 *   4. From outside the browser context (raw fetch), call
 *      GET /api/v1/contracts with that key and assert 200 + a list shape.
 *
 * This catches: API key DB write breaks, public REST middleware
 * regression, scope / permission check accidentally tightened, missing
 * Bearer auth header parsing on the public API surface.
 */
const { test, expect, request } = require('@playwright/test');
const { registerFreshAccount } = require('./helpers');

test.describe('public API key', () => {
  test('create key, use to fetch /api/v1/contracts', async ({ page, baseURL }) => {
    await registerFreshAccount(page);

    // Hit the Settings page directly. The exact URL slug for the API
    // Keys tab has shifted across versions -- /settings is the stable
    // landing and the tab is the first or second tab in the SettingsPage
    // component. We navigate and then activate the tab by visible name.
    await page.goto('/settings');
    const tab = page.getByRole('tab', { name: /api keys/i })
      .or(page.getByRole('link', { name: /api keys/i }))
      .or(page.getByRole('button', { name: /api keys/i }));
    if (await tab.count()) {
      await tab.first().click({ timeout: 15000 });
    }

    // Look for the create-key affordance. Settings.jsx exposes a "Create
    // API key" or "Generate" or "New API key" button depending on the
    // version. Match any of the conventional wordings.
    const createButton = page.getByRole('button', { name: /create.*key|generate.*key|new.*key/i });
    await expect(createButton.first()).toBeVisible({ timeout: 15000 });
    await createButton.first().click();

    // Some flows ask for a label / name first. If a name input appears,
    // fill it before submitting the modal.
    const nameInput = page.locator('input[placeholder*="name" i], input[placeholder*="label" i]').first();
    if (await nameInput.count() && await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await nameInput.fill('playwright-e2e-key');
      const modalCreate = page.getByRole('button', { name: /create|generate|save/i });
      await modalCreate.first().click();
    }

    // The new key is displayed once; the canonical pattern is to render
    // it inside a <code> or <pre> element. Pull the longest token-looking
    // string from the visible content of the page.
    await page.waitForTimeout(1500);
    const candidates = await page.locator('code, pre, [class*="key"], [class*="token"]').allTextContents();
    const apiKey = candidates
      .flatMap(s => s.split(/\s+/))
      .find(s => /^lapse?(_| )?[A-Za-z0-9_\-]{20,}$|^[A-Za-z0-9_\-]{32,}$/.test(s));

    expect(apiKey, `no API-key-shaped token found in: ${candidates.join(' | ')}`).toBeTruthy();

    // Now use the key from outside the browser. Playwright''s request
    // fixture is a clean HTTP client, not the SPA''s session cookies.
    const api = await request.newContext({ baseURL });
    const resp = await api.get('/api/v1/contracts', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(resp.status(), `body: ${await resp.text()}`).toBe(200);
    const json = await resp.json();
    // The public API contract returns { success: true, data: [...] }
    expect(json).toHaveProperty('success', true);
    expect(json).toHaveProperty('data');
  });
});