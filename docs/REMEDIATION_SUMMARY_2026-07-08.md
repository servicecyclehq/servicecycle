# ServiceCycle — 2026-07-08 Acquisition Audit Remediation Summary

**Source audit:** `docs/ACQUISITION_AUDIT_2026-07-08.md` (findings) / `docs/AUDIT_PUNCHLIST_2026-07-08.md` (running list)
**Remediation session:** 2026-07-08, single Cowork session, 8 commits on `main`, fanned out across parallel subagents per finding-cluster.
**HEAD before this pass:** `c767b38` · **HEAD after:** `191b08b` (then deployed to prod)

---

## 1. What shipped (with commit SHAs)

### Batch 1 — Schema & migrations — `16e9cb7`
- `TestMeasurement.source`/`confidence` columns (W1-H3): per-reading provenance, populated by Batch 3.
- `ActivityLog.asset` FK `onDelete: Cascade` → `SetNull` (W1-M3), paired with excluding `accountId`/`assetId` from `activityLogChain.ts`'s `canonical()` hash payload (same pattern as the earlier `userId` exclusion) so a legitimate hard-delete no longer reads as tamper. One-time chain re-anchor via a rewritten `scripts/backfill-activity-log-chain.js` (also fixed two independent pre-existing bugs in that script found along the way: a dead `Contract`-model Pass 1, and a missing `.default` on the `lib/prisma` require that made it crash on every run under `tsx`). **Verified locally against `servicecycle_dev`**: migration applied, re-anchor settled all 7,601 rows across 118 account chains, `verifyAllChains()` reports 0 breaks.
- Missing indexes (W1-L13): `ActivityLog.userId`, `PartnerInvite.accountId`, `CustomFieldValue.definitionId`, `WorkOrder.assignedTechId`.
- `Part.[accountId,partNumber]` unique constraint + `SpareInventory` dedupe expression index (W1-L5) — both **guarded** in the migration SQL: skip + log a Postgres `NOTICE` instead of failing the (migrate-gated) deploy if pre-existing duplicates are found. No `NOTICE` fired locally; confirm on prod after this deploy (see §3).
- Deleted stale `server/prisma/partner-flywheel.sql` (unreferenced by any script).
- **Not fixed, deliberately:** the duplicate `20260620130000` migration-timestamp collision (`sso_polis` / `v1_api_writes_scopes`). Both are already applied in every environment; renaming an applied migration folder breaks Prisma's checksum verification and risks a migrate-gated deploy failure. Documented instead of renamed.

### Batch 2 — Domain accuracy — `2e3c038`
- `dgaEvaluate.ts`: reverted C₂H₂ (acetylene) DGA thresholds `[35,50,80]`→`[1,9,35]` ppm (IEEE C57.104-2008 Table 1) — **the ship-first fix**, was under-calling a genuine arcing-fault signal by ~2 condition levels.
- `arcFlashSanity.ts`: IEEE-1584 fault-current validity bound now voltage-class branched (500A–106kA ≤600V, 200A–65kA 601V–15kV), matching the adjacent electrode-gap check; working-distance wording clarified; legacy "Category 0" reworded to "IE < 1.2 cal/cm² (no PPE required)".
- `arcFlashIntegrity.ts`: 5-year review re-cited as NFPA 70E §130.5 mandatory "shall" (was mis-cited as Annex D best practice). Trigger logic unchanged.
- 20 new/extended tests, 72/72 unit + 2/2 integration (real DB) passing.

### Batch 3 — Ingestion/AI provenance — `938ac88`
- `commitTestReport.ts` now populates `TestMeasurement.source`/`confidence` at commit (closes the provenance-dropped-at-commit gap).
- `aiTestReportExtract.ts` + `arcFlashExtract.ts`: extracted document text now routed through the existing `promptSanitize` before prompt concatenation.
- `ai.ts`: wall-clock timeout added to Gemini/OpenAI provider calls (Anthropic/Cloudflare/Groq already had one).
- `testReportPreview.ts` + `ingestWorker.ts`: sha256 dedupe enforced on the `autoCommit` path; `autoCommitError` now routes to `needs_review` instead of a false-success terminal state.
- `ingestConfidenceGate.ts`: auto-commit threshold floored at ≥0.5.
- `aiBudgetGuard.ts`: optional, off-by-default per-account/day AI call+token cap.
- `extractor.py`: `_tofloat()` now rejects ambiguous locale numeric formats (e.g. `"1,5"`) instead of silently mis-parsing them as 15.

