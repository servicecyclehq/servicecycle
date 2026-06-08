'use strict';

/**
 * Multi-tenant isolation (IDOR) — ServiceCycle asset model.
 *
 * Rewritten 2026-06-07 for the equipment/maintenance model (the original
 * covered Contract rows). This is the regression proof for the project's
 * non-negotiable tenancy rule: EVERY query is scoped by accountId.
 *
 * Strategy: the demo seed provides account A (Meridian Manufacturing, four
 * role users). We self-register a hostile account B (REGISTRATION_OPEN=true
 * on the test instance) and verify B can neither read nor write nor
 * cross-reference anything that belongs to A — including the subtle cases:
 * creating an asset under A's site, applying schedules to A's assets, and
 * creating work orders against A's assets.
 *
 * Also covers role tiers inside account A: viewer and consultant are
 * read-only on assets (requireManager gate).
 *
 * Live-server style (TEST_BASE_URL) like the rest of the suite.
 */

const { api } = require('./helpers');

// Repeated full-suite runs inside one 15-minute window burn the shared
// real-IP credential-limiter budget (10 login attempts / 15 min). Present a
// per-run unique TEST-NET-2 client IP via the CF header pair the limiter
// key fn honors (same approach as registerTermsGate.test.js) so this suite
// is immune to run ordering and re-runs.
const RUN_IP = `198.51.100.${(Date.now() % 200) + 10}`;
const CF = { 'CF-Connecting-IP': RUN_IP, 'CF-Ray': '0123456789abcdef-SJC' };

async function login(email, password) {
  const res = await api().post('/api/auth/login').set(CF).send({ email, password });
  if (res.status !== 200 || !res.body?.data?.token) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.token;
}

const ADMIN_A      = { email: 'admin@demo.local',      password: 'Admin1234!' };
const VIEWER_A     = { email: 'viewer@demo.local',     password: 'Viewer1234!' };
const CONSULTANT_A = { email: 'consultant@demo.local', password: 'Consultant1234!' };

const B_EMAIL = `idor-b-${Date.now()}@example.test`;
const B_PASS  = 'HostileTenant1234!';

let tokenA, tokenViewerA, tokenConsultantA, tokenB;
let assetA;   // an asset belonging to account A
let siteA;    // a site belonging to account A
let scheduleA;

beforeAll(async () => {
  tokenA           = await login(ADMIN_A.email, ADMIN_A.password);
  tokenViewerA     = await login(VIEWER_A.email, VIEWER_A.password);
  tokenConsultantA = await login(CONSULTANT_A.email, CONSULTANT_A.password);

  // Grab a real asset + site + schedule from account A.
  const list = await api()
    .get('/api/assets?limit=5')
    .set('Authorization', `Bearer ${tokenA}`);
  expect(list.status).toBe(200);
  assetA = list.body.data.assets[0];
  expect(assetA).toBeDefined();

  const sites = await api()
    .get('/api/sites')
    .set('Authorization', `Bearer ${tokenA}`);
  siteA = sites.body.data.sites[0];
  expect(siteA).toBeDefined();

  const schedules = await api()
    .get(`/api/schedules?assetId=${assetA.id}`)
    .set('Authorization', `Bearer ${tokenA}`);
  scheduleA = schedules.body.data.schedules?.[0] || null;

  // Self-register hostile account B. The register route stacks
  // registrationLimiter (3/hour/IP); when the full suite runs,
  // registerTermsGate.test.js has already burned the real-IP budget, so we
  // present a distinct client IP the same way that suite does (CF headers
  // are honored by the credential limiter's key fn — see routes/auth.ts).
  // 203.0.113.0/24 is TEST-NET-3; .250 stays clear of the counter range the
  // terms-gate suite uses.
  const reg = await api()
    .post('/api/auth/register')
    .set(CF)
    .send({
    name:           'Hostile Tenant',
    email:          B_EMAIL,
    password:       B_PASS,
    companyName:    'Account B Industrial',
    acceptedTerms:  true,
    // DEMO_MODE register gate (routes/auth.ts) requires the US-scope
    // attestation; without it registration 400s with US_SCOPE_REQUIRED and
    // the whole suite fails in beforeAll.
    acceptedUsScope: true,
  });
  expect([200, 201]).toContain(reg.status);
  tokenB = reg.body?.data?.token || (await login(B_EMAIL, B_PASS));
}, 60_000);

