-- v0.5.14 — Add free-text fallback for contract owners who are not LapseIQ users.
-- Form UI gates: either internalOwnerId is set (the User reference) OR
-- internalOwnerName is set (free-text fallback). Email is always optional.

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN "internalOwnerName"  TEXT;
ALTER TABLE "contracts" ADD COLUMN "internalOwnerEmail" TEXT;
