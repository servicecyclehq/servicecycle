// @ts-check
const { test, expect } = require('@playwright/test');

// ── LapseIQ deploy smoke suite (v0.90.2) ─────────────────────────────────────
//
// Runs against the live demo URL (E2E_BASE_URL, default https://demo.lapseiq.com)
// after every deploy. Designed to catch the entire class of "page X crashes on
// load" bugs that have bitten today's session: render-time TypeErrors,
// stale-chunk failures, API shape regressions.
//
// Strategy: log in once as admin@demo.local, then visit every protected route
// + ping every documented API endpoint. Fail the test on ANY of:
//   - non-2xx/3xx HTTP response from an API endpoint
//   - the ErrorBoundary heading "Something went wrong" appearing on any route
//   - the page failing to render its expected h1/landmark
//
// The deploy script wraps this — non-zero exit triggers automatic rollback
// to LAPSEIQ_VERSION_PREV via the lapseiq-mcp update_env_var allowlist.
//
// Demo creds: admin@demo.local / Admin1234! (per server/scripts/seed-demo.js).
// Demo password override available via E2E_ADMIN_PASSWORD env var.

const ADMIN_EMAIL    = process.env.E2E_ADMIN_EMAIL    || 'admin@demo.local';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'Admin1234!';

// Routes that authenticated admins should reach without an ErrorBoundary.
// Each entry is `{ path, expectedTitle, optionalSelectors }` — expectedTitle
// is a regex for the h1 or page title; optionalSelectors lists alternative
// landmarks that prove the page rendered (so we tolerate empty states).
// Every individual report page. Each is its own route that can crash on its
// own, so each gets its own smoke check (keep in sync with App.jsx routes).
const REPORT_SLUGS = [
  'renewal-horizon', 'risk-radar', 'savings-ledger', 'license-wastage', 'spend-ledger',
  'executive-spend', 'auto-renewal-exposure', 'vendor-concentration', 'non-saas-categories',
  'application-overlap', 'budget-shock-simulator', 'total-addressable-waste',
  'termination-window-violations', 'license-reclamation-roi', 'cost-per-active-user',
  'negotiation-effectiveness-by-owner', 'vendor-negotiation-difficulty', 'price-escalation-radar',
  'multi-year-commitment-risk', 'contract-health-score', 'department-budget-allocation',
  'price-per-seat-benchmark', 'gl-code-spend', 'walkaway-calculator', 'portfolio-decision-dashboard',
  'renewal-win-rate', 'contract-ownership', 'audit-evidence-pack', 'vendor-heat-map',
  'co-term-opportunity', 'renewal-commitment-forecast',
  // #19 (v0.92.0) conditional report; direct nav bypasses hub gating. Endpoint
  // returns 200 with hasAnchor:false when the account has no M365 suite license.
  'm365-overlap',
];

// Every sidebar/main page + admin pages. The route check only asserts "no
// ErrorBoundary + non-empty body", so gated/denied pages that render a message
// (rather than crash) still pass. `title` is informational, not asserted.
const PROTECTED_ROUTES = [
  { path: '/dashboard',          title: /Dashboard|Welcome|Activity/i },
  { path: '/contracts',          title: /Contracts/i },
  { path: '/contracts/new',      title: /New|Add|Contract/i },
  { path: '/contracts/archived', title: /Archived/i },
  { path: '/vendors',            title: /Vendors/i },
  { path: '/ingest',             title: /Upload|Ingest|Extract|Document/i },
  { path: '/budget',             title: /Budget|Forecast/i },
  { path: '/reports',            title: /Reports/i },
  { path: '/alerts',             title: /Alerts/i },
  { path: '/news',               title: /Vendor News|News|Headlines/i },
  { path: '/activity',           title: /Activity Log|Activity/i },
  { path: '/settings',           title: /Settings/i },
  { path: '/profile',            title: /Profile/i },
  { path: '/users',              title: /Users|Team|Members/i },
  { path: '/permissions',        title: /Permission|Role|Access/i },
  { path: '/admin/early-access', title: /.*/ },
  { path: '/admin/metrics',      title: /.*/ },

];

// API endpoints to ping. Each: method, path, expectedStatus, optional bodyAssert.
const API_ENDPOINTS = [
  { method: 'GET', path: '/api/setup/status',           expectStatus: 200 },
  { method: 'GET', path: '/api/auth/me',                expectStatus: 200 },
  { method: 'GET', path: '/api/config',                 expectStatus: 200 },
  { method: 'GET', path: '/api/bootstrap',              expectStatus: 200, bodyContains: ['contracts'] },
  { method: 'GET', path: '/api/contracts',              expectStatus: 200 },
  { method: 'GET', path: '/api/contracts/coterm-summary', expectStatus: 200 },
  { method: 'GET', path: '/api/vendors',                expectStatus: 200 },
  { method: 'GET', path: '/api/news?view=headlines',    expectStatus: 200 },
  { method: 'GET', path: '/api/news?view=outages',      expectStatus: 200 },
  { method: 'GET', path: '/api/news/summary',           expectStatus: 200, bodyContains: ['unreadHeadlines', 'unreadOutages'] },
  { method: 'GET', path: '/api/news/distinct/vendor',   expectStatus: 200, bodyContains: ['values'] },
  { method: 'GET', path: '/api/alerts',                 expectStatus: 200 },
  { method: 'GET', path: '/api/activity',               expectStatus: 200 },
  { method: 'GET', path: '/api/settings',               expectStatus: 200 },
  { method: 'GET', path: '/api/dashboard',              expectStatus: 200 },
];

