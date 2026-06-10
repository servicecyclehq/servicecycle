/**
 * Tests for rep assignment:
 *   PATCH /api/fleet/accounts/:accountId/assign-rep
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
let oemAdminA: TestUser;
let repA: TestUser, repB: TestUser;
let targetAccount: any;

beforeAll(async () => {
  orgA = await createTestPartnerOrg();
  orgB = await createTestPartnerOrg();
  toDelete.push({ model: 'partnerOrganization', id: orgA.id });
  toDelete.push({ model: 'partnerOrganization', id: orgB.id });

  oemAdminA = await createTestUser('oem_admin', { partnerOrgId: orgA.id });
  toDelete.push({ model: 'user', id: oemAdminA.id });
  toDelete.push({ model: 'account', id: oemAdminA.accountId });

  // repA belongs to orgA, repB belongs to orgB
  repA = await createTestUser('oem_admin', { partnerOrgId: orgA.id });
  repB = await createTestUser('oem_admin', { partnerOrgId: orgB.id });
  toDelete.push({ model: 'user', id: repA.id });
  toDelete.push({ model: 'account', id: repA.accountId });
  toDelete.push({ model: 'user', id: repB.id });
  toDelete.push({ model: 'account', id: repB.accountId });

  targetAccount = await createTestAccount(orgA.id);
  toDelete.push({ model: 'account', id: targetAccount.id });
});

test('PATCH assign-rep with oem_admin from correct org → 200', async () => {
  const res = await request(app)
    .patch(`/api/fleet/accounts/${targetAccount.id}/assign-rep`)
    .set('Authorization', `Bearer ${oemAdminA.token}`)
    .send({ repId: repA.id });
  expect(res.status).toBe(200);

  const updated = await prisma.account.findUnique({ where: { id: targetAccount.id } });
  expect(updated.assignedRepId).toBe(repA.id);
});

test('Assigning a rep who belongs to a different partner org → 400', async () => {
  const res = await request(app)
    .patch(`/api/fleet/accounts/${targetAccount.id}/assign-rep`)
    .set('Authorization', `Bearer ${oemAdminA.token}`)
    .send({ repId: repB.id }); // repB is in orgB
  expect(res.status).toBe(400);
});

test('Assigning null clears the assignment', async () => {
  // First set a rep
  await prisma.account.update({
    where: { id: targetAccount.id },
    data:  { assignedRepId: repA.id },
  });

  const res = await request(app)
    .patch(`/api/fleet/accounts/${targetAccount.id}/assign-rep`)
    .set('Authorization', `Bearer ${oemAdminA.token}`)
    .send({ repId: null });
  expect(res.status).toBe(200);

  const updated = await prisma.account.findUnique({ where: { id: targetAccount.id } });
  expect(updated.assignedRepId).toBeNull();
});

test('Fallback routing: no assignedRepId and no fallbackRepId → event created with assignedRepId=null', async () => {
  const org = await createTestPartnerOrg();
  toDelete.push({ model: 'partnerOrganization', id: org.id });
  const account = await createTestAccount(org.id); // no assignedRepId
  toDelete.push({ model: 'account', id: account.id });

  await prisma.accountSetting.upsert({
    where:  { accountId_key: { accountId: account.id, key: 'partner_share_inspections' } },
    update: { value: 'true' },
    create: { accountId: account.id, key: 'partner_share_inspections', value: 'true' },
  });

  const { emitPartnerEvent } = require('../../lib/partnerEvents');
  await emitPartnerEvent(account.id, 'INSPECTION_COMPLETED', { assetName: 'Bus' });

  const log = await prisma.partnerEventLog.findFirst({
    where: { accountId: account.id, eventType: 'INSPECTION_COMPLETED' },
  });
  expect(log).not.toBeNull();
  expect(log.assignedRepId).toBeNull();
  if (log) toDelete.push({ model: 'partnerEventLog', id: log.id });
});
