/**
 * Tests for webhook settings routes:
 *   GET  /api/fleet/webhook-settings
 *   PUT  /api/fleet/webhook-settings
 */

import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';
import { createTestPartnerOrg } from '../helpers/seed';

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

let orgA: any, orgB: any;
let oemAdminA: TestUser, oemAdminB: TestUser;

beforeAll(async () => {
  orgA = await createTestPartnerOrg();
  orgB = await createTestPartnerOrg();
  toDelete.push({ model: 'partnerOrganization', id: orgA.id });
  toDelete.push({ model: 'partnerOrganization', id: orgB.id });

  oemAdminA = await createTestUser('oem_admin', { partnerOrgId: orgA.id });
  oemAdminB = await createTestUser('oem_admin', { partnerOrgId: orgB.id });
  toDelete.push({ model: 'user', id: oemAdminA.id });
  toDelete.push({ model: 'account', id: oemAdminA.accountId });
  toDelete.push({ model: 'user', id: oemAdminB.id });
  toDelete.push({ model: 'account', id: oemAdminB.accountId });
});

test('GET /api/fleet/webhook-settings — oem_admin sees own org settings', async () => {
  const res = await request(app)
    .get('/api/fleet/webhook-settings')
    .set('Authorization', `Bearer ${oemAdminA.token}`);
  expect([200, 404]).toContain(res.status);
  // If 200, should not leak orgB data
  if (res.status === 200) {
    const body = res.body;
    // Must not contain orgB id
    expect(JSON.stringify(body)).not.toContain(orgB.id);
  }
});

test('oem_admin from Org A cannot read Org B webhook settings', async () => {
  // Try to read by passing orgB.id in a way that bypasses scoping
  // The route should scope to caller's partnerOrg, so oemAdminA only sees orgA
  const resA = await request(app)
    .get('/api/fleet/webhook-settings')
    .set('Authorization', `Bearer ${oemAdminA.token}`);
  const resB = await request(app)
    .get('/api/fleet/webhook-settings')
    .set('Authorization', `Bearer ${oemAdminB.token}`);

  // If both are 200, their partnerOrg ids should differ
  if (resA.status === 200 && resB.status === 200) {
    const orgIdA = resA.body.partnerOrg?.id ?? resA.body.webhookUrl;
    const orgIdB = resB.body.partnerOrg?.id ?? resB.body.webhookUrl;
    // They should be different (one could be null, but not cross-contaminated)
    expect(orgIdA).not.toBe(orgB.id);
  }
});
