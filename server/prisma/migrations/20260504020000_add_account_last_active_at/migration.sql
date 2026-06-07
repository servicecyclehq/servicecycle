-- L3: Per-visitor demo accounts with 5-day inactivity TTL.
--
-- `lastActiveAt` is updated debounced (1/hour per account) by the auth
-- middleware. The nightly DEMO_MODE prune cron deletes accounts where
-- lastActiveAt < now() - 5 days OR (lastActiveAt IS NULL AND createdAt
-- < now() - 5 days). The COALESCE-style fallback to createdAt covers a
-- visitor who registered but never returned.
--
-- The index supports the prune query without scanning the full accounts
-- table once a busy demo accumulates hundreds of per-visitor sandboxes.

ALTER TABLE "accounts" ADD COLUMN "lastActiveAt" TIMESTAMP(3);

CREATE INDEX "accounts_lastActiveAt_idx" ON "accounts"("lastActiveAt");
