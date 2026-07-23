/**
 * server/scripts/backfill-activity-log-actor.js
 * -----------------------------------------------
 *
 * One-time (re-runnable) backfill: snapshot {userId, accountId, assetId}
 * attribution into details._actor for ActivityLog rows written BEFORE the
 * SC-10 Approach-A middleware (lib/prisma.ts's $use hook) went live, using
 * whatever is CURRENTLY in each row's own FK columns.
 *
 * Why this exists / why now (SC-10 Approach B, backfill piece only --
 * Dustin greenlit this piece specifically and deferred the rest: no
 * canonical() versioning migration, no external chain-anchor work):
 *
 *   canonical() (lib/activityLogChain.ts) has never hash-chained WHO performed
 *   an action -- userId/accountId/assetId are all excluded from the chain
 *   payload (all three are onDelete: SetNull FKs, dropped from canonical()
 *   historically to avoid false chain-breaks on legitimate GDPR erasure --
 *   see that file's history comments). Approach A (already shipped, see
 *   lib/prisma.ts's $use middleware, tagged "-- SC-10: audit-chain
 *   attribution --") fixed this GOING FORWARD by snapshotting the actor into
 *   the already-chain-covered `details` JSON at write time -- no canonical()
 *   change, no migration, no existing hash disturbed.
 *
 *   Approach A does nothing for rows written BEFORE it deployed. Those rows'
 *   attribution is exactly as unrecoverable as before -- and it gets WORSE
 *   over time: every legitimate asset archive / account offboarding / user
 *   GDPR-erasure nulls one of these FK columns going forward, permanently
 *   destroying attribution this backfill could otherwise still have
 *   captured. This script is the time-sensitive one-time catch-up: run once,
 *   snapshot whatever is CURRENTLY still in the FK columns of every
 *   pre-Approach-A row -- recoverable or not. A row whose FK is already null
 *   just gets an honest null captured in `_actor`, exactly what Approach A
 *   itself would capture for a brand-new row with the same null FK (e.g. a
 *   login_failed event with no account). Nothing is fabricated; this is
 *   simply applying Approach A's own logic retroactively, using whatever
 *   data is available at the moment this script runs instead of at the
 *   moment the row was originally written.
 *
 * Two-pass shape, same technique as the existing chain-form-change precedent
 * (scripts/backfill-activity-log-chain.js, run successfully twice before for
 * the userId and accountId/assetId canonical() exclusions):
 *
 *   Pass 1 -- for every row whose `details` is missing an `_actor` key,
 *             write one in, built from that row's CURRENT userId/accountId/
 *             assetId columns + a `backfilledAt` timestamp so a reader can
 *             always tell a reconstructed snapshot from one captured live
 *             by Approach A at the moment of the original action.
 *   Pass 2 -- because `details` is inside canonical(), Pass 1 changes the
 *             canonical payload (and therefore the rowHash) of every row it
 *             touches -- which cascades to every LATER row in that row's
 *             per-account chain (rowHash = sha256(prevHash || canonical(row))
 *             is sequential). Rather than hand-computing which rows cascade,
 *             this reuses the exact reset-then-resettle technique the
 *             existing precedent script already uses successfully: reset
 *             every row's prevHash/rowHash to NULL, then call
 *             settleAllPending() to rebuild every account's chain from
 *             genesis under the current canonical(). canonical() ITSELF is
 *             unchanged by this script (only `details` content changes in
 *             Pass 1), so there's no new chain-FORM risk beyond what the
 *             existing precedent script already validated twice before.
 *   Pass 3 -- verifyAllChains() and report the summary; fail loudly (nonzero
 *             exit) if any account comes back broken, rather than silently
 *             declaring success.
 *
 * Safety:
 *   - Defaults to dry-run (report-only, zero writes) -- same convention as
 *     backfillDrawingRevisions.ts / p5-cleanup-riverside-imports.js elsewhere
 *     in this directory. Pass --execute to actually write.
 *   - Idempotent: a second run finds zero rows missing _actor (Pass 1 no-ops)
 *     and, since nothing changed, skips Pass 2/3 entirely rather than
 *     redundantly resettling an already-correct chain.
 *   - Never fabricates a non-null value: only ever writes what's CURRENTLY in
 *     the row's own FK columns, null or not.
 *   - Preserves any other existing keys already in `details` (object spread,
 *     never overwrite) -- only adds `_actor` where it's absent.
 *   - Batches reads (1000 rows/page, cursor pagination) rather than one
 *     unbounded findMany, even though current data volume (zero live
 *     customers as of this writing) makes this unlikely to matter in
 *     practice -- matches settleAccount()'s own 500-row-batch convention.
 *   - Crash-safe by construction, not by special-casing: if Pass 1 dies
 *     partway, re-running the whole script from scratch just picks up the
 *     rows still missing _actor (already-backfilled rows are skipped, since
 *     they now have the key). If Pass 2/3 dies partway, the live
 *     settleAllPending() cron (~30s tick, already running in production)
 *     finishes the resettle on its own -- Pass 3's verify can simply be
 *     re-run a little later to confirm.
 *
 * Run with:
 *   docker compose exec server node scripts/backfill-activity-log-actor.js            # dry run (default)
 *   docker compose exec server node scripts/backfill-activity-log-actor.js --execute   # writes for real
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// lib/prisma.ts uses `export default prisma` -- a bare CJS require() returns
// the ES module namespace object, not the client -- .default is required
// (same gotcha documented in backfill-activity-log-chain.js; this script
// never actually connects otherwise, it just gets `undefined.activityLog`).
const prisma = require('../lib/prisma').default;
const { settleAllPending, verifyAllChains } = require('../lib/activityLogChain');

const EXECUTE = process.argv.includes('--execute');
const PAGE_SIZE = 1000;
const SAMPLE_LOG_COUNT = 3;

function buildActorSnapshot(row, now) {
  return {
    userId: row.userId ?? null,
    accountId: row.accountId ?? null,
    assetId: row.assetId ?? null,
    backfilledAt: now,
  };
}

function hasActor(details) {
  return !!details && typeof details === 'object' && !Array.isArray(details) && details._actor !== undefined;
}

async function findRowsNeedingBackfill() {
  // Fetch id + the fields we need to decide/build the snapshot, paginated.
  // "details has no _actor key" isn't pushed into the Prisma `where` clause --
  // JSON-shape filters are provider-specific and this avoids any raw SQL
  // against a JSON column (see backfillDrawingRevisions.ts's own history
  // comment about a prior SQL-injection-shaped review finding on a similar
  // raw-query approach elsewhere in this directory; data volume here doesn't
  // require raw SQL, so that whole risk class is sidestepped). Simple
  // in-JS filter over a cursor-paginated scan instead.
  const needsBackfill = [];
  let cursor;
  for (;;) {
    const page = await prisma.activityLog.findMany({
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      select: { id: true, userId: true, accountId: true, assetId: true, details: true },
    });
    if (page.length === 0) break;
    for (const row of page) {
      if (!hasActor(row.details)) needsBackfill.push(row);
    }
    cursor = page[page.length - 1].id;
    if (page.length < PAGE_SIZE) break;
  }
  return needsBackfill;
}

function report(rows) {
  console.log(`Rows missing details._actor: ${rows.length}`);
  let fullyNull = 0;
  let partial = 0;
  let full = 0;
  for (const r of rows) {
    const nullCount = [r.userId, r.accountId, r.assetId].filter((v) => v == null).length;
    if (nullCount === 3) fullyNull++;
    else if (nullCount === 0) full++;
    else partial++;
  }
  console.log(`  all 3 FKs still present (full attribution recoverable): ${full}`);
  console.log(`  some FKs already null (partial attribution recoverable): ${partial}`);
  console.log(`  all 3 FKs already null (nothing left to recover, will honestly record null): ${fullyNull}`);
}

async function backfillActors(rows) {
  console.log('');
  console.log(`=== Pass 1: writing details._actor for ${rows.length} rows ===`);
  let done = 0;
  const samples = [];
  for (const row of rows) {
    // Preserve whatever else is already in details (spread, never overwrite)
    // rather than assuming it's null just because _actor was absent.
    const existing = (row.details && typeof row.details === 'object' && !Array.isArray(row.details)) ? row.details : {};
    const now = new Date().toISOString();
    const actor = buildActorSnapshot(row, now);
    const newDetails = { ...existing, _actor: actor };
    await prisma.activityLog.update({
      where: { id: row.id },
      data: { details: newDetails },
    });
    if (samples.length < SAMPLE_LOG_COUNT) {
      samples.push({ id: row.id, before: existing, after: newDetails });
    }
    done++;
    if (done % 500 === 0) console.log(`  ...${done}/${rows.length}`);
  }
  console.log(`Backfilled ${done} rows.`);
  if (samples.length > 0) {
    console.log('');
    console.log(`Sample of first ${samples.length} backfilled rows (for spot-check):`);
    console.log(JSON.stringify(samples, null, 2));
  }
}

async function resetSettledRows() {
  console.log('');
  console.log('=== Pass 2a: reset every row to pending so the chain recomputes over the new details ===');
  const result = await prisma.activityLog.updateMany({
    where: { rowHash: { not: null } },
    data: { rowHash: null, prevHash: null },
  });
  console.log(`Reset ${result.count} previously-settled rows to pending.`);
}

async function recomputeChain() {
  console.log('');
  console.log('=== Pass 2b: recompute hash chain on pending rows ===');
  const results = await settleAllPending(prisma);
  let total = 0;
  for (const r of results) {
    const accLabel = r.accountId || '(null/cross-tenant)';
    console.log(`  ${accLabel}: ${r.settled} settled, head=${(r.lastHash || '').slice(0, 16)}…`);
    total += r.settled;
  }
  console.log(`Total settled: ${total}`);
}

async function verify() {
  console.log('');
  console.log('=== Pass 3: verify every chain end-to-end ===');
  const { summary } = await verifyAllChains(prisma);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.accountsBroken > 0) {
    throw new Error(
      `verifyAllChains reports ${summary.accountsBroken} broken account chain(s) -- ` +
      `investigate before trusting this backfill. See the audit_chain_break event(s) ` +
      `verifyAllChains just wrote for the affected row IDs.`
    );
  }
  console.log('All chains verified clean.');
}

async function main() {
  console.log('=== ServiceCycle ActivityLog attribution backfill (SC-10 Approach B, historical-row catch-up) ===');
  console.log(EXECUTE ? '*** EXECUTE MODE -- this WILL write to the database ***' : '(dry run -- pass --execute to write for real)');
  console.log('');
  try {
    const rows = await findRowsNeedingBackfill();
    report(rows);

    if (rows.length === 0) {
      console.log('');
      console.log('Nothing to backfill -- every row already has details._actor. Skipping reset/recompute/verify.');
      return;
    }

    if (!EXECUTE) {
      console.log('');
      console.log('Dry run only -- no writes performed. Re-run with --execute to perform the backfill for real.');
      return;
    }

    await backfillActors(rows);
    await resetSettledRows();
    await recomputeChain();
    await verify();
    console.log('');
    console.log('=== Backfill complete. ===');
  } catch (err) {
    console.error('Backfill failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
