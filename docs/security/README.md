# `docs/security/` — Security & SOC 2 Documentation Index

**Purpose:** entry point for anyone opening the security folder cold — an auditor, an acquirer's diligence team, a new engineer, or Dustin returning after a break.

**Compiled:** 2026-07-04
**Anchor:** [`docs/SOC2_CONTROLS.md`](../SOC2_CONTROLS.md) is the Trust Services Criteria mapping (which control lives where). This README is the *narrative* index.

---

## Where to start

| If you want to... | Read... |
|---|---|
| See the SOC 2 posture at a glance | [`../SOC2_ONE_PAGER.md`](../SOC2_ONE_PAGER.md) |
| See the 95-item scorecard | [`../SOC2_READINESS_CHECKLIST.md`](../SOC2_READINESS_CHECKLIST.md) |
| See TSC → control → code/doc mapping | [`../SOC2_CONTROLS.md`](../SOC2_CONTROLS.md) |
| See the evidence data-room map | [`../DATA_ROOM_INDEX.md`](../DATA_ROOM_INDEX.md) |
| Understand what threats we're defending against | [`THREAT_MODEL.md`](THREAT_MODEL.md) |
| Understand how data moves | [`DATA_FLOW.md`](DATA_FLOW.md) |
| See what runs where | [`ASSET_INVENTORY.md`](ASSET_INVENTORY.md) |

---

## Policies (the "what we say we do")

