# ServiceCycle — Pre-Production Security & Hardening Audit

**Date:** 2026-06-09  **Scope:** `server/` (Node/Express/TypeScript, 152 TS files, 55 Prisma models)
**Method:** 36 automated checks across 9 sections. Only failures and warnings are listed below; ~30 checks passed cleanly and are summarized at the end.

## Headline

**No CRITICAL or HIGH findings.** Multi-tenancy isolation, auth hardening, secrets management, CORS/CSP/rate-limiting, body limits, DB timeouts, and the dependency tree are all in good shape for launch. `tsc --noEmit` compiles clean (exit 0) and `npm audit` reports **zero high/critical** CVEs. The items below are MEDIUM/LOW hardening opportunities and one deployment footgun to be aware of before any horizontal scaling.

---

## MEDIUM

### M1 — Cron jobs have no cross-instance guard (latent duplicate-execution risk)
**Files:** `server/index.ts:1294` (`runOnce`), cron registrations `index.ts:1422`–`2053` (30+ jobs)
**Status:** Not an active bug at current single-container topology; becomes a real bug the moment the app is scaled.

`runOnce()`/`runOnceQuiet()` only guard against a job overlapping *itself within one process* (in-memory `_cronInFlight` map). There is **no** `NODE_APP_INSTANCE` check or Postgres advisory lock gating cron registration. Today the app ships as a single `tsx` process in one container (`docker-compose.yml` `server:` service, no `replicas`, no PM2 cluster), so each job fires once — fine. But if you ever set PM2 `instances > 1`, scale the compose service, or run a second replica on the new demo droplet, **every cron fires on every instance**: double `pg_dump` backups, double prune deletes, double digest emails, double webhook retries.

**Risk:** Duplicate execution of all 30+ scheduled jobs if the process count ever exceeds 1.
**Fix:** Wrap cron registration in a single-instance guard before scaling. Cheapest option using the existing PG advisory-lock pattern already in `lib/aiQuota.ts:316`:
```ts
// before cron.schedule(...) block
const gotCronLock = await prisma.$queryRaw<{ locked: boolean }[]>`
  SELECT pg_try_advisory_lock(hashtext('servicecycle:cron')) AS locked`;
if (!gotCronLock[0]?.locked) {
  console.log('[Cron] another instance holds the scheduler lock — skipping registration');
} else {
  /* existing cron.schedule(...) calls */
}
```
Or, simpler for PM2 cluster mode: `if (process.env.NODE_APP_INSTANCE === '0') { /* register crons */ }`.

---

## LOW / INFO

