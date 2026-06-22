-- Slice 3.5c: live QR/NFC label-as-portal + printed-vs-current mismatch.
-- Additive: a public token (the QR/NFC credential), a snapshot of the label
-- values at print time, and when it was printed.
ALTER TABLE "system_study_assets" ADD COLUMN "publicToken" TEXT;
ALTER TABLE "system_study_assets" ADD COLUMN "printedSnapshot" JSONB;
ALTER TABLE "system_study_assets" ADD COLUMN "printedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "system_study_assets_publicToken_key" ON "system_study_assets"("publicToken");
