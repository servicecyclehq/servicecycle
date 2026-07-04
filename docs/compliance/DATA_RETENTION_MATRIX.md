# Data Retention Matrix

**Purpose:** single table stating how long every class of ServiceCycle data lives, what deletion mechanism applies, and how a customer-requested deletion propagates. SOC 2 auditors ask for this by name; SC's current C1.2 gap in `SOC2_CONTROLS.md` is closed by this doc + planned auto-prune scheduler.

**Version:** 1.0
**Effective date:** 2026-07-04
**Owner:** Dustin
**Review cadence:** annually or on any material data-class addition.
**Anchor:** `docs/security/DATA_CLASSIFICATION.md` (tier definitions).

---

## Matrix

| Data class | Tier | Live retention | Backup retention | Auto-prune? | Deletion on customer request | Deletion propagation |
|---|---|---|---|---|---|---|
| **Customer compliance records** (test reports, arc-flash studies, LOTO, nameplate scans) | 3 | Indefinite while account active | 30-day rolling S3 | Not currently automatic — closed by planned prune job | GDPR erasure via `support@servicecycle.app` | Live delete immediate; backup age-out ≤30 days |
| **Assets, sites, deficiencies, work orders** | 3 | Indefinite while account active | 30-day rolling S3 | Not currently automatic | Same as above | Same |
| **Quote requests, parts catalog, spare inventory** | 3 | Indefinite while account active | 30-day rolling S3 | Not currently automatic | Same | Same |
| **User accounts (email, name, role)** | 3 | While active | 30-day rolling S3 | On account close: soft-delete then hard-delete after 30-day grace | Immediate hard-delete on request | Backup age-out ≤30 days |
| **Password hashes** | 4 | Until password change or account close | 30-day rolling S3 | Auto (replaced on change) | Deleted with account | Backup age-out ≤30 days |
| **TOTP secrets** | 4 | Until MFA reset or account close | 30-day rolling S3 | Auto (replaced on reset) | Deleted with account | Backup age-out ≤30 days |
| **Sessions (JWTs)** | 3 | JWT lifetime (short, from config) | Not stored — signature-only | N/A | `tokenEpoch` bump revokes all outstanding | Immediate |
| **Audit chain rows** | 3 | Indefinite (append-only in intent; rows are redactable for GDPR while `rowHash`/`prevHash` remain intact) | 30-day rolling S3 | No — audit chain is preserved even after data-subject request | GDPR erasure redacts payload; row + hashes remain | Backup age-out ≤30 days |
| **Login-failure / lockout events** | 3 | 12 months live, then can be pruned via retention job (planned) | 30-day rolling S3 | Planned | On account close, deleted with account | Backup age-out ≤30 days |
| **AI call metadata** (model, tokens, cost, purpose) | 3 | 12 months live for cost analysis, then aggregate-only | 30-day rolling S3 | Planned | On account close, deleted with account | Backup age-out ≤30 days |
| **Feature flags, admin settings** | 2 | Indefinite | 30-day rolling S3 | N/A | On account close, deleted with account | Backup age-out ≤30 days |
| **Application logs (nginx, docker)** | 2–3 (may contain redacted PII) | 90 days on droplet | Not backed up | Auto (log rotation) | N/A (aggregate) | N/A |
| **Error traces (uncaught exceptions)** | 2–3 | 90 days on droplet | Not backed up | Auto (log rotation) | N/A (aggregate) | N/A |
| **Backup archives (pg_dumps)** | 3 (contents mirror live) | N/A | 30-day rolling S3 | Auto (S3 lifecycle rule) | Live data is deleted; backup archives age out ≤30 days | Backup age-out ≤30 days |
| **`ENCRYPTED_KEYS` per-account envelope keys** | 4 | Indefinite while account active | 30-day rolling S3 (encrypted under `MASTER_KEY`) | Rotated per `KEY_ROTATION.md` | Deleted with account | Backup age-out ≤30 days |
| **`MASTER_KEY`, `JWT_SECRET`, `BACKUP_ENCRYPTION_KEY`** | 4 | Until rotation | Not in backups | Rotated per `KEY_ROTATION.md` | N/A (SC-level) | N/A |
| **Vendor credentials** | 4 | Until rotation | Not in backups (password manager only) | Rotated per `SECRETS_INVENTORY.md` cadence | N/A (SC-level) | N/A |

## Deletion SLAs

| Trigger | Live deletion SLA | Backup age-out | Confirmation to customer |
|---|---|---|---|
| GDPR / CCPA erasure request | 30 days (target: 7 days) | ≤30 days from live delete | Email confirmation with export bundle if requested + delete timestamp |
| Account voluntary close (customer initiates from admin console) | Immediate soft-delete; hard-delete after 30-day grace | ≤30 days after hard delete | In-app + email confirmation |
| Contract termination initiated by SC | Standard offboarding per `OFFBOARDING.md` | ≤30 days after hard delete | Documented offboarding email |
| Log rotation | Automatic per droplet log config | N/A | N/A |
| Backup expiry | Automatic per S3 lifecycle rule | Rolling 30 days | N/A |

## Verification of requester (for erasure requests)

Before we act on a deletion request:

1. Requester must email from an address matching an admin user of the account.
2. SC replies with a canned confirmation asking to confirm scope (full account, or single user, or specific record set).
3. On confirmation, SC executes deletion and records the event in the audit chain.
4. Export bundle (if requested) is sent as an encrypted archive; encryption key sent out-of-band.

Documented in `docs/OFFBOARDING.md` §6 with the operational script; this matrix is the policy view.

## Retention exceptions

If a specific customer contract requires a longer or shorter retention window, capture the exception:

1. Note it in the customer's account record.
2. Add a row to `SECURITY_DECISIONS.md` explaining the exception.
3. If it materially changes the standard offering, update this matrix.

## Automation status

- **Auto-prune scheduler**: NOT YET IMPLEMENTED. Closing this is item H4 in `SOC2_READINESS_CHECKLIST.md` and CC5.2 / C1.2 gap in `SOC2_CONTROLS.md`. Prioritized as Session 4 in the checklist's suggested sequence.
- **Backup S3 lifecycle**: configured at bucket policy level.
- **Application log rotation**: droplet-level logrotate configuration.

## What this matrix does not cover

- Third-party retention (customer BYO AI provider — see their DPA).
- Retention on the customer's own workstations (out of scope).
- Retention of vendor logs at DO, Cloudflare, email provider (see each vendor's row in `VENDOR_SECURITY_REVIEW.md`).
