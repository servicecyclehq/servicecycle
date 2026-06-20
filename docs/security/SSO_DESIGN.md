# SSO + SCIM Design — Self-hosted Ory Polis

_Branch: `feature/sso-polis`. Companion to [`docs/roadmap/SSO_BUILD_SPEC.md`](../roadmap/SSO_BUILD_SPEC.md) (the contract). This is the living design record: architecture, data model, resolved open questions, env vars, threat model, and license/attribution + dependency-scan results._

**Status:** in progress. Polis API response shapes are **source-verified** against `ory/polis@v26.2.0` (`npm/src/...`) and **fixture-locked** by a live local run (no Docker, no droplet) — see [§11 Verification](#11-polis-api-shape-verification).

---

## 1. Goal & scope

Add enterprise SSO (OIDC + SAML) and SCIM 2.0 directory sync so business customers sign in with their corporate IdP (Okta, Entra ID, Google Workspace, Ping, JumpCloud), multi-tenant, with automatic provisioning/deprovisioning. ServiceCycle is the OAuth **relying party**; Ory Polis is the **broker**. Our existing JWT remains the only session credential the app trusts.

Ships **dark**: gated behind a per-account feature flag (`sso`), default OFF, enabled per customer.

## 2. Foundation (decided in the spec — not re-litigated)

- **Self-host Ory Polis**, **Apache-2.0** (verified: repo `LICENSE` = Apache 2.0, `package.json` `version` 26.2.0, `license` "Apache-2.0"). We use ONLY the OSS distribution; **no Ory Enterprise License (OEL) component** is pulled or bundled.
- Polis runs as a **separate container/process** backed by **our PostgreSQL** (its own database/schema, isolated from the app DB). Single port **5225** serving `/oauth/*`, `/api/v1/sso/*` (connection admin), `/api/v1/dsync/scim/v2.0/*` (SCIM), and the admin portal.
- **OAuth 2.1**: Authorization Code + PKCE (S256), strict `state` + `nonce`, full ID-token validation (alg pinned, `none` rejected, `iss/aud/exp/nonce` checked). Short-lived tokens.
- Polis pins `openid-client` (panva, MIT) internally. We do **not** hand-roll SAML XML parsing — Polis owns that (the canonicalization / parser-differential CVE class is exactly why we delegate).

## 3. Architecture

```
                         ┌─────────────────────────────────────────┐
  Browser (SPA)          │            ServiceCycle API (RP)         │        Ory Polis (broker)
  Login.jsx              │  server/routes/sso.ts                    │        :5225  (separate container)
     │  email/domain     │  + middleware/auth.ts (unchanged JWT)    │
     │ ────────────────► │  GET /api/sso/authorize                  │
     │                   │   • domain → SsoDomain → Account+Conn     │
     │                   │   • fail closed if not opted-in/unknown   │
     │                   │   • mint state+nonce+PKCE → SsoLoginState │
     │ ◄──── 302 ─────── │                                          │
     │  302 to Polis /oauth/authorize?...state,code_challenge,nonce ────────►  /oauth/authorize
     │                                          IdP login (SAML/OIDC) ◄──────►  IdP (Okta/Entra/…)
     │ ◄──────────────────── 302 to /api/sso/callback?code&state ◄───────────  redirect_uri
     │ ───── GET /api/sso/callback?code&state ─►│                              │
     │                   │  • validate state (CSRF, single-use, TTL) │
     │                   │  • POST /oauth/token (code+verifier) ──────────────►  /oauth/token
     │                   │  • validate id_token (alg/iss/aud/exp/nonce)        │
     │                   │  • GET /oauth/userinfo ────────────────────────────►  /oauth/userinfo
     │                   │  • assert requested.tenant == conn tenant │
     │                   │  • resolve user INTO conn's Account only  │
     │                   │  • issueTokenPair()  (our normal JWT)     │
     │                   │  • mint single-use SsoHandoff (60s)       │
     │ ◄── 302 /sso/callback?code=<handoff>&next=<safeNext> ─────────│
     │ ── POST /api/sso/exchange {code} ───────►│ → {token,refreshToken,user}  │
     │  setAuthData() → normal authed session   │                              │

  SCIM (provisioning):  IdP ──► Polis SCIM ──► webhook ──► POST /api/sso/scim/webhook
                        verify HMAC (BoxyHQ-Signature) → upsert User on externalId (idempotent)
```

### 3.1 Why a token-handoff code (not tokens in the URL)
The SPA stores a bearer JWT + refresh token in `localStorage` (existing model). Returning those in the callback redirect URL would leak them into browser history, the `Referer` header, and server/proxy logs. Instead the callback mints a **single-use, 60-second `SsoHandoff` code**, puts only that in the redirect, and the SPA exchanges it once at `POST /api/sso/exchange` for the real `{token, refreshToken, user}`. The actual JWT is minted **at exchange time**, so a leaked handoff code that is never exchanged grants nothing, and a replayed one is rejected (`consumedAt`).

### 3.2 Integration points (existing code reused)
- **JWT issue/verify:** `issueTokenPair()` in [`server/routes/auth.ts`](../../server/routes/auth.ts) and `authenticateToken` in [`server/middleware/auth.ts`](../../server/middleware/auth.ts) — unchanged. The callback mints the **same** token a password login does.
- **Open-redirect guard:** the `safeNext` check in [`client/src/pages/Login.jsx`](../../client/src/pages/Login.jsx) (`startsWith('/') && !startsWith('//')`) is reused for post-SSO return.
- **Feature flag:** [`server/lib/accountFeatures.ts`](../../server/lib/accountFeatures.ts) `AccountSetting` pattern (`feature.sso`), mirrored client-side in `AuthContext`.
- **Role gate:** `requireAdmin` in [`server/middleware/roles.ts`](../../server/middleware/roles.ts) for the admin config routes.
- **Audit log:** `writeLog()` in `server/lib/activityLog.ts` for SSO/SCIM events (login, provision, deactivate, break-glass).

## 4. Data model (additive Prisma migration, UTF-8 no BOM)

New enum `SsoProtocol { oidc, saml }`. New models (all `accountId`-scoped, FK-cascade on account delete):

| Model | Purpose | Key fields |
|---|---|---|
| `SsoConnection` | Account ↔ Polis tenant/product + connection | `accountId`, `protocol`, `polisTenant`, `polisProduct`, `polisClientId?`, `label`, `isActive` |
| `SsoDomain` | Email-domain → account discovery (isolation anchor) | `domain @unique`, `accountId`, `connectionId`, `isActive` |
| `ScimDirectory` | Account ↔ Polis SCIM directory | `polisDirectoryId @unique`, `accountId`, `polisTenant`, `polisProduct`, `type`, `isActive` |
| `SsoRoleMapping` | IdP group/claim → our role | `accountId`, `idpGroup`, `role`, `@@unique([accountId, idpGroup])` |
| `SsoLoginState` | CSRF/PKCE transient (single-use, TTL) | `state @unique`, `nonce`, `codeVerifier`, `connectionId`, `accountId`, `redirectTo`, `expiresAt`, `consumedAt` |
| `SsoHandoff` | One-time token handoff to SPA | `codeHash @unique`, `userId`, `accountId`, `redirectTo`, `expiresAt`, `consumedAt` |
| `ScimEvent` | Idempotency/replay ledger | `eventKey @unique`, `polisDirectoryId?`, `directoryId?`, `eventType`, `status` |

Additive columns on **`User`**:
- `scimExternalId String?`, `scimDirectoryId String?` — SCIM identity, `@@unique([scimDirectoryId, scimExternalId])` (NULLs are distinct in Postgres, so existing password users are unaffected; upsert key for SCIM).
- `ssoManaged Boolean @default(false)` — provisioned/managed via SSO/SCIM; drives the `sso.required` password-login block.
- `lastSsoLoginAt DateTime?`.

`passwordHash` **stays NOT NULL**: SCIM/JIT users get a random, unusable bcrypt hash (cannot be matched by any password) rather than making the column nullable — this keeps the password-login path's invariant intact and avoids a `bcrypt.compare(pw, null)` throw. Documented here so it isn't mistaken for a bug.

Role-mapping default and `sso.required` policy live as `AccountSetting` rows (`sso.rolemap.default`, `sso.required`) — reusing the existing key/value flag table, no extra columns.

## 5. Open questions — resolved

### Q1. Session model: our JWT vs Polis sessions
**Our JWT is authoritative; Polis is a stateless broker.** No Polis session/cookie is ever trusted for app authz. Polis is contacted only during authorize→token→userinfo. The callback's sole job is to resolve identity and call `issueTokenPair()`. This means revocation, `tokenEpoch`, 2FA, refresh rotation, and every downstream `requireX` gate keep working unchanged.

### Q2. SCIM ingestion: webhook push vs scheduled poll
**Webhook push.** Real-time deprovisioning is the security win — a poll leaves a terminated employee able to log in until the next sweep. Polis posts directory events to `POST /api/sso/scim/webhook`. SCIM writes are made idempotent by upserting on `externalId`, so a redelivery is a no-op. An **optional** manual reconcile endpoint (admin-triggered full re-pull) is provided as a safety net for missed webhooks, but push is primary. Justification recorded per spec.

### Q3. Role/group → role mapping + default
**Default = lowest privilege `viewer`.** `SsoRoleMapping` maps an IdP group/claim value to one of `viewer | consultant | manager`. **`admin`, `oem_admin`, and `super_admin` are NEVER auto-granted from an IdP claim** — they must be set by an existing ServiceCycle admin in-app. If no mapping matches, the user gets the account's `sso.rolemap.default` (which itself defaults to `viewer`). On re-login, role is re-evaluated from claims **except** privileged roles, which are sticky once granted in-app (an IdP claim can never downgrade-then-re-escalate around the in-app grant; and it can never escalate past `manager`).

### Q4. SSO-required vs optional + break-glass
**Optional by default; per-account `sso.required` flag with mandatory break-glass.** When `sso.required=true` for an account, password login is blocked for `ssoManaged` users, but:
- **Break-glass is always preserved:** at least one local (non-SSO-managed) **admin** can always sign in with password + 2FA. The toggle/that-state is guarded by a **last-password-admin check** — the system refuses any action that would drop the count of password-capable active admins below one.
- **Break-glass logins are logged and alerted:** a password login while `sso.required` is on writes a distinct `sso_break_glass_login` activity-log row (should be rare; surfaced for operators).
- **Hard-required / no-fallback** (option 3 in the spec) is intentionally **NOT built now**; it's noted as a possible future explicit opt-in for advanced customers.

## 6. Environment variables (secrets in env only; fail closed + loud)

When `SSO_ENABLED=true`, the startup validator (`server/index.ts`) **refuses to boot** (`process.exit(1)`) if any required var is missing — same pattern as `JWT_SECRET`/`MASTER_KEY`.

| Var | Required when SSO on | Purpose |
|---|---|---|
| `SSO_ENABLED` | — | Master switch (default `false`). |
| `POLIS_BASE_URL` | ✅ | Internal URL the API calls (`/oauth/token`, `/oauth/userinfo`, admin API). |
| `POLIS_EXTERNAL_URL` | optional | Public URL the browser is redirected to for `/oauth/authorize` (defaults to `POLIS_BASE_URL`). |
| `POLIS_API_KEY` | ✅ | Polis admin API key (`Authorization: Api-Key …`). Server-only. |
| `POLIS_PRODUCT` | optional | Polis product id (default `servicecycle`). |
| `SSO_CALLBACK_URL` | ✅ | Our OAuth `redirect_uri`; must equal what Polis has registered. |
| `SCIM_WEBHOOK_SECRET` | ✅ | HMAC secret to verify inbound SCIM webhooks (`BoxyHQ-Signature`). |
| `SSO_JIT_PROVISIONING` | optional | Allow login-time user creation when no SCIM record exists (default `false`). |

No secret is ever committed; `.env.example` documents each with placeholders only.

## 7. Threat model (per-flow)

| # | Threat | Mitigation |
|---|---|---|
| T1 | **Cross-tenant identity confusion** (IdP-A user resolves into Account-B) | Triple bind: (a) flow is initiated only via `SsoDomain`→connection→account; (b) `state` row stores the connection/account and is single-use; (c) callback asserts `userinfo.requested.tenant == connection.polisTenant` AND the resolved user's existing `accountId` (if any) equals the connection's account — mismatch = hard reject. |
| T2 | **CSRF / login-forgery on callback** | Unguessable `state` (32B random), stored server-side, single-use (`consumedAt`), short TTL; callback rejects missing/unknown/expired/consumed state. |
| T3 | **ID-token alg-confusion / `none`** | Pin expected algorithm; reject `none`; validate `iss`, `aud`, `exp`, and `nonce` equals the value bound in `SsoLoginState`. |
| T4 | **PKCE downgrade / code interception** | S256 `code_challenge`; `code_verifier` stored server-side in `SsoLoginState`, never sent to the browser. |
| T5 | **Token leakage via callback URL** | Tokens never placed in URLs; single-use 60s `SsoHandoff` code → `POST /api/sso/exchange`. JWT minted at exchange time. |
| T6 | **SCIM webhook forgery** | HMAC-SHA256 verify of `BoxyHQ-Signature` over the **raw** body (`t=<ms>,s=<hex>`), constant-time compare; reject stale timestamps; fail closed if `SCIM_WEBHOOK_SECRET` unset. |
| T7 | **SCIM replay / double-delivery** | `ScimEvent` dedupe ledger (unique `eventKey`) + naturally idempotent upsert-on-`externalId`. |
| T8 | **Privilege escalation via claims** | Role map caps at `manager`; admin/oem_admin/super_admin never claim-granted; default `viewer`. |
| T9 | **Stale session after deprovision** | `user.deleted`/`active=false` sets `isActive=false` **and bumps `tokenEpoch`**, instantly invalidating every outstanding access token (existing revocation mechanism). |
| T10 | **Account lockout via misconfigured IdP** | `sso.required` always preserves password break-glass for ≥1 local admin (last-password-admin guard). |
| T11 | **Open redirect on post-login return** | Existing `safeNext` guard (same-origin relative paths only). |
| T12 | **Admin configures another tenant's connection** | Admin config routes force `tenant`/`product` to be **account-derived server-side**; client-supplied tenant is ignored. |
| T13 | **IdP-discovery / account enumeration oracle** | `/api/sso/authorize` returns a generic outcome whether or not a domain maps to an opted-in account (no "this domain has SSO" signal). |
| T14 | **Polis outage / slow broker** | Timeouts + retry-with-backoff on all Polis calls; structured logs distinguish `pending` from `error`; user sees a clean failure, never a hung request. |

## 8. Polis API shapes (source-verified @ v26.2.0)

> Verified from `ory/polis` source and locked by committed fixtures (`server/__tests__/fixtures/polis/`). See [§11](#11-polis-api-shape-verification).

**`POST /oauth/token` → `OAuthTokenRes`** (`npm/src/controller/oauth.ts`):
```jsonc
{ "access_token": "<hexKey>.<token>", "token_type": "bearer", "expires_in": 300, "id_token": "<jwt>" /* OIDC only */ }
```

**`GET /oauth/userinfo` → `Profile`** (camelCase):
```jsonc
{ "id": "…", "email": "…", "firstName": "…", "lastName": "…",
  "roles": ["…"], "groups": ["…"], "raw": { /* full IdP attrs incl. group claims */ },
  "requested": { "tenant": "…", "product": "…" } }
```

**SCIM webhook body** — `DirectorySyncEvent | DirectorySyncEvent[]` (batch possible; `npm/src/directory-sync/types.ts`):
```jsonc
{ "directory_id": "…", "tenant": "…", "product": "…",
  "event": "user.created|user.updated|user.deleted|group.*",
  "data": { "id": "…", "email": "…", "first_name": "…", "last_name": "…", "active": true, "roles": ["…"], "raw": {} } }
```
Signature: header `BoxyHQ-Signature` (and `Ory-Polis-Signature`), value `t=<ms>,s=<hmacSHA256hex>` over `` `${t}.${rawBody}` `` (`npm/src/event/webhook.ts`). **Verify over the raw request body**, not a re-serialization (HMAC re-computation against the captured live deliveries matches — see fixtures).

**Live-capture findings (locked into the parser):**
1. **Deactivation arrives as `user.updated` with `active:false`**, NOT `user.deleted`. The consumer treats any user event with `active===false` as a deactivation (set `isActive=false` + bump `tokenEpoch`); `user.deleted` is a separate removal path.
2. **`data.id`** is Polis's stable per-directory resource id (identical across create/update/deactivate for one user) → the SCIM upsert key (`scimExternalId`). The IdP's own externalId is in **`data.raw.externalId`** (stored secondary).
3. Webhook body may be a **single object or an array** (batch) — both handled.
4. `group.user_added`/`group.user_removed` carry the full **user** `data` plus a nested **`group`** object → the role-mapping hook.

## 9. Test plan (mandatory coverage)

Integration (`server/__tests__/routes/`, real DB) + unit (`server/tests/`, mocked prisma):
- **auth-boundary** — every new route 401 without token; admin routes 403 for non-admin; `/exchange` rejects bad handoff.
- **cross-tenant isolation** — IdP-A `state`/handoff/SCIM-directory can never resolve into Account-B (T1).
- **SCIM create/update/deactivate idempotency + replay** — same event twice = one effect; bad signature 401; deactivate flips `isActive` + bumps `tokenEpoch`.
- **role mapping** — group→role, default `viewer`, no claim ever grants admin/oem_admin.
- **callback CSRF/state/nonce** — missing/forged/replayed/expired state rejected; nonce mismatch rejected.

Gates kept green after each step: `tsc --noEmit`, jest, `vite build`.

## 10. License & attribution + dependency scan

- Polis is used as a **separate service**, not bundled into our `node_modules`; its transitive deps are not shipped in the ServiceCycle artifact. New app-side deps added for SSO are scanned.
- Polis `LICENSE` (Apache-2.0) + `NOTICE` attribution recorded under `docs/security/` / `third_party/`.
- `license-checker` run results and any AGPL/SSPL/copyleft findings recorded here.

_(Results table filled in Task #11.)_

## 11. Polis API-shape verification

Per spec §"Verify Polis's ACTUAL API response shapes": Polis `v26.2.0` was run locally as a **plain Node process** (no Docker, no droplet) via `npm run pre-loaded` (`DB_ENGINE=mem`, `PRE_LOADED_CONNECTION=./_dev/saml_config`) on `:5225`, driven against the public Mock SAML IdP and Polis's SCIM admin/inbound endpoints. Results, committed under `server/__tests__/fixtures/polis/` (+ a provenance `README.md`):

| Surface | Status | Evidence |
|---|---|---|
| SCIM webhook payloads (create/update/deactivate/group/membership) | **LIVE-captured** | `webhook_deliveries.json` — real signed POSTs to a local listener |
| SCIM webhook HMAC signature | **LIVE-verified** | HMAC-SHA256 re-computation matches the captured `BoxyHQ-Signature` |
| SCIM 2.0 HTTP responses | **LIVE-captured** | `scim_user_*`, `scim_group_*` |
| Polis admin directory-create | **LIVE-captured** (redacted) | `admin_dsync_create.json` |
| OAuth `/authorize` → IdP redirect | **LIVE-verified** | `oauth_authorize_redirect.json` (signed RSA-SHA256 SAMLRequest) |
| OIDC discovery | **LIVE-captured** | `openid-configuration.json` |
| `/oauth/token` + `/oauth/userinfo` JSON | **SOURCE-verified** | `oauth_token_userinfo.source-verified.json` (from `npm/src/controller/oauth.ts`). Live JSON capture blocked by mocksaml.com's hosted IdP returning HTTP 500 on **headless** form submission — their bug, not Polis; the authorize half is live-verified above. A future capture against a real IdP (or a browser-driven Mock SAML login) will replace this with a live fixture; no parser ships unverified — token/userinfo parsing follows the exact source types. |

The SCIM consumer — the surface most exposed to malformed/forged input — is fully live-captured and cryptographically verified. Parsers are written only against these shapes.
