-- AddColumn: savings tracker, negotiation log, license utilization, signature tracking, archive

ALTER TABLE "contracts" ADD COLUMN "originalAsk"          DECIMAL(12, 2);
ALTER TABLE "contracts" ADD COLUMN "finalNegotiatedPrice"  DECIMAL(12, 2);
ALTER TABLE "contracts" ADD COLUMN "negotiationLog"        TEXT;
ALTER TABLE "contracts" ADD COLUMN "seatsLicensed"         INTEGER;
ALTER TABLE "contracts" ADD COLUMN "seatsActivelyInUse"    INTEGER;
ALTER TABLE "contracts" ADD COLUMN "annualUpliftPercent"   DECIMAL(5, 2);
ALTER TABLE "contracts" ADD COLUMN "signatureStatus"       TEXT;
ALTER TABLE "contracts" ADD COLUMN "signedAt"              TIMESTAMP(3);
ALTER TABLE "contracts" ADD COLUMN "signerName"            TEXT;
ALTER TABLE "contracts" ADD COLUMN "archivedAt"            TIMESTAMP(3);
ALTER TABLE "contracts" ADD COLUMN "archivedById"          TEXT;
