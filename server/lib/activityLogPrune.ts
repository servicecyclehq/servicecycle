/**
 * (B2) ActivityLog retention pruning.
 *
 * The audit log grows unbounded — every contract update, permission denial,
 * login failure, and document access writes a row. For a busy account, that's
 * thousands of rows per month. Without a retention cap, the table eventually
 * dominates pg_dump backup time and disk footprint.
 *
 * pruneActivityLog() deletes rows older than ACTIVITY_LOG_RETENTION_DAYS
 * (default: 365). Wired into the cron schedule in server/index.js to run
 * once per day at 03:00, between the 02:00 backup and the 03:30 demo reset
 * so it never competes with another scheduled job.
 *
 * IMPORTANT — does not touch BackupLog. BackupLog has no retention policy
 * yet and is small (one row per backup attempt). Pruning it would be a
 * separate decision; this helper is scoped to ActivityLog only.
 *
 * Returns { deletedCount } so the caller can log a summary line.
 * Never throws — a failed prune must never crash the cron loop.
 */

import prisma from './prisma';

const DEFAULT_RETENTION_DAYS = 365;

async function pruneActivityLog() {
  const days = parseInt(process.env.ACTIVITY_LOG_RETENTION_DAYS, 10);
  const retentionDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  try {
    const result = await prisma.activityLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return { deletedCount: result.count, retentionDays, cutoff };
  } catch (err) {
    console.error('[activityLogPrune] failed:', err.message);
    return { deletedCount: 0, retentionDays, cutoff, error: err.message };
  }
}

module.exports = { pruneActivityLog };

export {};
