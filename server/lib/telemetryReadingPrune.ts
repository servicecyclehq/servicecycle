/**
 * TelemetryReading retention pruning.
 *
 * TelemetryReading is the highest-write-rate table in the schema: one row per
 * channel per sample from continuous condition-monitoring gateways. With no
 * retention cap it grows unbounded (flagged worst-case in DB_HEALTH 2026-07-19)
 * and eventually dominates disk + pg_dump time.
 *
 * pruneTelemetryReadings() deletes rows whose server-ingest time (createdAt) is
 * older than TELEMETRY_READING_RETENTION_DAYS (default: 365). Wired into the
 * daily cron in server/index.ts at 03:05 — after activityLogPrune (03:00) and
 * before the demo reset (03:30) so it never competes with another job.
 *
 * SAFE vs. load-growth trends: the only consumer of reading history,
 * routes/arcFlashIngest.ts `/load-growth`, reads at most the 200 most recent
 * readings per channel (orderBy recordedAt desc, take 200). A 365-day retention
 * keeps far more than 200 readings at any realistic cadence, so the baseline /
 * growth calculation is unaffected. Threshold-breach monitoring acts on new
 * readings in real time, not on pruned history.
 *
 * Deletes in bounded batches (BATCH_SIZE by id) so a large backlog never holds a
 * long table lock, and caps the batches per run so one invocation can't run away
 * — the next nightly run finishes any remainder. Prunes by createdAt (monotonic
 * server time), not recordedAt (device-supplied, can be wrong/backdated).
 *
 * Returns { deletedCount } so the caller can log a summary line.
 * Never throws — a failed prune must never crash the cron loop.
 */

import prisma from './prisma';

const DEFAULT_RETENTION_DAYS = 365;
const BATCH_SIZE = 5000;   // rows deleted per transaction (bounded lock)
const MAX_BATCHES = 400;   // cap one run at 2,000,000 rows; remainder next night

async function pruneTelemetryReadings() {
  const days = parseInt(process.env.TELEMETRY_READING_RETENTION_DAYS, 10);
  const retentionDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  let deletedCount = 0;
  try {
    for (let i = 0; i < MAX_BATCHES; i++) {
      // Grab a bounded page of ids to delete, then delete by id. deleteMany has
      // no LIMIT, so page-then-delete keeps each transaction short.
      const batch = await prisma.telemetryReading.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        take: BATCH_SIZE,
      });
      if (batch.length === 0) break;
      const del = await prisma.telemetryReading.deleteMany({
        where: { id: { in: batch.map((r: any) => r.id) } },
      });
      deletedCount += del.count;
      if (batch.length < BATCH_SIZE) break; // drained
    }
    return { deletedCount, retentionDays, cutoff };
  } catch (err: any) {
    console.error('[telemetryReadingPrune] failed:', err && err.message);
    return { deletedCount, retentionDays, cutoff, error: err && err.message };
  }
}

module.exports = { pruneTelemetryReadings };

export {};
