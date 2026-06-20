-- Enterprise SSO + SCIM (feature/sso-polis). Additive ONLY: one new enum,
-- seven new tables, four new nullable columns + one unique index on "users".
-- No existing column is altered or dropped. ServiceCycle is the OAuth relying
-- party; Ory Polis (Apache-2.0) is the broker. See docs/security/SSO_DESIGN.md.

-- New enum.
CREATE TYPE "SsoProtocol" AS ENUM ('oidc', 'saml');

-- ── users: additive SCIM/SSO columns ────────────────────────────────────────
ALTER TABLE "users" ADD COLUMN "scimExternalId"  TEXT;
ALTER TABLE "users" ADD COLUMN "scimDirectoryId" TEXT;
ALTER TABLE "users" ADD COLUMN "ssoManaged"      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "lastSsoLoginAt"  TIMESTAMP(3);

-- Unique SCIM identity per directory. NULLs are distinct in Postgres, so the
-- (NULL, NULL) rows of existing password users never collide.
CREATE UNIQUE INDEX "users_scimDirectoryId_scimExternalId_key" ON "users"("scimDirectoryId", "scimExternalId");

-- ── sso_connections ─────────────────────────────────────────────────────────
CREATE TABLE "sso_connections" (
  "id"            TEXT NOT NULL,
  "accountId"     TEXT NOT NULL,
  "protocol"      "SsoProtocol" NOT NULL,
  "polisTenant"   TEXT NOT NULL,
  "polisProduct"  TEXT NOT NULL DEFAULT 'servicecycle',
  "polisClientId" TEXT,
  "label"         TEXT,
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sso_connections_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sso_connections_accountId_idx" ON "sso_connections"("accountId");
CREATE INDEX "sso_connections_polisTenant_idx" ON "sso_connections"("polisTenant");

-- ── sso_domains ─────────────────────────────────────────────────────────────
CREATE TABLE "sso_domains" (
  "id"           TEXT NOT NULL,
  "domain"       TEXT NOT NULL,
  "accountId"    TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sso_domains_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sso_domains_domain_key" ON "sso_domains"("domain");
CREATE INDEX "sso_domains_accountId_idx" ON "sso_domains"("accountId");
CREATE INDEX "sso_domains_connectionId_idx" ON "sso_domains"("connectionId");

-- ── scim_directories ────────────────────────────────────────────────────────
CREATE TABLE "scim_directories" (
  "id"               TEXT NOT NULL,
  "accountId"        TEXT NOT NULL,
  "polisDirectoryId" TEXT NOT NULL,
  "polisTenant"      TEXT NOT NULL,
  "polisProduct"     TEXT NOT NULL DEFAULT 'servicecycle',
  "type"             TEXT,
  "label"            TEXT,
  "isActive"         BOOLEAN NOT NULL DEFAULT true,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "scim_directories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "scim_directories_polisDirectoryId_key" ON "scim_directories"("polisDirectoryId");
CREATE INDEX "scim_directories_accountId_idx" ON "scim_directories"("accountId");

-- ── sso_role_mappings ───────────────────────────────────────────────────────
CREATE TABLE "sso_role_mappings" (
  "id"        TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "idpGroup"  TEXT NOT NULL,
  "role"      "UserRole" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sso_role_mappings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sso_role_mappings_accountId_idpGroup_key" ON "sso_role_mappings"("accountId", "idpGroup");
CREATE INDEX "sso_role_mappings_accountId_idx" ON "sso_role_mappings"("accountId");

-- ── sso_login_states (CSRF/PKCE; single-use + TTL) ──────────────────────────
CREATE TABLE "sso_login_states" (
  "id"           TEXT NOT NULL,
  "state"        TEXT NOT NULL,
  "nonce"        TEXT NOT NULL,
  "codeVerifier" TEXT NOT NULL,
  "accountId"    TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "redirectTo"   TEXT NOT NULL DEFAULT '/dashboard',
  "expiresAt"    TIMESTAMP(3) NOT NULL,
  "consumedAt"   TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sso_login_states_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sso_login_states_state_key" ON "sso_login_states"("state");
CREATE INDEX "sso_login_states_expiresAt_idx" ON "sso_login_states"("expiresAt");

-- ── sso_handoffs (one-time token handoff to the SPA) ────────────────────────
CREATE TABLE "sso_handoffs" (
  "id"         TEXT NOT NULL,
  "codeHash"   TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "accountId"  TEXT NOT NULL,
  "redirectTo" TEXT NOT NULL DEFAULT '/dashboard',
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sso_handoffs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sso_handoffs_codeHash_key" ON "sso_handoffs"("codeHash");
CREATE INDEX "sso_handoffs_userId_idx" ON "sso_handoffs"("userId");
CREATE INDEX "sso_handoffs_expiresAt_idx" ON "sso_handoffs"("expiresAt");

-- ── scim_events (idempotency/replay ledger; intentionally FK-less, like
--    extraction_events, so the ledger survives directory deletion) ───────────
CREATE TABLE "scim_events" (
  "id"               TEXT NOT NULL,
  "eventKey"         TEXT NOT NULL,
  "polisDirectoryId" TEXT,
  "directoryId"      TEXT,
  "eventType"        TEXT NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'processed',
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scim_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "scim_events_eventKey_key" ON "scim_events"("eventKey");
CREATE INDEX "scim_events_createdAt_idx" ON "scim_events"("createdAt");
CREATE INDEX "scim_events_directoryId_idx" ON "scim_events"("directoryId");

-- ── Foreign keys (DB-enforced cascade; not declared as Prisma relations) ─────
ALTER TABLE "sso_connections"   ADD CONSTRAINT "sso_connections_accountId_fkey"     FOREIGN KEY ("accountId")    REFERENCES "accounts"("id")        ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sso_domains"       ADD CONSTRAINT "sso_domains_accountId_fkey"         FOREIGN KEY ("accountId")    REFERENCES "accounts"("id")        ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sso_domains"       ADD CONSTRAINT "sso_domains_connectionId_fkey"      FOREIGN KEY ("connectionId") REFERENCES "sso_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scim_directories"  ADD CONSTRAINT "scim_directories_accountId_fkey"    FOREIGN KEY ("accountId")    REFERENCES "accounts"("id")        ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sso_role_mappings" ADD CONSTRAINT "sso_role_mappings_accountId_fkey"   FOREIGN KEY ("accountId")    REFERENCES "accounts"("id")        ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sso_login_states"  ADD CONSTRAINT "sso_login_states_accountId_fkey"    FOREIGN KEY ("accountId")    REFERENCES "accounts"("id")        ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sso_login_states"  ADD CONSTRAINT "sso_login_states_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "sso_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sso_handoffs"      ADD CONSTRAINT "sso_handoffs_userId_fkey"           FOREIGN KEY ("userId")       REFERENCES "users"("id")           ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sso_handoffs"      ADD CONSTRAINT "sso_handoffs_accountId_fkey"        FOREIGN KEY ("accountId")    REFERENCES "accounts"("id")        ON DELETE CASCADE ON UPDATE CASCADE;
