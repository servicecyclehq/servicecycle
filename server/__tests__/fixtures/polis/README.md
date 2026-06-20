# Polis API-shape fixtures (verification gate)

These fixtures are **real responses** captured from `ory/polis@v26.2.0` run locally as a
plain Node process (no Docker, no droplet): `npm run pre-loaded` (`DB_ENGINE=mem`,
`PRE_LOADED_CONNECTION=./_dev/saml_config`) on `:5225`, driven against the public Mock
SAML IdP and Polis's own SCIM admin/inbound endpoints. They exist to satisfy the spec's
rule: _verify Polis's ACTUAL API response shapes with a live call before coding any parser._

Parsers in `server/lib/ssoPolis.ts` and the SCIM consumer in `server/routes/sso.ts` are
written **only** against these shapes. The SCIM webhook tests replay
`webhook_deliveries.json` byte-for-byte.

| File | Provenance | What it proves |
|---|---|---|
| `webhook_deliveries.json` | **LIVE** (real signed POSTs to a local listener) | Exact SCIM webhook bodies for `user.created`, `user.updated` (incl. **deactivate = `user.updated` with `active:false`**), `group.created`, `group.user_added`; signature header `BoxyHQ-Signature: t=<ms>,s=<hmacSHA256hex>` over `` `${t}.${rawBody}` `` (HMAC re-computation **matches** with the configured secret). |
| `scim_user_create_response.json` etc. | **LIVE** | SCIM 2.0 HTTP responses (status + body) for create/update/deactivate + groups. |
| `admin_dsync_create.json` | **LIVE** (secrets redacted) | Polis admin `POST /api/v1/dsync` directory-create response shape (`scim.path`, `scim.secret`, `webhook`). |
| `oauth_authorize_redirect.json` | **LIVE** | `GET /api/oauth/authorize` 302 → IdP with a signed RSA-SHA256 SAMLRequest. Confirms the authorize contract end-to-end. |
| `openid-configuration.json` | **LIVE** | Polis OIDC discovery document. |
| `oauth_token_userinfo.source-verified.json` | **SOURCE-VERIFIED** | `/oauth/token` + `/oauth/userinfo` shapes from `npm/src/controller/oauth.ts`. Live JSON capture was blocked by mocksaml.com's hosted IdP 500-ing on headless submission (their bug); the authorize half is live-verified above. |

Key findings baked into the parsers:
1. **Deactivation is `user.updated` with `active:false`**, not `user.deleted`. Treat any user
   event with `active===false` as a deactivation.
2. **`data.id`** is Polis's stable per-directory resource id (identical across create/update/
   deactivate for the same user) → used as the SCIM upsert key. The IdP's own externalId is in
   **`data.raw.externalId`** (kept as secondary).
3. Webhook body may be a **single object or an array** (batch) — handle both.
4. Userinfo is **camelCase** (`firstName`); SCIM is **snake_case** (`first_name`).
