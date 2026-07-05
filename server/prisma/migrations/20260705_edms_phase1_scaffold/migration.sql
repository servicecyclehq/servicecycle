-- EDMS Phase 1 scaffold (2026-07-05, feat/edms-phase-1 branch -- NOT on main,
-- NOT applied to the droplet). See docs/scoping/EDMS_MODULE_SCOPE_2026-07-04.md
-- §5/§19 Phase 1: schema + storage foundation only.
--
-- Purely additive: 3 nullable columns on existing tables + 6 new tables, zero
-- drops/renames/NOT-NULL-without-default. Hand-extracted from a
-- `prisma migrate diff` run against a throwaway shadow DB
-- (servicecycle_shadow_edms, created + dropped for verification only -- never
-- touched dev or prod data). That diff ALSO surfaced pre-existing unrelated
-- drift (DropForeignKey on access_blockers; RenameConstraint/RenameIndex on
-- failed_login_attempts / rate_sheet / work_order_part_usages / WorkOrder) --
-- same drift flagged in the 20260705_protection_curves and
-- 20260705_ingest_job_checkpoint migrations earlier tonight. Deliberately
-- EXCLUDED here; still needs separate investigation (see the recap memo).
--
-- One deliberate hand-edit vs. the raw diff output: `drawing_page_texts.tsvector`
-- is written below as a proper Postgres GENERATED column + GIN index (per the
-- scope doc's own worked example), not the bare `tsvector` column type Prisma's
-- `Unsupported("tsvector")` emits by default -- Prisma can't express the
-- GENERATED ALWAYS AS clause, so this line is authored by hand.

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "edmsSettings" JSONB;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "currentRevisionId" TEXT;

-- AlterTable
ALTER TABLE "sites" ADD COLUMN     "retentionPolicy" JSONB;

-- CreateTable
CREATE TABLE "drawing_revisions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "revNo" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sourceFormat" TEXT NOT NULL DEFAULT 'pdf',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3),
    "supersededDate" TIMESTAMP(3),
    "supersededByRevNo" INTEGER,
    "workflowState" TEXT NOT NULL DEFAULT 'draft',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionNote" TEXT,
    "revisionNote" TEXT,
    "isSealed" BOOLEAN NOT NULL DEFAULT false,
    "sealDetails" JSONB,
    "originalSourceKey" TEXT,
    "originalFormat" TEXT,
    "immutable" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "drawing_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drawing_annotations" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "page" INTEGER NOT NULL,
    "geometry" JSONB NOT NULL,
    "text" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "drawing_annotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drawing_symbol_links" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "boundingBox" JSONB NOT NULL,
    "assetId" TEXT NOT NULL,
    "linkedBy" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drawing_symbol_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drawing_share_links" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "requireAuth" BOOLEAN NOT NULL DEFAULT false,
    "canComment" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "accessLog" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "drawing_share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable (tsvector is a GENERATED column, not a Prisma-writable one --
-- see header comment)
CREATE TABLE "drawing_page_texts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "tsvector" tsvector GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "extractionMethod" TEXT NOT NULL,

    CONSTRAINT "drawing_page_texts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drawing_revision_seals" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "signatureIndex" INTEGER NOT NULL DEFAULT 0,
    "signerCommonName" TEXT,
    "signerOrg" TEXT,
    "peLicenseNumber" TEXT,
    "certChainValid" BOOLEAN,
    "timestampValid" BOOLEAN,
    "revocationStatus" TEXT,
    "selfSignedCert" BOOLEAN NOT NULL DEFAULT false,
    "validationOutcome" TEXT NOT NULL,
    "rawResult" JSONB,
    "validatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drawing_revision_seals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "drawing_revisions_accountId_idx" ON "drawing_revisions"("accountId");

-- CreateIndex
CREATE INDEX "drawing_revisions_documentId_idx" ON "drawing_revisions"("documentId");

-- CreateIndex
CREATE INDEX "drawing_revisions_workflowState_idx" ON "drawing_revisions"("workflowState");

-- CreateIndex
CREATE UNIQUE INDEX "drawing_revisions_documentId_revNo_key" ON "drawing_revisions"("documentId", "revNo");

-- CreateIndex
CREATE INDEX "drawing_annotations_accountId_idx" ON "drawing_annotations"("accountId");

-- CreateIndex
CREATE INDEX "drawing_annotations_revisionId_idx" ON "drawing_annotations"("revisionId");

-- CreateIndex
CREATE INDEX "drawing_symbol_links_accountId_idx" ON "drawing_symbol_links"("accountId");

-- CreateIndex
CREATE INDEX "drawing_symbol_links_revisionId_page_idx" ON "drawing_symbol_links"("revisionId", "page");

-- CreateIndex
CREATE INDEX "drawing_symbol_links_assetId_idx" ON "drawing_symbol_links"("assetId");

-- CreateIndex
CREATE INDEX "drawing_share_links_accountId_idx" ON "drawing_share_links"("accountId");

-- CreateIndex
CREATE INDEX "drawing_share_links_revisionId_idx" ON "drawing_share_links"("revisionId");

-- CreateIndex
CREATE INDEX "drawing_share_links_expiresAt_idx" ON "drawing_share_links"("expiresAt");

-- CreateIndex
CREATE INDEX "drawing_page_texts_accountId_idx" ON "drawing_page_texts"("accountId");

-- CreateIndex
CREATE INDEX "drawing_page_texts_revisionId_idx" ON "drawing_page_texts"("revisionId");

-- CreateIndex (GIN, per EDMS_MODULE_SCOPE_2026-07-04.md §5)
CREATE INDEX "drawing_page_texts_tsv_gin" ON "drawing_page_texts" USING GIN ("tsvector");

-- CreateIndex
CREATE INDEX "drawing_revision_seals_accountId_idx" ON "drawing_revision_seals"("accountId");

-- CreateIndex
CREATE INDEX "drawing_revision_seals_revisionId_idx" ON "drawing_revision_seals"("revisionId");
