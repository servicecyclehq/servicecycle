# Release Verification Checklist

**Version:** 1.0
**Effective date:** 2026-07-04
**Next review:** 2027-01-04
**Owner:** Dustin
**SOC 2 mapping:** CC8.1 (change management).
**When it runs:** before every release tag (or every deploy that is release-shaped).

Where `CHANGE_REVIEW_CHECKLIST.md` runs per-PR for security-sensitive PRs, this runs per-release. Consolidates the discipline items scattered across `DEPLOY_RUNBOOK.md`, `CHANGE_REVIEW_CHECKLIST.md`, and the various CI gates.

**Companion:**
- `docs/DEPLOY_RUNBOOK.md` (operational steps)
- `docs/CHANGE_REVIEW_CHECKLIST.md` (per-PR security review)
- `.github/workflows/release-tag.yml` (auto-tags on version bump)
- `.github/workflows/release-evidence.yml` (archives SBOMs + scans on tag)

---

## Before you type `git tag` (or bump `server/package.json` version)

### Tests + CI
- [ ] `ci.yml` green on the commit you're about to release.
- [ ] `gitleaks.yml` green on the same commit.
- [ ] `codeql.yml` green on the same commit (or in-flight scheduled run has completed).
- [ ] `trivy.yml` fs-scan green; `image-scan` will run on tag push.
- [ ] `verify-signed-commits.yml` green (once branch protection is on).
- [ ] Integration tests (jest `integration` project) run manually if the PRs since last release touched: auth, roles, tenant scope, encryption, ingest, arc-flash, or activity chain.

### Migrations
- [ ] Every migration since last release is backward-compatible per `CHANGE_REVIEW_CHECKLIST.md` §2.
- [ ] `prisma migrate status` is clean on staging (or dry-run on prod backup).
- [ ] No `NOT NULL` on existing table without a default.
- [ ] No column drops without a two-release deprecation.

### Dependencies
- [ ] `npm audit --audit-level=high` clean on both server and client.
- [ ] Any HIGH/CRITICAL CVEs added to `.trivyignore` since last release have a corresponding entry in `docs/security/DEPENDENCY_DECISIONS.md`.
- [ ] Any new direct dependencies added since last release have their own entry in `DEPENDENCY_DECISIONS.md`.

### Changelog
- [ ] `CHANGELOG.md` has an `[Unreleased]` section with a bullet per meaningful change.
- [ ] Every bullet answers: what changed, why, commit SHA if useful.
- [ ] Every entry that touched policy or SOC 2 posture is called out explicitly.

### Version bump
- [ ] `server/package.json` version bumped per semver rules:
  - PATCH — bug fix, no schema change, no API contract change.
  - MINOR — new feature, additive schema, backward-compatible API.
  - MAJOR — breaking API change, non-backward-compatible schema, auth model change.
- [ ] `client/package.json` version bumped to match (or synced per convention).

### Rollback path
- [ ] The DEPLOY_RUNBOOK's rollback path is up to date for what's in this release.
- [ ] For any DB migration, the rollback is either:
  - reversible (no-op or safe reverse migration), OR
  - forward-only with a documented data-repair procedure.
- [ ] For any new external integration, the fallback plan is documented in `docs/security/BC_PLAYBOOKS.md`.

### Data + security
- [ ] Any new fields storing customer data are labeled with their data-classification tier per `DATA_CLASSIFICATION.md`.
- [ ] Any new AI provider integration is documented in `VENDOR_SECURITY_REVIEW.md` + `SECRETS_INVENTORY.md`.
- [ ] Any new endpoint that returns customer data has `authenticateToken` + tenant-scope predicate + integration test.

### Docs
- [ ] `docs/SOC2_CONTROLS.md` updated if the release closes a gap or introduces a new control.
- [ ] `docs/security/SECURITY_DECISIONS.md` has entries for any material decision made this cycle.
- [ ] `docs/api/` OpenAPI spec updated if the public API changed.

---

## Release-time

1. Merge to `main`.
2. Bump `server/package.json` version + `CHANGELOG.md` `[Unreleased]` promoted to `[X.Y.Z]` with today's date.
3. Push to `main`.
4. `.github/workflows/release-tag.yml` fires and creates `vX.Y.Z` git tag + GitHub Release.
5. `.github/workflows/release-evidence.yml` fires on the tag and attaches SBOMs + npm audit + Trivy scan + `MANIFEST.md` to the release.
6. `.github/workflows/deploy.yml` fires and deploys to prod.

## Post-release

- [ ] Deploy health check green (`GET /api/health` returns 200).
- [ ] Better Stack synthetic still green.
- [ ] Nothing broken in `docs/security/MONITORING_MATRIX.md` D-section signals.
- [ ] Activity chain nightly verifier still passes.
- [ ] First customer scan / test-report / arc-flash after deploy succeeds.

## If anything is broken

Follow rollback per `docs/DEPLOY_RUNBOOK.md`. Open an incident record per `docs/compliance/incidents/README.md`.

---

## Copy-paste PR-body / release-notes stub

Use this to sign off the release verification in the release PR body or the CHANGELOG entry:

```markdown
## Release verification — vX.Y.Z (YYYY-MM-DD)

- [x] CI green (ci, gitleaks, codeql, trivy, verify-signed-commits).
- [x] Migrations reviewed.
- [x] `npm audit` clean.
- [x] CHANGELOG entries added.
- [x] Version bumped per semver.
- [x] Rollback path documented.
- [x] Data classification labels applied to new fields.
- [x] Docs updated (SOC2_CONTROLS, SECURITY_DECISIONS, api/).

Reviewed by Dustin on YYYY-MM-DD.
```