### Batch 4 — Security/tenancy/backend — `ec34492`
- `inboundEmail.ts`: per-account sender allowlist (fails closed when unconfigured), uniform 202 response body (no slug/sender enumeration oracle — independently verified byte-identical across all four response paths).
- `settings.ts`: SSRF guard reused on the BYO-storage endpoint; **removed** the no-op encryption toggle (`GET /encryption/status`, `POST /verify-key`, `/enable`, `/disable`) that wrote hash-chained audit events for a control nothing ever read. Real per-tenant gating would touch `documents.ts` + new logic in `fieldRoutes.ts` — out of scope for this pass, tracked as a follow-up. `client/.../EncryptionSection.jsx` reworked to match (static explanation of the real `ENCRYPT_DOCS` env-gate, zero calls to the removed routes — this cross-batch gap was caught and closed in the same pass, see §2).
- `salesRollup.ts`/`sales.ts`: `group_admin` now scoped by `enterpriseGroupId` (kept in `OPERATOR_ROLES` — an existing test asserts it must remain valid).
- `ssoAdmin.ts`: try/catch on 7 previously-bare admin handlers.
- `index.ts`: process-level `unhandledRejection` (log-only) + `uncaughtException` (log+exit) handlers; `earlyAccess` public mount hardened; nightly backup now dumps once per night not once per account; nightly uploads-off-host-sync cron wired in (Batch 5's `runUploadsSync`, folded in here since this file was `index.ts`'s single owner this pass).
- `adminPartnerOrgs.ts`: in-file `requireSuperAdmin` guard for parity.
- `apiIdempotency.ts`: keys scoped to method+path across all 3 real call sites.
- `workOrders.ts`: all status transitions now use the guarded `updateMany`+409 pattern COMPLETE already used; 2 `asset.name` ghost-field fixes.
- `assets.ts`: NaN-checked dates → 400 instead of 500; 2 more ghost-field fixes via new shared `lib/assetLabel.ts` helper (also applied in `arcFlashLabelDoc.ts`).
- `rateCards.ts`: `SERIALIZABLE` transaction + 409-on-conflict (no existing unique constraint to upsert on, contrary to the audit's assumption — verified against schema + migrations before choosing this approach).
- `fleetDashboard.ts`: generic error response.

### Batch 5 — Ops/CI/backups — `c32f2b4`
- `docker-compose.yml` + `.ghcr.yml`: aligned `STORAGE_S3_*`/`BACKUP_S3_*` env-var names to what the code reads (**confirmed live on the droplet before this deploy that the old mismatched names were actually in effect** — see §3); forwarded `BETTERSTACK_*`/`HEALTHCHECKS_*`; ported `/api/ready` healthcheck + `read_only` into the base compose.
- `backup.ts`: fixed the `pfx` temporal-dead-zone crash; `BACKUP_DEST=both` + unconfigured/failed S3 now writes a `BackupLog` failure row + admin alert instead of a false-green warning; added `runUploadsSync()` for nightly off-host sync of `./uploads` (zero off-host document backup existed before this).
- `deploy.yml`: gated on `workflow_run` + CI `conclusion==success`; health check now hits `/api/ready`; `set -euo pipefail`; prunes old plaintext `pg_dump` artifacts. GitHub `production` environment itself needs a repo-admin to create — **flagged for Dustin**, not attempted.
- `ci.yml`: wired the 136-file integration jest project in as **non-blocking** — measured actual pass rate: **368/871 tests (~42%), genuinely broken**, correctly left non-blocking rather than assumed clean; added `npm run openapi:check`; added a jest coverage floor. **Did not** broaden the `./prisma` `moduleNameMapper` regex as originally scoped — verified it breaks 5 real tests that deliberately exploit the current gap; reverted, documented for a proper follow-up.
- `.github/workflows/e2e-scheduled.yml` (new): Playwright e2e wired into a scheduled, non-blocking workflow (hits live prod, basic-auth gated — needs Dustin to add demo credentials as repo secrets if it should actually run green).
- `docs/dr.md`, `docs/observability.md` (new): honest current-state docs, filling two dangling references.

### Batch 6 — Frontend — `c8605d2` (+ `9ded5f2` follow-up for a missed file deletion)
- `AssetDetail.jsx`: unsaved-changes guard (dirty-check + confirm + `beforeunload`), reusing `NewAsset.jsx`'s draft pattern — was silently discarding edits with zero warning (confirmed live during the audit).
- `App.jsx`/`OfflineBanner.jsx`: the false "changes will sync" promise scoped to pre-auth routes only; the two-banners-at-once bug fixed as a side effect.
- `NameplateReview.jsx`: label/id pairs, dialog semantics + focus trap + Escape, AI-flag reasons now rendered as visible text (was touch-invisible tooltip-only).
- `Sidebar.jsx`: role-gated nav links for `/users` and `/permissions` (existed, unreachable before); deleted dead `pages/StubReport.jsx`.
- `useFocusTrap` wired into the 9 dialogs that lacked it across 7 files.
- `e2e/smoke.spec.js` + `audit.spec.js`: route lists rebuilt against the current router (were testing the pre-rebrand surface).
- Removed the unused `@tanstack/react-query` dependency.

### Batch 7 — Docs accuracy — `191b08b`
Corrected 8 diligence docs to match verified current code (each correction re-checked against live code, not the audit's summary): `SOC2_ONE_PAGER.md` (encryption claim + scoreboard), `IP_OWNERSHIP.md` (LGPL disclosure), `ENGINEERING_HANDOFF.md` (prune-job list + restore cadence + scoreboard), `ACQUISITION_BRIEF.md` (DWG conversion), SCIM wording across 7 docs, `api/INTEGRATIONS.md` (spec URLs), and restored `docs/api/openapi.yaml` + regenerated `docs/openapi.json` (the drift-baseline Batch 5's CI step needs).

---

## 2. Cross-batch integration fixes (found and closed in this pass, not part of any single batch)

Running 6 parallel subagents against disjoint file sets surfaced two gaps where one batch's decision had a consequence in another batch's territory. Both were caught and closed before the final commit, not left as follow-ups:

1. **Batch 5's `runUploadsSync()` needed a cron registration in `index.ts`**, which Batch 4 owned exclusively this pass. Folded into `ec34492`.
2. **Batch 4 removed the backend encryption-toggle routes; `client/.../EncryptionSection.jsx` still called all four.** This would have shipped as a broken Settings-page feature (404s on click) if not caught. Reworked the component to a static, honest explanation of the real `ENCRYPT_DOCS` env-gate — no invented API surface. Folded into `ec34492`.

A third issue was caught and fixed **during** Batch 1, not after: the Edit tool's known big-file truncation hazard actually fired on `schema.prisma` (3793→3771 lines, silently dropping the file's tail) partway through the first round of edits. Caught immediately via a post-edit line-count/tail check, restored from `git show HEAD`, and redone via a Python splice script instead — the guardrail the original task brief specifically warned about, and it was real.

