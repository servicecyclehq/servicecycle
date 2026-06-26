# DEMO LANDMINES v5 — ServiceCycle Adversarial Scan

**Scan date:** 2026-06-26  
**Method:** 8 parallel agents, completely new personas not used in v1–v4  
**Total findings:** 102 across 8 categories  
**Prior scans:** v1 (SEC, UX, R), v2 (ARC, SEED, SEC2, REL2, UX2, SCHEMA, TEST, CI), v3 (INS, ESP, DB, LEG, UXR, INFRA, INT, PMF), v4 (SOC, PWA, APPSEC, TSQ, CS, SRE, MT, DI)

---

## Scan Categories

| Prefix | Persona | Findings |
|--------|---------|----------|
| NETA | NETA Level III Certified Test Technician | 12 |
| ISEC | IT Security Architect / Container Security | 13 |
| PG | PostgreSQL DBA | 14 |
| A11Y | WCAG 2.1 AA Accessibility Auditor | 13 |
| PRIV | Privacy Counsel / CCPA+GDPR | 12 |
| AFX | NFPA 70E 2024 Implementation Accuracy | 12 |
| REV | Financial/Revenue Analyst (PE Diligence) | 13 |
| DX | Developer Experience / API Quality | 13 |

---

## NETA — NETA Level III Test Technician

**[NETA-1] No Dedicated Structured Trip-Time Fields for Circuit Breaker Testing**  
Severity: HIGH  
NETA MTS-2023 §7.6 requires recording primary-injection trip times at 300%, 500%, and instantaneous overcurrent multiples. The `TestMeasurement` model uses a generic `measurementType` string and single `asFoundValue`/`asLeftValue` decimal pair. `DeviceTestRecord` stores trip results as unstructured `asFoundSettings Json?` blob. No structured `injectionCurrentA` or `overcurrentMultiple` fields exist. No completion gate enforces that all three required points are recorded before a CIRCUIT_BREAKER work order completes.  
File: `schema.prisma` lines 1119–1153 (TestMeasurement), 3202–3222 (DeviceTestRecord)  
Fix: Add `overcurrentMultiplePct Int?` and `primaryCurrentA Decimal?` to `TestMeasurement`. Add completion gate on CIRCUIT_BREAKER work orders requiring measurement rows per required multiple.

**[NETA-2] IR Thermography Ingest Discards Load Current, Ambient Temperature, and Emissivity**  
Severity: HIGH  
NETA MTS-2023 §7.22.3 and NETA Table 100.18 require load current at scan time (% of nameplate), ambient temperature, emissivity, and instrument make/model/serial. The thermography ingest endpoint (`thermographyIngest.ts` lines 27–43) accepts only `{ location, deltaT, note }` plus optional `surveyDate`. The `TestMeasurement` model has `loadPercent` and `ambientTempC` on `WorkOrder`, but the ingest pathway creates `Deficiency` records directly (lines 82–93), bypassing `TestMeasurement` entirely. Delta-T is encoded as plain text in deficiency description rather than as a stored numeric value.  
File: `server/routes/thermographyIngest.ts` lines 27–43, 82–93; `schema.prisma` line 1137  
Fix: Require `loadPercent`, `ambientTempC`, and `emissivity` as request fields. Record as `TestMeasurement` rows, not discarded.

**[NETA-3] NETA Cert Level Minimum Recorded but Never Enforced at Completion**  
Severity: HIGH  
NETA MTS-2023 §5.1 requires certified personnel at the appropriate level. `MaintenanceTaskDefinition` has `netaCertLevelMin NetaCertLevel?` and `requiresNetaCertified Boolean`, but the COMPLETE transition handler (`workOrders.ts` lines 535–719) contains zero cert-level enforcement. A LEVEL_I tech can complete a task requiring LEVEL_III with no warning or block.  
File: `server/routes/workOrders.ts` lines 333–334, 535–570; `server/scripts/seed-standards.js` line 130  
Fix: In the COMPLETE transition handler, fetch tech's `netaCertLevel` and compare against `taskDefinition.netaCertLevelMin`. Return 400/422 if insufficient.

**[NETA-4] Insulation Resistance Test Duration and Polarization Index Not Captured**  
Severity: HIGH  
NETA MTS-2023 §7.2 requires test duration in minutes (for computing Polarization Index = 10-min reading / 1-min reading). `TestMeasurement` has no `testDurationMinutes` field, no `piRatio` or `darRatio`. The seed task `XFMR_INSULATION_RES` references "PI" in description but no route enforces both readings are present.  
File: `schema.prisma` lines 1119–1153; `server/scripts/seed-standards.js` lines 163–167  
Fix: Add `testDurationMinutes Int?` and computed `piRatio Decimal?` to `TestMeasurement`.

**[NETA-5] Test Equipment Calibration Date Is Unvalidated String — No Expiry Check**  
Severity: MEDIUM  
NETA MTS-2023 §5.4.2 requires documenting test equipment make, model, serial, and current calibration date. `calDate` in `TestEquipmentSchema` is `z.string().max(200).nullable().optional()` — any string accepted. No date parsing, no expiry check, no warning if `calDate` is in the past.  
File: `server/routes/workOrders.ts` lines 71–78; `schema.prisma` line 1068  
Fix: Change `calDate` to ISO date regex validation. Add soft warning at COMPLETE time if any instrument's `calDate` is >12 months old or missing.

**[NETA-6] Asset Nameplate Missing BIL and Impedance % Typed Fields**  
Severity: MEDIUM  
NETA MTS-2023 §5.4.2 requires BIL (kV) and impedance % for transformer/switchgear acceptance tests. These fall into the catch-all `nameplateData Json?` field. The `FIELDS` array in `NameplateCard.jsx` (lines 16–21) does not include `bilKv` or `impedancePct`.  
File: `schema.prisma` lines 784–790; `client/src/components/NameplateCard.jsx` lines 16–21  
Fix: Add `bilKv Decimal?` and `impedancePct Decimal?` as typed columns on `Asset` or add to `FIELDS` array with OCR extraction prompts.

**[NETA-7] Deficiency-to-Re-Test Chain Not Formally Linked**  
Severity: MEDIUM  
NETA MTS-2023 §5.5 and §8 require Deficiency → Corrective Action WO → Re-test WO → pass/fail chain. The `Deficiency` model has `correctiveAction String?` (text memo) and `resolvedAt DateTime?`, but no `retestWorkOrderId` FK. `resolvedAt` can be set with a text note alone — no work order required. No machine-readable re-test result stored.  
File: `schema.prisma` lines 1159–1180; `server/routes/workOrders.ts` lines 1081–1096  
Fix: Add `retestWorkOrderId String?` FK on `Deficiency`. Gate `IMMEDIATE` deficiency resolution on presence of linked completed re-test work order.

**[NETA-8] MV Switchgear CB Trip Interval Is 48 Months — NETA Requires Annual for Class E2**  
Severity: MEDIUM  
NETA MTS-2023 Table 100-1 requires annual testing for medium-voltage drawout switchgear Class E2 (>1000A or >50kA interrupting). The `SWGR_CB_TRIP` task definition in `seed-standards.js` (line 128) seeds `c2: 48` months uniformly. No `voltageClassKv` or `dutyClass` field on `Asset` to support voltage-class-differentiated intervals.  
File: `server/scripts/seed-standards.js` line 128; `server/lib/maintenanceInterval.ts` line 13–15  
Fix: Add `voltageClassKv Decimal?` to `Asset`. Create separate task definitions `SWGR_CB_TRIP_MV` (c2: 12) and `SWGR_CB_TRIP_LV` (c2: 48).

**[NETA-9] Transformer Acceptance Test Has No Multi-Point Structured Data Model**  
Severity: MEDIUM  
NETA ATS-2021 §7.2 requires 13–18 measurement points for a transformer acceptance test. `TestMeasurement` has no `testGroupId` to link measurements into a single acceptance test sequence, and no `tanDeltaPct Decimal?` for power factor/dissipation factor.  
File: `schema.prisma` lines 1073 (isAcceptanceTest), 1119–1153 (TestMeasurement)  
Fix: Add `testGroupId String?` and `tanDeltaPct Decimal?` to `TestMeasurement`. Add completion gate for `isAcceptanceTest=true` WOs on TRANSFORMER assets checking required measurement types.

