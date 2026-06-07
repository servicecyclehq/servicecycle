-- CreateTable: negotiation_cache
-- Stores AI debate verdicts so they survive server restarts.
-- One row per contract (UNIQUE contractId).
CREATE TABLE "negotiation_cache" (
    "id"          TEXT NOT NULL,
    "accountId"   TEXT NOT NULL,
    "contractId"  TEXT NOT NULL,
    "contextHash" TEXT NOT NULL,
    "result"      JSONB NOT NULL,
    "validUntil"  TIMESTAMP(3) NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "negotiation_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "negotiation_cache_contractId_key" ON "negotiation_cache"("contractId");
CREATE INDEX "negotiation_cache_accountId_idx"   ON "negotiation_cache"("accountId");
CREATE INDEX "negotiation_cache_validUntil_idx"  ON "negotiation_cache"("validUntil");

-- AddForeignKey
ALTER TABLE "negotiation_cache"
    ADD CONSTRAINT "negotiation_cache_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "negotiation_cache"
    ADD CONSTRAINT "negotiation_cache_contractId_fkey"
    FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
