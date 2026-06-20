/**
 * Regression tests for the flagged items addressed after the deep audit:
 *   F1  — GET /api/admin/metrics/overview (platform-wide BI) is super_admin-only
 *   F5  — fleet list endpoints fail CLOSED when caller has no partnerOrgId
 *          (in non-demo / non-super_admin) instead of returning ALL accounts
 *   F6  — fleet account drill-down fails closed for a null-partnerOrgId caller
 * Test env sets DEMO_MODE='' so the production fail-closed path is exercised.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';
import { createTestPartnerOrg } from '../helpers/seed';

let app: any;
let prisma: any;
let superAdmin: TestUser;
let customerAdmin: TestUser;
let oemNoOrg: TestUser;
let oemWithOrg: TestUser;
let org: any;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  superAdmin = await createTestUser('super_admin');
  customerAdmin = await createTestUser('admin');
  oemNoOrg = await createTestUser('oem_admin'); // fresh account → no partnerOrgId
  org = await createTestPartnerOrg();
  oemWithOrg = await createTestUser('oem_admin', { partnerOrgId: org.id });
});

afterAll(async () => {
  for (const u of [superAdmin, customerAdmin, oemNoOrg, oemWithOrg]) {
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: u.accountId } }); } catch {}
  }
  try { await prisma.partnerOrganization.delete({ where: { id: org.id } }); } catch {}
  await prisma.$disconnect();
});

const auth = (u: TestUser) => `Bearer ${u.token}`;

describe('F1 — platform metrics is super_admin-only', () => {
  test('a customer admin is forbidden (403)', async () => {
    const res = await request(app).get('/api/admin/metrics/overview').set('Authorization', auth(customerAdmin));
    expect(res.status).toBe(403);
  });
  test('a super_admin can read it (200)', async () => {
    const res = await request(app).get('/api/admin/metrics/overview').set('Authorization', auth(superAdmin));
    expect(res.status).toBe(200);
  });
});

describe('F5 — fleet list endpoints fail closed for a null-partnerOrgId caller', () => {
  test.each([
    '/api/fleet/dashboard',
    '/api/fleet/path-to-100',
    '/api/fleet/portfolio-rank',
    '/api/fleet/forecast',
  ])('%s -> 403 for oem_admin with no partner org', async (url) => {
    const res = await request(app).get(url).set('Authorization', auth(oemNoOrg));
    expect(res.status).toBe(403);
  });

  test('an oem_admin WITH a partner org still gets 200 (dashboard)', async () => {
    const res = await request(app).get('/api/fleet/dashboard').set('Authorization', auth(oemWithOrg));
    expect(res.status).toBe(200);
  });
});

describe('F6 — fleet account drill-down fails closed for a null-partnerOrgId caller', () => {
  test('GET /api/fleet/accounts/:id -> 404 for oem_admin with no partner org', async () => {
    // target = the oem-with-org's account; a null-org caller must not reach it.
    const res = await request(app).get(`/api/fleet/accounts/${oemWithOrg.accountId}`).set('Authorization', auth(oemNoOrg));
    expect(res.status).toBe(404);
  });
});

export {};
