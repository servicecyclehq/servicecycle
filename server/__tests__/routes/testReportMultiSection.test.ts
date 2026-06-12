/**
 * #1 one-upload = one-facility — multi-section commit. Verifies the transactional
 * match-or-create path (writes N assets atomically), the unchanged legacy
 * single-asset path, validation, all-or-nothing rollback, and that a non-ASCII
 * unit (µΩ) round-trips cleanly through the whole write path.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let manager: TestUser;
let siteId: string;
let existingAssetId: string;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `MultiSec ${Date.now()}` } });
  siteId = site.id;
  const a = await prisma.asset.create({
    data: { accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR', serialNumber: 'EXIST-1' },
  });
  existingAssetId = a.id;
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

describe('POST /commit — multi-section (#1)', () => {
  test('writes one section to an existing asset and creates a new asset for another, atomically', async () => {
    const res = await request(app)
      .post('/api/test-reports/import/commit')
      .set('Authorization', auth())
      .send({
        testDate: '2026-03-04', vendor: 'Acme NETA',
        sections: [
          {
            assetId: existingAssetId, label: 'SWGR-1 / MAIN',
            measurements: [
              { measurementType: 'insulation_resistance', label: 'IR A', phase: 'A', asFoundValue: 1000, asFoundUnit: 'MΩ', passFail: 'GREEN' },
              { measurementType: 'contact_resistance', label: 'Contact', asFoundValue: 250, asFoundUnit: 'µΩ', passFail: 'RED', critical: true },
            ],
          },
          {
            createAsset: { siteId, equipmentType: 'SWITCHGEAR', serialNumber: 'NEW-TIE-2', manufacturer: 'Square D', model: 'QED' },
            label: 'SWGR-2 / TIE',
            measurements: [
              { measurementType: 'insulation_resistance', label: 'IR A', phase: 'A', asFoundValue: 1500, asFoundUnit: 'MΩ', passFail: 'GREEN' },
            ],
          },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totals.assetsCreated).toBe(1);
    expect(res.body.data.totals.measurementsCreated).toBe(3);
    expect(res.body.data.sections.length).toBe(2);

    // The created asset exists with the supplied serial.
    const created = await prisma.asset.findFirst({ where: { accountId: manager.accountId, serialNumber: 'NEW-TIE-2' } });
    expect(created).toBeTruthy();
    expect(created.siteId).toBe(siteId);

    // Readings landed on the right assets (existing got 2, new got 1).
    const woExisting = await prisma.workOrder.findMany({ where: { assetId: existingAssetId }, select: { id: true } });
    const existingMeas = await prisma.testMeasurement.count({ where: { workOrderId: { in: woExisting.map((w: any) => w.id) } } });
    expect(existingMeas).toBe(2);

    // The RED critical reading became an IMMEDIATE deficiency.
    const defs = await prisma.deficiency.count({ where: { assetId: existingAssetId, severity: 'IMMEDIATE' } });
    expect(defs).toBe(1);

    // Non-ASCII unit survived the round-trip.
    const microOhm = await prisma.testMeasurement.findFirst({ where: { accountId: manager.accountId, asFoundUnit: 'µΩ' } });
    expect(microOhm).toBeTruthy();
    expect(microOhm.asFoundUnit).toBe('µΩ');
  });

  test('rejects a section missing measurements', async () => {
    const res = await request(app).post('/api/test-reports/import/commit').set('Authorization', auth())
      .send({ sections: [{ assetId: existingAssetId, measurements: [] }] });
    expect(res.status).toBe(400);
  });

  test('rejects createAsset missing siteId/equipmentType', async () => {
    const res = await request(app).post('/api/test-reports/import/commit').set('Authorization', auth())
      .send({ sections: [{ createAsset: { equipmentType: 'SWITCHGEAR' }, measurements: [{ measurementType: 'x', asFoundValue: 1 }] }] });
    expect(res.status).toBe(400);
  });

  test('is all-or-nothing: a bad assetId in section 2 rolls back section 1', async () => {
    const before = await prisma.asset.count({ where: { accountId: manager.accountId, serialNumber: 'ROLLBACK-NEW' } });
    const res = await request(app).post('/api/test-reports/import/commit').set('Authorization', auth())
      .send({
        sections: [
          { createAsset: { siteId, equipmentType: 'SWITCHGEAR', serialNumber: 'ROLLBACK-NEW' }, measurements: [{ measurementType: 'insulation_resistance', asFoundValue: 1, asFoundUnit: 'MΩ', passFail: 'GREEN' }] },
          { assetId: '00000000-0000-4000-8000-000000000000', measurements: [{ measurementType: 'insulation_resistance', asFoundValue: 1, passFail: 'GREEN' }] },
        ],
      });
    expect(res.status).toBe(404);
    const after = await prisma.asset.count({ where: { accountId: manager.accountId, serialNumber: 'ROLLBACK-NEW' } });
    expect(after).toBe(before); // section 1's asset was NOT persisted
  });
});

describe('POST /commit — legacy single-asset path unchanged', () => {
  test('commits flat measurements to one asset', async () => {
    const res = await request(app).post('/api/test-reports/import/commit').set('Authorization', auth())
      .send({
        assetId: existingAssetId, testDate: '2026-03-05',
        measurements: [{ measurementType: 'power_factor', label: 'PF', asFoundValue: 2.1, asFoundUnit: '%', passFail: 'GREEN' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.data.measurementsCreated).toBe(1);
    expect(res.body.data.assetId).toBe(existingAssetId);
  });
});
