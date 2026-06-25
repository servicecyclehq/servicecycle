# ServiceCycle — Data Room Index

**Classification:** Confidential / Diligence  
**Updated:** 2026-06-25  
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

| Document | Location | Contents |
|---|---|---|
| SOC 2 Type I controls | `docs/SOC2_CONTROLS.md` | 13+ Trust Service Criteria mapped; remediation status for each gap |
| Audit log architecture | `docs/AUDIT_LOG_ARCHITECTURE.md` | SHA-256 hash-chained tamper-evident audit log — how it works, threat model, GDPR compatibility |
| Security trust pack | `docs/SECURITY_TRUST_PACK.md` | Customer-facing security posture summary |
| Risk register | `docs/RISK_REGISTER.md` | 10 risks, L×I scoring, mitigations, residual scores, quarterly cadence |
| Incident response | `docs/INCIDENT_RESPONSE.md` | P0–P3 playbooks, customer notification thresholds, GDPR timelines |
| Key rotation | `docs/KEY_ROTATION.md` | JWT_SECRET, MASTER_KEY, BACKUP_ENCRYPTION_KEY rotation procedures |
| Security policy | `SECURITY.md` | Responsible disclosure, 90-day window, safe harbor |
| Dependency audit | `docs/DEPENDENCY_AUDIT_2026-06-18.md` | Point-in-time npm audit; ongoing via Dependabot + CI |
| Change review checklist | `docs/CHANGE_REVIEW_CHECKLIST.md` | Mandatory review criteria for security-impacting PRs |

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
