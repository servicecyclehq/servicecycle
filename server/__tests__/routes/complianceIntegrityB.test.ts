/**
 * Cluster B compliance integrity:
 *  - a commit whose rows carry no value and no pass/fail is rejected
 *    (no "compliance by import" of a date-only report)
 *  - an order-of-magnitude unit/scale outlier is flagged (non-blocking)
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { checkMeasurementSanity } = require('../../lib/measurementSanity');

let app: any;
let prisma: any;
let mgr: TestUser;
let assetId: string;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  mgr = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: mgr.accountId, name: `B ${Date.now()}` } });
  const a = await prisma.asset.create({ data: { accountId: mgr.accountId, siteId: site.id, equipmentType: 'SWITCHGEAR', serialNumber: `B-${Date.now()}` } });
  assetId = a.id;
});

afterAll(async () => {
  const acc = mgr.accountId;
  try { await prisma.deficiency.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.testMeasurement.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.delete({ where: { id: mgr.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

describe('B / checkMeasurementSanity (pure)', () => {
  test('flags an order-of-magnitude contact-resistance outlier', () => {
    expect(checkMeasurementSanity('contact_resistance', 9e8)).toBeTruthy();
  });
  test('passes a plausible insulation resistance', () => {
    expect(checkMeasurementSanity('insulation_resistance', 5000)).toBeNull();
  });
  test('flags a negative resistance', () => {
    expect(checkMeasurementSanity('winding_resistance', -5)).toBeTruthy();
  });
  test('ignores unknown measurement types', () => {
    expect(checkMeasurementSanity('weirdo_unknown', 1e12)).toBeNull();
  });
});

describe('B1 / compliance-by-import guard', () => {
  test('rejects a commit whose rows have no value and no pass/fail', async () => {
    const res = await request(app)
      .post('/api/test-reports/import/commit')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ assetId, measurements: [{ measurementType: 'insulation_resistance', label: 'IR' }] });
    expect(res.status).toBe(400);
    expect(String(res.body.error || '')).toMatch(/usable readings/i);
  });
});

describe('B2 / unit-scale flag on commit', () => {
  test('an absurd contact-resistance value commits but raises a sanity flag', async () => {
    const res = await request(app)
      .post('/api/test-reports/import/commit')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ assetId, measurements: [{ measurementType: 'contact_resistance', asFoundValue: 999999999, asFoundUnit: 'mOhm' }] });
    expect(res.status).toBe(201);
    expect(res.body.data.sanityFlags).toBeGreaterThanOrEqual(1);
  });
});

export {};