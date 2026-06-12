/**
 * #27 Acceptance test = year-0 baseline. Verifies the test-report commit marks
 * a work order as the acceptance/commissioning baseline, the test-history
 * endpoint surfaces baselineEventId + per-event isBaseline/isAcceptanceTest,
 * and a backfilled acceptance test does NOT generate year-over-year trend
 * deficiencies (a baseline is the anchor, not a comparison).
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let manager: TestUser;
let siteId: string;
let assetA: string; // acceptance-flagged commit
let assetB: string; // backfilled acceptance after a maintenance test

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `Accept ${Date.now()}` } });
  siteId = site.id;
  const a = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR', serialNumber: 'ACC-A' } });
  const b = await prisma.asset.create({ data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR', serialNumber: 'ACC-B' } });
  assetA = a.id; assetB = b.id;
});

afterAll(async () => {
  const acc = manager.accountId;
  try { await prisma.deficiency.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.testMeasurement.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: manager.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

const auth = () => `Bearer ${manager.token}`;

describe('#27 acceptance test = year-0 baseline', () => {
  test('commit flags the work order and skips trend flags on the baseline', async () => {
    const res = await request(app)
      .post('/api/test-reports/import/commit')
      .set('Authorization', auth())
      .send({
        assetId: assetA, testDate: '2020-01-15', vendor: 'Commissioning Co', isAcceptanceTest: true,
        measurements: [
          { measurementType: 'insulation_resistance', label: 'IR A', phase: 'A', asFoundValue: 1000, asFoundUnit: 'MΩ', passFail: 'GREEN' },
        ],
      });
    expect(res.status).toBe(201);
    const wo = await prisma.workOrder.findFirst({ where: { id: res.body.data.workOrderId }, select: { isAcceptanceTest: true } });
    expect(wo.isAcceptanceTest).toBe(true);
  });

  test('test-history returns baselineEventId + per-event flags', async () => {
    const res = await request(app)
      .get(`/api/assets/${assetA}/test-history`)
      .set('Authorization', auth());
    expect(res.status).toBe(200);
    const { events, baselineEventId } = res.body.data;
    expect(baselineEventId).toBeTruthy();
    const ev = events.find((e: any) => e.id === baselineEventId);
    expect(ev.isAcceptanceTest).toBe(true);
    expect(ev.isBaseline).toBe(true);
  });

  test('backfilled acceptance test does NOT flag a downward trend deficiency', async () => {
    // First a maintenance test establishes a prior reading…
    await request(app).post('/api/test-reports/import/commit').set('Authorization', auth()).send({
      assetId: assetB, testDate: '2024-06-01', vendor: 'Maint Co',
      measurements: [{ measurementType: 'insulation_resistance', label: 'IR A', phase: 'A', asFoundValue: 1000, asFoundUnit: 'MΩ', passFail: 'GREEN' }],
    });
    // …then a *backfilled* acceptance test with a much lower value (would be a
    // 50% downward trend) — must NOT produce an advisory trend deficiency.
    const res = await request(app).post('/api/test-reports/import/commit').set('Authorization', auth()).send({
      assetId: assetB, testDate: '2019-01-01', vendor: 'Commissioning Co', isAcceptanceTest: true,
      measurements: [{ measurementType: 'insulation_resistance', label: 'IR A', phase: 'A', asFoundValue: 500, asFoundUnit: 'MΩ', passFail: 'GREEN' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.trendDeficiencies).toBe(0);
    expect(res.body.data.deficienciesCreated).toBe(0);
  });

  test('baseline prefers the acceptance test even when a later maintenance test exists', async () => {
    const res = await request(app).get(`/api/assets/${assetB}/test-history`).set('Authorization', auth());
    const { events, baselineEventId } = res.body.data;
    const baseline = events.find((e: any) => e.id === baselineEventId);
    expect(baseline.isAcceptanceTest).toBe(true);
  });
});

export {};
