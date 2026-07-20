-- P1-B Phase 1 backfill: one genesis row per existing MaintenanceSchedule, stamped at its
-- createdAt, capturing current state (source='backfill'). Idempotent via NOT EXISTS.
-- One-time data migration: gives as-of compliance reconstruction a baseline from each
-- schedule's createdAt forward. Complements the Phase 0a capture trigger (schedules created
-- after Phase 0a already carry trigger-captured history; this covers pre-trigger schedules).
INSERT INTO "schedule_state_history"
  ("id", "accountId", "scheduleId", "assetId", "nextDueDate", "lastCompletedDate",
   "isActive", "conditionOverride", "changedAt", "source", "actorId")
SELECT gen_random_uuid()::text, m."accountId", m."id", m."assetId", m."nextDueDate", m."lastCompletedDate",
       m."isActive", m."conditionOverride", m."createdAt", 'backfill', NULL
FROM "maintenance_schedules" m
WHERE NOT EXISTS (
  SELECT 1 FROM "schedule_state_history" h
  WHERE h."scheduleId" = m."id" AND h."source" = 'backfill'
);
