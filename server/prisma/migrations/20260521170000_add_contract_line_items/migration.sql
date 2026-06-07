-- Migration: add_contract_line_items
-- v0.55.0 — multi-SKU per-line renewal planning.
--
-- Adds one new table (contract_line_items) and runs an idempotent backfill
-- from the existing Contract row's (product, quantity, costPerLicense,
-- budgetNeededQty) tuple. Legacy columns stay populated (and stay written
-- to) so the contracts-list query keeps working; we'll deprecate them
-- behind a feature flag in v0.57+.
--
-- See: docs/design/renewal-planning-persistence-v047.md (§2.1, §2.4)

-- ── Table ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "contract_line_items" (
  "id"                    TEXT          NOT NULL,
  "contractId"            TEXT          NOT NULL,
  "sku"                   TEXT,
  "productName"           TEXT          NOT NULL,
  "originalCount"         INTEGER       NOT NULL,
  "originalCostPerUnit"   DECIMAL(12,4),
  "plannedNewCount"       INTEGER,
  "plannedNewCostPerUnit" DECIMAL(12,4),
  "notes"                 TEXT,
  "sortOrder"             INTEGER       NOT NULL DEFAULT 0,
  "archivedAt"            TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3)  NOT NULL,
  "lastEditedById"        TEXT,

  CONSTRAINT "contract_line_items_pkey" PRIMARY KEY ("id")
);

-- ── FK constraints (idempotent via DO/EXCEPTION pattern) ─────────────────
DO $$ BEGIN
  ALTER TABLE "contract_line_items"
    ADD CONSTRAINT "contract_line_items_contractId_fkey"
    FOREIGN KEY ("contractId") REFERENCES "contracts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "contract_line_items"
    ADD CONSTRAINT "contract_line_items_lastEditedById_fkey"
    FOREIGN KEY ("lastEditedById") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Indexes ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "contract_line_items_contractId_archivedAt_idx"
  ON "contract_line_items"("contractId", "archivedAt");

CREATE INDEX IF NOT EXISTS "contract_line_items_contractId_sortOrder_idx"
  ON "contract_line_items"("contractId", "sortOrder");

-- ── Idempotent backfill ──────────────────────────────────────────────────
-- For every Contract with both product and quantity set, insert one
-- ContractLineItem unless one already exists (idempotent across re-runs).
--
-- gen_random_uuid() is the Postgres-native UUID v4 generator (pgcrypto, an
-- extension we already use). Casting to text matches Prisma's @default(uuid()).
INSERT INTO "contract_line_items" (
  "id",
  "contractId",
  "productName",
  "originalCount",
  "originalCostPerUnit",
  "plannedNewCount",
  "sortOrder",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  c."product",
  c."quantity",
  c."costPerLicense",
  c."budgetNeededQty",
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "contracts" c
WHERE c."product" IS NOT NULL
  AND c."quantity" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "contract_line_items" li
    WHERE li."contractId" = c."id"
      AND li."archivedAt" IS NULL
  );
