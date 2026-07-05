-- W8 fallback-masks-capture fixes (2026-07-05): three additive, nullable
-- provenance columns. Null = trustworthy (human-picked / report-stated);
-- 'unverified_default' = the ingest path silently fell back to a guess.
-- Same design as SystemStudy.studyDateSource (2026-07-05 arc-flash census).

ALTER TABLE "assets" ADD COLUMN "equipmentTypeSource" TEXT;
ALTER TABLE "work_orders" ADD COLUMN "testDateSource" TEXT;
ALTER TABLE "test_measurements" ADD COLUMN "sanityNote" TEXT;
