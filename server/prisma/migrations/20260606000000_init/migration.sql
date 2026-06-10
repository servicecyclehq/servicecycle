-- ============================================================================
-- Squashed baseline migration (2026-06-10).
-- Replaces the original 14-migration chain, whose timestamps did not match
-- table dependency order (e.g. 20260607100820_audit_readiness altered
-- compliance_snapshots, created later in 20260607142446) so a fresh
-- 'prisma migrate deploy' failed with P3018 / 42P01. Regenerated directly
-- from prisma/schema.prisma via 'migrate diff --from-empty', which emits
-- enums -> tables -> indexes -> FKs in dependency order, guaranteeing a clean
-- replay on an empty database. Includes the 2026-06-09 security-audit schema
-- changes (users.tokenEpoch, render_errors composite index).
-- ============================================================================
-- CreateEnum
CREATE TYPE "QuoteDriver" AS ENUM ('down_now', 'suspected_failing', 'failed_inspection', 'planned_replacement', 'budgetary');

-- CreateEnum
CREATE TYPE "QuoteTimeline" AS ENUM ('immediately', 'within_1_week', 'within_30_days', 'next_budget_cycle');

-- CreateEnum
CREATE TYPE "QuoteRequestStatus" AS ENUM ('requested', 'quoted', 'accepted', 'declined');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('active', 'expiring', 'lapsed', 'read_only', 'inactive');

-- CreateEnum
CREATE TYPE "PlanType" AS ENUM ('saas', 'licensed');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('small', 'mid', 'enterprise');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'manager', 'viewer', 'consultant', 'oem_admin', 'super_admin');

-- CreateEnum
CREATE TYPE "EquipmentType" AS ENUM ('TRANSFORMER_LIQUID', 'TRANSFORMER_DRY', 'SWITCHGEAR', 'SWITCHBOARD', 'PANELBOARD', 'BUSWAY', 'GENERATOR', 'MOTOR', 'MCC', 'VFD', 'UPS_BATTERY', 'BATTERY_SYSTEM', 'CIRCUIT_BREAKER', 'FUSE_GEAR', 'DISCONNECT_SWITCH', 'TRANSFER_SWITCH', 'PROTECTION_RELAY', 'GROUND_FAULT_PROTECTION', 'SURGE_ARRESTER', 'CABLE_LV', 'CABLE_MV_HV', 'CABLE_TRAY', 'GROUNDING_SYSTEM', 'EMERGENCY_LIGHTING', 'ARC_FLASH_PANEL', 'FIRE_PUMP_CONTROLLER');

-- CreateEnum
CREATE TYPE "ConditionRating" AS ENUM ('C1', 'C2', 'C3');

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ResultRating" AS ENUM ('GREEN', 'YELLOW', 'RED');

-- CreateEnum
CREATE TYPE "DeficiencySeverity" AS ENUM ('IMMEDIATE', 'RECOMMENDED', 'ADVISORY');

-- CreateEnum
CREATE TYPE "NetaCertLevel" AS ENUM ('LEVEL_I', 'LEVEL_II', 'LEVEL_III', 'LEVEL_IV');

-- CreateEnum
CREATE TYPE "CommunicationType" AS ENUM ('call', 'email_thread', 'meeting', 'note');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('maintenance_due', 'overdue', 'escalation', 'regulatory_breach');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('pending', 'sent', 'acknowledged', 'escalated', 'cancelled');

-- CreateEnum
CREATE TYPE "IngestionStatus" AS ENUM ('processing', 'review_pending', 'approved', 'imported', 'failed');

-- CreateEnum
CREATE TYPE "PartnerEventType" AS ENUM ('IMMEDIATE_DEFICIENCY', 'INSPECTION_COMPLETED', 'QUOTE_REQUEST_CREATED', 'TASK_OVERDUE');

