-- (B4) Make ActivityLog.userId nullable so login_failed rows can be written
-- for attempts that target an unregistered email. Until now those went to
-- console.warn only; persisting them in the audit log lets admins spot brute-
-- force attempts that target made-up addresses.
--
-- Drop the existing FK + NOT NULL, recreate as optional with the same ON DELETE
-- semantics. Existing rows are unaffected (every current row has a userId).

-- DropForeignKey
ALTER TABLE "activity_logs" DROP CONSTRAINT IF EXISTS "activity_logs_userId_fkey";

-- AlterTable
ALTER TABLE "activity_logs" ALTER COLUMN "userId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "activity_logs"
  ADD CONSTRAINT "activity_logs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- (B4) Add an index on (action, createdAt) so admins can scan a single audit
-- category (e.g. login_failed) over a time window without a full table scan.
CREATE INDEX IF NOT EXISTS "activity_logs_action_createdAt_idx"
  ON "activity_logs" ("action", "createdAt");
