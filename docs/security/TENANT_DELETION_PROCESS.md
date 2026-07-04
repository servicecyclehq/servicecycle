# Tenant Deletion Process

**Version:** 1.0
**Effective date:** 2026-07-04
**Next review:** 2027-01-04
**Owner:** Dustin
**SOC 2 mapping:** C1.2 (disposes of confidential information), CC6.4 (manages changes to access).

Where `docs/security/PRIVACY_REQUESTS.md` covers the customer-facing SLAs and
verification flow, this doc is the **operational script**: exactly how a
tenant's data is wiped, and how we prove the wipe was complete.

**Companion:**
- `docs/OFFBOARDING.md` — customer-facing description of what happens.
- `docs/security/PRIVACY_REQUESTS.md` — request intake + verification.
- `docs/compliance/DATA_RETENTION_MATRIX.md` — what gets deleted per class.

---

## When this runs

- Customer initiates account close from admin console.
- SC initiates contract termination (offboarding).
- Data-subject erasure request per `PRIVACY_REQUESTS.md`.

## Pre-flight

Before deleting anything:

1. **Verification** — confirm the requester's identity per `PRIVACY_REQUESTS.md` §Verification.
2. **Export** — if requester asked for an export, complete the export FIRST. Store encrypted; send passphrase out-of-band.
3. **Confirmation** — get written (email) confirmation of scope. Choices:
   - Whole account.
   - One user only.
   - Specific record set.
4. **Snapshot** — take a targeted snapshot of the tenant's rows (encrypted, held 30 days) in case the deletion needs to be reversed within the SLA window.
5. **Backup verification** — confirm last nightly backup succeeded and includes this tenant (so if we mis-delete adjacent data, we can restore just that tenant).

## Deletion sequence

Run in this order — it minimizes cross-tenant risk:

### 1. Freeze the tenant

- Set `Account.deletedAt = NOW()` and `Account.suspendedAt = NOW()`.
- Bump `tokenEpoch` on every user in the account (revokes all outstanding sessions).
- API returns 410 Gone for any future request scoped to this account.

### 2. Purge dependent records (in FK order)

For every table with an `accountId` column, execute batched deletes:

```sql
-- Example for one class; repeat for each:
DELETE FROM "TestReport" WHERE "accountId" = $1;
DELETE FROM "ArcFlashStudy" WHERE "accountId" = $1;
DELETE FROM "LotoProcedure" WHERE "accountId" = $1;
DELETE FROM "WorkOrder" WHERE "accountId" = $1;
DELETE FROM "Deficiency" WHERE "accountId" = $1;
DELETE FROM "Asset" WHERE "accountId" = $1;
DELETE FROM "Site" WHERE "accountId" = $1;
DELETE FROM "QuoteRequest" WHERE "accountId" = $1;
DELETE FROM "PartCatalog" WHERE "accountId" = $1;
DELETE FROM "SpareInventory" WHERE "accountId" = $1;
DELETE FROM "AiUsage" WHERE "accountId" = $1;
DELETE FROM "LoginFailure" WHERE "accountId" = $1;
DELETE FROM "AdminSetting" WHERE "accountId" = $1;
DELETE FROM "EncryptedKey" WHERE "accountId" = $1;
DELETE FROM "User" WHERE "accountId" = $1;
DELETE FROM "Account" WHERE "id" = $1;
```

Every DELETE is a batched operation (LIMIT 1000; loop until 0 rows affected).

**Order note:** the exact FK order depends on the current schema; the source of truth is `server/prisma/schema.prisma`. Before running this in prod, dry-run against a restored snapshot to confirm order.

### 3. Audit chain — special handling

The tamper-evident activity chain does not delete rows (would break the hash chain). Instead:

- Redact each row's payload to `{ "redacted": "data-subject-erasure", "requestId": "<hash>", "date": "<YYYY-MM-DD>" }`.
- `rowHash` + `prevHash` remain intact.
- Nightly verifier still passes because the hash is over the row's outer envelope, which is unchanged.
- Log a `data_subject_erasure` event (CEF sev 7) marking the redaction.

Documented in `docs/AUDIT_LOG_ARCHITECTURE.md` and `PRIVACY_REQUESTS.md`.

### 4. Uploaded files

For each file the tenant uploaded (test reports, arc-flash studies, nameplate images):

- Delete from local storage (droplet volume).
- Delete from any object-storage bucket.
- If field-level encryption was on (`ENCRYPT_DOCS`), also purge the tenant's `EncryptedKey` rows so the ciphertext is unrecoverable.

### 5. Backup age-out

Live deletion doesn't touch backups. The 30-day rolling backup window ages the tenant's data out automatically. To communicate honestly:

- Tell the requester: "Live data deleted today. Backup copies age out within 30 days."
- If the customer requires shorter backup age-out (e.g., contractual), we take a fresh backup, exclude the tenant, and forcibly purge older backups. Document as an exception in `SECURITY_DECISIONS.md`.

### 6. Confirmation

- Send confirmation email to the requester with:
  - Live-deletion timestamp.
  - Backup age-out target date (today + 30 days).
  - Reference to `docs/OFFBOARDING.md` for the public statement of what was deleted.

### 7. Log

Write two entries:

- Activity chain event `tenant_deleted` (CEF sev 7): actor, requester identity hash, timestamp, table row counts.
- Evidence file at `docs/compliance/evidence/YYYY-MM/tenant-deletion-YYYY-MM-DD-<hash>.md` with the frontmatter template.

## Verification (after)

Run this SQL against prod to confirm no residual rows:

```sql
SELECT
  'Account' AS table_name, COUNT(*) AS remaining
FROM "Account" WHERE "id" = $1
UNION ALL
SELECT 'Asset', COUNT(*) FROM "Asset" WHERE "accountId" = $1
UNION ALL
SELECT 'User', COUNT(*) FROM "User" WHERE "accountId" = $1
-- repeat for every accountId-scoped table
;
```

All rows should return 0. If any row is non-zero, that's an incident — investigate the FK order and re-run the missed classes.

## Rollback window

Within 30 days of deletion (backup retention window), a customer can request restoration only if:

- The deletion was reported as an error by the customer within 24 hours, AND
- They can verify identity per `PRIVACY_REQUESTS.md`, AND
- They accept that restoration recreates the state as of the last backup before deletion, not up to the deletion moment.

Restoration procedure:

1. Retrieve latest pre-deletion backup from S3.
2. Restore to a scratch DB.
3. Extract the tenant's rows using the same accountId-scoped selects.
4. Re-insert into prod, taking care not to collide with new IDs.
5. Rebuild `tokenEpoch` and force password reset for all users in the tenant.
6. Confirm to customer with new session credentials.

Document each restoration as an incident record.

## Automation status

At current stage, tenant deletion is a **manual admin operation**. When traffic grows and this becomes routine, wrap the sequence above in a script `server/scripts/deleteAccount.ts` with:

- `--dry-run` flag showing counts without deleting.
- `--verify-only` post-run mode.
- Automatic evidence-file generation.

Track as an enhancement backlog item; not required for SOC 2 Type I readiness.

## Cross-references

- `docs/OFFBOARDING.md` — customer view of offboarding.
- `docs/security/PRIVACY_REQUESTS.md` — request lifecycle.
- `docs/compliance/DATA_RETENTION_MATRIX.md` — what gets deleted per class.
- `docs/AUDIT_LOG_ARCHITECTURE.md` — why audit chain redacts vs. deletes.
- `docs/RISK_ACCEPTANCE_LOG.md` — RAR-001 (audit chain + insider considerations).
