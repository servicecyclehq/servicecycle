/**
 * lib/documentOrphanPrune.js
 *
 * S4-FN-04 (v0.74.1): weekly cron job that deletes Document rows whose
 * contractId no longer exists (FK orphans produced when contracts are
 * hard-deleted without cascading to their documents).
 *
 * How orphans arise:
 *   Prisma's onDelete default is Restrict, not Cascade. A raw SQL delete or
 *   an admin hard-delete that bypasses the ORM can leave Document rows
 *   referencing a contractId that no longer exists in the Contract table.
 *   Those rows are invisible in the UI but still consume R2 / local disk
 *   space and bloat backup sizes.
 *
 * Safety:
 *   - Read-only check first: count orphans, log, then delete.
 *   - Batched in groups of 100 to avoid locking the table for long.
 *   - Never throws — failure is logged at ERROR but must not crash the
 *     caller or abort other crons.
 *
 * Scheduled at 05:00 UTC every Sunday by server/index.js.
 */

'use strict';

import prisma from './prisma';

const BATCH_SIZE = 100;

async function pruneDocumentOrphans() {
  console.log('[documentOrphanPrune] Starting orphan document prune...');
  let totalDeleted = 0;

  try {
    // Find all distinct contractIds referenced by Document rows, then check
    // which ones are missing from the Contract table. We do this in a single
    // query rather than a raw NOT IN to keep it ORM-idiomatic and safe.
    //
    // The subquery approach (deleteMany where contractId NOT IN (SELECT id...))
    // is straightforward for small tables; if Document ever grows > 100k rows
    // replace with a chunked cursor scan.
    const orphanRows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT d.id
      FROM "Document" d
      LEFT JOIN "Contract" c ON d."contractId" = c.id
      WHERE d."contractId" IS NOT NULL
        AND c.id IS NULL
      LIMIT 10000
    `;

    if (!orphanRows || orphanRows.length === 0) {
      console.log('[documentOrphanPrune] No orphaned documents found.');
      return { deleted: 0 };
    }

    console.warn(`[documentOrphanPrune] Found ${orphanRows.length} orphaned document(s) — deleting in batches of ${BATCH_SIZE}.`);

    const ids = orphanRows.map(r => r.id);

    // Delete in batches to avoid long lock windows
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const result = await prisma.document.deleteMany({
        where: { id: { in: batch } },
      });
      totalDeleted += result.count;
    }

    console.log(`[documentOrphanPrune] Done — deleted ${totalDeleted} orphaned document record(s).`);
    return { deleted: totalDeleted };
  } catch (err) {
    console.error('[documentOrphanPrune] Error during orphan prune:', err.message);
    return { deleted: totalDeleted, error: err.message };
  }
}

module.exports = { pruneDocumentOrphans };

export {};
