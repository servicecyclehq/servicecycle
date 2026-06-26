# DEMO_LANDMINES_v7 — ServiceCycle Security & Quality Scan

Generated: 2026-06-26
Personas: CMMS-7, DD-7, PEN-7, SE-7, NETA-7, SRE-7, ESO-7, INS-7
Total findings: 110
  CRITICAL: 30
  HIGH: 47
  MEDIUM: 33

---

## CMMS-7 — Senior CMMS Implementation Consultant

**[CMMS-7-1] CRITICAL: No Labor Planning, Scheduling, or Capacity Management**
No plannedHours, crewSize, skillCode, workCenter, or shift-calendar FK. WorkOrder stores only laborHours (post-completion) and laborCostCents. Scheduler assigns one tech but cannot express crew requirements or time-window constraints.
File: server/prisma/schema.prisma lines 1032-1113

---

**[CMMS-7-2] CRITICAL: No Purchase Order or Procurement Workflow**
No PurchaseOrder model, no requisition, no goods receipt. Low-stock detection exists but workflow ends there — no PO generation, approval routing, or three-way match.
File: server/routes/parts.ts lines 1-28; server/prisma/schema.prisma lines 364-367

---

**[CMMS-7-3] CRITICAL: No Native ERP or Industrial Protocol Integration**
No OPC-UA, MQTT, Sparkplug B, ISA-95, SAP RFC, or OSIsoft PI integration. v1 telemetry is REST HTTP push only. Comment documents OPC-UA as future external bridge, not implemented.
File: server/routes/v1/telemetry.ts lines 14-18

---

**[CMMS-7-4] HIGH: Asset Hierarchy Maxes Out at 5 Levels with No Functional Location Code**
Site → Building → Area → EquipmentPosition → Asset. No ISO 14224 or KKS coding. Free-text names throughout.
File: server/prisma/schema.prisma lines 661-770

---

**[CMMS-7-5] HIGH: Maintenance Program is Interval-Only — No RCM, CBM, or Failure-Mode Framework**
MaintenanceTaskDefinition has intervalC1/C2/C3Months but no failureMode, FMEA linkage, consequence-of-failure score, or RCM decision logic. Interval engine is pure time-based.
File: server/lib/maintenanceInterval.ts lines 98-132; server/prisma/schema.prisma lines 948-975

---

**[CMMS-7-6] HIGH: Offline Mobile Capability is Partial — Read Cache Only, No Full Data Set**
Service worker caches only /api/field/ and /api/assets. Work order detail, maintenance schedules, parts inventory have no offline cache. Outbox has no conflict-resolution logic — later flush silently overwrites.
File: client/dist/sw.js line 1; client/src/lib/outbox.js lines 154-165

---

**[CMMS-7-7] HIGH: No MTTR, MTBF, Wrench-Time, or Any Industry-Standard KPI**
No MTTR, MTBF, PM compliance rate, wrench-time, backlog-hours trend, planned-vs-actual, cost-per-asset, or OEE metric anywhere in the codebase.
File: client/src/tables/reportsRegistry.js lines 21-107; server/routes/reports.ts line 26

---

**[CMMS-7-8] HIGH: Parts and Inventory Has No Supplier Management or Replenishment Automation**
No supplier/vendor FK, preferred-supplier field, supplier part number, EOQ calculation, ABC classification, or cycle-count schedule. Low-stock detection is JS-side only.
File: server/routes/parts.ts lines 68-97

---

**[CMMS-7-9] HIGH: Work Order Approval Workflow is Single-Level and Hardcoded**
Single manager-approves-anything model. No dollar-threshold routing, no multi-level chain, no delegation. approvedBy/approvedAt/approvalNote are single scalar fields.
File: server/routes/workOrders.ts lines 57-63; server/prisma/schema.prisma lines 1086-1088

---

**[CMMS-7-10] HIGH: Telemetry Integration is HTTP-Push Only — No Native OT Connectivity**
No OPC-UA node-ID mapping, MQTT topic binding, or Sparkplug B metric descriptor. TelemetryChannel source field is free-text string.
File: server/routes/v1/telemetry.ts lines 14-18; server/prisma/schema.prisma lines 2860-2913

---

**[CMMS-7-11] MEDIUM: Asset Taxonomy is Electrical-Only**
21 electrical EquipmentType values. No mechanical, civil, instrumentation, HVAC, or piping categories. Bulk-apply task engine enforces type match, so mechanical assets cannot receive any task.
File: server/prisma/schema.prisma lines 74-101

---

**[CMMS-7-12] MEDIUM: No Permit-to-Work System Beyond LOTO**
No hot-work permit, confined-space entry permit, excavation permit, or HV switching permit model. LOTO covers OSHA 1910.147 energy isolation only.
File: server/routes/loto.ts lines 1-25; server/prisma/schema.prisma lines 2373-2465