let authToken = null;
let firstContractId = null;
let firstVendorId = null;

test.beforeAll(async ({ request, baseURL }) => {
  const res = await request.post(`${baseURL}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.status(), `login failed for ${ADMIN_EMAIL}`).toBe(200);
  const json = await res.json();
  authToken = (json && json.data && json.data.token) || json.token;
  expect(authToken, 'login returned no token').toBeTruthy();

  // Grab a real contract + vendor id so the detail-page checks have a live
  // target (their URLs carry a record id, so they can't be static entries).
  const cRes = await request.get(`${baseURL}/api/contracts`, { headers: { Authorization: `Bearer ${authToken}` } });
  const cJson = await cRes.json().catch(() => ({}));
  const contracts = (cJson && cJson.data && cJson.data.contracts) || [];
  firstContractId = contracts.length ? contracts[0].id : null;

  const vRes = await request.get(`${baseURL}/api/vendors`, { headers: { Authorization: `Bearer ${authToken}` } });
  const vJson = await vRes.json().catch(() => ({}));
  const vendors = (vJson && vJson.data && vJson.data.vendors) || [];
  firstVendorId = vendors.length ? vendors[0].id : null;
});

// ── Browser route checks ─────────────────────────────────────────────────────
//
// For each protected route: navigate, wait for hydration, assert NEITHER the
// ErrorBoundary heading nor a hard 4xx/5xx server error renders. This is the
// gate that would have caught today's /contracts crash AND the v0.89.7 stale-
// chunk silent-fail.

for (const route of PROTECTED_ROUTES) {
  test(`route: ${route.path} renders without ErrorBoundary`, async ({ page, baseURL }) => {
    // Bypass the SPA login by seeding the auth token from beforeAll into
    // localStorage before the React shell mounts. Matches how the app
    // restores sessions in normal use.
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => { window.localStorage.setItem('lapseiq_token', t); }, authToken);
    await page.goto(`${baseURL}${route.path}`, { waitUntil: 'networkidle' });

    // The ErrorBoundary renders an h1 with exactly this text. Any match means
    // the page crashed during render — fail the smoke test.
    const boundaryHeading = page.getByRole('heading', { name: /Something went wrong/i });
    await expect(boundaryHeading, `ErrorBoundary fired on ${route.path}`).toHaveCount(0, { timeout: 8000 });

    // Sanity: page rendered SOMETHING. Doesn't have to match a specific title
    // (route renames happen); just must not be blank or all-error.
    const bodyText = (await page.locator('body').innerText()).trim();
    expect(bodyText.length, `${route.path} rendered empty body`).toBeGreaterThan(20);
  });
}

// Detail pages (dynamic ids). High-traffic pages whose URL carries a record id.
// The contract detail page in particular is where two render crashes have hidden
// (no static path -> never smoke-covered). We also hit ?tab=renewal, the tab
// that crashed.
async function seedToken(page, baseURL, token) {
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => { window.localStorage.setItem('lapseiq_token', t); }, token);
}

test('route: /contracts/:id detail (both tabs) renders without ErrorBoundary', async ({ page, baseURL }) => {
  test.skip(!firstContractId, 'no contracts in this instance to open');
  await seedToken(page, baseURL, authToken);
  for (const url of [
    `${baseURL}/contracts/${firstContractId}`,
    `${baseURL}/contracts/${firstContractId}?tab=renewal`,
  ]) {
    await page.goto(url, { waitUntil: 'networkidle' });
    const boundary = page.getByRole('heading', { name: /Something went wrong/i });
    await expect(boundary, `ErrorBoundary on ${url}`).toHaveCount(0, { timeout: 8000 });
    const body = (await page.locator('body').innerText()).trim();
    expect(body.length, `${url} rendered empty body`).toBeGreaterThan(20);
  }
});

test('route: /vendors/:id detail renders without ErrorBoundary', async ({ page, baseURL }) => {
  test.skip(!firstVendorId, 'no vendors in this instance to open');
  await seedToken(page, baseURL, authToken);
  await page.goto(`${baseURL}/vendors/${firstVendorId}`, { waitUntil: 'networkidle' });
  const boundary = page.getByRole('heading', { name: /Something went wrong/i });
  await expect(boundary, 'ErrorBoundary on vendor detail').toHaveCount(0, { timeout: 8000 });
  const body = (await page.locator('body').innerText()).trim();
  expect(body.length, 'vendor detail rendered empty body').toBeGreaterThan(20);
});

// ── API endpoint checks ──────────────────────────────────────────────────────
//
// For each documented endpoint: send the request with the admin bearer,
// assert expected status, optionally assert key fields present in body.
// This is the gate that would have caught today's `/api/news/distinct/vendor`
// 500 (wrong Prisma relation name in v0.89.7).

for (const endpoint of API_ENDPOINTS) {
  test(`api: ${endpoint.method} ${endpoint.path}`, async ({ request, baseURL }) => {
    const res = await request[endpoint.method.toLowerCase()](`${baseURL}${endpoint.path}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status(), `${endpoint.method} ${endpoint.path} returned ${res.status()}`).toBe(endpoint.expectStatus);

    if (endpoint.bodyContains && endpoint.expectStatus === 200) {
      const body = await res.json().catch(() => ({}));
      const flat = JSON.stringify(body);
      for (const key of endpoint.bodyContains) {
        expect(flat, `${endpoint.path} body missing key "${key}"`).toContain(key);
      }
    }
  });
}

