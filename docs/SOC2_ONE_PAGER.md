# ServiceCycle — SOC 2 Posture (One Page)

**Version:** 2026-07-04
**Audience:** acquirer diligence teams, enterprise-security reviewers, prospective customer InfoSec.
**Full detail:** `docs/SOC2_CONTROLS.md` (Trust Services Criteria mapping) · `docs/SOC2_READINESS_CHECKLIST.md` (95-item scorecard) · `docs/DATA_ROOM_INDEX.md` (evidence-to-control map).

---

## Position

ServiceCycle is **SOC 2 Type I evidence-ready** as of 2026-07-04. Type II requires 6–12 months of operating evidence collection; a formal audit engagement has not been commissioned pre-revenue but the posture is engineered so that engaging a Type II auditor is a matter of collecting existing dated artifacts, not building missing controls.

## Score at a glance

95 controls tracked across 12 categories (access, change management, vulnerability management, logging & monitoring, incident response, backup & DR, risk & governance, data retention & privacy, AI governance, vendor risk, endpoint / solo-dev compensating controls, evidence discipline).

**🟢 80 done · 🟡 15 documented pending single execution step · 🔴 0** (per `docs/SOC2_READINESS_CHECKLIST.md` summary scoreboard, current as of the 2026-07-08 acquisition audit).

Two of the 15 yellows are dated-evidence-first-execution items (first quarterly access review, first quarterly security review) — every procedure is written; running the cadence once closes each to green.

## What's actually in place

**Security engineering (CC6, CC7):**
- Tamper-evident audit log (SHA-256 hash chain per account, tested nightly).
- MFA/TOTP with admin enforcement; SSO + SAML (dark-by-default via Ory Polis) with SCIM-brokered directory sync — Ory Polis implements SCIM against the IdP and pushes provisioning/deprovisioning events to ServiceCycle's inbound webhook consumer; ServiceCycle does not itself expose a standard SCIM v2 resource-server API.
- RBAC (8 roles), tenant-scoped queries with integration tests, instant session revocation on password change (`tokenEpoch`).
- AES-256-GCM encryption at rest: a single shared `MASTER_KEY` protects secret-bearing columns (BYO storage credentials, etc.) and gates opt-in document encryption (`ENCRYPT_DOCS`, per-document key via HKDF off that same master key for uploaded PDFs/photos). This is master-key encryption, not per-account/per-tenant envelope encryption — there are no per-account data-encryption keys today. Test-report, measurement, and arc-flash business data are plaintext Postgres columns (protected by network/access controls and disk-level hosting encryption, not column-level encryption). Backup encryption uses a separate `BACKUP_ENCRYPTION_KEY`.
- Rate limiting (per-IP + per-token + per-email lockout); Zod input validation; Helmet headers + CSP + HSTS.
- CI security stack live on `main`: Gitleaks, CodeQL (SAST), Trivy (fs + container CVE scan), CycloneDX SBOM auto-gen, release-evidence archive on tag, signed-commit verifier.

**Reliability & DR (A1, CC9):**
- Nightly encrypted `pg_dump` to off-host S3-compatible target (30-day rolling retention, `BACKUP_ENCRYPTION_KEY` client-side).
- Automated restore testing at two cadences (both in `server/lib/restoreTest.ts`): weekly table-of-contents integrity check + monthly deep restore to a sidecar Postgres with row-count verification.
- Health check endpoint + Better Stack synthetic monitor + Healthchecks.io heartbeat wired.
- Documented RTO ~2h / RPO ~24h.
- 7 per-scenario BC playbooks (droplet outage, DB corruption, Cloudflare outage, GitHub outage, AI provider outage, vendor account compromise, workstation compromise).

**Governance (CC1, CC3, CC5):**
- 10-risk risk register with L×I scoring + quarterly review cadence.
- Risk acceptance log (8 accepted risks, each dated with reconsider-by).
- Whole-app threat model (10 threats × mitigations × residual risk).
- Change-review checklist v1.1 with solo-founder separation-of-duties compensating-control statement (RAR-006).
- Vendor security reviews on 10 sub-processors + failure-mode matrix.
- Automated data-retention enforcement via 10 nightly prune crons (activity_logs 365d, ai_usage 90d, notification_logs 180d, etc.).

**Evidence discipline (CC4, CC7):**
- Dated evidence folder pattern `docs/compliance/evidence/YYYY-MM/` with frontmatter template.
- First tabletop drill run 2026-07-04 (scenario: DO regional outage).
- First weekly log-review evidence bullet logged 2026-07-04.
- Baseline security-metrics-2026-07.md template ready for month-end close.
- Automated monthly scheduled task pings the operator on the 1st of each month with a punch list.

**Solo-founder compensating controls (RAR-006):** every change captured in git from a signed key (SSH signing configurable), every deploy audit-logged with commit SHA, mandatory change-review checklist on schema/auth/API/integration PRs, CI gates the founder cannot silently bypass (npm audit, tsc, jest, Gitleaks, CodeQL, Trivy, verify-signed-commits), Dependabot + Trivy weekly full-history scans, PR-body attestation required for security-sensitive changes.

## What the 15 yellows are

Documented and awaiting a single execution step each:
- 5 need admin action on GitHub (branch protection, signed-commits enforce, DAST target var, environment gate, deploy secrets) — `docs/security/GITHUB_ADMIN_SETUP.md` has copy-paste commands.
- 4 need dated evidence execution (screenshots + confirmation).
- 4 need production env or configuration steps (Better Stack alert activation, backup dest cred, disposal-log first entry, restore-test archive).
- 2 are minor consolidations (privacy-policy attorney review pending; release-verification could be re-examined).

## Trust-page pointers

- Security disclosure: `SECURITY.md` (email `security@servicecycle.app`) + `/.well-known/security.txt`.
- Full controls matrix: `docs/SOC2_CONTROLS.md`.
- Threat model: `docs/security/THREAT_MODEL.md`.
- Data flow: `docs/security/DATA_FLOW.md`.
- Data classification: `docs/security/DATA_CLASSIFICATION.md`.
- Data retention matrix: `docs/compliance/DATA_RETENTION_MATRIX.md`.
- Privacy-request lifecycle: `docs/security/PRIVACY_REQUESTS.md`.
- Vendor risk + failure-mode matrix: `docs/VENDOR_SECURITY_REVIEW.md`.
- Incident response: `docs/INCIDENT_RESPONSE.md`.
- Key rotation runbook: `docs/KEY_ROTATION.md`.

## Compliance stance

- **SOC 2 Type I**: engineered for. Formal engagement post-revenue.
- **SOC 2 Type II**: 6–12 months of operating evidence collection begins the day the readiness sweep goes green (target: Q3 2026 end).
- **GDPR**: data-subject request lifecycle documented (`docs/security/PRIVACY_REQUESTS.md`); breach notification thresholds + templates in `docs/INCIDENT_RESPONSE.md` §5; sub-processor list published in `docs/OFFBOARDING.md` §6.
- **HIPAA**: not in scope — SC does not collect health data.
- **PCI**: not in scope — SC does not store payment card data (Stripe handles PCI scope).

## Acquirer read

The remaining path to 100% is execution, not engineering. Nothing on the yellow / red list is architectural. A 2-hour founder session closes the majority of the yellows; a formal Type II auditor engagement closes the rest.
