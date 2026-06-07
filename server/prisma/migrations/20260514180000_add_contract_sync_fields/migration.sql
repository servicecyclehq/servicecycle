-- Migration: add cloud sync tracking fields to contracts
-- externalId: the provider's unique ID for this purchase (e.g. AWS agreement entity ID)
-- syncSource: which cloud provider synced this contract ('aws' | 'azure' | 'gcp')

ALTER TABLE "contracts" ADD COLUMN "externalId" TEXT;
ALTER TABLE "contracts" ADD COLUMN "syncSource" TEXT;

-- Index for efficient dedup lookups during sync
CREATE INDEX "contracts_accountId_syncSource_externalId_idx"
  ON "contracts"("accountId", "syncSource", "externalId")
  WHERE "externalId" IS NOT NULL;
