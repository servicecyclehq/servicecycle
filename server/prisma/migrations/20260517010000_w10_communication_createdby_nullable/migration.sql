-- Wave 10 regression hotfix (2026-05-17)
--
-- Make communications.createdBy nullable + flip the FK to ON DELETE SET NULL
-- so the GDPR Article 17 erasure path (DELETE /api/users/:id) can succeed
-- for users who authored vendor communications. Pre-fix the column was
-- NOT NULL and the FK was effectively RESTRICT â€” any realistic user
-- (anyone who logged a call/note) failed to delete and the whole
-- transaction aborted. Pass-2 audit P0.

ALTER TABLE "communications" ALTER COLUMN "createdBy" DROP NOT NULL;

ALTER TABLE "communications" DROP CONSTRAINT IF EXISTS "communications_createdBy_fkey";

ALTER TABLE "communications"
  ADD CONSTRAINT "communications_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;