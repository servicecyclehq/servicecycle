# ServiceCycle — Engineering Handoff Guide

**Audience:** Incoming engineering lead or CTO post-acquisition  
**Classification:** Confidential / Diligence  
**Last updated:** 2026-06-25

This document tells you what you need to know on day 1 that you won't find quickly by reading the code — the non-obvious decisions, the known debt, the things that will bite you, and the roadmap context that shaped what was and wasn't built.

For the full technical reference, start with `docs/ARCHITECTURE.md`. For deploy procedures, see `docs/DEPLOY_RUNBOOK.md`.

---

## Stack in one sentence

Node 20 / Express 4 / TypeScript on the server; Prisma 5 / PostgreSQL 16 for the DB; React 18 / Vite 5 on the client; Docker Compose on a single DigitalOcean VPS (198.211.99.45); Resend for email; Anthropic Claude + Gemini + Groq in a cascade for AI.

Everything runs in one docker-compose.yml. There is no Kubernetes. That's intentional at this stage — keep it simple, keep it shippable. When volume warrants it, the natural split is server → Fly.io or DigitalOcean App Platform, DB → DigitalOcean Managed Postgres, client → Cloudflare Pages.

---

## The three things you must understand first

### 1. Tenant isolation is the most critical invariant

Every DB table that holds customer data has an `accountId` column. Every query must filter by it. The Prisma middleware in `server/middleware/multiTenantMiddleware.ts` enforces this automatically on most read operations, but direct `prisma.X.findFirst` calls without a `where.accountId` are the attack surface.

The IDOR test suite (`server/tests/idor.test.js`) was written specifically because a stale cross-account query would be catastrophic. Run it after any route changes. If you find a query that's missing `accountId`, stop and fix it before shipping.

### 2. The encryption key hierarchy matters

`MASTER_KEY` (base64-encoded 32-byte key in `.env`) encrypts per-account `ENCRYPTED_KEYS`. Those encrypted keys are stored in the DB. When a user authenticates, their account key is decrypted in memory and used for field-level AES-256-GCM encryption on sensitive columns.

If you lose `MASTER_KEY`, all encrypted data is unrecoverable. There is no reset path. The key rotation runbook (`docs/KEY_ROTATION.md`) covers the dual-write window for zero-downtime rotation. The key lives only in the VPS `.env` and in your heads — it is not in the repo, not in GitHub secrets, not in the docker image.

### 3. The audit log is a hash chain

`server/lib/activityLog.ts` writes every significant action (logins, exports, role changes, API calls) to the `ActivityLog` table. Each row has a `prevHash` field — a SHA-256 hash of the previous row's content — forming a chain. This makes post-hoc log tampering detectable.

The chain is per-account. If you're doing a data migration that touches ActivityLog rows, you'll break the chain for affected accounts unless you regenerate the hashes in the correct order. Don't touch ActivityLog rows in migrations.

---

## What the codebase does well

- **Domain logic is correct.** The NFPA 70B interval calculations, arc-flash label rules, and NFPA 70E study-expiry logic have been cross-referenced against the actual standards. The arc-flash module (`server/routes/arcFlash.ts`, `server/lib/arcFlashLabels.ts`) is the most domain-dense part of the codebase — read the comments before touching it.
- **The public API is clean.** `/api/v1` is versioned, scoped (read/write), rate-limited, idempotent-key-aware, and fully OpenAPI 3.1 documented. The API changelog (`docs/api/CHANGELOG.md`) tracks every breaking and additive change.
- **Test coverage is solid on the critical paths.** ~500 integration tests run against a real Postgres instance. Auth, IDOR, field isolation, arc-flash label generation, export, and the v1 API are all covered. The unit tests (mocked Prisma) are less comprehensive — don't rely on them for security properties.
- **CI is wired.** Every PR runs `tsc --noEmit` + `npm audit --audit-level=high` + jest (unit + integration). GitHub Actions config at `.github/workflows/ci.yml`. Dependabot opens weekly PRs for npm and GitHub Actions deps.

---

## Known debt (in priority order)

### High priority

**Single VPS.** Everything runs on one DigitalOcean droplet. The nightly Postgres backup (`pg_dump`) goes to S3, and a restore test runs weekly. RTO ~2h, RPO ~24h. This is fine for demo/early production, but the first infrastructure investment should be DigitalOcean Managed Postgres (removes DB from the single-failure-domain) + a second compute node (removes app from it). The `docker-compose.yml` is already written to support pointing `DATABASE_URL` at an external host — it's a one-line change.

**AssetDetail.jsx is 1423 lines.** It is the longest file in the client and the most likely to cause merge conflicts and truncation bugs if edited carelessly. Use Python-splice (`python3 -c "..."`) rather than the Edit tool for surgical line replacements in this file. The pattern is documented in `memory/feedback_file_writes.md` for future reference.

**Sidebar.jsx is ~1034 lines.** Same concern. Same advice.

**Login lockout events are logged but not actively alerted.** Every failed login writes a `login_failed` (CEF severity 6) event to activityLog. When the 5th failure in a 15-minute window triggers a lockout, a `login_lockout_triggered` (CEF severity 7) event is also written — queryable from the admin Activity Log. There is no proactive email/alert to an admin when a lockout fires. Adding an email notification or SIEM webhook on `login_lockout_triggered` events is the next alerting improvement.

### Medium priority

**Data retention.** There is no scheduled prune job. ActivityLog, TelemetryReading, and DigestLog will grow unboundedly. The data model has soft-delete patterns in places but no time-based expiry. Decide retention windows (suggested: ActivityLog 2y, TelemetryReading 1y, DigestLog 6mo) and add a nightly `DELETE WHERE createdAt < now() - interval` job.