**[NETA-10] In-House User Qualification Cannot Be Attested**  
Severity: MEDIUM  
NETA certification fields (`netaCertLevel`, `qemwCertNumber`, etc.) exist only on `ContractorTech` (`schema.prisma` lines 631–652). The `User` model (lines 458–519) has no certification fields. A work order assigned to an in-house employee (`assignedUserId`) cannot capture their NETA cert level — the field is only copied from `ContractorTech` at creation.  
File: `schema.prisma` lines 458–519 (User — no cert fields), 1042–1050 (WorkOrder)  
Fix: Add `netaCertLevel NetaCertLevel?`, `qualifiedPersonDesignatedAt DateTime?`, `trainingExpiresAt DateTime?` to `User` model.

**[NETA-11] Contact Resistance Acceptance Criterion Has No Type-Specific Lookup**  
Severity: LOW  
NETA MTS-2023 Table 100.12 specifies contact resistance acceptance criteria varying by breaker frame rating. `TestMeasurement.expectedRange` (line 1132) is free-text. No lookup table or structured `acceptanceCriterionId` FK links measurements to machine-readable criteria.  
File: `schema.prisma` lines 1129, 1132  
Fix: Create `AcceptanceCriterion` table with `taskCode`, `equipmentType`, `parameterName`, `minValue`, `maxValue`, `unit`, `sourceRef`. Add `acceptanceCriterionId String?` FK to `TestMeasurement`.

**[NETA-12] Thermography Delta-T Embedded in Plain-Text String — Not Machine-Readable**  
Severity: LOW  
Thermography commit (`thermographyIngest.ts` lines 84–91) encodes delta-T as plain text in the deficiency `description`. Year-over-year trending requires text parsing rather than a numeric query. `deltaTCelsius` is not a separate column.  
File: `server/routes/thermographyIngest.ts` lines 84–91; `schema.prisma` lines 1159–1180  
Fix: Add `deltaTCelsius Decimal?` and `loadPctAtScan Decimal?` to `Deficiency` model.

---

## ISEC — IT Security Architect / Container Security

**[ISEC-1] CRITICAL — Live API Keys in `server/.env` On Disk**  
Severity: CRITICAL  
`server/.env` (correctly gitignored) contains real `GROQ_API_KEY`, `GEMINI_API_KEY`, and `MASTER_KEY` (encryption root key). Risk: file included in Docker build context or repo zip. The CI pre-deploy backup (`deploy.yml` line 62) produces an unencrypted pg_dump in `/root/` — not encrypted with `MASTER_KEY`.  
File: `server/.env` lines 10–13; `.github/workflows/deploy.yml` line 62  
Fix: Rotate `GROQ_API_KEY` and `GEMINI_API_KEY`. Add `--exclude server/.env` to Docker build or verify `.dockerignore`. Encrypt CI pre-deploy backup.

**[ISEC-2] HIGH — Dev Client Dockerfile Runs Vite Dev Server as Root**  
Severity: HIGH  
`client/Dockerfile` has no `USER` directive — process runs as root (UID 0). Server Dockerfile correctly uses `USER node` (line 106). Production client image uses `nginx:1.25-alpine` which runs master nginx as root.  
File: `client/Dockerfile` (entire file)  
Fix: Add `USER node` before `CMD` in `client/Dockerfile`. Use `nginxinc/nginx-unprivileged` for prod nginx.

**[ISEC-3] HIGH — No Container Network Segmentation (Flat Default Bridge)**  
Severity: HIGH  
Neither `docker-compose.yml` nor `docker-compose.ghcr.yml` defines a `networks:` block. All services share Docker's default bridge — the client nginx container has direct TCP access to port 5432 on the db container.  
File: `docker-compose.yml` (entire services block); `docker-compose.ghcr.yml`  
Fix: Define `frontend` and `backend` networks. Assign db + server to `backend`, server + client to `frontend`. Remove db from `frontend`.

**[ISEC-4] HIGH — `cap_drop: ALL` Removed from Server/DB in Dev Compose File**  
Severity: HIGH  
`docker-compose.yml` intentionally removed `cap_drop: ALL` and `read_only: true` from db and server services due to entrypoint compatibility. Server container has full Linux capability set (CAP_NET_RAW, CAP_SYS_CHROOT, etc.). `docker-compose.ghcr.yml` retains `cap_drop: ALL` only for server.  
File: `docker-compose.yml` lines 61–65, 165–167  
Fix: `cap_drop: ALL` is achievable for the server service without entrypoint issues. Decouple db entrypoint issue from server capabilities. Sync from `docker-compose.ghcr.yml`.

**[ISEC-5] HIGH — Floating Base Image Tags (No SHA Digest Pinning)**  
Severity: HIGH  
All base images use mutable floating tags: `node:20-alpine`, `nginx:1.25-alpine`, `postgres:16-alpine`. A supply-chain attack compromising upstream images is silently adopted on next build.  
File: All Dockerfiles, both compose files  
Fix: Pin every base image to SHA-256 digest. Use Dependabot/Renovate for automated digest updates.

**[ISEC-6] HIGH — CI/CD Deploy Workflow Has No `permissions:` Block; Deploy Key Runs as Root**  
Severity: HIGH  
Neither `deploy.yml` nor `ci.yml` declares `permissions:`. GitHub defaults grant broad write access. Deploy workflow uses `SC_SSH_USER = root` — key grants full host root access. Third-party actions use mutable `@v4` tags, not SHA-pinned.  
File: `.github/workflows/deploy.yml` (entire file)  
Fix: Add `permissions: contents: read` at workflow top. Create non-root deploy user with limited sudo. Pin actions to SHA digests.

**[ISEC-7] MEDIUM — nginx `client/nginx.conf` Sets No Security Headers**  
Severity: MEDIUM  
nginx serving the SPA emits no `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Content-Security-Policy`, or `Strict-Transport-Security` headers. Helmet sets these for API responses but SPA's `index.html` is unprotected.  
File: `client/nginx.conf` lines 1–74  
Fix: Add security headers to `nginx.conf` for `location /` and static blocks.

**[ISEC-8] MEDIUM — Upload/Backup Volumes Not Read-Only Where Appropriate**  
Severity: MEDIUM  
Both bind mounts use default read-write mode: `./uploads:/app/uploads` and `./backups:/app/backups`. Attacker with container write access to `./backups` can overwrite backup files on the host filesystem.  
File: `docker-compose.yml` lines 352, 357  
Fix: Set restrictive host-level permissions on `./backups`. Long-term: split upload serving into read-only-mounted nginx container.

**[ISEC-9] MEDIUM — No CPU Limits on Any Container**  
Severity: MEDIUM  
All services set `mem_limit`, `pids_limit`, and `ulimits: nofile`, but no `cpus:` quota. On a 1–2 vCPU droplet, a runaway process can starve all other containers including the database.  
File: Both compose files — all service definitions  
Fix: Add CPU limits: server `0.75`, db `0.50`, client `0.25` via `deploy.resources.limits`.

**[ISEC-10] MEDIUM — `^` Version Prefixes on Security-Critical Server Dependencies**  
Severity: MEDIUM  
All production dependencies use `^` (caret) including `jsonwebtoken`, `express`, `bcryptjs`, `multer`, `jose`. A compromised maintainer pushing a malicious patch release is automatically adopted on next `npm ci`.  
File: `server/package.json` lines 29–63  
Fix: Remove `^` from 4–5 highest-risk packages (JWT, bcrypt, multer, express). Use Dependabot for deliberate version bump PRs.

**[ISEC-11] MEDIUM — HSTS `preload: false`; No HSTS from nginx Layer**  
Severity: MEDIUM  
Helmet HSTS sets `preload: false` (`server/index.ts` line 564). Without preloading, first-visit requests are over HTTP before redirect. nginx layer emits no HSTS at all.  
File: `server/index.ts` line 564; `client/nginx.conf`  
Fix: Submit domain to HSTS preload list. Change to `preload: true`. Add HSTS to `nginx.conf`.

**[ISEC-12] LOW — GitHub Actions Pinned to Mutable Tag Refs, Not SHA Digests**  
Severity: LOW  
`actions/checkout@v4` and `actions/setup-node@v4` use mutable tags. A compromised `actions` org account or force-pushed tag would execute attacker code with access to `SC_SSH_KEY`.  
File: `.github/workflows/deploy.yml` lines 27, 30; `ci.yml`  
Fix: Pin to full commit SHA digests. Use `pin-github-action` or Dependabot `actions` update config.

