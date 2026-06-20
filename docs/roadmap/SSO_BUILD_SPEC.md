# SSO Build Spec — for Claude Code (branch: `feature/sso-polis`)
_Authored 2026-06-20 by the Cowork planning session. This is the contract for the SSO build. Read it fully before writing code. Surface open questions in the design doc rather than guessing._

## Goal
Add **enterprise SSO (OIDC + SAML) + SCIM directory sync** to ServiceCycle so business customers sign in with their corporate IdP (Okta, Microsoft Entra ID, Google Workspace, Ping, JumpCloud), multi-tenant, with automatic user provisioning/deprovisioning. This unlocks enterprise deals and is an acquisition-diligence checkbox.

## Foundation (decided — do not re-litigate)
- **Self-host Ory Polis** (formerly BoxyHQ "SAML Jackson"), **Apache-2.0** (verified 2026-06-20 from repo LICENSE + package.json v26.2.0). Polis brokers SAML/OIDC IdPs behind ONE OAuth 2.0 flow and provides SCIM 2.0 Directory Sync.
- Run Polis as a **separate container** backed by our existing **PostgreSQL** (it supports Postgres natively). ServiceCycle is the OAuth **relying party**; Polis is the broker.
- **OIDC-first**; add SAML for legacy IdPs that can't do OIDC. 2026 baseline: **OAuth 2.1 — Authorization Code + PKCE (S256)**, strict `state` + `nonce`, full ID-token validation (guard alg-confusion + PKCE-downgrade), short-lived tokens.
- **Library note:** Polis already pins `openid-client` 6.8.4 (panva, MIT). If any raw SAML work is needed outside Polis, use the scoped `@node-saml/*` packages — the unscoped `passport-saml`/`node-saml` are deprecated. **Do not hand-roll SAML XML parsing** — that CVE class (canonicalization / parser-differential bypass) is exactly why we delegate to Polis.

## Architecture / integration points (our stack: Node + TS + Express + Prisma 5.22 + PG18; client React+Vite)
- `server/routes/sso.ts` (NEW): `GET /api/sso/authorize` (redirect to Polis), `GET /api/sso/callback` (exchange code → resolve tenant+user → issue our normal JWT), SCIM consumer (webhook endpoint or sync job).
- `server/middleware/auth.ts`: reuse the existing JWT issue/verify. SSO callback ends by minting the SAME JWT the password flow issues — downstream authz is unchanged.
- **Tenant mapping:** each customer `Account` ↔ a Polis tenant/product + SSO connection. A user arriving from IdP-A must ONLY ever resolve into their own Account. Store the Polis tenant mapping + per-user `externalId` (SCIM) on our models.
- **Prisma (additive migration, UTF-8 NO BOM via Node fs.writeFileSync):** add an SSO-connection mapping per account and a SCIM `externalId` on `User`. New Postgres enum values (if any) require `ALTER TYPE`.
- **Per-account admin config:** a route + Settings UI for an account `admin` to set up their IdP (upload SAML metadata / OIDC client), proxying the Polis Admin API. Gate behind `requireAdmin`.
- **Client:** `Login.jsx` adds "Sign in with SSO" (email/domain → IdP discovery → redirect; reuse the existing `safeNext` open-redirect guard for post-login return). New admin SSO settings page.
- **Account opt-in:** make SSO an account-level feature flag (mirror the existing `arc_flash_studies` AccountSetting pattern) so it ships dark and enables per customer.

## Role mapping (surface as an open question, propose a default)
Map IdP group/claim → our roles (`viewer | consultant | manager | admin | oem_admin`). Propose a safe default (lowest-privilege = `viewer`) and a config table; do NOT auto-grant `admin`/`oem_admin` from an unverified claim.

## HARD guardrails
- **Branch `feature/sso-polis` ONLY. Do NOT merge to main. Do NOT deploy.** Dustin runs the MCP deploy loop after review.
- **ServiceCycle repo ONLY. Do NOT touch LapseIQ or ForgeRift** (separate products; explicit project rule).
- **Keep all 3 gates green after each step:** server `tsc --noEmit`, the jest integration suite, client `vite build`. (Suite note: the full run can make the shell wrapper report a teardown ETIMEDOUT even on success — tee to a file and read the file; kill leftover node procs.)
- **Tests are mandatory** for every new route/flow: auth-boundary (401 no/bad/revoked token), **cross-tenant isolation** (IdP-A user can never reach Account-B), SCIM create/update/deactivate **idempotency + replay**, role-mapping, and callback CSRF/state/nonce validation.
- **Secrets:** never commit secrets. Polis API keys, OIDC client secrets, SAML signing keys → env only; document every required env var. Missing config must fail **closed and loud**, not silent.
- **License hygiene:** use ONLY the public OSS `ory/polis` (Apache-2.0). Do NOT pull any "Ory Enterprise License" (OEL) component. Add Polis LICENSE + NOTICE attribution. Run a transitive-dependency license scan (e.g. `license-checker`) and **report any AGPL/SSPL/other copyleft** findings — flag, do not bundle.
- **Verify Polis's ACTUAL API response shapes** with a local call before coding any parser (engineering-guidelines §4 — don't trust docs/memory). Idempotent SCIM writes (upsert on `externalId`). Timeouts + retry-with-backoff on Polis calls. Structured logging; distinguish "pending" from "error".
- **Do NOT modify the droplet's production docker-compose.** Provide the compose additions (Polis service) as a reviewable diff; Dustin applies via the MCP loop.

## Deliverables (on the branch)
1. Working SSO login (OIDC + SAML) via Polis, with a local `docker-compose` addition for Polis + documented env vars.
2. SCIM provisioning (create/update/deactivate) wired into `User`/`Account`.
3. Per-account SSO admin config flow (gated `requireAdmin`, account-opt-in flag).
4. Full test coverage per the guardrails above.
5. `docs/security/SSO_DESIGN.md`: architecture, data model, env vars, **threat model**, license/attribution notes, and dependency-license-scan results.
6. A PR description + a "how to review & deploy" note for Dustin (so the MCP deploy loop can run post-review).

## Open questions to RESOLVE IN THE DESIGN DOC (don't guess silently)
- Session model: our JWT vs Polis sessions — confirm the boundary.
- SCIM ingestion: webhook push vs scheduled poll (pick one, justify).
- Role/group → role mapping rules + default.
- SSO-required vs SSO-optional per account (allow password fallback for break-glass admin?).
