-- S2-FN-02 (v0.75.x): partial index on ActivityLog for unsettled rows.
-- The activityLogChainSettler cron (every 30s) queries:
--   WHERE "accountId" = $1 AND "rowHash" IS NULL ORDER BY "createdAt", "id"
-- Without this index that's a full table scan for every account each tick.
-- The partial index covers only rows where rowHash IS NULL (the unsettled
-- subset), which is almost always tiny relative to the total row count.
-- Once settled, rows fall outside the partial index and stop being scanned.
CREATE INDEX IF NOT EXISTS "activity_logs_unsettled"
  ON "activity_logs" ("accountId", "createdAt", "id")
  WHERE "rowHash" IS NULL;