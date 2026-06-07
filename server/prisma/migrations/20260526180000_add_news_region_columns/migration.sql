-- v0.89.5 (2026-05-26): geographic intelligence for the news Outages tab.
-- Two additions:
--   1. vendor_news.region        : detected region of the article (set by
--      scanner from title text); nullable when undetectable.
--   2. accounts.newsOutageRegion : per-account filter preference. Default
--      'global' so existing accounts see no behavior change until the user
--      opts into a region in Settings.

ALTER TABLE "vendor_news" ADD COLUMN "region" TEXT;

ALTER TABLE "accounts" ADD COLUMN "newsOutageRegion" TEXT NOT NULL DEFAULT 'global';