**[ISEC-13] LOW — `gzip_vary` Missing; Gzip Over Proxied API Path (BREACH Exposure)**  
Severity: LOW  
Gzip enabled without `gzip_vary on`. Responses served without `Vary: Accept-Encoding` can confuse shared caches. Gzip compression of responses mixing secret and attacker-controlled content is the BREACH attack precondition.  
File: `client/nginx.conf` lines 8–11  
Fix: Add `gzip_vary on;`. Disable gzip for `/api/` proxy path or document that SameSite cookies mitigate BREACH.

---

## PG — PostgreSQL DBA

**[PG-1] Missing Partial Index: Open Deficiency Queries Are Full-Table-Filtered**  
Severity: HIGH  
Dashboard queries filter `WHERE resolvedAt IS NULL` on `deficiencies`. The composite `(accountId, severity, resolvedAt)` index helps when severity is also in the predicate, but pure `(accountId, resolvedAt IS NULL)` scans all rows for an account then filters. No partial index restricts to unresolved rows only.  
File: `schema.prisma` lines 1177–1183; `server/routes/deficiencies.ts:66`, `dashboard.ts:70`  
Fix: `CREATE INDEX CONCURRENTLY idx_deficiencies_account_open ON deficiencies (account_id, created_at DESC) WHERE resolved_at IS NULL;`

**[PG-2] Missing Partial Index: Active Work Order Queries Scan All Statuses**  
Severity: HIGH  
Most frequent pattern is `WHERE accountId = ? AND status IN ('SCHEDULED', 'IN_PROGRESS')`. As COMPLETE/CANCELLED records dominate, the `(accountId, status)` index grows with dead weight. No partial index on live statuses.  
File: `schema.prisma` lines 1105–1113; `server/routes/workOrders.ts:200`  
Fix: `CREATE INDEX CONCURRENTLY idx_work_orders_account_active ON work_orders (account_id, scheduled_date) WHERE status IN ('SCHEDULED', 'IN_PROGRESS');`

**[PG-3] RefreshToken Prune Misses Revoked Tokens — Revoked Tokens Accumulate Forever**  
Severity: HIGH  
Nightly cron deletes `refresh_tokens WHERE expiresAt < NOW - 30d`. Revoked tokens with future `expiresAt` (revoked 5 min after login, still has 30-day TTL) are never pruned. Tokens linger up to 60 days. No index on `revokedAt`.  
File: `server/index.ts` lines 1972–1982  
Fix: Add `@@index([revokedAt])` to `RefreshToken`. Update prune query to include `OR { revokedAt: { not: null, lt: cutoff } }`.

**[PG-4] ActivityLog: No Composite (accountId, action, createdAt) Index**  
Severity: MEDIUM  
Admin queries filter `(accountId, action, createdAt)` triple. The existing `(accountId, createdAt)` index forces an `action` heap filter. With 36,000+ rows per busy account at 365-day retention, this degrades.  
File: `schema.prisma` lines 1835–1865  
Fix: `CREATE INDEX CONCURRENTLY idx_activity_logs_account_action_date ON activity_logs (account_id, action, created_at DESC);`

**[PG-5] Prisma Client: No Log Config or Transaction Timeout**  
Severity: MEDIUM  
`server/lib/prisma.ts` instantiates `new PrismaClient()` with no `log` config and no `transactionOptions.timeout`. Default Prisma transaction timeout is 5 seconds — silent conflict with long ingest operations (10–20s).  
File: `server/lib/prisma.ts` lines 1–24  
Fix: Configure `log: [{ level: 'warn', emit: 'stdout' }]` and `transactionOptions: { timeout: 25000, maxWait: 5000 }`.

**[PG-6] Connection Pool Default of 10 Too Small for Cron Workload**  
Severity: MEDIUM  
`DATABASE_URL` defaults to `connection_limit=10`. The nightly 03:xx window stacks 8+ concurrent crons. With 10 pool slots shared with live HTTP requests, pool contention manifests as `pool_timeout` errors during cron windows.  
File: `docker-compose.yml` line 197; `server/.env.example` line 25  
Fix: Set `DB_CONNECTION_LIMIT=20` for production. Explicitly set `max_connections=100` in PostgreSQL command flags.

**[PG-7] Double-Compression: Gzip Over `pg_dump --format=custom`**  
Severity: MEDIUM  
`runPgDump()` uses `--format=custom --compress=6` then pipes through Node.js `createGzip({ level: 9 })`. Custom-format pg_dump is already LZ-compressed. Second gzip adds CPU time for 1–3% size reduction on a 1GB dump, wasting 30–60 seconds.  
File: `server/lib/backup.ts` lines 153, 188–196  
Fix: Remove `gzipBuffer()` from backup pipeline. `--compress=6` on `pg_dump --format=custom` is sufficient. Rename output to `.pgcustom.enc` to accurately reflect format.

**[PG-8] `pg_dump` Missing `--schema=public` Flag**  
Severity: LOW  
No `--schema=public` flag in pg_dump args. If extensions are installed in non-public schemas, dump scope is inconsistent. Restore to a fresh database may fail with "extension already exists" if pgcrypto/uuid-ossp is in `public`.  
File: `server/lib/backup.ts` line 153  
Fix: Add `--schema=public` to pg_dump args for explicit, restore-safe scope.

**[PG-9] Docker Healthcheck Uses `pg_isready` — Does Not Verify Schema Accessibility**  
Severity: MEDIUM  
`pg_isready` only checks TCP connection acceptance, not that the `servicecycle` database exists, has correct permissions, or that application tables are present. A partial restore failure would show healthy.  
File: `docker-compose.yml` lines 130–134  
Fix: Replace with `psql -U ${POSTGRES_USER} -d ${POSTGRES_DB} -c 'SELECT 1' > /dev/null 2>&1`.

**[PG-10] No Autovacuum Tuning for High-Write Tables**  
Severity: MEDIUM  
Default `autovacuum_vacuum_scale_factor = 0.2` means 20% of rows must be dead before vacuum fires. For `telemetry_readings` (continuous sensor data) and `activity_logs` (every user action), this delays vacuum significantly, leading to table bloat.  
File: `docker-compose.yml` lines 106–119  
Fix: Add `-c autovacuum_vacuum_scale_factor=0.05` to PostgreSQL command flags. Add per-table `ALTER TABLE telemetry_readings SET (autovacuum_vacuum_scale_factor = 0.01)`.

**[PG-11] Missing Index on `refresh_tokens.revokedAt` — Token Auth Queries Scan Full Table**  
Severity: MEDIUM  
Multiple hot-path auth queries filter `WHERE userId = ? AND revokedAt IS NULL`. Current indexes are `userId` and `tokenHash` only. No index on `revokedAt`.  
File: `schema.prisma` lines 2021–2036  
Fix: Add `@@index([userId, revokedAt])` or a partial index `ON refresh_tokens (user_id) WHERE revoked_at IS NULL`.

**[PG-12] No Partial Index for Open TelemetryNotifications**  
Severity: LOW  
Hot-path queries filter `WHERE acknowledgedAt IS NULL AND autoResolved = false`. Existing composite indexes include all acknowledged rows (majority over time), making the index larger than necessary.  
File: `schema.prisma` lines 2919–2942  
Fix: `CREATE INDEX CONCURRENTLY idx_telemetry_notifications_account_open ON telemetry_notifications (account_id, created_at DESC) WHERE acknowledged_at IS NULL AND auto_resolved = false;`

**[PG-13] `FailedLoginAttempt`: No Composite `(email, attemptedAt)` Index**  
Severity: LOW  
Lockout query is `WHERE email = ? AND attemptedAt > NOW - window`. Current single-column indexes on `email` and `attemptedAt` separately require heap filter. During brute force, this table is hit on every login attempt.  
File: `schema.prisma` lines 3376–3386  
Fix: Add `@@index([email, attemptedAt(sort: Desc)])`.

**[PG-14] `AiUsage`: No Prune Job; `@@index([day])` Is Orphaned**  
Severity: LOW  
`AiUsage` rows accumulate without bound — 3-year deployment with 50 users → ~164,000 rows. `@@index([day])` exists but serves no maintenance purpose (no prune job uses it). Quota tracking >90 days old serves no rate-limiting purpose.  
File: `schema.prisma` lines 1907–1918; `server/index.ts` (no prune for `ai_usage`)  
Fix: Add daily prune cron deleting rows where `day < NOW - 90 days`.

