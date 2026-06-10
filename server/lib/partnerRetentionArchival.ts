export {};
/**
 * Partner Flywheel — retention archival cron.
 *
 * Soft-archives PartnerEventLog records that exceed the customer account's
 * data retention window.  Never hard-deletes.
 *
 * Retention tiers:
 *   STANDARD    — 7 years
 *   HEALTHCARE  — 10 years
 *   UTILITY     — permanent (never archived)
 *   CUSTOM      — account.retentionCustomYears years
 */

const prisma = require('./prisma').default;

const RETENTION_YEARS: Record<string, number | null> = {
  STANDARD:   7,
  HEALTHCARE: 10,
  UTILITY:    null, // never archive
  CUSTOM:     null, // resolved per-account
};

interface ArchivalResult {
  archived: number;
  accountsProcessed: number;
}

async function runRetentionArchival(): Promise<ArchivalResult> {
  let archived = 0;
  let accountsProcessed = 0;

  // Load all accounts that have partner event logs
  const accounts = await prisma.account.findMany({
    where: {
      partnerEventLogs: { some: { archived: false } },
    },
    select: {
      id: true,
      retentionTier: true,
      retentionCustomYears: true,
    },
  });

  for (const account of accounts) {
    accountsProcessed++;

    let retentionYears: number | null;
    if (account.retentionTier === 'UTILITY') {
      continue; // never archive
    } else if (account.retentionTier === 'CUSTOM') {
      retentionYears = account.retentionCustomYears ?? 7; // fallback to STANDARD
    } else {
      retentionYears = RETENTION_YEARS[account.retentionTier] ?? 7;
    }

    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - retentionYears);

    const result = await prisma.partnerEventLog.updateMany({
      where: {
        accountId: account.id,
        archived: false,
        createdAt: { lt: cutoff },
      },
      data: { archived: true },
    });

    archived += result.count;
    if (result.count > 0) {
      console.log(`[partnerRetentionArchival] Archived ${result.count} records for account ${account.id} (tier: ${account.retentionTier}, cutoff: ${cutoff.toISOString().split('T')[0]})`);
    }
  }

  return { archived, accountsProcessed };
}

module.exports = { runRetentionArchival };
