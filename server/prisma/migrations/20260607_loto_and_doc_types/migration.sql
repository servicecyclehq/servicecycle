-- Migration: LOTO procedures + document type classification
-- Adds DocType, LotoStatus, EnergyType enums; docType + externalUrl columns
-- on documents; and the three LOTO tables (loto_procs, loto_energy_sources,
-- loto_steps).

-- ── DocType enum ────────────────────────────────────────────────────────────
CREATE TYPE "DocType" AS ENUM (
  'oem_manual',
  'wiring_diagram',
  'loto_pdf',
  'test_report',
  'inspection_report',
  'commissioning_report',
  'warranty',
  'other'
);

-- ── Document table additions ─────────────────────────────────────────────────
ALTER TABLE "documents" ADD COLUMN "docType"     "DocType";
ALTER TABLE "documents" ADD COLUMN "externalUrl" TEXT;

-- ── LotoStatus enum ─────────────────────────────────────────────────────────
CREATE TYPE "LotoStatus" AS ENUM ('draft', 'active', 'archived');

-- ── EnergyType enum ─────────────────────────────────────────────────────────
CREATE TYPE "EnergyType" AS ENUM (
  'electrical',
  'pneumatic',
  'hydraulic',
  'mechanical',
  'thermal',
  'chemical',
  'gravity'
);

-- ── loto_procs ───────────────────────────────────────────────────────────────
CREATE TABLE "loto_procs" (
  "id"           TEXT         NOT NULL,
  "accountId"    TEXT         NOT NULL,
  "assetId"      TEXT         NOT NULL,
  "title"        TEXT         NOT NULL,
  "status"       "LotoStatus" NOT NULL DEFAULT 'draft',
  "version"      INTEGER      NOT NULL DEFAULT 1,
  "approvedById" TEXT,
  "approvedAt"   TIMESTAMP(3),
  "notes"        TEXT,
  "createdById"  TEXT         NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "loto_procs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "loto_procs"
  ADD CONSTRAINT "loto_procs_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "loto_procs_assetId_fkey"
    FOREIGN KEY ("assetId")   REFERENCES "assets"("id")   ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "loto_procs_approvedById_fkey"
    FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "loto_procs_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id")  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "loto_procs_accountId_idx"        ON "loto_procs"("accountId");
CREATE INDEX "loto_procs_assetId_idx"           ON "loto_procs"("assetId");
CREATE INDEX "loto_procs_accountId_status_idx"  ON "loto_procs"("accountId", "status");

-- ── loto_energy_sources ──────────────────────────────────────────────────────
CREATE TABLE "loto_energy_sources" (
  "id"                 TEXT         NOT NULL,
  "lotoId"             TEXT         NOT NULL,
  "accountId"          TEXT         NOT NULL,
  "energyType"         "EnergyType" NOT NULL,
  "description"        TEXT         NOT NULL,
  "isolationPoint"     TEXT         NOT NULL,
  "isolationMethod"    TEXT         NOT NULL,
  "verificationMethod" TEXT         NOT NULL,
  "sortOrder"          INTEGER      NOT NULL DEFAULT 0,
  CONSTRAINT "loto_energy_sources_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "loto_energy_sources"
  ADD CONSTRAINT "loto_energy_sources_lotoId_fkey"
    FOREIGN KEY ("lotoId")    REFERENCES "loto_procs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "loto_energy_sources_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "accounts"("id")   ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "loto_energy_sources_lotoId_idx"    ON "loto_energy_sources"("lotoId");
CREATE INDEX "loto_energy_sources_accountId_idx" ON "loto_energy_sources"("accountId");

-- ── loto_steps ───────────────────────────────────────────────────────────────
CREATE TABLE "loto_steps" (
  "id"                   TEXT         NOT NULL,
  "lotoId"               TEXT         NOT NULL,
  "accountId"            TEXT         NOT NULL,
  "sortOrder"            INTEGER      NOT NULL,
  "instruction"          TEXT         NOT NULL,
  "category"             TEXT         NOT NULL DEFAULT 'lockout',
  "requiresVerification" BOOLEAN      NOT NULL DEFAULT false,
  CONSTRAINT "loto_steps_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "loto_steps"
  ADD CONSTRAINT "loto_steps_lotoId_fkey"
    FOREIGN KEY ("lotoId")    REFERENCES "loto_procs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "loto_steps_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "accounts"("id")   ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "loto_steps_lotoId_idx"    ON "loto_steps"("lotoId");
CREATE INDEX "loto_steps_accountId_idx" ON "loto_steps"("accountId");
