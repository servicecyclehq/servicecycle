-- [W3] Link the source PDF a SystemStudy was ingested from, asset-precise
-- (docs/scoping/audits/afx-scenario-preservation.md, W3 near-term fix).
-- Additive only: one new nullable column, no changes to any existing table.
--
-- Deliberately a column separate from the existing reportPdfUrl (a
-- user-typed external URL rendered as a raw <a href>). reportFileKey holds
-- an internal storage key (see lib/storage.ts buildStorageKey/uploadFile)
-- and must be resolved to a URL at READ time via storage.getFileUrl() —
-- for S3 destinations that helper returns a short-lived presigned URL
-- (15-60 min TTL), so baking a resolved URL into a durable column at
-- confirm-time would go stale almost immediately.
--
-- Hand-written rather than a raw `prisma migrate diff` dump — same reason
-- as 20260705_a4_wo_comments_doc_annotations/migration.sql (an earlier
-- migration in this history was hand-edited for a raw-SQL GENERATED column
-- Prisma's diff engine can't fully reconcile against a clean shadow replay;
-- unrelated noise, deliberately excluded here).

-- AlterTable
ALTER TABLE "system_studies" ADD COLUMN "reportFileKey" TEXT;
