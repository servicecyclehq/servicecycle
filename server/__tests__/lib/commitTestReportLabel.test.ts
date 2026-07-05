/**
 * [W2] Regression lock: TestMeasurement.label must actually persist.
 *
 * commitAssetReadings() has long READ x.label off incoming measurements (for
 * deficiency description text) but never wrote it to the created row -- the
 * extractor already computes reading identity (DGA gas species, winding
 * pair, PF test mode, battery cell) and it was silently discarded before
 * this fix. See docs/scoping/audits/afx-scenario-preservation.md, W2
 * (design approved by Dustin 2026-07-05: one flexible label column).
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let prisma: any;
let commitAssetReadings: any;
let user: TestUser;
let assetId: string;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  ({ commitAssetReadings } = require('../../lib/commitTestReport'));
  user = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: user.accountId, name: `label-test ${Date.now()}` } });
  const asset = await prisma.asset.create({ data: { accountId: user.accountId, siteId: site.id, equipmentType: 'TRANSFORMER_LIQUID', serialNumber: `LBL-${Date.now()}` } });
  assetId = asset.id;
});

afterAll(async () => {
  const acc = user.accountId;
  try { await prisma.deficiency.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.testMeasurement.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.delete({ where: { id: user.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

test('a labeled DGA reading persists its species label on the TestMeasurement row', async () => {
  await commitAssetReadings(prisma, {
    accountId: user.accountId, assetId, when: new Date(), vendor: 'Test Lab',
    measurements: [
      { measurementType: 'dissolved_gas', label: 'Hydrogen (H2)', asFoundValue: 1240, asFoundUnit: 'ppm', passFail: 'RED', critical: true },
      { measurementType: 'dissolved_gas', label: 'Ethylene (C2H4)', asFoundValue: 405, asFoundUnit: 'ppm', passFail: 'RED', critical: true },
    ],
  });

  const rows = await prisma.testMeasurement.findMany({ where: { accountId: user.accountId, workOrder: { assetId } }, orderBy: { createdAt: 'asc' } });
  expect(rows).toHaveLength(2);
  expect(rows.map((r: any) => r.label).sort()).toEqual(['Ethylene (C2H4)', 'Hydrogen (H2)']);
});

test('a reading with no label persists label=null, no crash', async () => {
  await commitAssetReadings(prisma, {
    accountId: user.accountId, assetId, when: new Date(), vendor: 'Test Lab',
    measurements: [
      { measurementType: 'power_factor', asFoundValue: 0.34, asFoundUnit: '%', passFail: 'GREEN' },
    ],
  });

  const row = await prisma.testMeasurement.findFirst({ where: { accountId: user.accountId, measurementType: 'power_factor' } });
  expect(row.label).toBeNull();
});
