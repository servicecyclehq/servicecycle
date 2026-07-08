/**
 * server/scripts/backfill-activity-log-chain.js
 * ---------------------------------------------
 *
 * One-time (re-runnable) chain (re)compute for ActivityLog's hash chain.
 *
 * History:
 *   - Originally the Pass-6 W4 MT-127 backfill, with a Pass 1 that derived
 *     accountId for historical rows via a `Contract` model. That model no
 *     longer exists (ServiceCycle's contractId -> assetId conversion), so
 *     Pass 1 referenced a nonexistent `contractId` column and would throw
 *     "Unknown field" on first Prisma call — a stale, broken script
 *     (2026-07-08 acquisition-audit finding W1-L6). Removed below; every
 *     row has had accountId populated at write time since that conversion.
 *   - 2026-07-08 acquisition-audit fix W1-M3: canonical() in
 *     activityLogChain.ts now excludes accountId/assetId (both FK columns
 *     are onDelete: SetNull, so a legitimate hard-delete used to read as
 *     tampering). That's a chain-FORM change: every previously-settled
 *     row's rowHash was computed under the OLD canonical() and will no
 *     longer match under the new one. This script now does the one-time
 *     re-anchor: reset every settled row's prevHash/rowHash to NULL, then
 *     call settleAllPending() to recompute the whole chain from genesis
 *     under the new canonical() form — exactly the same technique used for
 *     the earlier userId exclusion (see activityLogChain.ts history).
 *
 * Idempotent: safe to re-run. A second run just re-settles an
 * already-correctly-chained set of rows (wasted work, not wrong work) —
 * canonical() is a pure function of (id, action, details, createdAt), so
 * the recomputed hashes are identical either way.
 *
 * Run with:
 *   docker compose exec server node scripts/backfill-activity-log-chain.js
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// lib/prisma.ts uses `export default prisma`, so a bare CJS require() here
// returns the ES module namespace object, not the client — .default is
// required (2026-07-08 acquisition-audit fix; this script never actually
// ran successfully under tsx before, on top of the Contract-field bug fixed
// above; see backfillDrawingRevisions.ts / seed-powerdb-demo.js for the
// same correct pattern elsewhere in this directory).
const prisma = require('../lib/prisma').default;
const { settleAllPending } = require('../lib/activityLogChain');

async function resetSettledRows() {
  console.log('=== Pass 1: reset settled rows so the chain recomputes under the new canonical() form ===');
  const result = await prisma.activityLog.updateMany({
    where: { rowHash: { not: null } },
    data:  { rowHash: null, prevHash: null },
  });
  console.log(`Reset ${result.count} previously-settled rows to pending.`);
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
  console.log('=== ServiceCycle ActivityLog hash-chain re-anchor (2026-07-08 W1-M3 canonical() form change) ===');
  console.log('');
  try {
    await resetSettledRows();
    await computeChain();
    console.log('');
    console.log('=== Re-anchor complete. Run scripts/verify-audit-chain.js against a fresh export to confirm. ===');
  } catch (err) {
    console.error('Re-anchor failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
