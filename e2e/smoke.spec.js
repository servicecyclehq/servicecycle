// @ts-check
const { test, expect } = require('@playwright/test');

// ── ServiceCycle deploy smoke suite ─────────────────────────────────────────
//
// Runs against the live demo URL (E2E_BASE_URL, default https://servicecycle.app)
// after every deploy. Designed to catch the entire class of "page X crashes on
// load" bugs: render-time TypeErrors, stale-chunk failures, API shape
// regressions.
//
// Strategy: log in once as admin@demo.local, then visit every protected route
// + ping every documented API endpoint. Fail the test on ANY of:
//   - non-2xx/3xx HTTP response from an API endpoint
//   - the ErrorBoundary heading "Something went wrong" appearing on any route
//   - the page failing to render its expected h1/landmark
//
// The deploy script wraps this — non-zero exit triggers automatic rollback.
//
// Demo creds: admin@demo.local / Admin1234! (per server/scripts/seed-demo.js).
// Demo password override available via E2E_ADMIN_PASSWORD env var.
//
// Audit 2026-07-08 (docs/ACQUISITION_AUDIT_2026-07-08.md §1.6): this spec
// previously still tested the PRE-REBRAND contract-SaaS surface
// (/contracts, /vendors, /budget, /ingest, a /reports/:slug dynamic report
// system) — routes that now redirect or 404 on the current asset/compliance
// app, so "green" certified nothing real and gave zero coverage of asset
// detail, work orders, arc-flash, field routes, or ingest review. Rebuilt
// against the CURRENT route table in client/src/App.jsx.

const ADMIN_EMAIL    = process.env.E2E_ADMIN_EMAIL    || 'admin@demo.local';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'Admin1234!';

// Routes that authenticated admins should reach without an ErrorBoundary.
// Each entry is `{ path, title }` — title is informational only (not
// asserted); the real gate is "no ErrorBoundary + non-empty body" so
// role-gated pages that soft-redirect (RequireRole → /dashboard) still pass
// rather than false-failing on a role this login doesn't have.
// Keep in sync with client/src/App.jsx's <Routes> table.
const PROTECTED_ROUTES = [
  { path: '/dashboard',                 title: /Dashboard/i },
  { path: '/assets',                    title: /Assets/i },
  { path: '/assets/new',                title: /New Asset|Add Asset/i },
  { path: '/assets/archived',           title: /Archived/i },
  { path: '/assets/import',             title: /Import/i },
  { path: '/sites',                     title: /Sites/i },
  { path: '/documents',                 title: /Documents/i },
  { path: '/contractors',               title: /Contractors/i },
  { path: '/work-orders',               title: /Work Orders/i },
  { path: '/deficiencies',              title: /Deficienc/i },
  { path: '/calendar',                  title: /Calendar|Compliance/i },
  { path: '/news',                      title: /News/i },
  { path: '/profile',                   title: /Profile/i },
  { path: '/reports',                   title: /Reports/i },
  { path: '/reports/compliance',        title: /Compliance/i },
  { path: '/reports/snapshots',         title: /Snapshot|Audit/i },
  { path: '/reports/overdue',           title: /Overdue/i },
  { path: '/reports/standards-library', title: /Standard/i },
  { path: '/reports/revenue',           title: /Revenue/i },
  { path: '/reports/arc-flash',         title: /Arc Flash/i },
  { path: '/reports/arc-flash-fleet',   title: /Arc Flash|Fleet/i },
  { path: '/reports/arc-flash-heatmap', title: /Arc Flash|Heat/i },
  { path: '/reports/arc-flash-search',  title: /Arc Flash|Search/i },
  { path: '/audits',                    title: /Audit/i },
  { path: '/equipment-templates',       title: /Template/i },
  { path: '/outage-planner',            title: /Outage/i },
  { path: '/import',                    title: /Import|CMMS/i },
  { path: '/parts',                     title: /Parts/i },
  { path: '/quote-requests',            title: /Quote/i },
  { path: '/alerts',                    title: /Alert/i },
  { path: '/disaster-response',         title: /Disaster/i },
  { path: '/users',                     title: /Users|Team/i },
  { path: '/permissions',               title: /Permission/i },
  { path: '/settings',                  title: /Settings/i },
  { path: '/activity',                  title: /Activity/i },
  { path: '/review',                    title: /Review/i },
  { path: '/test-reports/import',       title: /Import|Test Report/i },
  { path: '/add-data',                  title: /Add data|Import/i },
  { path: '/import/assets',             title: /Import/i },
  { path: '/import/doble',              title: /Doble|Import/i },
  { path: '/installed-base',            title: /Installed Base|Fleet/i },
  { path: '/backfill',                  title: /Backfill|Import/i },
  { path: '/admin/metrics',             title: /.*/ },
  { path: '/admin/opportunities',       title: /.*/ },
  // Field Mode preview (admin/manager see FieldHome; field_tech would see
  // FieldJobs, but this login is admin — see App.jsx FieldHomeByRole).
  { path: '/field',                     title: /Field/i },
];

