# ServiceCycle — Data Room Index

**Classification:** Confidential / Diligence
**Updated:** 2026-07-04 (SOC 2 readiness sweep)
**Contact:** servicecycle.app (demo access on request)

This index maps the standard PE/M&A due diligence workstream categories to the
relevant materials in this repository. All documents are in the `docs/` directory
unless noted.

---

## Quick links for common diligence requests

| Request | Document |
|---|---|
| "Send me the acquisition overview" | `docs/ACQUISITION_BRIEF.md` |
| "Can we do a demo?" | `docs/DEMO_SCRIPT.md` (guide) + servicecycle.app (live) |
| "What's the tech stack?" | `docs/ARCHITECTURE.md` |
| "What are the security controls?" | `docs/SOC2_CONTROLS.md` + `docs/SECURITY_TRUST_PACK.md` |
| "Give me the SOC 2 one-pager" | `docs/SOC2_ONE_PAGER.md` |
| "Show me the SOC 2 readiness scorecard" | `docs/SOC2_READINESS_CHECKLIST.md` |
| "Where's the full security-docs index?" | `docs/security/README.md` |
| "Who owns the IP?" | `docs/IP_OWNERSHIP.md` + `LICENSE` |
| "What does the handoff look like?" | `docs/ENGINEERING_HANDOFF.md` |
| "What's left to build?" | `docs/ACQUISITION_BRIEF.md` §Deferred + `docs/COMPETITIVE_ANALYSIS.md` |
| "Who are the competitors?" | `docs/COMPETITIVE_ANALYSIS.md` |

---

## 1. Business and strategy

| Document | Location | Contents |
|---|---|---|
| Acquisition brief | `docs/ACQUISITION_BRIEF.md` | Market thesis, product, moat, acquisition angles, upside narrative, asking price considerations |
| Two-sided model narrative | `docs/CONTRACTOR_FLYWHEEL_NARRATIVE.md` | How the facility↔contractor flywheel works; why the design is customer-aligned; the non-negotiable wall |
| Competitive analysis | `docs/COMPETITIVE_ANALYSIS.md` | Competitive landscape overview — vs CMMS, OEM software, NETA tools; barriers to replication |
| ServiceCycle vs. Gimba | `docs/ServiceCycle_vs_Gimba_Competitive_Analysis.md` | Deep feature comparison vs. Gimba (closest named competitor); shows feature parity and differentiation (note: some ❌ gaps since addressed) |
| Pricing architecture | `docs/PRICING.md` | SaaS pricing model design — location-based tiers, Stripe activation path, OEM licensing model, unit economics |
| Demo script | `docs/DEMO_SCRIPT.md` | Structured 20-min PE/OEM demo walkthrough with objection handling |

---

## 2. Technology and architecture

| Document | Location | Contents |
|---|---|---|
| Architecture overview | `docs/ARCHITECTURE.md` | Stack, data model, security architecture, scaling path |
| Engineering handoff | `docs/ENGINEERING_HANDOFF.md` | Day-1 guide for a new CTO — what to know, key debt, deferred items |
| Deploy runbook | `docs/DEPLOY_RUNBOOK.md` | Operator install, deploy pipeline, rollback, disaster recovery |
| Self-host guide | `docs/SELF_HOST.md` | Air-gapped / no-egress install guide |
| API changelog | `docs/api/CHANGELOG.md` | Public API version history (v1.0–v1.4) and breaking-change policy |
| OpenAPI spec | `server/data/openapi/v1.yaml` | Machine-readable v1 API spec (OpenAPI 3.1) |
| Integration guide | `docs/api/INTEGRATIONS.md` | MaintainX + Salesforce integration walkthrough; webhook event reference |
| Telemetry API | `docs/api/TELEMETRY.md` | Edge-gateway push API reference |
| Arc-flash spec | `docs/api/AFX_SPEC.md` | AFX v1 export field catalog |
| CI pipeline | `.github/workflows/ci.yml` | TypeScript + jest (unit + integration) + npm audit; runs on every PR |

---

## 3. Legal and intellectual property

| Document | Location | Contents |
|---|---|---|
| IP ownership statement | `docs/IP_OWNERSHIP.md` | Author, prior-employer claims, third-party licenses, AI-generated code, trademark |
| License | `LICENSE` | Proprietary notice (all rights reserved) |
| Privacy policy | `/legal/privacy` (live at servicecycle.app/privacy) | Customer privacy policy draft (attorney review pending) |
| Sub-processor list | `docs/OFFBOARDING.md` §6 | Third-party services that process customer data |
| Vendor security review | `docs/VENDOR_SECURITY_REVIEW.md` | Vendor questionnaire + approval record (Anthropic, Resend, DigitalOcean, Google, Groq) |
| Offboarding / data portability | `docs/OFFBOARDING.md` | Customer data export, account deletion, GDPR erasure |
| EULA | `/legal/eula` (live at servicecycle.app/legal/eula) | End-user license agreement |