| Policy | Purpose | SOC 2 mapping |
|---|---|---|
| [`ENDPOINT_SECURITY.md`](ENDPOINT_SECURITY.md) | Workstation baseline (FDE, screen lock, AV) + solo-founder compensating controls | CC1, CC6 |
| [`SESSION_MANAGEMENT.md`](SESSION_MANAGEMENT.md) | JWT lifecycle + `tokenEpoch` revocation model | CC6.2, CC6.4 |
| [`DATA_CLASSIFICATION.md`](DATA_CLASSIFICATION.md) | 4-tier data classification (public / internal / confidential / restricted) | C1.1 |
| [`SIGNED_COMMITS.md`](SIGNED_COMMITS.md) | GPG / SSH commit signing setup | CC1.4, CC8.1 |
| [`../CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | Ethics + confidentiality + least-privilege | CC1.1 |
| [`../PERSONNEL_SECURITY.md`](../PERSONNEL_SECURITY.md) | Onboard / offboard + access-removal | CC1.3 |
| [`../INCIDENT_RESPONSE.md`](../INCIDENT_RESPONSE.md) | IR plan + severity matrix + breach notification | CC7.4, CC7.5 |
| [`../KEY_ROTATION.md`](../KEY_ROTATION.md) | Zero-downtime rotation for JWT / MASTER_KEY / BACKUP_ENCRYPTION_KEY | CC6.8 |
| [`../CHANGE_REVIEW_CHECKLIST.md`](../CHANGE_REVIEW_CHECKLIST.md) | Per-PR review gate + solo-founder SoD compensating control | CC3.4, CC8.1 |
| [`../VENDOR_SECURITY_REVIEW.md`](../VENDOR_SECURITY_REVIEW.md) | Vendor risk template + failure-mode matrix | CC9.2 |
| [`../SECURITY_TRUST_PACK.md`](../SECURITY_TRUST_PACK.md) | Customer-facing security narrative | CC2.2 |

## Procedures (the "how we do it")

| Procedure | Cadence | Evidence goes to |
|---|---|---|
| [`ACCESS_REVIEW.md`](ACCESS_REVIEW.md) | quarterly | `docs/compliance/evidence/YYYY-QN/access-review-YYYY-MM-DD.md` |
| [`LOG_REVIEW.md`](LOG_REVIEW.md) | weekly + monthly + quarterly | `docs/compliance/evidence/YYYY-MM/log-review-weekly.md` + `log-review-quarterly-*` |
| [`QUARTERLY_SECURITY_REVIEW.md`](QUARTERLY_SECURITY_REVIEW.md) | quarterly umbrella | `docs/compliance/evidence/YYYY-QN/quarterly-security-review-*.md` |
| [`RELEASE_VERIFICATION.md`](RELEASE_VERIFICATION.md) | per release | commit / CHANGELOG entry |
| [`MODEL_VERSIONING.md`](MODEL_VERSIONING.md) | on model swap | `SECURITY_DECISIONS.md` entry |
| [`TENANT_DELETION_PROCESS.md`](TENANT_DELETION_PROCESS.md) | on data-subject / offboarding request | `docs/compliance/evidence/YYYY-MM/tenant-deletion-*.md` |
| [`PRIVACY_REQUESTS.md`](PRIVACY_REQUESTS.md) | on request | `docs/compliance/evidence/YYYY-MM/privacy-request-*.md` |
| [`SECURE_DISPOSAL_LOG.md`](SECURE_DISPOSAL_LOG.md) | monthly | `docs/compliance/evidence/YYYY-MM/secure-disposal-*.md` |
| [`SECURITY_AWARENESS_TRAINING_LOG.md`](SECURITY_AWARENESS_TRAINING_LOG.md) | annual | this file itself |

## Runbooks (the "how to do the thing right now")

| Runbook | Purpose |
|---|---|
| [`GITHUB_ADMIN_SETUP.md`](GITHUB_ADMIN_SETUP.md) | One-time org-admin GH config: branch protection, signed-commits enforce, DAST target var, environment gate, deploy secrets |
| [`BETTER_STACK_ACTIVATION.md`](BETTER_STACK_ACTIVATION.md) | Turn on Better Stack HTTP synthetic + heartbeat alerts |
| [`BC_PLAYBOOKS.md`](BC_PLAYBOOKS.md) | 7 per-scenario recovery playbooks (droplet outage, DB corruption, Cloudflare outage, GH outage, AI provider outage, vendor account compromise, workstation compromise) |
| [`../DEPLOY_RUNBOOK.md`](../DEPLOY_RUNBOOK.md) | Standard deploy + rollback + DR |

## Inventories (the "what we have")

| Inventory | Update on... |
|---|---|
| [`ASSET_INVENTORY.md`](ASSET_INVENTORY.md) | Any asset add/remove/reclassify |
| [`SECRETS_INVENTORY.md`](SECRETS_INVENTORY.md) | Any secret rotation, add, or vendor change |
| [`ENVIRONMENT_INVENTORY.md`](ENVIRONMENT_INVENTORY.md) | Any env-var / integration change |
| [`PERMISSIONS_MATRIX.md`](PERMISSIONS_MATRIX.md) | Any role capability change |
| [`MONITORING_MATRIX.md`](MONITORING_MATRIX.md) | Any new signal / threshold / channel |
| [`DEPENDENCY_DECISIONS.md`](DEPENDENCY_DECISIONS.md) | Any new direct dep + any accepted CVE |
| [`SECURITY_DECISIONS.md`](SECURITY_DECISIONS.md) | Any architectural security decision |
| [`../compliance/RISK_ACCEPTANCE_LOG.md`](../compliance/RISK_ACCEPTANCE_LOG.md) | Any accepted residual risk (RAR-NNN entries) |
| [`../compliance/VENDOR_REVIEW_LOG.md`](../compliance/VENDOR_REVIEW_LOG.md) | Annually per vendor + on any material event |
| [`../compliance/DATA_RETENTION_MATRIX.md`](../compliance/DATA_RETENTION_MATRIX.md) | Any new data class stored |
| [`../RISK_REGISTER.md`](../RISK_REGISTER.md) | Quarterly + on any new risk |

## Design docs

| Doc | Purpose |
|---|---|
| [`RETENTION_ENFORCEMENT_DESIGN.md`](RETENTION_ENFORCEMENT_DESIGN.md) | Retention enforcement — **§Actual state** documents the shipped nightly prune cascade |
| [`../AUDIT_LOG_ARCHITECTURE.md`](../AUDIT_LOG_ARCHITECTURE.md) | SHA-256 hash-chain design + threat model of the chain itself |
| [`SSO_DESIGN.md`](SSO_DESIGN.md) | Ory Polis SSO / SAML / SCIM design |
| [`POLIS_ATTRIBUTION.md`](POLIS_ATTRIBUTION.md) | Polis attribution notes |

## Audit reports (point-in-time)

| Report | Date |
|---|---|
| [`SECURITY_REVIEW_2026-07-07.md`](SECURITY_REVIEW_2026-07-07.md) | Manual review of partner-webhook signing (621798e) + field_tech document annotations (e26354c) + overnight cron fixes — 0 Critical/High, 1 Low (dead 2-arg signPayload branch) |
| [`SECURITY_AUDIT_2026-06-20.md`](SECURITY_AUDIT_2026-06-20.md) | Pre-demo security audit |
| [`../security-audit-2026-06-09.md`](../security-audit-2026-06-09.md) | Earlier audit |
| [`../DEPENDENCY_AUDIT_2026-06-18.md`](../DEPENDENCY_AUDIT_2026-06-18.md) | Dependency posture snapshot |
| [`../DOMAIN_ACCURACY_AUDIT_2026-06-28.md`](../DOMAIN_ACCURACY_AUDIT_2026-06-28.md) | EE domain accuracy audit (pre-NETA demo) |

## Evidence

Dated evidence artifacts live under [`../compliance/evidence/`](../compliance/evidence/) organized by `YYYY-MM/` (monthly) and `YYYY-QN/` (quarterly). See [`../compliance/evidence/README.md`](../compliance/evidence/README.md) for the folder convention + frontmatter template. Reusable templates in [`../compliance/evidence/_templates/`](../compliance/evidence/_templates/).

## Cadence at a glance

| Cadence | What runs | Where evidence lands |
|---|---|---|
| Nightly (03:00–03:55 UTC) | 10 retention prune crons + audit-chain verifier | activity log + Better Stack alerts on chain break |
| Nightly (02:00 UTC) | Encrypted backup | `BackupLog` + healthchecks.io |
| Weekly | Log-review 5-min glance | `docs/compliance/evidence/YYYY-MM/log-review-weekly.md` |
| Weekly (schedules) | Trivy image-scan + Gitleaks full-history + CodeQL deep scan | GH Actions runs |
| Monthly (1st) | Restore test + security metrics rollup + secure disposal + retention scheduled task ping | `docs/compliance/evidence/YYYY-MM/` |
| Quarterly | Access review + log-review quarterly + umbrella quarterly security review | `docs/compliance/evidence/YYYY-QN/` |
| Annual | Security awareness training entry + tabletop drill + full risk-register walkthrough | `docs/security/SECURITY_AWARENESS_TRAINING_LOG.md` + evidence folder |

## When something changes

- **New dep**: log in `DEPENDENCY_DECISIONS.md`; SBOM auto-regenerates on tag.
- **New vendor**: `VENDOR_SECURITY_REVIEW.md` row + `VENDOR_REVIEW_LOG.md` entry + `SECRETS_INVENTORY.md` if a credential is issued + `ASSET_INVENTORY.md` + `DATA_FLOW.md` if data flows to them.
- **New route / endpoint**: `PERMISSIONS_MATRIX.md` + `docs/CHANGE_REVIEW_CHECKLIST.md` § Auth/roles.
- **New data class**: `DATA_CLASSIFICATION.md` + `DATA_RETENTION_MATRIX.md` + `THREAT_MODEL.md` if threat surface changes.
- **New AI model**: `MODEL_VERSIONING.md` procedure + `SECURITY_DECISIONS.md` entry.
- **New accepted risk**: `RISK_ACCEPTANCE_LOG.md` RAR-NNN with reconsider-by date.
- **Incident**: `docs/compliance/incidents/YYYY-MM-DD-*.md` per `docs/compliance/incidents/README.md`.