-- CreateEnum
CREATE TYPE "RetentionTier" AS ENUM ('STANDARD', 'HEALTHCARE', 'UTILITY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('oem_manual', 'wiring_diagram', 'loto_pdf', 'test_report', 'inspection_report', 'commissioning_report', 'warranty', 'other');

-- CreateEnum
CREATE TYPE "LotoStatus" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "EnergyType" AS ENUM ('electrical', 'pneumatic', 'hydraulic', 'mechanical', 'thermal', 'chemical', 'gravity');

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'active',
    "planType" "PlanType" NOT NULL,
    "planTier" "PlanTier",
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "stripeSubscriptionStatus" TEXT,
    "stripeCurrentPeriodEnd" TIMESTAMP(3),
    "licenseDate" TIMESTAMP(3),
    "supportExpiresAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3),
    "aiBriefEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaRequiredForAdmins" BOOLEAN NOT NULL DEFAULT false,
    "serviceRepName" TEXT,
    "serviceRepEmail" TEXT,
    "serviceRepPhone" TEXT,
    "partnerOrgId" TEXT,
    "assignedRepId" TEXT,
    "fallbackRepId" TEXT,
    "retentionTier" "RetentionTier" NOT NULL DEFAULT 'STANDARD',
    "retentionCustomYears" INTEGER,
    "fteCount" INTEGER,
    "importWebhookUrl" TEXT,
    "importWebhookSecret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "primaryColor" TEXT,
    "website" TEXT,
    "webhookUrl" TEXT,
    "webhookSecret" TEXT,
    "digestIntervalDays" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "tokenEpoch" INTEGER NOT NULL DEFAULT 0,
    "passwordResetToken" TEXT,
    "passwordResetExpiresAt" TIMESTAMP(3),
    "lastLogin" TIMESTAMP(3),
    "twoFactorSecret" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorBackupCodes" TEXT,
    "twoFactorLastUsedStep" BIGINT,
    "featureFlags" JSONB,
    "hiddenFeatures" JSONB,
    "assetScopeRestricted" BOOLEAN NOT NULL DEFAULT false,
    "onboardingStep" INTEGER NOT NULL DEFAULT 0,
    "acceptedTermsAt" TIMESTAMP(3),
    "acceptedTermsVersion" TEXT,
    "aiConsentDismissedAt" TIMESTAMP(3),
    "aiConsentSilenced" BOOLEAN NOT NULL DEFAULT false,
    "aiConsentVersion" TEXT,
    "aiConsentProviderAtAcceptance" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contractors" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "netaAccredited" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "supportEmail" TEXT,
    "supportPhone" TEXT,
    "supportPortalUrl" TEXT,
    "portalUrl" TEXT,
    "scoreSupport" INTEGER,
    "scoreSatisfaction" INTEGER,
    "aliases" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contractors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contractor_techs" (
    "id" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "title" TEXT,
    "netaCertLevel" "NetaCertLevel",
    "qualifiedPersonDesignatedAt" TIMESTAMP(3),
    "trainingExpiresAt" TIMESTAMP(3),
    "thermographerCertLevel" TEXT,
    "qemwCertNumber" TEXT,
    "qemwExpiresAt" TIMESTAMP(3),
    "qemwIssuingBody" TEXT,
    "lastContactedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contractor_techs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "primaryContactName" TEXT,
    "primaryContactEmail" TEXT,
    "primaryContactPhone" TEXT,
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildings" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buildings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "areas" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "buildingId" TEXT,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment_positions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "areaId" TEXT,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "equipment_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "buildingId" TEXT,
    "areaId" TEXT,
    "positionId" TEXT,
    "equipmentType" "EquipmentType" NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "nameplateData" JSONB,
    "installDate" TIMESTAMP(3),
    "lastCommissionedDate" TIMESTAMP(3),
    "conditionPhysical" "ConditionRating" NOT NULL DEFAULT 'C2',
    "conditionCriticality" "ConditionRating" NOT NULL DEFAULT 'C2',
    "conditionEnvironment" "ConditionRating" NOT NULL DEFAULT 'C2',
    "ownerId" TEXT,
    "fedFromAssetId" TEXT,
    "criticalityScore" INTEGER,
    "conditionScore" INTEGER,
    "priorityScore" INTEGER,
    "repairCostEstimate" DECIMAL(14,2),
    "spareLeadTimeWeeks" INTEGER,
    "redundancyStatus" TEXT,
    "requiresPredictiveMaintenance" BOOLEAN NOT NULL DEFAULT false,
    "governingCondition" "ConditionRating" NOT NULL DEFAULT 'C2',
    "inService" BOOLEAN NOT NULL DEFAULT true,
    "isEnergized" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "endOfManufacture" TIMESTAMP(3),
    "endOfSupport" TIMESTAMP(3),
    "obsolescenceStatus" TEXT,
    "criticalSparesAvailable" BOOLEAN,
    "sparePartsLeadTimeDays" INTEGER,
    "replacementCostCents" INTEGER,
    "modernizationRiskScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_standards" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "edition" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "keyMandate" TEXT,
    "revisionCycle" TEXT,
    "effectiveDate" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "sourceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_standards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_task_definitions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "standardId" TEXT,
    "equipmentType" "EquipmentType" NOT NULL,
    "taskName" TEXT NOT NULL,
    "taskCode" TEXT NOT NULL,
    "description" TEXT,
    "intervalC1Months" INTEGER,
    "intervalC2Months" INTEGER NOT NULL,
    "intervalC3Months" INTEGER,
    "requiresOutage" BOOLEAN NOT NULL DEFAULT false,
    "requiresEnergized" BOOLEAN NOT NULL DEFAULT false,
    "requiresNetaCertified" BOOLEAN NOT NULL DEFAULT false,
    "netaCertLevelMin" "NetaCertLevel",
    "standardRef" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenance_task_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_schedules" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "taskDefinitionId" TEXT NOT NULL,
    "lastCompletedDate" TIMESTAMP(3),
    "nextDueDate" TIMESTAMP(3),
    "leadTimeSchedulingDays" INTEGER NOT NULL DEFAULT 180,
    "leadTimeCustomerDays" INTEGER NOT NULL DEFAULT 90,
    "conditionOverride" "ConditionRating",
    "lastPerformedByName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenance_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_orders" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "scheduleId" TEXT,
    "assetId" TEXT NOT NULL,
    "contractorId" TEXT,
    "assignedTechId" TEXT,
    "netaCertLevel" "NetaCertLevel",
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledDate" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedDate" TIMESTAMP(3),
    "asFoundCondition" "ConditionRating",
    "asLeftCondition" "ConditionRating",
    "netaDecal" "ResultRating",
    "ambientTempC" DECIMAL(5,1),
    "humidityPct" DECIMAL(5,1),
    "testEquipment" JSONB,
    "reportPdfUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_measurements" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "measurementType" TEXT NOT NULL,
    "phase" TEXT,
    "asFoundValue" DECIMAL(16,4),
    "asFoundUnit" TEXT,
    "asLeftValue" DECIMAL(16,4),
    "asLeftUnit" TEXT,
    "passFail" "ResultRating",
    "expectedRange" TEXT,
    "testVoltage" TEXT,
    "loadPercent" DECIMAL(5,1),
    "severityPriority" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_measurements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deficiencies" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "workOrderId" TEXT,
    "assetId" TEXT NOT NULL,
    "severity" "DeficiencySeverity" NOT NULL,
    "description" TEXT NOT NULL,
    "correctiveAction" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deficiencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_studies" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "studyType" TEXT NOT NULL DEFAULT 'arc_flash',
    "performedDate" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "performedBy" TEXT,
    "method" TEXT,
    "peName" TEXT,
    "peLicense" TEXT,
    "trigger" TEXT,
    "reportPdfUrl" TEXT,
    "notes" TEXT,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_studies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_visits" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT,
    "auditType" TEXT NOT NULL,
    "auditorName" TEXT,
    "auditorOrg" TEXT,
    "scheduledDate" TIMESTAMP(3),
    "performedDate" TIMESTAMP(3),
    "outcome" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_recommendations" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "auditVisitId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'insurer',
    "severity" TEXT NOT NULL DEFAULT 'recommendation',
    "description" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'open',
    "responseNotes" TEXT,
    "respondedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "assignedToUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_samples" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "workOrderId" TEXT,
    "sampleType" TEXT NOT NULL,
    "sampleDate" TIMESTAMP(3) NOT NULL,
    "labName" TEXT,
    "h2" DECIMAL(10,2),
    "ch4" DECIMAL(10,2),
    "c2h2" DECIMAL(10,2),
    "c2h4" DECIMAL(10,2),
    "c2h6" DECIMAL(10,2),
    "co" DECIMAL(10,2),
    "co2" DECIMAL(10,2),
    "o2" DECIMAL(10,2),
    "n2" DECIMAL(10,2),
    "ieeeStatus" INTEGER,
    "faultCode" TEXT,
    "resultsData" JSONB,
    "resultRating" "ResultRating",
    "reportPdfUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lab_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blackout_windows" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "isOutageWindow" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blackout_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "standard_revision_alerts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "standardId" TEXT NOT NULL,
    "newEdition" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "summary" TEXT,
    "affectedScheduleCount" INTEGER,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "standard_revision_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_snapshots" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT,
    "standardCode" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'compliance',
    "auditVisitId" TEXT,
    "generatedById" TEXT,
    "filename" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "sha256" TEXT NOT NULL,
    "stats" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "news_items" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'industry',
    "summary" TEXT,
    "matchedTerm" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "news_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "assetId" TEXT,
    "workOrderId" TEXT,
    "accountId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "docType" "DocType",
    "externalUrl" TEXT,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communications" (
    "id" TEXT NOT NULL,
    "assetId" TEXT,
    "contractorId" TEXT,
    "accountId" TEXT NOT NULL,
    "type" "CommunicationType" NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "alertType" "AlertType" NOT NULL,
    "leadDays" INTEGER,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "status" "AlertStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "alertType" "AlertType" NOT NULL,
    "daysBeforeList" TEXT NOT NULL DEFAULT '180,120,90,60,30,7',
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_sessions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "documentId" TEXT,
    "originalFilename" TEXT NOT NULL,
    "rawText" TEXT,
    "extractedFields" JSONB,
    "confidenceScores" JSONB,
    "aiNotes" JSONB,
    "status" "IngestionStatus" NOT NULL DEFAULT 'processing',
    "reviewedBy" TEXT,
    "reviewCompletedAt" TIMESTAMP(3),
    "importedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" TEXT NOT NULL,
    "assetId" TEXT,
    "userId" TEXT,
    "accountId" TEXT,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prevHash" TEXT,
    "rowHash" TEXT,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_settings" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "early_access_requests" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT,
    "timing" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "early_access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("userId","action","day")
);

