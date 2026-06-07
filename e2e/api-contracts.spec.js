// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// e2e/api-contracts.spec.js  (Item 8 â€” API response-shape contract tests)
//
// Playwright request-context only (NO browser). Complements smoke.spec.js:
// smoke checks that pages render + endpoints return 200; THIS asserts the raw
// JSON response STRUCTURE matches the Zod schema the server validates against
// (server/schemas/registry.js). It is the local mirror of the production
// response-validator â€” if a refactor reshapes a contract the client depends
// on (the v0.89.x /api/preferences + v0.89.7 /api/news cascade class), this
// fails loudly before the change can ship.
//
// Runs against the live demo by default (E2E_BASE_URL, default
// https://demo.lapseiq.com). Local only â€” not part of any deploy image.
//
//   npx playwright test e2e/api-contracts.spec.js
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const { test, expect } = require('@playwright/test');
const reg = require('../server/schemas/registry');
const { configSchema } = require('../server/schemas/api');

const ADMIN_EMAIL    = process.env.E2E_ADMIN_EMAIL    || 'admin@demo.local';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'Admin1234!';

// Endpoints with a PRECISE response schema in the registry â€” these are the
// high-blast-radius reads the client renders on hot paths.
const REGISTRY_CASES = [
  'GET /api/auth/me',
  'GET /api/bootstrap',
  'GET /api/contracts',
  'GET /api/vendors',
  'GET /api/news/summary',
  'GET /api/alerts',
  'GET /api/alerts/preferences',
  'GET /api/dashboard',
  'GET /api/categories',
  'GET /api/custom-fields',
  'GET /api/preferences',
  'GET /api/budget/forecast',
];

let authToken = null;

test.beforeAll(async ({ request, baseURL }) => {
  const res = await request.post(`${baseURL}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.status(), `login failed for ${ADMIN_EMAIL}`).toBe(200);
  const json = await res.json();
  authToken = (json && json.data && json.data.token) || json.token;
  expect(authToken, 'login returned no token').toBeTruthy();
});

function issueSummary(parsed) {
  if (parsed.success) return '';
  return (parsed.error.issues || []).slice(0, 4)
    .map((i) => (i.path || []).join('.') + ': ' + i.message)
    .join(' | ');
}

for (const key of REGISTRY_CASES) {
  test(`contract: ${key}`, async ({ request, baseURL }) => {
    const [method, path] = key.split(' ');
    const res = await request[method.toLowerCase()](`${baseURL}${path}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status(), `${key} returned ${res.status()}`).toBe(200);

    const body = await res.json();
    const entry = reg.getEntry(key);
    const parsed = entry.response.safeParse(body);
    expect(parsed.success, `${key} response drift :: ${issueSummary(parsed)}`).toBe(true);
  });
}

// /api/config is validated inline in index.js (not a mounted router), so it is
// not in the registry â€” assert it against the same schema the server uses.
test('contract: GET /api/config', async ({ request, baseURL }) => {
  const res = await request.get(`${baseURL}/api/config`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  expect(res.status()).toBe(200);
  const parsed = configSchema.safeParse(await res.json());
  expect(parsed.success, `/api/config drift :: ${issueSummary(parsed)}`).toBe(true);
});

// Negative control: a precise request-body schema must reject a malformed body.
// POST /api/categories requires { name }. An empty body must 400 (the central
// request validator OR the handler guard â€” either way, not a 2xx/500).
test('contract: POST /api/categories rejects missing name (400)', async ({ request, baseURL }) => {
  const res = await request.post(`${baseURL}/api/categories`, {
    headers: { Authorization: `Bearer ${authToken}` },
    data: {},
  });
  expect(res.status(), `expected 400 for empty category body, got ${res.status()}`).toBe(400);
});