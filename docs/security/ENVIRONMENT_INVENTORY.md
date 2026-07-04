# Environment Inventory

**Purpose:** enumerate every environment variable, integration endpoint, and configuration surface that governs ServiceCycle runtime behavior. Where `SECRETS_INVENTORY.md` tracks credentials, this doc tracks **every knob** — secret or not — so an auditor can answer "what is configurable, where, and who can change it."

**Owner:** Dustin
**Last updated:** 2026-07-04
**Source of truth for shape:** `server/.env.example`

---

## Environments

| Environment | Purpose | URL | Data class | Managed by |
|---|---|---|---|---|
| Production | Customer-facing hosted | `https://servicecycle.app` | Real customer data | DigitalOcean droplet 198.211.99.45; docker-compose |
| Demo | Sales / acquisition demo | Gated behind basic-auth | Seeded synthetic data only | Same droplet, separate stack |
| Local dev | Founder workstation | `localhost:3001` (API) / `localhost:5173` (client) | Empty / synthetic | Workstation Docker + native PG18 |

There is intentionally no **staging** environment at current stage — pre-deploy smoke tests run in CI against an ephemeral test server. A separate staging is a documented tradeoff, reviewed at next quarterly risk review.

## Runtime configuration surface

Categorized. Full authoritative list is in `server/.env.example`.

### Auth
- `JWT_SECRET` (secret — see inventory)
- `OLD_JWT_SECRET` (transient during rotation)
- `MFA_REQUIRED_FOR_ADMINS` (boolean flag)
- `EMAIL_LOCKOUT_ATTEMPTS`, `EMAIL_LOCKOUT_WINDOW_MIN`, `EMAIL_LOCKOUT_DURATION_MIN`
- `SSO_ENABLED` (dark-by-default; enables Ory Polis routes)

### Encryption
- `MASTER_KEY` (secret)
- `ENCRYPT_DOCS` (feature flag — per-account envelope encryption for test reports)
- `BACKUP_ENCRYPTION_KEY` (secret)

### Data
- `DATABASE_URL` (secret)
- `S3_BACKUP_BUCKET`, `S3_BACKUP_REGION`, `S3_BACKUP_ACCESS_KEY_ID`, `S3_BACKUP_SECRET_ACCESS_KEY` (backup target)
- `BACKUP_RETENTION_DAYS` (default 30)

### AI providers
- `GEMINI_API_KEY`, `GROQ_API_KEY` (free-tier fallback keys, SC-owned, PII-scrubbed use)
- `AI_BUDGET_DAILY_USD` (cap)
- `AI_ALLOW_PROVIDERS` (whitelist — shadow-AI prevention)

### External integrations
- `RESEND_API_KEY`, `BREVO_API_KEY` (transactional email)
- `INBOUND_WEBHOOK_SECRET` (HMAC verification for inbound email + integration webhooks)
- `BETTER_STACK_TOKEN`, `BETTER_STACK_HEARTBEAT_URL`
- `HEALTHCHECKS_URL` (heartbeat — optional)

### Client
- `CLIENT_URL` (comma-separated allowlist for CORS)
- `PWA_ENABLED`
- Analytics: intentionally none — no third-party analytics ship with the client.

### Feature flags
- Documented at time of introduction in `docs/api/` design notes.
- Toggled via env var or admin console; every toggle is logged as an admin action.

## Where each surface lives

| Surface | Where the value lives | Who can change |
|---|---|---|
| Server .env | `/root/ServiceCycle/server/.env` on droplet | Founder via VPS MCP (SSH access) |
| Client build vars | Baked at build time from Vite env | Founder (change → rebuild → deploy) |
| DB rows (admin flags, encryption toggle, MFA-required) | Postgres `Account`, `AdminSetting` tables | Admin UI, audit-logged |
| CI variables | GitHub Actions secrets/variables | Founder (GitHub org owner) |
| Deploy trigger | `.github/workflows/deploy.yml` on push to `main` | Any commit to main (single dev) |

## Changing anything here

Every environment change:

1. Ideally rides on a commit (env-example update, docker-compose update, docs update).
2. Is announced in CHANGELOG.md if customer-facing.
3. Is logged in the tamper-evident activity log for admin flags (`AdminSetting` writes).
4. If it changes a secret, the rotation log in `SECRETS_INVENTORY.md` is updated.

## Review cadence

- **Quarterly** — run `diff` between `server/.env.example` and the actual production env, confirm every prod key still has a documented purpose.
- **On any material integration change** (new AI provider, new email provider) — update this doc and `SECRETS_INVENTORY.md` in the same PR.
