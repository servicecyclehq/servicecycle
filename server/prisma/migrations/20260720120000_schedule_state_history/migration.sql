-- Forensics P2 / P1-B: append-only point-in-time history of MaintenanceSchedule
-- compliance state, captured by a Postgres trigger on maintenance_schedules.
-- Additive: one new table + one function/trigger; NO changes to existing columns.
-- The Prisma model is scalar-only; integrity is enforced by the SQL FKs below
-- (mirrors migration 20260619000000_access_blockers).

CREATE TABLE "schedule_state_history" (
    "id"                TEXT NOT NULL,
    "accountId"         TEXT NOT NULL,
    "scheduleId"        TEXT NOT NULL,
    "assetId"           TEXT NOT NULL,
    "nextDueDate"       TIMESTAMP(3),
    "lastCompletedDate" TIMESTAMP(3),
    "isActive"          BOOLEAN NOT NULL,
    "conditionOverride" "ConditionRating",
    "changedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source"            TEXT NOT NULL,
    "actorId"           TEXT,
    CONSTRAINT "schedule_state_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "schedule_state_history_accountId_scheduleId_changedAt_idx" ON "schedule_state_history"("accountId", "scheduleId", "changedAt");
CREATE INDEX "schedule_state_history_accountId_changedAt_idx" ON "schedule_state_history"("accountId", "changedAt");

-- Tenant-cascade + integrity (SQL-only; the Prisma model carries no relations).
ALTER TABLE "schedule_state_history" ADD CONSTRAINT "schedule_state_history_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "schedule_state_history" ADD CONSTRAINT "schedule_state_history_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "maintenance_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "schedule_state_history" ADD CONSTRAINT "schedule_state_history_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Capture: append the NEW state on every INSERT, and on any UPDATE that changes one
-- of the four compliance-governing columns. current_setting(..., true) returns NULL
-- when unset (missing_ok), so unattributed writes (cron / raw SQL) are still captured
-- with source = 'unknown'. Attribution (app.actor_id / app.change_source) is optional
-- and set per-transaction by the app in a later, additive phase.
CREATE OR REPLACE FUNCTION capture_schedule_state() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'UPDATE'
      AND NEW."nextDueDate"       IS NOT DISTINCT FROM OLD."nextDueDate"
      AND NEW."lastCompletedDate" IS NOT DISTINCT FROM OLD."lastCompletedDate"
      AND NEW."isActive"          IS NOT DISTINCT FROM OLD."isActive"
      AND NEW."conditionOverride" IS NOT DISTINCT FROM OLD."conditionOverride") THEN
    RETURN NEW; -- no governing column changed; skip the redundant row
  END IF;

  INSERT INTO "schedule_state_history"
    ("id", "accountId", "scheduleId", "assetId", "nextDueDate", "lastCompletedDate",
     "isActive", "conditionOverride", "changedAt", "source", "actorId")
  VALUES
    (gen_random_uuid()::text, NEW."accountId", NEW."id", NEW."assetId", NEW."nextDueDate",
     NEW."lastCompletedDate", NEW."isActive", NEW."conditionOverride", CURRENT_TIMESTAMP,
     COALESCE(NULLIF(current_setting('app.change_source', true), ''), 'unknown'),
     NULLIF(current_setting('app.actor_id', true), ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_capture_schedule_state"
  AFTER INSERT OR UPDATE ON "maintenance_schedules"
  FOR EACH ROW EXECUTE FUNCTION capture_schedule_state();
