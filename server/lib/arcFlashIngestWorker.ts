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
// --- overall extraction wall-clock cap (Block B fix) -------------------------
// Each provider AI call is already bounded (see lib/ai PROVIDER_TIMEOUT_MS /
// PDF_TIMEOUT_MS), but a large multi-chunk PDF makes SEVERAL sequential calls,
// each of which can cascade across providers on timeout, so the AGGREGATE
// extraction has no bound of its own. Without a cap, one pathological document
// holds this single-flight, serial worker for many minutes and starves every
// other queued ingest (head-of-line blocking) -- and because stale-recovery
// runs inside the same _running-gated tick, it cannot intervene mid-flight.
// Cap one attempt below STALE_MS so a runaway fails fast, is surfaced (A2), and
// frees the worker. NOTE: this does not cancel the orphaned work (JS cannot kill
// a promise); the per-call timeouts wind it down while the worker moves on.
const EXTRACT_TIMEOUT_MS = Number(process.env.AF_INGEST_EXTRACT_TIMEOUT_MS) || 8 * 60 * 1000;

class ArcFlashIngestTimeout extends Error {
  constructor(ms: number) {
    super(`arc-flash extraction exceeded ${Math.round(ms / 1000)}s wall-clock cap`);
    this.name = 'ArcFlashIngestTimeout';
  }
}

// Reject with ArcFlashIngestTimeout if `work` has not settled within `ms`. Does
// not cancel `work`; attaches a handler so a late settle never becomes an
// unhandledRejection.
function withTimeout<T>(work: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { try { if (onTimeout) onTimeout(); } catch {} reject(new ArcFlashIngestTimeout(ms)); }, ms);
    work.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

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
    const _ac = new AbortController();
    await withTimeout(processArcFlashIngestExtraction(ingest, buffer, { extractor, signal: _ac.signal }), EXTRACT_TIMEOUT_MS, () => { try { _ac.abort(); } catch {} });
    return 'done';
  } catch (e: any) {
    const isTimeout = !!(e && e.name === 'ArcFlashIngestTimeout');
    const rawMsg = e && e.message ? String(e.message).slice(0, 500) : 'arc-flash ingest failed';
    // A timed-out attempt is TERMINAL, not requeued: re-running the same heavy
    // document would just time out again and re-starve the single-flight worker.
    const terminal = isTimeout || (ingest.attempts || 1) >= MAX_ATTEMPTS;
    const msg = isTimeout
      ? rawMsg + '. The document may be too large or complex to extract in one pass -- try splitting it into smaller PDFs.'
      : rawMsg;
    await prisma.arcFlashIngest.update({
      where: { id: ingest.id },
      data: terminal
        ? { status: 'failed', error: msg }
        : { status: 'queued', error: msg, startedAt: null },
    }).catch(() => {});
    if (terminal) console.error(`[arcFlashIngestWorker] ingest ${ingest.id} failed ${isTimeout ? '(timeout)' : 'permanently'}:`, msg);
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
