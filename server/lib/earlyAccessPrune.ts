/**
 * earlyAccessPrune.js
 *
 * Pass-4 audit L2-10 — Privacy Policy §5 commits "Early-access form
 * submissions: retained until you ask us to delete them, or until 36
 * months elapse, whichever is sooner." Before this module existed, the
 * 36-month commitment was policy-only — the EarlyAccessRequest table
 * (server/prisma/schema.prisma — name, email, company, timing,
 * ipAddress, userAgent) grew unbounded.
 *
 * This module is wired into the nightly cron block in server/index.js at
 * 03:35 server time, slotted after the demo prune (03:25) and demo reset
 * (03:30) so it doesn't compete for the DB write window.
 *
 * The retention period is configurable via EARLY_ACCESS_RETENTION_DAYS;
 * the default of 1095 days = 36 months matches the policy commitment.
 *
 * Idempotent and safe to run repeatedly. Logs the deleted count for
 * audit trail; no per-row activity-log entry is written (the row itself
 * is the only personal-data record of the early-access submission).
 */

'use strict';

import prisma from './prisma';

const DEFAULT_RETENTION_DAYS = 1095; // 36 months — matches Privacy §5

function getRetentionDays() {
  const raw = process.env.EARLY_ACCESS_RETENTION_DAYS;
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

/**
 * pruneEarlyAccessRequests() → { deletedCount, retentionDays, cutoff }
 *
 * Deletes every EarlyAccessRequest row with createdAt older than the
 * retention cutoff. The Prisma `count` return makes the cron log line
 * informative without an extra round-trip.
 */
async function pruneEarlyAccessRequests() {
  const retentionDays = getRetentionDays();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  try {
    const { count } = await prisma.earlyAccessRequest.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return { deletedCount: count, retentionDays, cutoff };
  } catch (err) {
    return { error: err.message, retentionDays, cutoff };
  }
}

module.exports = {
  pruneEarlyAccessRequests,
  getRetentionDays,
};

export {};