---

## 4. Security and compliance

### Executive artifacts

| Document | Location | Contents |
|---|---|---|
| SOC 2 one-pager | `docs/SOC2_ONE_PAGER.md` | Single-page executive summary of SOC 2 posture for acquirer / enterprise-security reviewer |
| SOC 2 readiness checklist | `docs/SOC2_READINESS_CHECKLIST.md` | 95-item scorecard across A–L categories; live status green/yellow/red per item |
| SOC 2 Type I controls | `docs/SOC2_CONTROLS.md` | Trust Service Criteria mapped to controls + evidence + gaps |
| Security-docs narrative index | `docs/security/README.md` | Entry point for anyone opening the security folder cold — categorized navigation |

### Policies

| Document | Location | Contents |
|---|---|---|
| Security trust pack | `docs/SECURITY_TRUST_PACK.md` | Customer-facing security posture summary |
| Endpoint security policy | `docs/security/ENDPOINT_SECURITY.md` | Workstation baseline + solo-founder compensating controls |
| Session management policy | `docs/security/SESSION_MANAGEMENT.md` | JWT + `tokenEpoch` revocation model |
| Data classification | `docs/security/DATA_CLASSIFICATION.md` | 4-tier classification (public / internal / confidential / restricted) |
| Signed commits policy | `docs/security/SIGNED_COMMITS.md` | GPG / SSH commit signing setup + enforcement |
| Change review checklist | `docs/CHANGE_REVIEW_CHECKLIST.md` v1.1 | Per-PR review + solo-founder SoD compensating control |
| Key rotation runbook | `docs/KEY_ROTATION.md` | JWT_SECRET / MASTER_KEY / BACKUP_ENCRYPTION_KEY rotation |
| Security policy | `SECURITY.md` | Responsible disclosure, 90-day window, safe harbor |

### Procedures + runbooks

| Document | Location | Contents |
|---|---|---|
| Access review procedure | `docs/security/ACCESS_REVIEW.md` | Quarterly access review across 8 vendor accounts + SC in-app admins |
| Log review procedure | `docs/security/LOG_REVIEW.md` | Weekly 5-min + monthly rollup + quarterly deep review |
| Quarterly security review | `docs/security/QUARTERLY_SECURITY_REVIEW.md` | 13-item umbrella cadence |
| Release verification | `docs/security/RELEASE_VERIFICATION.md` | Per-release checklist + PR-body sign-off stub |
| Model versioning | `docs/security/MODEL_VERSIONING.md` | LLM pinning + swap procedure + rollback |
| Tenant deletion process | `docs/security/TENANT_DELETION_PROCESS.md` | FK-ordered wipe sequence + verification SQL |
| Privacy request handling | `docs/security/PRIVACY_REQUESTS.md` | Data-subject request lifecycle + SLAs |
| Business continuity playbooks | `docs/security/BC_PLAYBOOKS.md` | 7 per-scenario recovery playbooks |
| Incident response | `docs/INCIDENT_RESPONSE.md` | Severity matrix, breach notification, GDPR timelines |
| Better Stack activation | `docs/security/BETTER_STACK_ACTIVATION.md` | Turn on HTTP synthetic + heartbeat alerts |
| GitHub admin setup | `docs/security/GITHUB_ADMIN_SETUP.md` | One-time org-owner GH config kit |

### Inventories

| Document | Location | Contents |
|---|---|---|
| Asset inventory | `docs/security/ASSET_INVENTORY.md` | Every asset with SOC 2 scope |
| Secrets inventory | `docs/security/SECRETS_INVENTORY.md` | Every credential with rotation cadence |
| Environment inventory | `docs/security/ENVIRONMENT_INVENTORY.md` | Every env var + integration |
| Permissions matrix | `docs/security/PERMISSIONS_MATRIX.md` | 8 roles × 40 features |
| Monitoring matrix | `docs/security/MONITORING_MATRIX.md` | Signals + thresholds + channels |
| Dependency decisions | `docs/security/DEPENDENCY_DECISIONS.md` | Add-a-dep + accept-a-CVE log |
| Security decisions | `docs/security/SECURITY_DECISIONS.md` | Architectural security decisions with rationale |
| Risk register | `docs/RISK_REGISTER.md` | 10 risks, L×I scoring, mitigations |
| Risk acceptance log | `docs/compliance/RISK_ACCEPTANCE_LOG.md` | 8 accepted residual risks (RAR-001..008) with reconsider-by dates |
| Vendor security review | `docs/VENDOR_SECURITY_REVIEW.md` v1.1 | 9-vendor questionnaire + failure-mode matrix |
| Vendor review log | `docs/compliance/VENDOR_REVIEW_LOG.md` | Dated per-vendor review cadence |
| Data retention matrix | `docs/compliance/DATA_RETENTION_MATRIX.md` | Every data class × retention × deletion mechanism |

