/*
 * w17-cleanup-2025-baddate.js
 *
 * Tonight's Riverside 2025 NETA report import (via the Preview UI) committed
 * with the WRONG test date -- the "Date not found in report - please confirm"
 * field was left at its default (today, 2026-07-23) instead of being
 * corrected to the report's real date (2025-07-15), because it wasn't set
 * before clicking Commit. This creates a WorkOrder dated 2026-07-23 (today)
 * on the Riverside SWGR2M asset, plus its cascaded TestMeasurement rows and
 * (per the trend-comparison bug found in commitTestReport.ts -- priorByKey is
 * keyed by measurementType+phase only, with no label/sub-reading
 * discriminator, so all 3 insulation_resistance sub-readings [1-min, 10-min,
 * PI] per test point collide into one map slot) 9 bogus Advisory trend
 * deficiencies comparing mismatched sub-readings against each other.
 *
 * Default mode: READ-ONLY diagnose (prints the target WorkOrder + its
 * deficiency/measurement counts, and every deficiency on the asset so a human
 * can confirm scope before deleting).
 *
 * Pass "cleanup" as argv[2] to actually delete: the target WorkOrder + its
 * cascaded TestMeasurement + Deficiency rows + the matching ExtractionEvent
 * audit row. Scoped tightly to ONE WorkOrder id (looked up by asset +
 * ingest-tag + completedDate falling on today, 2026-07-23) -- never touches
 * the correctly-dated 2024 WorkOrder or the 2 pre-existing thermal
 * deficiencies (workOrderId: null).
 *
 *   node scripts/w17-cleanup-2025-baddate.js            # diagnose only
 *   node scripts/w17-cleanup-2025-baddate.js cleanup     # actually delete
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');

const ASSET_ID = '9b155c95-16e9-4b95-a97c-8a3c4a8940f6';
const BAD_DATE_START = new Date('2026-07-23T00:00:00.000Z');
const BAD_DATE_END = new Date('2026-07-24T00:00:00.000Z');
const doCleanup = process.argv[2] === 'cleanup';

(async () => {
  const prisma = new PrismaClient();
  try {
    const candidates = await prisma.workOrder.findMany({
      where: {
        assetId: ASSET_ID,
        notes: { contains: '[ingest:test_report]' },
        completedDate: { gte: BAD_DATE_START, lt: BAD_DATE_END },
      },
      select: { id: true, notes: true, scheduledDate: true, completedDate: true, isAcceptanceTest: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!candidates.length) {
      console.log('DIAG: no WorkOrder found on this asset with completedDate on 2026-07-23 -- nothing to clean up (already done, or never happened).');
      return;
    }

    console.log('DIAG: ' + candidates.length + ' candidate WorkOrder(s) with completedDate = 2026-07-23:');
    for (const w of candidates) {
      const msCount = await prisma.testMeasurement.count({ where: { workOrderId: w.id } });
      const defs = await prisma.deficiency.findMany({ where: { workOrderId: w.id }, select: { id: true, severity: true, description: true } });
      console.log('  - ' + w.id + ' completed=' + w.completedDate.toISOString() + ' isAcceptanceTest=' + w.isAcceptanceTest + ' measurements=' + msCount + ' deficiencies=' + defs.length);
      for (const d of defs) console.log('      [' + d.severity + '] ' + d.description.slice(0, 100));
    }

    if (!doCleanup) {
      console.log('\nDIAG: dry run only. Re-run with "cleanup" as the argument to delete the WorkOrder(s) above + their cascaded rows.');
      return;
    }

    for (const w of candidates) {
      const delDefs = await prisma.deficiency.deleteMany({ where: { workOrderId: w.id } });
      const delMeasurements = await prisma.testMeasurement.deleteMany({ where: { workOrderId: w.id } });
      await prisma.workOrder.delete({ where: { id: w.id } });
      console.log('CLEANUP: deleted WorkOrder ' + w.id + ' (' + delDefs.count + ' deficiencies, ' + delMeasurements.count + ' measurements). Note: ExtractionEvent has no workOrderId link, so its audit row (if any) is left in place -- harmless, informational only.');
    }
  } finally {
    await prisma.$disconnect();
  }
})();
