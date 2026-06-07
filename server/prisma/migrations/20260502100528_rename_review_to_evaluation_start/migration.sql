-- Rename review-tracking columns to evaluation-start naming for product clarity.
-- Non-destructive: uses ALTER COLUMN RENAME so existing data is preserved.
-- Also renames the foreign-key constraint to match the new column name.

ALTER TABLE "contracts" RENAME COLUMN "reviewByDate" TO "evaluationStartByDate";
ALTER TABLE "contracts" RENAME COLUMN "reviewStartedById" TO "evaluationStartedById";
ALTER TABLE "contracts" RENAME COLUMN "reviewStartedAt" TO "evaluationStartedAt";

ALTER TABLE "contracts" RENAME CONSTRAINT "contracts_reviewStartedById_fkey" TO "contracts_evaluationStartedById_fkey";