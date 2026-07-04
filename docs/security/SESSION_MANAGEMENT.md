# Session Management Policy

**Purpose:** state the design of ServiceCycle's session lifecycle so auditors can trace timeouts, revocation, and refresh mechanics. Companion to `docs/security/DATA_FLOW.md` Flow 1 (login) and to the code in `server/routes/auth.ts`.

**Version:** 1.0
**Effective date:** 2026-07-04
**Owner:** Dustin
**SOC 2 mapping:** CC6.2 (authentication), CC6.4 (manages changes to access).
**Source of truth:** `server/routes/auth.ts` (JWT lifecycle), `server/middleware/auth.ts` (verification).

---

## Model

ServiceCycle uses **short-lived JSON Web Tokens (JWTs)** issued at login and passed via `Authorization: Bearer <token>` on every API call. There is intentionally no server-side session store — the token is the session.

Rationale:
- Simplicity for solo-dev operations.
- Horizontal scalability (no sticky sessions).
- The tradeoff — revocation is a challenge for stateless JWTs — is handled by the `tokenEpoch` mechanism below.

## Token contents (claims)

Every JWT carries:

| Claim | Purpose |
|---|---|
| `sub` | user id |
| `accountId` | tenant scope; every DB query is filtered by this |
| `role` | RBAC role name |
| `epoch` | monotonic per-user counter (see revocation) |
| `iat` | issued-at |
| `exp` | expiry |

Claims are signed with `JWT_SECRET` (HS256). During key rotation, `OLD_JWT_SECRET` provides a dual-verify window — see `docs/KEY_ROTATION.md`.

## Lifetimes

| Token type | Default lifetime | Configurable via |
|---|---|---|
| Access token | 24 hours | `JWT_ACCESS_TTL` env var |
| Password-reset token | 60 minutes | Hardcoded; short-lived by design |
| Invite token | 7 days | `INVITE_TTL_HOURS` env var |
| SSO session | inherits from IdP; SC accepts 12h max | `SSO_MAX_SESSION_HOURS` env var |

**No refresh tokens at this stage.** When an access token expires, the user re-authenticates. This is a deliberate simplification; a refresh-token design is on the roadmap when session friction becomes measurable.

## Idle timeout

Because access tokens are validity-checked only for `exp` (not for last activity), there is no server-enforced idle timeout smaller than `exp`. This is a documented gap in `SOC2_READINESS_CHECKLIST.md` Section A9 (yellow). Compensating controls:

- Endpoint policy (`ENDPOINT_SECURITY.md`) requires ≤15 min screen lock on workstations that have production access.
- MFA-required admin actions re-challenge periodically.
- Short (24h) access token lifetime bounds the window.

## Revocation

The absence of a session store is normally a weakness for JWT designs. ServiceCycle solves it with a per-user monotonic counter, `tokenEpoch`, stored in the DB:

1. User's row has `tokenEpoch: N`.
2. Issued JWTs carry `epoch: N`.
3. `authenticateToken` middleware verifies `jwt.epoch === user.tokenEpoch`.
4. **Any event that must revoke sessions** (password change, MFA reset, forced logout, admin deactivation) increments `tokenEpoch` to `N+1`.
5. All previously-issued JWTs (with `epoch: N`) now fail verification instantly.

Events that trigger a `tokenEpoch` bump:

| Event | Bumped for |
|---|---|
| Password change | The user |
| Forced password reset (admin action) | The user |
| MFA reset | The user |
| Admin deactivates user | The user |
| Detected credential compromise | The user (or all users for account-wide) |
| Workstation compromise incident (Playbook 7) | All admin users |

## MFA / step-up

- MFA is per-user opt-in by default.
- `MFA_REQUIRED_FOR_ADMINS` flag makes MFA mandatory for `admin` and `super_admin` roles.
- On login with MFA, the user completes TOTP challenge before the JWT is issued.
- Certain admin actions (encryption toggle, SSO reconfiguration) require a fresh MFA challenge within the current session — the JWT carries a short-lived `mfaVerifiedAt` claim used by these routes.

## SSO sessions

- When `SSO_ENABLED`, the IdP determines primary authentication.
- After successful IdP handshake, SC issues a JWT with the same claims.
- IdP session and SC JWT are decoupled — the IdP can revoke, but SC's JWT is valid until `exp` or `tokenEpoch` bump.
- SCIM deprovisioning at the IdP triggers `tokenEpoch` bump automatically via the SCIM webhook.

## What we log

Every session event writes to the tamper-evident activity chain:

- `login_success` — successful auth, method (password | MFA | SSO)
- `login_failed` — per-email counter (CEF sev 6)
- `login_lockout_triggered` — email lockout (CEF sev 7)
- `password_changed` — bump event
- `mfa_enrolled` / `mfa_reset` — MFA lifecycle
- `token_epoch_bumped` — synthetic event when revocation fires
- `sso_login_success` / `sso_login_failed` — SSO-specific
- `scim_deprovision` — SCIM webhook triggered revocation

## Storage

- JWTs are **never** stored in `localStorage` — they live in memory in the SPA to reduce XSS surface. This means a page refresh triggers a re-authentication challenge (the SPA has a short session-recovery flow using a same-site cookie for the redirect; no persistent secret is stored client-side).
- JWTs are **never** logged server-side.
- `Authorization` headers are stripped from any log line before writing.

## Cookies

- Same-site cookies exist only for the SPA session-recovery flow. They are `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/api/auth`.
- No third-party cookies are set by SC.

## Change triggers

Revisit this policy when:

- Refresh tokens are introduced.
- Idle timeout is enforced server-side.
- Additional auth methods (WebAuthn, passkeys) are added.
- The session model changes for enterprise (e.g., SAML session lifetime binding).