### L1 — `$queryRawUnsafe` used where a tagged template would do (defense-in-depth)
**Files:** `server/routes/admin.ts:280, 288, 296, 306, 331, 378, 389`
All 7 calls use **fully static SQL string literals with zero interpolation** and sit behind `requireAdmin`, so there is **no injection risk today**. But `$queryRawUnsafe` defeats Prisma's parameterization safety net — a future edit that drops a variable into one of these strings would be silently injectable.
**Fix:** Convert to tagged-template `prisma.$queryRaw\`...\`` (no parameters needed since they're static). Removes the footgun and passes a stricter lint rule.

### L2 — JWT has no `jti` claim (no per-token revocation)
**Files:** `server/lib/jwtSecrets.ts:88` (sign), `server/middleware/auth.ts:66` (verify)
Access tokens carry no `jti`, so an individual leaked access token can't be revoked before it expires. **Mitigated** by short token TTL (`JWT_EXPIRES_IN` default 1h, startup refuses >24h) and DB-backed refresh-token revocation (`refreshToken` table, reuse-detection at `auth.ts:620/665`). Acceptable for launch; add `jti` only if you need instant access-token kill.

### L3 — Dead "magic-byte sniffer" in document uploads (misleading defense-in-depth)
**Files:** `server/routes/documents.ts:86` (`looksLikeDeclaredType`), `:60` (`isAllowedUploadMime`), `:49` (`DENIED_IMAGE_MIME`)
`looksLikeDeclaredType()` and the MIME allow/deny lists are **defined but never called** (the `fileFilter` at `:71` returns `cb(null, true)` for everything). The surrounding comments claim a second-line magic-byte defense "even if a forged Content-Type slips past" — that defense is not actually wired in. **This is not a vulnerability:** the real protection is correct and present — every stored file is served as `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` + `Cache-Control: private, no-store` (`documents.ts:211–214`), so nothing renders inline in-origin.
**Fix:** Either delete the dead functions, or wire `looksLikeDeclaredType(req.file.buffer, req.file.mimetype)` into the upload handler if you want true defense-in-depth. At minimum, correct the misleading comments.

### L4 — `downloadFile()` lacks an explicit path-traversal belt-and-suspenders check
**File:** `server/lib/storage.ts:129` (`path.join(getLocalPath(), key)`)
The `/api/documents/file?key=` route is **already safe**: `key` must match an existing `Document.filePath` row scoped to `accountId` (`documents.ts:184–194`) before `downloadFile(key)` is reached, so an attacker-supplied `key=../../etc/passwd` returns 404. Storage keys are also sanitized at write time (`storage.ts:76`). Still, a cheap explicit guard prevents any future caller from reaching `downloadFile` without the DB gate.
**Fix:**
```ts
const abs = path.resolve(getLocalPath(), key);
if (!abs.startsWith(getLocalPath() + path.sep)) throw new Error('path traversal blocked');
```

### L5 — `RenderError` model has `accountId` but no index on it (perf only)
**File:** `server/prisma/schema.prisma` (model `RenderError`)
Every other tenant-scoped model (41/55) carries an `accountId` index; `RenderError` doesn't. It's an admin-facing error-telemetry table, so this is a query-performance nit, not an isolation issue. Will get slow once the table grows.
**Fix:** add `@@index([accountId, createdAt])` and a migration.

### L6 — `lock_timeout` not set (statement/idle timeouts are)
**File:** `docker-compose.yml:104–106`
Postgres is correctly started with `statement_timeout=30s` and `idle_in_transaction_session_timeout=60s` (good — covers the main runaway-query and held-transaction risks). `lock_timeout` is not set, so a statement *waiting on a lock* can block up to the 30s statement cap.
**Fix (optional):** add `-c lock_timeout=10s` to the postgres `command:` args.

### L7 — Two MODERATE npm advisories (no high/critical)
**Dependency:** `uuid <11.1.1` pulled transitively via `exceljs` (GHSA-w5hq-g745-h8pq, "missing buffer bounds check when `buf` is provided").
exceljs does not pass attacker-controlled `buf` into uuid, so this is not exploitable in this app. The only fix is `npm audit fix --force`, which downgrades exceljs to 3.4.0 (breaking). **Recommend deferring** — re-check when exceljs ships a patched uuid.

### INFO — Workspace mount serves stale/truncated files (tooling caveat, not a code issue)
During this audit the Linux workspace mount returned **truncated** copies of several source files (e.g. `lib/partnerDigest.ts`, `routes/disasterEvents.ts`, `__tests__/routes/partnerInvites.test.ts` had trailing NUL bytes), which produced ~45 spurious `tsc` syntax errors. Cross-checking the same files via the Windows host showed them **complete and correct**, and `tsc --noEmit` run on the Windows host exits **0**. Treat Linux-mount reads of this repo as potentially stale; verify builds/tests through windows-shell.

---

## Passing checks (no action needed)

- **Multi-tenancy (S1):** `accountId` is always server-derived (`req.user.accountId` / `req.apiKeyAccountId`), never trusted from request input. All tenant list endpoints scope by `accountId`; child-table writes (`assetTemplateTask`, `contractorTech`, `customFieldValue`) are gated by an account-scoped parent lookup first. OEM fleet endpoints scope by `partnerOrgId` behind `requireOemAdmin`. No `$executeRawUnsafe`; all `$queryRaw`/`$executeRaw` are parameterized tagged templates.
- **Auth/session (S2):** `trust proxy` configurable (safe default), JWT pinned to `HS256`, startup refuses weak/short/over-long secrets, no hardcoded secrets, no `secure:false`/`sameSite:none`, refresh-token reuse detection, graceful `SIGTERM`/`SIGINT` shutdown closing both HTTP server and Prisma. No network/email side-effects inside `$transaction` blocks.
- **Uploads (S4):** all 6 multer instances use memory storage with `fileSize` limits + `files:1`; `originalname` only used for extension regex + DB metadata, never as an fs path.
- **Logging (S5):** no passwords/tokens/secrets/headers/cookies logged; no `.env` reads outside dotenv.
- **Config (S6):** `.env` git-ignored and untracked; `helmet` active with `noSniff`; CORS is an allowlist (not `*`) with credentialed echo; `express.json({ limit: '200kb' })`; global `/api/` rate limiter plus dedicated `credentialLimiter`/`registrationLimiter`/`totpLimiter`/`apiKeyLimiter`.
- **Database (S7):** 41/55 models carry `accountId` + composite index; soft-delete via `archivedAt` is filtered (`archivedAt: null`) in list queries; pool sized (`connection_limit=10`, `pool_timeout=30`); statement/idle timeouts enforced server-side.
- **Compile (S8):** `tsc --noEmit` → exit 0 on the Windows host.
- **Dependencies (S9):** zero high/critical CVEs.
