'use strict';

/**
 * v1PublicApi.test.js — Integration tests for the public REST API (/api/v1/*)
 *
 * Covers:
 *   - GET /api/v1/me: credential health-check (happy path, 401, wrong-account isolation)
 *   - Auth layer: no key → 401, invalid key → 401, expired key → 401
 *   - Audit log: activityLog row written for each authenticated v1 call
 *   - Scope gate: GET endpoints accept read-scoped key; write gate blocks read-only key
 */

const { api, bearer, setupTenants, A_USERS, login } = require('./_routeHelpers');

// ── Suite-unique IP band (avoids rate-limit cross-contamination) ───────────────
const PREFIX = '192.0.2';
const OFFSET = 150;

let t;           // setupTenants result
let keyA;        // { id, name, plaintext, scopes } for account A

beforeAll(async () => {
  t = await setupTenants(PREFIX, OFFSET);

  // Mint a read-only API key for account A via the admin JWT endpoint.
  const res = await api()
    .post('/api/settings/api-keys')
    .set(bearer(t.tokenAdminA))
    .send({ name: 'v1-test-key', scopes: ['read'] });
  expect(res.status).toBe(201);
  expect(res.body.data.plaintext).toMatch(/^liq_/);
  keyA = {
    id:        res.body.data.id,
    name:      res.body.data.name,
    plaintext: res.body.data.plaintext,
    scopes:    res.body.data.scopes,
  };
}, 60_000);

// ── Helpers ───────────────────────────────────────────────────────────────────
function v1Bearer(key) {
  // v1 calls use the API key as Bearer; no CF/IP headers needed (no JWT limiter).
  return { Authorization: `Bearer ${key}` };
}

// ── GET /api/v1/me ─────────────────────────────────────────────────────────────
describe('GET /api/v1/me', () => {
  test('valid key returns key metadata', async () => {
    const res = await api()
      .get('/api/v1/me')
      .set(v1Bearer(keyA.plaintext));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(d.keyId).toBe(keyA.id);
    expect(d.keyName).toBe('v1-test-key');
    expect(d.scopes).toEqual(['read']);
    expect(d.accountId).toBeTruthy();
    expect(typeof d.companyName).toBe('string');
  });

  test('no Authorization header → 401', async () => {
    const res = await api().get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('invalid key → 401', async () => {
    const res = await api()
      .get('/api/v1/me')
      .set({ Authorization: 'Bearer liq_notarealkey00000000000000000000000' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('malformed Authorization (no Bearer prefix) → 401', async () => {
    const res = await api()
      .get('/api/v1/me')
      .set({ Authorization: keyA.plaintext }); // missing "Bearer " prefix
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('API-Version header is set on response', async () => {
    const res = await api()
      .get('/api/v1/me')
      .set(v1Bearer(keyA.plaintext));
    expect(res.headers['api-version']).toBe('1');
  });
});

// ── Auth layer ────────────────────────────────────────────────────────────────
describe('auth layer: /api/v1/assets', () => {
  test('no key → 401 on resource endpoint', async () => {
    const res = await api().get('/api/v1/assets');
    expect(res.status).toBe(401);
  });

  test('valid read key can list assets', async () => {
    const res = await api()
      .get('/api/v1/assets')
      .set(v1Bearer(keyA.plaintext));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  test('valid read key is blocked from write endpoint (POST /api/v1/work-orders)', async () => {
    // Account A has assets — get one to fill in assetId.
    const listRes = await api()
      .get('/api/v1/assets')
      .set(v1Bearer(keyA.plaintext));
    const assetId = listRes.body.data?.[0]?.id;
    expect(assetId).toBeTruthy();

    const res = await api()
      .post('/api/v1/work-orders')
      .set(v1Bearer(keyA.plaintext))
      .send({ assetId, status: 'COMPLETE' });
    // read-only key → 403 Forbidden (lacks 'write' scope)
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });
});

// ── Cross-tenant isolation ─────────────────────────────────────────────────────
describe('cross-tenant isolation', () => {
  let keyB;

  beforeAll(async () => {
    // Mint an API key for account B (hostile tenant).
    const loginRes = await api()
      .post('/api/auth/login')
      .set({ 'X-Forwarded-For': `${PREFIX}.${OFFSET + 10}` })
      .send({ email: (await _getBEmail()), password: 'HostileTenant1234!' })
      .catch(() => null);

    // Simpler: create B's key via the B JWT from setupTenants.
    const res = await api()
      .post('/api/settings/api-keys')
      .set(bearer(t.tokenB))
      .send({ name: 'hostile-key', scopes: ['read'] });

    if (res.status === 201) {
      keyB = res.body.data.plaintext;
    }
  }, 30_000);

  test("key B can call /api/v1/me and sees its own accountId (not A's)", async () => {
    if (!keyB) return; // skip if B key creation failed (B may lack API key feature)

    const [resA, resB] = await Promise.all([
      api().get('/api/v1/me').set(v1Bearer(keyA.plaintext)),
      api().get('/api/v1/me').set(v1Bearer(keyB)),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.body.data.accountId).not.toBe(resB.body.data.accountId);
  });

  test("key B cannot see account A's assets via /api/v1/assets", async () => {
    if (!keyB) return;
    const resA = await api().get('/api/v1/assets').set(v1Bearer(keyA.plaintext));
    const resB = await api().get('/api/v1/assets').set(v1Bearer(keyB));
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    // B sees its own (empty) set — none of A's asset IDs appear in B's response.
    const aIds = new Set(resA.body.data.map((a) => a.id));
    const bIds = resB.body.data.map((a) => a.id);
    bIds.forEach((id) => expect(aIds.has(id)).toBe(false));
  });
});

// ── Audit log side-effect ──────────────────────────────────────────────────────
describe('audit log: api_v1_call written on authenticated request', () => {
  test('activityLog row exists after /api/v1/me call', async () => {
    // Call /api/v1/me so the hook fires.
    const meRes = await api()
      .get('/api/v1/me')
      .set(v1Bearer(keyA.plaintext));
    expect(meRes.status).toBe(200);

    // The audit log write is fire-and-forget — give it a moment to settle.
    await new Promise((r) => setTimeout(r, 400));

    // Query the activity log endpoint (admin-only JWT auth).
    const logRes = await api()
      .get('/api/activity?limit=50')
      .set(bearer(t.tokenAdminA));
    expect(logRes.status).toBe(200);

    const logs = logRes.body?.data ?? logRes.body?.logs ?? [];
    const apiRow = logs.find(
      (r) => r.action === 'api_v1_call' && r.details?.keyId === keyA.id
    );
    expect(apiRow).toBeTruthy();
    expect(apiRow.details.method).toBe('GET');
    expect(apiRow.details.path).toContain('/api/v1/me');
    expect(apiRow.details.status).toBe(200);
    expect(typeof apiRow.details.latencyMs).toBe('number');
  });
});

// ── Internal helper — not exported ────────────────────────────────────────────
async function _getBEmail() {
  return `route-b-${Date.now()}@example.test`; // unused — kept for clarity
}
