/**
 * [P5 2026-07-22] Regression lock: commitAssetReadings() must create deficiencies
 * PER TEST POINT (groupTestPoints() -- consecutive same-label readings), not per
 * individual reading row.
 *
 * Root cause: P3 (2026-07-22) added groupTestPoints() to collapse a multi-row
 * NETA test point (e.g. a single A-G insulation-resistance point printing
 * 1-Min/10-Min/PI as 3 rows sharing one label) into one summary chip in the
 * Preview UI -- but the grouping was never applied at COMMIT time. Committing
 * the 3 real Riverside NETA demo reports (2024/2025/DEMO) through the live app
 * inflated Open Deficiencies from 1 pre-existing to 32 -- confirmed live, not
 * synthetic. See docs/DEMO_FIXES.md P5 entry.
 *
 * This file exercises commitAssetReadings() directly against a live test DB
 * (see helpers/setup.ts -- only email sending is mocked), same pattern as
 * commitTestReportLabel.test.ts.
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
  const site = await prisma.site.create({ data: { accountId: user.accountId, name: `defgroup-test ${Date.now()}` } });
  const asset = await prisma.asset.create({ data: { accountId: user.accountId, siteId: site.id, equipmentType: 'TRANSFORMER_LIQUID', serialNumber: `DEFGRP-${Date.now()}` } });
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

test('3 same-label failing readings (one test point) collapse to 1 severity deficiency', async () => {
  const r = await commitAssetReadings(prisma, {
    accountId: user.accountId, assetId, when: new Date(), vendor: 'Test Lab',
    measurements: [
      { measurementType: 'winding_resistance', label: 'H-X', phase: 'A', asFoundValue: 120, asFoundUnit: 'mΩ', passFail: 'RED', critical: false },
      { measurementType: 'winding_resistance', label: 'H-X', phase: 'B', asFoundValue: 118, asFoundUnit: 'mΩ', passFail: 'RED', critical: false },
      { measurementType: 'winding_resistance', label: 'H-X', phase: 'C', asFoundValue: 121, asFoundUnit: 'mΩ', passFail: 'RED', critical: false },
    ],
  });

  expect(r.measurementsCreated).toBe(3); // per-reading: unchanged
  expect(r.deficienciesCreated).toBe(1); // per-point: was 3 before the fix
  expect(r.deficiencyBySeverity.RECOMMENDED).toBe(1);

  const defs = await prisma.deficiency.findMany({ where: { accountId: user.accountId, workOrderId: r.workOrderId } });
  expect(defs).toHaveLength(1);
  expect(defs[0].description).toContain('H-X');
});

test('2 distinct-label failing points stay separate (1 deficiency each)', async () => {
  const r = await commitAssetReadings(prisma, {
    accountId: user.accountId, assetId, when: new Date(), vendor: 'Test Lab',
    measurements: [
      { measurementType: 'power_factor', label: 'CH', asFoundValue: 5.2, asFoundUnit: '%', passFail: 'RED', critical: true },
      { measurementType: 'power_factor', label: 'CHG', asFoundValue: 4.9, asFoundUnit: '%', passFail: 'RED', critical: true },
    ],
  });

  expect(r.measurementsCreated).toBe(2);
  expect(r.deficienciesCreated).toBe(2); // 2 distinct points -> 2 deficiencies, not collapsed
  expect(r.deficiencyBySeverity.IMMEDIATE).toBe(2);

  const defs = await prisma.deficiency.findMany({ where: { accountId: user.accountId, workOrderId: r.workOrderId } });
  const labels = defs.map((d: any) => d.description).sort();
  expect(labels.some((d: string) => d.includes('CH:') || d.startsWith('CH '))).toBe(true);
  expect(labels.some((d: string) => d.includes('CHG'))).toBe(true);
});

test('mixed-severity readings within one point: worst severity wins the single deficiency', async () => {
  const r = await commitAssetReadings(prisma, {
    accountId: user.accountId, assetId, when: new Date(), vendor: 'Test Lab',
    measurements: [
      { measurementType: 'insulation_resistance', label: '1-Min', phase: 'A', asFoundValue: 9000, asFoundUnit: 'MΩ', passFail: 'GREEN', critical: false },
      { measurementType: 'insulation_resistance', label: '1-Min', phase: 'B', asFoundValue: 400, asFoundUnit: 'MΩ', passFail: 'YELLOW', critical: false },
      { measurementType: 'insulation_resistance', label: '1-Min', phase: 'C', asFoundValue: 12, asFoundUnit: 'MΩ', passFail: 'RED', critical: true },
    ],
  });

  expect(r.measurementsCreated).toBe(3);
  expect(r.deficienciesCreated).toBe(1); // collapsed to the worst reading in the point
  expect(r.deficiencyBySeverity.IMMEDIATE).toBe(1);

  const defs = await prisma.deficiency.findMany({ where: { accountId: user.accountId, workOrderId: r.workOrderId } });
  expect(defs).toHaveLength(1);
  expect(defs[0].severity).toBe('IMMEDIATE');
  expect(defs[0].description).toContain('12'); // the RED (Ph C) reading's value, not GREEN/YELLOW
});

test('trend-only point: multiple trending readings collapse to 1 trend deficiency (steepest wins)', async () => {
  // Baseline commit establishes prior values for phase A and phase B.
  const baseline = await commitAssetReadings(prisma, {
    accountId: user.accountId, assetId, when: new Date('2024-01-01'), vendor: 'Test Lab',
    measurements: [
      { measurementType: 'contact_resistance', label: 'A-G', phase: 'A', asFoundValue: 100, asFoundUnit: 'µΩ' },
      { measurementType: 'contact_resistance', label: 'A-G', phase: 'B', asFoundValue: 100, asFoundUnit: 'µΩ' },
    ],
  });
  expect(baseline.deficienciesCreated).toBe(0); // no passFail, no prior yet -> nothing to flag

  // Follow-up commit: phase A trends +40% (bad direction: 'up'), phase B +20%.
  // Both exceed the 15% threshold and neither has a pass/fail verdict, so both
  // are trend candidates within the SAME point ('A-G') -- expect exactly one
  // trend deficiency, describing the steeper one (phase A).
  const followUp = await commitAssetReadings(prisma, {
    accountId: user.accountId, assetId, when: new Date('2025-01-01'), vendor: 'Test Lab',
    measurements: [
      { measurementType: 'contact_resistance', label: 'A-G', phase: 'A', asFoundValue: 140, asFoundUnit: 'µΩ' },
      { measurementType: 'contact_resistance', label: 'A-G', phase: 'B', asFoundValue: 120, asFoundUnit: 'µΩ' },
    ],
  });

  expect(followUp.measurementsCreated).toBe(2);
  expect(followUp.trendDeficiencies).toBe(1); // was 2 before the fix (one per reading)
  expect(followUp.deficienciesCreated).toBe(1);

  const defs = await prisma.deficiency.findMany({ where: { accountId: user.accountId, workOrderId: followUp.workOrderId } });
  expect(defs).toHaveLength(1);
  expect(defs[0].description).toContain('trending up');
  expect(defs[0].description).toContain('100->140'); // phase A, the steeper trend, wins
});
