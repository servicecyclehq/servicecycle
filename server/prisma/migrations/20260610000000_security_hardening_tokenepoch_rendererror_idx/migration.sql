-- Security hardening pass (2026-06-09 audit) -- additive, non-destructive.
-- Hand-authored because the dev shadow DB cannot replay the historical
-- migration chain cleanly (pre-existing P1014 on 20260607100820_audit_readiness)
-- and the live dev DB carries unrelated column-casing drift. Touches ONLY the
-- two tables changed by the audit fixes, so it applies cleanly on a fresh
-- production DB via 'migrate deploy'.

-- L2: per-user monotonic token epoch. Access tokens embed it as the 'ep' claim;
-- the auth middleware rejects any token whose ep != the user's current epoch.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tokenEpoch" INTEGER NOT NULL DEFAULT 0;

-- L5: tenant-scoped index so admin error-telemetry dashboards stay index-backed.
CREATE INDEX IF NOT EXISTS "render_errors_accountId_occurredAt_idx" ON "render_errors"("accountId", "occurredAt");