---

## A11Y — WCAG 2.1 AA Accessibility Auditor

**[A11Y-1] CRITICAL — WCAG 2.4.3: CompleteModal Missing Focus Trap and Focus Restore**  
Severity: CRITICAL  
`CompleteModal` in `WorkOrderDetail.jsx` (lines 85–175) renders `role="dialog" aria-modal="true"` but does not import or invoke `useFocusTrap`. On open, focus stays on the triggering button behind the backdrop. Tab cycles the entire page. On close, focus is not restored. `ConfirmDialog.jsx` and `FeedbackModal.jsx` both correctly use `useFocusTrap`.  
File: `client/src/pages/WorkOrderDetail.jsx` lines 85–175  
Fix: Add `const dialogRef = useRef(null); useFocusTrap(dialogRef, { onClose });` and attach `ref={dialogRef}` to the outer `<div role="dialog">`.

**[A11Y-2] HIGH — WCAG 2.4.7: `.form-control:focus-visible { outline: none }` Removes Focus Ring From All Form Inputs**  
Severity: HIGH  
`index.css` line 169 sets `.form-control:focus-visible { outline: none }` — removing the focus indicator from every `<input>`, `<select>`, and `<textarea>` in the app. The box-shadow-only fallback fails in Windows High Contrast mode (forced colors suppress box-shadow).  
File: `client/src/index.css` line 169  
Fix: Replace `outline: none` with `outline: 2px solid transparent` (present for forced-color) or use `outline: 2px solid var(--color-primary); outline-offset: -1px`.

**[A11Y-3] HIGH — WCAG 2.4.7: Inline `outline: none` on Inputs With No Substitute Focus Indicator**  
Severity: HIGH  
The global search `<input>` in `Sidebar.jsx` (line 115) has `outline: 'none'` as an inline style, overriding the global `:focus-visible` catch-all. Same issue in `FieldScan.jsx` line 76 and `FieldAsset.jsx` lines 106, 926, 1278.  
File: `client/src/components/Sidebar.jsx` line 115; `FieldScan.jsx` line 76; `FieldAsset.jsx` lines 106, 926, 1278  
Fix: Remove `outline: 'none'` from inline styles on all four inputs.

**[A11Y-4] HIGH — WCAG 1.3.1: WorkOrderDetail `<label>` Elements Have No `htmlFor`/`id` Association**  
Severity: HIGH  
The entire `WorkOrderDetail.jsx` form pattern uses visual `<label>` elements without `htmlFor` attributes, paired with inputs that have no `id`. ~25 occurrences at lines 117, 132, 144, 156, 725, 736, 752, 763, 771, 780, 812, 820, 1007–1050, 1115–1125. Screen readers cannot associate labels with controls; browser click-to-focus is broken.  
File: `client/src/pages/WorkOrderDetail.jsx` (many lines)  
Fix: Add `id` to each input/select and matching `htmlFor` on each `<label>`.

**[A11Y-5] HIGH — WCAG 4.1.2: Sidebar "Add Asset" Icon Button Has No `aria-label`**  
Severity: HIGH  
The `+` quick-add button next to Assets nav uses only `title="Add asset"` — unreliable as accessible name in VoiceOver/iOS. Inner SVG is not aria-hidden.  
File: `client/src/components/Sidebar.jsx` lines 670–688  
Fix: Add `aria-label="Add asset"` to button. Mark inner SVG `aria-hidden="true"`.

**[A11Y-6] HIGH — WCAG 4.1.2: FeedbackModal Close Button Has No `aria-label`**  
Severity: HIGH  
Close button uses `title="Close"` only — not reliably announced by VoiceOver. No `aria-label`. Inner SVG not aria-hidden. Screen reader users hear "button" with no name.  
File: `client/src/components/FeedbackModal.jsx` lines 121–130  
Fix: Add `aria-label="Close"` to button and `aria-hidden="true"` to inner SVG.

**[A11Y-7] MEDIUM — WCAG 1.4.3: ViewerBanner Text `#94a3b8` on `#0e1017` ≈ 4.0:1 (Below AA)**  
Severity: MEDIUM  
`ViewerBanner` in `Sidebar.jsx` (lines 239–254) uses `color: 'rgb(148, 163, 184)'` on `rgba(100, 116, 139, 0.12)` background composited over `#0a0d12`. Computed contrast ≈ 4.0:1, below the 4.5:1 AA minimum for 12px text.  
File: `client/src/components/Sidebar.jsx` lines 239–254  
Fix: Bump to `#b0bccc` (~5.2:1) or use `var(--color-sidebar-label, #cbd5e1)`.

**[A11Y-8] MEDIUM — WCAG 1.4.4: Entire Font Scale Defined in `px`, Blocking Browser Text Scaling**  
Severity: MEDIUM  
CSS custom property font scale uses absolute `px`: `--font-size-xs: 11px`, `--font-size-sm: 12px`, `--font-size-base: 15px`. Browser default font size changes have no effect. 11px and 12px sizes are near-illegible for low-vision users.  
File: `client/src/index.css` lines 4–15; `client/src/styles/tokens.css` lines 97–103  
Fix: Convert to `rem`: `--font-size-xs: 0.6875rem`, `--font-size-sm: 0.75rem`, `--font-size-base: 0.9375rem`. Change `body { font-size: 15px }` to `body { font-size: 0.9375rem }`.

**[A11Y-9] MEDIUM — WCAG 3.3.1: Form Validation Errors Not Linked to Inputs via `aria-describedby`**  
Severity: MEDIUM  
Error messages use `role="alert"` (correct for announcement) but no `aria-describedby` link to the offending input. A screen reader user navigating back to fix the error hears no indication of the associated error. Inputs have no `aria-invalid="true"`.  
File: `client/src/pages/NewAsset.jsx`; `FeedbackModal.jsx` line 221; `Login.jsx` line 176; `WorkOrderDetail.jsx` line 114  
Fix: Assign stable `id` to each error `<div>`. Add `aria-describedby={errorId}` and `aria-invalid={!!error}` to the corresponding input.

**[A11Y-10] MEDIUM — WCAG 1.1.1: FieldScan Camera `<video>` Has No Accessible Description**  
Severity: MEDIUM  
The full-screen `<video>` for live QR scanning (lines 252–257) has no `aria-label`, `title`, or `aria-describedby`. The visible instruction text at line 272 is not associated with the video element.  
File: `client/src/pages/field/FieldScan.jsx` lines 252–257  
Fix: Add `aria-label="Live camera feed for QR code scanning"` to `<video>`.

**[A11Y-11] MEDIUM — WCAG 4.1.2: ActionDropdown Menu Items Use `<div role="menuitem">` With `outline: none`**  
Severity: MEDIUM  
Menu items are `<div role="menuitem">` with manual `onKeyDown` handlers. Inline style at line 187 includes `outline: 'none'`. Global `:focus-visible` rule covers `[role="button"]` but not `[role="menuitem"]` — no visible focus ring for keyboard users.  
File: `client/src/components/ActionDropdown.jsx` lines 161–200  
Fix: Replace with `<button type="button" role="menuitem">`. Remove `outline: 'none'` from item style.

**[A11Y-12] LOW — WCAG 2.4.3: InfoTip Uses `aria-label={content}` on Trigger Instead of `aria-describedby`**  
Severity: LOW  
`InfoTip` trigger `<span>` sets `aria-label={content}` — full tooltip text is announced as the button's name. `role="tooltip"` element has `pointerEvents: 'none'` preventing hover read per WCAG 1.4.13.  
File: `client/src/components/InfoTip.jsx` lines 16–29  
Fix: Give tooltip span a stable `id`. Change trigger to `aria-label="More information"` with `aria-describedby={tooltipId}`. Remove `pointerEvents: 'none'`.

**[A11Y-13] LOW — WCAG 1.3.1: Sidebar Nav Section Labels Not Associated with Link Groups**  
Severity: LOW  
Section heading labels ("Equipment", "Operations") are plain `<div className="nav-section-label">` elements. Not exposed as group labels. Screen reader user traversing nav hears a flat list of 20+ links with no grouping cue.  
File: `client/src/components/Sidebar.jsx` (nav section labels)  
Fix: Wrap each nav section's links in `<ul role="group" aria-labelledby="section-label-id">` and give section label a matching `id`.

