# PR: Enterprise SSO (OIDC + SAML) + SCIM via self-hosted Ory Polis

**Branch:** `feature/sso-polis` → **do NOT merge to main / do NOT deploy from CI.**
Dustin runs the MCP deploy loop after review.

## What this adds

Business customers can sign in with their corporate IdP (Okta, Entra ID, Google
Workspace, Ping, JumpCloud), multi-tenant, with automatic user provisioning /
deprovisioning (SCIM). ServiceCycle is the OAuth 2.1 relying party; **Ory Polis**
(Apache-2.0, `boxyhq/jackson:26.2.0`) is the broker, run as a **separate
container** on our existing Postgres. Our JWT stays the only session credential.

Ships **dark**: gated per-account behind the new `sso` AccountSetting feature
flag (default OFF), like `arc_flash_studies`.

Full design + threat model: [`SSO_DESIGN.md`](./SSO_DESIGN.md).

## Changes (small, attributable commits)

1. `docs(sso)` — design doc + **live-verified Polis API fixtures** (`server/__tests__/fixtures/polis/`).
2. `feat(sso)` — additive Prisma schema + hand-written migration (`20260620130000_sso_polis`).
3. `feat(sso)` — fail-closed `ssoConfig` + `sso` feature flag + startup env validation.
4. `feat(sso)` — Polis client, id-token/PKCE/role-map/SCIM libs (+ `jose`, MIT).
5. `feat(sso)` — authorize / callback / exchange routes + SCIM webhook consumer.
6. `feat(sso)` — per-account admin config routes + break-glass login enforcement.
7. `feat(sso)` — client: SSO login, callback handoff, admin settings page.
8. `test(sso)` — unit (id-token/PKCE/role-map/SCIM/config) + integration suites.
9. `chore(sso)` — Polis compose overlay, license scan, attribution, this PR doc.

## Security properties (see threat model §7)

- **Cross-tenant isolation**: email domain → exactly one account (`SsoDomain`
  global-unique); callback asserts `userinfo.requested.tenant` == the connection's
  tenant AND that the identity doesn't already belong to another account; SCIM
  never mutates a user outside the directory's account.
- **CSRF/replay**: single-use `state` (atomic claim) + TTL; PKCE S256 (verifier
  server-side only); id_token alg pinned (no `none`/HS*), JWKS-verified, nonce-bound.
- **No tokens in URLs**: 60s single-use handoff code; the JWT is minted at exchange.
- **SCIM**: HMAC (`BoxyHQ-Signature`) verified over the **raw** body (fail closed) +
  replay window; idempotent upsert-on-externalId + dedupe ledger; deactivation
  (incl. `user.updated active:false`) bumps `tokenEpoch` to kill live sessions.
- **No privilege escalation**: claims map only to `viewer|consultant|manager`;
  `admin/oem_admin/super_admin` are never claim-granted.
- **Break-glass**: `sso.required` blocks password login except a local
  (non-SSO-managed) admin; a last-password-admin guard blocks enabling it
  otherwise; break-glass logins are audit-logged.
- **Fail closed**: `SSO_ENABLED=true` with any missing Polis/SCIM secret refuses
  to boot; `getSsoConfig()` never returns a partial config.

## Gate status (run after each step)

- `tsc --noEmit` (server): **green** (incl. integration test type-check).
- `vite build` (client): **green**.
- `jest` unit project: **green** — 20 suites / 217 tests pass (the 12 failing
  suites are PRE-EXISTING in a fresh worktree: they hit a live server on
  `:3001` which isn't running here — unrelated to this change).
- `jest` integration project (`__tests__`): requires a migrated DB (see below);
  type-checked by `tsc`. Authored to run in CI / the deploy DB env.

## Polis API-shape verification (spec gate)

Polis `v26.2.0` was run **locally as a plain Node process — no Docker, no
droplet** (`npm run pre-loaded`, mem DB + Mock SAML) and real responses captured
as committed fixtures. SCIM webhook payloads are live-captured **and the HMAC
signature was re-computed and matches**; OAuth `/authorize`→IdP redirect is
live-verified; token/userinfo shapes are source-verified from
`npm/src/controller/oauth.ts` (live JSON capture blocked by mocksaml.com's hosted
IdP 500-ing on headless form submit — their bug, not Polis). Details + fixture
provenance: `SSO_DESIGN.md` §11 + `server/__tests__/fixtures/polis/README.md`.

## How to review

1. Read `SSO_DESIGN.md` (architecture, data model, 4 resolved open questions,
   threat model) + `POLIS_ATTRIBUTION.md` (license).
2. Migration `server/prisma/migrations/20260620130000_sso_polis/migration.sql` is
   additive only (1 enum, 7 tables, 4 nullable `users` columns + 1 unique index);
   names + FK cascade match `prisma migrate diff` output exactly (zero drift).
3. Compose overlay `docker-compose.polis.yml` is an **addition** — the prod
   `docker-compose.yml` is untouched.

### Run the full test suite locally (needs Postgres)

```bash
# server/.env must have DATABASE_URL (a migrated DB) + JWT_SECRET + MASTER_KEY.
cd server
npx prisma migrate deploy           # applies the additive SSO migration
# integration tests set their own SSO_* + ACCOUNT_FEATURE_SSO env at file top
npx jest                            # runs unit + integration; tee to a file (see note)
```
Suite note (from the spec): the full run can make the shell wrapper report a
teardown `ETIMEDOUT` even on success — tee to a file and read the file; kill
leftover node procs.

## How to deploy (Dustin — MCP loop, post-review)

1. Add the new keys to the **repo-root `.env`** (placeholders documented in
   `server/.env.example` + `docker-compose.polis.yml` header):
   `SSO_ENABLED=true`, `POLIS_BASE_URL=http://polis:5225`, `POLIS_EXTERNAL_URL`,
   `POLIS_API_KEY`, `SCIM_WEBHOOK_SECRET`, `SSO_CALLBACK_URL`, `POLIS_DB`,
   `POLIS_DB_ENCRYPTION_KEY`, `POLIS_NEXTAUTH_SECRET`, and (recommended)
   `OPENID_RSA_PRIVATE_KEY` / `OPENID_RSA_PUBLIC_KEY`.
2. Apply the migration (the existing `server-migrate` init container runs
   `prisma migrate deploy` on `up`).
3. Bring up the stack WITH the overlay:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.polis.yml up -d --build
   ```
4. Flip the `sso` feature flag for the pilot account (env
   `ACCOUNT_FEATURE_SSO=true` globally, or the per-account `feature.sso`
   AccountSetting), then configure the IdP at **Settings → Security → Configure
   SSO & SCIM**.
5. Confirm `GET /api/health` and that the public reverse proxy exposes only
   Polis `/api/oauth/*` and `/api/scim/*` (keep the admin API internal).

## Known follow-ups (non-blocking)

- Capture a live `/oauth/token` + `/oauth/userinfo` fixture against a real IdP (or
  a browser-driven Mock SAML login) to replace the source-verified token/userinfo
  fixture. Parser already follows the exact source types.
- Optionally tighten id_token `aud` enforcement once a real id_token's audience
  shape is confirmed (currently iss/exp/sig/alg/nonce are enforced; aud is
  enforced only when an expected value is supplied).
