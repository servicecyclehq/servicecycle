-- v0.36.0 — Renewal Brief opt-in sections (2026-05-18)
--
-- Adds renewalBriefSectionsHash to "contracts" so the cached brief can
-- be invalidated when the admin toggles which opt-in sections to
-- include. Without this column the cache returns the old shape even
-- after a section toggle change — Settings would feel broken.
--
-- The hash is a stable short string derived from the enabled-slug list
-- (see server/lib/aiBrief/optInSections.js computeSectionsHash). When
-- the stored value diverges from the current AccountSetting-derived
-- hash, routes/contracts.js POST /:id/brief treats the cached brief as
-- stale and regenerates.
--
-- Nullable so legacy rows (briefs generated before this migration ran)
-- regenerate on their next refresh without a backfill step. The
-- account-level setting itself lives in account_settings (key/value
-- table) so no schema change is needed for the toggle storage.

ALTER TABLE "contracts"
  ADD COLUMN "renewalBriefSectionsHash" VARCHAR(32);
