-- Phase 3 #7: bi-directional public API.
-- (1) Per-key scopes. Existing keys default to read-only so the write surface
--     is opt-in -- a key must be minted (or is implicitly) 'read' until granted 'write'.
ALTER TABLE "api_keys" ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY['read']::TEXT[];

-- (2) Idempotency store so a CMMS can safely retry a write (POST) without
--     creating duplicate work orders. Unique per (account, key).
CREATE TABLE "api_idempotency_keys" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "api_idempotency_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_idempotency_keys_accountId_idempotencyKey_key" ON "api_idempotency_keys"("accountId", "idempotencyKey");
CREATE INDEX "api_idempotency_keys_createdAt_idx" ON "api_idempotency_keys"("createdAt");

ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
