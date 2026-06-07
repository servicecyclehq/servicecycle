// @ts-check
//
// Per-report smoke. Hits every /reports/* sub-path AND the matching backend
// endpoint, fails on ErrorBoundary, 500/4xx (except 404), or empty body.
// One-off addendum to e2e/smoke.spec.js for the v0.90.6 ruthless-quality pass.
//
const { test, expect } = require('@playwright/test');

const ADMIN_EMAIL    = process.env.E2E_ADMIN_EMAIL    || 'admin@demo.local';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'Admin1234!';

// Pair = { path, api } where api is the route under /api/reports/* the page calls.
// `api: null` => the page is a pure client-side calculator with no fetch.
const REPORTS = [
  { path: '/reports/renewal-horizon',                  api: '/api/reports/renewal-horizon' },
  { path: '/reports/risk-radar',                       api: '/api/reports/risk-radar' },
  { path: '/reports/savings-ledger',                   api: '/api/reports/savings-ledger' },
  { path: '/reports/license-wastage',                  api: '/api/reports/license-wastage' },
  { path: '/reports/spend-ledger',                     api: '/api/reports/spend-ledger' },
  { path: '/reports/executive-spend',                  api: '/api/reports/executive-spend' },
  { path: '/reports/auto-renewal-exposure',            api: '/api/reports/auto-renewal-exposure' },
  { path: '/reports/vendor-concentration',             api: '/api/reports/vendor-concentration' },
  { path: '/reports/non-saas-categories',              api: '/api/reports/non-saas-categories' },
  { path: '/reports/application-overlap',              api: '/api/reports/application-overlap' },
  { path: '/reports/budget-shock-simulator',           api: null },
  { path: '/reports/total-addressable-waste',          api: '/api/reports/total-addressable-waste' },
  { path: '/reports/termination-window-violations',    api: '/api/reports/termination-window-violations' },
  { path: '/reports/license-reclamation-roi',          api: '/api/reports/license-reclamation-roi' },
  { path: '/reports/cost-per-active-user',             api: '/api/reports/cost-per-active-user' },
  { path: '/reports/negotiation-effectiveness-by-owner', api: '/api/reports/negotiation-effectiveness-by-owner' },
  { path: '/reports/vendor-negotiation-difficulty',    api: '/api/reports/vendor-negotiation-difficulty' },
  { path: '/reports/price-escalation-radar',           api: '/api/reports/price-escalation-radar' },
  { path: '/reports/multi-year-commitment-risk',       api: '/api/reports/multi-year-commitment-risk' },
  { path: '/reports/contract-health-score',            api: '/api/reports/contract-health-score' },
  { path: '/reports/department-budget-allocation',     api: '/api/reports/department-budget-allocation' },
  { path: '/reports/price-per-seat-benchmark',         api: '/api/reports/price-per-seat-benchmark' },
  { path: '/reports/gl-code-spend',                    api: '/api/reports/gl-code-spend' },
  { path: '/reports/walkaway-calculator',              api: '/api/reports/walkaway-calculator' },
  { path: '/reports/portfolio-decision-dashboard',     api: '/api/reports/portfolio-decision-dashboard' },
  { path: '/reports/renewal-win-rate',                 api: '/api/reports/renewal-win-rate' },
  { path: '/reports/contract-ownership',               api: '/api/reports/contract-ownership' },
  { path: '/reports/audit-evidence-pack',              api: '/api/reports/audit-evidence-pack' },
  { path: '/reports/vendor-heat-map',                  api: '/api/reports/vendor-heat-map' },
  { path: '/reports/co-term-opportunity',              api: '/api/reports/co-term-opportunity' },
  { path: '/reports/renewal-commitment-forecast',      api: '/api/reports/renewal-commitment-forecast' },
];

let authToken = null;

test.beforeAll(async ({ request, baseURL }) => {
  const res = await request.post(`${baseURL}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.status()).toBe(200);
  const json = await res.json();
  authToken = (json && json.data && json.data.token) || json.token;
  expect(authToken).toBeTruthy();
});

for (const r of REPORTS) {
  test(`page: ${r.path} renders`, async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => { window.localStorage.setItem('lapseiq_token', t); }, authToken);
    await page.goto(`${baseURL}${r.path}`, { waitUntil: 'networkidle' });
    const boundary = page.getByRole('heading', { name: /Something went wrong/i });
    await expect(boundary, `ErrorBoundary fired on ${r.path}`).toHaveCount(0, { timeout: 8000 });
    // also catch soft-failure "Failed" copy that some report pages render in
    // place of the chart when their fetch rejects.
    const failedText = page.getByText(/^(Failed to load|Failed to fetch|Error loading)/i);
    await expect(failedText, `Failed-to-load copy on ${r.path}`).toHaveCount(0, { timeout: 4000 });
    const body = (await page.locator('body').innerText()).trim();
    expect(body.length).toBeGreaterThan(20);
  });
}

for (const r of REPORTS.filter(x => x.api)) {
  test(`api: GET ${r.api}`, async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}${r.api}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    // 200 OK or 404 Not Found (endpoint not implemented) are both acceptable;
    // 500 / 4xx other = fail.
    const s = res.status();
    expect([200, 404]).toContain(s);
    if (s === 500) {
      throw new Error(`${r.api} returned 500`);
    }
  });
}
