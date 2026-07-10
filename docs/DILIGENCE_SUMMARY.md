# ServiceCycle -- Technical Due-Diligence Summary

**Classification:** Confidential / Diligence
**Date:** 2026-07-10 -- every material claim in this document was verified on this date against the repository at `main` @ `1d99c9b`, the GitHub Actions/settings API, or the production host, and carries its evidence pointer inline (commit SHA, file path, CI gate name, or dated live check)
**Audience:** acquirer technical and security diligence teams
**Companions:** `docs/ARCHITECTURE.md` (system deep-dive) - `docs/SOC2_ONE_PAGER.md` (security posture, one page) - `docs/SOC2_READINESS_CHECKLIST.md` (95-item control scorecard) - `docs/ENGINEERING_HANDOFF.md` (day-1 guide for a new engineering lead) - `docs/DATA_ROOM_INDEX.md` (full document map)

This document favors checkability over polish. Where the honest answer is a gap, the gap is stated, with its tracking reference.

---

## 1. Product and business state

ServiceCycle converts an electrical contractor's inspection PDFs, arc-flash studies, nameplate photos, and telemetry into a living equipment-health record: NFPA 70B condition-based maintenance intervals, arc-flash study currency tracking, deficiency registers, and automated work-order generation. It is a compliance/data layer, deliberately not a calculation engine or safety authority (it displays PE-sealed study values; it does not assert PPE categories -- see `docs/ACQUISITION_BRIEF.md` for the liability rationale).

Business state, plainly: **pre-revenue, zero customers, no production customer data.** The live deployment at servicecycle.app is a gated demo seeded with fictional data. The company is a solo founder directing AI coding agents (see section 8 on provenance). Valuation rests on the asset, the documentation, and the strategic fit -- not on traction.

## 2. Architecture (verified against code and `docs/ARCHITECTURE.md`)

- **Stack:** Node 20 + Express 4 + TypeScript API server; Prisma ORM on PostgreSQL 16; React 18 + Vite SPA; Docker Compose on a single DigitalOcean droplet behind nginx with Let's Encrypt TLS (live nginx/TLS config captured in-repo at `deploy/nginx.conf.snapshot`, commit `22f1872`).
- **Multi-tenancy:** single database, row-level tenancy -- every query is scoped by `accountId`. Enforced in middleware and covered by dedicated test suites (`server/__tests__/routes/multiTenantIsolation.test.ts`, `server/__tests__/routes/tenantSecurityFixes.test.ts`, `server/tests/idor.test.js`) plus a written isolation proof (`docs/security/DATABASE_ISOLATION_PROOF.md`, commit `2c987cd`). HoldCo/OpCo rollups (EnterpriseGroup) and OEM fleet views (PartnerOrganization) layer above tenant scoping. This is not schema-per-tenant or database-per-tenant.
- **AuthN/Z:** bcrypt + JWT with a `tokenEpoch` monotonic counter for instant session revocation on password change; TOTP MFA with per-account admin enforcement; 8-role RBAC (`server/middleware/roles.ts`); SSO via Ory Polis (OIDC/SAML), shipped dark behind `SSO_ENABLED`, with the tenant check fail-closed (`723fe84`, 2026-07-06).
- **Public API:** versioned `/api/v1`, OpenAPI 3.1 spec (`docs/openapi.json`), scoped API keys, HMAC-signed webhooks unified onto a single timestamped, replay-protected signing scheme (`621798e`), Idempotency-Key support.
- **Ingestion:** deterministic PDF/report parsers with Python extractors (pdfplumber) and an AI gap-fill cascade (default Cloudflare Workers AI -> Groq -> HuggingFace; customers can bring their own Anthropic/OpenAI/Azure/Gemini/Groq keys). AI spend is budget-guarded and call-metadata-logged; the free tier scrubs PII before any LLM call (`server/lib/aiTestReportExtract.ts`).
- **File storage:** local bind-mount by default; per-tenant bring-your-own S3-compatible storage shipped 2026-07-08 (`10cf249`) with SSRF/DNS-rebind pinning on the BYO-S3 client (`09a7f1d`).
- **Audit trail:** append-only, SHA-256 hash-chained `ActivityLog` per account with a nightly chain verifier; SIEM export in ndjson and CEF (`GET /api/activity/export`).
- **Encryption, stated precisely:** AES-256-GCM under a single `MASTER_KEY` protects secret-bearing columns (e.g. BYO storage credentials) and opt-in document encryption (per-document HKDF subkeys). Business and measurement data are plaintext Postgres columns, protected by access controls and host-level encryption -- there is no column-level or per-tenant envelope encryption today. Backups are encrypted client-side with a separate `BACKUP_ENCRYPTION_KEY`. (Same wording as `docs/SOC2_ONE_PAGER.md`; this is deliberate consistency, not boilerplate.)