---

## PRIV — Privacy Counsel / CCPA+GDPR

**[PRIV-1] HIGH — GDPR Article 13: Legal Basis Not Mapped Per Processing Purpose**  
Regulation: GDPR Articles 13(1)(c) and 13(2)(a)  
Privacy policy applies legal bases to the demo sandbox as a whole, not per processing purpose. Missing: IP logging from marketing site (legitimate interests), EarlyAccessRequest IP/UA capture (not disclosed), post-erasure anonymized audit row retention (legitimate interests basis and cap).  
File: `client/src/legal/privacy-draft-2026-05.md` line 72  
Fix: Add per-purpose legal basis table to Section 3. Include marketing-site IP logging, early-access form IP/UA, and post-erasure audit row retention.

**[PRIV-2] HIGH — No Data Processing Agreement in Pilot SOW Template**  
Regulation: GDPR Article 28; CPRA §1798.100(d)  
Pilot SOW template (entire file) contains no DPA and no reference to one. GDPR Article 28 mandatory clauses are absent — no subject-matter, duration, data categories, or processor obligations. Contractor customer employees are data subjects with no contractual protection.  
File: `docs/PILOT_SOW_TEMPLATE.md` (entire file)  
Fix: Draft GDPR Article 28-compliant DPA addendum as SOW annex. Include EU SCCs Module 2. Reference in SOW Section 6.

**[PRIV-3] HIGH — GDPR Article 17: IncidentLog PII Not Nulled on User Erasure**  
Regulation: GDPR Article 17  
The erasure route handles User row, ActivityLog, EarlyAccessRequest — but `IncidentLog.resolvedById` and `IncidentLog.createdById` (schema lines 1253–1254) are plain `String?` fields with no `@relation` and no `onDelete` cascade. These user ID strings persist unchanged after user deletion.  
File: `server/routes/users.ts` lines 769–864; `schema.prisma` lines 1244–1265  
Fix: Add FK relations with `onDelete: SetNull` for `IncidentLog.resolvedById` and `IncidentLog.createdById`, or add explicit `updateMany` step in erasure transaction.

**[PRIV-4] MEDIUM — CCPA/CPRA: Public Parser Lead Capture Not Disclosed in Privacy Notice**  
Regulation: CCPA §1798.100; GDPR Articles 13/14  
`POST /api/public/parse-report` captures and stores email as `PublicParseLead` (schema lines 1228–1242). Privacy policy Section 2.1 lists only four collection points — public parser is absent. No retention period specified for `PublicParseLead` rows.  
File: `server/routes/publicParse.ts` lines 56–80; `schema.prisma` lines 1228–1242  
Fix: Add public parser to privacy policy Section 2.1. Set 36-month retention. Add prune cron or TTL.

**[PRIV-5] MEDIUM — GDPR Article 13: No Retention Period for Production Tenant Personal Data**  
Regulation: GDPR Article 13(2)(a)  
Privacy policy Section 5 addresses retention only for the demo sandbox. No retention schedule for production tenant data — ContractorTech records, work order labor records, arc flash study data, incident logs. The `RetentionTier` enum and `retentionTier` on Account exist but are not surfaced in the privacy policy.  
File: `client/src/legal/privacy-draft-2026-05.md` lines 113–120  
Fix: Add Section 5A "Production tenant data" with retention schedule. State 7-year STANDARD tier basis per NETA record-keeping requirements.

**[PRIV-6] MEDIUM — No Account-Level Erasure Path**  
Regulation: GDPR Article 17; CCPA §1798.105  
Individual user erasure exists but no account-level erasure endpoint. `ComplianceSnapshot` rows explicitly have no delete path (deferred). Privacy policy describes a deletion right exercisable by email but no automated mechanism or manual runbook.  
File: `server/routes/accounts.ts` (no erasure endpoint)  
Fix: Document manual account deletion runbook covering cascade behavior. Add runbook reference to privacy policy. Prioritize automated `DELETE /api/accounts/me` for acquisition diligence.

**[PRIV-7] MEDIUM — Breach Notification: No Mechanism to Identify Affected EU Residents**  
Regulation: GDPR Article 33(3)(c)–(d)  
Incident response plan (Phase 6) identifies the 72-hour notification obligation but has no mechanism to identify which data subjects were affected or whether any are EU residents. `User` schema has no `country` field; `Account` has no country-of-domicile. Article 33(3)(c)–(d) requires "categories and approximate number of affected data subjects."  
File: `docs/INCIDENT_RESPONSE.md` lines 136–168  
Fix: Add "regulatory triage" step to Phase 3. Add `registeredCountry` to Account model. Add Article 33(3) notification template with all mandatory fields.

**[PRIV-8] MEDIUM — No Consent Version/Source Recorded for Early-Access Follow-Up Emails**  
Regulation: GDPR Article 7(1)  
`EarlyAccessRequest` stores email but not which version of the privacy policy was shown at submission time. No `privacyPolicyVersion` field. Cannot prove consent for follow-up emails.  
File: `schema.prisma` lines 1887–1900; `server/routes/earlyAccess.ts` lines 62–80  
Fix: Add `privacyPolicyVersion String?` and `formCopyVersion String?` to `EarlyAccessRequest`. Populate server-side from a constant.

**[PRIV-9] MEDIUM — ContractorTech PII (Name/Email/Phone/Certs) Undisclosed in Privacy Policy**  
Regulation: GDPR Articles 13/14; CCPA §1798.100  
`ContractorTech` model (lines 622–658) stores `name`, `email`, `phone`, certification credentials — a rich personal data profile. These third-party individuals (not users who registered) are not mentioned in the privacy policy.  
File: `schema.prisma` lines 622–658; `client/src/legal/privacy-draft-2026-05.md`  
Fix: Add Section 2.1 bullet for contractor/technician records. Add Section 5A subsection on retention. Include in SOW/DPA representation.

**[PRIV-10] LOW-MEDIUM — No Age Verification at Registration (COPPA)**  
Regulation: COPPA (15 U.S.C. §6501)  
Privacy policy states "we do not collect data from children under 13" but no technical enforcement. Registration form and admin invite flow have no age attestation.  
File: `client/src/pages/Register.jsx` lines 157–192; `server/routes/users.ts` invite flow  
Fix: Add "I confirm I am 13 years of age or older" checkbox to registration form. Store `minimumAgeAttestedAt DateTime?` on `User`.

**[PRIV-11] LOW — GDPR Article 33: Supervisory Authority Not Identified in Incident Response Plan**  
Regulation: GDPR Article 33(1)  
Incident response plan identifies 72-hour obligation but does not name which supervisory authority to notify. No Article 33(3) notification template. No ICO contact for UK data.  
File: `docs/INCIDENT_RESPONSE.md` lines 163–167  
Fix: Add "Regulatory Contact Quick Reference" to Phase 6 with DPC, ICO, and US state AG notification URLs. Add bare-bones Article 33(3) template.

**[PRIV-12] LOW — Transfer Mechanism Stated Generically; No Per-Sub-Processor Mapping**  
Regulation: GDPR Chapter V (Articles 44–49)  
Section 8 states SCCs/DPF "where applicable" without per-processor specification. Cloudflare is DPF-certified, DigitalOcean relies on SCCs, Brevo is EEA-based (no transfer needed), Groq is US-based. PE diligence will ask for specific mechanism per sub-processor and DPA evidence.  
File: `client/src/legal/privacy-draft-2026-05.md` line 194  
Fix: Expand Section 8 with per-sub-processor transfer mechanism table.

---

## AFX — NFPA 70E 2024 Implementation Accuracy

**[AFX-1] HIGH — PPE Cat 0 Sanity Check Misses IE=1.2 Boundary**  
Reference: NFPA 70E 2024 Table 130.7(C)(15)(a)  
`arcFlashSanity.ts` uses `PPE_CATEGORY_CAL[0] = 1.2`. The under-coverage check `PPE_CATEGORY_CAL[ppe] < ie` evaluates `1.2 < 1.2` = false — silently passes an under-protective Cat 0 assignment when IE is exactly 1.2 cal/cm² (which should be Cat 1).  
File: `server/lib/arcFlashMitigation.ts` line 107; `server/lib/arcFlashSanity.ts` line 37  
Fix: Change sanity check to use `>=`: at 1.2 cal/cm², Cat 0 is under-protective. Verify boundary is strictly `<` 1.2 for Cat 0.

