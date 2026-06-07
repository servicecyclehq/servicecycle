/**
 * dlqPrune.js — nightly purge of OutboundWebhookDLQ rows older than 30 days.
 *
 * Mirrors lib/activityLogPrune.js + lib/backupLogPrune.js. Keeps the DLQ
 * table bounded so a webhook misconfiguration that fails for months
 * doesn't slowly grow the table to gigabytes.
 *
 * The 30-day window is a deliberate compromise: long enough that an
 * operator returning from a 2-week vacation can still see what failed
 * while they were away, short enough that the table stays cheap to
 * scan in the admin UI.
 *
 * v0.37.1 W5 MT-132.
 */

'use strict';

const { pruneOlderThan } = require('./webhookDlq');

const RETENTION_DAYS = parseInt(process.env.WEBHOOK_DLQ_RETENTION_DAYS || '30', 10) || 30;

async function pruneWebhookDlq() {
  const retentionDays = Math.max(1, RETENTION_DAYS);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  try {
    const deletedCount = await pruneOlderThan(cutoff);
    return { deletedCount, retentionDays, cutoff };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

module.exports = { pruneWebhookDlq };

export {};
