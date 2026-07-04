# Data Flow Documentation

**Purpose:** show, per data class, where data lives, how it moves, how it's protected at each hop, and who has access. SOC 2 CC6.7 / C1.1 evidence.

**Owner:** Dustin
**Last updated:** 2026-07-04

Companion to `THREAT_MODEL.md` (which frames the attacker view) and `ASSET_INVENTORY.md` (which lists the endpoints).

---

## Data classes

| Class | Examples | Confidentiality | Integrity |
|---|---|---|---|
| **Customer compliance records** | Test reports, arc-flash studies, LOTO procedures, nameplate scans | High | Very high (regulatory) |
| **Customer PII** | User emails, technician names, site addresses | High | Standard |
| **Auth secrets** | Password hashes, TOTP secrets, JWTs | Very high | High |
| **Encryption keys** | `MASTER_KEY`, `BACKUP_ENCRYPTION_KEY`, per-account envelope keys | Very high | Very high |
| **Audit chain** | activity log rows with `prevHash` + `rowHash` | Medium | Very high (tamper evidence) |
| **Operational metadata** | Feature flags, config, non-secret env vars | Low | Standard |

## Flow 1 — Customer login

```
Browser
  ↓ HTTPS/TLS 1.3 (Cloudflare edge → nginx origin)
Client SPA
  ↓ POST /api/auth/login (JSON body: email + password)
API rate limiter (per-IP + per-email)
  ↓
Auth handler → Prisma → Postgres (bcrypt compare)
  ↓ (success)
JWT signed with JWT_SECRET, epoch stamped
  ↓ HTTPS response
Browser stores JWT (memory; not localStorage for XSS mitigation)
  ↓
Every subsequent /api/* call carries `Authorization: Bearer <jwt>`
```

**Protections:** TLS 1.3 in transit; bcrypt at rest for password; per-email lockout on 5 fails / 15 min; login_failed and login_lockout_triggered events written to hash-chained activity log.

**Access:** the founder (via admin console + activity log) can see login attempts. No third party.

## Flow 2 — Test report ingest (highest-risk path)

```
Field tech uploads PDF via /api/ingest
  ↓ multipart upload, size-capped
API auth + tenant scope
  ↓
Local parser (pdfplumber / pypdfium2 / tesseract inside container)
  ↓
If parser confidence low OR user opted for AI:
  ↓
  Free tier?
    ↓ redact PII → Gemini vision (SC-owned key, PII-scrubbed)
  Paid tier?
    ↓ pass full text/image → customer BYO key
  ↓
Extracted fields → validators (nameplate, report-verdict, etc.)
  ↓
Prisma write with accountId scope
  ↓
Activity log row: `test_report_ingested` (CEF sev 4)
  ↓
If AI was called: `api_v1_call` row with model + tokens + cost
```

**Protections:**
- Free-tier AI never sees email/phone (`aiTestReportExtract.ts` scrubs).
- Paid-tier AI is customer's own key + provider agreement.
- Uploaded PDFs go directly into `ENCRYPTED_KEYS`-encrypted storage if the feature flag is on.
- Every step is audit-logged.

**Access:** only users in the same account can read the record. Consultant role is read-only. Field-tech role is scoped to assigned jobs.

## Flow 3 — Nightly backup

```
Cron (02:00 UTC on the droplet)
  ↓
pg_dump | gzip | age-encrypt with BACKUP_ENCRYPTION_KEY
  ↓ HTTPS to S3-compatible target
Stored 30 days rolling; older objects lifecycled out by bucket policy
```

**Protections:** encryption key exists only on droplet + password manager; the backup target holds ciphertext only. Restore test runs monthly.

**Access:** the founder (with droplet SSH + password manager). Losing either half of the key material means backups are unrecoverable — this is why `KEY_ROTATION.md` procedures preserve the old key during rollover.

## Flow 4 — Audit chain export

```
Admin requests /api/activity/export
  ↓ requires admin role, MFA-verified session
API queries `ActivityLog` for the account
  ↓
Serialized as ndjson + CEF with per-row rowHash + prevHash
  ↓ HTTPS response
Admin's SIEM ingests
```

**Protections:** query scoped to the requester's account. Export payload includes hash-chain fields so the receiver can verify tamper-evidence externally.

## Flow 5 — SSO / SCIM (dark by default)

```
Enterprise IdP (Okta / Azure AD)
  ↓ SAML assertion or OIDC token
Ory Polis at /api/sso/*
  ↓
Map claims → SC role (see `docs/security/SSO_DESIGN.md`)
  ↓
Provision / update user via SCIM
  ↓
Standard JWT issuance from here on
```

**Protections:** SSO_ENABLED flag; enterprise-only feature. Attribute mapping tested in `ssoRoleMap.test.ts`.

## Retention per class

| Class | Live retention | Backup retention | Deletion on customer request |
|---|---|---|---|
| Customer compliance records | Indefinite while account is active | 30-day rolling backup | Purged from live + logically deleted from future backups within 24h; existing backups age out within 30 days |
| Customer PII | Indefinite while account is active | 30-day rolling backup | Same as above |
| Auth secrets | Bcrypt hash rotates on password change; TOTP secret rotates on user-initiated MFA reset | 30-day rolling backup | Deleted with account |
| Encryption keys | Rotated per `KEY_ROTATION.md` cadence | Backup-key material never in backup itself | Rotated within 30 days of any breach |
| Audit chain | Indefinite (append-only) | 30-day rolling backup | See §Deletion + audit chain below |
| Operational metadata | Indefinite | 30-day rolling backup | N/A (no customer data) |

### Deletion + audit chain

The hash chain is tamper-evident, not append-only immutable. Customer-requested deletion (GDPR erasure) redacts the row's payload while leaving `rowHash`/`prevHash` intact so the chain still verifies. This is documented as a compensating design choice: the chain proves "no row was silently rewritten," and redaction is an intentional, logged action.

## Access matrix (who can see what)

| Data class | Viewer | Consultant | Field tech | Manager | Admin | Super admin | External |
|---|---|---|---|---|---|---|---|
| Own account compliance records | read | read | assigned jobs only | read/write | read/write | read/write across accounts | none |
| Own account PII | limited | read | assigned jobs only | read/write | read/write | read/write | none |
| Auth secrets | none | none | none | none | own only | own only | none |
| Encryption keys | none | none | none | none | none (founder-only via env) | none | none |
| Audit chain (own account) | none | none | none | read | read/export | read/export | export via SIEM if configured |
| Free-tier AI prompts | none | none | none | none | admin sees usage summary; not prompt bodies | same | AI provider sees PII-scrubbed body |
| Paid-tier AI prompts | none | none | none | none | admin sees usage summary; body goes to customer BYO provider | same | Customer's own AI provider |

## Cross-referenced docs

- `THREAT_MODEL.md` — attacker view of these same flows.
- `SOC2_CONTROLS.md` — TSC mapping for each control cited.
- `KEY_ROTATION.md` — rotation runbooks for the encryption keys named here.
- `AUDIT_LOG_ARCHITECTURE.md` — deeper design of the hash chain.