**[AFX-2] HIGH — Label Field Named "Arc Flash Boundary" Not Enforced as the 1.2 cal/cm² AFPB**  
Reference: NFPA 70E 2024 §130.5(B) and §130.5(H)(1)(e)  
`arcFlashBoundaryIn` is stored without enforcement that it represents the AFPB (distance at 1.2 cal/cm²). Label renders "Arc flash boundary" — wrong term. AFPB is also not tracked in `LABEL_FIELDS` mismatch detector.  
File: `server/lib/arcFlashLabelDoc.ts` lines 73, 131; `server/lib/arcFlashLabel.ts` lines 14–17  
Fix: Rename rendered label to "Arc Flash Protection Boundary (AFPB)". Add schema comment enforcing AFPB semantics. Add to `LABEL_FIELDS` mismatch tracker.

**[AFX-3] HIGH — §130.5(H): Shock Approach Boundaries Silently Omitted If Null; Not in Mismatch Detector**  
Reference: NFPA 70E 2024 §130.5(H)(1)(f)(g)  
Limited Approach Boundary and Restricted Approach Boundary are only rendered when not null. §130.5(H) makes them mandatory on every label. Both are absent from `LABEL_FIELDS` — if a re-study changes them, mismatch detector won't flag reprint.  
File: `server/lib/arcFlashLabelDoc.ts` lines 139–144; `server/lib/arcFlashLabel.ts` lines 14–17  
Fix: Add `shockLimitedApproachIn` and `shockRestrictedApproachIn` to `LABEL_FIELDS`. Add warning/block when absent at label generation.

**[AFX-4] HIGH — §130.5(C): No System-Modification Re-Evaluation Trigger**  
Reference: NFPA 70E 2024 §130.5(C)  
`arcFlashIntegrity.ts` implements 5-year calendar expiry and load growth triggers, but not the §130.5(C) mandatory trigger: "major modifications or renovations to the electrical distribution system." When a new asset is created under a studied bus, or transformer data changes, no re-evaluation flag is created.  
File: `server/lib/arcFlashIntegrity.ts` (entire file)  
Fix: When a power-distribution-class asset is created, replaced, or has `fedFromAssetId` changed under a site with an active study, create a `StudyReviewFlag` record noting "topology change since last study."

**[AFX-5] MEDIUM — §130.7(A): PPE Category Method Lacks Voltage Ceiling (>15kV Invalid)**  
Reference: NFPA 70E 2024 §130.7(A) and Table 130.7(C)(15)(b)  
`ppeMethod = 'ppe_category'` can be set on a 25kV bus without any flag. The PPE Category Method cannot be used for voltages >15kV per the table applicability limits.  
File: `server/lib/arcFlashLabelDoc.ts` lines 61–65; schema  
Fix: Add voltage-ceiling check in `checkBusContradictions()`: if `ppeMethod = 'ppe_category'` and `nominalVoltage > 15000`, raise sanity error `ppe_category_exceeds_voltage_limit`.

**[AFX-6] MEDIUM — §130.7(C)(14): Cat 3/4 PPE Recommendations Give No Layering Non-Additivity Warning**  
Reference: NFPA 70E 2024 §130.7(C)(14) and Informative Annex M  
Arc ratings of layered clothing are NOT arithmetically additive — must be system-tested. Recommendations for Cat 3 and Cat 4 just say "PPE Category 3/4" with no guidance on tested layering systems.  
File: `server/lib/arcFlashMitigation.ts` lines 105–148  
Fix: Add caveat to `estimateMitigationRoi()` output when `ppeAfter >= 3`: "Cat 3/4 PPE requires arc-rated clothing with system arc rating per §130.7(C)(14) — individual layer ratings are not additive."

**[AFX-7] MEDIUM — §130.5(G): Qualified Person Is a Text Checklist Item, Not Validated; Permit Not Persisted**  
Reference: NFPA 70E 2024 §130.5(G)  
`validatePermitIssuance()` blocks on stale studies but has no gate on qualified person. The `writeActivityLog` for permit generation uses `catch(() => {})` — safety-critical audit events must not silently fail. The permit is returned as JSON but never persisted to the database.  
File: `server/lib/arcFlashPermit.ts` lines 89–117  
Fix: Add required `qualifiedPersonAttestation: boolean` to permit request. Persist permit to `EnergizedWorkPermit` table. Change `catch(() => {})` to `catch(e => console.error('permit audit log failed', e))`.

**[AFX-8] MEDIUM — §130.2(A): Energized Work Justification Is Post-Permit Fill-In, Not Pre-Issuance Gate**  
Reference: NFPA 70E 2024 §130.2(A)  
"Justification why de-energizing is infeasible" is listed in `toComplete` array — crew fills it in after permit is generated. `validatePermitIssuance()` does not check for a pre-supplied justification. Permit can be issued with zero justification.  
File: `server/lib/arcFlashPermit.ts` lines 89–97  
Fix: Add required `energizedWorkJustification` field to permit request body. Change endpoint from GET to POST.

**[AFX-9] MEDIUM — IEEE 1584-2018: Missing Input Range Validation**  
Reference: IEEE 1584-2018 §1.2  
`checkBusContradictions()` validates arcing current < bolted fault but not absolute IEEE 1584-2018 limits: 0.5 kA minimum arcing current, 106 kA maximum, 6.35–152.4 mm gap range, 305 mm (12 in) minimum working distance. Out-of-range values from CSV import are accepted without warning.  
File: `server/lib/arcFlashSanity.ts` lines 57–113  
Fix: Add checks: `arcingCurrentKA < 0.5` → `arcing_below_ieee1584_min`, `boltedFaultCurrentKA > 106` → `fault_exceeds_ieee1584_max`, gap out of 6.35–152.4mm range, working distance < 305mm.

**[AFX-10] MEDIUM — §130.5(J): Pre-Permit Safety Procedure Verification Is Optional, Not Enforced**  
Reference: NFPA 70E 2024 §130.5(J)  
§130.5(J) requires verification before issuance that (a) risk assessment completed, (b) safe work procedures documented, (c) normal precautions in place. Items (b) and (c) appear in `toComplete` array — filled in after permit is generated, not prerequisites.  
File: `server/lib/arcFlashPermit.ts` lines 89–97  
Fix: Add `riskAssessmentCompleted: boolean` and `safeWorkProcedureAvailable: boolean` as required fields. Mark as pre-issuance attestations distinct from in-work checklist items.

**[AFX-11] LOW-MEDIUM — §130.5(C) Alert Messaging Conflates Mandatory Trigger with Advisory**  
Reference: NFPA 70E 2024 §130.5(C) and Annex D  
Alert text at `arcFlashIntegrity.ts` lines 229–232, 293–298 frames the 5-year review as "Annex D best practice" and the system-change trigger as a "separate condition." This understates the mandatory nature of §130.5(C) and may cause users to believe calendar compliance equals full compliance.  
File: `server/lib/arcFlashIntegrity.ts` lines 229–232, 293–298  
Fix: Lead with mandatory standard: "NFPA 70E §130.5(C) requires re-evaluation when system changes occur. Per Annex D, a 5-year review is the recommended minimum regardless of known changes."

**[AFX-12] LOW — Cat 0 Bus With AFPB Value Not Flagged; Standard Says No Boundary Required**  
Reference: NFPA 70E 2024 Table 130.7(C)(15)(a) Note 3  
If IE < 1.2 cal/cm², NFPA 70E says no AFPB is required. If a PE provides `arcFlashBoundaryIn` for a Cat 0 bus, the system renders it without flagging the inconsistency.  
File: `server/lib/arcFlashSanity.ts` lines 36–37; `server/lib/arcFlashLabelDoc.ts` line 131  
Fix: In `checkBusContradictions()`, emit warning `cat0_boundary_present` if `ppeCategory === 0` and `arcFlashBoundaryIn != null`.

---

## REV — Financial/Revenue Analyst (PE Diligence)

**[REV-1] CRITICAL — No Stripe Checkout, Portal, or Webhook Handler: Platform Cannot Accept Payment**  
`server/lib/stripe.ts` comment at lines 16–28 explicitly lists what is NOT done: Checkout session creation, Customer Portal sessions, webhook handler at `POST /api/billing/webhook`. `STRIPE_ENABLED` defaults to `false`. No customer can pay. Every account is zero-cost.  
File: `server/lib/stripe.ts` lines 16–28  
Fix: Activate Stripe Checkout with one tier. Wire `subscription.updated` and `invoice.payment_failed` webhooks. Even a single paying pilot customer transforms the valuation from "asset acquisition" to "pre-Series A."