### Design docs

| Document | Location | Contents |
|---|---|---|
| Threat model | `docs/security/THREAT_MODEL.md` | 10 threats × mitigations × residual risk |
| Data flow | `docs/security/DATA_FLOW.md` | 5 flows + role-based access matrix |
| Audit log architecture | `docs/AUDIT_LOG_ARCHITECTURE.md` | SHA-256 hash chain + threat model of the chain |
| Retention enforcement design | `docs/security/RETENTION_ENFORCEMENT_DESIGN.md` | 10 nightly prune crons documented (§Actual state) |
| Secure disposal cadence | `docs/security/SECURE_DISPOSAL_LOG.md` | Monthly disposal verification pattern |

### Evidence (dated artifacts)

| Location | Contents |
|---|---|
| `docs/compliance/evidence/README.md` | Folder convention + frontmatter template |
| `docs/compliance/evidence/_templates/` | Reusable templates (restore-test, endpoint-security) |
| `docs/compliance/evidence/2026-07/` | July 2026 evidence (log-review, security-metrics baseline, tabletop drill, secure disposal) |
| `docs/compliance/evidence/2026-Q3/` | Q3 2026 quarterly evidence (access review scaffold, quarterly security review scaffold) |
| `docs/compliance/incidents/` | Incident record folder + template + null-baseline entry |

### Audit reports (point-in-time)

| Document | Location | Contents |
|---|---|---|
| Security audit 2026-06-20 | `docs/security/SECURITY_AUDIT_2026-06-20.md` | Pre-demo security audit |
| Security audit 2026-06-09 | `docs/security-audit-2026-06-09.md` | Earlier audit |
| Dependency audit | `docs/DEPENDENCY_AUDIT_2026-06-18.md` | Point-in-time npm audit; ongoing via Dependabot + CI |
| Domain accuracy audit | `docs/DOMAIN_ACCURACY_AUDIT_2026-06-28.md` | EE domain accuracy audit pre-NETA demo |

### CI security scanning stack (live on `main`)

| Workflow | Location | Purpose |
|---|---|---|
| Gitleaks | `.github/workflows/gitleaks.yml` | Secret scan on every push + PR + weekly full-history |
| CodeQL SAST | `.github/workflows/codeql.yml` | Push + PR + weekly |
| Trivy CVE + misconfig | `.github/workflows/trivy.yml` | Filesystem scan + container image scan |
| SBOM auto-gen | `.github/workflows/sbom.yml` | CycloneDX SBOM on push to main + tags |
| Release evidence archive | `.github/workflows/release-evidence.yml` | Attach SBOMs + audits + Trivy on release tags |
| Release tag automation | `.github/workflows/release-tag.yml` | Auto-tag on version bump |
| Signed commit verifier | `.github/workflows/verify-signed-commits.yml` | Warn-only until REQUIRE_SIGNED_COMMITS var set |
| DAST OWASP ZAP baseline | `.github/workflows/dast-zap.yml` | Manual + weekly (safe default: skips unless DAST_TARGET_URL set) |

---

## 5. People and governance

| Document | Location | Contents |
|---|---|---|
| Code of conduct | `docs/CODE_OF_CONDUCT.md` | Ethics policy: data integrity, confidentiality, least-privilege, breach reporting |
| Personnel security | `docs/PERSONNEL_SECURITY.md` | Pre-access requirements, onboarding/offboarding checklists, access log |

---

## 6. Product and roadmap

| Document | Location | Contents |
|---|---|---|
| Feature overview | `README.md` | What the product does, tech stack, key docs table |
| Deferred items (funded upside) | `docs/ACQUISITION_BRIEF.md` §Deferred | OEM data atlas, predictive RUL, marketplace, report generation |
| OEM atlas design | `docs/research/2026-06-20-oem-atlas-cross-tenant-design.md` | Technical design for cross-tenant fleet analytics (post-acquisition upside) |

---

## 7. Operations

| Document | Location | Contents |
|---|---|---|
| Live demo | servicecycle.app | Gated; request credentials at contact above |
| VPS details | 198.211.99.45 (DigitalOcean, NYC) | Production server; Docker Compose; nightly Postgres backup |
| RTO / RPO | `docs/DEPLOY_RUNBOOK.md` + SOC2 CC9.1 | RTO ~2h / RPO ~24h |

---

## Source code access

Full source code is available for review under NDA. The repository is hosted
at GitHub (`servicecyclehq/servicecycle`). Contact the founder to arrange
read-only access under a signed non-disclosure agreement.

The test suite (`npm test` in `server/`) has ~450 integration tests covering
auth, tenant isolation, arc-flash logic, the v1 public API, and IDOR
protections. CI runs on every PR via GitHub Actions.
