/**
 * Tests for the partner inbox routes:
 *   GET   /api/fleet/inbox
 *   PATCH /api/fleet/inbox/:id/seen
 *   PATCH /api/fleet/inbox/:id/actioned
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

let orgA: any, orgB: any;
let oemAdminA: TestUser, oemAdminB: TestUser;
let accountA: any, accountB: any;
let logA: any, logB: any;

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

  accountA = await createTestAccount(orgA.id);
  accountB = await createTestAccount(orgB.id);
  toDelete.push({ model: 'account', id: accountA.id });
  toDelete.push({ model: 'account', id: accountB.id });

  logA = await prisma.partnerEventLog.create({
    data: {
      partnerOrgId: orgA.id,
      accountId:    accountA.id,
      eventType:    'INSPECTION_COMPLETED',
      payload:      { assetName: 'Panel A' },
    },
  });
  logB = await prisma.partnerEventLog.create({
    data: {
      partnerOrgId: orgB.id,
      accountId:    accountB.id,
      eventType:    'TASK_OVERDUE',
      payload:      { assetName: 'Panel B' },
    },
  });
  toDelete.push({ model: 'partnerEventLog', id: logA.id });
  toDelete.push({ model: 'partnerEventLog', id: logB.id });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test('GET /api/fleet/inbox — oem_admin from Org A only sees Org A events', async () => {
  const res = await request(app)
    .get('/api/fleet/inbox')
    .set('Authorization', `Bearer ${oemAdminA.token}`);

  expect(res.status).toBe(200);
  const ids = res.body.events?.map((e: any) => e.id) ?? res.body.logs?.map((e: any) => e.id) ?? [];
  expect(ids).toContain(logA.id);
  expect(ids).not.toContain(logB.id);
});

test('GET /api/fleet/inbox — Org B cannot see Org A events (multi-tenant isolation)', async () => {
  const res = await request(app)
    .get('/api/fleet/inbox')
    .set('Authorization', `Bearer ${oemAdminB.token}`);

  expect(res.status).toBe(200);
  const ids = res.body.events?.map((e: any) => e.id) ?? res.body.logs?.map((e: any) => e.id) ?? [];
  expect(ids).not.toContain(logA.id);
});

test('GET /api/fleet/inbox?unseenOnly=true → only unseen records', async () => {
  // Mark logA as seen
  await prisma.partnerEventLog.update({
    where: { id: logA.id },
    data:  { seenAt: new Date() },
  });

  const res = await request(app)
    .get('/api/fleet/inbox?unseenOnly=true')
    .set('Authorization', `Bearer ${oemAdminA.token}`);

  expect(res.status).toBe(200);
  const ids = res.body.events?.map((e: any) => e.id) ?? res.body.logs?.map((e: any) => e.id) ?? [];
  expect(ids).not.toContain(logA.id);
});

test('PATCH /api/fleet/inbox/:id/seen → sets seenAt, idempotent', async () => {
  // Create a fresh unseen log
  const log = await prisma.partnerEventLog.create({
    data: {
      partnerOrgId: orgA.id,
      accountId:    accountA.id,
      eventType:    'TASK_OVERDUE',
      payload:      { overdueCount: 1 },
    },
  });
  toDelete.push({ model: 'partnerEventLog', id: log.id });

  const res = await request(app)
    .patch(`/api/fleet/inbox/${log.id}/seen`)
    .set('Authorization', `Bearer ${oemAdminA.token}`);
  expect(res.status).toBe(200);

  const updated = await prisma.partnerEventLog.findUnique({ where: { id: log.id } });
  expect(updated.seenAt).not.toBeNull();

  // Idempotent second call
  const res2 = await request(app)
    .patch(`/api/fleet/inbox/${log.id}/seen`)
    .set('Authorization', `Bearer ${oemAdminA.token}`);
  expect(res2.status).toBe(200);
});

test('PATCH /api/fleet/inbox/:id/actioned → sets actionedAt', async () => {
  const log = await prisma.partnerEventLog.create({
    data: {
      partnerOrgId: orgA.id,
      accountId:    accountA.id,
      eventType:    'QUOTE_REQUEST_CREATED',
      payload:      { assetName: 'Breaker' },
    },
  });
  toDelete.push({ model: 'partnerEventLog', id: log.id });

  const res = await request(app)
    .patch(`/api/fleet/inbox/${log.id}/actioned`)
    .set('Authorization', `Bearer ${oemAdminA.token}`);
  expect(res.status).toBe(200);

  const updated = await prisma.partnerEventLog.findUnique({ where: { id: log.id } });
  expect(updated.actionedAt).not.toBeNull();
});

test('Cannot mark seen/actioned on event from different partner org → 403 or 404', async () => {
  // logB belongs to orgB; oemAdminA belongs to orgA
  const res = await request(app)
    .patch(`/api/fleet/inbox/${logB.id}/seen`)
    .set('Authorization', `Bearer ${oemAdminA.token}`);
  expect([403, 404]).toContain(res.status);
});