---

**[CMMS-7-13] MEDIUM: Deficiency Resolution Has No Root-Cause Analysis or RCFA Tracking**
Deficiency.correctiveAction is a nullable free-text string. No rootCause field, no RCFA workflow, no corrective-action verification date, no preventive-action linkage, no recurrence count.
File: server/prisma/schema.prisma lines 1159-1182

---

**[CMMS-7-14] MEDIUM: Report Catalogue is Stub Returning Empty Array**
GET /api/reports returns { reports: [] }. ReportsHub hardcodes 10 cards from local reportsRegistry.js. No server-side catalogue, no scheduled reports, no custom report builder.
File: server/routes/reports.ts lines 25-27; client/src/tables/reportsRegistry.js lines 6-8

---

## DD-7 — PE/M&A Technical Due Diligence Partner

**[DD-7-1] CRITICAL: Single-node architecture — no HA, RPO 24h, RTO 2h**
Entire stack on one DigitalOcean droplet. RTO ~2h, RPO ~24h. No replica, no managed PaaS, no failover.
File: docs/DEPLOY_RUNBOOK.md:33; docs/RISK_REGISTER.md:R-03

---

**[DD-7-2] CRITICAL: Login lockout is process-memory-scoped — cleared on every deploy**
loginFailMap is a plain in-process Map. A FailedLoginAttempt schema model exists but the migration to wire it into the login path has not landed. Lockout resets on every deploy.
File: server/routes/auth.ts:247

---

**[DD-7-3] CRITICAL: No background job queue — all async work runs in-process via node-cron**
Ingest workers, alert sweeps, webhook retries, news scanning all run as node-cron jobs inside the Express process. No BullMQ, SQS, or separate worker process.
File: server/index.ts (cron section)

---

**[DD-7-4] HIGH: Mixed CommonJS/ESM in 80+ route files is a build-pipeline liability**
Every route file uses require() and import simultaneously. Any move to standard compiled build pipeline requires full-codebase refactor.
File: server/routes/accounts.ts:12-17

---

**[DD-7-5] HIGH: Tenant isolation is manual discipline, not ORM enforcement**
findFirst calls without where.accountId are the attack surface. Only automated guard is a dedicated IDOR test suite.
File: docs/ENGINEERING_HANDOFF.md:23-27

---