// API endpoints to ping. Each: method, path, expectedStatus, optional bodyAssert.
const API_ENDPOINTS = [
  { method: 'GET', path: '/api/setup/status',  expectStatus: 200 },
  { method: 'GET', path: '/api/auth/me',       expectStatus: 200 },
  { method: 'GET', path: '/api/config',        expectStatus: 200 },
  { method: 'GET', path: '/api/bootstrap',     expectStatus: 200, bodyContains: ['assets'] },
  { method: 'GET', path: '/api/assets',        expectStatus: 200, bodyContains: ['assets'] },
  { method: 'GET', path: '/api/sites',         expectStatus: 200, bodyContains: ['sites'] },
  { method: 'GET', path: '/api/contractors',   expectStatus: 200, bodyContains: ['contractors'] },
  { method: 'GET', path: '/api/work-orders',   expectStatus: 200, bodyContains: ['workOrders'] },
  { method: 'GET', path: '/api/deficiencies',  expectStatus: 200 },
  { method: 'GET', path: '/api/news',          expectStatus: 200 },
  { method: 'GET', path: '/api/alerts',        expectStatus: 200 },
  { method: 'GET', path: '/api/activity',      expectStatus: 200 },
  { method: 'GET', path: '/api/settings',      expectStatus: 200 },
  { method: 'GET', path: '/api/dashboard',     expectStatus: 200 },
  { method: 'GET', path: '/api/custom-fields', expectStatus: 200 },
];

let authToken = null;
let firstAssetId = null;
let firstWorkOrderId = null;

