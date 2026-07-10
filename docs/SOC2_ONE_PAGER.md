# ServiceCycle — SOC 2 Posture (One Page)

**Version:** 2026-07-10 (all 15 open items independently re-verified against live repo, CI, GitHub settings, and the production host on this date — evidence trail in `docs/SOC2_READINESS_CHECKLIST.md`, session-log entry 2026-07-10)
**Audience:** acquirer diligence teams, enterprise-security reviewers, prospective customer InfoSec.
**Full detail:** `docs/SOC2_CONTROLS.md` (Trust Services Criteria mapping) · `docs/SOC2_READINESS_CHECKLIST.md` (95-item scorecard) · `docs/DILIGENCE_SUMMARY.md` (verified technical diligence summary) · `docs/DATA_ROOM_INDEX.md` (evidence-to-control map).

---

## Position

ServiceCycle is **SOC 2 Type I evidence-ready** as an internal characterization — a formal audit engagement has not been commissioned pre-revenue, and no auditor has opined. The posture is engineered so that engaging a Type II auditor is a matter of collecting existing dated artifacts, not building missing controls. Type II requires 6–12 months of operating evidence collection.

## Score at a glance

95 controls tracked across 12 categories (access, change management, vulnerability management, logging & monitoring, incident response, backup & DR, risk & governance, data retention & privacy, AI governance, vendor risk, endpoint / solo-dev compensating controls, evidence discipline).

**🟢 80 done · 🟡 15 documented pending single execution step · 🔴 0** — tally re-verified item-by-item on 2026-07-10; none of the 15 could be closed autonomously because each genuinely requires the founder, an attorney, or a calendar boundary (breakdown below).

## What's actually in place

**Security engineering (CC6, CC7):**
- Tamper-evident audit log (SHA-256 hash chain per account, verified nightly).
- MFA/TOTP with admin enforcement; SSO + SAML (dark-by-default via Ory Polis, tenant check fail-closed per `723fe84`) with SCIM-brokered directory sync — Ory Polis implements SCIM against the IdP and pushes provisioning/deprovisioning events to ServiceCycle's inbound webhook consumer; ServiceCycle does not itself expose a standard SCIM v2 resource-server API.
- RBAC (8 roles), tenant-scoped queries with integration tests + a written isolation proof (`docs/security/DATABASE_ISOLATION_PROOF.md`), instant session revocation on password change (`tokenEpoch`).
- AES-256-GCM encryption at rest: a single shared `MASTER_KEY` protects secret-bearing columns (BYO storage credentials, etc.) and gates opt-in document encryption (`ENCRYPT_DOCS`, per-document key via HKDF off that same master key for uploaded PDFs/photos). This is master-key encryption, not per-account/per-tenant envelope encryption — there are no per-account data-encryption keys today. Test-report, measurement, and arc-flash business data are plaintext Postgres columns (protected by network/access controls and disk-level hosting encryption, not column-level encryption). Backup encryption uses a separate `BACKUP_ENCRYPTION_KEY`.
- Rate limiting (per-IP + per-token + per-email lockout); Zod input validation; Helmet headers + CSP + HSTS.
- CI security stack live on `main`, all gates green on HEAD `1d99c9b` (verified via Actions API 2026-07-10): Gitleaks, CodeQL, Semgrep, Trivy (fs + container), CycloneDX SBOM auto-gen, License compliance gate, Knip + dependency-cruiser (report-only), release-evidence archive on tag, signed-commit verifier (report-only). Weekly OWASP ZAP baseline DAST against https://servicecycle.app — first scheduled run succeeded 2026-07-08.
- Branch protection live on `main` (verified via GitHub API 2026-07-10): 3 required security checks, linear history, no force pushes/deletions, required conversation resolution.
- Supply chain: npm `ignore-scripts=true` with explicit 5-package rebuild allowlist + verification script; `save-exact` pinning; Dependabot (npm + Actions).
- Cloud posture: DigitalOcean CSPM weekly scan, enabled 2026-07-07 free tier, first scan clean — with scope caveats documented (`docs/security/CSPM_SCAN_EVIDENCE.md`).

**Reliability & DR (A1, CC9) — stated honestly:**
- Nightly encrypted `pg_dump` (client-side `BACKUP_ENCRYPTION_KEY`, 30-day rolling retention). Verified live 2026-07-10: that morning's encrypted backup present on the droplet. **Current destination is local droplet disk — the offsite S3-compatible target is implemented in code but not yet configured in production (open item F5).** Until F5 closes, backups share the droplet's failure domain.
- Automated restore testing at two cadences (both in `server/lib/restoreTest.ts`): weekly table-of-contents integrity check (Sundays 04:00 UTC) + monthly deep restore to a sidecar Postgres with row-count verification (1st, 05:00 UTC). These crons were non-functional until fixed 2026-07-06 (`c39b5d4`, + 4 regression tests); the first live post-fix run is expected 2026-07-12, so no successful production restore-test artifact exists yet.
- Health check endpoint + Healthchecks.io heartbeats on crons are live. Better Stack synthetic/uptime monitoring is code-complete but **not activated** (open item D5) — no external uptime alerting today.
- Documented RTO ~2h / RPO ~24h.
- 7 per-scenario BC playbooks (droplet outage, DB corruption, Cloudflare outage, GitHub outage, AI provider outage, vendor account compromise, workstation compromise).

