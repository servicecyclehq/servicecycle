# Retention Enforcement — Design & Migration Plan

**Version:** 1.0 (design; implementation pending)
**Effective date:** 2026-07-04 (design), TBD (implementation)
**Owner:** Dustin
**SOC 2 mapping:** C1.2 (disposes of confidential information), CC5.2 (general controls over technology).

**Status:** ✅ **ALREADY SHIPPED** — this doc was originally written as a forward-looking design under the false assumption that no retention enforcement existed. In fact SC has had comprehensive nightly retention crons wired since well before this SOC 2 sweep began. The section below is kept as reference. See §Actual state as of 2026-07-04 for the truth.

**Companion:** `docs/compliance/DATA_RETENTION_MATRIX.md` (the policy).

---

## Actual state as of 2026-07-04

Discovered during the SOC 2 sweep on 2026-07-04: `server/index.ts` already registers a full nightly retention cascade between 03:00 and 03:55 UTC (chosen to sit between the 02:00 backup and the 03:30 demo reset). Every job wraps in `runOnce()` for single-instance guarantees and pings healthchecks.io on completion.

| Cron | Slot | Retention | Configurable via | Handler |
|---|---|---|---|---|
| `activityLogPrune` | 03:00 | 365d | `ACTIVITY_LOG_RETENTION_DAYS` | `server/lib/activityLogPrune.ts` |
| `notificationLogPrune` | 03:05 | 180d | inline | `server/index.ts` |
| `backupLogPrune` | 03:15 | 180d | `BACKUP_LOG_RETENTION_DAYS` | `server/lib/backupLogPrune.ts` |
| `refreshTokenPrune` | 03:20 | 30d | inline | `server/index.ts` |
| `demoPrune` (hourly) | :25 | inactivity-based | `DEMO_MODE=true` | `server/lib/demoPrune.ts` |
| `demoReset` | 03:30 | daily | `DEMO_MODE=true` | `server/scripts/seed-demo` |
| `earlyAccessPrune` | 03:35 | expires-based | inline | `server/lib/earlyAccessPrune.ts` |
| `webhookDlqPrune` | 03:40 | 30d | `WEBHOOK_DLQ_RETENTION_DAYS` | `server/lib/webhookDlqPrune.ts` |
| `telemetryReadingPrune` | 03:50 | 365d | `TELEMETRY_READING_RETENTION_DAYS` | inline |
| `extractionEventPrune` | 03:51 | 180d | `EXTRACTION_EVENT_RETENTION_DAYS` | inline |
| `renderErrorPrune` | 03:52 | 30d | `RENDER_ERROR_RETENTION_DAYS` | inline |
| `prune-ai-usage` | 03:55 | 90d | inline | inline |

This satisfies SOC 2 C1.2 (disposes of confidential information) and CC5.2 (general controls over technology) with automated enforcement AND per-cron single-instance protection.

## Follow-up decisions (design vs. implementation delta)

Two tension points where the existing code differs from what I documented earlier in this SOC 2 sweep:

**1. ActivityLog: delete vs. redact for hash-chain preservation.**

- `DATA_RETENTION_MATRIX.md` and `PRIVACY_REQUESTS.md` describe the audit chain as "append-only in intent; rows are redactable for GDPR while `rowHash`/`prevHash` remain intact." The design implication is that time-based retention should also redact rather than hard-delete, to preserve chain continuity.
- `activityLogPrune.ts` currently hard-deletes any activity_logs row older than 365 days.
- Consequence: the hash chain becomes discontinuous at the 365-day boundary (the row at day 366 references a `prevHash` for a row that no longer exists). The nightly `activityLogChainVerify` cron either treats this as expected (walks only within-retention rows) or flags it as a chain break.
- **Decision needed at next security session**: reconcile these. Either (a) verify the chain verifier is retention-aware and this is intentional, or (b) switch `pruneActivityLog` to a redact-in-place strategy. Log the outcome in `SECURITY_DECISIONS.md`.

**2. AI usage retention: 90 days vs. 12 months.**

- `DATA_RETENTION_MATRIX.md` documented "12 months live for cost analysis, then aggregate-only."
- `prune-ai-usage` cron deletes rows at 90 days.
- The schema shows `AiUsage` is **already aggregated** to `(userId, action, day, count)` — there is no "detailed row + aggregate row" duality; every row is already daily aggregate.
- **Decision**: adopt 90 days as the effective policy — update `DATA_RETENTION_MATRIX.md` to match. The 12-month plan was based on an incorrect assumption about detailed vs aggregate rows.

Both follow-ups are documentation-consistency work, not new code.

---

## Original forward-looking design (kept for historical reference)

The remainder of this document was written before the discovery above. It described a planned `retentionSweeper` job. That work is redundant with the existing crons — do not implement.

---

---

## Goal

Enforce the retention windows in `DATA_RETENTION_MATRIX.md` automatically —
today, retention is documented but not enforced. Auditors accept documented
retention; they prefer enforced.

## Scope for v1

Only auto-prune the **transient** classes where deletion is safe and reversible
from backup:

