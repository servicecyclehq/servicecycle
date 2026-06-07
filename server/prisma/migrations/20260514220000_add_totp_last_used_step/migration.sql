-- Add TOTP replay-prevention column (H1 security hardening)
-- Stores the TOTP time-step used for the most recent successful 2FA verify-login.
-- The server rejects any code whose matched step <= this value, preventing
-- a captured code from being reused within the same or previous 30s window.
ALTER TABLE "users" ADD COLUMN "twoFactorLastUsedStep" BIGINT;
