/*
 * p5-cleanup-riverside-imports.js — remove the 3 test-report commits made
 * tonight (2026-07-22) against the Riverside SWGR2M asset BEFORE the P5
 * deficiency-grouping fix (commit b42cb0a) was live, so they can be
 * re-imported cleanly through the fixed commitAssetReadings().
 *
 *   node scripts/p5-cleanup-riverside-imports.js          # DIAGNOSE only (read-only)
 *   node scripts/p5-cleanup-riverside-imports.js cleanup  # delete the 3 WorkOrders
 *                                                          # (+ their TestMeasurement
 *                                                          # and Deficiency rows) and
 *                                                          # the matching ExtractionEvent
 *                                                          # audit rows
 *
 * Read-only by default: identifies WorkOrders whose `notes` contain the
 * ingest marker '[ingest:test_report]', created in the last 24h, and prints
 * them plus a summary of ALL Deficiency rows on the same asset(s) --
 * including any that PRE-DATE tonight's imports -- so a human can visually
 * confirm the pre-existing deficiency (e.g. "Severe overheating") is NOT
 * among the WorkOrders selected for deletion before running `cleanup`.
 *
 * `cleanup` deletes ONLY rows scoped to workOrderId IN (the 3 identified
 * WorkOrders): Deficiency, TestMeasurement, then the WorkOrder itself, all
 * inside one $transaction (all-or-nothing). It does NOT touch the Asset,
 * Site, or any other WorkOrder/Deficiency. It also deletes ExtractionEvent
 * rows whose committedAt falls in the same 24h window for the same account
 * (the account-wide "already imported" dedupe/audit table -- see
 * findPriorImport() in lib/extractionTelemetry.ts) so the same 3 PDFs can
 * be re-imported without a stale "already imported" banner.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');

const WINDOW_HOURS = 24;

(async () => {
  const prisma = new PrismaClient();
  try {
    const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);

    const targetWOs = await prisma.workOrder.findMany({
      where: { notes: { contains: '[ingest:test_report]' }, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, accountId: true, assetId: true, notes: true, createdAt: true, isAcceptanceTest: true,
        asset: { select: { serialNumber: true, manufacturer: true, model: true } },
      },
    });

    if (!targetWOs.length) {
      console.log('DIAG: no ingest:test_report WorkOrders found in the last ' + WINDOW_HOURS + 'h. Nothing to do.');
      return;
    }

    const assetIds = [...new Set(targetWOs.map((w) => w.assetId))];
    const targetIds = targetWOs.map((w) => w.id);

    console.log('DIAG: ' + targetWOs.length + ' candidate WorkOrder(s) for deletion (created >= ' + since.toISOString() + '):');
    for (const w of targetWOs) {
      const defCount = await prisma.deficiency.count({ where: { workOrderId: w.id } });
      const msCount = await prisma.testMeasurement.count({ where: { workOrderId: w.id } });
      console.log('  - ' + w.id + ' asset=' + (w.asset.serialNumber || w.asset.model || w.assetId)
        + ' created=' + w.createdAt.toISOString() + ' acceptanceTest=' + w.isAcceptanceTest
        + ' deficiencies=' + defCount + ' measurements=' + msCount);
    }

    console.log('\nDIAG: ALL deficiencies currently on the affected asset(s) (for a visual pre-existing-data check):');
    const allDefs = await prisma.deficiency.findMany({
      where: { assetId: { in: assetIds } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, workOrderId: true, severity: true, description: true, createdAt: true },
    });
    for (const d of allDefs) {
      const inTargetSet = targetIds.includes(d.workOrderId) ? '[WILL DELETE]' : '[keep -- not one of tonight\'s 3 imports]';
      console.log('  - ' + d.id + ' wo=' + d.workOrderId + ' sev=' + d.severity + ' ' + inTargetSet + ' :: ' + d.description.slice(0, 90));
    }

    const priorImports = await prisma.extractionEvent.findMany({
      where: { accountId: { in: [...new Set(targetWOs.map((w) => w.accountId))] }, committedAt: { gte: since } },
      select: { id: true, sha256: true, committedAt: true, originalName: true },
    });
    console.log('\nDIAG: ' + priorImports.length + ' ExtractionEvent audit row(s) in the same window (would also be deleted by cleanup).');

    if (process.argv[2] !== 'cleanup') {
      console.log('\nDIAG mode only -- re-run with "cleanup" argument to actually delete the ' + targetWOs.length
        + ' WorkOrder(s) above (and their Deficiency/TestMeasurement rows + the ' + priorImports.length + ' ExtractionEvent row(s)).');
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      const defDel = await tx.deficiency.deleteMany({ where: { workOrderId: { in: targetIds } } });
      const msDel = await tx.testMeasurement.deleteMany({ where: { workOrderId: { in: targetIds } } });
      const woDel = await tx.workOrder.deleteMany({ where: { id: { in: targetIds } } });
      const evDel = priorImports.length
        ? await tx.extractionEvent.deleteMany({ where: { id: { in: priorImports.map((e) => e.id) } } })
        : { count: 0 };
      return { defDel: defDel.count, msDel: msDel.count, woDel: woDel.count, evDel: evDel.count };
    });

    console.log('\nCLEANUP DONE: deleted ' + result.woDel + ' WorkOrder(s), ' + result.msDel + ' TestMeasurement(s), '
      + result.defDel + ' Deficiency row(s), ' + result.evDel + ' ExtractionEvent row(s).');

    const remaining = await prisma.deficiency.count({ where: { assetId: { in: assetIds } } });
    console.log('VERIFY: ' + remaining + ' deficiency row(s) remain on the affected asset(s) (should be exactly the pre-existing ones, e.g. 1).');
  } finally {
    await prisma.$disconnect();
  }
})();
