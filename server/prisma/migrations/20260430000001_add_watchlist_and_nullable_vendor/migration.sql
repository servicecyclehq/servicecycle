-- Migration: add_watchlist_and_nullable_vendor
-- Makes vendorId nullable in vendor_news (for watch-term matched items),
-- adds watchTerm and userId columns, updates unique constraint,
-- and creates user_news_watches table.

-- 1. Make vendorId nullable
ALTER TABLE "vendor_news" ALTER COLUMN "vendorId" DROP NOT NULL;

-- 2. Add watchTerm column (null for vendor-matched items)
ALTER TABLE "vendor_news" ADD COLUMN IF NOT EXISTS "watchTerm" TEXT;

-- 3. Add userId column (null for vendor-matched items)
ALTER TABLE "vendor_news" ADD COLUMN IF NOT EXISTS "userId" TEXT;

-- 4. Drop the old unique constraint (accountId, url) and replace with (accountId, url, userId)
--    The old constraint name was set by Prisma — match it here
ALTER TABLE "vendor_news" DROP CONSTRAINT IF EXISTS "vendor_news_accountId_url_key";
ALTER TABLE "vendor_news" ADD CONSTRAINT "vendor_news_accountId_url_userId_key"
  UNIQUE ("accountId", "url", "userId");

-- 5. Add index on userId for watch-term queries
CREATE INDEX IF NOT EXISTS "vendor_news_userId_idx" ON "vendor_news"("userId");

-- 6. Create user_news_watches table
CREATE TABLE IF NOT EXISTS "user_news_watches" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "term"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_news_watches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_news_watches_userId_term_key"
  ON "user_news_watches"("userId", "term");

CREATE INDEX IF NOT EXISTS "user_news_watches_userId_idx"
  ON "user_news_watches"("userId");

ALTER TABLE "user_news_watches"
  ADD CONSTRAINT "user_news_watches_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
