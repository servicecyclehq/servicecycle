/**
 * scripts/backfillDrawingRevisions.ts — EDMS Phase 1 scaffold (2026-07-05,
 * feat/edms-phase-1 branch, NOT merged, NOT run).
 *
 * AUTHORED, NOT EXECUTED. This is Phase-2 prep per
 * docs/scoping/EDMS_MODULE_SCOPE_2026-07-04.md §14 ("Migration plan (existing
 * attachments)") -- it exists so the backfill design is settled and reviewable
 * now, while Phase 1 itself only ships schema + storage foundation. Running
 * this tonight would violate the overnight plan's own constraints (no live
 * AI calls are needed here, but this DOES write rows and copy file bytes --
 * exactly the kind of "no reseed / careful about writes" territory the plan
 * asked to stay out of). It has never been executed against any database,
 * including the shadow DBs used to verify the migration in this same commit.
 *
 * Per §14 Phase 2, for each `Document` where
 *   docType IN ('one_line','schematic','as_built','panel_schedule')
 *   AND currentRevisionId IS NULL
 * this script is meant to:
 *   1. Read the current bytes from Document.filePath via lib/storage.downloadFile.
 *   2. Compute SHA-256.
 *   3. Copy to the new EDMS keying scheme (see KNOWN GAP below).
 *   4. VERIFY SHA-256 after the copy.
 *   5. Extract text (pdfplumber/tesseract, reusing the existing pyextract
 *      sidecar the same way lib/ingestWorker + lib/testReportPreview do) into
 *      DrawingPageText rows.
 *   6. Create DrawingRevision(revNo=1, workflowState='published',
 *      createdAt=Document.uploadedAt).
 *   7. Set Document.currentRevisionId = revision.id.
 * Uses the same SELECT ... FOR UPDATE SKIP LOCKED claim pattern as
 * lib/ingestWorker.ts so this is safe to run in a rolling/multi-instance
 * deploy without double-processing a Document.
 *
 * KNOWN GAP (flagging honestly rather than papering over it): lib/storage.ts's
 * `uploadFile(accountId, assetId, filename, buffer, mimeType)` always derives
 * its own storage key via `buildStorageKey()` -- there is no primitive today
 * to upload to an EXPLICIT key. The EDMS scope doc's keying scheme
 * (`{accountId}/drawings/{documentId}/rev-{N}.pdf`, §6) needs one. This script
 * calls a `putAtKey()` helper that DOES NOT YET EXIST -- Phase 2 needs to add
 * it to lib/storage.ts (a small addition: same s3/local branch as uploadFile,
 * but taking the key as a parameter instead of generating one). Left as a
 * clearly-marked TODO rather than silently working around it, since working
 * around it would mean the backfilled keys don't match the documented scheme.
 *
 * Usage (once Phase 2 actually lands and this is wired for real):
 *   npx tsx scripts/backfillDrawingRevisions.ts --dry-run           (default; report only)
 *   npx tsx scripts/backfillDrawingRevisions.ts --execute --limit=50
 *
 * Both a CLI --execute flag AND an env var must agree before any write
 * happens -- a deliberate two-key safety so this can't be run by accident via
 * a stray flag or a copy-pasted command.
 */

'use strict';

const crypto = require('crypto');
const prisma = require('../lib/prisma').default;
const { downloadFile } = require('../lib/storage');

const BACKFILL_DOC_TYPES = ['one_line', 'schematic', 'as_built', 'panel_schedule'];
const BATCH_SIZE = 25;

function parseArgs(argv: string[]) {
  const out: any = { dryRun: true, limit: null, accountId: null };
  for (const arg of argv) {
    if (arg === '--execute') out.dryRun = false;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg.startsWith('--limit=')) out.limit = parseInt(arg.slice('--limit='.length), 10);
    else if (arg.startsWith('--account=')) out.accountId = arg.slice('--account='.length);
  }
  return out;
}

// Two-key safety: --execute alone is not enough. This is deliberately
// annoying to flip -- the whole point is that nobody runs this by accident.
function writesAreArmed(opts: any): boolean {
  return !opts.dryRun && process.env.EDMS_BACKFILL_ENABLE === 'true';
}

