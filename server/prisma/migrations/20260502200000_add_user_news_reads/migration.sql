-- Per-user news read state. Replaces the per-row vendor_news.isRead flag,
-- which had the data-model bug where any user marking a row as read flipped
-- it for the entire account. The old column is retained for graceful
-- migration; no read path consults it anymore.

CREATE TABLE "user_news_reads" (
  "id"     TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "newsId" TEXT NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_news_reads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_news_reads_userId_newsId_key" ON "user_news_reads"("userId", "newsId");
CREATE INDEX "user_news_reads_userId_idx" ON "user_news_reads"("userId");
CREATE INDEX "user_news_reads_newsId_idx" ON "user_news_reads"("newsId");

ALTER TABLE "user_news_reads"
  ADD CONSTRAINT "user_news_reads_newsId_fkey"
  FOREIGN KEY ("newsId") REFERENCES "vendor_news"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;