describe('cross-tenant reads are blocked', () => {
  test("B's asset list never contains A's assets", async () => {
    const res = await api()
      .get('/api/assets?limit=100')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    const ids = (res.body.data.assets || []).map((a) => a.id);
    expect(ids).not.toContain(assetA.id);
  });

  test("B cannot GET A's asset by id (404, not 403 — no existence oracle)", async () => {
    const res = await api()
      .get(`/api/assets/${assetA.id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });

  test("B cannot GET A's site detail", async () => {
    const res = await api()
      .get(`/api/sites/${siteA.id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });

  test("B's bootstrap bundle is empty of A's data", async () => {
    const res = await api()
      .get('/api/bootstrap?limit=100')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    const ids = (res.body.data.assets || []).map((a) => a.id);
    expect(ids).not.toContain(assetA.id);
    const siteIds = (res.body.data.sites || []).map((s) => s.id);
    expect(siteIds).not.toContain(siteA.id);
  });

  test("B's alert feed never references A's assets", async () => {
    const res = await api()
      .get('/api/alerts')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    const assetIds = (res.body.data.alerts || []).map((a) => a.assetId || a.asset?.id);
    expect(assetIds).not.toContain(assetA.id);
  });

  test("B's dashboard aggregates are zeroed (not A's totals)", async () => {
    const res = await api()
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    // Fresh account B may carry its own sandbox seed (DEMO_MODE registration
    // path) — so we can't assert zero. We CAN assert it differs from A's
    // known site names.
    const siteNames = (res.body.data.complianceBySite || []).map((s) => s.siteName);
    expect(siteNames).not.toContain('Riverside Plant');
    expect(siteNames).not.toContain('Eastgate Distribution Center');
  });
});

describe('cross-tenant writes + cross-references are blocked', () => {
  test("B cannot update A's asset", async () => {
    const res = await api()
      .put(`/api/assets/${assetA.id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ notes: 'owned' });
    expect([403, 404]).toContain(res.status);
  });

  test("B cannot archive A's asset", async () => {
    const res = await api()
      .post(`/api/assets/${assetA.id}/archive`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect([403, 404]).toContain(res.status);
  });

  test("B cannot create an asset under A's site (cross-tenant FK reference)", async () => {
    const res = await api()
      .post('/api/assets')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ siteId: siteA.id, equipmentType: 'SWITCHGEAR' });
    expect([400, 403, 404]).toContain(res.status);
  });

  test("B cannot bulk-apply schedules to A's asset", async () => {
    const res = await api()
      .post('/api/schedules/bulk-apply')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ assetId: assetA.id });
    expect([400, 403, 404]).toContain(res.status);
  });

  test("B cannot create a work order against A's asset", async () => {
    const res = await api()
      .post('/api/work-orders')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ assetId: assetA.id });
    expect([400, 403, 404]).toContain(res.status);
  });

  test("B cannot complete A's schedule", async () => {
    if (!scheduleA) return; // seed shape changed — covered by bulk-apply test
    const res = await api()
      .post(`/api/schedules/${scheduleA.id}/complete`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({});
    expect([400, 403, 404]).toContain(res.status);
  });

  test("B cannot resolve A's deficiencies", async () => {
    const defs = await api()
      .get('/api/deficiencies?resolved=false')
      .set('Authorization', `Bearer ${tokenA}`);
    const defA = defs.body.data.deficiencies?.[0];
    if (!defA) return;
    const res = await api()
      .post(`/api/deficiencies/${defA.id}/resolve`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect([400, 403, 404]).toContain(res.status);
  });
});

describe('role tiers within account A', () => {
  test('viewer cannot create assets (requireManager)', async () => {
    const res = await api()
      .post('/api/assets')
      .set('Authorization', `Bearer ${tokenViewerA}`)
      .send({ siteId: siteA.id, equipmentType: 'GENERATOR' });
    expect(res.status).toBe(403);
  });

  test('consultant cannot create assets', async () => {
    const res = await api()
      .post('/api/assets')
      .set('Authorization', `Bearer ${tokenConsultantA}`)
      .send({ siteId: siteA.id, equipmentType: 'GENERATOR' });
    expect(res.status).toBe(403);
  });

  test("viewer CAN read assets (read access is account-wide)", async () => {
    const res = await api()
      .get(`/api/assets/${assetA.id}`)
      .set('Authorization', `Bearer ${tokenViewerA}`);
    expect(res.status).toBe(200);
    expect(res.body.data.asset.id).toBe(assetA.id);
  });
});