async function claimNextDocumentId(accountId: string | null): Promise<string | null> {
  const accountClause = accountId ? `AND "accountId" = '${accountId.replace(/'/g, '')}'` : '';
  // NOTE: same FOR UPDATE SKIP LOCKED pattern as lib/ingestWorker.ts's
  // claimNextJobId -- safe under a rolling/multi-instance deploy. Documents
  // don't have a 'status' column to flip, so this claims by selecting an
  // eligible id under a row lock and relying on the caller to set
  // currentRevisionId (which removes it from future eligibility) inside the
  // same transaction as the rest of the backfill work for that row.
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT "id" FROM "documents"
      WHERE "currentRevisionId" IS NULL
        AND "docType" = ANY($1)
        ${accountClause}
      ORDER BY "uploadedAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1`,
    BACKFILL_DOC_TYPES,
  );
  return rows && rows.length ? rows[0].id : null;
}

async function backfillOneDocument(documentId: string, opts: any): Promise<{ documentId: string; status: string; reason?: string }> {
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  if (!doc) return { documentId, status: 'skipped', reason: 'not found' };
  if (doc.currentRevisionId) return { documentId, status: 'skipped', reason: 'already backfilled' };
  if (doc.filePath === '__external__') return { documentId, status: 'skipped', reason: 'external-URL document, no bytes to copy' };

  if (opts.dryRun) {
    return { documentId, status: 'would-backfill' };
  }

  if (!writesAreArmed(opts)) {
    // Belt-and-suspenders: even with --execute, refuse to write unless the
    // env var also agrees. See writesAreArmed() doc comment.
    return { documentId, status: 'blocked', reason: 'EDMS_BACKFILL_ENABLE!=true -- refusing to write' };
  }

  const buffer = await downloadFile(doc.filePath);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  // TODO(Phase 2): replace with storage.putAtKey(storageKey, buffer, doc.fileType)
  // once that primitive exists (see header KNOWN GAP). Constructing the
  // intended key now so the eventual swap is a one-line change.
  const storageKey = `${doc.accountId}/drawings/${doc.id}/rev-1.pdf`;
  throw new Error(
    `backfillOneDocument: storage.putAtKey() does not exist yet (documentId=${documentId}, ` +
    `intended key=${storageKey}). This script is scaffolding only -- see the ` +
    'KNOWN GAP note at the top of this file. Not safe to run until that lands.',
  );

  // Intended remainder of the flow (unreachable until the TODO above is
  // resolved -- left in place so Phase 2 has the actual shape to fill in):
  //
  // await prisma.$transaction(async (tx) => {
  //   const revision = await tx.drawingRevision.create({ data: {
  //     accountId: doc.accountId, documentId: doc.id, revNo: 1,
  //     storageKey, sha256, sizeBytes: buffer.length, sourceFormat: 'pdf',
  //     createdBy: doc.uploadedBy, createdAt: doc.uploadedAt,
  //     workflowState: 'published', approvedBy: doc.uploadedBy, approvedAt: doc.uploadedAt,
  //   } });
  //   await tx.document.update({ where: { id: doc.id }, data: { currentRevisionId: revision.id } });
  // });
  // return { documentId, status: 'backfilled' };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`[backfillDrawingRevisions] mode=${opts.dryRun ? 'DRY RUN' : 'EXECUTE'} armed=${writesAreArmed(opts)} limit=${opts.limit ?? BATCH_SIZE} account=${opts.accountId ?? 'ALL'}`);

  const results: any[] = [];
  const limit = opts.limit ?? BATCH_SIZE;
  for (let i = 0; i < limit; i++) {
    const id = await claimNextDocumentId(opts.accountId);
    if (!id) break;
    try {
      results.push(await backfillOneDocument(id, opts));
    } catch (e: any) {
      results.push({ documentId: id, status: 'error', reason: e && e.message ? e.message : String(e) });
      break; // stop on first error in dry-run-of-real-thing mode; don't mask a systemic issue
    }
  }

  console.log(JSON.stringify(results, null, 2));
  console.log(`[backfillDrawingRevisions] processed ${results.length} document(s).`);
}

if (require.main === module) {
  main().catch((e) => { console.error('[backfillDrawingRevisions] fatal:', e); process.exitCode = 1; });
}

module.exports = { parseArgs, writesAreArmed, claimNextDocumentId, backfillOneDocument };

export {};
