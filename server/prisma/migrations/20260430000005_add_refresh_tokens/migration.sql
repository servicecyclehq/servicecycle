-- Migration: 20260430000005_add_refresh_tokens
-- Adds the refresh_tokens table for H4 (short-lived access tokens + rotating refresh tokens).

CREATE TABLE "refresh_tokens" (
  "id"            TEXT         NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "userId"        TEXT         NOT NULL,
  "tokenHash"     TEXT         NOT NULL,
  "expiresAt"     TIMESTAMP(3) NOT NULL,
  "revokedAt"     TIMESTAMP(3),
  "replacedById"  TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "refresh_tokens_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "refresh_tokens_userId_idx"     ON "refresh_tokens"("userId");
CREATE INDEX "refresh_tokens_tokenHash_idx"  ON "refresh_tokens"("tokenHash");
