# Contributing to ServiceCycle

This guide covers local setup, the test/deploy workflow, and the three things to understand before touching the codebase.

## Running locally

1. Copy `.env.example` to `.env` and fill in the required variables. The critical ones are `DATABASE_URL`, `MASTER_KEY` (a base64-encoded 32-byte random key — generate with `openssl rand -base64 32`), and `JWT_SECRET`. Leave AI keys blank to run in deterministic mode.
2. Start the stack: `docker compose up -d`
3. Apply the schema: `cd server && npm run migrate`
4. Start both servers in separate terminals:
   ```bash
   # Terminal 1 — API server (port 3001)
   cd server && npm run dev

   # Terminal 2 — Vite dev server (port 5173)
   cd client && npm run dev
   ```
5. Visit http://localhost:5173
6. Seed demo data: `cd server && npm run reseed` — this requires a direct terminal session. It cannot be triggered via the API.

## Running tests

```bash
cd server
npm test                  # full suite (~500 integration tests against real Postgres)
tsc --noEmit              # type-check only
npm run test:idor         # cross-account isolation suite specifically
```

Tests run against a real Postgres instance started by `docker compose up -d`. There is no mocked DB layer in the integration suite — that's intentional. CI runs `tsc --noEmit` + `npm audit --audit-level=high` + jest on every PR (see `.github/workflows/ci.yml`).

## Architecture

**Stack and deployment.** Node 20 / Express 4 / TypeScript on the server; Prisma 5 / PostgreSQL 16 for the database; React 18 / Vite 5 on the client. Everything runs in one `docker-compose.yml` on a single DigitalOcean VPS. The natural future split is server → DigitalOcean App Platform, database → Managed Postgres, client → Cloudflare Pages. There is no Kubernetes today — that's intentional. The full stack diagram is in `docs/ARCHITECTURE.md`.

**Security model.** The platform is multi-tenant. Every table holding customer data has an `accountId` column. `server/middleware/multiTenantMiddleware.ts` enforces tenant isolation automatically on most Prisma reads, but any direct `prisma.X.findFirst` call without `where.accountId` is an attack surface. Field-level encryption uses AES-256-GCM with a per-account key hierarchy: `MASTER_KEY` (in `.env`) decrypts per-account `ENCRYPTED_KEYS` stored in the database. Those account keys are used for field encryption. If `MASTER_KEY` is lost, all encrypted data is unrecoverable — there is no reset path.

**Audit log.** `server/lib/activityLog.ts` writes every significant action (logins, exports, role changes, API calls) to the `ActivityLog` table. Each row contains a `prevHash` field — a SHA-256 hash of the previous row's content — forming a hash chain that makes post-hoc log tampering detectable. The chain is per-account. Do not update or delete `ActivityLog` rows in migrations; that breaks the chain for affected accounts.

## The three things to understand first

### 1. Tenant isolation is the most critical invariant

Every DB table that holds customer data has an `accountId` column. Every query must filter by it. The Prisma middleware in `server/middleware/multiTenantMiddleware.ts` enforces this automatically on most read operations, but direct `prisma.X.findFirst` calls without a `where.accountId` are the attack surface.

The IDOR test suite (`server/tests/idor.test.js`) was written specifically because a stale cross-account query would be catastrophic. Run it after any route changes. If you find a query that's missing `accountId`, stop and fix it before shipping.

### 2. The encryption key hierarchy matters

`MASTER_KEY` (base64-encoded 32-byte key in `.env`) encrypts per-account `ENCRYPTED_KEYS`. Those encrypted keys are stored in the DB. When a user authenticates, their account key is decrypted in memory and used for field-level AES-256-GCM encryption on sensitive columns.

If you lose `MASTER_KEY`, all encrypted data is unrecoverable. There is no reset path. The key rotation runbook (`docs/KEY_ROTATION.md`) covers the dual-write window for zero-downtime rotation. The key lives only in the VPS `.env` — it is not in the repo, not in GitHub secrets, not in the Docker image.

### 3. The audit log is a hash chain

`server/lib/activityLog.ts` writes every significant action (logins, exports, role changes, API calls) to the `ActivityLog` table. Each row has a `prevHash` field — a SHA-256 hash of the previous row's content — forming a chain. This makes post-hoc log tampering detectable.

The chain is per-account. If you're doing a data migration that touches ActivityLog rows, you'll break the chain for affected accounts unless you regenerate the hashes in the correct order. Don't touch ActivityLog rows in migrations.

## Before you open a PR

Review the `.github/pull_request_template.md` — it includes the full impact checklist. For changes that touch auth, schema, security middleware, billing, or external integrations, also review `docs/CHANGE_REVIEW_CHECKLIST.md`.

The short version: any route change needs an IDOR test pass; any schema change needs `accountId` on new tables; any new external service needs to be added to the sub-processor list in `docs/OFFBOARDING.md`.

## Deploying

See `docs/DEPLOY_RUNBOOK.md` for the authoritative procedure. The short path:

1. Merge to `main`
2. On the VPS: `git pull`
3. Rebuild the client: `npm run deploy:client` (from the repo root)
4. Health check: `curl https://servicecycle.app/api/health`

Do not run `docker compose down` unless you are prepared for a full restart, including a `prisma migrate deploy` before the container comes back up. The DB container goes down with it.

## Known large files

Two files will cause silent truncation bugs if edited with standard "replace all" operations near end-of-file:

- `client/src/pages/AssetDetail.jsx` — 1423 lines
- `client/src/components/Sidebar.jsx` — ~1034 lines

Use targeted edits or a Python splice for surgical changes to either file.
