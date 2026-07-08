# ServiceCycle — Engineering Handoff Guide

**Audience:** Incoming engineering lead or CTO post-acquisition  
**Classification:** Confidential / Diligence  
**Last updated:** 2026-06-25

This document tells you what you need to know on day 1 that you won't find quickly by reading the code — the non-obvious decisions, the known debt, the things that will bite you, and the roadmap context that shaped what was and wasn't built.

For the full technical reference, start with `docs/ARCHITECTURE.md`. For deploy procedures, see `docs/DEPLOY_RUNBOOK.md`.

---

## Stack in one sentence

Node 20 / Express 4 / TypeScript on the server; Prisma 5 / PostgreSQL 16 for the DB; React 18 / Vite 5 on the client; Docker Compose on a single DigitalOcean VPS (198.211.99.45); Brevo for email (transactional + inbound); a provider-configurable AI layer (Cloudflare Workers AI is the demo default; Anthropic / OpenAI / Azure OpenAI / Gemini are selectable) with a Cloudflare → HuggingFace → Groq cascade fallback.

Everything runs in one docker-compose.yml. There is no Kubernetes. That's intentional at this stage — keep it simple, keep it shippable. When volume warrants it, the natural split is server → Fly.io or DigitalOcean App Platform, DB → DigitalOcean Managed Postgres, client → Cloudflare Pages.

---

## The three things you must understand first

### 1. Tenant isolation is the most critical invariant

Every DB table that holds customer data has an `accountId` column. Every query must filter by it. Account scoping is enforced per-route: the auth layer in `server/middleware/auth.ts` resolves the caller's `accountId` and routes apply it in their `where` clauses. Direct `prisma.X.findFirst` calls without a `where.accountId` are the attack surface.

The IDOR test suite (`server/tests/idor.test.js`) was written specifically because a stale cross-account query would be catastrophic. Run it after any route changes. If you find a query that's missing `accountId`, stop and fix it before shipping.

### 2. The encryption design matters

`MASTER_KEY` (base64-encoded 32-byte key in `.env`) directly encrypts a small set of secret account settings at rest — there is no per-account key hierarchy and no decrypt-on-auth step. The `ENCRYPTED_KEYS` set in `server/routes/settings.ts` names three settings: `AI_API_KEY`, `SLACK_WEBHOOK_URL`, and `TEAMS_WEBHOOK_URL`. On write, their values are encrypted with AES-256-GCM (`server/lib/crypto.ts`: `enc.v1:` sentinel + 12-byte IV + 16-byte auth tag + ciphertext, base64-encoded) and stored in the `AccountSetting` table; on read, they are decrypted at the storage boundary so the rest of the request lifecycle handles plaintext. A secondary pattern gate also auto-encrypts any setting key ending in `_API_KEY`, `_SECRET`, `_TOKEN`, `_PASSWORD`, or `_WEBHOOK_URL`.

If you lose `MASTER_KEY`, all encrypted data is unrecoverable. There is no reset path. The key rotation runbook (`docs/KEY_ROTATION.md`) covers the dual-write window for zero-downtime rotation. The key lives only in the VPS `.env` and in your heads — it is not in the repo, not in GitHub secrets, not in the docker image.

### 3. The audit log is a hash chain

`server/lib/activityLog.ts` writes every significant action (logins, exports, role changes, API calls) to the `ActivityLog` table. Each row has a `prevHash` field — a SHA-256 hash of the previous row's content — forming a chain. This makes post-hoc log tampering detectable.

The chain is per-account. If you're doing a data migration that touches ActivityLog rows, you'll break the chain for affected accounts unless you regenerate the hashes in the correct order. Don't touch ActivityLog rows in migrations.

---

## What the codebase does well

- **Domain logic is correct.** The NFPA 70B interval calculations, arc-flash label rules, and NFPA 70E study-expiry logic have been cross-referenced against the actual standards. The arc-flash module (`server/routes/arcFlashIngest.ts`, `server/routes/v1/arcFlash.ts`, and `server/lib/arcFlashLabel.ts` / `server/lib/arcFlashLabelDoc.ts`) is the most domain-dense part of the codebase — read the comments before touching it.
- **The public API is clean.** `/api/v1` is versioned, scoped (read/write), rate-limited, idempotent-key-aware, and fully OpenAPI 3.1 documented. The API changelog (`docs/api/CHANGELOG.md`) tracks every breaking and additive change.
- **Test coverage is solid on the critical paths.** ~500 integration tests run against a real Postgres instance. Auth, IDOR, field isolation, arc-flash label generation, export, and the v1 API are all covered. The unit tests (mocked Prisma) are less comprehensive — don't rely on them for security properties.
- **CI is wired.** Every PR runs `tsc --noEmit` + `npm audit --audit-level=high` + jest (unit + integration). GitHub Actions config at `.github/workflows/ci.yml`. Dependabot opens weekly PRs for npm and GitHub Actions deps.

