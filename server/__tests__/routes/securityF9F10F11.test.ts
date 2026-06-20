/**
 * F9 — WO COMPLETE is idempotent under a concurrent double-submit (exactly one
 *      success; the loser 409/400; schedule rolled once).
 * F10 — soft-deleted ([DELETED]) partner orgs are hidden from the list and
 *      cannot be link-account'd / create-oem-user'd.
 * F11 — bulk asset import computes priorityScore (DPS) from condition +
 *      criticality scores.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let manager: TestUser;
let superAdmin: TestUser;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  superAdmin = await createTestUser('super_admin');
});

afterAll(async () => {
  const acc = manager.accountId;
  try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.partnerOrganization.deleteMany({ where: { name: { startsWith: '[DELETED] ZZTest' } } }); } catch {}
  for (const u of [manager, superAdmin]) {
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: u.accountId } }); } catch {}
  }
  await prisma.$disconnect();
});

const auth = (u: TestUser) => `Bearer ${u.token}`;

describe('F9 WO complete idempotency', () => {
  test('two concurrent completes -> exactly one succeeds, schedule rolled once', async () => {
    const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `F9 ${Date.now()}` } });
    const asset = await prisma.asset.create({ data: { accountId: manager.accountId, siteId: site.id, equipmentType: 'MOTOR', serialNumber: `F9-${Date.now()}` } });
    const td = await prisma.maintenanceTaskDefinition.create({ data: { accountId: manager.accountId, equipmentType: 'MOTOR', taskName: 'IR', taskCode: `F9_${Date.now()}`, intervalC2Months: 12 } });
    const sched = await prisma.maintenanceSchedule.create({ data: { accountId: manager.accountId, assetId: asset.id, taskDefinitionId: td.id, isActive: true, nextDueDate: new Date(Date.now() - 86400000) } });
    const wo = await prisma.workOrder.create({ data: { accountId: manager.accountId, assetId: asset.id, scheduleId: sched.id, status: 'SCHEDULED', scheduledDate: new Date() } });

    const fire = () => request(app).put(`/api/work-orders/${wo.id}`).set('Authorization', auth(manager)).send({ status: 'COMPLETE' });
    const [a, b] = await Promise.all([fire(), fire()]);
    const codes = [a.status, b.status].sort();
    const successes = codes.filter((c) => c === 200).length;
    expect(successes).toBe(1);
    // The loser is rejected (already-finalized 409, or stale-read transition 400).
    expect(codes.some((c) => c === 409 || c === 400)).toBe(true);

    const finalWo = await prisma.workOrder.findUnique({ where: { id: wo.id }, select: { status: true } });
    expect(finalWo.status).toBe('COMPLETE');
    const rolled = await prisma.maintenanceSchedule.findUnique({ where: { id: sched.id }, select: { nextDueDate: true, lastCompletedDate: true } });
    expect(rolled.lastCompletedDate).not.toBeNull();
    expect(new Date(rolled.nextDueDate).getTime()).toBeGreaterThan(Date.now()); // rolled forward
  });
});

describe('F10 soft-deleted partner orgs hidden', () => {
  let deletedOrgId: string;
  beforeAll(async () => {
    const org = await prisma.partnerOrganization.create({ data: { name: `[DELETED] ZZTest ${Date.now()}` } });
    deletedOrgId = org.id;
  });

  test('not returned by the list', async () => {
    const res = await request(app).get('/api/admin/partner-orgs').set('Authorization', auth(superAdmin));
    expect(res.status).toBe(200);
    expect(res.body.orgs.find((o: any) => o.id === deletedOrgId)).toBeFalsy();
  });
  test('cannot link-account to a deleted org (409)', async () => {
    const res = await request(app).post(`/api/admin/partner-orgs/${deletedOrgId}/link-account`)
      .set('Authorization', auth(superAdmin)).send({ accountId: manager.accountId });
    expect(res.status).toBe(409);
  });
  test('cannot create-oem-user on a deleted org (409)', async () => {
    const res = await request(app).post(`/api/admin/partner-orgs/${deletedOrgId}/create-oem-user`)
      .set('Authorization', auth(superAdmin)).send({ email: `x-${Date.now()}@test.invalid`, name: 'X', password: 'Abcd1234!x' });
    expect(res.status).toBe(409);
  });
});

describe('F11 import computes DPS', () => {
  test('priorityScore = conditionScore × criticalityScore on commit', async () => {
    const siteName = `ImpSite ${Date.now()}`;
    await prisma.site.create({ data: { accountId: manager.accountId, name: siteName } });
    const serial = `IMP-${Date.now()}`;
    const csv = `Site,Equipment Type,Serial Number,Condition Score,Criticality Score\n${siteName},MOTOR,${serial},4,5\n`;
    const columnMap = JSON.stringify({
      'Site': 'siteName',
      'Equipment Type': 'equipmentType',
      'Serial Number': 'serialNumber',
      'Condition Score': 'conditionScore',
      'Criticality Score': 'criticalityScore',
    });
    const res = await request(app).post('/api/assets/import/commit')
      .set('Authorization', auth(manager))
      .field('columnMap', columnMap)
      .attach('file', Buffer.from(csv), 'assets.csv');
    expect(res.status).toBeLessThan(300);

    const asset = await prisma.asset.findFirst({ where: { accountId: manager.accountId, serialNumber: serial }, select: { conditionScore: true, criticalityScore: true, priorityScore: true } });
    expect(asset).toBeTruthy();
    expect(asset.conditionScore).toBe(4);
    expect(asset.criticalityScore).toBe(5);
    expect(asset.priorityScore).toBe(20);
  });
});

export {};