## 3. Engineering quality -- what is verifiable today

- **Tests:** two Jest projects (`server/jest.config.ts`): `unit` (97 files, 1,142 declared cases, stubbed Prisma) and `integration` (139 files, 854 declared cases, real Postgres), plus 6 Playwright e2e specs. Counts are from a 2026-07-10 grep of test declarations -- "declared," not "executed": some suites require a live server and skip without one. CI executes the unit project and live-server smoke suites on every push.
- **CI:** 16 GitHub Actions workflows. On `main` HEAD `1d99c9b` (2026-07-09), all of the following completed green (verified via the Actions API on 2026-07-10): CI (tsc + unit tests + live-server smoke suites + npm audit), CodeQL (SAST), Semgrep (SAST), Gitleaks (secret scan), Trivy (container + fs CVE scan), SBOM (CycloneDX), License compliance, Knip (dead code, report-only), dependency-cruiser (module boundaries, report-only), Verify Signed Commits (report-only). The scheduled OWASP ZAP baseline DAST against https://servicecycle.app succeeded on 2026-07-08.
- **Branch protection on `main`** (verified live via GitHub API, 2026-07-10): required status checks "Scan for secrets" (Gitleaks), "Analyze (javascript-typescript)" (CodeQL), "Filesystem scan (package manifests)" (Trivy); linear history required; force pushes and deletions blocked; conversation resolution required. `enforce_admins` is off -- a documented solo-dev emergency-fix exception (RAR-006, `docs/compliance/RISK_ACCEPTANCE_LOG.md`).
- **Supply chain:** npm `ignore-scripts=true` with an explicit 5-package rebuild allowlist and a one-shot verification script (`1ec4ac1`, `5b7f9db`); `save-exact` pinning (`387f234`); Dependabot on server/client/Actions (`.github/dependabot.yml`); weekly scheduled Trivy dependency scan with dated evidence (`docs/security/DEPENDENCY_SCAN_EVIDENCE.md`).
- **Operability docs:** deploy runbook (`docs/DEPLOY_RUNBOOK.md`), self-host / air-gap guide (`docs/SELF_HOST.md`), key rotation (`docs/KEY_ROTATION.md`), incident response (`docs/INCIDENT_RESPONSE.md`), engineering handoff (`docs/ENGINEERING_HANDOFF.md`), plus dated session notes for major design decisions (`docs/sessions/`).

## 4. Security posture

