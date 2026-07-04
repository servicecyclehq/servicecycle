# Retention Enforcement — Design & Migration Plan

**Version:** 1.0 (design; implementation pending)
**Effective date:** 2026-07-04 (design), TBD (implementation)
**Owner:** Dustin
**SOC 2 mapping:** C1.2 (disposes of confidential information), CC5.2 (general controls over technology).

**Status:** ⏳ NOT YET IMPLEMENTED. Closes H4 in `SOC2_READINESS_CHECKLIST.md` when shipped.
**Companion:** `docs/compliance/DATA_RETENTION_MATRIX.md` (the policy).

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
