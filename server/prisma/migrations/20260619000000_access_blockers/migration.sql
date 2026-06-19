-- Missing-access / open-items blocker log (stretch feature).
-- Additive: one new table, no changes to existing tables.
CREATE TABLE "access_blockers" (
  "id"           TEXT NOT NULL,
  "accountId"    TEXT NOT NULL,
  "siteId"       TEXT,
  "assetId"      TEXT,
  "kind"         TEXT NOT NULL,
  "description"  TEXT,
  "status"       TEXT NOT NULL DEFAULT 'open',
  "createdById"  TEXT,
  "resolvedById" TEXT,
  "resolvedAt"   TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "access_blockers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "access_blockers_accountId_status_idx" ON "access_blockers"("accountId", "status");
CREATE INDEX "access_blockers_assetId_idx" ON "access_blockers"("assetId");

ALTER TABLE "access_blockers" ADD CONSTRAINT "access_blockers_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "access_blockers" ADD CONSTRAINT "access_blockers_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "access_blockers" ADD CONSTRAINT "access_blockers_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "access_blockers" ADD CONSTRAINT "access_blockers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "access_blockers" ADD CONSTRAINT "access_blockers_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;