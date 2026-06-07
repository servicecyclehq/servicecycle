-- CreateTable VendorNews
CREATE TABLE "vendor_news" (
    "id"          TEXT        NOT NULL,
    "accountId"   TEXT        NOT NULL,
    "vendorId"    TEXT        NOT NULL,
    "title"       TEXT        NOT NULL,
    "url"         TEXT        NOT NULL,
    "source"      TEXT        NOT NULL,
    "summary"     TEXT,
    "category"    TEXT        NOT NULL DEFAULT 'general',
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isRead"      BOOLEAN     NOT NULL DEFAULT false,

    CONSTRAINT "vendor_news_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one copy of each article per account
CREATE UNIQUE INDEX "vendor_news_accountId_url_key" ON "vendor_news"("accountId", "url");

-- Indexes for common query patterns
CREATE INDEX "vendor_news_accountId_idx"            ON "vendor_news"("accountId");
CREATE INDEX "vendor_news_vendorId_idx"             ON "vendor_news"("vendorId");
CREATE INDEX "vendor_news_accountId_publishedAt_idx" ON "vendor_news"("accountId", "publishedAt" DESC);

-- Foreign Keys
ALTER TABLE "vendor_news"
    ADD CONSTRAINT "vendor_news_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "vendor_news"
    ADD CONSTRAINT "vendor_news_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
