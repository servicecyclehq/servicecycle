// ─────────────────────────────────────────────────────────────────────────────
// server/lib/webhookRetry.js
// ─────────────────────────────────────────────────────────────────────────────
//
// v0.67.10 (audit High H12 from H4): DLQ auto-retry orchestrator.
//
// Picks DLQ rows due for retry, looks up the live WebhookEndpoint
// (rebuilds URL + secret), re-fires the delivery using the same
// timestamped signature contract production uses, then either deletes
// the DLQ row (on success) or stamps + increments (on failure).
//
// Backoff strategy: simple "30 minutes minimum between attempts" + a
// hard cap of 10 attempts. Beyond 10, the row is left to the 30-day
// daily prune. Could be exponential later; in practice most successful
// retries land on attempt 2-3 when the receiver comes back online.
//
// Tenant boundaries: cron runs globally + iterates all accounts.
// Each DLQ row remains scoped to its accountId, so retries can never
// cross-pollinate; the cron just calls per-row delivery.

'use strict';

import prisma from './prisma';
const { decryptIfEncrypted } = require('./crypto');
const { signPayload, validateWebhookUrl, postOnce } = require('./webhook');
const { dismissOne, persistFailedDelivery, maskUrl } = require('./webhookDlq');

const RETRY_CUTOFF_MS  = 30 * 60 * 1000;  // 30 minutes between attempts
const MAX_ATTEMPTS     = 10;
const REQUEST_TIMEOUT  = 10000;            // 10s per delivery attempt
const BATCH_LIMIT      = 50;               // process at most 50 rows per tick

/**
 * retryDueRows() -- main entry. Returns a summary object:
 *   { considered, delivered, failed, skipped }
 */
async function retryDueRows() {
  const cutoff = new Date(Date.now() - RETRY_CUTOFF_MS);
  const rows = await prisma.outboundWebhookDLQ.findMany({
    where: {
      attemptCount: { lt: MAX_ATTEMPTS },
      lastAttemptAt: { lt: cutoff },
      webhookEndpointId: { not: null },
    },
    orderBy: { lastAttemptAt: 'asc' },
    take: BATCH_LIMIT,
  });

  const summary = { considered: rows.length, delivered: 0, failed: 0, skipped: 0 };

  for (const row of rows) {
    try {
      const endpoint = await prisma.webhookEndpoint.findUnique({
        where:  { id: row.webhookEndpointId },
        select: { id: true, url: true, hmacSecret: true, enabled: true },
      });
      if (!endpoint || !endpoint.enabled) {
        // Endpoint deleted or disabled -- drop the DLQ row; it can't
        // ever succeed. Tenant can use POST /api/webhooks/dlq/:id
        // dismiss but it's polite for us to clean up auto-deleted refs.
        await dismissOne({ accountId: row.accountId, id: row.id });
        summary.skipped += 1;
        continue;
      }
      const url    = decryptIfEncrypted(endpoint.url);
      const secret = decryptIfEncrypted(endpoint.hmacSecret);

      // Server-side validateWebhookUrl rejects private-IP targets +
      // refuses any URL that no longer resolves to public addresses.
      // Belt + suspenders against an endpoint that flipped to localhost
      // between the original delivery + this retry.
      const { valid, addresses } = await validateWebhookUrl(url).catch(() => ({ valid: false, addresses: [] }));
      if (!valid) {
        await dismissOne({ accountId: row.accountId, id: row.id });
        summary.skipped += 1;
        continue;
      }

      const body      = JSON.stringify(row.payload);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = signPayload(body, timestamp, secret);

      const result = await postOnce({
        url,
        addresses,
        body,
        signature,
        timestamp,
        deliveryId: row.deliveryId,
        timeoutMs:  REQUEST_TIMEOUT,
      });

      if (result.ok) {
        await dismissOne({ accountId: row.accountId, id: row.id });
        summary.delivered += 1;
      } else {
        await prisma.outboundWebhookDLQ.update({
          where: { id: row.id },
          data: {
            attemptCount:  { increment: 1 },
            lastAttemptAt: new Date(),
            lastError:     result.reason ? String(result.reason).slice(0, 1000) : 'unknown',
            lastStatus:    Number.isInteger(result.status) ? result.status : null,
          },
        });
        summary.failed += 1;
      }
    } catch (err) {
      console.error('[webhookRetry] row error:', err && err.message ? err.message : err);
      // Best-effort: stamp the row so we don't tight-loop on a bad payload
      try {
        await prisma.outboundWebhookDLQ.update({
          where: { id: row.id },
          data: {
            attemptCount: { increment: 1 },
            lastAttemptAt: new Date(),
            lastError: err && err.message ? String(err.message).slice(0, 1000) : 'retry-orchestrator-threw',
          },
        });
      } catch (_) { /* noop */ }
      summary.failed += 1;
    }
  }

  return summary;
}

module.exports = { retryDueRows };

export {};
