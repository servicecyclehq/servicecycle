-- #27 NFPA 70B year-0 baseline: mark a work order as an acceptance / commissioning test.
-- Additive, non-breaking (default false).
ALTER TABLE "work_orders" ADD COLUMN "isAcceptanceTest" BOOLEAN NOT NULL DEFAULT false;
