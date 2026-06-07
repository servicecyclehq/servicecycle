-- v0.83.0: savings lever — nullable String, not Postgres enum, so future
-- lever additions don't require a migration. Values enforced at Zod layer.
ALTER TABLE "contracts" ADD COLUMN "savingsLever" TEXT;
