-- Migration: add_vendor_type
-- Adds an optional vendorType string column to the vendors table.
-- Stored as a plain nullable text column; the fixed picklist is enforced
-- at the application layer (routes + UI), not at the DB level, so it can
-- be extended without a schema migration.

ALTER TABLE "vendors" ADD COLUMN "vendorType" TEXT;
