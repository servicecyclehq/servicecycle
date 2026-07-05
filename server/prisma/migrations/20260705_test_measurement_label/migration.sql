-- [W2] Persist reading identity on TestMeasurement (2026-07-05).
-- Additive only: one new nullable column, no changes to any existing table.
--
-- Design approved by Dustin 2026-07-05 (docs/scoping/audits/afx-scenario-preservation.md,
-- W2 decision gate): one flexible free-text label column, not a per-domain
-- structured set of columns. The extractor (server/pyextract/extractor.py)
-- already computes this identity in most emit paths (DGA gas species,
-- winding-pair grid rows, PF bushing rows, battery cell rows) and
-- lib/commitTestReport.ts already READS it in-memory for deficiency
-- descriptions -- it was simply never written to the database row. This
-- migration + the accompanying commitTestReport.ts fix close that gap.

-- AlterTable
ALTER TABLE "test_measurements" ADD COLUMN "label" TEXT;
