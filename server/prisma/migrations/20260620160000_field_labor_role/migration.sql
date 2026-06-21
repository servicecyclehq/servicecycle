-- Field-labor / subcontractor login role + work-order assignment binding.
-- Additive only. New role value + nullable assignee FK on work_orders.

-- New role: field technician / subcontractor — assigned-jobs-only, NO pricing,
-- NO full customer list. Scope is enforced at the app layer (a default-deny
-- gate + the assignment-scoped /api/field surface). (PG12+ allows ADD VALUE
-- here; the value is not USED in this same migration, so no transaction
-- conflict.)
ALTER TYPE "UserRole" ADD VALUE 'field_tech';

-- Direct work-order -> login-user assignment. Distinct from assignedTechId
-- (which points at a ContractorTech record, not a login). A field_tech user
-- sees only work orders where assignedUserId = their id.
ALTER TABLE "work_orders" ADD COLUMN "assignedUserId" TEXT;
CREATE INDEX "work_orders_assignedUserId_idx" ON "work_orders"("assignedUserId");
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
