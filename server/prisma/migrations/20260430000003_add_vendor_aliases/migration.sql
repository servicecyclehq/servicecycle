-- AddColumn: vendor aliases (JSON array of org-specific alternate names / procurement codes)
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "aliases" JSONB;