**[REV-2] CRITICAL — No MRR/ARR Data Model: System Cannot Answer "What Is Our ARR?"**  
Schema has `planType`, `planTier`, `stripeSubscriptionId` on Account but no `contractValue`, `mrr`, `arr`, or `subscriptionPrice` per account. The admin metrics endpoint reports DAU, retention, signups — zero revenue metrics.  
File: `server/prisma/schema.prisma` lines 254–262; `server/routes/admin.ts` lines 356–479  
Fix: Add `mrrCents INT` and `contractStartDate DATE` to `Account`. Populate on Stripe webhook. Add `/api/admin/metrics/revenue` endpoint returning current MRR.

**[REV-3] CRITICAL — No ACV/TCV Tracking Per Customer: ARR Schedule Impossible**  
`Account` model has no `contractValue`, `acv`, `tcv`, `contractStartDate`, `contractEndDate`, or `renewalDate`. PE standard diligence request: "give me a table: customer name, ACV, contract start, contract end, renewal status" — cannot be generated.  
File: `server/prisma/schema.prisma` (Account model, lines 248–370)  
Fix: Add `contractValueCents INT`, `contractStartDate DATE`, `contractEndDate DATE`, `renewalDate DATE` to `Account` model.

**[REV-4] HIGH — Tier Gates Built but Applied to Zero Routes**  
`requireTier` middleware is fully implemented (lines 58–123) with Stripe subscription status checking and 402 responses. A grep of all `.ts` route files shows `requireTier` is only referenced in the middleware file itself — no route calls it.  
File: `server/middleware/requireTier.ts`; all `server/routes/*.ts`  
Fix: Apply `requireTier('mid')` to SSO (`/api/sso`), multi-OpCo endpoints, and API key creation at minimum.

**[REV-5] HIGH — No Customer-Facing Billing/Subscription Tab in Settings**  
SettingsPage imports ~20 section components but no `BillingSection`. The Stripe module's own TODO (line 21) names it explicitly as missing. Customers have no UI to see subscription status, plan, renewal date, or upgrade path.  
File: `client/src/pages/SettingsPage.jsx`; `server/lib/stripe.ts` line 21  
Fix: Wire Stripe Customer Portal link into a new Billing sub-tab. A stub showing `planTier` and `stripeCurrentPeriodEnd` plus "Manage billing" link is sufficient for pilot close.

**[REV-6] HIGH — No Invoice or Payment Receipt Generation**  
No invoice/receipt generator anywhere. `invoice.paid` webhook explicitly listed as not done. B2B enterprise customers require invoices for accounts payable. Revenue quality question ("are these real contracts?") cannot be answered without invoice records.  
File: `server/lib/stripe.ts` lines 16–28; grep of `server/lib/*.ts` for "invoice|receipt"  
Fix: Wire `invoice.paid` webhook. Store Stripe invoice data on an `Invoice` model. Enable PDF receipt generation.

**[REV-7] HIGH — No Renewal Tracking or Renewal Alert Mechanism**  
`stripeCurrentPeriodEnd DateTime?` exists on Account but nothing reads it to generate renewal notices. `AlertType` enum has no `subscription_renewal` type. `AccountStatus.expiring` and `lapsed` values exist but no code path sets them from `stripeCurrentPeriodEnd`.  
File: `server/prisma/schema.prisma` line 260; `server/index.ts` (no renewal cron)  
Fix: Add nightly cron: accounts with `stripeCurrentPeriodEnd` within 60 days → `status = 'expiring'` + email to account admin. Log as `ActivityLog` action `subscription_renewal_notice`.

**[REV-8] HIGH — No Revenue Metrics in Platform Admin Dashboard**  
`GET /api/admin/metrics/overview` provides excellent product analytics (DAU, retention cohorts, top actions) but zero revenue metrics. No MRR, paid/trial account count, past-due count, or churn rate.  
File: `server/routes/admin.ts` lines 356–479  
Fix: Add MRR, paid account count, and past-due count once Stripe webhooks are wired. Expose `planTier` and `stripeSubscriptionStatus` distribution in metrics response immediately.

**[REV-9] MEDIUM — No Composite Customer Health Score**  
Raw signals exist: `lastLogin` per user, WAU-by-role from ActivityLog, asset count, work orders completed. No composite health score computed. Sales dashboard sorts by compliance % but has no "at-risk" flag. PE buyer question "which accounts are at churn risk?" cannot be answered.  
File: `server/lib/salesRollup.ts`; `server/routes/admin.ts` kpis endpoint  
Fix: Add nightly computed `healthScore` (0–100) to Account. Inputs: days since last login (recency), WOs created in 30 days (engagement), assets added in 30 days (expansion), open unresolved deficiencies (risk).

**[REV-10] MEDIUM — Usage Metering Exists Implicitly but Not Wired to Stripe**  
Pricing model is location (site) count-based. `prisma.site.count()` is queryable but never exposed in admin KPIs or synced to Stripe subscription quantity. A customer with 200 sites pays the same as one with 2.  
File: `server/routes/admin.ts` line 113; `docs/PRICING.md` lines 17–22  
Fix: Add nightly job to sync `prisma.site.count()` per account to Stripe subscription quantity. Add `managedSiteCount INT` to `/api/admin/kpis`.

**[REV-11] MEDIUM — Feature Adoption Not Queryable Cross-Account**  
`revenueAttribution.ts` tracks QuoteRequest→WorkOrder funnel by trigger type per account. But there is no cross-tenant query for "how many accounts have arc_flash_studies enabled." PE buyer question "how many accounts use the arc flash module?" cannot be answered.  
File: `server/lib/revenueAttribution.ts`; `server/routes/admin.ts`  
Fix: Add `featureAdoption` object to `/api/admin/metrics/overview`: for each feature key in `ACCOUNT_FEATURE_KEYS`, count distinct accounts with `AccountSetting.value = 'true'`.

**[REV-12] MEDIUM — Trial Tier Architecture Incomplete (No Limits, No Expiry, No Conversion Flow)**  
Schema supports `trialing` status and tier middleware allows it identically to `active`. No trial asset/site limits, no trial expiry automation, no trial-to-paid conversion flow, no trial countdown banner. Trial conversion rate cannot be tracked.  
File: `server/middleware/requireTier.ts` line 34; `server/prisma/schema.prisma` lines 258–259  
Fix: When Stripe Checkout is activated, set 14-day trials. Add UI banner for trialing accounts. Add `trialStartedAt` and `trialEndedAt` to Account for cohort analysis.

**[REV-13] LOW — No MSA/SOW Contract Template in Codebase or Data Room**  
`docs/PILOT_KICKOFF_GUIDE.md` and `docs/FIRST_CUSTOMER_MEETING_PREP.md` exist but no SOW template or contract template. PE legal workstream will ask for redacted sample customer contract. First customer would negotiate from a blank sheet.  
File: `docs/` directory (no SOW template found)  
Fix: Draft 2-page MSA covering: subscription term, payment terms (net 30, annual upfront), IP ownership, limitation of liability, acceptable use.

---

## DX — Developer Experience / API Quality

**[DX-1] MEDIUM — Arc Flash v1 Endpoints Return Raw Objects, Missing `success` Envelope**  
Three of five arc-flash v1 endpoints return raw objects without `{ success: true, data: ... }` wrapper. `GET /one-line` success (line 122) returns `{ site, ...buildOneLine(merged) }` flat — no `success` or `data`. SDK's `getOneLine()` tries to unwrap `response.data` which is always `undefined`.  
File: `server/routes/v1/arcFlash.ts` lines 51, 94, 122, 132, 141, 161, 178  
Fix: Apply consistent `{ success: true, data: ... }` / `{ success: false, error: ..., code: ... }` envelope to all arc-flash endpoints. Update SDK `getOneLine()` accordingly.

