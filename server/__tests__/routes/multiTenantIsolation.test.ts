/**
 * Multi-tenant isolation tests.
 * Verifies that oem_admin from Org A cannot access Org B data.
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

let orgA: any, orgB: any;
let oemAdminA: TestUser, oemAdminB: TestUser;
let repA: TestUser, repB: TestUser;
let accountInOrgB: any;

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

  // repA in orgA, repB in orgB
  repA = await createTestUser('oem_admin', { partnerOrgId: orgA.id });
  repB = await createTestUser('oem_admin', { partnerOrgId: orgB.id });
  toDelete.push({ model: 'user', id: repA.id });
  toDelete.push({ model: 'account', id: repA.accountId });
  toDelete.push({ model: 'user', id: repB.id });
  toDelete.push({ model: 'account', id: repB.accountId });

  accountInOrgB = await createTestAccount(orgB.id);
  toDelete.push({ model: 'account', id: accountInOrgB.id });
});

test('oem_admin from Org A cannot GET account detail that belongs to Org B', async () => {
  const res = await request(app)
    .get(`/api/fleet/accounts/${accountInOrgB.id}`)
    .set('Authorization', `Bearer ${oemAdminA.token}`);
  expect([403, 404]).toContain(res.status);
});

test('oem_admin from Org A cannot assign rep from Org B to an account', async () => {
  const accountInOrgA = await createTestAccount(orgA.id);
  toDelete.push({ model: 'account', id: accountInOrgA.id });

  const res = await request(app)
    .patch(`/api/fleet/accounts/${accountInOrgA.id}/assign-rep`)
    .set('Authorization', `Bearer ${oemAdminA.token}`)
    .send({ repId: repB.id }); // repB is in orgB

  expect(res.status).toBe(400);
});

test('oem_admin from Org A cannot read Org B webhook settings', async () => {
  // Both admins read their own webhook settings — responses should not contain the other org's data
  const resA = await request(app)
    .get('/api/fleet/webhook-settings')
    .set('Authorization', `Bearer ${oemAdminA.token}`);

  // Even if 200, must not expose orgB's id or data
  if (resA.status === 200) {
    expect(JSON.stringify(resA.body)).not.toContain(orgB.id);
  } else {
    expect([200, 404]).toContain(resA.status);
  }
});

test('oem_admin from Org A inbox only shows Org A events', async () => {
  // Create one event in each org
  const logA = await prisma.partnerEventLog.create({
    data: {
      partnerOrgId: orgA.id,
      accountId:    oemAdminA.accountId,
      eventType:    'TASK_OVERDUE',
      payload:      { tag: 'orgA-isolation-test' },
    },
  });
  const logB = await prisma.partnerEventLog.create({
    data: {
      partnerOrgId: orgB.id,
      accountId:    accountInOrgB.id,
      eventType:    'TASK_OVERDUE',
      payload:      { tag: 'orgB-isolation-test' },
    },
  });
  toDelete.push({ model: 'partnerEventLog', id: logA.id });
  toDelete.push({ model: 'partnerEventLog', id: logB.id });

  const res = await request(app)
    .get('/api/fleet/inbox')
    .set('Authorization', `Bearer ${oemAdminA.token}`);

  expect(res.status).toBe(200);
  const ids = res.body.events?.map((e: any) => e.id) ?? res.body.logs?.map((e: any) => e.id) ?? [];
  expect(ids).not.toContain(logB.id);
});
