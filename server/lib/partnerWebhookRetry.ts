export {};
/**
 * Partner Flywheel — webhook retry cron (every 15 minutes).
 *
 * Finds PartnerEventLog records where:
 *   - webhookSentAt IS NULL        (never successfully delivered)
 *   - webhookAttempts < 3          (not yet exhausted)
 *   - partnerOrg.webhookUrl IS NOT NULL
 *   - Exponential backoff: webhookLastFailedAt < NOW() - (5min * 2^webhookAttempts)
 *     attempt 0 (first try) — no backoff required (webhookLastFailedAt IS NULL)
 *     attempt 1 — retry after 5 min
 *     attempt 2 — retry after 10 min
 *     attempt 3 — retry after 20 min (then give up, attempts = 3)
 *
 * On final failure (attempt 3 reached), logs a warning and leaves the record.
 */

const { createHmac } = require('crypto');
const prisma = require('./prisma').default;

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

interface RetryResult {
  checked: number;
  succeeded: number;
  failed: number;
  exhausted: number;
}

async function runWebhookRetryCron(): Promise<RetryResult> {
  let succeeded = 0;
  let failed = 0;
  let exhausted = 0;

  const now = new Date();

  // Find all candidates — records that haven't been delivered and aren't exhausted.
  // We load partnerOrg inline to get webhookUrl + webhookSecret.
  const candidates = await prisma.partnerEventLog.findMany({
    where: {
      webhookSentAt: null,
      webhookAttempts: { lt: MAX_ATTEMPTS },
      partnerOrg: { webhookUrl: { not: null } },
    },
    include: {
      partnerOrg: {
        select: {
          id: true,
          webhookUrl: true,
          webhookSecret: true,
        },
      },
      assignedRep: { select: { email: true } },
    },
  });

  const eligible = candidates.filter((log: any) => {
    if (!log.partnerOrg?.webhookUrl) return false;
    // First attempt (no previous failure): always eligible.
    if (!log.webhookLastFailedAt) return true;
    // Exponential backoff: must wait (5min * 2^attempts) since last failure.
    const backoffMs = BASE_BACKOFF_MS * Math.pow(2, log.webhookAttempts - 1);
    const retryAfter = new Date(log.webhookLastFailedAt.getTime() + backoffMs);
    return now >= retryAfter;
  });

  for (const log of eligible) {
    const partnerOrg = log.partnerOrg;

    const body = JSON.stringify({
      partnerId:        partnerOrg.id,
      eventType:        log.eventType,
      accountId:        log.accountId,
      assignedRepEmail: log.assignedRep?.email ?? null,
      timestamp:        log.createdAt,
      data:             log.payload,
    });

    const sig = createHmac('sha256', partnerOrg.webhookSecret ?? '').update(body).digest('hex');

    try {
      const resp = await fetch(partnerOrg.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ServiceCycle-Signature': `sha256=${sig}`,
        },
        body,
        signal: AbortSignal.timeout(5000),
      });

      if (resp.ok) {
        await prisma.partnerEventLog.update({
          where: { id: log.id },
          data: { webhookSentAt: new Date() },
        });
        succeeded++;
      } else {
        const newAttempts = log.webhookAttempts + 1;
        await prisma.partnerEventLog.update({
          where: { id: log.id },
          data: {
            webhookAttempts:     newAttempts,
            webhookLastFailedAt: new Date(),
          },
        });
        if (newAttempts >= MAX_ATTEMPTS) {
          console.warn(
            `[webhookRetry] Log ${log.id} exhausted ${MAX_ATTEMPTS} attempts (last HTTP ${resp.status}). Giving up.`
          );
          exhausted++;
        } else {
          failed++;
        }
      }
    } catch (err: any) {
      const newAttempts = log.webhookAttempts + 1;
      await prisma.partnerEventLog.update({
        where: { id: log.id },
        data: {
          webhookAttempts:     newAttempts,
          webhookLastFailedAt: new Date(),
        },
      });
      if (newAttempts >= MAX_ATTEMPTS) {
        console.warn(
          `[webhookRetry] Log ${log.id} exhausted ${MAX_ATTEMPTS} attempts (${err.message}). Giving up.`
        );
        exhausted++;
      } else {
        failed++;
      }
    }
  }

  return { checked: eligible.length, succeeded, failed, exhausted };
}

module.exports = { runWebhookRetryCron };
