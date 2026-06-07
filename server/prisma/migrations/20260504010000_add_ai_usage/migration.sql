-- L1: AiUsage — per-user-per-action-per-day quota tracking.
--
-- Composite PK on (userId, action, day) enables a single-round-trip atomic
-- upsert (INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING)
-- so two concurrent AI calls cannot both read count=cap-1 and both pass.
--
-- `day` is stored as a YYYY-MM-DD UTC string rather than a DATE / TIMESTAMP.
-- We reset on UTC midnight everywhere (servers, clients, log entries) to avoid
-- the "midnight in the operator's timezone reset midnight in the user's
-- timezone" bug class. A TEXT key is stable, sortable, and trivially indexable
-- without timezone math.
--
-- ON DELETE CASCADE: when a demo user is pruned by the L3 inactivity sweep,
-- their usage rows go with them — keeps the table from growing into a
-- gravesite of orphaned tracking data.

CREATE TABLE "ai_usage" (
    "userId" TEXT    NOT NULL,
    "action" TEXT    NOT NULL,
    "day"    TEXT    NOT NULL,
    "count"  INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("userId", "action", "day")
);

-- Day-bucket index for the nightly prune (DELETE WHERE day < N).
-- Without it, prune scans the whole table once usage rolls into year 2.
CREATE INDEX "ai_usage_day_idx" ON "ai_usage"("day");

ALTER TABLE "ai_usage"
  ADD CONSTRAINT "ai_usage_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
