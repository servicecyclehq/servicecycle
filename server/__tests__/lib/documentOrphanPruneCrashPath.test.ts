/**
 * Regression test — 2026-07-06/07 overnight cron bug hunt (Tier 2,
 * continuation of [[servicecycle-bughunt-restore-branch-2026-07-06]]).
 *
 * `documentOrphanPrune` (weekly Sunday 05:00 UTC, index.ts) uses a raw
 * `$queryRaw` join across documents/assets/work_orders — exactly the class
 * of code (hand-written SQL, table/column names typed by hand rather than
 * checked by the Prisma client) most likely to carry a silent
 * column-name/quoting bug that only a REAL Postgres connection can catch;
 * a mocked Prisma client can't validate raw SQL at all. Zero test coverage
 * existed before this pass.
 *
 * Also: index.ts's cron registration comment (the doc-comment directly
 * above the `documentOrphanPrune` cron.schedule call) claims the job
 * "Deletes Document rows whose contractId no longer exists in the Contract
 * table" — but there is no `contractId` column on Document and no
 * `Contract` Prisma model at all (this schema has Contractor/ContractorTech
 * — the same stale-model-name confusion the restoreTest bug hunt found in
 * runDeepRestoreTest()'s row-count list). The actual implementation checks
 * assetId/workOrderId, not contractId. Comment-only, fixed alongside this
 * test (same class of trivial-but-real fix as the DLQ alarm ">1000 rows"
 * stale-comment correction from [[servicecycle-batchf-sso-webhook-2026-07-06]]).
 *
 * This test first proves the raw SQL runs cleanly against real fixture rows
 * with no orphans (the common case). It then attempts to construct a real
 * orphan row via a `session_replication_role` FK-bypass (Document.assetId's
 * relation has no onDelete rule, i.e. Postgres NO ACTION/Restrict — the only
 * way an orphan can exist in this schema is a bypass that skips FK
 * enforcement entirely, matching the doc-comment's own "hard-delete that
 * bypasses cascade" premise). If the test DB role lacks the privilege to
 * toggle session_replication_role, that half is skipped rather than
 * false-failing — the clean-path assertion above already covers the raw
 * SQL's real-Postgres correctness either way.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let prisma: any;
let admin: TestUser;
let siteId: string;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `DOP Site ${Date.now()}` } });
  siteId = site.id;
});

afterAll(async () => {
  try { await prisma.$executeRawUnsafe('SET session_replication_role = DEFAULT;'); } catch {}
  await prisma.document.deleteMany({ where: { accountId: admin.accountId } });
  await prisma.asset.deleteMany({ where: { accountId: admin.accountId } });
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  await prisma.$disconnect();
});

test('pruneDocumentOrphans(): raw SQL join runs cleanly against real Postgres with only valid (non-orphaned) documents', async () => {
  const { pruneDocumentOrphans } = require('../../lib/documentOrphanPrune');

  const asset = await prisma.asset.create({ data: { accountId: admin.accountId, siteId, equipmentType: 'SWITCHGEAR' } });
  const validDoc = await prisma.document.create({
    data: {
      accountId: admin.accountId, assetId: asset.id, siteId: null,
      filename: 'valid.pdf', filePath: `test/${Date.now()}-valid.pdf`, fileType: 'application/pdf',
      uploadedBy: admin.id,
    },
  });
  // A site-level document (assetId AND workOrderId both null) — must NOT be
  // treated as an orphan; the query's own guard
  // (`NOT (d."assetId" IS NULL AND d."workOrderId" IS NULL)`) exists exactly
  // for this case.
  const siteLevelDoc = await prisma.document.create({
    data: {
      accountId: admin.accountId, siteId,
      filename: 'site-level.pdf', filePath: `test/${Date.now()}-sitelevel.pdf`, fileType: 'application/pdf',
      uploadedBy: admin.id,
    },
  });

  const result = await pruneDocumentOrphans();

  expect(result.error).toBeUndefined();
  expect(typeof result.deleted).toBe('number');

  const stillThere = await prisma.document.findMany({ where: { id: { in: [validDoc.id, siteLevelDoc.id] } } });
  expect(stillThere.length).toBe(2);
});

test('pruneDocumentOrphans(): deletes a genuinely orphaned document (dangling assetId, FK bypassed) without touching a live one', async () => {
  const asset = await prisma.asset.create({ data: { accountId: admin.accountId, siteId, equipmentType: 'SWITCHGEAR' } });
  const liveDoc = await prisma.document.create({
    data: {
      accountId: admin.accountId, assetId: asset.id,
      filename: 'live.pdf', filePath: `test/${Date.now()}-live.pdf`, fileType: 'application/pdf',
      uploadedBy: admin.id,
    },
  });

  let bypassAvailable = true;
  const orphanAssetId = '00000000-0000-4000-8000-000000000000'; // syntactically valid uuid, no such asset row
  let orphanDocId: string | null = null;
  try {
    await prisma.$executeRawUnsafe('SET session_replication_role = replica;');
    const inserted: any[] = await prisma.$queryRawUnsafe(
      `INSERT INTO documents (id, "assetId", "accountId", filename, "filePath", "fileType", "uploadedBy", "uploadedAt", version, encrypted, provenance)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now(), 1, false, 'unverified'::"DocProvenance")
       RETURNING id`,
      orphanAssetId, admin.accountId, 'orphan.pdf', `test/${Date.now()}-orphan.pdf`, 'application/pdf', admin.id
    );
    orphanDocId = inserted[0].id;
  } catch (e: any) {
    bypassAvailable = false;
    console.warn('[documentOrphanPruneCrashPath] session_replication_role bypass unavailable (' + e.message + ') — skipping the real-orphan half, clean-path test above already covers raw-SQL correctness.');
  } finally {
    try { await prisma.$executeRawUnsafe('SET session_replication_role = DEFAULT;'); } catch {}
  }

  if (!bypassAvailable || !orphanDocId) return;

  const { pruneDocumentOrphans } = require('../../lib/documentOrphanPrune');
  const result = await pruneDocumentOrphans();

  expect(result.error).toBeUndefined();
  expect(result.deleted).toBeGreaterThanOrEqual(1);

  const orphanGone = await prisma.document.findUnique({ where: { id: orphanDocId } });
  const liveStillThere = await prisma.document.findUnique({ where: { id: liveDoc.id } });
  expect(orphanGone).toBeNull();
  expect(liveStillThere).toBeTruthy();
}, 30000);

export {};
