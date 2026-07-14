/**
 * lib/arcFlashIngestWorker.ts — async arc-flash ingest worker (W1 part 2).
 *
 * Native-PDF arc-flash extraction runs 50-150s (a chunked large report is
 * several native calls), far too long to hold an HTTP request open. This
 * in-process poller claims one queued ArcFlashIngest at a time with
 * SELECT ... FOR UPDATE SKIP LOCKED (race-safe now, replica-safe later),
 * downloads the stored source file, runs the shared extract+persist step
 * (arcFlashIngestProcess), and flips the row's status so the client's poll
 * (GET /api/arc-flash/ingest/:id) shows the draft.
 *
 * Mirrors lib/ingestWorker's reliability contract: attempt cap (poison jobs go
 * terminal, not loop), stale-crash recovery (a row stuck 'processing' past
 * STALE_MS is requeued), single-flight ticks, and a liveness heartbeat. The
 * extractor is injectable so the queue mechanics are testable without a real
 * Gemini call.
 *
 * Single-droplet: in-process setInterval poll, no Redis. STALE_MS is set well
 * above the longest realistic chunked extraction so a slow-but-alive job is
 * never yanked out from under itself.
 */

'use strict';

const prisma = require('./prisma').default;
const { downloadFile } = require('./storage');
const { processArcFlashIngestExtraction } = require('./arcFlashIngestProcess');

const MAX_ATTEMPTS = Number(process.env.AF_INGEST_MAX_ATTEMPTS) || 3;
// A native chunked extraction can take a few minutes; only presume a crash well
// past that so we never requeue a job that is merely slow.
const STALE_MS = Number(process.env.AF_INGEST_STALE_MS) || 12 * 60 * 1000;
const POLL_MS = Number(process.env.AF_INGEST_WORKER_POLL_MS || process.env.INGEST_WORKER_POLL_MS || 4000);

// Atomically claim the oldest queued ingest. The single UPDATE ... WHERE id =
// (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) is race-free across concurrent
// ticks or a future second replica. Returns the claimed id or null.
async function claimNextIngestId(): Promise<string | null> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `UPDATE "arc_flash_ingests"
       SET "status" = 'processing', "startedAt" = now(), "attempts" = "attempts" + 1, "updatedAt" = now()
     WHERE "id" = (
       SELECT "id" FROM "arc_flash_ingests"
        WHERE "status" = 'queued'
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING "id"`,
  );
  return rows && rows.length ? rows[0].id : null;
}

/**
 * Run one claimed ingest to a terminal state. On a hard failure, requeue while
 * attempts remain (transient AI/network flake), else fail terminally. The
 * per-bus persist inside processArcFlashIngestExtraction is idempotent, so a
 * requeued retry cleanly overwrites any partial prior attempt.
 */
async function runArcFlashIngest(ingest: any, extractor?: any): Promise<'done' | 'failed'> {
  try {
    if (!ingest.fileKey) throw new Error('ingest has no stored fileKey — cannot process asynchronously');
    const buffer = await downloadFile(ingest.fileKey, ingest.accountId);
    await processArcFlashIngestExtraction(ingest, buffer, { extractor });
    return 'done';
  } catch (e: any) {
    const msg = e && e.message ? String(e.message).slice(0, 500) : 'arc-flash ingest failed';
    const terminal = (ingest.attempts || 1) >= MAX_ATTEMPTS;
    await prisma.arcFlashIngest.update({
      where: { id: ingest.id },
      data: terminal
        ? { status: 'failed', error: msg }
        : { status: 'queued', error: msg, startedAt: null },
    }).catch(() => {});
    if (terminal) console.error(`[arcFlashIngestWorker] ingest ${ingest.id} failed permanently:`, msg);
    return 'failed';
  }
}

/** Claim + run the next queued ingest. Returns the id processed, or null when the queue is empty. */
async function processNextArcFlashIngest(extractor?: any): Promise<string | null> {
  const id = await claimNextIngestId();
  if (!id) return null;
  const ingest = await prisma.arcFlashIngest.findUnique({ where: { id } });
  if (!ingest) return null;
  await runArcFlashIngest(ingest, extractor);
  return id;
}

/** Requeue ingests stuck in 'processing' past STALE_MS (worker crashed mid-extraction). */
async function recoverStaleArcFlashIngests(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_MS);
  const stale = await prisma.arcFlashIngest.findMany({
    where: { status: 'processing', startedAt: { lt: cutoff } },
    select: { id: true, attempts: true },
  });
  for (const j of stale) {
    await prisma.arcFlashIngest.update({
      where: { id: j.id },
      data: (j.attempts || 0) >= MAX_ATTEMPTS
        ? { status: 'failed', error: 'stale claim — worker presumed crashed mid-extraction' }
        : { status: 'queued', startedAt: null },
    }).catch(() => {});
  }
  return stale.length;
}

let _timer: any = null;
let _running = false;
let _lastTickAt: Date | null = null;

/** Start the in-process poller. Idempotent. */
function startArcFlashIngestWorker() {
  if (_timer) return;
  _lastTickAt = new Date();
  _timer = setInterval(async () => {
    if (_running) return; // never overlap ticks
    _running = true;
    try {
      await recoverStaleArcFlashIngests();
      // Drain a small batch per tick so a short backlog doesn't wait POLL_MS each.
      for (let i = 0; i < 3; i++) {
        const id = await processNextArcFlashIngest();
        if (!id) break;
      }
    } catch (e: any) {
      console.error('[arcFlashIngestWorker] tick error:', e && e.message ? e.message : e);
    } finally {
      _lastTickAt = new Date();
      _running = false;
    }
  }, POLL_MS);
  console.log(`[arcFlashIngestWorker] started — polling every ${POLL_MS}ms`);
}

function stopArcFlashIngestWorker() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/** Liveness snapshot for the readiness probe (same shape as ingestWorker). */
function getArcFlashIngestWorkerStatus() {
  return {
    started: !!_timer,
    lastTickAt: _lastTickAt,
    ageMs: _lastTickAt ? (Date.now() - _lastTickAt.getTime()) : null,
    pollMs: POLL_MS,
  };
}

module.exports = {
  claimNextIngestId,
  runArcFlashIngest,
  processNextArcFlashIngest,
  recoverStaleArcFlashIngests,
  startArcFlashIngestWorker,
  stopArcFlashIngestWorker,
  getArcFlashIngestWorkerStatus,
  MAX_ATTEMPTS,
};

export {};
