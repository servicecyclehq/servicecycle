-- Migration: add compound index on WorkOrder(accountId, status, completedDate)
-- Enables index-only scans for the dashboard trends query:
--   WHERE accountId = ? AND status = 'COMPLETE' AND completedDate >= ?
-- Safe: CREATE INDEX IF NOT EXISTS — no data changes, no table rewrites, no downtime.

CREATE INDEX IF NOT EXISTS "WorkOrder_accountId_status_completedDate_idx"
ON "work_orders"("accountId", "status", "completedDate");
