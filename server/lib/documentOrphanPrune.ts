/**
 * lib/documentOrphanPrune.js
 *
 * S4-FN-04 (v0.74.1): weekly cron job that deletes Document rows whose
 * assetId (or workOrderId) no longer exists (FK orphans produced when
 * assets / work orders are hard-deleted without cascading to documents).
 *
 * How orphans arise:
 *   Prisma's onDelete default is Restrict, not Cascade. A raw SQL delete or
 *   an admin hard-delete that bypasses the ORM can leave Document rows
 *   referencing an assetId that no longer exists in the assets table.
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
    // Find Document rows whose assetId or workOrderId points at a parent
    // row that no longer exists. Table names use the @@map'd snake_case
    // identifiers from the Prisma schema (documents / assets / work_orders).
    //
    // Conservative rule: a document is an orphan only when EVERY non-null
    // parent reference is dangling. A doc with a dead workOrderId but a
    // live assetId is still reachable from the asset page and must survive.
    //
    // The join approach is straightforward for small tables; if documents
    // ever grows > 100k rows replace with a chunked cursor scan.
    const orphanRows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT d.id
      FROM "documents" d
      LEFT JOIN "assets"      a ON d."assetId"     = a.id
      LEFT JOIN "work_orders" w ON d."workOrderId" = w.id
      WHERE (d."assetId" IS NOT NULL OR d."workOrderId" IS NOT NULL)
        AND (d."assetId"     IS NULL OR a.id IS NULL)
        AND (d."workOrderId" IS NULL OR w.id IS NULL)
        AND NOT (d."assetId" IS NULL AND d."workOrderId" IS NULL)
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
