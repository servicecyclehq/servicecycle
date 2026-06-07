-- Migration: add_user_preferences
-- v0.42. Per-user key/value store so saved views, column visibility, and
-- other UI personalization follow the user across browsers / devices
-- (previously every site used localStorage, which only worked on the
-- single browser where the user last opened the page).
--
-- Composite (userId, key) is unique so the API can upsert without race
-- conditions. value is JSONB so callers can stash arbitrary shape without
-- schema churn. Cascade on user delete keeps the GDPR Art. 17 erase path
-- simple - preferences aren't audit-relevant.

CREATE TABLE IF NOT EXISTS "user_preferences" (
  "id"        TEXT         NOT NULL,
  "userId"    TEXT         NOT NULL,
  "key"       TEXT         NOT NULL,
  "value"     JSONB        NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "user_preferences"
    ADD CONSTRAINT "user_preferences_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "user_preferences_userId_key_key"
  ON "user_preferences"("userId", "key");

CREATE INDEX IF NOT EXISTS "user_preferences_userId_idx"
  ON "user_preferences"("userId");