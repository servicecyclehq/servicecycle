/*
 * p5-diagnose-riverside-imports.js — READ-ONLY report only. Contains no
 * delete/update/transaction code anywhere in this file.
 *
 * Identifies the WorkOrders created by tonight's (2026-07-22) 3 test-report
 * imports against the Riverside SWGR2M demo asset (committed before the P5
 * deficiency-grouping fix, commit b42cb0a, was live) and prints, for each:
 * id, asset, created time, deficiency count, measurement count -- plus a
 * full dump of every Deficiency currently on the affected asset(s) so a
 * human can visually confirm which ones pre-date tonight's imports.
 *
 *   node scripts/p5-diagnose-riverside-imports.js
 *
 * See p5-cleanup-riverside-imports.js (separate file) for the script that
 * actually performs the deletion once this report has been reviewed.
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
      console.log('DIAG: no ingest:test_report WorkOrders found in the last ' + WINDOW_HOURS + 'h.');
      return;
    }

    const assetIds = [...new Set(targetWOs.map((w) => w.assetId))];
    const targetIds = targetWOs.map((w) => w.id);

    console.log('DIAG: ' + targetWOs.length + ' candidate WorkOrder(s) (created >= ' + since.toISOString() + '):');
    for (const w of targetWOs) {
      const defCount = await prisma.deficiency.count({ where: { workOrderId: w.id } });
      const msCount = await prisma.testMeasurement.count({ where: { workOrderId: w.id } });
      console.log('  - ' + w.id + ' asset=' + (w.asset.serialNumber || w.asset.model || w.assetId)
        + ' created=' + w.createdAt.toISOString() + ' acceptanceTest=' + w.isAcceptanceTest
        + ' deficiencies=' + defCount + ' measurements=' + msCount);
    }

    console.log('\nDIAG: ALL deficiencies currently on the affected asset(s):');
    const allDefs = await prisma.deficiency.findMany({
      where: { assetId: { in: assetIds } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, workOrderId: true, severity: true, description: true, createdAt: true },
    });
    for (const d of allDefs) {
      const inTargetSet = targetIds.includes(d.workOrderId) ? '[one of tonight\'s 3 imports]' : '[PRE-EXISTING -- keep]';
      console.log('  - ' + d.id + ' wo=' + d.workOrderId + ' sev=' + d.severity + ' ' + inTargetSet + ' :: ' + d.description.slice(0, 90));
    }

    const priorImports = await prisma.extractionEvent.findMany({
      where: { accountId: { in: [...new Set(targetWOs.map((w) => w.accountId))] }, committedAt: { gte: since } },
      select: { id: true, sha256: true, committedAt: true },
    });
    console.log('\nDIAG: ' + priorImports.length + ' ExtractionEvent audit row(s) in the same window.');
    console.log('\nDIAG: total deficiency count on asset(s) currently: ' + allDefs.length
      + ' (pre-existing: ' + (allDefs.length - allDefs.filter((d) => targetIds.includes(d.workOrderId)).length)
      + ', from tonight\'s imports: ' + allDefs.filter((d) => targetIds.includes(d.workOrderId)).length + ')');
  } finally {
    await prisma.$disconnect();
  }
})();
