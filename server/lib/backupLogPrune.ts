/**
 * (B1) BackupLog retention pruning.
 *
 * BackupLog is small — one row per backup attempt — but it grows linearly
 * with calendar time. With a 30-day retention policy on the *backups
 * themselves*, keeping the audit row indefinitely buys little: a renewals
 * manager investigating a 2-year-old backup failure has nothing they can
 * actually restore from. Default retention is 180 days, which keeps roughly
 * six months of attempts (≈180 cron rows + manual runs) — enough to
 * investigate a failure pattern while keeping the table bounded.
 *
 * Wired into the cron schedule in server/index.js to run once per day at
 * 03:15, between the 03:00 ActivityLog prune and the 03:30 demo reset so
 * it never competes with another scheduled job.
 *
 * Returns { deletedCount, retentionDays, cutoff } so the caller can log a
 * summary line. Never throws — a failed prune must never crash the cron
 * loop.
 *
 * Companion to lib/activityLogPrune.js. Deliberately scoped to BackupLog
 * only — different retention story than ActivityLog (180d vs 365d).
 */

import prisma from './prisma';

const DEFAULT_RETENTION_DAYS = 180;

async function pruneBackupLog() {
  const days = parseInt(process.env.BACKUP_LOG_RETENTION_DAYS, 10);
  const retentionDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  try {
    const result = await prisma.backupLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return { deletedCount: result.count, retentionDays, cutoff };
  } catch (err) {
    console.error('[backupLogPrune] failed:', err.message);
    return { deletedCount: 0, retentionDays, cutoff, error: err.message };
  }
}

module.exports = { pruneBackupLog };

export {};
