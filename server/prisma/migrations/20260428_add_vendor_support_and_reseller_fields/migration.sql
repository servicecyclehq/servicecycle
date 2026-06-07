ALTER TABLE "vendors"
  ADD COLUMN "supportEmail"     TEXT,
  ADD COLUMN "supportPhone"     TEXT,
  ADD COLUMN "supportPortalUrl" TEXT;

ALTER TABLE "contracts"
  ADD COLUMN "resellerName"          TEXT,
  ADD COLUMN "resellerAccountNumber" TEXT,
  ADD COLUMN "resellerContactName"   TEXT,
  ADD COLUMN "resellerContactEmail"  TEXT;
