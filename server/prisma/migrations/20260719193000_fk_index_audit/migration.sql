-- FK-index audit (DB_HEALTH.md, 2026-07-19): add covering single-column indexes for 40
-- relation FKs across 27 models that Postgres does NOT auto-index. Purely additive.
-- IF NOT EXISTS makes it idempotent (repo convention: see 20260624120000_parts_tables_create_if_not_exists).
-- Fixes the unindexed-cascade/set-null seq-scan class behind slow reseed (DB_HEALTH sec 5-6).
-- CreateIndex
CREATE INDEX IF NOT EXISTS "accounts_partnerOrgId_idx" ON "accounts"("partnerOrgId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "accounts_assignedRepId_idx" ON "accounts"("assignedRepId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "accounts_fallbackRepId_idx" ON "accounts"("fallbackRepId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "assets_ownerId_idx" ON "assets"("ownerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "assets_siteId_idx" ON "assets"("siteId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "assets_buildingId_idx" ON "assets"("buildingId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "assets_areaId_idx" ON "assets"("areaId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "maintenance_schedules_taskDefinitionId_idx" ON "maintenance_schedules"("taskDefinitionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "work_orders_quoteRequestId_idx" ON "work_orders"("quoteRequestId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "work_order_comments_authorId_idx" ON "work_order_comments"("authorId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "deficiencies_resolvedById_idx" ON "deficiencies"("resolvedById");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "system_studies_supersededById_idx" ON "system_studies"("supersededById");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_recommendations_assignedToUserId_idx" ON "audit_recommendations"("assignedToUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "standard_revision_alerts_acknowledgedById_idx" ON "standard_revision_alerts"("acknowledgedById");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "compliance_snapshots_siteId_idx" ON "compliance_snapshots"("siteId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "compliance_snapshots_generatedById_idx" ON "compliance_snapshots"("generatedById");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "compliance_snapshots_auditVisitId_idx" ON "compliance_snapshots"("auditVisitId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "documents_uploadedBy_idx" ON "documents"("uploadedBy");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "document_annotations_authorId_idx" ON "document_annotations"("authorId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "communications_createdBy_idx" ON "communications"("createdBy");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "communications_contractorId_idx" ON "communications"("contractorId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "consultant_accesses_grantedById_idx" ON "consultant_accesses"("grantedById");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "consultant_accesses_revokedById_idx" ON "consultant_accesses"("revokedById");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_invites_invitedBy_idx" ON "user_invites"("invitedBy");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "custom_field_definitions_createdById_idx" ON "custom_field_definitions"("createdById");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "outbound_webhook_dlq_webhookEndpointId_idx" ON "outbound_webhook_dlq"("webhookEndpointId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notification_logs_userId_idx" ON "notification_logs"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "loto_procs_approvedById_idx" ON "loto_procs"("approvedById");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "loto_procs_createdById_idx" ON "loto_procs"("createdById");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "disaster_events_declaredBy_idx" ON "disaster_events"("declaredBy");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "asset_template_tasks_taskDefinitionId_idx" ON "asset_template_tasks"("taskDefinitionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sso_login_states_accountId_idx" ON "sso_login_states"("accountId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sso_login_states_connectionId_idx" ON "sso_login_states"("connectionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sso_handoffs_accountId_idx" ON "sso_handoffs"("accountId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "telemetry_notifications_acknowledgedById_idx" ON "telemetry_notifications"("acknowledgedById");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "asset_feeds_siteId_idx" ON "asset_feeds"("siteId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "thermography_surveys_assetId_idx" ON "thermography_surveys"("assetId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "thermography_surveys_sourceDocumentId_idx" ON "thermography_surveys"("sourceDocumentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "thermography_surveys_createdById_idx" ON "thermography_surveys"("createdById");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "thermography_findings_assetId_idx" ON "thermography_findings"("assetId");

