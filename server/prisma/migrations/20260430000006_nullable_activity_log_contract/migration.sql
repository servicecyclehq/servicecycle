-- Migration: 20260430000006_nullable_activity_log_contract
-- Makes ActivityLog.contractId nullable so non-contract events (e.g. user_directly_created)
-- can be recorded in the audit trail without requiring a contractId. (M11)

ALTER TABLE "activity_logs" ALTER COLUMN "contractId" DROP NOT NULL;
