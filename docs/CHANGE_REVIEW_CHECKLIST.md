# ServiceCycle — Change-Impact Review Checklist

**Owner:** Engineering  
**Applies to:** Any PR or deploy that touches: auth/roles, DB schema, public API, security middleware, billing/limits, external integrations, or encryption.

This checklist closes SOC2 CC3.4 (identifies and assesses changes that could affect internal controls). It is not required for routine UI tweaks or copy edits — use judgment.

---

## When to run this checklist

Run before merging any PR that:

- Changes Prisma schema or adds/alters DB migrations
- Touches `server/middleware/` (roles, auth, rate limiting, API keys)
- Adds or changes a `/api/v1` public endpoint
- Modifies encryption, key management, or secret handling
- Adds a new external service integration or sub-processor
- Changes audit logging, the activity log schema, or hash-chain logic
- Touches billing, seat limits, or account-level access gates
- Updates Docker images, nginx config, or CI/deploy workflow

---

## Checklist

### 1. Scope and blast radius

- [ ] What is the narrowest change that achieves the goal? (Prefer surgical scope.)
- [ ] Could this affect other tenants' data? If yes, describe the isolation boundary.
- [ ] Are there conditional paths that skip security checks? List them.

### 2. Schema changes

- [ ] Is the migration backward-compatible? (No `NOT NULL` without a default on existing rows; no column drops without a grace period.)
- [ ] Does the new table/column need `accountId` for tenant isolation?
- [ ] Is the migration idempotent? (Safe to replay on a fresh DB via `prisma migrate deploy`.)
- [ ] Have you run `prisma migrate dev` locally and verified `prisma migrate status` is clean on the VPS before deploying?

### 3. Auth / roles / access control

- [ ] Does the new route/action require `requireRole(...)` middleware?
- [ ] Is the `accountId` filter applied on every DB query that returns customer data?
- [ ] If scopes were added to the v1 API, are the new scopes added to the OpenAPI spec and CHANGELOG?
- [ ] Have IDOR tests been run or added (`server/tests/idor.test.js`)?

### 4. External dependencies

- [ ] Is a new npm package being added? Run `npm audit` and check the package's supply-chain health (last publish date, download count, known CVEs).
- [ ] Is a new external service being called? Add it to the sub-processor list (`docs/OFFBOARDING.md` §6).
- [ ] Does the service receive PII? If so, does it have a DPA or privacy shield? Note in the sub-processor list.

### 5. Audit trail

- [ ] Are security-relevant actions (data access, exports, role changes) logged to `activityLog`?
- [ ] If an activityLog schema field changes, does the existing hash-chain still verify?

### 6. Rollback

- [ ] Is the change reversible? (Additive API fields: yes. Column drops or data migrations: no — describe the rollback path.)
- [ ] Is there a `docs/DEPLOY_RUNBOOK.md` step that needs updating?

### 7. Test coverage

- [ ] Are there new integration tests covering the happy path and at least one auth-failure path?
- [ ] Does CI pass locally (`tsc --noEmit` + `jest`)?

---

## Sign-off

| Reviewer | Date | Notes |
|---|---|---|
| | | |

For changes with broad impact (auth refactor, new encryption scheme, schema renames), request a second reviewer. For solo-developer contexts, document the self-review rationale in the PR description.
