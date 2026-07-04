---
date: 2026-07-31
reviewer: Dustin
scope: Secure disposal summary for July 2026
outcome: (fill on close-out)
next-review: 2026-08-31
---

# Secure Disposal — 2026-07

Follows `docs/security/SECURE_DISPOSAL_LOG.md`. First entry; establishes the pattern. Close out at end of month via the monthly cadence (or when the scheduled task fires on 2026-08-01).

## Backup archive age-out (S3)

| Bucket | Lifecycle rule verified? | Objects expired this month | Oldest remaining object |
|---|---|---|---|
| (S3 target from `SECRETS_INVENTORY.md`) | [ ] verify via provider console | (query at month-end) | (should be ≤30 days) |

**How to verify** (~ 2 min):
- Log in to the S3-compatible provider (Backblaze or configured target).
- Navigate to the backup bucket.
- Check the Lifecycle rule is still active and set to 30-day expiry.
- Screenshot for the evidence file.

## Application log rotation (droplet)

Rotation is handled by droplet logrotate. Verify oldest surviving log is ≤ 90 days.

| Path | Logrotate config verified? | Files rotated this month | Oldest remaining |
|---|---|---|---|
| `/var/log/nginx/` | [ ] | (query at month-end) | (target ≤90d) |
| `/var/lib/docker/containers/` | [ ] | (query at month-end) | (target ≤90d) |

**How to verify** (~ 1 min via SSH or vps-control MCP):
```bash
ls -la /var/log/nginx/ | head -5
docker system df
```

## Application-level retention prunes

From the nightly cron cascade (`server/index.ts` 03:00–03:55 UTC). Each cron logs `retention_pruned`-style events to the activity chain; count via `GET /api/activity/export` filtered on `action IN ('retention_pruned', ...)`.

| Class | Cron | Retention | Rows deleted this month | Activity chain refs |
|---|---|---|---|---|
| `ActivityLog` | 03:00 activityLogPrune | 365d | (query at month-end) | see `activity_log_pruned` events |
| `NotificationLog` | 03:05 notificationLogPrune | 180d | (query at month-end) | inline log |
| `BackupLog` | 03:15 backupLogPrune | 180d | (query at month-end) | see `backup_log_pruned` events |
| `RefreshToken` | 03:20 refreshTokenPrune | 30d | (query at month-end) | inline log |
| `EarlyAccessRequest` | 03:35 earlyAccessPrune | expires-based | (query at month-end) | inline log |
| `OutboundWebhookDLQ` | 03:40 webhookDlqPrune | 30d | (query at month-end) | inline log |
| `TelemetryReading` | 03:50 telemetryReadingPrune | 365d | (query at month-end) | inline log |
| `ExtractionEvent` | 03:51 extractionEventPrune | 180d | (query at month-end) | inline log |
| `RenderError` | 03:52 renderErrorPrune | 30d | (query at month-end) | inline log |
| `AiUsage` | 03:55 prune-ai-usage | 90d | (query at month-end) | inline log |

## Data-subject-driven deletions this month

| Date | Request type | Accounts affected | Rows deleted | Activity chain event |
|---|---|---|---|---|
| (none this month) — or list | | | | |

## Anomalies

- (none) — or list.

## Actions

- (none) — or list follow-ups.

## Approval

Reviewed and signed by Dustin on YYYY-MM-DD (fill on close-out).

---

**Note:** first month; establishing the pattern. In future months, the monthly cadence scheduled task will remind on the 1st to close out the previous month's file.