**Governance (CC1, CC3, CC5):**
- 10-risk risk register with L×I scoring + quarterly review cadence.
- Risk acceptance log (8 accepted risks, each dated with reconsider-by).
- Whole-app threat model (10 threats × mitigations × residual risk).
- Change-review checklist v1.1 with solo-founder separation-of-duties compensating-control statement (RAR-006).
- Vendor security reviews on 10 sub-processors + failure-mode matrix.
- Automated data-retention enforcement via 10 nightly prune crons (activity_logs 365d, ai_usage 90d, notification_logs 180d, etc.), regression-tested 2026-07-06 after two silent-failure bugs were found and fixed (`8aac1d9`, `5e2ce18`).

**Evidence discipline (CC4, CC7):**
- Dated evidence folder pattern `docs/compliance/evidence/YYYY-MM/` with frontmatter template.
- First tabletop drill run 2026-07-04 (scenario: DO regional outage).
- First weekly log-review evidence bullet logged 2026-07-04.
- Dated CSPM scan log + dated dependency-scan log running weekly.
- Baseline security-metrics-2026-07.md populated with real 30-day data; month-end close automated via scheduled task on the 1st.

**Security review history:** internal reviews only — `SECURITY_REVIEW_2026-07-07.md` (0 critical/high), `SECURITY_AUDIT_2026-06-20.md`, `security-audit-2026-06-09.md`, plus a two-run acquisition-audit remediation sweep 2026-07-08. **No independent third-party penetration test has been performed** (deferred pre-revenue).

**Solo-founder compensating controls (RAR-006):** every deploy audit-logged with commit SHA, mandatory change-review checklist on schema/auth/API/integration PRs, CI gates the founder cannot silently bypass (npm audit, tsc, jest, Gitleaks, CodeQL, Semgrep, Trivy, license gate), Dependabot + weekly Trivy full-history scans, PR-body attestation required for security-sensitive changes. (Commit signing is configured as a report-only verifier; enforcement pending local signing setup — open item B7.)

## What the 15 yellows are (re-verified 2026-07-10)

Fifteen open items; three are duplicate ledger rows of the same underlying artifact (L6=A8, L7=F3, L10=C9), so there are **12 distinct actions**:
- **8 need the founder's hands** — A8/L6 first quarterly access review (fill the scaffolded evidence file), A10 MFA screenshots across vendor accounts, B7 local commit-signing setup then flip enforcement, B11 add reviewer/wait-timer rules to the GitHub `production` environment, C9/L10 first quarterly security review (13-item checklist), D5 Better Stack activation (runbook ready), F5 backup offsite credentials into the droplet env, K1 BitLocker/screen-lock screenshots.
- **1 needs an attorney** — H7 privacy-policy review (draft is live at `/privacy` and `/legal/privacy`).
- **2 close after the next scheduled cron run** — F3/L7 restore-test evidence (first post-fix weekly run expected 2026-07-12; paste output into the scaffolded file).
- **2 auto-close at month-end 2026-08-01** — D9 security-metrics month close, F6 secure-disposal first entry (scheduled task pings on the 1st).

Note: earlier revisions of this page listed branch protection and the DAST target among the open GitHub items — both closed 2026-07-04 (Session 8) and were re-confirmed live via the GitHub API on 2026-07-10.

## Trust-page pointers

- Security disclosure: `SECURITY.md` (email `security@servicecycle.app`) + `/.well-known/security.txt`.
- Verified technical diligence summary: `docs/DILIGENCE_SUMMARY.md`.
- Full controls matrix: `docs/SOC2_CONTROLS.md`.
- Threat model: `docs/security/THREAT_MODEL.md`.
- Data flow: `docs/security/DATA_FLOW.md`.
- Data classification: `docs/security/DATA_CLASSIFICATION.md`.
- Data retention matrix: `docs/compliance/DATA_RETENTION_MATRIX.md`.
- Privacy-request lifecycle: `docs/security/PRIVACY_REQUESTS.md`.
- Vendor risk + failure-mode matrix: `docs/VENDOR_SECURITY_REVIEW.md`.
- Incident response: `docs/INCIDENT_RESPONSE.md`.
- Key rotation runbook: `docs/KEY_ROTATION.md`.
- Tenant isolation proof: `docs/security/DATABASE_ISOLATION_PROOF.md`.
- CSPM scan evidence: `docs/security/CSPM_SCAN_EVIDENCE.md`.

## Compliance stance

- **SOC 2 Type I**: engineered for. Formal engagement post-revenue. No auditor opinion exists today.
- **SOC 2 Type II**: 6–12 months of operating evidence collection begins the day the readiness sweep goes green (target: Q3 2026 end).
- **GDPR**: data-subject request lifecycle documented (`docs/security/PRIVACY_REQUESTS.md`); breach notification thresholds + templates in `docs/INCIDENT_RESPONSE.md` §5; sub-processor list published in `docs/OFFBOARDING.md` §6.
- **HIPAA**: not in scope — SC does not collect health data.
- **PCI**: not in scope — SC does not store payment card data (Stripe handles PCI scope).

## Acquirer read

The remaining path to 100% is execution, not engineering: nothing on the yellow list is architectural, and none of it requires new code beyond pasting credentials or running written procedures. The honest gaps a diligence team will care about are listed plainly in `docs/DILIGENCE_SUMMARY.md` §6 (no third-party pentest, no formal audit, single-VPS failure domain with local-only backups until F5 closes, one unmerged security-fix branch pending merge as of 2026-07-10).
