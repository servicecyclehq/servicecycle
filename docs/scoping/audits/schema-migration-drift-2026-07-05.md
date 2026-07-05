# Schema / Migration-History Drift Audit

Date: 2026-07-05
Scope: Investigation only — no schema or migration files changed. Per the
handoff prompt: "Daylight investigation only — no schema changes without
Dustin reviewing the finding first."

## Method

Every `prisma migrate diff` shadow-DB run across the 2026-07-05 multi-day
effort surfaced the same 4-table drift, each time deliberately excluded from
that session's own (unrelated) migration file. This session reproduced it
directly to get a definitive answer instead of re-flagging it a fourth time.

Created two throwaway local Postgres databases (`sc_drift_check` as the
target, `sc_drift_shadow` as Prisma's required shadow DB), then ran:

```
npx prisma migrate diff --from-migrations ./prisma/migrations \
  --to-schema-datamodel ./prisma/schema.prisma \
  --shadow-database-url postgresql://postgres:postgres@localhost:5432/sc_drift_shadow \
  --script
```

This replays the entire migration history into a real database and diffs
the *result* against what `schema.prisma` currently declares — the same
check `prisma migrate dev` would run before generating a new migration.
Both databases were dropped immediately after. No real (dev/prod) database
was touched.

## Finding: two different things are being lumped together as "drift"

**1. `access_blockers` (5 DropForeignKey) + `drawing_page_texts` (DropIndex +
AlterTable) — NOT drift. This is the expected, permanent signature of a
deliberate architecture pattern. Do not "fix" it.**

- `AccessBlocker` (`schema.prisma` ~line 1720) is a documented **scalar-only
  model by design** — its own comment reads: *"Scalar-only by design (no
  Prisma relations) so it adds zero churn to Account/Site/Asset/User;
  referential integrity + tenant-cascade is enforced by the SQL foreign keys
  in migration 20260619000000_access_blockers."* The 5 foreign keys exist for
  real in Postgres; Prisma's schema has no `@relation` fields to describe
  them (that was the point — keeping a high-blast-radius table decoupled
  from the four core models). Every diff will propose dropping them because
  Prisma only reconciles what it can see in the schema DSL.
- `DrawingPageText.tsvector` (EDMS Phase 1, `20260705_edms_phase1_scaffold`)
  is a hand-written Postgres `GENERATED ALWAYS AS (to_tsvector(...)) STORED`
  column + GIN index — functionally verified against a shadow DB when it was
  built (2026-07-05 overnight session). Prisma's schema can only express
  this column as `Unsupported("tsvector")?`, which has no way to declare
  "generated" or the GIN index. Same root cause as above: a real, deliberate
  raw-SQL addition invisible to the schema DSL.
- **Applying either of these diffs would be a regression** — it would drop
  real referential-integrity enforcement and a real search index that are
  working exactly as designed. This is why every session so far has
  correctly excluded them from new migrations rather than "fixing" them.
  **Recommendation: never apply this half of the diff. It will re-appear on
  every future `migrate diff` run for as long as this scalar-only-relations
  / raw-SQL-generated-column pattern is used — that recurrence is expected,
  not a signal something is wrong.**

**2. `failed_login_attempts`, `rate_sheet`, `work_order_part_usages`,
`WorkOrder` (RenameConstraint / RenameForeignKey / RenameIndex only) — real,
but purely cosmetic, naming-only drift. Zero functional risk.**

- Every operation in this half is a bare Postgres `RENAME` — no
  `DropForeignKey`/`DropIndex`/`AlterTable ... TYPE` involving data. The
  actual DB objects are byte-identical in structure; only their SQL-level
  names differ (e.g. `FailedLoginAttempt_pkey` vs. the current Prisma
  default `failed_login_attempts_pkey`).
- Root cause: each of these 4 models carries `@@map("<snake_case_table>")`,
  but the constraints/indexes were created (in an earlier migration, under
  an earlier Prisma version or before the `@@map` existed) using Prisma's
  then-default naming, which is based on the **model name**, not the
  **mapped table name**. Current Prisma computes default constraint/index
  names from the mapped table name instead, so a fresh `prisma migrate dev`
  today would name them differently than history already did. `WorkOrder`
  only has ONE stale index (`WorkOrder_accountId_status_completedDate_idx`)
  — its other constraints already use the current naming, confirming this
  accumulated incrementally across different migration eras rather than
  indicating one big one-time break.
- **This is safe to formalize into a single no-op migration whenever
  convenient** — a `RENAME CONSTRAINT` / `RENAME INDEX` is metadata-only: no
  table lock beyond a brief catalog update, no data rewrite, no behavior
  change, fully reversible. It is **not urgent** — Postgres doesn't care what
  a constraint is named for correctness, so leaving it as-is carries no risk
  either. The only cost of leaving it alone is that it will keep showing up
  in this same diff every time, which is exactly what created the "is this
  safe?" question this audit was scoped to answer.
- Exact SQL for a future formalizing migration (validated by replaying the
  full migration history into a real Postgres and taking Prisma's own
  diff output verbatim — not hand-written):

  ```sql
  ALTER TABLE "failed_login_attempts" RENAME CONSTRAINT "FailedLoginAttempt_pkey" TO "failed_login_attempts_pkey";
  ALTER TABLE "rate_sheet" RENAME CONSTRAINT "RateSheet_pkey" TO "rate_sheet_pkey";
  ALTER TABLE "work_order_part_usages" RENAME CONSTRAINT "WorkOrderPartUsage_pkey" TO "work_order_part_usages_pkey";
  ALTER TABLE "work_order_part_usages" RENAME CONSTRAINT "WorkOrderPartUsage_accountId_fkey" TO "work_order_part_usages_accountId_fkey";
  ALTER TABLE "work_order_part_usages" RENAME CONSTRAINT "WorkOrderPartUsage_partId_fkey" TO "work_order_part_usages_partId_fkey";
  ALTER TABLE "work_order_part_usages" RENAME CONSTRAINT "WorkOrderPartUsage_workOrderId_fkey" TO "work_order_part_usages_workOrderId_fkey";
  ALTER INDEX "FailedLoginAttempt_attemptedAt_idx" RENAME TO "failed_login_attempts_attemptedAt_idx";
  ALTER INDEX "FailedLoginAttempt_email_idx" RENAME TO "failed_login_attempts_email_idx";
  ALTER INDEX "WorkOrderPartUsage_accountId_idx" RENAME TO "work_order_part_usages_accountId_idx";
  ALTER INDEX "WorkOrderPartUsage_partId_idx" RENAME TO "work_order_part_usages_partId_idx";
  ALTER INDEX "WorkOrderPartUsage_workOrderId_idx" RENAME TO "work_order_part_usages_workOrderId_idx";
  ALTER INDEX "WorkOrder_accountId_status_completedDate_idx" RENAME TO "work_orders_accountId_status_completedDate_idx";
  ```

## Recommendation

- **No action needed** on `access_blockers` / `drawing_page_texts` — keep
  excluding them from future migrations exactly as every session has done.
  Worth a one-line comment at the top of `schema.prisma` (or in
  `docs/INGESTION_ARCHITECTURE.md`/a CONTRIBUTING note) saying "these two
  will always show up in `migrate diff`, by design — do not apply that
  part," so a future session doesn't re-spend time re-diagnosing this.
- **Optional cleanup** for the 4-table rename drift: a single tiny
  no-op-functionally migration (SQL above) whenever Dustin wants the diff to
  go fully quiet. Not blocking anything, not risky, not urgent — purely
  cosmetic. Did not apply it in this session per the "no schema changes
  without Dustin reviewing first" instruction.
