-- Session 23-28: Modernization Revenue Engine + Alert Suite
-- Adds: Asset EOL fields, QuoteRequest.triggerType, ContractorTech QEMW fields,
--        ServiceRateCard table.

-- ── Asset: EOL / Obsolescence fields (Task 23) ────────────────────────────────
ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "endOfManufacture"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "endOfSupport"            TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "obsolescenceStatus"      TEXT,
  ADD COLUMN IF NOT EXISTS "criticalSparesAvailable" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "sparePartsLeadTimeDays"  INTEGER,
  ADD COLUMN IF NOT EXISTS "replacementCostCents"    INTEGER,
  ADD COLUMN IF NOT EXISTS "modernizationRiskScore"  DOUBLE PRECISION;

-- ── QuoteRequest: system trigger type (Tasks 23/25/26) ───────────────────────
ALTER TABLE "quote_requests"
  ADD COLUMN IF NOT EXISTS "triggerType" TEXT;

-- ── ContractorTech: QEMW credential fields (Task 26) ─────────────────────────
ALTER TABLE "contractor_techs"
  ADD COLUMN IF NOT EXISTS "qemwCertNumber"  TEXT,
  ADD COLUMN IF NOT EXISTS "qemwExpiresAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "qemwIssuingBody" TEXT;

-- ── ServiceRateCard: CapEx benchmark table (Task 24) ─────────────────────────
CREATE TABLE IF NOT EXISTS "service_rate_cards" (
  "id"           TEXT        NOT NULL,
  "partnerOrgId" TEXT,
  "accountId"    TEXT,
  "serviceType"  TEXT        NOT NULL,
  "minCents"     INTEGER     NOT NULL,
  "maxCents"     INTEGER     NOT NULL,
  "notes"        TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_rate_cards_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "service_rate_cards_partnerOrgId_idx" ON "service_rate_cards"("partnerOrgId");
CREATE INDEX IF NOT EXISTS "service_rate_cards_accountId_idx"    ON "service_rate_cards"("accountId");
CREATE INDEX IF NOT EXISTS "service_rate_cards_serviceType_idx"  ON "service_rate_cards"("serviceType");

-- ── Seed: default platform-level rate card (Task 24) ─────────────────────────
-- Using ON CONFLICT DO NOTHING so re-running the migration is safe.
-- serviceType string keys are stable — changing them requires a data migration.
INSERT INTO "service_rate_cards" ("id","serviceType","minCents","maxCents","notes","createdAt","updatedAt")
VALUES
  (gen_random_uuid(), 'ARC_FLASH_STUDY',           800000,  1500000, 'NFPA 70E §130.5 incident-energy analysis; PE-stamped. Includes equipment survey, arc-flash label updates, and coordination review.',             NOW(), NOW()),
  (gen_random_uuid(), 'SWITCHGEAR_MODERNIZATION',  1200000, 4500000, 'Bus replacement, vacuum interrupter upgrade, or full gear replacement. Highly site-specific; use mid-range for 12–15kV class.',                   NOW(), NOW()),
  (gen_random_uuid(), 'BREAKER_RETROFIT',           350000,  800000, 'Mechanically-retrofit replacement breaker into existing cubicle. OEM-dependent pricing; excludes MCC bucket replacements.',                       NOW(), NOW()),
  (gen_random_uuid(), 'TRANSFORMER_REPLACEMENT',   2500000,12000000, 'Includes pad-mount, unit substation, and network transformer classes. Lead time 26–52 weeks for units >1000 kVA.',                               NOW(), NOW()),
  (gen_random_uuid(), 'RELAY_UPGRADE',              200000,  600000, 'Electromechanical or solid-state to microprocessor-based SEL/GE replacement. Includes coordination study update.',                               NOW(), NOW()),
  (gen_random_uuid(), 'INSPECTION',                 150000,  400000, 'ANSI/NETA MTS annual or interval inspection. Range covers single cabinet to full switchgear lineup.',                                            NOW(), NOW()),
  (gen_random_uuid(), 'LOAD_STUDY',                 400000, 1200000, 'Power system load-flow and harmonic analysis; IEEE 519 deliverable. Per-site, not per-asset.',                                                   NOW(), NOW()),
  (gen_random_uuid(), 'QEMW_TRAINING',               80000,  250000, 'ANSI/NETA EMW-2026 QEMW classroom + hands-on training per tech. Range is per-technician. Group rates and on-site delivery available.',          NOW(), NOW())
ON CONFLICT DO NOTHING;