// ── Render-error telemetry liveness ──────────────────────────────────────────
//
// v0.90.0 endpoint. Always returns 204; persists if errorCode is present.
// We don't check persistence here (cleanup would be cross-cutting); a 204 on
// a well-formed POST is enough to prove the route + middleware chain works.

test('api: POST /api/errors/render (telemetry liveness)', async ({ request, baseURL }) => {
  const res = await request.post(`${baseURL}/api/errors/render`, {
    headers: { Authorization: `Bearer ${authToken}` },
    data:    { errorCode: 'SMOKE-' + Date.now().toString(36).toUpperCase(), message: 'smoke ping' },
  });
  expect(res.status()).toBe(204);
});
// â”€â”€ Reports: page loads with NO error banner AND its data query returns 200 â”€â”€
// Reports break in ways the basic route check misses: the page mounts fine (no
// ErrorBoundary) but shows a "Failed to load report" banner because the backing
// query errored on the data. So each report is checked at BOTH layers against
// the seeded data: no visible error banner, and a 200 from its data endpoint.

for (const slug of REPORT_SLUGS) {
  test(`report page: /reports/${slug} loads with no error banner`, async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => { window.localStorage.setItem('lapseiq_token', t); }, authToken);
    await page.goto(`${baseURL}/reports/${slug}`, { waitUntil: 'networkidle' });

    const boundary = page.getByRole('heading', { name: /Something went wrong/i });
    await expect(boundary, `ErrorBoundary on /reports/${slug}`).toHaveCount(0, { timeout: 8000 });

    // Report pages render a failed load as <div class="alert alert-error">. On a
    // fresh load (no export triggered) any error banner means the report broke.
    const errorBanner = page.locator('.alert-error');
    await expect(errorBanner, `error banner shown on /reports/${slug}`).toHaveCount(0, { timeout: 8000 });

    const body = (await page.locator('body').innerText()).trim();
    expect(body.length, `/reports/${slug} rendered empty body`).toBeGreaterThan(20);
  });
}

for (const slug of REPORT_SLUGS) {
  test(`report data: GET /api/reports/${slug}`, async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/api/reports/${slug}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status(), `GET /api/reports/${slug} returned ${res.status()}`).toBe(200);
  });
}

// -- Dashboard: redesigned alert cards render (v0.92.0) --------------------------
// The v0.92.0 redesign reworked the dashboard "Needs Attention Today" and
// "Auto-Renewal" cards onto a shared AttentionCard/Section/Row primitive set. A
// render-time TypeError in any primitive would blank or crash the whole
// dashboard. Assert both card titles render and no ErrorBoundary fired.
// "Needs Attention Today" always renders (populated or all-caught-up empty
// state); "Auto-Renewal" always renders via the summary card + action section
// (the side-by-side trap tile is shown only when traps > 0, so we assert on the
// always-present title text rather than the conditional tile).
test('dashboard: Needs Attention + Auto-Renewal cards render without ErrorBoundary', async ({ page, baseURL }) => {
  await seedToken(page, baseURL, authToken);
  await page.goto(`${baseURL}/dashboard`, { waitUntil: 'networkidle' });

  const boundary = page.getByRole('heading', { name: /Something went wrong/i });
  await expect(boundary, 'ErrorBoundary fired on /dashboard').toHaveCount(0, { timeout: 8000 });

  // Each redesigned card exposes its title text. A silently-unrendered card
  // (data-shape regression) would fail these visibility assertions.
  await expect(
    page.getByText('Needs Attention Today').first(),
    'Needs Attention Today card did not render'
  ).toBeVisible({ timeout: 8000 });
  await expect(
    page.getByText(/Auto-Renewal/).first(),
    'Auto-Renewal card did not render'
  ).toBeVisible({ timeout: 8000 });
});
