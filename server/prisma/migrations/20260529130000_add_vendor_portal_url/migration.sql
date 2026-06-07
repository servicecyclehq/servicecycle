-- #12 contract-section-refresh: vendor access/login portal URL.
-- Editable from the contract "License Keys & Access" card; applies to all of
-- this vendor's contracts. Nullable, additive.
ALTER TABLE "vendors" ADD COLUMN "portalUrl" TEXT;
