-- Migration: add autoRenewalNoticeDays to Contract
-- How many days notice the vendor requires to cancel an auto-renewing contract.
-- Used by the Risk Radar 'trap' bucket and cancelByDate computation in seed-demo.

ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "autoRenewalNoticeDays" INTEGER;