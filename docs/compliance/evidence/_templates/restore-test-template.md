---
date: YYYY-MM-DD
reviewer: Dustin
scope: Monthly restore test — YYYY-MM
outcome: pass | fail
next-review: <first of next month>
artifacts:
  - restore-test-run-log-YYYY-MM-DD.txt
  - restored-db-checksum-YYYY-MM-DD.txt
  - audit-chain-verify-restored-YYYY-MM-DD.txt
---

# Restore Test — YYYY-MM

## Backup used

- **Backup date**: YYYY-MM-DD (nightly at 02:00 UTC)
- **Backup file**: `<bucket>/<path>/YYYY-MM-DD.pgdump.gz.age`
- **Backup size**: <N MB>
- **Backup encryption key ID**: BACKUP_ENCRYPTION_KEY (current or OLD_)

## Restore procedure

Runs automatically via `server/lib/restoreTest.ts` on the 1st of the month.
Manual invocation: `node server/scripts/runRestoreTest.js`

## Result

- [x] Backup decrypted successfully.
- [x] `pg_restore` succeeded.
- [x] Restored DB is readable (test connect + SELECT 1).
- [x] Row counts within expected range vs. previous month:
  - Account: N
  - User: N
  - Asset: N
  - TestReport: N
  - ActivityLog: N
- [x] Audit chain verifier runs successfully against restored DB.
- [x] `MASTER_KEY`-encrypted rows decrypt correctly against current master key (or documented OLD_MASTER_KEY window).
- [x] Restored DB cleaned up after verification.

## Duration

- Decrypt: <N seconds>
- Restore: <N seconds>
- Verify: <N seconds>
- Cleanup: <N seconds>
- **Total: <N seconds>**

## Anomalies

- (none) — or list.

## Actions

- (none) — or list follow-ups.

## Approval

Automated run + reviewed by Dustin on YYYY-MM-DD.
