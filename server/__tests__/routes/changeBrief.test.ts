/**
 * "What changed since last cycle" audit brief. Verifies the diff is anchored on
 * the prior compliance snapshot, counts assets added / maintenance completed /
 * deficiencies opened+resolved since that point, groups by site, produces a
 * narrative, handles the no-prior-snapshot case, and serves the route.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { buildChangeBrief } = require('../../lib/changeBrief');

let app: any;
let prisma: any;
let admin: TestUser;     // has a prior snapshot
let fresh: TestUser;     // no snapshot -> hasPrior false
let siteId: string;

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  fresh = await createTestUser('admin');

  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `Cyc ${Date.now()}` } });
  siteId = site.id;

  // Prior compliance snapshot, dated 10 days ago = the "last cycle" anchor.
  await prisma.complianceSnapshot.create({
    data: {
      accountId: admin.accountId, siteId, kind: 'compliance',
      filename: 'prior.pdf', filePath: `${admin.accountId}/misc/prior.pdf`, sha256: 'x'.repeat(64),
      sizeBytes: 1, stats: { current: 1, overdue: 1, assets: 1, openDeficiencies: 1 },
      createdAt: new Date(Date.now() - 10 * DAY),
    },
  });

  // Changes AFTER the anchor (asset.createdAt auto = now >= since):
  // an asset added, a serviced schedule, an opened + a resolved deficiency.
  const a = await prisma.asset.create({ data: { accountId: admin.accountId, siteId, equipmentType: 'MOTOR', serialNumber: 'C1' } });
  const td = await prisma.maintenanceTaskDefinition.create({ data: { accountId: admin.accountId, equipmentType: 'MOTOR', taskName: 'IR', taskCode: `C_${Date.now()}`, intervalC2Months: 12 } });
  await prisma.maintenanceSchedule.create({ data: { accountId: admin.accountId, assetId: a.id, taskDefinitionId: td.id, isActive: true, lastCompletedDate: new Date(Date.now() - 1 * DAY), nextDueDate: new Date(Date.now() + 300 * DAY) } });
  await prisma.deficiency.create({ data: { accountId: admin.accountId, assetId: a.id, severity: 'RECOMMENDED', description: 'opened since cycle' } });
  await prisma.deficiency.create({ data: { accountId: admin.accountId, assetId: a.id, severity: 'ADVISORY', description: 'resolved since cycle', resolvedAt: new Date(Date.now() - 1 * DAY) } });
});

afterAll(async () => {
  for (const u of [admin, fresh]) {
    const acc = u.accountId;
    try { await prisma.complianceSnapshot.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceSchedule.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.maintenanceTaskDefinition.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.deficiency.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

describe('change brief', () => {
  test('diffs against the prior snapshot and counts the changes', async () => {
    const b = await buildChangeBrief(prisma, admin.accountId, {});
    expect(b.hasPrior).toBe(true);
    expect(b.since).toBeTruthy();
    expect(b.totals.assetsAdded).toBeGreaterThanOrEqual(1);
    expect(b.totals.maintenanceCompleted).toBeGreaterThanOrEqual(1);
    expect(b.totals.deficienciesOpened).toBeGreaterThanOrEqual(1);
    expect(b.totals.deficienciesResolved).toBeGreaterThanOrEqual(1);
    expect(b.bySite.length).toBeGreaterThanOrEqual(1);
    expect(typeof b.narrative).toBe('string');
    expect(b.narrative).toMatch(/since the last cycle/i);
    // complianceThen is derived from the snapshot stats (1 current / 1 overdue = 50%).
    expect(b.complianceThen).toBe(50);
  });

  test('no prior snapshot -> hasPrior false with a guiding narrative', async () => {
    const b = await buildChangeBrief(prisma, fresh.accountId, {});
    expect(b.hasPrior).toBe(false);
    expect(b.since).toBeNull();
    expect(b.narrative).toMatch(/no prior compliance snapshot/i);
  });

  test('GET /api/compliance/change-brief returns the brief', async () => {
    const res = await request(app).get('/api/compliance/change-brief').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.hasPrior).toBe(true);
    expect(res.body.data.totals).toBeTruthy();
  });
});

export {};
