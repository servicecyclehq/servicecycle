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

const { randomUUID } = require('crypto');
const prisma = require('./prisma').default;
const { postJsonToValidatedUrl, signPayload } = require('./webhook');

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

    // [2026-07-06 fallback-masks-capture fix] `webhookSecret ?? ''` let a
    // missing secret silently sign with an EMPTY string instead of refusing
    // delivery -- an attacker who somehow blanked webhookSecret (or a data
    // issue that nulled it) would get a "valid-looking" signature the
    // receiving end could trivially forge/verify against a known empty key.
    // firePartnerWebhook (lib/partnerEvents.ts) already guards this; this
    // cron path didn't. Skip (not "failed", since retrying won't help until
    // an admin re-sets the secret via the settings PATCH, which always
    // rotates a real one) and record the same failure bookkeeping.
    if (!partnerOrg.webhookSecret) {
      console.warn(`[webhookRetry] Log ${log.id} skipped: partner org ${partnerOrg.id} has no webhookSecret configured.`);
      const newAttempts = log.webhookAttempts + 1;
      await prisma.partnerEventLog.update({
        where: { id: log.id },
        data: { webhookAttempts: newAttempts, webhookLastFailedAt: new Date() },
      });
      if (newAttempts >= MAX_ATTEMPTS) exhausted++; else failed++;
      continue;
    }

    const body = JSON.stringify({
      partnerId:        partnerOrg.id,
      eventType:        log.eventType,
      accountId:        log.accountId,
      assignedRepEmail: log.assignedRep?.email ?? null,
      timestamp:        log.createdAt,
      data:             log.payload,
    });

    // [2026-07-06 signing-unification fix] Was a body-only HMAC -- no
    // timestamp, no replay window. Switched to lib/webhook.ts's
    // signPayload() over "<timestamp>.<body>", matching the fix applied to
    // firePartnerWebhook (lib/partnerEvents.ts) and the fleetDashboard
    // webhook-test route. No live partner integrators exist today, so
    // there's no wire-format compat to preserve.
    const timestamp  = String(Math.floor(Date.now() / 1000));
    const deliveryId = randomUUID();
    const sig        = signPayload(body, timestamp, partnerOrg.webhookSecret);

    try {
      // [2026-07-06 SSRF fix] Same gap as firePartnerWebhook: raw fetch()
      // against an admin-configured URL with no SSRF defense. Routes
      // through the same hardened path (HTTPS-only, private/metadata-IP
      // block, DNS-rebind-safe IP pinning) without changing the wire
      // contract.
      const result = await postJsonToValidatedUrl({
        url: partnerOrg.webhookUrl,
        body,
        headers: {
          'Content-Type':               'application/json',
          'X-ServiceCycle-Signature':   sig,
          'X-ServiceCycle-Timestamp':   timestamp,
          'X-ServiceCycle-Delivery-Id': deliveryId,
        },
        timeoutMs: 5000,
      });

      if (result.ok) {
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
            `[webhookRetry] Log ${log.id} exhausted ${MAX_ATTEMPTS} attempts (last: ${result.status ?? result.reason}). Giving up.`
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
