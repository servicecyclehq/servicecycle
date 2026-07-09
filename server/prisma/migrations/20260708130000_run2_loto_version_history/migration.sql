-- 2026-07-08 Run 2 (W1-M4): LOTO append-only version history.
-- routes/loto.ts's PUT handler used to deleteMany+recreate LotoEnergySource/
-- LotoStep rows in place on every revision, permanently destroying the prior
-- OSHA 1910.147 procedure text. This adds a version stamp + isCurrent flag so
-- old rows are kept (isCurrent:false) instead of deleted; current-state reads
-- filter on isCurrent:true, GET /:id/history reads across all versions.
-- Guarded (IF NOT EXISTS), matching house style -- see
-- 20260708120000_audit_remediation_batch1.

ALTER TABLE "loto_energy_sources"
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "isCurrent" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "loto_steps"
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "isCurrent" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS "loto_energy_sources_lotoId_isCurrent_idx" ON "loto_energy_sources"("lotoId", "isCurrent");
CREATE INDEX IF NOT EXISTS "loto_steps_lotoId_isCurrent_idx" ON "loto_steps"("lotoId", "isCurrent");
