-- Slice E: arc-flash source / system model (utility/transformer/motor/generator)
-- + structured cable fields. All additive; the source model is one-per-study.

-- CreateTable
CREATE TABLE "study_source_models" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "utilityMaxFaultKA" DECIMAL(10,2),
    "utilityMinFaultKA" DECIMAL(10,2),
    "utilityXr" DECIMAL(10,2),
    "transformerKva" DECIMAL(12,2),
    "transformerPrimaryV" INTEGER,
    "transformerSecondaryV" INTEGER,
    "transformerImpedancePct" DECIMAL(6,2),
    "transformerXr" DECIMAL(10,2),
    "transformerConnection" TEXT,
    "motorContributionHp" INTEGER,
    "motorContributionCount" INTEGER,
    "generatorKva" DECIMAL(12,2),
    "generatorVoltageV" INTEGER,
    "generatorSubtransientXdPct" DECIMAL(6,2),
    "below125kvaFlag" BOOLEAN,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "study_source_models_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "study_source_models_studyId_key" ON "study_source_models"("studyId");
CREATE INDEX "study_source_models_accountId_idx" ON "study_source_models"("accountId");
CREATE INDEX "study_source_models_siteId_idx" ON "study_source_models"("siteId");

-- AddForeignKey
ALTER TABLE "study_source_models" ADD CONSTRAINT "study_source_models_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "system_studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: structured cable fields on the draft + durable per-study record.
ALTER TABLE "arc_flash_ingest_buses" ADD COLUMN "conductorsPerPhase" INTEGER,
                                     ADD COLUMN "conduitType" TEXT;
ALTER TABLE "system_study_assets"    ADD COLUMN "conductorsPerPhase" INTEGER,
                                     ADD COLUMN "conduitType" TEXT;
