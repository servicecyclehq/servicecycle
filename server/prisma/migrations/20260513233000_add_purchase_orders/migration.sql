-- ── v0.10.0 (2026-05-13): multi-PO support ──────────────────────────────────
-- New purchase_orders table for the Microsoft MPSA / Adobe VIP pattern:
-- one master agreement (Contract.contractNumber) holding many deliverable POs.
-- Contract.poNumber stays in place as a single-PO compat shim; the new
-- purchase_orders rows are the authoritative source going forward. This
-- migration also backfills one PO row per non-null Contract.poNumber so
-- existing data is addressable through the new model immediately.

-- 1. Create the table.
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(14,2),
    "quantity" INTEGER,
    "orderDate" TIMESTAMP(3),
    "coverageStartDate" TIMESTAMP(3),
    "coverageEndDate" TIMESTAMP(3),
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- 2. Index for the hot list-on-Contract-Detail read path.
CREATE INDEX "purchase_orders_contractId_archivedAt_idx" ON "purchase_orders"("contractId", "archivedAt");

-- 3. Index for ordering POs by order date inside a contract.
CREATE INDEX "purchase_orders_contractId_orderDate_idx" ON "purchase_orders"("contractId", "orderDate");

-- 4. Index for the global search-by-PO path. Per-request scoping to the
--    user's accountId happens via the Contract join in the query layer.
CREATE INDEX "purchase_orders_poNumber_idx" ON "purchase_orders"("poNumber");

-- 5. FK with cascade so deleting a contract removes its POs. Matches the
--    schema's onDelete: Cascade declaration. Account-level scoping is
--    enforced at the query layer (PurchaseOrder has no accountId of its own
--    by design — it inherits from its Contract).
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_contractId_fkey"
    FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. Backfill: every contract with a non-null poNumber gets exactly one
--    PO row carrying that number forward. We pull amount/orderDate from
--    the contract's totalValue + startDate to preserve as much context
--    as we can; the operator can edit afterward. gen_random_uuid()
--    requires the pgcrypto extension which is enabled on the demo
--    droplet (see 20260428231905_init).
INSERT INTO "purchase_orders" (
    "id", "contractId", "poNumber", "description", "amount", "quantity",
    "orderDate", "coverageStartDate", "coverageEndDate",
    "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    c."id",
    c."poNumber",
    'Backfilled from contract.poNumber (v0.10.0 migration)',
    c."totalValue",
    c."quantity",
    c."startDate",
    c."startDate",
    c."endDate",
    NOW(),
    NOW()
FROM "contracts" c
WHERE c."poNumber" IS NOT NULL
  AND TRIM(c."poNumber") <> '';
