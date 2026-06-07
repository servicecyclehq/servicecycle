-- Phase 4 (v0.4.0) — backfill the legacy demo account so the hosted
-- demo at demo.lapseiq.com showcases the AI renewal brief out of the
-- box without requiring a manual flip after deploy.
--
-- The legacy demo account ID is hardcoded in server/scripts/seed-demo.js
-- (DEMO_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'). On
-- self-hosted instances no row with this ID exists, so this UPDATE is
-- a safe no-op there.
--
-- Per-visitor demo accounts (registered via /api/auth/register) get
-- aiBriefEnabled = (DEMO_MODE === 'true') at insert time — see the
-- branch in server/routes/auth.js. New per-visitor signups post-deploy
-- get the feature on; pre-deploy signups stay off until the 5-day
-- inactivity prune cycles them.
UPDATE "accounts" SET "aiBriefEnabled" = true
WHERE "id" = '11111111-1111-4111-8111-111111111111';
