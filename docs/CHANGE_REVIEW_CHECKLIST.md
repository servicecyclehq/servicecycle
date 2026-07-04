# ServiceCycle — Change-Impact Review Checklist

**Version:** 1.1
**Effective date:** 2026-07-04 (v1.1 adds §Solo-founder separation of duties)
**Next review:** 2027-01-04
**Owner:** Engineering (Dustin, at current stage)
**Applies to:** Any PR or deploy that touches: auth/roles, DB schema, public API, security middleware, billing/limits, external integrations, or encryption.

This checklist closes SOC2 CC3.4 (identifies and assesses changes that could affect internal controls). It is not required for routine UI tweaks or copy edits — use judgment.

---

## Solo-founder separation of duties — compensating control

SOC 2 CC8.1 expects segregation between the developer who writes a change, the reviewer who approves it, and the operator who deploys it. ServiceCycle operates as a solo founder at this stage; that deviation is documented in `docs/compliance/RISK_ACCEPTANCE_LOG.md` **RAR-006**.

The compensating controls that stand in for a second reviewer:

1. **Every change is captured in git**, on a public commit history from a signed key (see `docs/security/SIGNED_COMMITS.md`).
2. **Every deploy is audit-logged** to the tamper-evident activity chain, with the founder's identity attached and the commit SHA recorded.
3. **This checklist is run and signed** for any change matching the "when to run" criteria below — the founder's dated sign-off in the PR body is the audit artifact.
4. **CI enforces objective gates** the founder cannot silently bypass: `npm audit --audit-level=high`, `tsc --noEmit`, jest unit + smoke tests, Gitleaks (`.github/workflows/gitleaks.yml`), CodeQL (`.github/workflows/codeql.yml`), Trivy (`.github/workflows/trivy.yml`), verify-signed-commits (`.github/workflows/verify-signed-commits.yml`).
5. **Dependabot + Trivy weekly full-history scans** run without the founder's involvement — they catch decisions the founder didn't make.
6. **Every schema/auth/API PR** requires an explicit note in the PR body confirming the checklist below was mentally executed. Missing note ⇒ deploy is not authorized.

This composite control ("many small independent gates the founder cannot silently disable, plus an append-only audit trail") is what stands in for a second human reviewer. It will be revisited when a second person receives production access (see `docs/PERSONNEL_SECURITY.md`).

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
