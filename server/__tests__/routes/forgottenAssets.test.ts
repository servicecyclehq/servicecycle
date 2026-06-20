/**
 * Phase 1 #2 "Forgotten / untracked assets" lens. Verifies the two buckets
 * (untracked = no active program; forgotten = on a program but not serviced in
 * > N years, including never-serviced), the threshold knob, ranking, the route,
 * tenant scoping, and the clean empty-state.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildForgottenAssets } = require('../../lib/forgottenAssets');

let app: any;
let prisma: any;
let admin: TestUser;
let other: TestUser;
let aUntracked: string;
let aNever: string;
let aStale: string;
let aRecent: string;
let cleanSiteId: string;

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  other = await createTestUser('admin');

  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `Forg ${Date.now()}` } });
  const cleanSite = await prisma.site.create({ data: { accountId: admin.accountId, name: `Clean ${Date.now()}` } });
  cleanSiteId = cleanSite.id;

  const mkTd = (suffix: string) => prisma.maintenanceTaskDefinition.create({ data: { accountId: admin.accountId, equipmentType: 'MOTOR', taskName: `T ${suffix}`, taskCode: `FG_${suffix}_${Date.now()}`, intervalC2Months: 12 } });

  // untracked: in-service asset with NO active schedule.
  const u = await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR', serialNumber: 'FG-UNTR', criticalityScore: 80 } });
  aUntracked = u.id;

  // never serviced: has an active schedule, no completed WO.
  const n = await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'MOTOR', serialNumber: 'FG-NEVER' } });
  aNever = n.id;
  const tdN = await mkTd('never');
  await prisma.maintenanceSchedule.create({ data: { accountId: admin.accountId, assetId: n.id, taskDefinitionId: tdN.id, isActive: true, nextDueDate: new Date(Date.now() + 100 * DAY) } });

  // stale: active schedule + a completed WO ~4 years ago (> 3yr threshold).
  const st = await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'MOTOR', serialNumber: 'FG-STALE' } });
  aStale = st.id;
  const tdS = await mkTd('stale');
  await prisma.maintenanceSchedule.create({ data: { accountId: admin.accountId, assetId: st.id, taskDefinitionId: tdS.id, isActive: true, lastCompletedDate: new Date(Date.now() - 1460 * DAY), nextDueDate: new Date(Date.now() - 30 * DAY) } });
  await prisma.workOrder.create({ data: { accountId: admin.accountId, assetId: st.id, status: 'COMPLETE', completedDate: new Date(Date.now() - 1460 * DAY) } });

  // recent: active schedule + a recent completed WO -> NOT flagged.
  const rc = await prisma.asset.create({ data: { accountId: admin.accountId, siteId: site.id, equipmentType: 'MOTOR', serialNumber: 'FG-RECENT' } });
  aRecent = rc.id;
  const tdR = await mkTd('recent');
  await prisma.maintenanceSchedule.create({ data: { accountId: admin.accountId, assetId: rc.id, taskDefinitionId: tdR.id, isActive: true, lastCompletedDate: new Date(Date.now() - 30 * DAY), nextDueDate: new Date(Date.now() + 300 * DAY) } });
  await prisma.workOrder.create({ data: { accountId: admin.accountId, assetId: rc.id, status: 'COMPLETE', completedDate: new Date(Date.now() - 30 * DAY) } });
});

afterAll(async () => {
  for (const u of [admin, other]) {
    const acc = u.accountId;
    try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

describe('#2 forgotten / untracked assets', () => {
  test('classifies untracked vs forgotten and honours the threshold', async () => {
    const d = await buildForgottenAssets(prisma, admin.accountId, {}); // default 3yr
    const untrackedIds = d.untrackedAssets.map((a: any) => a.assetId);
    const forgottenIds = d.forgottenAssets.map((a: any) => a.assetId);

    expect(untrackedIds).toContain(aUntracked);
    expect(forgottenIds).toContain(aNever);
    expect(forgottenIds).toContain(aStale);
    // recently serviced asset is not flagged anywhere.
    expect(untrackedIds).not.toContain(aRecent);
    expect(forgottenIds).not.toContain(aRecent);

    expect(d.summary.untracked).toBe(1);
    expect(d.summary.forgotten).toBe(2);
    expect(d.summary.neverServiced).toBe(1);
    expect(d.thresholdYears).toBe(3);

    // never-serviced sorts ahead of the 4-year-stale asset.
    expect(d.forgottenAssets[0].assetId).toBe(aNever);
    expect(d.forgottenAssets[0].neverServiced).toBe(true);

    // A 5-year threshold drops the 4-year-stale asset (but keeps never-serviced).
    const d5 = await buildForgottenAssets(prisma, admin.accountId, { years: 5 });
    const forg5 = d5.forgottenAssets.map((a: any) => a.assetId);
    expect(forg5).toContain(aNever);
    expect(forg5).not.toContain(aStale);
    expect(d5.thresholdYears).toBe(5);
  });

  test('GET /api/compliance/forgotten-assets serves the view', async () => {
    const res = await request(app).get('/api/compliance/forgotten-assets?years=3').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.summary.flagged).toBe(3);
    expect(res.body.data.untrackedAssets.length).toBe(1);
  });

  test('is tenant-scoped and handles a clean / empty scope + bad site', async () => {
    const o = await request(app).get('/api/compliance/forgotten-assets').set('Authorization', `Bearer ${other.token}`);
    expect(o.status).toBe(200);
    expect(o.body.data.summary.flagged).toBe(0);

    const clean = await buildForgottenAssets(prisma, admin.accountId, { siteId: cleanSiteId });
    expect(clean.summary.clean).toBe(true);
    expect(clean.summary.flagged).toBe(0);

    const bad = await request(app).get('/api/compliance/forgotten-assets?siteId=00000000-0000-4000-8000-000000000000').set('Authorization', `Bearer ${admin.token}`);
    expect(bad.status).toBe(404);
  });
});

export {};
