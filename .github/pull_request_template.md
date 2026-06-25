## What this PR does

<!-- One paragraph. What changed and why. -->

## Checklist

### Always
- [ ] `tsc --noEmit` passes locally
- [ ] `npm test` passes (or explain below why tests were skipped)
- [ ] PR description explains the change, not just the diff

### Run if this PR touches auth, DB schema, public API, security middleware, billing, or external integrations

#### Scope
- [ ] Change is as narrow as possible — no unrelated edits bundled in
- [ ] No code path skips a security check without documentation

#### Schema changes
- [ ] Migration is backward-compatible (no `NOT NULL` without a default on existing rows; no column drops without a grace period)
- [ ] New tables/columns include `accountId` for tenant isolation
- [ ] Migration is idempotent — safe to replay via `prisma migrate deploy`
- [ ] `prisma migrate status` is clean on VPS before deploying

#### Auth / roles / access control
- [ ] New routes have `requireRole(...)` middleware
- [ ] Every DB query filtering customer data includes `accountId`
- [ ] New API scopes added to OpenAPI spec and CHANGELOG
- [ ] IDOR tests run or added (`server/tests/idor.test.js`)

#### External dependencies
- [ ] New npm packages: `npm audit` clean, supply-chain checked (publish date, download count, CVEs)
- [ ] New external services added to sub-processor list (`docs/OFFBOARDING.md` §6)
- [ ] PII-receiving services have a DPA

#### Audit trail
- [ ] Security-relevant actions logged to `activityLog`
- [ ] ActivityLog schema changes do not break the hash chain

#### Rollback
- [ ] Change is reversible, OR rollback path is documented here
- [ ] `docs/DEPLOY_RUNBOOK.md` updated if the deploy procedure changed

## Notes for reviewer

<!-- Anything non-obvious. Known limitations. Follow-up items. -->
