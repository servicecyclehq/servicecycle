-- Pass-6 W4 MT-127: hash-chained ActivityLog for tamper evidence
-- See server/lib/activityLogChain.js + docs/master-key-rotation.md cross-refs

ALTER TABLE "activity_logs"
  ADD COLUMN IF NOT EXISTS "accountId" TEXT,
  ADD COLUMN IF NOT EXISTS "prevHash" TEXT,
  ADD COLUMN IF NOT EXISTS "rowHash" TEXT;

CREATE INDEX IF NOT EXISTS "activity_logs_accountId_createdAt_idx"
  ON "activity_logs" ("accountId", "createdAt");

CREATE INDEX IF NOT EXISTS "activity_logs_rowHash_idx"
  ON "activity_logs" ("rowHash");

-- accountId is intentionally nullable to support cross-tenant events
-- (login_failed for unknown emails has no associated account); those rows
-- share a single "global" chain keyed by NULL accountId.