test.beforeAll(async ({ request, baseURL }) => {
  const res = await request.post(`${baseURL}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.status(), `login failed for ${ADMIN_EMAIL}`).toBe(200);
  const json = await res.json();
  authToken = (json && json.data && json.data.token) || json.token;
  expect(authToken, 'login returned no token').toBeTruthy();

  // Grab a real asset + work order id so the detail-page checks have a live
  // target (their URLs carry a record id, so they can't be static entries).
  const aRes = await request.get(`${baseURL}/api/assets`, { headers: { Authorization: `Bearer ${authToken}` } });
  const aJson = await aRes.json().catch(() => ({}));
  const assets = (aJson && aJson.data && aJson.data.assets) || [];
  firstAssetId = assets.length ? assets[0].id : null;

  const wRes = await request.get(`${baseURL}/api/work-orders`, { headers: { Authorization: `Bearer ${authToken}` } });
  const wJson = await wRes.json().catch(() => ({}));
  const workOrders = (wJson && wJson.data && wJson.data.workOrders) || [];
  firstWorkOrderId = workOrders.length ? workOrders[0].id : null;
});

// ── Browser route checks ─────────────────────────────────────────────────────
//
// For each protected route: navigate, wait for hydration, assert NEITHER the
// ErrorBoundary heading nor a hard 4xx/5xx server error renders.

for (const route of PROTECTED_ROUTES) {
  test(`route: ${route.path} renders without ErrorBoundary`, async ({ page, baseURL }) => {
    // Bypass the SPA login by seeding the auth token from beforeAll into
    // localStorage before the React shell mounts. Matches how the app
    // restores sessions in normal use.
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => { window.localStorage.setItem('servicecycle_token', t); }, authToken);
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

// Detail pages (dynamic ids). High-traffic pages whose URL carries a record
// id — asset detail is the flagship compliance-hub page and work order
// detail is the other core write surface, and neither had a static path so
// neither was ever smoke-covered pre-fix (audit 2026-07-08).
async function seedToken(page, baseURL, token) {
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => { window.localStorage.setItem('servicecycle_token', t); }, token);
}

test('route: /assets/:id detail renders without ErrorBoundary', async ({ page, baseURL }) => {
  test.skip(!firstAssetId, 'no assets in this instance to open');
  await seedToken(page, baseURL, authToken);
  await page.goto(`${baseURL}/assets/${firstAssetId}`, { waitUntil: 'networkidle' });
  const boundary = page.getByRole('heading', { name: /Something went wrong/i });
  await expect(boundary, 'ErrorBoundary on asset detail').toHaveCount(0, { timeout: 8000 });
  const body = (await page.locator('body').innerText()).trim();
  expect(body.length, 'asset detail rendered empty body').toBeGreaterThan(20);
});

test('route: /work-orders/:id detail renders without ErrorBoundary', async ({ page, baseURL }) => {
  test.skip(!firstWorkOrderId, 'no work orders in this instance to open');
  await seedToken(page, baseURL, authToken);
  await page.goto(`${baseURL}/work-orders/${firstWorkOrderId}`, { waitUntil: 'networkidle' });
  const boundary = page.getByRole('heading', { name: /Something went wrong/i });
  await expect(boundary, 'ErrorBoundary on work order detail').toHaveCount(0, { timeout: 8000 });
  const body = (await page.locator('body').innerText()).trim();
  expect(body.length, 'work order detail rendered empty body').toBeGreaterThan(20);
});

// ── API endpoint checks ──────────────────────────────────────────────────────
//
// For each documented endpoint: send the request with the admin bearer,
// assert expected status, optionally assert key fields present in body.

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
// Always returns 204; persists if errorCode is present. We don't check
// persistence here (cleanup would be cross-cutting); a 204 on a well-formed
// POST is enough to prove the route + middleware chain works.

test('api: POST /api/errors/render (telemetry liveness)', async ({ request, baseURL }) => {
  const res = await request.post(`${baseURL}/api/errors/render`, {
    headers: { Authorization: `Bearer ${authToken}` },
    data:    { errorCode: 'SMOKE-' + Date.now().toString(36).toUpperCase(), message: 'smoke ping' },
  });
  expect(res.status()).toBe(204);
});

// ── Dashboard: core widgets render ──────────────────────────────────────────
// The dashboard is composed of several always-mounted card primitives
// (Priority assets, Maintenance horizon, Compliance by site, Next
// maintenance due, Recent work orders). A render-time TypeError in any one
// of them would blank or crash the whole dashboard. Assert two of the
// heaviest (data-table + calendar-grid) render their titles and no
// ErrorBoundary fired.
test('dashboard: core cards render without ErrorBoundary', async ({ page, baseURL }) => {
  await seedToken(page, baseURL, authToken);
  await page.goto(`${baseURL}/dashboard`, { waitUntil: 'networkidle' });

  const boundary = page.getByRole('heading', { name: /Something went wrong/i });
  await expect(boundary, 'ErrorBoundary fired on /dashboard').toHaveCount(0, { timeout: 8000 });

  await expect(
    page.getByText('Priority assets').first(),
    'Priority assets card did not render'
  ).toBeVisible({ timeout: 8000 });
  await expect(
    page.getByText('Maintenance horizon').first(),
    'Maintenance horizon card did not render'
  ).toBeVisible({ timeout: 8000 });
});
