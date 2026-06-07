-- Pass-4 compliance audit, L3-07 + L3-08 (2026-05-17)
--
-- AI consent previously recorded only a timestamp (aiConsentDismissedAt).
-- The legal effect of that record was anchored to "the user clicked the
-- modal at time T" without recording WHAT they consented to or WHICH
-- provider the disclosure named. If the consent text changed, prior
-- consents were silently grandfathered; if the operator swapped
-- AI_PROVIDER from Anthropic to OpenAI, every existing user's consent
-- silently re-scoped to the new provider.
--
-- This migration adds two columns so the consent record is auditable
-- and re-prompt logic can fire when either changes:
--
--   aiConsentVersion              — opaque version string stamped at
--                                   acknowledgment time (e.g.
--                                   "ai-consent-2026-05-17") so future
--                                   changes to the modal text bump it
--                                   and force re-prompt.
--   aiConsentProviderAtAcceptance — provider string at acceptance time
--                                   ("anthropic" | "openai" | "azure_openai"
--                                   | "gemini"). When the active provider
--                                   diverges from this, the server gate
--                                   forces a re-prompt before any AI call.
--
-- Both columns are nullable so existing rows continue to work; rows where
-- aiConsentDismissedAt is non-null but the new columns are null are
-- treated as legacy-grandfathered (a one-time forgiveness window — the
-- next AI call will re-prompt them so they can be backfilled cleanly).

ALTER TABLE "users"
  ADD COLUMN "aiConsentVersion"              VARCHAR(64),
  ADD COLUMN "aiConsentProviderAtAcceptance" VARCHAR(32);
