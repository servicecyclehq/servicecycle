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

// Default landing site for an auto-commit (email-in) job when the job carries no
// explicit siteId: the account's oldest non-archived site.
async function _firstSiteId(accountId: string): Promise<string | null> {
  const s = await prisma.site.findFirst({
    where: { accountId, archivedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return s ? s.id : null;
}

// Per-account auto-commit confidence floor (the tunable knob). Undefined falls
// back to the gate's conservative default.
async function _autoCommitThreshold(accountId: string): Promise<any> {
  try {
    const s = await prisma.accountSetting.findFirst({
      where: { accountId, key: 'ingest_autocommit_threshold' }, select: { value: true },
    });
    return s?.value ?? undefined;
  } catch { return undefined; }
}

// Post-gate hook: for an email-in job, once the whole inbound message is gated,
// send the sender the outcome ack. Best-effort and never blocks the job; the
// ack module aggregates per batch and fires exactly once.
async function _afterGated(job: any): Promise<void> {
  if (job.kind !== 'email_in') return;
  try {
    const { maybeSendInboundAck } = require('./ingestAck');
    await maybeSendInboundAck(job);
  } catch { /* ack never blocks the job */ }
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
    // 2026-07-05 (§11 A2 Half 1 + Half 2, Option A per Dustin): pass the last
    // confirmed-good page from a prior attempt as a `resumeFrom` hint. As of
    // Half 2 this reaches run.py (--resume-from) and extract_fields(), but per
    // the Option-A design it does NOT skip pages or merge partial state --
    // every attempt still re-reads the whole document from page 1 (see
    // extract_fields()'s docstring in pyextract/extractor.py for the full
    // rationale). What DOES change: extract_fields() now catches a per-page
    // exception instead of losing all prior pages' work when one page throws,
    // so a retry has a real floor to improve on. The hint itself is threaded
    // through purely for retry observability (logged here, echoed back as
    // `resumed_from` in the parser output).
    if (job.lastGoodPage != null) {
      console.log(`[ingestWorker] job ${job.id}: resumeFrom=${job.lastGoodPage} (retry attempt; full re-read, no page-skip -- see extract_fields() docstring)`);
    }
    const result = await buildPreview(buffer, {
      accountId: job.targetAccountId || job.accountId,
      userId:    job.createdById || job.accountId,
      originalName: job.fileName || undefined,
      resumeFrom: job.lastGoodPage ?? undefined,
    });

    // 2026-07-07 (overnight capture-gap fix): pull rawText out of the preview
    // object into its own variable BEFORE it's stored — it belongs in the new
    // dedicated IngestJob.rawText column (see schema comment), not duplicated
    // inside `result`, which is what the polling UI fetches on every request.
    const extractedRawText: string | null = (result as any)?.rawText ?? null;
    delete (result as any).rawText;

    // Confidence gate (email-in / backfill, i.e. hands-off autoCommit jobs).
    // High-confidence parses auto-commit; anything below the bar is parked as
    // needs_review so a human approves before any asset card is written.
    let gate: any = null;
    if (job.autoCommit) {
      try {
        const { evaluateIngestGate } = require('./ingestConfidenceGate');
        const threshold = await _autoCommitThreshold(job.accountId);
        gate = evaluateIngestGate(result, { threshold, originalName: job.fileName || undefined });
        (result as any).gate = gate;
      } catch (ge: any) {
        // If the gate itself errors, fail safe: park for review rather than
        // auto-committing something we couldn't score.
        gate = { autoCommit: false, band: 'yellow', reasons: ['Could not score confidence — review before committing.'], units: [] };
        console.error(`[ingestWorker] gate error for job ${job.id}:`, ge && ge.message ? ge.message : ge);
      }
    }

    // Parked: store the preview + gate, write NO assets, and stop here.
    if (job.autoCommit && gate && !gate.autoCommit) {
      await prisma.ingestJob.update({
        where: { id: job.id },
        data: { status: 'needs_review', gate, progress: 100, phase: 'awaiting review', result, rawText: extractedRawText, error: null, finishedAt: new Date() },
      });
      await prisma.activityLog.create({
        data: {
          accountId: job.accountId, userId: null, action: 'ingest_job_needs_review',
          details: { jobId: job.id, kind: job.kind, fileName: job.fileName, band: gate.band, reasons: (gate.reasons || []).slice(0, 5) },
        },
      }).catch(() => {});
      await _afterGated(job);
      return 'done';
    }

    // Auto-commit (gate green) — straight to asset cards. Best-effort: a commit
    // failure annotates the result but the job still completes.
    if (job.autoCommit) {
      try {
        await prisma.ingestJob.update({ where: { id: job.id }, data: { progress: 70, phase: 'creating asset cards' } });
        const siteId = job.siteId || await _firstSiteId(job.targetAccountId || job.accountId);
        if (!siteId) throw new Error('no site available to place inbound assets');
        const { commitPreviewSections } = require('./commitTestReport');
        const committed = await commitPreviewSections({
          accountId: job.targetAccountId || job.accountId, siteId,
          preview: result, originalName: job.fileName || undefined,
        });
        (result as any).autoCommitted = committed;
        try {
          const immediate = (committed.sections || []).reduce((n: number, s: any) => n + (s.deficiencyBySeverity?.IMMEDIATE || 0), 0);
          const { notifyReportIngested } = require('./loopNotify');
          notifyReportIngested(job.accountId, {
            readings: committed.measurementsCreated, deficiencies: committed.deficienciesCreated,
            immediate, assetLabel: `${committed.assetsCommitted} asset(s) from email`, assetId: null,
          }).catch(() => {});
        } catch { /* notify never blocks the job */ }
      } catch (ce: any) {
        (result as any).autoCommitError = ce && ce.message ? String(ce.message).slice(0, 300) : 'auto-commit failed';
        console.error(`[ingestWorker] auto-commit failed for job ${job.id}:`, (result as any).autoCommitError);
      }
    }

    // 2026-07-05 (§11 A2 Half 1 + Half 2): record the checkpoint so a retry's
    // resumeFrom hint (and operator visibility into how much of a large
    // document was actually read) has real data. `pageCount` is `null` when
    // the extractor didn't report a page count (e.g. the pdfjs fallback
    // path); in that case leave the checkpoint fields null rather than
    // writing a misleading 0/undefined.
    //
    // Half-2 correctness fix: this used to record `lastGoodPage: totalPages`
    // (the document's full page count) on every success, which was only
    // truthful because pre-Half-2 a per-page exception always took the
    // FAILURE branch below -- reaching this success branch implied every
    // page was scanned. Now that extract_fields() catches a per-page
    // exception and still returns normally (see its docstring), a job can
    // land here `truncated` with `pagesScanned < pageCount` (page_error set).
    // Recording `pagesScanned` instead of the raw page count keeps
    // `lastGoodPage` honest in that case; the two values are identical in
    // every case that completes without a page-level error, so this is a
    // strict correctness improvement with no behavior change for the
    // already-passing path.
    const totalPages = (result as any)?.pageCount ?? null;
    const pagesScanned = (result as any)?.pagesScanned ?? totalPages;
    const checkpoint = totalPages != null
      ? {
          lastGoodPage: pagesScanned,
          pageProgress: {
            totalPages, pagesCompleted: pagesScanned,
            lastError: (result as any)?.pageError ?? null,
            truncated: !!(result as any)?.truncated,
          },
        }
      : {};

    await prisma.ingestJob.update({
      where: { id: job.id },
      data:  { status: 'done', progress: 100, phase: 'ready', result, rawText: extractedRawText, gate: gate || undefined, error: null, finishedAt: new Date(), ...checkpoint },
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
    await _afterGated(job);
    return 'done';
  } catch (e: any) {
    const msg = e && e.message ? String(e.message).slice(0, 500) : 'ingest failed';
    // Retry by requeueing while attempts remain; otherwise fail terminally.
    const terminal = (job.attempts || 1) >= MAX_ATTEMPTS;
    // 2026-07-05 (§11 A2 Half 1): best-effort checkpoint on failure. The
    // extractor doesn't yet report a partial page count on a thrown
    // exception (that plumbing is Half 2), so `lastGoodPage` is left exactly
    // as it was on this job -- i.e. whatever a PRIOR successful attempt
    // already recorded, never overwritten with a guess. `pageProgress.lastError`
    // is still recorded so a future polling UI has something to show even
    // when the resume checkpoint itself can't move.
    const pageProgress = { lastError: msg };
    await prisma.ingestJob.update({
      where: { id: job.id },
      data: terminal
        ? { status: 'failed', error: msg, phase: 'failed', finishedAt: new Date(), pageProgress }
        : { status: 'queued', error: msg, phase: 'retry pending', startedAt: null, pageProgress },
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
  // Note: do NOT call _timer.unref() — that would allow Node to exit while jobs are queued.
  // In tests, call stopIngestWorker() explicitly instead.
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