---

## 3. Verification performed

- **Local, before any commit:** Batch 1's migration + chain re-anchor run against `servicecycle_dev` (7,601 rows, 118 accounts, 0 breaks after re-anchor); `prisma validate`/`generate` clean.
- **After all 6 parallel batches:** `npx tsc --noEmit` clean (server), `npm run build` clean (client), NUL-byte/line-count scan clean on every big-file-hazard file (`schema.prisma`, `index.ts`, `extractor.py`, `AssetDetail.jsx`).
- **Independent final review** (a fresh subagent with no visibility into the implementation, reading the diff cold): confirmed zero LapseIQ/Forgerift files touched, confirmed the PPE-liability invariant holds end-to-end (not just in the diff hunks), independently re-verified all 6 named security changes against actual code, flagged 2 non-blocking residual findings for a future pass (see §5), **verdict: GO**.
- **Live pre-deploy check (Batch 8):** confirmed via the vps-control MCP that the droplet's `docker-compose.yml` *did* have the old mismatched `STORAGE_S3_ACCESS_KEY_ID`/`BACKUP_S3_ACCESS_KEY_ID` names live in production — this was a real, currently-active bug, not theoretical. Also resolved the audit's "server reports healthy but base compose defines no healthcheck" puzzle: the image's own `Dockerfile` `HEALTHCHECK` (hitting `/api/ready`) was the real source of the "healthy" status; the compose-level healthcheck genuinely was missing and is now added for both layers to agree explicitly. Direct `BackupLog` querying was correctly blocked by the MCP's own security controls (`direct-db` block) — recommend checking recent backup success via the app's own admin UI or after the next 02:00 run.
- **Deploy:** pushed to `origin/main`, pulled on the droplet, `server-migrate`+`server` rebuilt (migration applied, server came up `healthy` on `/api/ready`), client rebuilt and published. Full detail in §4.

---

## 4. Deploy record

