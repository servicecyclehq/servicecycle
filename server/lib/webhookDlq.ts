/**
 * webhookDlq.js — persistence helper for the OutboundWebhookDLQ table.
 *
 * Kept separate from lib/webhook.js so the delivery logic doesn't depend
 * on prisma at all (cleaner unit-test surface, lets the function be used
 * in worker contexts that don't carry the prisma client).
 *
 * v0.37.1 W5 MT-132.
 * v0.38.1 — pruneOlderThan now accepts an optional accountId filter for
 *   tenant-scoped tests + per-account admin "purge old DLQ" actions.
 */

'use strict';

import prisma from './prisma';

function maskUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/…`;
  } catch {
    return '(invalid url)';
  }
}

/**
 * Persist a failed webhook delivery to the DLQ.
 *
 * @param {object} params
 * @param {string} params.accountId
 * @param {string} [params.webhookEndpointId] - null if the endpoint was deleted between attempts
 * @param {string} params.deliveryId
 * @param {string} params.eventType
 * @param {string} params.targetUrl - the raw URL (will be masked before persistence)
 * @param {object} params.payload   - the JS object that was serialized + sent
 * @param {number} params.attemptCount
 * @param {string} [params.lastError]
 * @param {number} [params.lastStatus]
 * @param {Date}   params.firstFailedAt
 * @returns {Promise<{ id: string } | null>} created row id, or null on persistence error
 */
async function persistFailedDelivery({
  accountId,
  webhookEndpointId = null,
  deliveryId,
  eventType,
  targetUrl,
  payload,
  attemptCount,
  lastError = null,
  lastStatus = null,
  firstFailedAt,
}) {
  try {
    const row = await prisma.outboundWebhookDLQ.create({
      data: {
        accountId,
        webhookEndpointId,
        deliveryId,
        eventType,
        targetUrlMasked: maskUrl(targetUrl),
        payload,
        attemptCount,
        lastError:     lastError ? String(lastError).slice(0, 1000) : null,
        lastStatus:    Number.isInteger(lastStatus) ? lastStatus : null,
        firstFailedAt,
        lastAttemptAt: new Date(),
      },
      select: { id: true },
    });
    return row;
  } catch (err) {
    // DLQ persistence must never throw out of the delivery loop.
    console.error('[webhookDlq] persist error:', err && err.message ? err.message : err);
    return null;
  }
}

/**
 * Delete DLQ rows older than the given cutoff. Used by the nightly prune
 * cron in lib/dlqPrune.js (no accountId — global prune). Tests + a
 * future per-account admin "purge old DLQ" action can pass an accountId
 * to scope the delete to one tenant. Returns the number of rows deleted.
 *
 * @param {Date}   cutoffDate
 * @param {object} [opts]
 * @param {string} [opts.accountId] - optional tenant scope
 */
async function pruneOlderThan(cutoffDate, opts: any = {}) {
  const where: any = { createdAt: { lt: cutoffDate } };
  if (opts.accountId) where.accountId = opts.accountId;
  const result = await prisma.outboundWebhookDLQ.deleteMany({ where });
  return result.count;
}

/**
 * H10 (audit High, 2026-05-22): list DLQ rows for a given account.
 * Used by GET /api/webhooks/dlq so admins can inspect failed
 * deliveries before the prune cron pulls them at day 30.
 *
 * @param {object} params
 * @param {string} params.accountId
 * @param {number} [params.limit=100]
 * @returns {Promise<Array>}
 */
async function listForAccount({ accountId, limit = 100 }) {
  if (!accountId) return [];
  return prisma.outboundWebhookDLQ.findMany({
    where: { accountId },
    orderBy: { lastAttemptAt: 'desc' },
    take: Math.min(Math.max(parseInt(String(limit), 10) || 100, 1), 500),
    select: {
      id: true,
      webhookEndpointId: true,
      deliveryId: true,
      eventType: true,
      targetUrlMasked: true,
      attemptCount: true,
      lastError: true,
      lastStatus: true,
      firstFailedAt: true,
      lastAttemptAt: true,
      createdAt: true,
    },
  });
}

/**
 * H10: dismiss (delete) a single DLQ row for an account.
 * Scoped by accountId so a tenant can't dismiss another tenant's row.
 * Returns true on delete, false on miss.
 */
async function dismissOne({ accountId, id }) {
  if (!accountId || !id) return false;
  const result = await prisma.outboundWebhookDLQ.deleteMany({
    where: { id, accountId },
  });
  return result.count > 0;
}

module.exports = { persistFailedDelivery, pruneOlderThan, maskUrl, listForAccount, dismissOne };

export {};
