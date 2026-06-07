-- v0.69.0 (audit Medium + Quick Win): two schema changes in one batch.
--
-- (1) ActivityLog -> Account FK: the activity_logs.accountId column existed
--     as a String? (Pass-6 W4 MT-127 denormalization) but had no FK
--     constraint, so a forgeable row with a bogus accountId could pass the
--     hash-chain verifier. Add the FK with ON DELETE SET NULL so account
--     deletion via the GDPR/account-close path doesn't cascade-delete the
--     historical audit trail.
ALTER TABLE "activity_logs"
  ADD CONSTRAINT "activity_logs_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- (2) User.onboardingStep: persist the OnboardingWizard step on the user
--     row so the wizard resumes across devices. Default 0 covers existing
--     users.
ALTER TABLE "users"
  ADD COLUMN "onboardingStep" INTEGER NOT NULL DEFAULT 0;
