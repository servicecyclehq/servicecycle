/**
 * lib/ingestAck.ts — post-parse acknowledgement for email-in reports.
 *
 * The old flow acked the sender at receipt, before we knew anything about the
 * report. Now the ack waits until the whole inbound message has been parsed and
 * gated, so it can tell the sender the truth:
 *   - everything committed cleanly        -> reportProcessedHtml  ("uploaded for your review")
 *   - some items were parked for review   -> reportNeedsReviewHtml ("a few need a check first")
 *
 * One inbound email can fan out into several IngestJobs (one per attachment);
 * they share a `batchId`. The ack fires once per batch, claimed atomically via
 * ackSentAt so a second worker tick (or replica) can't double-send.
 */

'use strict';

const prisma = require('./prisma').default;
const { sendEmail, reportProcessedHtml, reportNeedsReviewHtml } = require('./email');

// A job is still in flight (not yet gated) in these states.
const IN_FLIGHT = ['queued', 'processing'];

async function maybeSendInboundAck(job: any): Promise<void> {
  const batchId = job?.batchId;
  if (!batchId) return;

  // Wait until every job from this inbound message has reached a gated terminal
  // state (done / needs_review / failed / rejected).
  const inFlight = await prisma.ingestJob.count({ where: { batchId, status: { in: IN_FLIGHT } } });
  if (inFlight > 0) return;

  // Claim the ack for the whole batch in one atomic UPDATE. The first caller
  // sets ackSentAt on every still-null row and gets affected>0; a concurrent
  // caller re-evaluates the WHERE after the row locks release, matches nothing,
  // and bails — so the ack is sent exactly once.
  const affected: number = await prisma.$executeRawUnsafe(
    `UPDATE "ingest_jobs" SET "ackSentAt" = now() WHERE "batchId" = $1 AND "ackSentAt" IS NULL`,
    batchId,
  );
  if (!affected) return; // already claimed/sent

  const one = await prisma.ingestJob.findFirst({ where: { batchId }, select: { notifyEmail: true, accountId: true } });
  const notifyEmail = one?.notifyEmail || null;
  if (!notifyEmail) return; // no-reply / unattended sender

  // Aggregate the batch outcome.
  const jobs = await prisma.ingestJob.findMany({ where: { batchId }, select: { status: true, result: true } });
  let committed = 0, review = 0, assetCount = 0;
  for (const j of jobs as any[]) {
    if (j.status === 'needs_review') review++;
    else if (j.status === 'done') {
      committed++;
      const ac = j.result && j.result.autoCommitted;
      if (ac && typeof ac.assetsCommitted === 'number') assetCount += ac.assetsCommitted;
    }
  }
  if (committed === 0 && review === 0) return; // nothing usable (all failed) — don't send a misleading ack

  const acct = await prisma.account.findUnique({ where: { id: one!.accountId }, select: { companyName: true } }).catch(() => null);
  const appUrl = process.env.CLIENT_URL || 'https://servicecycle.app';

  try {
    if (review > 0) {
      await sendEmail({
        to: notifyEmail,
        subject: 'Your report needs a quick review — ServiceCycle',
        html: reportNeedsReviewHtml({ companyName: acct?.companyName, appUrl, committedCount: committed, reviewCount: review }),
      });
    } else {
      await sendEmail({
        to: notifyEmail,
        subject: 'We received your test report — ServiceCycle',
        html: reportProcessedHtml({ companyName: acct?.companyName, appUrl, assetCount }),
      });
    }
  } catch (e: any) {
    console.warn('[ingestAck] send failed:', e && e.message ? e.message : e);
  }
}

module.exports = { maybeSendInboundAck };

export {};