**AI budget guard is advisory.** `server/lib/aiBudgetGuard.ts` tracks token spend against a per-account monthly cap and soft-blocks when the cap is hit. It does not enforce hard limits at the infrastructure level. If Anthropic bills spike, the guard will log warnings but won't stop inference until the next request after it detects the breach.

**The reseed script requires a terminal.** `server/prisma/reseed.ts` must be run locally or via a terminal session on the VPS. It is not wired to any API endpoint (intentionally, for security). You cannot trigger it from the admin UI.

### Low priority / deferred by design

**SSO is shipped dark.** Ory Polis OIDC/SAML/SCIM is wired behind the `SSO_ENABLED` env flag. It works; it just isn't exposed in the UI by default. To enable: set `SSO_ENABLED=true` in `.env` and restart. No code changes needed.

**Multi-OpCo / EnterpriseGroup.** The DB schema, RBAC (`group_admin` role), and API routes for HoldCo/OpCo rollups are complete. The client-side EnterpriseGroup management UI is present but minimal. This is intentional — the feature exists for diligence but isn't the demo focus.

**OEM fleet view (PartnerOrganization).** Same status as EnterpriseGroup. Schema + routes exist; UI is minimal. The design doc (`docs/research/2026-06-20-oem-atlas-cross-tenant-design.md`) describes the funded upside path.

---

## What's intentionally NOT built

These are parked, not forgotten. Don't rebuild them without reading why:

- **Predictive RUL modeling** — the telemetry ingestion and condition history are live; the ML scoring is the next layer. Deferred because it requires a non-trivial data volume to calibrate. The schema is ready for it.
- **Automated NETA-format report generation** — turn the asset record *back into* a PDF report. High contractor value. Deferred because PDF generation at that fidelity is a multi-week build.
- **Marketplace / contractor finder** — facility → contractor lead routing. Makes most sense post-acquisition when the contractor book of business is real.
- **Role-on-assignment** — auto-apply a role change when a user is assigned to a work order. The WO assignment UI is live; the role side-effect is deferred.
- **Cloudflare Email Routing** — `support@`, `sales@`, `security@` aliases route via Cloudflare to the main inbox. Wired in DNS but not yet enabled in the Cloudflare dashboard. 15-minute task.

---

## The AI cascade

AI-assisted features use a three-tier cascade: Anthropic Claude (primary) → Google Gemini (fallback) → Groq (fast fallback for latency-sensitive paths). The cascade logic is in `server/lib/aiCascade.ts`. Customers can also bring their own API key (`BYO_AI` feature).

The cascade is gated by `AI_ENABLED` env var (set to `"false"` to run in fully deterministic mode — useful for testing). `aiBudgetGuard.ts` tracks spend against the `accountSetting.aiMonthlyBudgetUsd` field.

AI is used for: document ingest (PDF gap-fill), arc-flash study import (IEEE 1584 field extraction), nameplate OCR post-processing, equipment name normalization, and the monthly compliance digest email. None of these AI steps are in the critical path — if the AI call fails, the feature degrades gracefully to the deterministic result.

---

## The demo environment

`servicecycle.app` is the live demo, gated behind basic auth. The demo data is seeded from `server/prisma/reseed.ts` — a deterministic reseed script that populates realistic equipment records, arc-flash studies, deficiencies, work orders, and telemetry data for a plausible mid-sized industrial facility. The seed is designed to make every dashboard tell a compelling story (compliance gaps, overdue items, procurement risk flags, arc-flash label currency issues).

`DEMO_MODE` env var, when set, enables small UI affordances that make the demo smoother (e.g. the demo scan meter). Do not ship DEMO_MODE behavior to a production multi-tenant deployment — it relaxes some guard rails.

The demo punch list is at `docs/DEMO_FIXES.md`. As of the last session, all items in that list are implemented.

---

## Day-1 checklist for a new engineering lead

- [ ] Read `docs/ARCHITECTURE.md` — full stack diagram, data model, security architecture
- [ ] Read `docs/DEPLOY_RUNBOOK.md` — understand the deploy pipeline before you touch it
- [ ] Run `docker compose up -d` locally with the `.env.example` values — confirm the full stack boots
- [ ] Run `npm test` in `server/` — confirm all ~500 tests pass on your machine
- [ ] Read `server/middleware/multiTenantMiddleware.ts` — understand the tenant isolation layer
- [ ] Read `server/lib/arcFlashLabels.ts` and its comments — the most domain-dense code in the repo
- [ ] Review the open items in `docs/RISK_REGISTER.md` — R-03 (managed DB) is the first infrastructure investment to plan
- [ ] Confirm `MASTER_KEY` is stored securely outside the repo and the VPS (key management is your first security task)
- [ ] Set up Dependabot review process — PRs open weekly, don't let them pile up
- [ ] Configure Better Stack heartbeat monitor on `/api/health` — takes 30 minutes, closes the last open SOC2 gap (A1.2)

---

## Who to call if things break

There is currently one engineer (the founding engineer). Post-acquisition, the intent is a clean handoff — the docs, tests, and runbooks are the knowledge transfer. If you need context on a specific design decision, the session notes in `docs/sessions/` record the reasoning behind major features as they were built.

For security incidents: `docs/INCIDENT_RESPONSE.md`. For key rotation: `docs/KEY_ROTATION.md`. For rollback after a bad deploy: `docs/DEPLOY_RUNBOOK.md` §Rollback.
