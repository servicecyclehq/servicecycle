# ServiceCycle — Acquisition Audit Punch List (Running)

**Session:** 2026-07-08 Fable full end-to-end audit (read-only)
**HEAD at audit start:** `c767b38` (main)
**Status:** COMPLETE — verification pass done (high-severity citations spot-checked against live code; all verified; zero tracked files modified)
**Final report:** docs/ACQUISITION_AUDIT_2026-07-08.md (written at end)
**Remediation pass:** 2026-07-08, same day, `c767b38` → `191b08b` → deployed. Full writeup: `docs/REMEDIATION_SUMMARY_2026-07-08.md`. Every item below is now marked ✅ shipped / ⚠️ open (not in this pass's scope) / ⏸ deferred on purpose, with the shipping commit SHA.

## Remediation commit index

| SHA | Batch |
|---|---|
| `16e9cb7` | 1 — schema/migrations |
| `2e3c038` | 2 — domain accuracy (DGA/arc-flash) |
| `938ac88` | 3 — ingestion/AI provenance |
| `ec34492` | 4 — security/tenancy/backend |
| `c32f2b4` | 5 — ops/CI/backups |
| `c8605d2`, `9ded5f2` | 6 — frontend |
| `191b08b` | 7 — docs accuracy |

Note: 215 files show as modified in `git status` from the audit sandbox — verified pure CRLF
line-ending noise from the Linux mount (89,186 insertions == 89,186 deletions). No real
working-tree changes. This audit modifies nothing; it only adds this file + the final report.

## Orientation snapshot

- Server: Express + TypeScript, 85 route files, 170 lib files, entry `server/index.ts`
- Data: Prisma, 98 models, 54 migrations
- Client: React PWA, 76 pages
- Tests: ~100 test files under `server/tests/`
- CI: 11 workflows (ci, codeql, dast-zap, deploy, gitleaks, release-evidence, release-tag, sbom, semgrep, trivy, verify-signed-commits)
- Docs: 97 files in docs/ incl. SOC2 pack, ACQUISITION_BRIEF, threat model, DR/backup docs
- Repo-root hygiene note: personal/career files (resume, CCA study PDFs, job-search kit), stray logs, and `do-api-token.token.tmp` (confirmed gitignored, untracked) live in the repo root — data-room hygiene item, not a security leak.

## Phase log

- [x] Phase 0 — Orientation + calibration docs (ACQUISITION_BRIEF, SOC2_READINESS_CHECKLIST, PPE liability posture)
- [x] Wave 1 — Tenant isolation/auth · Prisma schema · test-suite run · secrets/CVEs
- [x] Wave 2 — Domain accuracy (arc-flash/NETA) · ingestion pipeline · backend/API · ops/CI/backups
- [x] Wave 3 — Enterprise completeness · frontend/UX · functional check (live-demo functional check BLOCKED by nginx basic-auth; live prod health checked via MCP instead)
- [x] Synthesis — personas, tensions, verdict, final report → docs/ACQUISITION_AUDIT_2026-07-08.md

## Live prod health (checked via ServiceCycle vps-control MCP, 2026-07-08 ~19:45 UTC)
- Containers: db healthy (up 12d), server healthy (up 4h — recent deploy), client running (up 4d, health n/a). Live server HAS a healthcheck (contradicts repo-only "base compose has no server healthcheck" finding W2-OPS6 — prod config differs from repo; verify which compose is live).
- DB: schema up to date, 53 migrations applied, ZERO pending. Prisma 5.22.0 (major 7.x available, non-urgent).
- Host: disk 77% used (11G free) — watch (unencrypted pg_dumps accumulate in /root per W2-OPS7); mem tight (106MB free/932MB avail, swap 399MB/3071MB); up 16d, load ~0.05.
- Git on droplet: clean on main, up to date with origin/main.

## Findings (running, unified)

### Critical
(none found in Wave 1 — no live cross-tenant data-read leak; tenant isolation holds)

### High
- ✅ **DGA acetylene thresholds wrong** — reverted `[35,50,80]`→`[1,9,35]`. `dgaEvaluate.ts:34`. **Shipped `2e3c038`.**
- ✅ **W1-H1 Inbound-email webhook = unauthenticated cross-tenant data INJECTION** (NEW, verified). `routes/inboundEmail.ts:147,178-182` routes on `to:` slug only; sender never validated; attachments enqueue as `IngestJob{autoCommit:true}` bypassing review. Resend HMAC authenticates transport not author. Slug enumeration oracle (line 149,188). Precondition: email-in provisioned (not on demo). Fix: sender allowlist OR route through review queue OR high-entropy slug token. Effort M. **Shipped `ec34492`** — sender allowlist added (fail-closed), uniform 202 response closes the enumeration oracle.
- ✅ **W1-H2 Integration jest project (136 files: 89 route + 47 lib tests) never run by any CI workflow** (NEW, verified). `ci.yml:182,239` hardcode `--selectProjects unit`; `jest.config.ts:27-51` integration project wired to nothing → zero signal forever. Fix: add to CI after migrate/seed. Effort S wiring (true pass rate unknown — nobody has run them). **Shipped `c32f2b4`** — wired in non-blocking (measured real pass rate: 368/871, ~42% — genuinely broken, correctly left non-blocking rather than assumed clean; working the backlog down is a separate future effort).
- ✅ **Ingestion provenance/confidence dropped at commit** — `TestMeasurement.source`/`confidence` added + populated. `commitTestReport.ts:119-143`. **Shipped `16e9cb7`** (schema) + `938ac88` (populate at commit).
- ✅ **Unhandled promise rejections can crash the process** — process-level handler + try/catch on 7 ssoAdmin handlers. `ssoAdmin.ts`. **Shipped `ec34492`.**
- ✅ **Off-host backup silently dead (S3 env-var name drift)** — compose aligned to code. `docker-compose.yml:269-278`. **Shipped `c32f2b4`.** Confirmed live-broken on the droplet before this fix (checked via vps-control MCP prior to deploy).
- ✅ **Backup failure path crash + false green** — `pfx` temporal-dead-zone crash fixed; `both`+unconfigured-S3 now writes a `BackupLog` failure + admin alert. `backup.ts:385`. **Shipped `c32f2b4`.**
- ✅ **False "per-account envelope encryption" claim** — doc corrected. `SOC2_ONE_PAGER.md:27`. **Shipped `191b08b`.**
- ✅ **No-op encryption toggle emitting hash-chained audit events** — toggle removed (was gating nothing real); `settings.ts:1051-1115`; `EncryptionSection.jsx` reworked to a static explanation, no dead API calls. **Shipped `ec34492`.** Real per-account gating is a genuine feature project, not built here — see `REMEDIATION_SUMMARY_2026-07-08.md` §5.

### Medium
- ✅ **W1-M1 sales.ts group_admin scoped by partnerOrgId not enterpriseGroupId** (NEW, verified). `lib/salesRollup.ts:26` + `sales.ts:38-43,176-185`: a group_admin with non-null partnerOrgId can read+reassign reps on every account sharing that partnerOrgId (not necessarily their group). Latent (needs account with both FKs). Fix: drop group_admin from OPERATOR_ROLES or add enterpriseGroupId branch. Effort S. **Shipped `ec34492`** — scoped by enterpriseGroupId; kept in OPERATOR_ROLES per an existing test's requirement.
- ⚠️ **W1-M2 Master-key rotation script broken end-to-end** (NEW, verified). `scripts/rotate-master-key.js:191,218,257` calls nonexistent `prisma.cloudConnector`; `--apply` crashes AFTER rewriting some secrets (non-idempotent, unrecoverable); misses Account.importWebhookSecret + BYO storageS3 creds. Fix: rewrite + idempotent. Effort S. **OPEN — not in this pass's batch scope.** Not currently in active use, but should not ship broken.
- ✅ **W1-M3 Hash-chain audit log breakable by schema's own cascade deletes** (NEW, verified). `ActivityLog.asset onDelete:Cascade` (schema:2194) + `account SetNull` (:2200) both mutate/remove hashed rows → permanent false-tamper. Latent (no hard-delete route today). Fix: exclude FKs from canonical() or SetNull + never-hard-delete invariant. Effort M. **Shipped `16e9cb7`** — FK changed to SetNull, accountId/assetId excluded from canonical() hash payload, one-time chain re-anchor run (7,601 rows / 118 chains, 0 breaks after).
- ⚠️ **W1-M4 LOTO "auditable version history" is false** (NEW, verified). `routes/loto.ts:210-220` deleteMany+update in place; prior OSHA 1910.147 procedure revisions unrecoverable; LotoStep/LotoEnergySource have no timestamps. Fix: append-only revisions. Effort M. **OPEN — not in this pass's batch scope.**
- ⚠️ **W1-M5 Account offboarding: PartnerInvite blocker + ~8 orphan tables** (partial KNOWN). `lib/demoPrune.ts:72-147`: PartnerInvite.accountId (Restrict, unindexed) unpruneable; FK-less arc-flash tables orphan on delete. Fix: add deletes + test invariant. Effort S. **OPEN — not in this pass's batch scope.**
- ✅ **W1-M6 BYO-storage endpoint has no SSRF validation** (NEW, verified). `routes/settings.ts:1261,1286-1304` accepts any endpoint URL, server connects, returns raw err.message (oracle). Guard exists for AI-endpoint/webhooks but not applied here. Admin-only, pre-launch. Fix: reuse private-IP blocklist. Effort S. **Shipped `ec34492`** — reused the existing private-IP blocklist guard. Note: the independent security review flagged that the guard runs at config-save-time, not on every live S3 request (no DNS-rebind pinning like `lib/webhook.ts` has) — non-blocking follow-up.
- ✅ **W1-M7 Compose↔code env-name drift silently breaks global S3 storage + off-host backups** (NEW, verified static). `docker-compose.yml:269-278` forwards `STORAGE_S3_ACCESS_KEY_ID`; code reads `STORAGE_S3_KEY_ID` (storage.ts:93-95, backup.ts:82-83). Operator following .env.example → silent local-disk fallback; ransomware-mitigation off-host backup can no-op. (BYO per-tenant storage unaffected.) Fix: align names. Effort S. **Shipped `c32f2b4`** — confirmed this was actually live-broken on the droplet before fixing.
- ⚠️ **W1-M8 32 lib/*.ts use bare `./prisma` import bypassing jest unit-mock** (NEW, verified). `jest.config.ts:19-21` moduleNameMapper misses `./prisma` form (e.g. activityLog.ts:32); 17 suites silently depend on a real generated client. Fix: broaden regex. Effort S. **ATTEMPTED, REVERTED.** Broadening the regex breaks 5 real tests that deliberately exploit the current mock gap — needs a proper per-file remediation, not a one-line change. Still open.
- ✅ **W1-M9 Playwright e2e (6 specs incl a11y) orphaned from CI, defaults to live prod demo** (verified). `playwright.config.js:29` baseURL=servicecycle.app; no workflow references it. Fix: scheduled workflow or document manual-only. Effort S-M. **Shipped `c32f2b4`** — new `.github/workflows/e2e-scheduled.yml`, scheduled + non-blocking. Needs Dustin to add demo basic-auth credentials as repo secrets for it to actually run green.
- ⚠️ **W1-M10 19 of 84 route files have zero test references** (NEW, heuristic). Incl public/import surfaces (partnerInvitePublic, shareLinkPublic, assetsImport, dgaIngest, adminOpportunities...). Fix: spot-check public/import first. Effort M. **OPEN — not in this pass's batch scope.**
- ✅ **Deploy not gated on CI** — `deploy.yml` now uses `workflow_run` gated on CI's `conclusion==success`, health check hits real `/api/ready`, `set -euo pipefail`, prunes old plaintext dump artifacts. **Shipped `c32f2b4`.** GitHub's `production` environment itself still needs a repo-admin to create — flagged for Dustin.
- ✅ **AI paths bypass promptSanitize / no AI-call timeout / re-ingest idempotency / AI spend uncapped** — all four shipped `938ac88`.
- ✅ **WO non-COMPLETE transition race / rate-card upsert race / malformed dates → 500** — shipped `ec34492`.
- ✅ **IEEE 1584 fault-current bound not voltage-class-branched** (`arcFlashSanity.ts:132-141`) — shipped `2e3c038`.
- ✅ **e2e smoke/axe test the pre-rebrand app / modal focus-trap gaps / users-permissions unreachable** — shipped `c8605d2`.
- ✅ **IP_OWNERSHIP LGPL misstatement / SCIM overstated / DWG "shipped" is a stub / SOC2_ONE_PAGER scoreboard drift** — shipped `191b08b`.
- ⚠️ **No off-host document backup** — **Shipped `c32f2b4`** (new `runUploadsSync()`, nightly cron wired in `ec34492`). First real run happens at the next scheduled window — flagged in §"needs a live check" below.
- ⚠️ **Live web tier unversioned / deploy.yml no rollback story** — **OPEN.** Not attempted this pass; the host-level nginx/Caddy/TLS config still lives only on the droplet, not in a repo `deploy/` directory, and there's no automated rollback path.

### Low
- ✅ **W1-L1** adminPartnerOrgs.ts no in-file requireSuperAdmin guard (mount-only; no bypass today) — parity fix. `index.ts:1440`. S. **Shipped `ec34492`.**
- ✅ **W1-L2** Idempotency key not scoped to method+path — within-account wrong-result risk. `lib/apiIdempotency.ts:31-33`. S. **Shipped `ec34492`** — all 3 real call sites.
- ✅ **W1-L3** early-access `/list` on public mount, self-protects on-route (one line from exposure). `index.ts:1054`, `earlyAccess.ts:146`. S. **Shipped `ec34492`.**
- ✅ **W1-L4** Condition/decommission alerts render asset as raw UUID (`asset.name` doesn't exist). `routes/assets.ts:1112,1124`. S. (missed instance of e26354c class) **Shipped `ec34492`** — new shared `lib/assetLabel.ts` helper, also applied in `arcFlashLabelDoc.ts`.
- ✅ **W1-L5** Part/SpareInventory missing @@unique → CSV-import TOCTOU duplicate rows. `schema:3676-3705`, `parts.ts:223-254`. S. **Shipped `16e9cb7`** — guarded migration (skips + logs a Postgres NOTICE instead of failing if pre-existing duplicates found; none fired locally, prod not yet confirmed — see live-check list below).
- ⚠️/✅ **W1-L6** Stale broken scripts: backfill-activity-log-chain.js (contractId/contract) — **fixed, `16e9cb7`** (rewritten as a chain re-anchor tool). rotate-master-key.js — **still open**, see W1-M2.
- ⚠️ **W1-L7** Dead schema: IngestionSession (no writers), FailedLoginAttempt (lockout still in-memory loginFailMap). S. **OPEN — not in this pass's batch scope.**
- ⏸ **W1-L8** Money stored 3 ways (Decimal dollars vs Int cents on same model). Migrate to cents. M. **Deferred on purpose** — explicitly out of scope per the original remediation brief (L-effort build).
- ⏸ **W1-L9** Voltage stringly-typed ("480V"/"13.8kV") feeds IEEE 1584 math; native cause of 1000x LV-inflation bug class. Add numeric column. M. **Deferred on purpose** — same reason as L8.
- ⚠️ **W1-L10** js-yaml moderate DoS advisory GHSA-h67p-54hq-rp68 (fixAvailable, low reachability). S. **OPEN.**
- ⚠️ **W1-L11** vite/esbuild dev-server advisories (1 high 1 mod, DEV-ONLY, no prod exposure; scanner-visible for diligence). M. **OPEN.**
- ⚠️ **W1-L12** .gitleaks.toml allowlist `your-.*-here` unanchored greedy (could mask). S. **OPEN — not in this pass's batch scope.**
- ✅ **W1-L13** Missing indexes: ActivityLog.userId, PartnerInvite.accountId, CustomFieldValue.definitionId, WorkOrder.assignedTechId. S. **Shipped `16e9cb7`.**
- ✅/⚠️ **W1-L14** No jest coverage threshold — **fixed, `c32f2b4`.** Stale `partner-flywheel.sql` — **deleted, `16e9cb7`.** Duplicate migration timestamp `20260620130000` and date-only `0705` dirs — **left as-is**: both migrations are already applied everywhere; renaming an applied migration folder risks a checksum failure on the next migrate-gated deploy, so this is documented rather than touched.

### Info / re-confirmed solid (Wave 1)
- Tenant isolation genuinely holds: per-query accountId scoping + fetch-then-act by-id pattern consistent across routes; `multiTenantIsolation.test.ts` asserts real cross-org 403/404. No live cross-tenant READ leak found.
- Crypto: AES-256-GCM correct in all 3 impls (random 12-byte IV, auth tag pinned 16, key validated 32 bytes at boot). BYO creds encrypted at rest, only 4-char hint returned.
- JWT HS256 pinned sign+verify, weak-secret boot reject, token epoch revocation, refresh rotation w/ reuse-detection cascade. bcrypt cost 12, zxcvbn+HIBP, reset tokens 256-bit hashed single-use.
- HTTP hardening: Helmet CSP default-src none, CORS allowlist, 9 rate-limiters, multer magic-byte sniff + SVG block + traversal guard. Docker USER node, Postgres port not published, secrets via env.
- Deps mostly clean, WebSearch-verified: jsonwebtoken/multer/sharp/react-router/express no open advisories; axios 1.16.1 ABOVE the compromised 1.14.1 supply-chain release.
- No destructive migrations post-2026-06-06 reset; enum changes append-only. Rollup FK mobility safe. Zero .skip/.todo test debt. Unit slice 860/908 pass (48 fails 100% attributable to sandbox prisma-engine 403, not code).

### Need-to-Add (enterprise/M&A) — Wave 1 seeds
- ✅ Wire integration + e2e test projects into CI (currently no continuous signal on 136 integration + 6 e2e specs). **Shipped `c32f2b4`** — both wired non-blocking.
- ✅ Coverage thresholds in jest. **Shipped `c32f2b4`.**
- ⚠️ SSRF hardening parity across all outbound-URL config surfaces. **Partially shipped** — BYO-storage endpoint now guarded (`ec34492`); the independent security review flagged the S3 client itself still lacks DNS-rebind IP-pinning on live requests (`lib/webhook.ts` has this, `lib/storage.ts` doesn't) — non-blocking follow-up, open.
- ✅ Off-host encrypted backup verification (env drift means it may silently no-op). **Shipped `c32f2b4`** — env names aligned (confirmed live-broken beforehand), failure path now writes a `BackupLog` row + alert instead of a silent false-green. Documents now also get a nightly off-host sync (`runUploadsSync`, new capability, not just a fix).

---

## Remediation pass close-out (2026-07-08)

Every High-severity item shipped. See `docs/REMEDIATION_SUMMARY_2026-07-08.md` for the full batch-by-batch writeup, cross-batch integration fixes, verification performed, and the complete deferred/open list with reasoning. Genuinely open items not covered by this pass (all were outside the original 8-batch scope, not skipped): **W1-M2** (rotate-master-key.js), **W1-M4** (LOTO versioning), **W1-M5** (demoPrune PartnerInvite blocker), **W1-M8** (jest moduleNameMapper — attempted, reverted, breaks real tests), **W1-M10** (19/84 untested routes), **W1-L7/L10/L11/L12** (dead schema, dependency advisories, gitleaks regex), live web tier unversioned, deploy rollback story.

**Needs a live/dated check, not just a code review:**
- Confirm no Postgres `NOTICE` fired on prod for the guarded Part/SpareInventory unique constraints (i.e., no pre-existing duplicates blocked them from being added).
- Confirm the next 02:00 UTC backup run succeeds with the corrected S3 env-var names.
- Confirm the new 02:20 UTC uploads-sync cron completes on its first live run.
- If `e2e-scheduled.yml` should go green, add demo basic-auth credentials as GitHub repo secrets.

**Deployed:** pushed to `origin/main` at `191b08b`, pulled + rebuilt on the droplet (migration applied, `server-migrate`+`server` rebuilt, `client` rebuilt+published), post-deploy `get_app_status`: db healthy, server healthy, client running. Independent fresh-eyes security review verdict: **GO** (2 non-blocking follow-ups noted above).
