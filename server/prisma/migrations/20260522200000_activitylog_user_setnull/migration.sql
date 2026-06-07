-- v0.71.4 (audit Medium "Data Integrity"): ActivityLog.userId FK SetNull.
-- The userId column already has an implicit FK from Prisma 5+ schema sync,
-- but without an explicit onDelete clause Prisma defaults to RESTRICT, which
-- means deleting a User (e.g. GDPR Art. 17 erase) fails when historical
-- audit rows reference them. SetNull keeps the row + chain intact.
ALTER TABLE "activity_logs" DROP CONSTRAINT IF EXISTS "activity_logs_userId_fkey";

ALTER TABLE "activity_logs"
  ADD CONSTRAINT "activity_logs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