-- CreateTable
CREATE TABLE "consultant_accesses" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "consultantId" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,

    CONSTRAINT "consultant_accesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_invites" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "invitedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_logs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "filename" TEXT,
    "sizeBytes" INTEGER,
    "storageKey" TEXT,
    "error" TEXT,
    "triggeredBy" TEXT NOT NULL DEFAULT 'cron',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instance_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "setupCompletedAt" TIMESTAMP(3),
    "setupCompletedBy" TEXT,
    "demoMode" BOOLEAN NOT NULL DEFAULT false,
    "demoLastResetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instance_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_definitions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "helpText" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_values" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "value" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL,
    "hmacSecret" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_webhook_dlq" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "webhookEndpointId" TEXT,
    "deliveryId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "targetUrlMasked" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastStatus" INTEGER,
    "firstFailedAt" TIMESTAMP(3) NOT NULL,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_webhook_dlq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT,
    "assetId" TEXT,
    "channel" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "alertCount" INTEGER,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "render_errors" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'render',
    "errorCode" TEXT NOT NULL,
    "name" TEXT,
    "message" TEXT,
    "stack" TEXT,
    "componentStack" TEXT,
    "path" TEXT,
    "userId" TEXT,
    "accountId" TEXT,
    "userAgent" TEXT,
    "appVersion" TEXT,
    "ip" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "render_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_requests" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "QuoteRequestStatus" NOT NULL DEFAULT 'requested',
    "driver" "QuoteDriver" NOT NULL,
    "timeline" "QuoteTimeline" NOT NULL,
    "outageAvailable" BOOLEAN,
    "outageWindow" TEXT,
    "budgeted" BOOLEAN,
    "budgetNotes" TEXT,
    "attachmentNotes" TEXT,
    "emergencyMode" BOOLEAN NOT NULL DEFAULT false,
    "triggerType" TEXT,
    "dossierSnapshot" JSONB,
    "notes" TEXT,
    "priority" TEXT,
    "quotedAt" TIMESTAMP(3),
    "quoteNotes" TEXT,
    "respondedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quote_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loto_procs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "LotoStatus" NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loto_procs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loto_energy_sources" (
    "id" TEXT NOT NULL,
    "lotoId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "energyType" "EnergyType" NOT NULL,
    "description" TEXT NOT NULL,
    "isolationPoint" TEXT NOT NULL,
    "isolationMethod" TEXT NOT NULL,
    "verificationMethod" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "loto_energy_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loto_steps" (
    "id" TEXT NOT NULL,
    "lotoId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "instruction" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'lockout',
    "requiresVerification" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "loto_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disaster_events" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "eventType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "affectedStates" TEXT[],
    "affectedSiteIds" TEXT[],
    "nwsAlertId" TEXT,
    "declaredBy" TEXT,
    "source" TEXT NOT NULL DEFAULT 'system',
    "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "disaster_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "statusCode" INTEGER,
    "responseMs" INTEGER,
    "error" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_templates" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "equipmentType" "EquipmentType" NOT NULL,
    "defaultCriticalityScore" INTEGER,
    "defaultRedundancyStatus" TEXT,
    "defaultRequiresPredictiveMaintenance" BOOLEAN NOT NULL DEFAULT false,
    "nameplateDefaults" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_template_tasks" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "taskDefinitionId" TEXT NOT NULL,

    CONSTRAINT "asset_template_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_rate_cards" (
    "id" TEXT NOT NULL,
    "partnerOrgId" TEXT,
    "accountId" TEXT,
    "serviceType" TEXT NOT NULL,
    "minCents" INTEGER NOT NULL,
    "maxCents" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_invites" (
    "id" TEXT NOT NULL,
    "partnerOrgId" TEXT NOT NULL,
    "inviteeEmail" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "accountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_event_logs" (
    "id" TEXT NOT NULL,
    "partnerOrgId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "eventType" "PartnerEventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "assignedRepId" TEXT,
    "digestSentAt" TIMESTAMP(3),
    "immediateEmailSentAt" TIMESTAMP(3),
    "webhookSentAt" TIMESTAMP(3),
    "webhookAttempts" INTEGER NOT NULL DEFAULT 0,
    "webhookLastFailedAt" TIMESTAMP(3),
    "seenAt" TIMESTAMP(3),
    "actionedAt" TIMESTAMP(3),
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_event_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_accountId_idx" ON "users"("accountId");

-- CreateIndex
CREATE INDEX "users_passwordResetToken_idx" ON "users"("passwordResetToken");

-- CreateIndex
CREATE INDEX "user_preferences_userId_idx" ON "user_preferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_userId_key_key" ON "user_preferences"("userId", "key");

-- CreateIndex
CREATE INDEX "contractors_accountId_idx" ON "contractors"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "contractors_accountId_name_key" ON "contractors"("accountId", "name");

-- CreateIndex
CREATE INDEX "contractor_techs_contractorId_idx" ON "contractor_techs"("contractorId");

-- CreateIndex
CREATE INDEX "sites_accountId_idx" ON "sites"("accountId");

-- CreateIndex
CREATE INDEX "sites_accountId_archivedAt_idx" ON "sites"("accountId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "sites_accountId_name_key" ON "sites"("accountId", "name");

-- CreateIndex
CREATE INDEX "buildings_accountId_idx" ON "buildings"("accountId");

-- CreateIndex
CREATE INDEX "buildings_siteId_idx" ON "buildings"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "buildings_siteId_name_key" ON "buildings"("siteId", "name");

-- CreateIndex
CREATE INDEX "areas_accountId_idx" ON "areas"("accountId");

-- CreateIndex
CREATE INDEX "areas_siteId_idx" ON "areas"("siteId");

-- CreateIndex
CREATE INDEX "areas_buildingId_idx" ON "areas"("buildingId");

-- CreateIndex
CREATE UNIQUE INDEX "areas_siteId_name_key" ON "areas"("siteId", "name");

-- CreateIndex
CREATE INDEX "equipment_positions_accountId_idx" ON "equipment_positions"("accountId");

-- CreateIndex
CREATE INDEX "equipment_positions_siteId_idx" ON "equipment_positions"("siteId");

-- CreateIndex
CREATE INDEX "equipment_positions_areaId_idx" ON "equipment_positions"("areaId");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_positions_siteId_name_key" ON "equipment_positions"("siteId", "name");

-- CreateIndex
CREATE INDEX "assets_accountId_idx" ON "assets"("accountId");

-- CreateIndex
CREATE INDEX "assets_accountId_siteId_idx" ON "assets"("accountId", "siteId");

-- CreateIndex
CREATE INDEX "assets_accountId_equipmentType_idx" ON "assets"("accountId", "equipmentType");

-- CreateIndex
CREATE INDEX "assets_accountId_archivedAt_idx" ON "assets"("accountId", "archivedAt");

-- CreateIndex
CREATE INDEX "assets_positionId_idx" ON "assets"("positionId");

-- CreateIndex
CREATE INDEX "assets_fedFromAssetId_idx" ON "assets"("fedFromAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_standards_code_edition_key" ON "compliance_standards"("code", "edition");

-- CreateIndex
CREATE INDEX "maintenance_task_definitions_equipmentType_idx" ON "maintenance_task_definitions"("equipmentType");

-- CreateIndex
CREATE INDEX "maintenance_task_definitions_accountId_idx" ON "maintenance_task_definitions"("accountId");

-- CreateIndex
CREATE INDEX "maintenance_task_definitions_standardId_idx" ON "maintenance_task_definitions"("standardId");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_task_definitions_accountId_equipmentType_taskCo_key" ON "maintenance_task_definitions"("accountId", "equipmentType", "taskCode");

-- CreateIndex
CREATE INDEX "maintenance_schedules_accountId_idx" ON "maintenance_schedules"("accountId");

-- CreateIndex
CREATE INDEX "maintenance_schedules_accountId_nextDueDate_idx" ON "maintenance_schedules"("accountId", "nextDueDate");

-- CreateIndex
CREATE INDEX "maintenance_schedules_accountId_isActive_nextDueDate_idx" ON "maintenance_schedules"("accountId", "isActive", "nextDueDate");

-- CreateIndex
CREATE INDEX "maintenance_schedules_assetId_idx" ON "maintenance_schedules"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_schedules_assetId_taskDefinitionId_key" ON "maintenance_schedules"("assetId", "taskDefinitionId");

-- CreateIndex
CREATE INDEX "work_orders_accountId_idx" ON "work_orders"("accountId");

-- CreateIndex
CREATE INDEX "work_orders_accountId_status_idx" ON "work_orders"("accountId", "status");

-- CreateIndex
CREATE INDEX "work_orders_accountId_scheduledDate_idx" ON "work_orders"("accountId", "scheduledDate");

-- CreateIndex
CREATE INDEX "work_orders_assetId_idx" ON "work_orders"("assetId");

-- CreateIndex
CREATE INDEX "work_orders_scheduleId_idx" ON "work_orders"("scheduleId");

-- CreateIndex
CREATE INDEX "work_orders_contractorId_idx" ON "work_orders"("contractorId");

-- CreateIndex
CREATE INDEX "test_measurements_accountId_idx" ON "test_measurements"("accountId");

-- CreateIndex
CREATE INDEX "test_measurements_workOrderId_idx" ON "test_measurements"("workOrderId");

-- CreateIndex
CREATE INDEX "deficiencies_accountId_idx" ON "deficiencies"("accountId");

-- CreateIndex
CREATE INDEX "deficiencies_accountId_severity_resolvedAt_idx" ON "deficiencies"("accountId", "severity", "resolvedAt");

-- CreateIndex
CREATE INDEX "deficiencies_assetId_idx" ON "deficiencies"("assetId");

-- CreateIndex
CREATE INDEX "deficiencies_workOrderId_idx" ON "deficiencies"("workOrderId");

-- CreateIndex
CREATE INDEX "system_studies_accountId_idx" ON "system_studies"("accountId");

-- CreateIndex
CREATE INDEX "system_studies_accountId_expiresAt_idx" ON "system_studies"("accountId", "expiresAt");

-- CreateIndex
CREATE INDEX "system_studies_siteId_studyType_idx" ON "system_studies"("siteId", "studyType");

-- CreateIndex
CREATE INDEX "audit_visits_accountId_performedDate_idx" ON "audit_visits"("accountId", "performedDate" DESC);

-- CreateIndex
CREATE INDEX "audit_visits_siteId_idx" ON "audit_visits"("siteId");

-- CreateIndex
CREATE INDEX "audit_recommendations_accountId_status_dueDate_idx" ON "audit_recommendations"("accountId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "audit_recommendations_auditVisitId_idx" ON "audit_recommendations"("auditVisitId");

-- CreateIndex
CREATE INDEX "lab_samples_accountId_idx" ON "lab_samples"("accountId");

-- CreateIndex
CREATE INDEX "lab_samples_assetId_sampleDate_idx" ON "lab_samples"("assetId", "sampleDate");

-- CreateIndex
CREATE INDEX "lab_samples_workOrderId_idx" ON "lab_samples"("workOrderId");

-- CreateIndex
CREATE INDEX "blackout_windows_accountId_idx" ON "blackout_windows"("accountId");

-- CreateIndex
CREATE INDEX "blackout_windows_siteId_startsAt_idx" ON "blackout_windows"("siteId", "startsAt");

-- CreateIndex
CREATE INDEX "standard_revision_alerts_accountId_acknowledgedAt_idx" ON "standard_revision_alerts"("accountId", "acknowledgedAt");

-- CreateIndex
CREATE INDEX "standard_revision_alerts_standardId_idx" ON "standard_revision_alerts"("standardId");

-- CreateIndex
CREATE INDEX "compliance_snapshots_accountId_createdAt_idx" ON "compliance_snapshots"("accountId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "news_items_url_key" ON "news_items"("url");

-- CreateIndex
CREATE INDEX "news_items_publishedAt_idx" ON "news_items"("publishedAt" DESC);

-- CreateIndex
CREATE INDEX "news_items_category_publishedAt_idx" ON "news_items"("category", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "documents_accountId_idx" ON "documents"("accountId");

-- CreateIndex
CREATE INDEX "documents_assetId_idx" ON "documents"("assetId");

-- CreateIndex
CREATE INDEX "documents_workOrderId_idx" ON "documents"("workOrderId");

-- CreateIndex
CREATE INDEX "documents_accountId_filePath_idx" ON "documents"("accountId", "filePath");

-- CreateIndex
CREATE INDEX "communications_accountId_idx" ON "communications"("accountId");

-- CreateIndex
CREATE INDEX "communications_assetId_idx" ON "communications"("assetId");

-- CreateIndex
CREATE INDEX "alerts_accountId_idx" ON "alerts"("accountId");

-- CreateIndex
CREATE INDEX "alerts_assetId_idx" ON "alerts"("assetId");

-- CreateIndex
CREATE INDEX "alerts_accountId_status_idx" ON "alerts"("accountId", "status");

-- CreateIndex
CREATE INDEX "alerts_scheduledAt_status_idx" ON "alerts"("scheduledAt", "status");

-- CreateIndex
CREATE INDEX "alerts_scheduleId_alertType_leadDays_status_idx" ON "alerts"("scheduleId", "alertType", "leadDays", "status");

-- CreateIndex
CREATE INDEX "alert_preferences_userId_idx" ON "alert_preferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "alert_preferences_userId_alertType_key" ON "alert_preferences"("userId", "alertType");

-- CreateIndex
CREATE INDEX "ingestion_sessions_accountId_idx" ON "ingestion_sessions"("accountId");

-- CreateIndex
CREATE INDEX "activity_logs_assetId_idx" ON "activity_logs"("assetId");

-- CreateIndex
CREATE INDEX "activity_logs_assetId_createdAt_idx" ON "activity_logs"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_action_createdAt_idx" ON "activity_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_accountId_createdAt_idx" ON "activity_logs"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_rowHash_idx" ON "activity_logs"("rowHash");

-- CreateIndex
CREATE INDEX "account_settings_accountId_idx" ON "account_settings"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "account_settings_accountId_key_key" ON "account_settings"("accountId", "key");

-- CreateIndex
CREATE INDEX "early_access_requests_createdAt_idx" ON "early_access_requests"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "early_access_requests_email_idx" ON "early_access_requests"("email");

-- CreateIndex
CREATE INDEX "ai_usage_day_idx" ON "ai_usage"("day");

-- CreateIndex
CREATE INDEX "consultant_accesses_accountId_idx" ON "consultant_accesses"("accountId");

-- CreateIndex
CREATE INDEX "consultant_accesses_consultantId_idx" ON "consultant_accesses"("consultantId");

-- CreateIndex
CREATE UNIQUE INDEX "user_invites_token_key" ON "user_invites"("token");

-- CreateIndex
CREATE INDEX "user_invites_accountId_idx" ON "user_invites"("accountId");

-- CreateIndex
CREATE INDEX "user_invites_token_idx" ON "user_invites"("token");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_tokenHash_idx" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "backup_logs_accountId_idx" ON "backup_logs"("accountId");

-- CreateIndex
CREATE INDEX "backup_logs_createdAt_idx" ON "backup_logs"("createdAt");

-- CreateIndex
CREATE INDEX "custom_field_definitions_accountId_idx" ON "custom_field_definitions"("accountId");

-- CreateIndex
CREATE INDEX "custom_field_definitions_accountId_archivedAt_displayOrder_idx" ON "custom_field_definitions"("accountId", "archivedAt", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_accountId_fieldKey_key" ON "custom_field_definitions"("accountId", "fieldKey");

-- CreateIndex
CREATE INDEX "custom_field_values_assetId_idx" ON "custom_field_values"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_values_assetId_definitionId_key" ON "custom_field_values"("assetId", "definitionId");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_accountId_idx" ON "api_keys"("accountId");

-- CreateIndex
CREATE INDEX "api_keys_accountId_revokedAt_idx" ON "api_keys"("accountId", "revokedAt");

-- CreateIndex
CREATE INDEX "webhook_endpoints_accountId_idx" ON "webhook_endpoints"("accountId");

-- CreateIndex
CREATE INDEX "outbound_webhook_dlq_accountId_createdAt_idx" ON "outbound_webhook_dlq"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "outbound_webhook_dlq_createdAt_idx" ON "outbound_webhook_dlq"("createdAt");

-- CreateIndex
CREATE INDEX "outbound_webhook_dlq_deliveryId_idx" ON "outbound_webhook_dlq"("deliveryId");

-- CreateIndex
CREATE INDEX "notification_logs_accountId_sentAt_idx" ON "notification_logs"("accountId", "sentAt" DESC);

-- CreateIndex
CREATE INDEX "notification_logs_assetId_sentAt_idx" ON "notification_logs"("assetId", "sentAt" DESC);

-- CreateIndex
CREATE INDEX "notification_logs_sentAt_idx" ON "notification_logs"("sentAt");

-- CreateIndex
CREATE INDEX "render_errors_occurredAt_idx" ON "render_errors"("occurredAt");

-- CreateIndex
CREATE INDEX "render_errors_errorCode_idx" ON "render_errors"("errorCode");

-- CreateIndex
CREATE INDEX "render_errors_userId_idx" ON "render_errors"("userId");

-- CreateIndex
CREATE INDEX "render_errors_kind_idx" ON "render_errors"("kind");

-- CreateIndex
CREATE INDEX "render_errors_accountId_occurredAt_idx" ON "render_errors"("accountId", "occurredAt");

-- CreateIndex
CREATE INDEX "quote_requests_accountId_idx" ON "quote_requests"("accountId");

-- CreateIndex
CREATE INDEX "quote_requests_accountId_status_idx" ON "quote_requests"("accountId", "status");

-- CreateIndex
CREATE INDEX "quote_requests_assetId_idx" ON "quote_requests"("assetId");

-- CreateIndex
CREATE INDEX "quote_requests_requestedById_idx" ON "quote_requests"("requestedById");

-- CreateIndex
CREATE INDEX "loto_procs_accountId_idx" ON "loto_procs"("accountId");

-- CreateIndex
CREATE INDEX "loto_procs_assetId_idx" ON "loto_procs"("assetId");

-- CreateIndex
CREATE INDEX "loto_procs_accountId_status_idx" ON "loto_procs"("accountId", "status");

-- CreateIndex
CREATE INDEX "loto_energy_sources_lotoId_idx" ON "loto_energy_sources"("lotoId");

-- CreateIndex
CREATE INDEX "loto_energy_sources_accountId_idx" ON "loto_energy_sources"("accountId");

-- CreateIndex
CREATE INDEX "loto_steps_lotoId_idx" ON "loto_steps"("lotoId");

-- CreateIndex
CREATE INDEX "loto_steps_accountId_idx" ON "loto_steps"("accountId");

-- CreateIndex
CREATE INDEX "disaster_events_accountId_idx" ON "disaster_events"("accountId");

-- CreateIndex
CREATE INDEX "disaster_events_resolvedAt_idx" ON "disaster_events"("resolvedAt");

-- CreateIndex
CREATE INDEX "disaster_events_nwsAlertId_idx" ON "disaster_events"("nwsAlertId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_accountId_createdAt_idx" ON "webhook_deliveries"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "asset_templates_accountId_idx" ON "asset_templates"("accountId");

-- CreateIndex
CREATE INDEX "asset_templates_equipmentType_idx" ON "asset_templates"("equipmentType");

-- CreateIndex
CREATE UNIQUE INDEX "asset_template_tasks_templateId_taskDefinitionId_key" ON "asset_template_tasks"("templateId", "taskDefinitionId");

-- CreateIndex
CREATE INDEX "service_rate_cards_partnerOrgId_idx" ON "service_rate_cards"("partnerOrgId");

-- CreateIndex
CREATE INDEX "service_rate_cards_accountId_idx" ON "service_rate_cards"("accountId");

-- CreateIndex
CREATE INDEX "service_rate_cards_serviceType_idx" ON "service_rate_cards"("serviceType");

-- CreateIndex
CREATE UNIQUE INDEX "partner_invites_tokenHash_key" ON "partner_invites"("tokenHash");

-- CreateIndex
CREATE INDEX "partner_invites_partnerOrgId_idx" ON "partner_invites"("partnerOrgId");

-- CreateIndex
CREATE INDEX "partner_invites_invitedById_idx" ON "partner_invites"("invitedById");

-- CreateIndex
CREATE INDEX "partner_invites_inviteeEmail_idx" ON "partner_invites"("inviteeEmail");

-- CreateIndex
CREATE INDEX "partner_event_logs_partnerOrgId_idx" ON "partner_event_logs"("partnerOrgId");

-- CreateIndex
CREATE INDEX "partner_event_logs_accountId_idx" ON "partner_event_logs"("accountId");

-- CreateIndex
CREATE INDEX "partner_event_logs_partnerOrgId_archived_digestSentAt_idx" ON "partner_event_logs"("partnerOrgId", "archived", "digestSentAt");

-- CreateIndex
CREATE INDEX "partner_event_logs_accountId_eventType_createdAt_idx" ON "partner_event_logs"("accountId", "eventType", "createdAt");

-- CreateIndex
CREATE INDEX "partner_event_logs_assignedRepId_digestSentAt_idx" ON "partner_event_logs"("assignedRepId", "digestSentAt");

-- CreateIndex
CREATE INDEX "partner_event_logs_archived_createdAt_idx" ON "partner_event_logs"("archived", "createdAt");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_partnerOrgId_fkey" FOREIGN KEY ("partnerOrgId") REFERENCES "partner_organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_assignedRepId_fkey" FOREIGN KEY ("assignedRepId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_fallbackRepId_fkey" FOREIGN KEY ("fallbackRepId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractors" ADD CONSTRAINT "contractors_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_techs" ADD CONSTRAINT "contractor_techs_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "areas" ADD CONSTRAINT "areas_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "areas" ADD CONSTRAINT "areas_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_positions" ADD CONSTRAINT "equipment_positions_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_positions" ADD CONSTRAINT "equipment_positions_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "equipment_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_fedFromAssetId_fkey" FOREIGN KEY ("fedFromAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_task_definitions" ADD CONSTRAINT "maintenance_task_definitions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_task_definitions" ADD CONSTRAINT "maintenance_task_definitions_standardId_fkey" FOREIGN KEY ("standardId") REFERENCES "compliance_standards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_taskDefinitionId_fkey" FOREIGN KEY ("taskDefinitionId") REFERENCES "maintenance_task_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "maintenance_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_assignedTechId_fkey" FOREIGN KEY ("assignedTechId") REFERENCES "contractor_techs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_measurements" ADD CONSTRAINT "test_measurements_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_measurements" ADD CONSTRAINT "test_measurements_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deficiencies" ADD CONSTRAINT "deficiencies_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deficiencies" ADD CONSTRAINT "deficiencies_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deficiencies" ADD CONSTRAINT "deficiencies_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deficiencies" ADD CONSTRAINT "deficiencies_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_studies" ADD CONSTRAINT "system_studies_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_studies" ADD CONSTRAINT "system_studies_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_studies" ADD CONSTRAINT "system_studies_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "system_studies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_visits" ADD CONSTRAINT "audit_visits_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_visits" ADD CONSTRAINT "audit_visits_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_recommendations" ADD CONSTRAINT "audit_recommendations_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_recommendations" ADD CONSTRAINT "audit_recommendations_auditVisitId_fkey" FOREIGN KEY ("auditVisitId") REFERENCES "audit_visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_recommendations" ADD CONSTRAINT "audit_recommendations_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_samples" ADD CONSTRAINT "lab_samples_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_samples" ADD CONSTRAINT "lab_samples_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_samples" ADD CONSTRAINT "lab_samples_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blackout_windows" ADD CONSTRAINT "blackout_windows_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blackout_windows" ADD CONSTRAINT "blackout_windows_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_revision_alerts" ADD CONSTRAINT "standard_revision_alerts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_revision_alerts" ADD CONSTRAINT "standard_revision_alerts_standardId_fkey" FOREIGN KEY ("standardId") REFERENCES "compliance_standards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_revision_alerts" ADD CONSTRAINT "standard_revision_alerts_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_snapshots" ADD CONSTRAINT "compliance_snapshots_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_snapshots" ADD CONSTRAINT "compliance_snapshots_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_snapshots" ADD CONSTRAINT "compliance_snapshots_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_snapshots" ADD CONSTRAINT "compliance_snapshots_auditVisitId_fkey" FOREIGN KEY ("auditVisitId") REFERENCES "audit_visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "maintenance_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_preferences" ADD CONSTRAINT "alert_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_sessions" ADD CONSTRAINT "ingestion_sessions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_sessions" ADD CONSTRAINT "ingestion_sessions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_sessions" ADD CONSTRAINT "ingestion_sessions_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultant_accesses" ADD CONSTRAINT "consultant_accesses_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultant_accesses" ADD CONSTRAINT "consultant_accesses_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultant_accesses" ADD CONSTRAINT "consultant_accesses_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultant_accesses" ADD CONSTRAINT "consultant_accesses_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_invitedBy_fkey" FOREIGN KEY ("invitedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_logs" ADD CONSTRAINT "backup_logs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "custom_field_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_webhook_dlq" ADD CONSTRAINT "outbound_webhook_dlq_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_webhook_dlq" ADD CONSTRAINT "outbound_webhook_dlq_webhookEndpointId_fkey" FOREIGN KEY ("webhookEndpointId") REFERENCES "webhook_endpoints"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loto_procs" ADD CONSTRAINT "loto_procs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loto_procs" ADD CONSTRAINT "loto_procs_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loto_procs" ADD CONSTRAINT "loto_procs_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loto_procs" ADD CONSTRAINT "loto_procs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loto_energy_sources" ADD CONSTRAINT "loto_energy_sources_lotoId_fkey" FOREIGN KEY ("lotoId") REFERENCES "loto_procs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loto_energy_sources" ADD CONSTRAINT "loto_energy_sources_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loto_steps" ADD CONSTRAINT "loto_steps_lotoId_fkey" FOREIGN KEY ("lotoId") REFERENCES "loto_procs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loto_steps" ADD CONSTRAINT "loto_steps_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disaster_events" ADD CONSTRAINT "disaster_events_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disaster_events" ADD CONSTRAINT "disaster_events_declaredBy_fkey" FOREIGN KEY ("declaredBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_templates" ADD CONSTRAINT "asset_templates_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_template_tasks" ADD CONSTRAINT "asset_template_tasks_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "asset_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_template_tasks" ADD CONSTRAINT "asset_template_tasks_taskDefinitionId_fkey" FOREIGN KEY ("taskDefinitionId") REFERENCES "maintenance_task_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_invites" ADD CONSTRAINT "partner_invites_partnerOrgId_fkey" FOREIGN KEY ("partnerOrgId") REFERENCES "partner_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_invites" ADD CONSTRAINT "partner_invites_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_invites" ADD CONSTRAINT "partner_invites_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_event_logs" ADD CONSTRAINT "partner_event_logs_partnerOrgId_fkey" FOREIGN KEY ("partnerOrgId") REFERENCES "partner_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_event_logs" ADD CONSTRAINT "partner_event_logs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_event_logs" ADD CONSTRAINT "partner_event_logs_assignedRepId_fkey" FOREIGN KEY ("assignedRepId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