---

## Known debt (in priority order)

### High priority

**Single VPS.** Everything runs on one DigitalOcean droplet. The nightly Postgres backup (`pg_dump`) goes to S3. Two restore-test crons run, both in `server/lib/restoreTest.ts`: a weekly table-of-contents integrity check (`runRestoreTest`, Sundays 04:00 UTC — decrypts, gunzips, and runs `pg_restore --list` against the latest backup) and a monthly deep restore (`runDeepRestoreTest`, 1st of month 05:00 UTC — restores into a sidecar Postgres and diffs row counts). RTO ~2h, RPO ~24h. This is fine for demo/early production, but the first infrastructure investment should be DigitalOcean Managed Postgres (removes DB from the single-failure-domain) + a second compute node (removes app from it). The `docker-compose.yml` is already written to support pointing `DATABASE_URL` at an external host — it's a one-line change.

**AssetDetail.jsx is 1423 lines.** It is the longest file in the client and the most likely to cause merge conflicts and truncation bugs if edited carelessly. Use Python-splice (`python3 -c "..."`) rather than the Edit tool for surgical line replacements in this file. The pattern is documented in `memory/feedback_file_writes.md` for future reference.

**Sidebar.jsx is ~1034 lines.** Same concern. Same advice.

**Login lockout events are logged but not actively alerted.** Every failed login writes a `login_failed` (CEF severity 6) event to activityLog. When the 5th failure in a 15-minute window triggers a lockout, a `login_lockout_triggered` (CEF severity 7) event is also written — queryable from the admin Activity Log. There is no proactive email/alert to an admin when a lockout fires. Adding an email notification or SIEM webhook on `login_lockout_triggered` events is the next alerting improvement.

### Medium priority

**Data retention is enforced by cron, not missing.** `server/index.ts` registers 11 daily-or-weekly prune jobs plus an hourly demo-only prune — e.g. `activityLogPrune` (365d, daily 03:00 UTC), `notificationLogPrune` (180d, daily 03:05 UTC), `backupLogPrune` (180d, daily 03:15 UTC), `refreshTokenPrune` (30d, daily 03:20 UTC), `webhookDlqPrune` (30d, daily 03:40 UTC), `telemetryReadingPrune` (365d, daily 03:50 UTC), `extractionEventPrune` (180d, daily 03:51 UTC), `renderErrorPrune` (30d, daily 03:52 UTC), `prune-ai-usage` (90d, daily 03:55 UTC), `earlyAccessPrune` (36mo, daily 03:35 UTC), and `documentOrphanPrune` (weekly, Sunday 05:00 UTC). Full windows are tracked in `docs/compliance/DATA_RETENTION_MATRIX.md`. One real open item: `ActivityLog`'s hash-chain verifier (`lib/activityLogChain.ts`) expects an unbroken chain starting at `prevHash: null`; the 365-day prune will produce a false tamper-alert on accounts whose chain start falls outside the retention window starting ~2027-06 unless a retention-aware verifier ships first — tracked as accepted risk RAR-008 in `docs/compliance/RISK_ACCEPTANCE_LOG.md` (reconsider-by 2027-03-01).

**AI budget guard is advisory.** `server/lib/aiBudgetGuard.ts` tracks token spend against a per-account monthly cap and soft-blocks when the cap is hit. It does not enforce hard limits at the infrastructure level. If Anthropic bills spike, the guard will log warnings but won't stop inference until the next request after it detects the breach.

**Demo reseed runs from a terminal (or the ops MCP).** The seed scripts are `server/scripts/seed-standards.js` then `server/scripts/seed-demo.js`, run via `docker compose exec server …` (see DEPLOY_RUNBOOK §6). They are intentionally not wired to a user-facing API endpoint. The VPS ops MCP exposes a `reseed_demo` tool that runs them on the droplet without a manual SSH session, so an authorized operator can refresh the live demo without one specific person's terminal.

