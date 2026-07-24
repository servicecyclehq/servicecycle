-- Attribution for lab-sample commits (2026-07-24 audit-coverage pass): which
-- user entered/committed this DGA/oil/fuel result. Previously uncaptured
-- anywhere -- no field on the row, no activity-log entry.
ALTER TABLE "lab_samples" ADD COLUMN "enteredById" TEXT;