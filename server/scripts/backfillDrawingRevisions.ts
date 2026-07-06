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
 *   3. Copy to the new EDMS keying scheme via lib/storage.putAtKey().
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
 * 2026-07-05 update: `lib/storage.putAtKey()` now exists (added same day as
 * this note) so steps 1-4 + 6-7 are implemented for real below. Step 5 (text
 * extraction into DrawingPageText, needed for EDMS Phase 3 full-text search)
 * is DELIBERATELY NOT implemented yet -- it needs its own design pass on
 * how to shell into pyextract per-document without blocking this script's
 * claim loop, and isn't required for the revision pointer / currentRevisionId
 * migration to be correct. Flagged as a follow-up, not silently skipped.
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
const { downloadFile, putAtKey } = require('../lib/storage');

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

// [2026-07-05 review fix -- SQL parameterization] accountId was interpolated
// directly into the query text after a naive `.replace(/'/g, '')` strip --
// a blocklist-style "sanitization" that is the wrong tool even when it
// happens to be safe today (every caller of this script passes a UUID).
// $queryRawUnsafe already supports real positional parameters ($1, $2, ...)
// -- accountId now travels as one instead of being spliced into the SQL text.
//
// [2026-07-05 review fix -- transaction boundary] This function used to run
// the SELECT ... FOR UPDATE SKIP LOCKED as its own standalone statement,
// separate from backfillOneDocument's later writes. A `FOR UPDATE` row lock
// only lives as long as the transaction that took it -- $queryRawUnsafe with
// no explicit transaction wrapper autocommits after the SELECT, so the lock
// was released before backfillOneDocument ever started. The header comment's
// claimed guarantee ("safe under a rolling/multi-instance deploy... relying
// on the caller to set currentRevisionId... inside the SAME transaction as
// the rest of the backfill work") was never actually true -- two instances
// could both claim the same document id and both write a DrawingRevision
// for it. The claim SELECT and the whole backfill (including the storage
// I/O and the final writes) now run inside ONE transaction per document, so
// the lock is held for the full duration and a second instance's SKIP LOCKED
// genuinely skips this row until the first instance commits (at which point
// currentRevisionId is set and the WHERE clause excludes it anyway).
async function claimAndBackfillNext(accountId: string | null, opts: any): Promise<{ documentId: string; status: string; reason?: string } | null> {
  return prisma.$transaction(async (tx: any) => {
    const params: any[] = [BACKFILL_DOC_TYPES];
    let accountClause = '';
    if (accountId) {
      params.push(accountId);
      accountClause = `AND "accountId" = $${params.length}`;
    }
    const rows: any[] = await tx.$queryRawUnsafe(
      `SELECT "id" FROM "documents"
        WHERE "currentRevisionId" IS NULL
          AND "docType" = ANY($1)
          ${accountClause}
        ORDER BY "uploadedAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      ...params,
    );
    const documentId = rows && rows.length ? rows[0].id : null;
    if (!documentId) return null;
    return backfillOneDocument(documentId, opts, tx);
  }, { timeout: 60_000 }); // storage I/O (download/copy/verify) runs inside this tx; default 5s prisma timeout is too tight for that
}

async function backfillOneDocument(documentId: string, opts: any, tx: any = prisma): Promise<{ documentId: string; status: string; reason?: string }> {
  const doc = await tx.document.findUnique({ where: { id: documentId } });
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

  const storageKey = `${doc.accountId}/drawings/${doc.id}/rev-1.pdf`;
  await putAtKey(storageKey, buffer, doc.fileType);

  // VERIFY step (per header §14 step 4): re-download what we just wrote and
  // confirm the SHA-256 matches before we ever point currentRevisionId at it.
  // putAtKey() has no built-in verification, so this script does it explicitly
  // rather than trusting a bare write.
  const verifyBuffer = await downloadFile(storageKey);
  const verifySha256 = crypto.createHash('sha256').update(verifyBuffer).digest('hex');
  if (verifySha256 !== sha256) {
    throw new Error(
      `backfillOneDocument: post-write SHA-256 mismatch for documentId=${documentId} ` +
      `key=${storageKey} (expected ${sha256}, got ${verifySha256}). Refusing to create ` +
      'a DrawingRevision pointing at a possibly-corrupt copy.',
    );
  }

  const rev = await tx.drawingRevision.create({ data: {
    accountId: doc.accountId, documentId: doc.id, revNo: 1,
    storageKey, sha256, sizeBytes: buffer.length, sourceFormat: 'pdf',
    createdBy: doc.uploadedBy, createdAt: doc.uploadedAt,
    workflowState: 'published', approvedBy: doc.uploadedBy, approvedAt: doc.uploadedAt,
  } });
  await tx.document.update({ where: { id: doc.id }, data: { currentRevisionId: rev.id } });

  // Step 5 (DrawingPageText extraction) is deliberately NOT done here -- see
  // the 2026-07-05 header note. currentRevisionId is correct without it.
  return { documentId, status: 'backfilled', reason: `revisionId=${rev.id}` };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`[backfillDrawingRevisions] mode=${opts.dryRun ? 'DRY RUN' : 'EXECUTE'} armed=${writesAreArmed(opts)} limit=${opts.limit ?? BATCH_SIZE} account=${opts.accountId ?? 'ALL'}`);

  const results: any[] = [];
  const limit = opts.limit ?? BATCH_SIZE;
  for (let i = 0; i < limit; i++) {
    let claimed: { documentId: string; status: string; reason?: string } | null = null;
    try {
      claimed = await claimAndBackfillNext(opts.accountId, opts);
    } catch (e: any) {
      results.push({ documentId: null, status: 'error', reason: e && e.message ? e.message : String(e) });
      break; // stop on first error; don't mask a systemic issue
    }
    if (!claimed) break;
    results.push(claimed);
  }

  console.log(JSON.stringify(results, null, 2));
  console.log(`[backfillDrawingRevisions] processed ${results.length} document(s).`);
}

if (require.main === module) {
  main().catch((e) => { console.error('[backfillDrawingRevisions] fatal:', e); process.exitCode = 1; });
}

module.exports = { parseArgs, writesAreArmed, claimAndBackfillNext, backfillOneDocument };

export {};