### Low priority / deferred by design

**SSO is shipped dark.** Ory Polis OIDC/SAML is wired behind the `SSO_ENABLED` env flag, with user provisioning/deprovisioning from the IdP handled by Polis's SCIM implementation pushing events to our inbound webhook consumer (`server/routes/ssoScim.ts`) — not a SCIM v2 resource server we expose ourselves. It works; it just isn't exposed in the UI by default. To enable: set `SSO_ENABLED=true` in `.env` and restart. No code changes needed.

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

AI-assisted features use a provider-configurable layer (`AI_PROVIDER`, default `cloudflare` on the demo; `anthropic` / `openai` / `azure_openai` / `gemini` selectable). For the `ask` / `classify` tasks on the Cloudflare provider there is a three-tier cascade: Cloudflare Workers AI → HuggingFace → Groq (every other provider/task is a single-element chain). The logic is in `server/lib/ai.ts` (the per-provider adapters live under `server/lib/aiProviders/`). Customers can also bring their own API key (`BYO_AI` feature).

The cascade is gated by `AI_ENABLED` env var (set to `"false"` to run in fully deterministic mode — useful for testing). `aiBudgetGuard.ts` tracks spend against the `accountSetting.aiMonthlyBudgetUsd` field.

AI is used for: document ingest (PDF gap-fill), arc-flash study import (IEEE 1584 field extraction), nameplate OCR post-processing, equipment name normalization, and the monthly compliance digest email. None of these AI steps are in the critical path — if the AI call fails, the feature degrades gracefully to the deterministic result.

---

## The demo environment

`servicecycle.app` is the live demo, gated behind basic auth. The demo data is seeded from `server/scripts/seed-demo.js` (with `server/scripts/seed-arcflash-trend-demo.js` for the arc-flash trend) — deterministic seed scripts that populate realistic equipment records, arc-flash studies, deficiencies, work orders, and telemetry data for a plausible mid-sized industrial facility. The seed is designed to make every dashboard tell a compelling story (compliance gaps, overdue items, procurement risk flags, arc-flash label currency issues).

`DEMO_MODE` env var, when set, enables small UI affordances that make the demo smoother (e.g. the demo scan meter). Do not ship DEMO_MODE behavior to a production multi-tenant deployment — it relaxes some guard rails.

The demo punch list is at `docs/DEMO_FIXES.md`. As of the last session, all items in that list are implemented.

---

## Day-1 checklist for a new engineering lead

- [ ] Read `docs/ARCHITECTURE.md` — full stack diagram, data model, security architecture
- [ ] Read `docs/DEPLOY_RUNBOOK.md` — understand the deploy pipeline before you touch it
- [ ] Run `docker compose up -d` locally with the `.env.example` values — confirm the full stack boots
- [ ] Run `npm test` in `server/` — confirm all ~500 tests pass on your machine
- [ ] Read `server/middleware/auth.ts` — understand how per-route `accountId` scoping (tenant isolation) is enforced
- [ ] Read `server/lib/arcFlashLabel.ts` / `server/lib/arcFlashLabelDoc.ts` and their comments — the most domain-dense code in the repo
- [ ] Review the open items in `docs/RISK_REGISTER.md` — R-03 (managed DB) is the first infrastructure investment to plan
- [ ] Confirm `MASTER_KEY` is stored securely outside the repo and the VPS (key management is your first security task)
- [ ] Set up Dependabot review process — PRs open weekly, don't let them pile up
- [ ] Configure Better Stack heartbeat monitor on `/api/health` — takes 30 minutes, closes the last open SOC2 gap (A1.2)

---

## Who to call if things break

The engineering function has been a single founding engineer to date — a bus-factor-of-one that an acquirer should close early by designating a primary maintainer plus a backup operator and moving all infrastructure credentials into a shared secret manager (see the operator-continuity note in `docs/INCIDENT_RESPONSE.md`). Post-acquisition, the intent is a clean handoff — the docs, tests, and runbooks are the knowledge transfer. If you need context on a specific design decision, the session notes in `docs/sessions/` record the reasoning behind major features as they were built.

For security incidents: `docs/INCIDENT_RESPONSE.md`. For key rotation: `docs/KEY_ROTATION.md`. For rollback after a bad deploy: `docs/DEPLOY_RUNBOOK.md` §Rollback.
