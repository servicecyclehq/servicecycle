-- Migration: add_contract_parent_index
-- v0.37.2 W6 MT-136. The renewal-chain self-join (Contract.parentContract /
-- Contract.renewals) walks parentContractId on every brief, dashboard, and
-- detail-page render. Without this index every walk is a full scan over the
-- account's contracts. Adding the @@index puts the lookup back on the
-- index-only path.

CREATE INDEX IF NOT EXISTS "contracts_parentContractId_idx"
  ON "contracts"("parentContractId");
