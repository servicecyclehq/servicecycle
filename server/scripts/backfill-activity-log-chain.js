/**
 * server/scripts/backfill-activity-log-chain.js
 * ---------------------------------------------
 *
 * One-time backfill for the Pass-6 W4 MT-127 ActivityLog hash chain.
 *
 * Two passes:
 *
 *   PASS 1 — Derive accountId for historical rows. The new accountId
 *   column is nullable, but for chain hygiene we want every row tied
 *   to its tenant. Sources, in priority order:
 *     - Contract.accountId via row.contractId
 *     - User.accountId via row.userId
 *     - (fallback) leave NULL — cross-tenant or pre-account event
 *
 *   PASS 2 — Compute the hash chain by calling settleAllPending() in
 *   activityLogChain.js. This walks rows where rowHash IS NULL,
 *   ordered by (createdAt, id), computes prevHash + rowHash, writes back.
 *
 * Idempotent: safe to re-run. Rows already chained are skipped.
 *
 * Run with:
 *   docker compose exec server node scripts/backfill-activity-log-chain.js
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const prisma = require('../lib/prisma');
const { settleAllPending } = require('../lib/activityLogChain');

async function deriveAccountIds() {
  console.log('=== Pass 1: derive accountId for historical rows ===');

  const rowsNeedingAccount = await prisma.activityLog.findMany({
    where:  { accountId: null },
    select: { id: true, contractId: true, userId: true },
  });
  console.log(`Rows without accountId: ${rowsNeedingAccount.length}`);

  if (rowsNeedingAccount.length === 0) return;

  // Batch resolve via two lookup maps (one DB query each, not one per row).
  const contractIds = [...new Set(rowsNeedingAccount.map(r => r.contractId).filter(Boolean))];
  const userIds     = [...new Set(rowsNeedingAccount.map(r => r.userId).filter(Boolean))];

  const contracts = contractIds.length
    ? await prisma.contract.findMany({ where: { id: { in: contractIds } }, select: { id: true, accountId: true } })
    : [];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, accountId: true } })
    : [];

  const contractMap = new Map(contracts.map(c => [c.id, c.accountId]));
  const userMap     = new Map(users.map(u => [u.id, u.accountId]));

  let viaContract = 0, viaUser = 0, leftNull = 0;
  // Update in batches of 500 to keep transaction size reasonable.
  const BATCH = 500;
  for (let i = 0; i < rowsNeedingAccount.length; i += BATCH) {
    const batch = rowsNeedingAccount.slice(i, i + BATCH);
    await prisma.$transaction(async (tx) => {
      for (const row of batch) {
        let accountId = null;
        if (row.contractId && contractMap.has(row.contractId)) {
          accountId = contractMap.get(row.contractId);
          viaContract++;
        } else if (row.userId && userMap.has(row.userId)) {
          accountId = userMap.get(row.userId);
          viaUser++;
        } else {
          leftNull++;
        }
        if (accountId) {
          await tx.activityLog.update({
            where: { id: row.id },
            data:  { accountId },
          });
        }
      }
    }, { timeout: 60_000 });
    process.stdout.write(`  Batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(rowsNeedingAccount.length / BATCH)} resolved\n`);
  }

  console.log(`Resolved via contract: ${viaContract}`);
  console.log(`Resolved via user:     ${viaUser}`);
  console.log(`Left NULL (anonymous): ${leftNull}`);
}

async function computeChain() {
  console.log('');
  console.log('=== Pass 2: compute hash chain on pending rows ===');
  const results = await settleAllPending(prisma);
  let total = 0;
  for (const r of results) {
    const accLabel = r.accountId || '(null/cross-tenant)';
    console.log(`  ${accLabel}: ${r.settled} settled, head=${(r.lastHash || '').slice(0, 16)}…`);
    total += r.settled;
  }
  console.log(`Total settled: ${total}`);
}

async function main() {
  console.log('=== ServiceCycle ActivityLog hash-chain backfill (W4 MT-127) ===');
  console.log('');
  try {
    await deriveAccountIds();
    await computeChain();
    console.log('');
    console.log('=== Backfill complete ===');
  } catch (err) {
    console.error('Backfill failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
