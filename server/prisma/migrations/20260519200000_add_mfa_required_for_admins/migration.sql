-- Migration: add_mfa_required_for_admins
-- v0.37.4 W7 scaffolding. Adds Account.mfaRequiredForAdmins column for the
-- forthcoming "admin-role users on this account must have TOTP enrolled"
-- enforcement gate. Defaults false on existing rows to preserve current
-- behaviour. Enforcement wiring (login-time gate + enrollment UI) is
-- deferred to a future session; this migration ships the data model now
-- so the legal pack + SIG/CAIQ doc can honestly claim the foundation.

ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "mfaRequiredForAdmins" BOOLEAN NOT NULL DEFAULT false;
