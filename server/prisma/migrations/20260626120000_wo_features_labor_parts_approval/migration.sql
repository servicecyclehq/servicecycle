-- Migration: 20260626120000_wo_features_labor_parts_approval
-- Features: WorkOrderType enum, labor cost tracking, AWAITING_APPROVAL status,
--           approval workflow fields, WorkOrderPartUsage join table,
--           FailedLoginAttempt model (SEC5 DB-backed lockout).

-- ── Feature 1: WorkOrderType enum ────────────────────────────────────────────
CREATE TYPE "WorkOrderType" AS ENUM ('PREVENTIVE', 'CORRECTIVE', 'EMERGENCY', 'INSPECTION');

ALTER TABLE "work_orders" ADD COLUMN "workOrderType" "WorkOrderType" NOT NULL DEFAULT 'PREVENTIVE';

-- ── Feature 2: Labor cost tracking ───────────────────────────────────────────
ALTER TABLE "work_orders" ADD COLUMN "laborHours" DECIMAL(6,2);
ALTER TABLE "work_orders" ADD COLUMN "laborCostCents" INTEGER;

-- ── Feature 3: Work order approval workflow ───────────────────────────────────
-- Add AWAITING_APPROVAL to the status enum (PostgreSQL ALTER TYPE ADD VALUE is
-- non-transactional and cannot run inside a transaction block; it is safe here
-- because this is the only statement touching the enum in this migration).
ALTER TYPE "WorkOrderStatus" ADD VALUE 'AWAITING_APPROVAL';

ALTER TABLE "work_orders" ADD COLUMN "approvedBy" TEXT;
ALTER TABLE "work_orders" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "work_orders" ADD COLUMN "approvalNote" TEXT;

-- ── Feature 4: WorkOrderPartUsage join table ──────────────────────────────────
CREATE TABLE "work_order_part_usages" (
  "id"            TEXT         NOT NULL,
  "workOrderId"   TEXT         NOT NULL,
  "partId"        TEXT         NOT NULL,
  "quantityUsed"  INTEGER      NOT NULL DEFAULT 1,
  "unitCostCents" INTEGER,
  "notes"         TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "accountId"     TEXT         NOT NULL,
  CONSTRAINT "WorkOrderPartUsage_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "work_order_part_usages"
  ADD CONSTRAINT "WorkOrderPartUsage_workOrderId_fkey"
  FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_order_part_usages"
  ADD CONSTRAINT "WorkOrderPartUsage_partId_fkey"
  FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "work_order_part_usages"
  ADD CONSTRAINT "WorkOrderPartUsage_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "WorkOrderPartUsage_workOrderId_idx" ON "work_order_part_usages"("workOrderId");
CREATE INDEX "WorkOrderPartUsage_partId_idx"      ON "work_order_part_usages"("partId");
CREATE INDEX "WorkOrderPartUsage_accountId_idx"   ON "work_order_part_usages"("accountId");

-- ── Feature 5: FailedLoginAttempt (SEC5 — DB-backed lockout) ─────────────────
CREATE TABLE "failed_login_attempts" (
  "id"          TEXT         NOT NULL,
  "email"       TEXT         NOT NULL,
  "ipAddress"   TEXT,
  "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "accountId"   TEXT,
  CONSTRAINT "FailedLoginAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FailedLoginAttempt_email_idx"       ON "failed_login_attempts"("email");
CREATE INDEX "FailedLoginAttempt_attemptedAt_idx" ON "failed_login_attempts"("attemptedAt");
