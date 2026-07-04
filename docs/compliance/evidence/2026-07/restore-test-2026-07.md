---
date: 2026-07-06
reviewer: Dustin
scope: Monthly restore test — July 2026
outcome: (fill from restoreTest cron output)
next-review: 2026-08-01
artifacts:
  - restore-test-cron-log-2026-07-06.txt   # capture from `docker logs servicecycle-server 2>&1 | grep restoreTest`
---

# Restore Test — 2026-07

The monthly restore test runs automatically via the `restoreTest` cron in `server/index.ts` at 04:00 UTC on the first Sunday of the month (2026-07-05).

For deep restore against a sidecar Postgres, the `deepRestoreTest` cron runs at 05:00 UTC on the 1st of the month (2026-07-01), gated on `PG_TEST_DB_URL` being set.

## Backup used

- **Backup date**: 2026-07-05 nightly backup (or most recent prior successful backup)
- **Backup file**: `<bucket>/<path>/2026-07-05.pgdump.gz.age`
- **Backup encryption key ID**: `BACKUP_ENCRYPTION_KEY`

## Automated result (fill from cron log)

```
[ paste `restoreTest` cron output here — should be one JSON summary line ]
```

The cron writes `activity_log` entries; query at month-end via:
```bash
GET /api/activity/export?since=2026-07-01&filter=restoreTest
```

## Manual verification (recommended each month, ~ 3 min via SSH or vps-control MCP)

```bash
# 1. Confirm the cron actually fired
docker logs servicecycle-server 2>&1 | grep -E "\[Cron\] .*[Rr]estore" | tail -20

# 2. Confirm the healthchecks.io ping succeeded
# (visit the SC-nightly-backup or SC-restore-test check on healthchecks.io)

# 3. Confirm backup blobs on target
# (log into the S3-compatible target; verify latest object age ≤24h)
```

## Result

- [ ] `restoreTest` cron fired at 04:00 UTC on Sunday.
- [ ] Backup decrypted successfully.
- [ ] `pg_restore` succeeded (wire-format check).
- [ ] Restored DB is readable.
- [ ] Row counts within expected range vs. previous month:
  - Account: N
  - User: N
  - Asset: N
  - TestReport: N
  - ActivityLog: N
- [ ] Audit chain verifier passes against restored DB (nightly `activityLogChainVerify` at 03:45).
- [ ] Restored DB cleaned up after verification.
- [ ] Healthchecks.io ping received.

## Duration

- Decrypt: (from cron log)
- Restore: (from cron log)
- Verify: (from cron log)
- Cleanup: (from cron log)
- **Total: (sum)**

## Anomalies

- (none) — or list.

## Actions

- (none) — or list follow-ups.

## Approval

Automated run + reviewed by Dustin on 2026-07-06 (or later date when confirmed).

---

**Note:** first month; establishes the pattern. Monthly cadence scheduled task pings on 2026-08-01 to close this file out with confirmed numbers.
