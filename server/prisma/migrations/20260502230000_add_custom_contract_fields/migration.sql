-- Custom contract fields: admin-defined fields that show up on every
-- contract form. Two tables — definitions (the schema) and values (the
-- per-contract data).
--
-- Type stored as a TEXT column with an explicit CHECK so we don't need
-- a Postgres enum (avoids the "enum migration is hard" tax — adding a
-- new field type later is a simple ALTER on the CHECK).

CREATE TABLE "custom_field_definitions" (
    "id"           TEXT NOT NULL,
    "accountId"    TEXT NOT NULL,
    "name"         TEXT NOT NULL,
    "fieldKey"     TEXT NOT NULL,
    "type"         TEXT NOT NULL,
    "helpText"     TEXT,
    "required"     BOOLEAN NOT NULL DEFAULT false,
    "options"      JSONB,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt"   TIMESTAMP(3),
    "createdById"  TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "custom_field_definitions_type_check"
      CHECK ("type" IN ('text','textarea','number','date','checkbox','select'))
);

CREATE UNIQUE INDEX "custom_field_definitions_accountId_fieldKey_key"
  ON "custom_field_definitions"("accountId", "fieldKey");

CREATE INDEX "custom_field_definitions_accountId_idx"
  ON "custom_field_definitions"("accountId");

CREATE INDEX "custom_field_definitions_account_active_order_idx"
  ON "custom_field_definitions"("accountId", "archivedAt", "displayOrder");

ALTER TABLE "custom_field_definitions"
  ADD CONSTRAINT "custom_field_definitions_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "custom_field_definitions"
  ADD CONSTRAINT "custom_field_definitions_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "custom_field_values" (
    "id"            TEXT NOT NULL,
    "contractId"    TEXT NOT NULL,
    "definitionId"  TEXT NOT NULL,
    -- Single value column — store as text and let the application coerce
    -- by type at the boundary. Avoids 4-6 nullable typed columns and lets
    -- us add new field types without another migration.
    "value"         TEXT,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "custom_field_values_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custom_field_values_contractId_definitionId_key"
  ON "custom_field_values"("contractId", "definitionId");

CREATE INDEX "custom_field_values_definitionId_idx"
  ON "custom_field_values"("definitionId");

ALTER TABLE "custom_field_values"
  ADD CONSTRAINT "custom_field_values_contractId_fkey"
  FOREIGN KEY ("contractId") REFERENCES "contracts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "custom_field_values"
  ADD CONSTRAINT "custom_field_values_definitionId_fkey"
  FOREIGN KEY ("definitionId") REFERENCES "custom_field_definitions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
