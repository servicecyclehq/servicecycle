/**
 * Regression tests — 2026-06-20 deep security audit (batch A: authz / audience /
 * secret / rate-limit fixes).
 *
 * Covers:
 *  - earlyAccess GET /list is admin-gated even on the PUBLIC mount (was an
 *    unauthenticated lead-PII dump)
 *  - proposals POST /request-contact blocks read-only roles (consultant/viewer)
 *  - disasterEvents POST /:id/resolve requires manager+
 *  - adminPartnerOrgs GET / + PATCH never serialize webhookSecret
 *  - /api/v1/* now carries an IP-keyed limiter ahead of API-key auth
 *  - admin GET /db-pool-health is super_admin-only
 *  - settings GET / suppresses the AI-key preview when it falls back to the env key
 *  - email feedbackHtml escapes user-controlled fields
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;

let admin: TestUser;
let viewer: TestUser;
let consultant: TestUser;
let manager: TestUser;
let superAdmin: TestUser;
let orgId: string;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;

  // One shared customer account with admin + manager + viewer + consultant.
  admin      = await createTestUser('admin');
  manager    = await createTestUser('manager',    { accountId: admin.accountId });
  viewer     = await createTestUser('viewer',     { accountId: admin.accountId });
  consultant = await createTestUser('consultant', { accountId: admin.accountId });
  superAdmin = await createTestUser('super_admin');

  const org = await prisma.partnerOrganization.create({
    data: { name: `AuditA Org ${Date.now()}`, webhookUrl: 'https://example.com/hook', webhookSecret: 'deadbeefdeadbeefdeadbeefdeadbeef' },
  });
  orgId = org.id;
});

afterAll(async () => {
  const accts = [admin.accountId, superAdmin.accountId];
  for (const u of [admin, manager, viewer, consultant, superAdmin]) {
    try { await prisma.disasterEvent.deleteMany({ where: { accountId: u.accountId } }); } catch {}
  }
  for (const u of [admin, manager, viewer, consultant, superAdmin]) {
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
  }
  for (const id of accts) { try { await prisma.account.delete({ where: { id } }); } catch {} }
  try { await prisma.partnerOrganization.delete({ where: { id: orgId } }); } catch {}
  await prisma.$disconnect();
});

describe('earlyAccess GET /list — admin-gated on the public mount (was unauth PII dump)', () => {
  test('no token → 401', async () => {
    const res = await request(app).get('/api/early-access/list');
    expect(res.status).toBe(401);
  });
  test('viewer token → 403', async () => {
    const res = await request(app).get('/api/early-access/list').set('Authorization', `Bearer ${viewer.token}`);
    expect(res.status).toBe(403);
  });
  test('admin token → 200', async () => {
    const res = await request(app).get('/api/early-access/list').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('proposals POST /request-contact — read-only roles blocked', () => {
  test('viewer → 403', async () => {
    const res = await request(app).post('/api/proposals/request-contact')
      .set('Authorization', `Bearer ${viewer.token}`).send({ mode: 'quote' });
    expect(res.status).toBe(403);
  });
  test('consultant → 403', async () => {
    const res = await request(app).post('/api/proposals/request-contact')
      .set('Authorization', `Bearer ${consultant.token}`).send({ mode: 'quote' });
    expect(res.status).toBe(403);
  });
  test('manager → 200', async () => {
    const res = await request(app).post('/api/proposals/request-contact')
      .set('Authorization', `Bearer ${manager.token}`).send({ mode: 'quote' });
    expect(res.status).toBe(200);
  });
});

describe('disasterEvents POST /:id/resolve — manager+ only', () => {
  let eventId: string;
  beforeAll(async () => {
    const ev = await prisma.disasterEvent.create({
      data: { accountId: admin.accountId, eventType: 'manual', severity: 'emergency', title: 'T', region: 'x', affectedStates: [], affectedSiteIds: [], source: 'manual' },
    });
    eventId = ev.id;
  });
  test('viewer → 403 (and event stays unresolved)', async () => {
    const res = await request(app).post(`/api/disaster-events/${eventId}/resolve`).set('Authorization', `Bearer ${viewer.token}`);
    expect(res.status).toBe(403);
    const ev = await prisma.disasterEvent.findUnique({ where: { id: eventId }, select: { resolvedAt: true } });
    expect(ev.resolvedAt).toBeNull();
  });
  test('consultant → 403', async () => {
    const res = await request(app).post(`/api/disaster-events/${eventId}/resolve`).set('Authorization', `Bearer ${consultant.token}`);
    expect(res.status).toBe(403);
  });
  test('manager → 200', async () => {
    const res = await request(app).post(`/api/disaster-events/${eventId}/resolve`).set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
  });
});

describe('adminPartnerOrgs — webhookSecret never serialized', () => {
  test('GET / omits webhookSecret', async () => {
    const res = await request(app).get('/api/admin/partner-orgs').set('Authorization', `Bearer ${superAdmin.token}`);
    expect(res.status).toBe(200);
    const mine = (res.body.orgs || []).find((o: any) => o.id === orgId);
    expect(mine).toBeTruthy();
    expect(mine.webhookSecret).toBeUndefined();
  });
  test('PATCH /:id omits webhookSecret', async () => {
    const res = await request(app).patch(`/api/admin/partner-orgs/${orgId}`)
      .set('Authorization', `Bearer ${superAdmin.token}`).send({ website: 'https://x.example' });
    expect(res.status).toBe(200);
    expect(res.body.org).toBeTruthy();
    expect(res.body.org.webhookSecret).toBeUndefined();
  });
  test('non-string name → 400 (not a 500 crash)', async () => {
    const res = await request(app).patch(`/api/admin/partner-orgs/${orgId}`)
      .set('Authorization', `Bearer ${superAdmin.token}`).send({ name: { evil: true } });
    expect(res.status).toBe(400);
  });
});

describe('/api/v1/* — IP limiter sits ahead of API-key auth', () => {
  test('no key still 401, and a RateLimit header is now present', async () => {
    const res = await request(app).get('/api/v1/assets');
    expect(res.status).toBe(401); // auth still enforced behind the limiter
    const hasHeader =
      res.headers['ratelimit-limit'] !== undefined ||
      res.headers['ratelimit'] !== undefined ||
      res.headers['x-ratelimit-limit'] !== undefined;
    expect(hasHeader).toBe(true);
    if (res.headers['ratelimit-limit'] !== undefined) {
      expect(res.headers['ratelimit-limit']).toBe('300');
    }
  });
});

describe('admin GET /db-pool-health — super_admin only', () => {
  test('customer admin → 403', async () => {
    const res = await request(app).get('/api/admin/db-pool-health').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(403);
  });
  test('super_admin → not 403', async () => {
    const res = await request(app).get('/api/admin/db-pool-health').set('Authorization', `Bearer ${superAdmin.token}`);
    expect(res.status).not.toBe(403);
  });
});

describe('settings GET / — AI-key preview suppressed for env-fallback key', () => {
  test('fresh account (no DB AI key) → _apiKeyPreview is null', async () => {
    const res = await request(app).get('/api/settings').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data._apiKeyPreview).toBeNull();
  });
});

describe('email feedbackHtml — user-controlled fields escaped', () => {
  test('pageUrl + userName markup is HTML-escaped', () => {
    // requireActual bypasses the global lib/email mock from helpers/setup.
    const { feedbackHtml } = jest.requireActual('../../lib/email');
    const html = feedbackHtml({
      userName: '<b>bob</b>',
      userEmail: 'b@x.com',
      userRole: 'admin',
      companyName: 'ACME',
      category: 'bug',
      message: 'hi',
      pageUrl: '<a href="https://evil.example/phish">click</a>',
      submittedAt: '2026-06-20',
    });
    expect(html).not.toContain('<a href="https://evil.example/phish">');
    expect(html).not.toContain('<b>bob</b>');
    expect(html).toContain('&lt;a href');
    expect(html).toContain('&lt;b&gt;bob');
  });
});

export {};
