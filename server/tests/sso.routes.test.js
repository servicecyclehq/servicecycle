/**
 * Route-level auth-boundary + fail-closed + signature tests for the SSO routers.
 * Runs in the esbuild "unit" jest project with the no-op prisma mock (no DB),
 * so it asserts behaviors that don't depend on query result shapes:
 *   - feature disabled -> 404 (don't advertise)
 *   - SCIM signature verification (accept real HMAC, reject bad/missing)
 *   - generic fail-closed redirects (no enumeration oracle)
 *   - input validation
 * End-to-end DB behaviors (cross-tenant, SCIM idempotency/replay, callback
 * single-use state, role persistence) live in __tests__/routes/sso*.test.ts.
 */

// Env MUST be set before requiring the routers (ssoConfig reads process.env).
process.env.SSO_ENABLED = 'true';
process.env.POLIS_BASE_URL = 'http://localhost:5225';
process.env.POLIS_API_KEY = 'test-api-key';
process.env.SCIM_WEBHOOK_SECRET = 'fixture-webhook-secret';
process.env.SSO_CALLBACK_URL = 'http://app.test/api/sso/callback';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-minimum-32-chars-long-xx';
process.env.SCIM_WEBHOOK_TOLERANCE_MS = '0'; // disable freshness window for deterministic tests

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ssoRouter = require('../routes/sso');
const scimRouter = require('../routes/ssoScim');

function makeApp() {
  const app = express();
  app.use('/api/sso/scim',
    express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }),
    scimRouter);
  app.use(express.json());
  app.use('/api/sso', ssoRouter);
  return app;
}
const app = makeApp();

const deliveries = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../__tests__/fixtures/polis/webhook_deliveries.json'), 'utf8')
);
function signFresh(rawBody, secret = 'fixture-webhook-secret') {
  const t = Date.now();
  const s = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},s=${s}`;
}

describe('SSO public routes — input validation + generic fail-closed', () => {
  test('GET /authorize with invalid email -> generic redirect (no oracle)', async () => {
    const res = await request(app).get('/api/sso/authorize').query({ email: 'not-an-email' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login?sso_error=unavailable');
  });

  test('GET /authorize unknown domain -> same generic redirect (no enumeration)', async () => {
    const res = await request(app).get('/api/sso/authorize').query({ email: 'user@unknown-domain.test' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login?sso_error=unavailable');
  });

  test('GET /callback without state or code -> generic redirect', async () => {
    const res = await request(app).get('/api/sso/callback');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login?sso_error=unavailable');
  });

  test('POST /exchange without code -> 400', async () => {
    const res = await request(app).post('/api/sso/exchange').send({});
    expect(res.status).toBe(400);
  });
});

describe('SCIM webhook — signature is mandatory (fail closed)', () => {
  const body = deliveries[0].rawBody;

  test('missing signature -> 401', async () => {
    const res = await request(app).post('/api/sso/scim/webhook')
      .set('Content-Type', 'application/json').send(body);
    expect(res.status).toBe(401);
  });

  test('tampered signature -> 401', async () => {
    const res = await request(app).post('/api/sso/scim/webhook')
      .set('Content-Type', 'application/json')
      .set('BoxyHQ-Signature', 't=1,s=deadbeef')
      .send(body);
    expect(res.status).toBe(401);
  });

  test('valid signature over real event -> 200 (unknown directory skipped, no DB)', async () => {
    const res = await request(app).post('/api/sso/scim/webhook')
      .set('Content-Type', 'application/json')
      .set('BoxyHQ-Signature', signFresh(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.processed + res.body.skipped).toBeGreaterThanOrEqual(1);
  });

  test('Ory-Polis-Signature header is also accepted', async () => {
    const res = await request(app).post('/api/sso/scim/webhook')
      .set('Content-Type', 'application/json')
      .set('Ory-Polis-Signature', signFresh(body))
      .send(body);
    expect(res.status).toBe(200);
  });
});

describe('SSO feature disabled -> 404 (not advertised)', () => {
  // Re-require routers with SSO_ENABLED unset so getSsoConfig() throws SSO_DISABLED.
  let appOff;
  beforeAll(() => {
    jest.resetModules();
    const prev = process.env.SSO_ENABLED;
    process.env.SSO_ENABLED = '';
    const off = require('../routes/sso');
    const offScim = require('../routes/ssoScim');
    const a = express();
    a.use('/api/sso/scim', express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }), offScim);
    a.use(express.json());
    a.use('/api/sso', off);
    appOff = a;
    process.env.SSO_ENABLED = prev; // restore for any later suites
  });

  test('GET /authorize -> 404 when SSO disabled', async () => {
    process.env.SSO_ENABLED = '';
    const res = await request(appOff).get('/api/sso/authorize').query({ email: 'a@b.com' });
    expect(res.status).toBe(404);
    process.env.SSO_ENABLED = 'true';
  });

  test('POST /scim/webhook -> 404 when SSO disabled', async () => {
    process.env.SSO_ENABLED = '';
    const res = await request(appOff).post('/api/sso/scim/webhook')
      .set('Content-Type', 'application/json').send('{}');
    expect(res.status).toBe(404);
    process.env.SSO_ENABLED = 'true';
  });
});
