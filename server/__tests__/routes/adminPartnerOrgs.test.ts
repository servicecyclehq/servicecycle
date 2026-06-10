/**
 * Tests for /api/admin/partner-orgs (super_admin only).
 */

import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';
import { createTestPartnerOrg, createTestAccount } from '../helpers/seed';

let app: any;
let prisma: any;
const toDelete: Array<{ model: string; id: string }> = [];

beforeAll(async () => {
  app    = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
});

afterAll(async () => {
  for (const { model, id } of toDelete.reverse()) {
    try { await (prisma as any)[model].delete({ where: { id } }); } catch {}
  }
  await prisma.$disconnect();
});

let superAdmin: TestUser;
let regularAdmin: TestUser;

beforeAll(async () => {
  superAdmin   = await createTestUser('super_admin');
  regularAdmin = await createTestUser('admin');
  toDelete.push({ model: 'user', id: superAdmin.id });
  toDelete.push({ model: 'account', id: superAdmin.accountId });
  toDelete.push({ model: 'user', id: regularAdmin.id });
  toDelete.push({ model: 'account', id: regularAdmin.accountId });
});

// ── POST /api/admin/partner-orgs ──────────────────────────────────────────────

describe('POST /api/admin/partner-orgs', () => {
  test('super_admin creates org → 201', async () => {
    const res = await request(app)
      .post('/api/admin/partner-orgs')
      .set('Authorization', `Bearer ${superAdmin.token}`)
      .send({ name: `Test Org ${Date.now()}`, website: 'https://example.com' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('org');
    expect(res.body.org).toHaveProperty('id');
    expect(res.body.org.website).toBe('https://example.com');

    toDelete.push({ model: 'partnerOrganization', id: res.body.org.id });
  });

  test('regular admin → 403', async () => {
    const res = await request(app)
      .post('/api/admin/partner-orgs')
      .set('Authorization', `Bearer ${regularAdmin.token}`)
      .send({ name: 'Should Fail' });
    expect(res.status).toBe(403);
  });

  test('missing name → 400', async () => {
    const res = await request(app)
      .post('/api/admin/partner-orgs')
      .set('Authorization', `Bearer ${superAdmin.token}`)
      .send({ website: 'https://example.com' });
    expect(res.status).toBe(400);
  });
});

// ── GET /api/admin/partner-orgs ───────────────────────────────────────────────

describe('GET /api/admin/partner-orgs', () => {
  test('super_admin gets list → 200 with orgs array', async () => {
    const res = await request(app)
      .get('/api/admin/partner-orgs')
      .set('Authorization', `Bearer ${superAdmin.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.orgs)).toBe(true);
  });
});

// ── POST /api/admin/partner-orgs/:id/link-account ────────────────────────────

describe('POST /api/admin/partner-orgs/:id/link-account', () => {
  test('links account correctly', async () => {
    const org = await createTestPartnerOrg();
    toDelete.push({ model: 'partnerOrganization', id: org.id });

    const account = await createTestAccount(); // no partnerOrgId
    toDelete.push({ model: 'account', id: account.id });

    const res = await request(app)
      .post(`/api/admin/partner-orgs/${org.id}/link-account`)
      .set('Authorization', `Bearer ${superAdmin.token}`)
      .send({ accountId: account.id });

    expect(res.status).toBe(200);
    expect(res.body.account.partnerOrgId).toBe(org.id);
  });

  test('non-existent account → 404', async () => {
    const org = await createTestPartnerOrg();
    toDelete.push({ model: 'partnerOrganization', id: org.id });

    const res = await request(app)
      .post(`/api/admin/partner-orgs/${org.id}/link-account`)
      .set('Authorization', `Bearer ${superAdmin.token}`)
      .send({ accountId: '00000000-0000-0000-0000-000000000000' });

    expect(res.status).toBe(404);
  });
});

// ── POST /api/admin/partner-orgs/:id/create-oem-user ─────────────────────────

describe('POST /api/admin/partner-orgs/:id/create-oem-user', () => {
  test('creates user with oem_admin role', async () => {
    const org = await createTestPartnerOrg();
    toDelete.push({ model: 'partnerOrganization', id: org.id });

    const email = `oem-${Date.now()}@test.invalid`;
    const res = await request(app)
      .post(`/api/admin/partner-orgs/${org.id}/create-oem-user`)
      .set('Authorization', `Bearer ${superAdmin.token}`)
      .send({ email, name: 'Test OEM User', password: 'SecurePassword123!' });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('oem_admin');
    expect(res.body.user.email).toBe(email);

    // Clean up created account + user
    toDelete.push({ model: 'user', id: res.body.user.id });
    toDelete.push({ model: 'account', id: res.body.user.accountId });
  });

  test('duplicate email → 409', async () => {
    const org = await createTestPartnerOrg();
    toDelete.push({ model: 'partnerOrganization', id: org.id });

    const email = superAdmin.email; // already exists

    const res = await request(app)
      .post(`/api/admin/partner-orgs/${org.id}/create-oem-user`)
      .set('Authorization', `Bearer ${superAdmin.token}`)
      .send({ email, name: 'Dupe', password: 'SecurePassword123!' });

    expect(res.status).toBe(409);
  });

  test('missing fields → 400', async () => {
    const org = await createTestPartnerOrg();
    toDelete.push({ model: 'partnerOrganization', id: org.id });

    const res = await request(app)
      .post(`/api/admin/partner-orgs/${org.id}/create-oem-user`)
      .set('Authorization', `Bearer ${superAdmin.token}`)
      .send({ name: 'No Email or Password' });

    expect(res.status).toBe(400);
  });
});

// ── PATCH /api/admin/partner-orgs/:id ────────────────────────────────────────

describe('PATCH /api/admin/partner-orgs/:id', () => {
  test('updates name and website', async () => {
    const org = await createTestPartnerOrg();
    toDelete.push({ model: 'partnerOrganization', id: org.id });

    const res = await request(app)
      .patch(`/api/admin/partner-orgs/${org.id}`)
      .set('Authorization', `Bearer ${superAdmin.token}`)
      .send({ name: 'Updated Name', website: 'https://updated.example.com' });

    expect(res.status).toBe(200);
    expect(res.body.org.name).toBe('Updated Name');
  });
});