- **Internal SOC 2-style scorecard:** 95 controls tracked, **80 green / 15 yellow / 0 red**, independently re-verified item-by-item on 2026-07-10 (evidence trail in `docs/SOC2_READINESS_CHECKLIST.md`, session log entry 2026-07-10). Every yellow names the single blocking action and its owner. No formal SOC 2 audit has been engaged; "Type I evidence-ready" is an internal characterization, not an auditor's opinion.
- **Security reviews to date are internal** (founder-directed, AI-agent-executed): `docs/security/SECURITY_REVIEW_2026-07-07.md` (0 critical/high), `docs/security/SECURITY_AUDIT_2026-06-20.md`, `docs/security-audit-2026-06-09.md`, and a two-run acquisition-audit remediation sweep on 2026-07-08 (batches 1-7: `16e9cb7`..`a683d8e`; run 2: `140a739`..`ad634ed`). **No independent third-party penetration test has been performed.** An internal pentest-style pass produced real fixes (e.g. rate-limiting public token-lookup endpoints, `2fc1407`).
- **Recent substantive fixes** (all on `main` unless noted): SSO fail-open-to-fail-closed (`723fe84`); OEM partner-webhook signing unified onto the replay-protected scheme (`621798e`); Semgrep first-run triage fixed 2 real bugs including an XSS gap (`7869fb3`, findings log `docs/security/SEMGREP_FINDINGS_2026-07-08.md`); four silently-crashing daily alert crons fixed (`37a5927`); master-key rotation script rewritten (`bbfdbcb`); LOTO version history made append-only (`739cc87`).
- **Cloud posture:** DigitalOcean CSPM weekly scan enabled 2026-07-07 (free tier), first scan clean, scope caveats documented rather than glossed (`docs/security/CSPM_SCAN_EVIDENCE.md`).
- **Data retention:** 10 nightly prune crons (03:00-03:55 UTC, registered in `server/index.ts`) enforce the retention matrix; two silent-failure bugs in this area were found and fixed with real-DB regression tests on 2026-07-06 (`8aac1d9` -- renderErrorPrune had never pruned; `5e2ce18` -- demoPrune's safety guard was dead code).
- **Monitoring, honestly:** health endpoint plus Healthchecks.io heartbeat pings on crons are live. Better Stack log/uptime integration is code-complete (`server/lib/betterStack.ts`) but **not activated** -- no external uptime alerting exists today (checklist D5; runbook `docs/security/BETTER_STACK_ACTIVATION.md`).

## 5. Backup and disaster recovery -- current honest state

- **Nightly encrypted `pg_dump` runs.** Verified live 2026-07-10: `servicecycle-backup-2026-07-10T02-00-00-114Z.sql.gz.enc` (2.2 MB) present on the droplet, written 02:00 UTC. It is the first backup persisted to the host bind-mount -- an ownership bug prevented writes there until the self-healing fix `3da89a2` deployed 2026-07-09.
- **Backups are currently local-only.** `BACKUP_DEST` defaults to `local` and no S3 credentials are configured in production, so backups share the droplet's failure domain: losing the droplet loses the database and its backups together. The offsite S3 path is fully implemented in code (`server/lib/backup.ts`) and is one credential-set away (checklist item F5). This is the single most material DR gap.
- **Restore verification:** a weekly `pg_restore --list` integrity check (Sundays 04:00 UTC) and a monthly deep restore into a sidecar Postgres with row-count diff (1st of month 05:00 UTC), both in `server/lib/restoreTest.ts`. These crons had **never completed a real run** until fixed on 2026-07-06 (`c39b5d4`, which also added 4 real-DB regression tests). The first live weekly run post-fix is expected 2026-07-12; as of this document no successful production restore-test artifact exists yet.
- **RTO ~2h / RPO ~24h** are documented targets (`docs/SOC2_CONTROLS.md` CC9.1). The RPO holds only while nightly backups succeed; the RTO assumes droplet rebuild from runbook, which has not been fire-drilled end-to-end.

## 6. Items an acquirer will flag (known and tracked, not hidden)

1. **No third-party penetration test and no formal SOC 2 audit engagement.** Both deferred as pre-revenue decisions; all security review to date is internal (section 4).
2. **Pre-revenue, zero customers, no production data.** Product-market claims in the brief are thesis, not evidence.
3. **Single-VPS failure domain with local-only backups** (section 5). The recommended first infrastructure spend post-acquisition is managed Postgres + offsite backups + a second compute node (`docs/ENGINEERING_HANDOFF.md`).
4. **An unmerged security fix exists.** Branch `overnight-hardening` (6 commits cut from `main` @ `1d99c9b`) contains `2917a3b`, a cross-tenant authorization fix (the disaster-events resolve gate allowed any manager to close another tenant's shared system event). As of 2026-07-10 it is neither merged to `main` nor deployed (the droplet runs `ac45204`, verified via the host's git log). Merge is queued; until then the vulnerability it fixes is live in the deployed demo.
5. **The GitHub Actions deploy workflow is inert.** The repository has zero Actions secrets (verified via API 2026-07-10), so "Deploy to ServiceCycle droplet" fails on every push to `main`. Real deploys run through an operator-driven MCP pipeline per `docs/DEPLOY_RUNBOOK.md`. Either the SSH secrets get configured or the workflow should be removed; today it is known failure noise in the Actions history.
6. **Commits are unsigned.** The `verify-signed-commits` workflow is report-only, GitHub's `required_signatures` is off, and every recent `main` commit shows no signature (checklist B7; needs local signing setup on the founder's workstation).
7. **The GitHub `production` environment gate is unconfigured** -- the environment exists with 0 protection rules (verified via API 2026-07-10; checklist B11). Low practical impact while the Actions deploy path is inert (item 5), but inconsistent posture.
8. **Bus factor of one.** Solo founder; code authored by AI agents under his direction. Mitigations: the handoff/runbook doc set, 236 server test files, CI gates the founder cannot silently bypass, dated session notes (`docs/sessions/`), and a written AI-code-provenance risk analysis (`docs/security/AI_CODE_SECURITY_RESEARCH_2026-07-07.md`).
9. **Major dependency upgrades pending:** Prisma 5->7, Express 4->5, React 18->19, Vite 5->8 Dependabot PRs open since 2026-06-25. Deliberately parked for a dedicated upgrade session, not ignored.
10. **~200 raw `console.*` calls** in routes/startup bypass the structured pino logger (not request-ID-correlated). Scoped as an adoption refactor in `TOOLING_ADOPTION_STATUS.md`; `req.log` infrastructure already exists.
11. **A known audit-log time bomb, accepted and dated:** the 365-day activity-log prune will trigger a false chain-break in the nightly hash-chain verifier on its first fire after 2027-06-06 unless a retention-aware verifier ships first (RAR-008, `docs/compliance/RISK_ACCEPTANCE_LOG.md`, reconsider-by 2027-03-01).
12. **Unit-test mock-resolution gap (W1-M8):** a Prisma `moduleNameMapper` regex in `server/jest.config.ts` deliberately does not cover the bare `./prisma` import form; the tradeoff and why the obvious fix breaks 5 existing suites is documented in-file. A per-file remediation is the follow-up.