**[DX-2] MEDIUM — No Machine-Readable Error Codes on Any Endpoint**  
Every 4xx/5xx across all v1 routes returns `{ success: false, error: "human string" }` with no `code` field (e.g. `"ASSET_NOT_FOUND"`, `"VALIDATION_FAILED"`). API consumers must string-match on `error` message — fragile.  
File: All `server/routes/v1/*.ts` files  
Fix: Add `code` field to every error response. Define codes in `sdk/src/errors.ts`. Surface `err.code` in SDK's `http.ts`.

**[DX-3] MEDIUM — SDK `Contractor` Type Fields Don't Match Server `CONTRACTOR_SELECT`**  
SDK `Contractor` interface declares `nataLevel`, `companyName`, `email`, `phone`, `neta70eQualified` — none of which exist in the server's `CONTRACTOR_SELECT` (lines 30–41). Server returns `netaAccredited`, `supportEmail`, `supportPhone`, `scoreSupport`, etc. Any SDK consumer using `contractor.email` gets `undefined`.  
File: `sdk/src/types.ts` lines 116–125; `server/routes/v1/contractors.ts` lines 29–42  
Fix: Regenerate `Contractor` type from actual `CONTRACTOR_SELECT`. Update OpenAPI spec to match.

**[DX-4] MEDIUM — SDK/OpenAPI Field Name Mismatch: `requiredArcRatingCalCm2` vs `minArcRatingCalCm2`**  
SDK uses `requiredArcRatingCalCm2` (correct — matches server). OpenAPI spec at line 259 names it `minArcRatingCalCm2`. Swagger UI shows wrong name. `studyExpired` in spec at line 263 is never emitted by the server route.  
File: `sdk/src/types.ts` line 143; `server/data/openapi/v1.yaml` lines 259, 263  
Fix: Update OpenAPI spec to `requiredArcRatingCalCm2`. Remove `studyExpired` from spec or emit it from the route.

**[DX-5] LOW — `AssetSchedule` SDK Type Is Flat; API Returns Nested `taskDefinition`**  
SDK `AssetSchedule` declares flat fields `taskName`, `taskCode`, `standardRef`, `intervalDays`. Server returns `{ id, lastCompletedDate, nextDueDate, taskDefinition: { taskName, taskCode, standardRef } }`. `intervalDays` is never selected.  
File: `sdk/src/types.ts` lines 53–61; `server/routes/v1/assets.ts` lines 157–165  
Fix: Either flatten `taskDefinition` server-side or update `AssetSchedule` to reflect nested shape. Remove `intervalDays`.

**[DX-6] LOW — `GET /telemetry/channels` Unbounded; `GET /telemetry/notifications` Hard-Capped at 200 Undocumented**  
`GET /telemetry/channels` returns all channels in a single flat array with no pagination. `GET /telemetry/notifications` silently caps at `take: 200` with no pagination block in response and no documented limit.  
File: `server/routes/v1/telemetry.ts` lines 88–102, 206–223  
Fix: Add `page`/`limit` parameters and `pagination` block, or explicitly document unbounded endpoints with stated maximums in OpenAPI spec.

**[DX-7] LOW — `WorkOrderPrecheck` SDK Uses `reason`/`label`; API Returns `reasons[]`/`hazard`**  
SDK interface: `{ canIssue: boolean; reason: string | null; label: ArcFlashLabel | null }`. Server returns `{ canIssue, reasons: [...], hazard: ..., study: ..., disclaimer: ... }`. SDK drops `reasons` (plural array) and `label` is always `null` (server field is `hazard`).  
File: `sdk/src/resources/arcflash.ts` lines 17–21, 49; `server/routes/v1/arcFlash.ts` line 141  
Fix: Update SDK interface to `{ canIssue: boolean; reasons: string[]; hazard: ArcFlashLabel | null; study: object | null; disclaimer: string }`.

**[DX-8] LOW — Rate Limit Key Falls Back to IP for All API Key Traffic**  
`buildRateLimitKey()` keys by `userId` from JWT. API key Bearer tokens are not JWTs — `verifyToken` throws, falling through to `clientIpKey(req)`. All API key traffic is rate-limited by IP, not by key. Multiple customers behind shared NAT share one bucket.  
File: `server/lib/rateLimitHelpers.ts` lines 29–39  
Fix: Use `req.apiKeyAccountId` (set by v1 API key middleware) as rate-limit key when present: `return \`apikey:${req.apiKeyAccountId}\`` before JWT decode.

**[DX-9] LOW — Notifications Response Has Non-Standard `count` Field; Ad-Hoc SDK Return Type**  
`GET /telemetry/notifications` returns `{ success: true, data: rows, count: rows.length }` — non-standard envelope adding bare `count` not in `PaginatedResponse<T>`. SDK handles it with unexported one-off inline type.  
File: `server/routes/v1/telemetry.ts` line 218; `sdk/src/resources/telemetry.ts` lines 61–70  
Fix: Standardize on `PaginatedResponse<TelemetryNotification>`. Export named `TelemetryNotificationList` type from SDK.

**[DX-10] LOW — SDK `package.json` Not npm-Publishable: Missing `files`, `exports`, `repository`**  
`package.json` is `"private": false` but missing `files: ["dist"]`, `exports` field, `repository`, `homepage`, `publishConfig`, and `prepublishOnly` script. `npm publish` would ship the entire directory. README advertises `npm install servicecycle-sdk` but package has never been published (no `dist/`).  
File: `sdk/package.json` lines 1–18  
Fix: Add `files: ["dist"]`, `exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } }`, `repository`, `homepage`, `publishConfig: { access: "public" }`, and `prepublishOnly: "npm run build"`.

**[DX-11] LOW — Webhooks Missing Events: Telemetry CRIT, Deficiency Create, Arc Flash Expiry**  
`EVENT_NAMES` documents only four maintenance-schedule events. `POST /telemetry/readings` auto-escalates on CRIT breach and creates `TelemetryNotification` but fires no webhook. Deficiency creation, arc flash study expiry, and condition-change alerts have no webhook event.  
File: `server/lib/webhook.ts` lines 15–27; `docs/api/INTEGRATIONS.md` lines 166–195  
Fix: Define and document new event types: `telemetry.breach`, `deficiency.opened`, `arcflash.study_expired`. Fire from telemetry ingest and deficiency creation paths.

**[DX-12] LOW — OpenAPI Spec Is Hand-Maintained With Two Inaccurate Entries**  
Spec is a static `v1.yaml` file, not generated from route code. CHANGELOG line 42–44 lists `POST /telemetry/notifications` (doesn't exist; actual is `POST /telemetry/notifications/:id/acknowledge`) and `GET /telemetry/channels/:id/readings` (actual is `GET /telemetry/readings?assetId=`). No CI validation.  
File: `server/data/openapi/v1.yaml`; `docs/api/CHANGELOG.md`  
Fix: Adopt code-first OpenAPI generation from Zod schemas, or add CI test validating spec against implemented routes. Correct the two inaccurate CHANGELOG entries.

**[DX-13] INFO — Offset Pagination Has No Scale Warning or Cursor Option**  
All list endpoints use `skip: (page - 1) * limit` offset pagination with max 100/page. `page=1000` forces DB scan of 100,000 rows. No documentation warning. No cursor-based pagination option.  
File: `server/routes/v1/assets.ts` lines 108–115; SDK README lines 53–60  
Fix: Add documentation note: "For datasets >10,000 records, use date-range filters to window pulls rather than iterating to high page numbers."

---

## Deferred / Requires Migration or Structural Work

The following findings require schema migrations and should not be addressed in the immediate fix cycle:

- **NETA-1, NETA-4, NETA-9**: New `TestMeasurement` fields (overcurrentMultiplePct, testDurationMinutes, tanDeltaPct, testGroupId) require migration
- **NETA-6, NETA-8, NETA-10**: New Asset/User schema fields require migration
- **NETA-7**: `Deficiency.retestWorkOrderId` FK requires migration
- **NETA-11**: New `AcceptanceCriterion` table requires migration
- **PRIV-3**: `IncidentLog` FK relations require migration
- **PRIV-8**: New `EarlyAccessRequest` consent fields require migration
- **PRIV-10**: `User.minimumAgeAttestedAt` requires migration
- **REV-1, REV-2, REV-3, REV-5, REV-6, REV-7**: Stripe activation — multi-day effort
- **PG-1, PG-2, PG-3, PG-11, PG-12, PG-13**: Partial indexes — safe CONCURRENT migrations, but require explicit approval

---

*End of DEMO_LANDMINES_v5.md — 102 findings across 8 personas*
