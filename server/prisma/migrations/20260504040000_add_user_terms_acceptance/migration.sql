-- L7+legal: terms-acceptance audit trail on User.
--
-- We need to be able to prove (a) that a given user accepted the ToS +
-- Privacy Policy at the moment of registration, and (b) which version of
-- those documents they accepted -- in case the lawyer-reviewed wording
-- changes later and a dispute arises about which version applied.
--
-- Both columns are nullable so existing pre-L7 demo and on-prem users
-- continue to work without a backfill ritual; new registrations populate
-- both.

ALTER TABLE "users"
  ADD COLUMN "acceptedTermsAt"      TIMESTAMP(3),
  ADD COLUMN "acceptedTermsVersion" TEXT;
