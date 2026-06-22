/**
 * Arc-flash schema-bootstrap slices C / E / G + per-asset surfacing.
 *   C — ElectrodeConfig enum persists on a SystemStudyAsset.
 *   E — StudySourceModel upsert (utility / transformer source model).
 *   G — DeviceTestRecord drift detection (as-found != as-left -> stale study).
 *   surfacing — GET /api/arc-flash/asset/:id consolidates it all.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let manager: TestUser;
let siteId: string;
let assetId: string;
let studyId: string;

const auth = (u: TestUser) => `Bearer ${u.token}`;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `AFB ${Date.now()}` } });
  siteId = site.id;
  const asset = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR' } });
  assetId = asset.id;
  const study = await prisma.systemStudy.create({
    data: {
      accountId: manager.accountId, siteId, studyType: 'arc_flash',
      performedDate: new Date('2024-02-01'), expiresAt: new Date('2029-02-01'), method: 'IEEE 1584-2018', peName: 'A. Engineer',
    },
  });
  studyId = study.id;
  await prisma.systemStudyAsset.create({
    data: {
      accountId: manager.accountId, studyId, assetId, busName: 'SWGR-1A-1', nominalVoltage: '480V',
      incidentEnergyCalCm2: 12.1, arcFlashBoundaryIn: 36, workingDistanceIn: 18, electrodeConfig: 'VCB',
      labelSeverity: 'warning', deviceType: 'breaker', tripUnitType: 'electronic_lsig', deviceRatingA: 800,
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

describe('slice C — ElectrodeConfig enum', () => {
  test('the seeded study asset stored the VCB enum value', async () => {
    const row = await prisma.systemStudyAsset.findFirst({ where: { assetId } });
    expect(row.electrodeConfig).toBe('VCB');
  });
});

describe('slice E — study source model', () => {
  test('PUT upserts the utility + transformer source model', async () => {
    const res = await request(app)
      .put(`/api/arc-flash/studies/${studyId}/source-model`)
      .set('Authorization', auth(manager))
      .send({ utilityMaxFaultKA: 25.4, utilityMinFaultKA: 12.0, utilityXr: 6.2, transformerKva: 1500, transformerImpedancePct: 5.75, transformerPrimaryV: 13800, transformerSecondaryV: 480, below125kvaFlag: false });
    expect(res.status).toBe(200);
    expect(res.body.data.sourceModel.utilityMaxFaultKA).toBe(25.4);
    expect(res.body.data.sourceModel.transformerSecondaryV).toBe(480);

    const get = await request(app).get(`/api/arc-flash/studies/${studyId}/source-model`).set('Authorization', auth(manager));
    expect(get.status).toBe(200);
    expect(get.body.data.sourceModel.utilityMinFaultKA).toBe(12);
  });
});

describe('slice G — NETA device test drift', () => {
  test('as-found != as-left flags drift; matching does not', async () => {
    const drift = await request(app)
      .post('/api/arc-flash/device-tests')
      .set('Authorization', auth(manager))
      .send({ siteId, assetId, testType: 'as_found_as_left', performedBy: 'NETA Tech', asFoundSettings: { ltPickupA: 400 }, asLeftSettings: { ltPickupA: 320 } });
    expect(drift.status).toBe(201);
    expect(drift.body.data.driftFlagged).toBe(true);

    const clean = await request(app)
      .post('/api/arc-flash/device-tests')
      .set('Authorization', auth(manager))
      .send({ siteId, assetId, testType: 'relay_calibration', asFoundSettings: { pickupA: 5 }, asLeftSettings: { pickupA: 5 } });
    expect(clean.status).toBe(201);
    expect(clean.body.data.driftFlagged).toBe(false);

    const list = await request(app).get(`/api/arc-flash/device-tests?assetId=${assetId}`).set('Authorization', auth(manager));
    expect(list.status).toBe(200);
    expect(list.body.data.anyStale).toBe(true);
  });

  test('matchesStudy=false flags drift even without as-left', async () => {
    const res = await request(app)
      .post('/api/arc-flash/device-tests')
      .set('Authorization', auth(manager))
      .send({ siteId, assetId, testType: 'breaker_trip_test', matchesStudy: false });
    expect(res.body.data.driftFlagged).toBe(true);
  });
});

describe('surfacing — GET /asset/:id', () => {
  test('consolidates label + tests + stale flag for the asset', async () => {
    const res = await request(app).get(`/api/arc-flash/asset/${assetId}`).set('Authorization', auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.data.hasArcFlash).toBe(true);
    expect(res.body.data.current.busName).toBe('SWGR-1A-1');
    expect(res.body.data.current.electrodeConfig).toBe('VCB');
    expect(res.body.data.labelSeverity).toBe('warning');
    expect(res.body.data.staleStudy).toBe(true); // from the slice-G drift test above
    expect(res.body.data.current.study.sourceModel.transformerSecondaryV).toBe(480);
  });
});