## 7. IP and provenance

- **Ownership:** single founder, no outside investors, no employees or contractors with equity or IP claims (`docs/IP_OWNERSHIP.md`). No copyleft dependencies -- enforced continuously by the License compliance CI gate, not just asserted; SPDX license headers across the codebase (`7172beb`).
- **AI-assisted authorship, disclosed:** the codebase was written by AI coding agents directed by the founder. The risk profile of AI-generated code and the specific mitigations applied here (test gates, SAST stack, human-directed review checkpoints) are analyzed in `docs/security/AI_CODE_SECURITY_RESEARCH_2026-07-07.md` rather than left for the buyer to discover.

## 8. How to re-verify this document (buyer's 30-minute pass)

1. `git log --oneline -20` on `main` -- confirm the commits cited above exist and match their descriptions.
2. GitHub -> Actions -- confirm the gate names and their green runs on `1d99c9b`; Settings -> Branches -- confirm the protection rules; Settings -> Environments -- confirm the `production` gate state (item 6.7).
3. `curl https://servicecycle.app/api/health` -- live deployment check.
4. `docs/SOC2_READINESS_CHECKLIST.md`, session-log entry "2026-07-10" -- the item-by-item evidence trail behind the 80/15/0 score, including what was checked and how.
5. Clone, `npm ci`, `npm test` in `server/` with a local Postgres (see `README.md`) -- run the suites yourself.

---

*Prepared from a read-only verification pass on 2026-07-10. This document intentionally contains no forward-looking or promotional claims; for the market thesis and roadmap upside, see `docs/ACQUISITION_BRIEF.md`.*
