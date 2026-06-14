/**
 * ingestWorker.ts — #2 async ingest worker.
 *
 * Moves facility-scale document parsing off the HTTP request. An in-process
 * poller claims one queued IngestJob at a time with SELECT ... FOR UPDATE SKIP
 * LOCKED (so two ticks — or a future second replica — never grab the same row),
 * downloads the stored upload, runs the SHARED buffer->preview builder
 * (lib/testReportPreview) across the whole document, and stores the preview
 * `result` for the client to poll then review-and-commit.
 *
 * The builder is injectable (processNextIngestJob(builder)) so the queue
 * mechanics are testable without the Python parser / a real PDF.
 *
 * Single-droplet: in-process setInterval poll. No Redis. Stale claims (a crash
 * mid-job) are requeued by recoverStaleJobs on the next tick.
 */

'use strict';

const prisma = require('./prisma').default;
const { downloadFile } = require('./storage');

const MAX_ATTEMPTS = 3;
const STALE_MS = 5 * 60 * 1000; // a job 'processing' longer than this is presumed crashed
const POLL_MS = Number(process.env.INGEST_WORKER_POLL_MS || 4000);

// Atomically claim the oldest queued job. The single UPDATE ... WHERE id =
// (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) is race-free across concurrent
// callers. Returns the claimed job id or null.
async function claimNextJobId(): Promise<string | null> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `UPDATE "ingest_jobs"
       SET "status" = 'processing', "startedAt" = now(), "attempts" = "attempts" + 1, "updatedAt" = now()
     WHERE "id" = (
       SELECT "id" FROM "ingest_jobs"
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
 * Run one claimed job to a terminal state. `builder` is injectable for tests;
 * defaults to the shared test-report preview builder.
 */
async function runIngestJob(job: any, builder?: any): Promise<'done' | 'failed'> {
  const buildPreview = builder || require('./testReportPreview').buildTestReportPreview;
  try {
    await prisma.ingestJob.update({ where: { id: job.id }, data: { progress: 10, phase: 'reading file' } });
    const buffer = await downloadFile(job.fileKey);

    await prisma.ingestJob.update({ where: { id: job.id }, data: { progress: 40, phase: 'parsing' } });
    const result = await buildPreview(buffer, {
      accountId: job.targetAccountId || job.accountId,
      userId:    job.createdById || job.accountId,
      originalName: job.fileName || undefined,
    });

    await prisma.ingestJob.update({
      where: { id: job.id },
      data:  { status: 'done', progress: 100, phase: 'ready', result, error: null, finishedAt: new Date() },
    });

    // Best-effort completion breadcrumb (the "we'll notify you" hook). Never
    // fails the job.
    await prisma.activityLog.create({
      data: {
        accountId: job.accountId, userId: job.createdById || null,
        action: 'ingest_job_completed',
        details: { jobId: job.id, kind: job.kind, fileName: job.fileName, sections: (result as any)?.assetSections ?? 1 },
      },
    }).catch(() => {});
    return 'done';
  } catch (e: any) {
    const msg = e && e.message ? String(e.message).slice(0, 500) : 'ingest failed';
    // Retry by requeueing while attempts remain; otherwise fail terminally.
    const terminal = (job.attempts || 1) >= MAX_ATTEMPTS;
    await prisma.ingestJob.update({
      where: { id: job.id },
      data: terminal
        ? { status: 'failed', error: msg, phase: 'failed', finishedAt: new Date() }
        : { status: 'queued', error: msg, phase: 'retry pending', startedAt: null },
    });
    if (terminal) console.error(`[ingestWorker] job ${job.id} failed permanently:`, msg);
    return 'failed';
  }
}

/**
 * Claim + run the next queued job. Returns the job id processed, or null if the
 * queue was empty.
 */
async function processNextIngestJob(builder?: any): Promise<string | null> {
  const id = await claimNextJobId();
  if (!id) return null;
  const job = await prisma.ingestJob.findUnique({ where: { id } });
  if (!job) return null;
  await runIngestJob(job, builder);
  return id;
}

/**
 * Requeue jobs stuck in 'processing' past STALE_MS (worker crashed mid-job).
 * Past MAX_ATTEMPTS they go to 'failed' instead so a poison job can't loop.
 */
async function recoverStaleJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_MS);
  const stale = await prisma.ingestJob.findMany({
    where: { status: 'processing', startedAt: { lt: cutoff } },
    select: { id: true, attempts: true },
  });
  for (const j of stale) {
    await prisma.ingestJob.update({
      where: { id: j.id },
      data: (j.attempts || 0) >= MAX_ATTEMPTS
        ? { status: 'failed', error: 'stale claim — worker presumed crashed', finishedAt: new Date() }
        : { status: 'queued', phase: 'recovered', startedAt: null },
    }).catch(() => {});
  }
  return stale.length;
}

let _timer: any = null;
let _running = false;
// Liveness heartbeat — updated at the end of every tick. /api/ready reads it
// (getIngestWorkerStatus) so a silently-dead worker shows up as degraded
// instead of a green health check hiding a stalled ingest pipeline.
let _lastTickAt: Date | null = null;

/** Start the in-process poller. Idempotent. */
function startIngestWorker() {
  if (_timer) return;
  _lastTickAt = new Date(); // count "started" as the first heartbeat
  _timer = setInterval(async () => {
    if (_running) return; // never overlap ticks
    _running = true;
    try {
      await recoverStaleJobs();
      // Drain a small batch per tick so a backlog doesn't wait POLL_MS each.
      for (let i = 0; i < 5; i++) {
        const id = await processNextIngestJob();
        if (!id) break;
      }
    } catch (e: any) {
      console.error('[ingestWorker] tick error:', e && e.message ? e.message : e);
    } finally {
      _lastTickAt = new Date(); // a tick completed (even on error) — worker alive
      _running = false;
    }
  }, POLL_MS);
  if (_timer.unref) _timer.unref();
  console.log(`[ingestWorker] started — polling every ${POLL_MS}ms`);
}

function stopIngestWorker() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/**
 * Liveness snapshot for the readiness probe. `started` = the poller is
 * installed; `ageMs` = ms since the last completed tick (null if never run).
 * A large ageMs while started=true means the event loop or the tick is wedged.
 */
function getIngestWorkerStatus() {
  return {
    started:    !!_timer,
    lastTickAt: _lastTickAt,
    ageMs:      _lastTickAt ? (Date.now() - _lastTickAt.getTime()) : null,
    pollMs:     POLL_MS,
  };
}

module.exports = {
  claimNextJobId,
  runIngestJob,
  processNextIngestJob,
  recoverStaleJobs,
  startIngestWorker,
  stopIngestWorker,
  getIngestWorkerStatus,
  MAX_ATTEMPTS,
};

export {};