- `git push origin main` — clean, no credential issues.
- `git_pull` on droplet — fast-forward to `191b08b`.
- `server-migrate` + `server` rebuilt (`docker compose ... up -d --build server-migrate server`, explicitly including `server-migrate` since this deploy carried a new Prisma migration, unlike a typical code-only deploy) — succeeded, server came up `healthy` on the real `/api/ready` DB probe.
- `deploy_client` — client rebuilt and published to `/var/www/servicecycle/html`.
- Both builds took noticeably longer than the deploy skill's typical estimate (server ~4 min vs. ~15-20s typical, client also several minutes) — the droplet's load average and memory were visibly under pressure during the builds (2 vCPU / ~2GB box, `npm rebuild`/`npm ci` are CPU-heavy); confirmed via `get_system_health` and a live `pgrep`/`ss` check that the build was genuinely progressing (not hung) before continuing to wait it out.
- Post-deploy `get_app_status`: db/server/client all running, db+server healthy.

---

## 5. Deferred / needs Dustin

**Explicitly out of scope for this pass** (per the original remediation brief):
- Attorney review of served legal drafts + a customer DPA template.
- SOC2 Type II operating-evidence cadence (founder-run, calendar-time — the evidence clock should just start now, per the audit's own recommendation).
- GitHub branch-protection required-checks / creating the `production` environment toggle — **Dustin needs to do this in GitHub settings**; `deploy.yml` already references `environment: production` and is ready for it.
- L-effort builds explicitly deferred per the brief: real per-tenant envelope encryption, money→cents migration, a true SCIM v2 server, native DWG rendering.

**Found during this pass, deliberately not built (judgment calls, with reasoning documented in the relevant commit):**
- Real per-account encryption gating (the toggle was removed rather than wired to something real — wiring it touches `documents.ts` + new `fieldRoutes.ts` logic, a genuine feature project).
- The `./prisma` moduleNameMapper broadening (verified it breaks 5 real tests; needs a proper per-file remediation, not a one-line regex change).
- Integration-suite failure backlog (368/871 passing, ~42%) — wired into CI non-blocking so there's finally continuous signal; working it down is real effort, not attempted here.

**Gap in the original batch plan** (not covered by any of the 8 commits — flagging honestly rather than letting it look "done"):
- **W1-M2** `scripts/rotate-master-key.js` is still broken end-to-end (calls a nonexistent `prisma.cloudConnector`, non-idempotent on `--apply`, misses `Account.importWebhookSecret` + BYO storage creds). Medium severity, S effort.
- **W1-M4** LOTO "auditable version history" is still false — `routes/loto.ts` still deletes+updates in place rather than appending revisions. Medium, M effort.
- **W1-M5** Account offboarding still has the `PartnerInvite.accountId` (Restrict, unindexed) blocker + ~8 orphan arc-flash tables in `demoPrune.ts`. Medium, S effort.
- **W1-M10** 19 of 84 route files still have zero test references (heuristic finding, needs a spot-check pass starting with public/import surfaces).
- Live web tier (host nginx + Caddy + TLS config) is still unversioned — exists only on the droplet, not committed to a `deploy/` directory in the repo. Deploy.yml's rollback story also wasn't addressed.
- Several Low items untouched: dead schema models (`IngestionSession`, `FailedLoginAttempt`), `js-yaml` DoS advisory, `.gitleaks.toml` allowlist regex breadth, dev-only vite/esbuild advisories.

**Non-blocking findings from the independent security review** (§3), for a future pass:
- `lib/storage.ts`'s `getS3Client()` doesn't apply the same DNS-rebind IP-pinning `lib/webhook.ts` already built for outbound webhooks — the new BYO-storage SSRF guard validates at config-save-time only, not on every live S3 request.
- A minor response-timing side-channel on `inboundEmail.ts`'s otherwise-uniform 202 responses (the success path does more work before responding than the reject paths).

**Live-verify items needing a human/dated check (Batch 8):**
- Confirm no `NOTICE` fired on prod for the guarded `Part`/`SpareInventory` unique constraints in Batch 1's migration (i.e., confirm no pre-existing duplicate rows blocked them from actually being added).
- Confirm the next 02:00 backup run succeeds cleanly with the corrected S3 env-var names (the old names were confirmed live-broken before this deploy).
- If `e2e-scheduled.yml` should actually go green, add demo basic-auth credentials as repo secrets.

---

## 6. Bottom line

Every High-severity finding shipped. The ship-first DGA safety-number fix, the inbound-email injection path, the unhandled-rejection crash risk, both backup-silent-failure bugs, and the false encryption/SOC2 claims are all closed and verified — locally, via an independent code review, and live on the droplet's compose file before the fix went out. Three Medium items from the original audit (rotate-master-key.js, LOTO versioning, demoPrune orphans) were not in the original batch plan and remain open — flagged above rather than left implicit. Prod is deployed, healthy, and the specific env-var bug the audit worried about was confirmed live-broken and is now fixed.
