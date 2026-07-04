# Secrets Inventory

**Purpose:** enumerate every secret that gives access to ServiceCycle production, source, or customer data — independent of the platform-provided secrets UI (GitHub Secrets, DO env vars, etc.). SOC 2 CC6.1 / CC6.8 ask "who has access to what, and how do you rotate."

**Owner:** Dustin (founder)
**Review cadence:** quarterly (align with access review)
**Last updated:** 2026-07-04

---

## Application secrets (server .env / DO droplet)

| Key | Purpose | Rotation cadence | Last rotated | Stored where | Rotation runbook |
|---|---|---|---|---|---|
| `JWT_SECRET` | Signs auth tokens | Every 12 months, or on suspected compromise | (see git log) | Droplet `.env`; password manager | `docs/KEY_ROTATION.md` §JWT (dual-verify window with `OLD_JWT_SECRET`) |
| `OLD_JWT_SECRET` | Dual-verify window during JWT rotation | Purged 24h after JWT rotation completes | N/A (transient) | Droplet `.env` | Same as JWT |
| `MASTER_KEY` | Root key for AES-256-GCM per-account secrets | Every 12 months | (see git log) | Droplet `.env`; password manager | `docs/KEY_ROTATION.md` §MASTER_KEY |
| `BACKUP_ENCRYPTION_KEY` | Encrypts pg_dump before S3 upload | Every 12 months | (see git log) | Droplet `.env`; password manager | `docs/KEY_ROTATION.md` §Backup |
| `INBOUND_WEBHOOK_SECRET` | HMAC verification on inbound email + integration webhooks | 12 months | (see git log) | Droplet `.env` | Manual rotate + coordinate with sender |
| `DATABASE_URL` | Postgres connection string | On credential rotation only | (see git log) | Droplet `.env` | Rotate PG user password, redeploy |
| `ENCRYPTED_KEYS` (list of per-account keys) | Per-account envelope encryption | Rotates per-account on admin trigger | Per account | DB (encrypted at rest under MASTER_KEY) | Admin UI |

## AI provider credentials (customer-supplied BYO by design)

| Key | Purpose | Owner | Rotation | Stored where |
|---|---|---|---|---|
| `GEMINI_API_KEY` | Free-tier trickle only (nameplate scan; free tier scrubs PII) | ServiceCycle-owned | 6 months, or on quota reset | Droplet `.env`; password manager |
| `GROQ_API_KEY` | Free-tier fallback | ServiceCycle-owned | 6 months | Droplet `.env`; password manager |
| Customer BYO Anthropic / OpenAI / Gemini keys | Paid-tier LLM calls per customer | Customer | Customer's responsibility | Encrypted per-account with MASTER_KEY-derived key |

## Platform credentials (not in .env — external accounts)

| Account | Owner | MFA on? | Rotation cadence | Stored where |
|---|---|---|---|---|
| GitHub (repo owner) | Dustin | ✅ | Password 12 months; SSH keys 24 months | Password manager |
| DigitalOcean | Dustin | ✅ | 12 months | Password manager |
| Cloudflare | Dustin | ✅ | 12 months | Password manager |
| Domain registrar | Dustin | ✅ | 12 months + registrar lock | Password manager |
| Email provider (Brevo / Resend) | Dustin | ✅ | 12 months | Password manager |
| S3-compatible backup target (Backblaze / other) | Dustin | ✅ | 12 months; access-key rotation 6 months | Password manager |
| Better Stack | Dustin | ✅ | 12 months | Password manager |
| Password manager itself | Dustin | ✅ (recovery-key vault too) | Master passphrase reviewed annually | N/A |

## Rotation log

Append here whenever a secret is rotated:

| Date | Secret | Reason | Verified by |
|---|---|---|---|
| _(seed row)_ 2026-07-04 | inventory initialized | Initial creation of inventory doc | Dustin |

## What's NOT in this inventory

- Ephemeral secrets that live only in memory (Prisma-generated transaction tokens, JWT payloads themselves).
- Public-key material (git-signed commits, TLS certs) — those live in their own key-rotation runbook.
- Third-party public keys (Cloudflare Origin CA cert). Those are configuration, not secrets.

## Access

Only the founder holds any of these credentials. When a second person joins:

1. Add them to `docs/PERSONNEL_SECURITY.md`.
2. Grant them credentials on a per-secret, per-role basis (do not hand over the password manager wholesale).
3. Log the grant date + secrets granted here.
4. Verify MFA on each account they access.