**[DD-7-6] HIGH: Internal API has no versioning — breaking changes are undetectable**
/api/* internal surface has no contract, no snapshot tests, no drift detection. /api/v1 is versioned; /api/* is not.
File: server/routes/auth.ts:909-911

---

**[DD-7-7] HIGH: AI budget guard is advisory-only — no hard infrastructure ceiling**
lib/aiBudgetGuard.ts logs warnings but cannot stop inference. No Anthropic spend cap.
File: docs/ENGINEERING_HANDOFF.md:68-70

---

**[DD-7-8] HIGH: MASTER_KEY loss is irrecoverable — stored only on VPS .env**
Root AES-256 key encrypts TOTP secrets, API credentials, webhook secrets. Not in any secrets manager. VPS wipe without key backup = permanent tenant credential loss.
File: docs/ENGINEERING_HANDOFF.md:29-34

---

**[DD-7-9] HIGH: No data retention prune jobs for high-volume tables**
ActivityLog and TelemetryReading grow unboundedly. Hash-chain constraint on ActivityLog makes adding retention architecturally complex.
File: docs/ENGINEERING_HANDOFF.md:66-68

---

**[DD-7-10] HIGH: Deploy pipeline SSHes as root — no least-privilege deploy user**
SC_SSH_USER: root. A compromised deploy key gives root shell on production with full access to .env.
File: .github/workflows/deploy.yml:10,54-57

---

**[DD-7-11] MEDIUM: Single founder bus factor — all architectural context in one person**
One founding engineer. NFPA 70B interval logic, arc-flash domain model, alert engine edge cases underdocumented.
File: docs/ENGINEERING_HANDOFF.md:130-132

---

**[DD-7-12] MEDIUM: No unit tests for core domain calculations**
~500 integration tests, 9 unit test files. None cover NFPA 70B interval calculation, arc-flash incident-energy computation, alert engine dedup, or compliance scoring.
File: server/tests/ (9 files)

---

**[DD-7-13] MEDIUM: Two 1000+ line React components are merge-conflict landmines**
AssetDetail.jsx is 1,423 lines. Sidebar.jsx is ~1,034 lines. Handoff flags both as "truncation-danger."
File: docs/ENGINEERING_HANDOFF.md:58-62

---

**[DD-7-14] MEDIUM: Stripe billing is a schema stub — revenue enforcement is not live**
Account model has Stripe columns with schema comments reading "Stripe seam — populated by a future Checkout flow." No webhook handler. Licensed instances bypass tier enforcement.
File: server/prisma/schema.prisma:255-262

---

## PEN-7 — Senior Penetration Tester

**[PEN-7-1] CRITICAL: Arc Flash Incident PATCH skips tenant isolation on update**
findFirst validates accountId; subsequent update({ where: { id } }) drops the accountId constraint. Cross-tenant write of safety-critical arc flash incident data possible in TOCTOU window.
File: server/routes/arcFlashIncidents.ts:189

---

**[PEN-7-2] HIGH: LOTO status transition allows archived→active bypass of approval semantics**
VALID_STATUSES permits any-to-any transition. No legal state machine. A single manager can re-activate an archived LOTO procedure bypassing two-party approval.
File: server/routes/loto.ts:263-315

---

**[PEN-7-3] HIGH: OEM fleet drill-down exposes full customer data when partnerOrgId is null**
If callerAccount.partnerOrgId is null (e.g., after onDelete: SetNull), the 403 guard short-circuits and any oem_admin reads full drill-down for any tenant.
File: server/routes/fleetDashboard.ts:398-405

---

**[PEN-7-4] HIGH: Inbound email webhook falls back to unauthenticated processing when both secrets are absent**
INBOUND_WEBHOOK_SECRET="" passes timingSafeEqual(Buffer.from(''), Buffer.from('')) → true. Unauthenticated POST can forge inbound email ingest.
File: server/routes/inboundEmail.ts:81-83

---

**[PEN-7-5] HIGH: Arc flash public label endpoint discloses safety-critical data with no token entropy floor**
Token length floor of 16 chars. No rate limiting. No account-scoping. Discloses peName, performedDate, expiresAt, incident energy, PPE category for any asset.
File: server/routes/arcFlashLabelPublic.ts:27-71

---

**[PEN-7-6] HIGH: field_tech role boundary bypassable via /api/errors allowlist**
/api/errors is allowlisted for field_tech. The route accepts up to 10KB of arbitrary string data stored in RenderError table. /api/preferences lets field_tech write arbitrary preference key/value pairs.
File: server/lib/fieldRoleScope.ts:31-35; server/routes/errors.ts:146-164

---

**[PEN-7-7] HIGH: Arc flash confirm path has no idempotency guard on asset creation**
Concurrent confirm requests for the same ingest pass the status check before either updates confirmedAt, creating duplicate Asset rows with diverging arc flash labels and LOTO procedures.
File: server/routes/arcFlashIngest.ts ~line 510

---

**[PEN-7-8] MEDIUM: Quote request GET routes have no role gate**
POST /api/quote-requests uses requireQuoteWriter. GET /api/quote-requests and GET /api/quote-requests/asset/:assetId have no role gate — any authenticated user reads full financial dossier including dossierSnapshot.
File: server/routes/quoteRequests.ts:218-309

---

**[PEN-7-9] MEDIUM: req.ip rate limiting on errors route bypasses Cloudflare trust proxy**
Custom rate limiter reads req.ip directly without Cloudflare CIDR validation. All clients behind same CF PoP share one bucket; different CF edge nodes bypass the limit.
File: server/routes/errors.ts:32

---

**[PEN-7-10] MEDIUM: LOTO procedure DELETE uses only findFirst for auth then delete by id**
delete({ where: { id } }) drops the accountId constraint. Latent IDOR: race condition or future refactor that removes findFirst guard → cross-tenant delete.
File: server/routes/loto.ts:334

---

**[PEN-7-11] MEDIUM: DGA preview endpoint has no role gate**
POST /api/assets/:id/dga/preview has no role middleware — consultant/viewer accounts can trigger DGA text parsing. No per-field size limit on reportText. No rate limit.
File: server/routes/dgaIngest.ts:59-73

---

**[PEN-7-12] MEDIUM: Arc flash ingest bus PATCH accepts unbounded deviceSettings object**
safeDeviceSettings() is defined but NOT called on PATCH path. Arbitrary-size deeply-nested JSONB stored; can cause OOM during export serialization.
File: server/routes/arcFlashIngest.ts:439-442

---

**[PEN-7-13] MEDIUM: Token rotation window allows old tokens for up to 1 hour after password reset**
OLD_JWT_SECRET acceptance + epoch-based revocation are independent. During rotation window, stolen token with matching ep remains valid for full 1-hour TTL even after password change.
File: server/lib/jwtSecrets.ts:66-84; server/middleware/auth.ts:109

---

## SE-7 — Enterprise Sales Engineer

**[SE-7-1] CRITICAL: "Coming soon" placeholder with internal version number rendered to all users**
StubReport.jsx renders "This report is on the v0.58 roadmap" to any user who clicks an unimplemented report link.
File: client/src/pages/StubReport.jsx lines 47-55

---

**[SE-7-2] CRITICAL: Mojibake encoding corruption on AFX import screen**
"Overwrite preview â€" 3 field(s)..." rendered instead of em-dash. UTF-8 bytes stored as Latin-1.
File: client/src/pages/ArcFlashFleet.jsx lines 447 and 472

---

**[SE-7-3] CRITICAL: window.prompt() and alert() native browser dialogs break demo**
Parts delete → window.confirm(); GDPR erase → window.prompt(); export failure → alert(). In enterprise Chrome managed environments, window.prompt is blocked by policy, silently returning null.
File: client/src/pages/Parts.jsx lines 172, 190; client/src/pages/UsersPage.jsx line 272; client/src/pages/SettingsPage.jsx lines 248, 262

---

**[SE-7-4] CRITICAL: Asset list silently caps at 500 rows — client-side filter totals mislead**
FETCH_LIMIT = 500. Filter shows count from 500-row bootstrap, not actual total. No truncation warning.
File: client/src/pages/AssetsList.jsx line 49

---

**[SE-7-5] CRITICAL: Deficiencies page hard-caps at 200 rows with no truncation warning**
limit=200 hardcoded. pagination.total badge may read "347" while table shows 200 rows. No "showing 200 of 347" message.
File: client/src/pages/DeficienciesPage.jsx line 186

---

**[SE-7-6] HIGH: "Site-level scoping coming soon" visible in four user-facing strings**
Viewer role description and Access buttons all say "(site-level scoping coming soon)." Any admin sees this during user management.
File: client/src/pages/UsersPage.jsx lines 295, 422, 470, 485

---

**[SE-7-7] HIGH: Gemini AI provider description shows retired model name (causes 404 on use)**
UI shows "Default model: gemini-1.5-flash" but code comment says it was retired. Actual default is gemini-2.5-flash. Following UI instructions fails every AI call.
File: client/src/pages/SettingsPage.jsx line 1225 vs line 48

---

**[SE-7-8] HIGH: Export endpoints have no role gate — any viewer can bulk-export all asset data**
/api/export/xlsx, /api/export/assets, /api/export/workorders are behind authenticateToken only. requireManager is imported but only applied to /api/export/account.
File: server/routes/export.ts lines 273, 289, 297

---

**[SE-7-9] HIGH: parseInt() with no bounds guard — ?limit=999999 or non-numeric params cause 500**
GET /api/assets?page=abc computes skip = NaN, Prisma throws 500. Work order list has Math.min guard; asset list does not.
File: server/routes/assets.ts lines 418-419

---

**[SE-7-10] HIGH: NETA IMMEDIATE deficiency warning uses Tailwind classes not in production bundle**
div uses bg-amber-50 border-amber-400 text-amber-800 but no Tailwind config found. Warning renders as unstyled black text on a safety-critical work order screen.
File: client/src/pages/WorkOrderDetail.jsx lines 1125-1129

---

**[SE-7-11] MEDIUM: window.prompt blocked by enterprise Chrome policy — GDPR erase silently does nothing**
In Intune/MDM-managed Chrome, window.prompt returns null without dialog. Erase button appears completely broken.
File: client/src/pages/UsersPage.jsx lines 272-277

---

**[SE-7-12] MEDIUM: SharedCompliancePage renders raw API error messages to third-party recipients**
e.message rendered directly as {error} on the public-facing unauthenticated page. Prospects' customers see raw error strings like "Failed to fetch."
File: client/src/pages/SharedCompliancePage.jsx lines 43, 47-58

---

**[SE-7-13] MEDIUM: Password reset tokens stored in plaintext — CISO will fail this in diligence**
Reset token and invite token stored as raw hex. hashToken() helper exists in lib/tokens.ts but is not applied here. Refresh tokens correctly use SHA-256 hash.
File: server/routes/auth.ts lines 988-993, 1021

---

## NETA-7 — NETA Standards Technical Committee Principal

**[NETA-7-1] CRITICAL: Calibration traceability chain is advisory-only and not validated at completion**
calDate is a free-text string (max 200 chars). Completion gate never checks calibration currency, parsability, or NIST traceability. WO can complete with testEquipment = null.
File: server/routes/workOrders.ts:71-78, 552-617

---

**[NETA-7-2] CRITICAL: No peer review or technical reviewer gate before report release**
No PENDING_REVIEW or RELEASED state. AWAITING_APPROVAL is pre-work approval, not post-test review. Leave-behind PDF fires automatically on completion. System cannot distinguish unreviewed draft from released client deliverable.
File: server/routes/workOrders.ts:54-59

---

**[NETA-7-3] CRITICAL: Acceptance testing and maintenance testing are not architecturally distinct**
isAcceptanceTest is a boolean flag on the WorkOrder model. No separate form family, no ATS-specific required test set enforcement, no commissioning report type.
File: server/prisma/schema.prisma:1073; server/lib/commitTestReport.ts:124

---

**[NETA-7-4] CRITICAL: Protective relay testing records lack required calibration input/output traceability**
DeviceTestRecord captures asFoundSettings/asLeftSettings as unstructured JSON. No pickup current, time-dial, instantaneous pickup, test current, actual operating time, or curve type fields. performedBy is free-text with no FK to ContractorTech.
File: server/prisma/schema.prisma lines 3202-3230

---

**[NETA-7-5] CRITICAL: Circuit breaker testing data model missing mandatory TCC fields**
No structured field for applied test current as % of rated, measured trip time in ms, TCC reference, or frame/sensor type. TestMeasurement measurementSanity bands don't include trip time in ms.
File: server/prisma/schema.prisma lines 1119-1153; server/lib/measurementSanity.ts lines 17-25

---

**[NETA-7-6] HIGH: No enforcement of minimum NETA ETT certification level at work order completion**
Cert level copied to WorkOrder but never checked at COMPLETE transition. Level I tech can close a Level III job. ContractorTech.trainingExpiresAt stored but no alert fires when expired.
File: server/routes/workOrders.ts:552-617; server/prisma/schema.prisma:638-640

---

**[NETA-7-7] HIGH: DGA interpretation uses four-condition table only — Duval Triangle and O2/N2-ratio discrimination not implemented**
dgaEvaluate.ts implements IEEE C57.104-2008 four-condition TDCG table. IEEE C57.104-2019 Duval triangle, Rogers ratios, and O2/N2-ratio for sealed vs free-breathing transformer discrimination not present.
File: server/lib/dgaEvaluate.ts lines 24-68

---

**[NETA-7-8] HIGH: Arc flash study has no linkage to completed protective device test records at completion**
Study currency check validates age only, not whether upstream device settings driftFlagged. A breaker whose trip settings drifted from study assumptions clears energized-work completion without warning.
File: server/routes/workOrders.ts:603-617

---

**[NETA-7-9] HIGH: Deficiency model lacks verification method and root cause fields**
No structured rootCause field. No verificationMethod or retest linkage. No verifiedAt distinct from resolvedAt. IMMEDIATE deficiency resolution requires 20-char note but no follow-up test work order.
File: server/prisma/schema.prisma lines 1159-1183; server/routes/deficiencies.ts lines 207-258

---

**[NETA-7-10] HIGH: Power quality testing has no structured data model**
No voltage THD %, current THD, harmonic spectrum, or waveform capture reference fields. measurementSanity BANDS has no THD band. UPS/VFD/generator IEEE 519-2022 assessments must be flattened to free text.
File: server/prisma/schema.prisma lines 1119-1153

---

**[NETA-7-11] HIGH: Equipment condition taxonomy conflates NETA MTS decal colors with NFPA 70B ratings**
GREEN is used instead of NETA's WHITE decal color. A device with netaDecal = RED and asLeftCondition = C2 is logically contradictory; schema permits it with no cross-validation.
File: server/prisma/schema.prisma lines 129-133; server/routes/workOrders.ts lines 576-583

---

**[NETA-7-12] MEDIUM: Thermography severity 21-40°C band mapped to ADVISORY instead of RECOMMENDED**
thermographyEvaluate.ts maps 21-40°C over-ambient to Priority 3/ADVISORY. HSB/Zurich loss-control standard treats 21-40°C as RECOMMENDED. Finding does not trigger IMMEDIATE completion block.
File: server/lib/thermographyEvaluate.ts lines 28-38

---

**[NETA-7-13] MEDIUM: Insulation resistance temperature correction not applied — no PI/DAR trend baseline**
No IEEE 43-2013 temperature correction coefficients. ambientTempC stored at work order level, not measurement level. No correctedValue field. Trend comparisons use raw values without normalization.
File: server/lib/commitTestReport.ts lines 65-140; server/prisma/schema.prisma line 1066

---

**[NETA-7-14] MEDIUM: Ground testing records lack IEEE Std 81-2012 method identification and soil resistivity linkage**
No structured field for test method, probe spacing, or soil resistivity. measurementSanity upper bound for ground resistance is 10,000 Ω — far above NETA MTS required maximum of 1-5 Ω.
File: server/lib/measurementSanity.ts lines 21-22

---

## SRE-7 — Senior SRE / Infrastructure Reviewer

**[SRE-7-1] CRITICAL: Advisory lock is session-level — process restart silently drops all crons**
pg_try_advisory_lock releases when connection closes. New process may fail to acquire lock and skip all cron registration permanently with no alert.
File: server/index.ts (advisory lock section)

---

**[SRE-7-2] CRITICAL: pg_dump entire database loaded into Node heap before write**
fsp.readFile() reads entire dump file into memory, then gzip at level 9 in-process. API container is memory-limited to 1 GB. Large account can OOM the API process during 02:00 backup cron.
File: server/lib/backup.ts:176; docker-compose.yml:187

---

**[SRE-7-3] CRITICAL: telemetryReadingPrune cron registered but backing function does not exist**
Cron at 3:50 AM registers telemetryReadingPrune but no implementation exists in server/lib/. TelemetryReading table grows unbounded. 10 channels × 525,600 readings/year.
File: server/index.ts (cron schedule section)

---

**[SRE-7-4] HIGH: Backup stored only on same host by default — droplet destruction = 100% data loss**
Default BACKUP_DEST=local. Startup warning fires but default is still local-only. No off-host copy in default install.
File: docker-compose.yml:30-33; server/lib/backup.ts:66-68

---

**[SRE-7-5] HIGH: Weekly restore test only runs pg_restore --list — not an actual restore**
Integrity check validates TOC only, not actual data. Never restores to a test database, never runs schema validation or row counts.
File: server/lib/restoreTest.ts:1-66

---

**[SRE-7-6] HIGH: Cron heartbeat monitoring requires manual pre-creation of checks — skipped in default install**
Without HEALTHCHECKS_PING_KEY set, all ~20 crons run silently. No default alerting channel for cron failures.
File: server/lib/heartbeat.ts:20-31; server/index.ts:426

---

**[SRE-7-7] HIGH: monthlyDigest silently truncates at 2000 schedules**
take: 2000 hard cap. No cursor pagination, no log indicating truncation. Facility with 300 assets × 8 tasks = 2,400 schedules silently drops 400.
File: server/lib/monthlyDigest.ts:131

---

**[SRE-7-8] HIGH: Single-tenant backup loop — one account failure blocks all others**
Sequential per-account pg_dump with 20-min timeout holds runOnce lock. N accounts: timeout on account 1 delays all subsequent accounts by 20 minutes.
File: server/index.ts (backup cron)

---

**[SRE-7-9] HIGH: No connection pool cap documented or enforced for the deployed Node process**
DATABASE_URL has connection_limit=10 but PrismaClient constructor doesn't set connectionLimit override. Postgres PID limit at risk.
File: docker-compose.yml:213; server/lib/prisma.ts

---

**[SRE-7-10] MEDIUM: Alert engine sweeps ALL accounts in one batch — no per-account timeout**
runAlertEngine() accumulates all accounts in one function call. No timeout, no circuit breaker if Brevo is down.
File: server/lib/alertEngine.ts:468-500

---

**[SRE-7-11] MEDIUM: Brevo API is the single external email dependency — no circuit breaker**
10-second AbortController timeout per send. 200 users × 10s = 33 minutes holding the cron lock during Brevo outage. No fallback SMTP, no dead-letter queue.
File: server/lib/alertEngine.ts:84-116

---

**[SRE-7-12] MEDIUM: Storage and backup S3 credential sets have no cross-validation**
STORAGE_S3_* and BACKUP_S3_* are independent families. startup validateEnv doesn't warn when STORAGE_DEST=s3 but BACKUP_DEST=local (or vice versa).
File: docker-compose.yml:264-279

---

**[SRE-7-13] MEDIUM: API container resource limits undersized for large PDF + AI workloads**
cpus: 0.75, memory: 1g. Single 50-page arc flash PDF rasterized at screen resolution can consume 200-400 MB before AI calls begin. 3 concurrent ingest jobs can hit 1 GB limit.
File: docker-compose.yml:184-188

---

**[SRE-7-14] MEDIUM: Structured logs exist but no log aggregation path configured**
pino-http with json-file driver, 30 MB rolling window. No trace IDs propagated to DB queries. BetterStack is fire-and-forget for AI events only.
File: server/index.ts:491-500; docker-compose.yml logging section

---

## ESO-7 — Chief Electrical Safety Officer

**[ESO-7-1] CRITICAL: No LOTO execution record — procedure written, never proven applied**
No lotoExecution table, lockNumber, performedByUserId, or timestamp of application/removal. Schema comment acknowledges: "future: digital sign-off / performed-by tracking on work orders."
File: server/prisma/schema.prisma:2373-2403; server/routes/loto.ts:1-346

---

**[ESO-7-2] CRITICAL: Energized work permit is generated but never persisted or linked**
arcFlashPermit.ts builds a permit object but there is no EnergyWorkPermit table. No WorkOrder.energizedWorkPermitId FK, no signedAt, no authorizedById, no workerSignatureAt.
File: server/lib/arcFlashPermit.ts:59-147; server/prisma/schema.prisma:1032-1114

---

**[ESO-7-3] CRITICAL: requiresEnergized flag on work order is never validated at job creation**
Arc flash study check fires only at COMPLETE transition. Manager can create and advance a work order on a live-bus asset with no study on file — workers start energized work before the check runs.
File: server/routes/workOrders.ts:552-617, 308-419

---

**[ESO-7-4] CRITICAL: LOTO procedure has no mandatory periodic review / annual certification trigger**
No reviewDueDate, lastReviewedAt, or annualCertifiedAt field on LotoProc. No alert or cron generates a review-overdue notification. Procedures created in 2023 stay active indefinitely.
File: server/prisma/schema.prisma:2373-2403; server/routes/loto.ts:260-315

---

**[ESO-7-5] CRITICAL: Incident investigation workflow has no root-cause analysis, OSHA 300 log integration, or 8-hour reporting chain**
ArcFlashIncident has a single correctiveAction text field and three-state status. No oshaForm300, oshaForm301, daysAway, restrictedWorkDays, or oshaRecordable enforcement.
File: server/routes/arcFlashIncidents.ts:113-133; server/prisma/schema.prisma:3237-3265

---

**[ESO-7-6] HIGH: No employer-side qualification verification — training is self-reported**
ContractorTech stores qualifiedPersonDesignatedAt and trainingExpiresAt but no training content, provider, or third-party verification path. NETA cert level is self-reported by manager.
File: server/prisma/schema.prisma:622-658; server/routes/contractors.ts:340-390

---

**[ESO-7-7] HIGH: No contractor safety prequalification**
Contractor model has netaAccredited, satisfaction scores, notes. No EMR, no insuranceCertExpiry, no COI document, no safetyProgramOnFile, no OSHA recordable rate.
File: server/routes/contractors.ts:232-280

---

**[ESO-7-8] HIGH: PPE compliance verification is not enforced at work order execution**
ppeWorn field only exists on ArcFlashIncident (post-incident). No pre-task PPE attestation field on the work order itself. Permit toComplete checklist is prose only, never recorded as structured data.
File: server/lib/arcFlashPermit.ts:119-124; server/prisma/schema.prisma:1032-1114

---

**[ESO-7-9] HIGH: No emergency response procedure**
Site model has contact fields but no emergencyResponsePlanUrl, nearestAedLocation, firstResponderName, or utilityEmergencyPhone. Work order and LOTO procedure have no emergency reference.
File: server/prisma/schema.prisma:670-701

---

**[ESO-7-10] HIGH: LOTO step requiresVerification has no enforcement — verification can be skipped**
Steps with requiresVerification: true are flagged for UI rendering only. No lotoStepCompletion model. No server-side enforcement that verification was recorded before work commenced.
File: server/prisma/schema.prisma:2443-2445; server/routes/loto.ts:163-169

---

**[ESO-7-11] HIGH: Arc flash incident has no mandatory investigator assignment or completion deadline**
ArcFlashIncident has no investigatorId, investigationDueDate, correctiveActionDueDate, or correctiveActionOwner. Incidents can sit open indefinitely with no assignment.
File: server/prisma/schema.prisma:3237-3265; server/routes/arcFlashIncidents.ts:144-195

---

**[ESO-7-12] MEDIUM: LOTO procedure cannot be linked to a work order**
WorkOrder model has no lotoId FK. No pre-task check that linked asset has an active LOTO procedure. No server-side block preventing WO from advancing to IN_PROGRESS on asset with zero approved LOTO procedures.
File: server/prisma/schema.prisma:1032-1114; server/routes/workOrders.ts:534-549

---

**[ESO-7-13] MEDIUM: No group LOTO / HASP or multi-employer lock coordination**
LotoProc model has no workerCount, haspRequired, worker-lock list, or all-clear verification before re-energization. Single-procedure-per-asset model only.
File: server/prisma/schema.prisma:2373-2452

---

**[ESO-7-14] MEDIUM: Self-approval block on LOTO applies only to procedure author — no second signatory enforcement on arc flash permits**
LOTO correctly prevents createdById from self-approving. Arc flash permit has "authorizing manager" as a prose toComplete item only — no enforcement and since permits aren't stored, no record this was satisfied.
File: server/routes/loto.ts:283-289; server/lib/arcFlashPermit.ts:119-124

---

## INS-7 — Senior Risk Engineering Manager / Underwriter

**[INS-7-1] CRITICAL: No enforcement gate blocks NETA-required work from completion by non-certified contractor**
COMPLETE gate checks open IMMEDIATE deficiencies and arc flash study age. No check that contractor.netaAccredited meets requiresNetaCertified task requirement.
File: server/routes/workOrders.ts:593-617; server/prisma/schema.prisma:599

---

**[INS-7-2] CRITICAL: Instrument calibration currency is free-text, not date-validated**
calDate is z.string().max(200).nullable(). No parsing as date, no comparison against completedDate, no rejection if expired or missing at COMPLETE transition.
File: server/routes/workOrders.ts:71-78, 552-617

---

**[INS-7-3] CRITICAL: Replacement cost / insurable value is structurally incomplete — TIV cannot be generated**
replacementCostCents is nullable with no enforcement. No SOV aggregation route. CFO report uses repairCostEstimate (repair cost, not RCN). Two fields serve different purposes but are conflated.
File: server/prisma/schema.prisma:830, 870; server/lib/cfoReport.ts:69-80

---

**[INS-7-4] CRITICAL: Completed work order date is mutable post-completion with no second-approver**
completedDate can be amended by the same manager who completed the WO. ActivityLog hash chain is settled asynchronously ~30s later. No cryptographic lock on completion.
File: server/routes/workOrders.ts:785-812; server/prisma/schema.prisma:1847-1849

---

**[INS-7-5] HIGH: No OSHA-recordability flag or regulatory reporting chain on incidents**
ArcFlashIncident has no oshaRecordable, injurySeverity, daysAwayFromWork, restrictedWorkDays, reportedToOshaAt, or OSHA Form 301 reference. IncidentLog similarly lacks regulatory classification.
File: server/prisma/schema.prisma:3237-3265, 1244-1265

---

**[INS-7-6] HIGH: Contractor qualification documentation carries no COI / insurance certificate tracking**
Contractor model has no generalLiabilityCertExpiry, workersCompCertExpiry, umbrellaLimitCents, coiDocumentId, or coiExpiresAt. System cannot enforce "do not schedule to contractors with expired COI."
File: server/prisma/schema.prisma:587-619

---

**[INS-7-7] HIGH: Warranty and OEM service contract tracking is document attachment only — no structured expiry enforcement**
warranty is one of 8 DocType values. No Warranty model with warrantyExpiresAt, oem_service_required, authorized_service_interval_months, or authorized_contractor_ids. No warranty_expiry AlertType.
File: server/prisma/schema.prisma:217-226, 162-170

---

**[INS-7-8] HIGH: NFPA 110 transfer switch monthly testing has no enforcement mechanism**
TRANSFER_SWITCH type exists. No auto-creation of monthly MaintenanceSchedule when registered. No interval floor. autoConditionC3 fires after two missed cycles — far beyond NFPA 110 tolerance.
File: server/prisma/schema.prisma:90, 984-1028, 162-170

---

**[INS-7-9] HIGH: Business interruption documentation chain is weather-event scoped only**
DisasterEvent captures weather trigger with declaredAt/resolvedAt. No dailyRevenueAtRisk, extraExpenseLog, affectedProductionUnits, or periodOfRestorationDays. CFO report has no BI exposure calculation.
File: server/prisma/schema.prisma:2462-2504; server/lib/cfoReport.ts:94-120

---

**[INS-7-10] HIGH: Compliance snapshot PDF self-describes as an estimate — cannot serve as primary audit evidence**
CFO report renders mandatory "ESTIMATE — NOT A CERTIFICATION" disclaimer. Finance stakeholders are likely to share this with insurers as the "compliance package," undermining its evidentiary value.
File: server/lib/cfoReport.ts:242-249; server/prisma/schema.prisma:1204-1222

---

**[INS-7-11] MEDIUM: Arc flash study coverage gap — assets linked to superseded study have no re-link enforcement**
When Study B supersedes Study A, SystemStudyAsset rows from Study A remain. No migration logic. No coverageVerifiedAt field. Can block legitimate energized work while stale arc flash labels remain posted.
File: server/prisma/schema.prisma:1282-1315; server/routes/workOrders.ts:604-616

---

**[INS-7-12] MEDIUM: Near-miss events have no mandatory root-cause field or CAPA tracking**
ArcFlashIncident has note and resolvedAt but no rootCause, correctiveActionId FK, capaRequired, or capaCompletedAt. No automatic deficiency or work order created from an incident.
File: server/prisma/schema.prisma:3237-3290

---

**[INS-7-13] MEDIUM: Policy renewal documentation package has no structured generation workflow**
No PolicyRenewal model, no bundled submission package, no submittedToCarrierAt timestamp, no carrierAcknowledgedAt. ShareLink only supports compliance_package kind with no way to attach open deficiencies or incident register.
File: server/prisma/schema.prisma:1204-1222, 1612-1638

---

**[INS-7-14] MEDIUM: DGA Status-3 result generates no automatic alert, deficiency, or escalation**
ieeeStatus Int? stored on LabSample. No AlertType for DGA escalation. No trigger creating a deficiency or work order when ieeeStatus = 3. cfoReport.ts does not query LabSample at all.
File: server/prisma/schema.prisma:1529; server/prisma/schema.prisma:162-170; server/lib/cfoReport.ts:50-64
