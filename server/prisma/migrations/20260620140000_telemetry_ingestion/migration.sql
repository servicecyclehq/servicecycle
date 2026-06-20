-- Phase 4 #8: continuous condition-monitoring telemetry ingestion.
-- Additive only. New enum + asset flag + three tables.

-- Reading grade. CRIT = the NFPA 70B:2023 "unaddressed continuous-monitoring
-- notification" that escalates an asset to Condition 2 until addressed.
CREATE TYPE "TelemetryStatus" AS ENUM ('OK', 'WARN', 'CRIT');

-- Asset: separate governing input. True while >=1 open CRIT notification exists.
ALTER TABLE "assets" ADD COLUMN "autoConditionMonitoring" BOOLEAN NOT NULL DEFAULT false;

-- Monitored signal on one asset (e.g. winding_temp). Thresholds optional.
CREATE TABLE "telemetry_channels" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT,
    "unit" TEXT,
    "warnHigh" DECIMAL(16,4),
    "critHigh" DECIMAL(16,4),
    "warnLow" DECIMAL(16,4),
    "critLow" DECIMAL(16,4),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastValue" DECIMAL(16,4),
    "lastStatus" "TelemetryStatus",
    "lastReadingAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "telemetry_channels_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "telemetry_channels_assetId_key_key" ON "telemetry_channels"("assetId", "key");
CREATE INDEX "telemetry_channels_accountId_idx" ON "telemetry_channels"("accountId");
CREATE INDEX "telemetry_channels_accountId_assetId_idx" ON "telemetry_channels"("accountId", "assetId");

-- One time-series sample. externalId dedups at-least-once gateway delivery.
CREATE TABLE "telemetry_readings" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "value" DECIMAL(16,4) NOT NULL,
    "unit" TEXT,
    "status" "TelemetryStatus" NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "telemetry_readings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "telemetry_readings_channelId_externalId_key" ON "telemetry_readings"("channelId", "externalId");
CREATE INDEX "telemetry_readings_channelId_recordedAt_idx" ON "telemetry_readings"("channelId", "recordedAt");
CREATE INDEX "telemetry_readings_accountId_recordedAt_idx" ON "telemetry_readings"("accountId", "recordedAt");
CREATE INDEX "telemetry_readings_assetId_recordedAt_idx" ON "telemetry_readings"("assetId", "recordedAt");

-- Breach event. Open CRIT = unaddressed notification holding the asset at C2.
CREATE TABLE "telemetry_notifications" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "status" "TelemetryStatus" NOT NULL,
    "value" DECIMAL(16,4) NOT NULL,
    "threshold" DECIMAL(16,4),
    "thresholdKind" TEXT,
    "message" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "autoResolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "telemetry_notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "telemetry_notifications_accountId_acknowledgedAt_idx" ON "telemetry_notifications"("accountId", "acknowledgedAt");
CREATE INDEX "telemetry_notifications_assetId_acknowledgedAt_idx" ON "telemetry_notifications"("assetId", "acknowledgedAt");
CREATE INDEX "telemetry_notifications_channelId_acknowledgedAt_idx" ON "telemetry_notifications"("channelId", "acknowledgedAt");

-- Foreign keys.
ALTER TABLE "telemetry_channels" ADD CONSTRAINT "telemetry_channels_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telemetry_channels" ADD CONSTRAINT "telemetry_channels_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "telemetry_readings" ADD CONSTRAINT "telemetry_readings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telemetry_readings" ADD CONSTRAINT "telemetry_readings_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "telemetry_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telemetry_readings" ADD CONSTRAINT "telemetry_readings_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "telemetry_notifications" ADD CONSTRAINT "telemetry_notifications_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telemetry_notifications" ADD CONSTRAINT "telemetry_notifications_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telemetry_notifications" ADD CONSTRAINT "telemetry_notifications_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "telemetry_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telemetry_notifications" ADD CONSTRAINT "telemetry_notifications_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
