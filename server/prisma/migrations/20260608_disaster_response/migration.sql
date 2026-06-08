-- Migration: Disaster Response Mode
-- Adds disaster_events table for NWS/FEMA weather alerts and customer
-- emergency declarations.

CREATE TABLE "disaster_events" (
  "id"              TEXT        NOT NULL,
  -- null = system-detected regional event; set = customer declaration
  "accountId"       TEXT,
  -- hurricane | tornado | ice_storm | blizzard | flash_flood |
  -- severe_thunderstorm | wildfire | extreme_heat | grid_failure |
  -- earthquake | manual
  "eventType"       TEXT        NOT NULL,
  -- watch | warning | emergency
  "severity"        TEXT        NOT NULL,
  "title"           TEXT        NOT NULL,
  "region"          TEXT        NOT NULL,
  -- 2-letter state abbreviations from NWS UGC codes
  "affectedStates"  TEXT[]      NOT NULL DEFAULT '{}',
  -- Site.id values in the impact zone
  "affectedSiteIds" TEXT[]      NOT NULL DEFAULT '{}',
  -- NWS alert @id — used for idempotent upsert across scanner runs
  "nwsAlertId"      TEXT,
  -- userId who clicked "Declare Emergency"; null for system events
  "declaredBy"      TEXT,
  -- nws | fema | manual
  "source"          TEXT        NOT NULL DEFAULT 'system',
  "declaredAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "resolvedAt"      TIMESTAMPTZ,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "disaster_events_pkey" PRIMARY KEY ("id")
);

-- FK: account (nullable — system events have no account)
ALTER TABLE "disaster_events"
  ADD CONSTRAINT "disaster_events_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
  ON DELETE SET NULL;

-- FK: declarer user (nullable)
ALTER TABLE "disaster_events"
  ADD CONSTRAINT "disaster_events_declaredBy_fkey"
  FOREIGN KEY ("declaredBy") REFERENCES "users"("id")
  ON DELETE SET NULL;

-- Indexes for the most common query patterns:
--   - list active events for an account
--   - scanner dedup check by NWS alert ID
--   - resolve/prune pass by resolvedAt
CREATE INDEX "disaster_events_accountId_idx"  ON "disaster_events"("accountId");
CREATE INDEX "disaster_events_resolvedAt_idx" ON "disaster_events"("resolvedAt");
CREATE INDEX "disaster_events_nwsAlertId_idx" ON "disaster_events"("nwsAlertId");
