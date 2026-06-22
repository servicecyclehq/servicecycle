/**
 * Slice 3a — GET /api/arc-flash/fleet cross-site rollup. Boots the app + seeds a
 * site with a DANGER bus and a contradiction, then asserts the per-site + total
 * aggregation (danger %, confidence, contradiction counts).
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let manager: TestUser;
let siteId: string;

const auth = (u: TestUser) => `Bearer ${u.token}`;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `Fleet ${Date.now()}` } });
  siteId = site.id;
  const asset = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR' } });
  const study = await prisma.systemStudy.create({
    data: {
      accountId: manager.accountId, siteId, studyType: 'arc_flash',
      performedDate: new Date(), expiresAt: new Date(Date.now() + 4 * 365 * 864e5), method: 'IEEE 1584-2018',
    },
  });
  // A DANGER bus (incident energy > 40) that is ALSO internally contradictory
  // (arcing current > bolted fault current).
  await prisma.systemStudyAsset.create({
    data: {
      accountId: manager.accountId, studyId: study.id, assetId: asset.id, busName: 'SWGR-DANGER', nominalVoltage: '480V',
      incidentEnergyCalCm2: 55, boltedFaultCurrentKA: 20, arcingCurrentKA: 25, labelSeverity: 'danger',
      deviceType: 'breaker', tripUnitType: 'electronic_lsig', deviceRatingA: 800,
    },
  });
});

afterAll(async () => {
  const acc = manager.accountId;
  for (const t of ['deviceTestRecord', 'studySourceModel', 'protectiveDevice', 'arcFlashCollectionTask', 'systemStudyAsset', 'systemStudy', 'asset', 'site']) {
    try { await (prisma as any)[t].deleteMany({ where: { accountId: acc } }); } catch {}
  }
  try { await prisma.user.delete({ where: { id: manager.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

describe('GET /api/arc-flash/fleet', () => {
  test('requires auth', async () => {
    await request(app).get('/api/arc-flash/fleet').expect(401);
  });

  test('rolls up the site: danger %, confidence, contradictions', async () => {
    const res = await request(app).get('/api/arc-flash/fleet').set('Authorization', auth(manager)).expect(200);
    const { sites, totals } = res.body.data;
    expect(Array.isArray(sites)).toBe(true);
    const site = sites.find((s: any) => s.siteId === siteId);
    expect(site).toBeTruthy();
    expect(site.busCount).toBe(1);
    expect(site.dangerCount).toBe(1);
    expect(site.dangerPct).toBe(100);
    expect(site.contradictionErrors).toBeGreaterThanOrEqual(1); // arcing > bolted
    expect(typeof site.avgConfidence).toBe('number');
    expect(totals.busCount).toBeGreaterThanOrEqual(1);
    expect(totals.dangerCount).toBeGreaterThanOrEqual(1);
  });
});
