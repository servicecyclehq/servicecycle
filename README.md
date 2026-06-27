# ServiceCycle

**Electrical-infrastructure maintenance compliance platform.**

ServiceCycle is a self-hostable, data-layer SaaS for electrical maintenance programs at utilities, industrials, and facilities teams. It ingests inspection reports, arc-flash studies, and real-time telemetry; surfaces NFPA 70B compliance gaps, audit evidence, and arc-flash label currency; and exports all data in open formats with no lock-in.

**Live demo:** [servicecycle.app](https://servicecycle.app) (basic-auth gated for diligence access — contact for credentials)

---

## What it does

- **Compliance calendar** — NFPA 70B condition-based maintenance intervals (C1/C2/C3) with automatic schedule advancement on work-order completion.
- **Arc-flash management** — IEEE 1584 study ingestion (AI-assisted gap-fill), NFPA 70E 130.5(H) label generation, AFX v1 export, per-asset energized-work permits, 5-year review tracking.
- **Document ingest** — deterministic PDF/test-report parser (runs in-container, no third party) with AI draft-fill for thin or scanned reports.
- **Condition monitoring** — telemetry ingestion from OT edge gateways via the v1 telemetry API; a CRIT breach auto-escalates the asset to NFPA 70B C2. Alert surfaces poll on a short interval (the client has no live push channel today), so detection is near-real-time, not instantaneous.
- **Parts & spare inventory** — parts catalog, site/asset inventory, low-stock procurement-risk flags, required-parts panel per asset.
- **Full data portability** — `GET /api/export/account` produces a complete portable snapshot (JSON + XLSX): all assets, work orders, arc-flash data, parts, and documents. See `docs/OFFBOARDING.md`.
- **Public REST API** — versioned (`/api/v1`), API-key-scoped (`sc_<key>` format), OpenAPI 3.1 spec at `/docs/api`.
- **SSO** — Ory Polis OIDC/SAML/SCIM; ships dark by default (`SSO_ENABLED` env flag).
- **Multi-tenant** — HoldCo/OpCo rollup (EnterpriseGroup) + OEM fleet view (PartnerOrganization).

---

## Tech stack

| Layer | Technology |
|---|---|
| API server | Node 20 + Express 4 (TypeScript via tsc) |
| ORM | Prisma 5 (PostgreSQL 16) |
| Client SPA | React 18 + Vite 5 |
| Auth | JWT + bcrypt + optional TOTP; Ory Polis for SSO |
| PDF / labels | pdfkit, pdfjs-dist, pyextract (pdfplumber + tesseract) |
| AI | Provider-configurable (Cloudflare Workers AI default on demo; Anthropic / OpenAI / Azure OpenAI / Gemini selectable) with a Cloudflare → HuggingFace → Groq cascade fallback; BYO-key supported |
| Email | Brevo (transactional + inbound) |
| Deploy | Docker Compose, nginx (static SPA), DigitalOcean |

---

## Running locally

```bash
# Prerequisites: Node 20, PostgreSQL 16, Docker (for the full stack)

# Full Docker Compose stack (recommended)
cp server/.env.example .env   # fill in POSTGRES_PASSWORD, JWT_SECRET, MASTER_KEY
docker compose up -d

# Dev (server watches TypeScript, Vite HMR for client)
cd server && npm install && npm run dev   # :3001
cd client && npm install && npm run dev   # :5173
```

For a production deployment, see **`docs/DEPLOY_RUNBOOK.md`**.
For air-gapped / self-hosted installs, see **`docs/SELF_HOST.md`**.

---

## Test suite

```bash
cd server
npm test                   # full integration suite (~450 tests)
npm test -- --grep parts   # run a subset by name
```

Tests require a running Postgres + server on `:3001` (or the Docker stack). Each test file uses `setupTenants()` to provision isolated test accounts — no shared state between files.

---

## Key docs

| Document | Purpose |
|---|---|
**Acquisition / diligence**
| `docs/DATA_ROOM_INDEX.md` | **Start here** — maps every diligence workstream to the relevant document |
| `docs/ACQUISITION_BRIEF.md` | Market thesis, product moat, acquisition angles, upside, asking-price considerations |
| `docs/COMPETITIVE_ANALYSIS.md` | Competitive landscape — vs CMMS, OEM software, NETA tools |
| `docs/DEMO_SCRIPT.md` | Structured 20-min PE/OEM demo walkthrough with objection handling |
| `docs/IP_OWNERSHIP.md` | IP ownership statement — authorship, third-party licenses, AI-assisted code |

**Engineering**
| `docs/ARCHITECTURE.md` | Stack, data model, security architecture, scaling path |
| `docs/ENGINEERING_HANDOFF.md` | Day-1 guide for an incoming engineering lead post-acquisition |
| `docs/DEPLOY_RUNBOOK.md` | Operator install + deploy runbook |
| `docs/SELF_HOST.md` | Air-gapped / no-egress self-host guide |
| `docs/CHANGE_REVIEW_CHECKLIST.md` | Mandatory change-impact review for schema/auth/API PRs |
| `docs/OFFBOARDING.md` | Data export and portability guide (no lock-in) |

**Security / compliance**
| `docs/SOC2_CONTROLS.md` | SOC 2 control-design self-assessment — Trust Service Criteria mapped to implemented controls (Type I *readiness*, not an issued report; no Type II evidence collection yet) |
| `docs/SECURITY_TRUST_PACK.md` | Customer-facing security posture summary |
| `docs/RISK_REGISTER.md` | Operational risk register (10 risks, L×I, mitigations, quarterly cadence) |
| `docs/INCIDENT_RESPONSE.md` | Incident response plan + customer breach notification template |
| `docs/KEY_ROTATION.md` | Secret key rotation procedures |
| `docs/VENDOR_SECURITY_REVIEW.md` | Vendor questionnaire + approval record (all current sub-processors) |
| `docs/PERSONNEL_SECURITY.md` | Onboarding/offboarding checklist, access log |
| `docs/CODE_OF_CONDUCT.md` | Ethics and conduct policy |

**API**
| `docs/api/INTEGRATIONS.md` | CMMS/CRM integration guide (MaintainX, Salesforce) + webhook event reference |
| `docs/api/CHANGELOG.md` | Public API version history (v1.0–v1.4) and breaking-change policy |
| `docs/api/TELEMETRY.md` | Edge-gateway telemetry push API reference |
| `docs/api/AFX_SPEC.md` | Arc Flash Data Exchange (AFX v1) field catalog |