| Class | Live retention | v1 auto-prune target |
|---|---|---|
| Login-failure events | 12 months | delete >12mo |
| AI call metadata (detailed rows) | 12 months | roll into daily aggregate + delete row |
| Nginx / Docker application logs | 90 days | already handled by logrotate — verify config |
| Backup archives on S3 | 30 days | already handled by S3 lifecycle rule — verify |

**Explicitly out of scope for v1:**

- Customer compliance records (retention is "indefinite while account active" — no auto-delete).
- Audit chain rows (append-only in intent; deletion is a data-subject-request-only event that redacts payload, not rows).
- Customer PII on live accounts (account close triggers deletion; no time-based auto-prune).

## Design

### 1. New scheduled job

A single `retentionSweeper` job runs nightly at 03:00 UTC on the droplet
(after backup at 02:00; before the workday). Implementation lives at
`server/lib/retention/sweep.ts`.

Structure:

```typescript
export async function runRetentionSweep(): Promise<SweepResult> {
  const results: SweepResult = { classes: [] };
  results.classes.push(await pruneLoginFailures());
  results.classes.push(await aggregateAndPruneAiUsage());
  return results;
}
```

Each `prune*` function:

1. Selects rows older than the class's retention window using an **index-friendly** `WHERE createdAt < NOW() - INTERVAL '12 months'`.
2. Batches deletes in chunks of 1000 rows to avoid long transactions.
3. Writes an activity chain entry `retention_pruned` (CEF sev 5) with class + count.
4. Returns `{ class, rowsDeleted, durationMs }` for the summary.

### 2. Idempotency + safety

- Every run is idempotent: if it fails halfway, re-running picks up where it left off (chunked deletes).
- If a chunk fails, the sweep logs the error to the activity chain (`retention_error`, CEF sev 6) and continues with the next class.
- Total sweep duration is capped at 30 minutes; anything longer is skipped and alerted on.

### 3. Feature flag

Env var `RETENTION_ENFORCEMENT_ENABLED=false` by default in v1 rollout.
Once verified in staging (or on a low-traffic account), set to `true` in prod.

### 4. Aggregation for AI usage

Detailed `AiUsage` rows carry per-call metadata (model, tokens, cost, purpose)
and are the most privacy-sensitive to retain long-term. v1 approach:

- Rows older than 90 days: keep individually.
- Rows 90 days–12 months: keep individually (for monthly reports).
- Rows older than 12 months: aggregate into `AiUsageDailyAggregate` (per day, per account, per provider — no user identity) and delete the raw row.

The aggregate is Tier-2 data (operational metadata) — safe to retain indefinitely.

### 5. Data-subject requests

Auto-prune runs BEFORE any manual data-subject request. If a request comes in,
we execute the deletion via `PRIVACY_REQUESTS.md` operational script, which
uses the same underlying deletion primitives — the sweeper does not duplicate
that path.

## Migration plan

1. **Add `AiUsageDailyAggregate` table** via Prisma migration:
   - `accountId`, `date`, `provider`, `model`, `callCount`, `tokenSum`, `costSumCents`.
   - Composite unique on `(accountId, date, provider, model)`.
   - No FK to user (aggregate is user-agnostic).
2. **Add indexes** on `LoginFailure.createdAt` and `AiUsage.createdAt` if not already present.
3. **Deploy the code** with `RETENTION_ENFORCEMENT_ENABLED=false`.
4. **Register the nightly cron** in the droplet crontab or via the existing
   scheduled-jobs mechanism.
5. **Manual dry-run** in prod (dry-run flag reports what would be deleted; no writes).
6. **Enable** by flipping the env var; verify first run's activity chain entry.
7. **Update `docs/SOC2_CONTROLS.md`** C1.2 gap to close.

## Test coverage

- Unit tests for each `prune*` function with mocked Prisma.
- Integration test (real DB) that seeds 100 old + 100 fresh rows, runs the sweep, asserts old rows gone.
- Regression test that the sweep does NOT delete customer compliance records under any circumstance.
- Snapshot test that the aggregate math matches the row-level sum.

## Rollback plan

If the sweep misbehaves after enable:

1. Set `RETENTION_ENFORCEMENT_ENABLED=false` and restart.
2. If rows were incorrectly deleted, restore the affected classes from the previous night's backup (RPO ≤24h).
3. Investigate before re-enabling.

## Cross-references

- `DATA_RETENTION_MATRIX.md` — the policy this enforces.
- `PRIVACY_REQUESTS.md` — manual deletion path.
- `SOC2_CONTROLS.md` C1.2 — the gap being closed.
- `SECURITY_DECISIONS.md` — will record the "aggregate + prune" choice when the migration lands.

## Follow-up (v2, later)

Auto-prune for classes where deletion is more nuanced:

- Session tokens: already handled by `tokenEpoch` on password change; no time-based prune needed.
- Old admin settings: rarely change; not worth v2.
- Old feature flags: kept for git/audit history; not worth v2.

The design above is deliberately narrow so v1 ships in a single day of coding.
