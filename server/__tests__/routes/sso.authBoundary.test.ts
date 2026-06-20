/**
 * SSO auth-boundary: admin config routes require auth + admin; public entry
 * points validate input and fail closed. Integration (real DB) — runs in CI /
 * the deploy DB env.
 */
process.env.SSO_ENABLED = 'true';
process.env.POLIS_BASE_URL = 'http://localhost:5225';
process.env.POLIS_API_KEY = 'test-api-key';
process.env.SCIM_WEBHOOK_SECRET = 'fixture-webhook-secret';
process.env.SSO_CALLBACK_URL = 'http://app.test/api/sso/callback';
process.env.ACCOUNT_FEATURE_SSO = 'true';

import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
const toDelete: Array<{ model: string; id: string }> = [];

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
});
afterAll(async () => {
  for (const { model, id } of toDelete.reverse()) { try { await (prisma as any)[model].delete({ where: { id } }); } catch {} }
  await prisma.$disconnect();
});

describe('admin SSO routes require authentication + admin role', () => {
  let admin: TestUser, viewer: TestUser;
  beforeAll(async () => {
    admin = await createTestUser('admin');
    viewer = await createTestUser('viewer', { accountId: admin.accountId });
    toDelete.push({ model: 'user', id: viewer.id });
    toDelete.push({ model: 'user', id: admin.id });
    toDelete.push({ model: 'account', id: admin.accountId });
  });

  test.each([
    ['get', '/api/sso/admin/config'],
    ['post', '/api/sso/admin/connections'],
    ['post', '/api/sso/admin/domains'],
    ['post', '/api/sso/admin/directories'],
    ['post', '/api/sso/admin/role-mappings'],
    ['put', '/api/sso/admin/policy'],
  ])('%s %s -> 401 without a token', async (method, url) => {
    const res = await (request(app) as any)[method](url).send({});
    expect(res.status).toBe(401);
  });

  test('GET /api/sso/admin/config -> 403 for non-admin', async () => {
    const res = await request(app).get('/api/sso/admin/config').set('Authorization', `Bearer ${viewer.token}`);
    expect(res.status).toBe(403);
  });

  test('GET /api/sso/admin/config -> 200 for admin (sso feature on)', async () => {
    const res = await request(app).get('/api/sso/admin/config').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.polisTenant).toBe(`acct_${admin.accountId}`);
  });

  test('role mapping rejects a privileged role (no SSO admin escalation)', async () => {
    const res = await request(app).post('/api/sso/admin/role-mappings')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ idpGroup: 'Admins', role: 'admin' });
    expect(res.status).toBe(400);
  });
});

describe('public SSO entry points', () => {
  test('GET /authorize with invalid email -> generic redirect', async () => {
    const res = await request(app).get('/api/sso/authorize').query({ email: 'nope' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login?sso_error=unavailable');
  });
  test('POST /exchange without code -> 400', async () => {
    const res = await request(app).post('/api/sso/exchange').send({});
    expect(res.status).toBe(400);
  });
  test('POST /exchange with bad code -> 401', async () => {
    const res = await request(app).post('/api/sso/exchange').send({ code: 'does-not-exist' });
    expect(res.status).toBe(401);
  });
  test('POST /scim/webhook without signature -> 401', async () => {
    const res = await request(app).post('/api/sso/scim/webhook').set('Content-Type', 'application/json').send('{}');
    expect(res.status).toBe(401);
  });
});

export {};
