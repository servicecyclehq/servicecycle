/**
 * Phase 4 #9 -- enterprise-group (HoldCo over OpCos) roll-up. Covers: the
 * group_admin role gate, cross-OpCo dashboard aggregation scoped to the group
 * (siblings in, outsiders out), single-OpCo drill-down + membership wall,
 * group rate-card upsert/list (centralized master data), and the resolver
 * inheritance (account > group > platform).
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildRateResolver } = require('../../lib/rateResolver');

let app: any;
let prisma: any;
let groupId: string;
let opcoA: TestUser;  // group_admin lives here
let opcoB: TestUser;  // sibling OpCo (admin)
let outsider: TestUser; // account with no group
const DAY = 86_400_000;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;

  const group = await prisma.enterpriseGroup.create({ data: { name: `HoldCo ${Date.now()}` } });
  groupId = group.id;

  opcoA = await createTestUser('group_admin', { enterpriseGroupId: groupId });
  opcoB = await createTestUser('admin', { enterpriseGroupId: groupId });
  outsider = await createTestUser('admin');

  // Seed A: 2 assets, 2 active schedules (1 overdue, 1 future), 1 IMMEDIATE deficiency.
  const siteA = await prisma.site.create({ data: { accountId: opcoA.accountId, name: 'A-site' } });
  const a1 = await prisma.asset.create({ data: { accountId: opcoA.accountId, siteId: siteA.id, equipmentType: 'SWITCHGEAR', serialNumber: 'A1' } });
  const a2 = await prisma.asset.create({ data: { accountId: opcoA.accountId, siteId: siteA.id, equipmentType: 'PANELBOARD', serialNumber: 'A2' } });
  const tdA = await prisma.maintenanceTaskDefinition.create({ data: { accountId: opcoA.accountId, equipmentType: 'SWITCHGEAR', taskName: 'PM', taskCode: `A_${Date.now()}`, intervalC2Months: 12 } });
  await prisma.maintenanceSchedule.create({ data: { accountId: opcoA.accountId, assetId: a1.id, taskDefinitionId: tdA.id, isActive: true, nextDueDate: new Date(Date.now() - 10 * DAY) } }); // overdue
  await prisma.maintenanceSchedule.create({ data: { accountId: opcoA.accountId, assetId: a2.id, taskDefinitionId: tdA.id, isActive: true, nextDueDate: new Date(Date.now() + 30 * DAY) } }); // future
  await prisma.deficiency.create({ data: { accountId: opcoA.accountId, assetId: a1.id, severity: 'IMMEDIATE', description: 'def' } });

  // Seed B: 1 asset, 1 future schedule.
  const siteB = await prisma.site.create({ data: { accountId: opcoB.accountId, name: 'B-site' } });
  const b1 = await prisma.asset.create({ data: { accountId: opcoB.accountId, siteId: siteB.id, equipmentType: 'SWITCHGEAR', serialNumber: 'B1' } });
  const tdB = await prisma.maintenanceTaskDefinition.create({ data: { accountId: opcoB.accountId, equipmentType: 'SWITCHGEAR', taskName: 'PM', taskCode: `B_${Date.now()}`, intervalC2Months: 12 } });
  await prisma.maintenanceSchedule.create({ data: { accountId: opcoB.accountId, assetId: b1.id, taskDefinitionId: tdB.id, isActive: true, nextDueDate: new Date(Date.now() + 30 * DAY) } });
});

afterAll(async () => {
  const accts = [opcoA.accountId, opcoB.accountId, outsider.accountId];
  try { await prisma.serviceRateCard.deleteMany({ where: { OR: [{ enterpriseGroupId: groupId }, { accountId: { in: accts } }] } }); } catch {}
  for (const acc of accts) {
    try { await prisma.deficiency.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  }
  for (const u of [opcoA, opcoB, outsider]) { try { await prisma.user.delete({ where: { id: u.id } }); } catch {} }
  for (const acc of accts) { try { await prisma.account.delete({ where: { id: acc } }); } catch {} }
  try { await prisma.enterpriseGroup.delete({ where: { id: groupId } }); } catch {}
  await prisma.$disconnect();
});

const bearer = (t: string) => `Bearer ${t}`;

describe('Phase 4 #9 enterprise-group roll-up', () => {
  test('role gate: a non group_admin cannot read the group dashboard (403)', async () => {
    const res = await request(app).get('/api/group/dashboard').set('Authorization', bearer(opcoB.token));
    expect(res.status).toBe(403);
  });

  test('dashboard aggregates the group OpCos and excludes outsiders', async () => {
    const res = await request(app).get('/api/group/dashboard').set('Authorization', bearer(opcoA.token));
    expect(res.status).toBe(200);
    const ids = res.body.data.opCos.map((o: any) => o.accountId).sort();
    expect(ids).toEqual([opcoA.accountId, opcoB.accountId].sort());
    expect(ids).not.toContain(outsider.accountId);

    const a = res.body.data.opCos.find((o: any) => o.accountId === opcoA.accountId);
    expect(a.assetCount).toBe(2);
    expect(a.overdueSchedules).toBe(1);
    expect(a.activeSchedules).toBe(2);
    expect(a.openImmediateDeficiencies).toBe(1);
    expect(a.compliancePct).toBe(50);

    expect(res.body.data.totals.opCoCount).toBe(2);
    expect(res.body.data.totals.assetCount).toBe(3);
  });

  test('drill-down works for a member OpCo and is walled from outsiders', async () => {
    const ok = await request(app).get(`/api/group/accounts/${opcoA.accountId}`).set('Authorization', bearer(opcoA.token));
    expect(ok.status).toBe(200);
    expect(ok.body.data.assetCount).toBe(2);
    expect(ok.body.data.openDeficiencies.IMMEDIATE).toBe(1);

    const walled = await request(app).get(`/api/group/accounts/${outsider.accountId}`).set('Authorization', bearer(opcoA.token));
    expect(walled.status).toBe(403);
  });

  test('group rate card is centralized master data inherited by OpCos', async () => {
    const put = await request(app).put('/api/group/rate-cards').set('Authorization', bearer(opcoA.token))
      .send({ serviceType: 'INSPECTION', minCents: 11100, maxCents: 22200 });
    expect(put.status).toBe(200);

    const list = await request(app).get('/api/group/rate-cards').set('Authorization', bearer(opcoA.token));
    const insp = list.body.data.rates.find((r: any) => r.serviceType === 'INSPECTION');
    expect(insp.source).toBe('group');
    expect(insp.minCents).toBe(11100);

    // An OpCo with no account override inherits the group rate.
    const r1 = await buildRateResolver(prisma, { accountId: opcoA.accountId, enterpriseGroupId: groupId });
    expect(r1.get('INSPECTION')).toEqual({ minCents: 11100, maxCents: 22200 });

    // An account-level override beats the group standard.
    await prisma.serviceRateCard.create({ data: { accountId: opcoA.accountId, serviceType: 'INSPECTION', minCents: 33300, maxCents: 44400 } });
    const r2 = await buildRateResolver(prisma, { accountId: opcoA.accountId, enterpriseGroupId: groupId });
    expect(r2.get('INSPECTION')).toEqual({ minCents: 33300, maxCents: 44400 });
  });
});

export {};
