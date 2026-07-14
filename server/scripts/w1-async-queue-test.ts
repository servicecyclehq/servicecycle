'use strict';
export {}; // module-scope marker so tsc doesn't treat this script as global
/**
 * W1 async queue reliability check — DB-only, NO AI. Exercises the arc-flash
 * ingest worker's reliability contract against the dev DB with a stub extractor:
 *   1. claim race-safety (FOR UPDATE SKIP LOCKED) — concurrent claims never
 *      grab the same row
 *   2. idempotent persist — reprocessing (a retry) doesn't double-write buses
 *   3. soft 0-bus result -> terminal 'failed' (not thrown)
 *   4. stale-crash recovery — a row stuck 'processing' is requeued, and one at
 *      MAX_ATTEMPTS goes terminal 'failed' (poison-proof)
 * Self-cleaning (removes its own rows before and after).
 * Usage: npx tsx scripts/w1-async-queue-test.ts   (exit 0 = PASS)
 */
try { require('dotenv').config(); } catch { /* optional */ }
const prisma = require('../lib/prisma').default;
const { claimNextIngestId, recoverStaleArcFlashIngests, MAX_ATTEMPTS } = require('../lib/arcFlashIngestWorker');
const { processArcFlashIngestExtraction } = require('../lib/arcFlashIngestProcess');

const TAG = 'W1ASYNCTEST';

function stubExtractor(nBuses: number) {
  return async () => ({
    method: 'stub', aiProvider: 'stub', promptVersion: 'stub', systemMeta: {}, rawJsonText: '',
    warnings: nBuses ? [] : ['no buses'],
    buses: Array.from({ length: nBuses }, (_, i) => ({
      busName: `STUB-BUS-${i + 1}`, equipmentTypeGuess: 'SWITCHGEAR', nominalVoltage: '480V',
      boltedFaultCurrentKA: 25, clearingTimeMs: 100,
    })),
  });
}

async function cleanup() {
  const rows = await prisma.arcFlashIngest.findMany({ where: { fileName: `${TAG}.pdf` }, select: { id: true } });
  const ids = rows.map((r: any) => r.id);
  if (ids.length) {
    await prisma.arcFlashIngestBus.deleteMany({ where: { ingestId: { in: ids } } });
    await prisma.arcFlashIngest.deleteMany({ where: { id: { in: ids } } });
  }
}

(async () => {
  let ok = true;
  const log: string[] = [];
  const acct = await prisma.account.findFirst({ select: { id: true } });
  const site = acct ? await prisma.site.findFirst({ where: { accountId: acct.id }, select: { id: true } }) : null;
  if (!acct || !site) { console.error('need a seeded account+site in the dev DB'); process.exit(2); }
  const mk = (status: string) => prisma.arcFlashIngest.create({
    data: { accountId: acct.id, siteId: site.id, sourceType: 'study_report', fileName: `${TAG}.pdf`, mimeType: 'application/pdf', status },
  });

  await cleanup(); // clear any residue from a crashed prior run

  try {
    // 1) Claim race-safety: two queued rows, concurrent claims => two distinct ids.
    const a = await mk('queued');
    const b = await mk('queued');
    const [c1, c2] = await Promise.all([claimNextIngestId(), claimNextIngestId()]);
    if (c1 && c2 && c1 !== c2 && [a.id, b.id].includes(c1) && [a.id, b.id].includes(c2)) log.push('ok   concurrent claims returned two DISTINCT queued rows (FOR UPDATE SKIP LOCKED)');
    else { ok = false; log.push(`FAIL concurrent claim: c1=${c1} c2=${c2} (expected the two distinct test rows)`); }
    const claimedA = await prisma.arcFlashIngest.findUnique({ where: { id: a.id }, select: { status: true, attempts: true, startedAt: true } });
    if (claimedA.status === 'processing' && claimedA.attempts === 1 && claimedA.startedAt) log.push('ok   claimed row -> processing, attempts=1, startedAt set');
    else { ok = false; log.push(`FAIL claimed row state: ${JSON.stringify(claimedA)}`); }

    // 2) Idempotent persist: process the SAME ingest twice => bus count stays 3.
    const p = await mk('processing');
    const pFull = await prisma.arcFlashIngest.findUnique({ where: { id: p.id } });
    await processArcFlashIngestExtraction(pFull, Buffer.from('x'), { extractor: stubExtractor(3) });
    const n1 = await prisma.arcFlashIngestBus.count({ where: { ingestId: p.id } });
    await processArcFlashIngestExtraction(pFull, Buffer.from('x'), { extractor: stubExtractor(3) });
    const n2 = await prisma.arcFlashIngestBus.count({ where: { ingestId: p.id } });
    const pSt = await prisma.arcFlashIngest.findUnique({ where: { id: p.id }, select: { status: true, totalBusCount: true } });
    if (n1 === 3 && n2 === 3 && pSt.status === 'needs_review') log.push('ok   idempotent persist: 3 buses after 1st AND 2nd run (no doubling), status needs_review');
    else { ok = false; log.push(`FAIL persist idempotency: n1=${n1} n2=${n2} status=${pSt.status}`); }

    // 3) Soft 0-bus result => terminal 'failed' (not thrown).
    const z = await mk('processing');
    const zFull = await prisma.arcFlashIngest.findUnique({ where: { id: z.id } });
    await processArcFlashIngestExtraction(zFull, Buffer.from('x'), { extractor: stubExtractor(0) });
    const zSt = await prisma.arcFlashIngest.findUnique({ where: { id: z.id }, select: { status: true } });
    if (zSt.status === 'failed') log.push('ok   0-bus extraction -> status failed (terminal, no throw)');
    else { ok = false; log.push(`FAIL 0-bus status: ${zSt.status}`); }

    // 4) Stale recovery: old 'processing' => requeued; at MAX_ATTEMPTS => failed.
    const stale = await mk('processing');
    await prisma.arcFlashIngest.update({ where: { id: stale.id }, data: { startedAt: new Date(Date.now() - 60 * 60 * 1000), attempts: 1 } });
    const poison = await mk('processing');
    await prisma.arcFlashIngest.update({ where: { id: poison.id }, data: { startedAt: new Date(Date.now() - 60 * 60 * 1000), attempts: MAX_ATTEMPTS } });
    await recoverStaleArcFlashIngests();
    const sSt = await prisma.arcFlashIngest.findUnique({ where: { id: stale.id }, select: { status: true } });
    const poSt = await prisma.arcFlashIngest.findUnique({ where: { id: poison.id }, select: { status: true } });
    if (sSt.status === 'queued') log.push('ok   stale processing row requeued -> queued');
    else { ok = false; log.push(`FAIL stale not requeued: ${sSt.status}`); }
    if (poSt.status === 'failed') log.push('ok   stale row at MAX_ATTEMPTS -> failed (poison-proof)');
    else { ok = false; log.push(`FAIL poison not failed: ${poSt.status}`); }
  } finally {
    await cleanup();
  }

  console.log(log.join('\n'));
  console.log(ok ? '\nRESULT: PASS' : '\nRESULT: FAIL');
  await prisma.$disconnect();
  process.exit(ok ? 0 : 1);
})().catch(async (e) => { console.error('TEST ERROR:', e && e.message ? e.message : e); try { await prisma.$disconnect(); } catch { /* noop */ } process.exit(2); });
