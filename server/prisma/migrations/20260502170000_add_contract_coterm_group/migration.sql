-- (A1 5/02) Co-term group identifier on Contract.
-- Free-text grouping field — contracts sharing the same value belong to the
-- same co-term group. Surfaces combined renewal value on the Contracts list
-- (Co-Term view mode) and Dashboard.
--
-- Backfill is a no-op: existing rows get NULL, which the application treats
-- as "no co-term group". Operators can populate via the Contract Detail
-- edit form when they identify groupings.

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN "coTermGroup" TEXT;

-- CreateIndex
CREATE INDEX "contracts_accountId_coTermGroup_idx"
  ON "contracts"("accountId", "coTermGroup");
