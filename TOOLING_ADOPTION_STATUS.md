# Tooling Adoption — Status & Handoff

> **Session:** overnight 2026-07-08 → 07-09. Branch: `tooling-adoptions` (off `main` @ `ac45204`).
> **Source of truth for *what* to adopt:** `TOOLING_RECOMMENDATIONS.md` (repo root).
> **This file is the handoff.** Tomorrow's session starts here. Per item: DONE (commit SHA + verification evidence), IN PROGRESS (exact state), BLOCKED (why), or MORNING QUEUE.
> **Scope guard:** ServiceCycle repo only. No droplets, no deploys, no reseed, no prod. Do NOT merge to `main` tonight.

## Summary

All 7 required items + both "if time" items are complete on branch `tooling-adoptions` (9 scoped commits + status-doc commits, off `main` @ `ac45204`; **not merged**). Shipped: SPDX SBOM job (item 1), gitleaks wrapper→MIT-CLI swap with a documented `.gitleaksignore` baseline (item 2), a GPL/AGPL license gate + DD inventory (item 3), report-only knip (item 4) and dependency-cruiser (item 5) with baselines, self-hosted Renovate (item 6), the `mcp-builder`+`claude-api` skills cherry-picked after a full file-by-file security review (item 7), and a promptfoo proof-of-pattern eval (item 9). Item 8 (pino) turned out **already implemented** — no change made. Every item was verified by actually running the tool (trivy, gitleaks, license-checker, knip, dependency-cruiser, renovate-config-validator, promptfoo) on the Windows host, not just YAML-linted. **Three findings need Dustin** and none block: (a) `docs/DEMO_LANDMINES_v8.md` committed truncated real API-key prefixes (item 2, baselined + flagged); (b) 6 dependencies are imported but undeclared incl. `openai` which isn't installed at all (item 4); (c) Renovate needs a `RENOVATE_TOKEN` secret to activate (item 6). Two corrections to the source recommendation were caught and fixed: `--failOn 'GPL;AGPL'` is a gate that doesn't gate (exact-SPDX matching — enumerated the variants, item 3), and pino was described as "underused" but request-logging is fully wired (item 8). Push status + full per-item evidence below. **Environment note:** the Linux sandbox mount is a stale session-start snapshot (doesn't reflect edits) and GitHub release downloads are 403-blocked there — all verification ran on the Windows host via windows-shell.

---

## ✅ Morning 2026-07-09 — close-out (MERGED)

Branch **squash-merged to `main` @ `7172beb`** (linear history) after getting all CI green. Work done this morning:

- **sdk CI failures root-caused + fixed** — `sdk/package-lock.json` was accidentally untracked (client/server were committed); it broke the sdk legs of License / knip / dependency-cruiser. Committed it (valid, not gitignored). All three now pass.
- **DEMO_LANDMINES key prefixes REDACTED** (`gsk_<REDACTED>`/`AQ.<REDACTED>`). Current tree clean; historical commit `f0368fbb7` still holds them so the `.gitleaksignore` entry stays (full purge = history rewrite; real fix = rotate the keys, still a to-do).
- **6 undeclared deps DECLARED** — `jszip`/`archiver`/`ms` → server deps; `openai`/`swagger-ui-dist` → server **optionalDependencies** (both have graceful require-guarded fallbacks); `png-to-ico` → client devDep. knip unlisted 7→0; server `tsc` + `npm ci` clean. ⚠️ `openai` pinned to latest 6.x — validate against `server/lib/ai.ts` when the BYO-OpenAI path is next used.
- **Pre-existing main CI failure fixed** — the `CI` "OpenAPI drift check" was red on main (independent of tooling): committed `docs/openapi.json` listed 4 removed `/api/settings/encryption/*` paths. Regenerated the spec (`npm run openapi:build`); drift check green.
- **`servicecyclehq` = personal User account** (not an org) — resolves the gitleaks-license question (moot anyway post-CLI-swap).
- **All 6 CI jobs green** on the merged content (Gitleaks, CI, License, Knip, dependency-cruiser, Trivy).

### Dependency bot decision — RESOLVED: kept Dependabot, removed Renovate (`da5f864`)

Discovered post-merge that `.github/dependabot.yml` is active and mature (grouped, weekly, Semgrep cooldown) — the Renovate recommendation's "Dependabot-off" premise was wrong. Per Dustin ("use the industry standard"): kept **GitHub-native Dependabot**, removed `renovate.json` + the Renovate workflow. No `RENOVATE_TOKEN` needed anymore.

### Still needs Dustin (his actions — I can't do these)

- **Rotate the GROQ + GEMINI keys** — the DEMO_LANDMINES finding's real remediation (redaction only cleaned the doc, not the live keys).
- **CCA-F Partner Academy course completion** — check status under the softwareone.com email (Sept 24 first-15 bonus race).

---

## Repo facts verified this session (ground truth)

- Branch `tooling-adoptions` created off `main` @ `ac45204` (verified `git branch --show-current`).
- **Not** formal npm workspaces — no `workspaces` key in root `package.json`. Separate packages: root (`servicecycle-e2e`), `server/` (`servicecycle-server`), `client/`, `sdk/`. knip/dependency-cruiser configured per-package accordingly.
- CI runs **Node 20** (`.github/workflows/ci.yml:85`). Sandbox verification ran Node 22.
- Existing security workflows already live: `sbom.yml` (CycloneDX), `gitleaks.yml`, `codeql.yml`, `trivy.yml`, `dast-zap.yml`, `semgrep.yml`, `verify-signed-commits.yml`, `release-evidence.yml`.
- `.gitleaks.toml` exists at repo root (allowlist config, referenced by existing workflow).
- Working tree had a large pre-existing pile of untracked files (CLAUDE.md, .claude/, docs, TOOLING_RECOMMENDATIONS.md, etc.) — NOT mine; each commit below is scoped to only its own new files.

---

## Item status

| # | Item | Status |
|---|------|--------|
| 1 | SPDX SBOM step | ✅ DONE `8be0f24` |
| 2 | gitleaks wrapper → MIT CLI | ✅ DONE `31c5486` (1 finding flagged for Dustin) |
| 3 | license-checker-rseidelsohn gate | ✅ DONE `14e929c` |
| 4 | knip (report-only) | ✅ DONE `b3b963f` (triage below; 5 real undeclared deps flagged) |
| 5 | dependency-cruiser (non-blocking) | ✅ DONE `de80616` (0 errors — clean boundaries) |
| 6 | ~~Renovate~~ → kept Dependabot | ⛔ REMOVED `da5f864` (Dependabot already active; Renovate redundant) |
| 7 | anthropics/skills cherry-pick | ✅ DONE `aede160` |
| 8 | pino hardening (if time) | ✅ ALREADY IMPLEMENTED — no change needed (gap flagged) |
| 9 | promptfoo eval (if time) | ✅ DONE `6b01cd7` |

### 1. SPDX SBOM step — ✅ DONE (`8be0f24`)

Added a `spdx` job to `.github/workflows/sbom.yml` (CycloneDX `sbom` job untouched). Uses `aquasecurity/trivy-action@v0.36.0` (same action version as the working `trivy.yml`) with `format: spdx-json`, `scan-type: fs`, node_modules/dist skipped, uploads `sbom.spdx.json` as a 90-day artifact.

**Verification:** YAML valid (pyyaml load → jobs `['sbom','spdx']`, spdx format `spdx-json`). Ran the real tool on Windows (trivy v0.72.0, temp download, cleaned up): `trivy fs --format spdx-json --output sbom.spdx.json --skip-dirs node_modules server/` → exit 0, valid **SPDX-2.3** JSON, **447 packages**. INFO confirms `--format spdx-json` disables vuln scanning (expected SBOM-mode behavior).

_Env note: could not run trivy inside the Linux sandbox — GitHub release downloads return HTTP 403 via the sandbox proxy (npm registry is reachable, GitHub releases are not). Verified on the Windows host instead._

### 2. gitleaks wrapper → MIT CLI — ✅ DONE (`31c5486`)

Rewrote `.github/workflows/gitleaks.yml`: dropped `gitleaks/gitleaks-action@v2`, now installs the MIT gitleaks CLI (pinned `v8.30.1`, `gitleaks_..._linux_x64.tar.gz`) in a plain `run:` step and runs full-history `gitleaks git . --config .gitleaks.toml --report-format sarif --exit-code 1`. Same triggers (push all branches / PR / weekly Sunday cron), SARIF upload to Security tab preserved. Dropped the now-unused `pull-requests: write` permission (least-privilege; the CLI doesn't comment on PRs).

**Verification:** YAML valid (4 steps). Ran real gitleaks 8.30.1 on Windows (temp download, cleaned up): initial full-history scan → exit 1, **10 unique `generic-api-key` findings** in history. After baselining them in `.gitleaksignore`, re-ran → **exit 0 (clean)**.

**⚠️ FLAGGED FOR DUSTIN — 1 of the 10 is not a benign false positive.**
`docs/DEMO_LANDMINES_v8.md:159` (commit `f0368fbb7`) committed **truncated real key prefixes** inside a security-audit writeup: `GROQ_API_KEY=gsk_gl74H1fkl...` and `GEMINI_API_KEY=AQ.Ab8RN6L_0i...`. Truncated (likely not directly usable), but it *is* a partial secret in committed history. I baselined it so CI is green, with an explicit ⚠️ comment in `.gitleaksignore` — **not** disguised as a false positive. **Decision needed:** redact those prefixes in the doc vs. accept. (Separately, that doc's underlying finding — real keys live in the gitignored `server/.env`, rotate before any data-room/host handover — is a pre-existing known landmine, out of scope for this branch.) The other 9 are confirmed false positives (data-column mapping strings in `arcFlashAfx*.ts`, test fixtures/mock tokens, a NETA research-doc example) — each commented by category in `.gitleaksignore`.

_Behavior change worth knowing: every run is now a full-history scan (the old action only walked the push commit-range on push, full history only weekly). Stricter, and the reason the 10 pre-existing findings surfaced now._

_Also for the morning queue: confirm whether `servicecyclehq` is a GitHub org or personal account — it decided whether the old action's license mattered. Moot now that the wrapper is gone, but worth a definitive answer._

### 3. license-checker-rseidelsohn gate — ✅ DONE (`14e929c`)

New workflow `.github/workflows/license-check.yml`, matrix over `server/client/sdk`, Node 20. **Pinned `license-checker-rseidelsohn@4.4.2`** — verified v5.0.1 declares `engines.node >= 24` (CI is Node 20), so 4.x is the compatible line. Gate step fails on GPL/AGPL in `--production` deps; a separate `if: always()` step emits `licenses.json` + `licenses-summary.txt` and uploads them as a 90-day DD artifact (produced even when the gate fails).

**Gate-correctness catch (important):** `--failOn` matches **exact SPDX identifiers**, not families. The literal `--failOn 'GPL;AGPL'` from the recommendation is a gate that *doesn't gate* — verified: a synthetic pure-`GPL-3.0-or-later` package passes `--failOn 'GPL'` (exit 0). I enumerated every copyleft variant instead (`GPL-{1,2,3}.0[-only|-or-later]`, deprecated `GPL-2.0`/`GPL-3.0`, and the AGPL equivalents). LGPL intentionally excluded (weak copyleft).

**Verification (all on Windows host, Node 24 — 4.x runs there too):**
- Synthetic pure `GPL-3.0-or-later` package + enumerated list → **exit 1** (blocked). ✓
- `--failOn 'GPL'` (family form) vs same package → exit 0 (proves the literal form is broken). 
- `server` / `client` / `sdk` production deps + enumerated list → **exit 0** each (no pure GPL/AGPL shipped). ✓
- Acceptable duals in server (`(MIT OR GPL-3.0-or-later)`, `Apache-2.0 AND LGPL-3.0-or-later`) correctly do **not** trip the gate.
- Inventory: `licenses.json` = 152 KB valid JSON; summary shows server prod = MIT 275 / Apache-2.0 56 / ISC 24 / BSD 12 / …

_Note for DD: server prod deps include one `(MIT OR GPL-3.0-or-later)` dual-licensed and one `Apache-2.0 AND LGPL-3.0-or-later` package, plus one `UNKNOWN`. None are gate violations, but a DD reviewer will ask — worth a glance at the inventory artifact._

### 4. knip (report-only) — ✅ DONE (`b3b963f`)

`knip.json` maps the three real packages (`server`/`client`/`sdk`) as explicit knip `workspaces` (this repo is **not** formal npm workspaces). `.github/workflows/knip.yml` runs `npx knip@5` **non-blocking** (`continue-on-error: true`), pipes the report to the job summary, and uploads it as a 30-day artifact. **No code deleted.** Verified: knip 5.88.1 runs to completion on the repo (exit 1 = issues found, 50 KB JSON report).

**Config note / self-inflicted false positives:** the eslint/stylelint/playwright knip plugins are disabled in `knip.json` because the **root `node_modules` is incomplete** (missing `@eslint/js`, `@playwright/test`) and those plugins crash trying to load the root configs. Consequence: knip now reports the root's lint/e2e devDeps and the `e2e/*.spec.js` files as "unused" — **those are artifacts of the disable, not real dead code.** Fixing properly = install root deps (deferred; out of tonight's no-heavy-install scope).

**Baseline (2026-07-08):** 40 unused files · 7 unused deps · 12 unused devDeps · 7 unlisted deps · 7 unlisted binaries · 48 unused exports · 55 unused exported types · 6 duplicate exports · 22 config hints.

**Triage — do NOT bulk-delete; per category:**

- **🔴 Real & worth fixing — UNLISTED (undeclared) dependencies.** Imported in code but not in the package's `package.json` (currently resolving via hoisted transitive installs — fragile, breaks on a clean/pruned install). **Verified** absent from `server/package.json`: `openai` (`server/lib/ai.ts:501` — and NOT in `server/node_modules` at all, so that import throws `MODULE_NOT_FOUND` if the code path runs), `jszip` (`routes/ingestBackfill.ts`), `archiver` (`routes/settings.ts`), `swagger-ui-dist` (`routes/openapi.ts`), `ms` (`index.ts`). Client: `png-to-ico` (`scripts/generate-favicons.mjs`). **Recommended follow-up (needs Dustin — changes package.json + lockfile):** declare these explicitly. Especially confirm the `openai` path — it may be a lazy `import('openai')` for a BYO-OpenAI feature that has never had the dep installed.
- **🟡 Unused declared deps (needs Dustin — may be planned features):** server `stripe`, `winston`, `mammoth`, `pino`. **⚠️ `pino` is a knip FALSE POSITIVE** — `pino-http` is loaded via a dynamic `require()` (knip misses it) and base `pino` comes in transitively; request logging is fully wired (see §8). `stripe`/`winston`/`mammoth` are the genuine "declared but unused" candidates.
- **🟡 Candidate dead components (needs Dustin — verify not dynamically imported):** `client/src/components/` — `ActionDropdown.jsx`, `HelpButton.jsx`, `ReportBackLink.jsx`, `TruncationBanner.jsx`, `settings/CategoriesSection.jsx`, `settings/CloudConnectorsSection.jsx`, `tables/savedViews.js` (+ ~20 more in the artifact). Plausible safe deletes, but React components can be lazy/dynamically imported — human check required.
- **⚪ Confirmed false positives (do NOT touch):** `e2e/*.spec.js` (Playwright tests — flagged only because I disabled the playwright plugin), `eslint.config.js`/`playwright.config.js`, `.claude/hooks/guard-destructive.mjs` (external hook), the 6 "duplicate exports" (named + default export is an intentional pattern), and the root lint/e2e devDeps flagged unused.

_Safe-delete vs needs-Dustin split: **zero** are safe to auto-delete tonight without review. The single highest-value action is declaring the 6 unlisted deps._

### 5. dependency-cruiser (non-blocking) — ✅ DONE (`de80616`)

`.dependency-cruiser.cjs` (v17.4.3) with error-severity rules: `no-circular`, `no-server-to-client`, `no-client-to-server`, `no-sdk-to-app` (SDK stays standalone), plus a `no-orphans` warn rule. `.github/workflows/depcruise.yml` runs it **non-blocking** (`continue-on-error`) with job-summary + artifact output.

**Verification (ran locally):** `dependency-cruiser@17 server client sdk` → **exit 0, 0 errors**, 534 modules / 1315 deps cruised. **No circular deps and no boundary violations** — server/client/sdk are cleanly separated. 14 `no-orphans` **warnings** only.

**Triage — nothing trivial to fix (0 errors):** the 14 orphan warnings are mostly false positives — `server/prisma/seed.js`, `scripts/seedWestAllis.js`, `scripts/enable-arcflash-demo.js` (run via npm scripts, not imported), `jest.esbuild.cjs` (jest config), `tests/__mocks__/prisma.js` (jest mock), `client/public/theme-bootstrap.js` (loaded via `<script>` in HTML). The few that overlap knip's candidate-dead-code list (`client/src/components/` ActionDropdown, HelpButton, TruncationBanner; `tables/savedViews.js`; `components/system/RowCheckbox.jsx`, `FormField.jsx`) are the same needs-Dustin judgment calls from §4 — not auto-deleted.

**Future (morning-queue candidate):** because the boundary + no-circular rules already pass with 0 errors, they're a low-risk candidate to promote from report-only to a **blocking** gate (drop `continue-on-error` on a dedicated boundary-only invocation, keep orphans report-only). Left non-blocking tonight per the stated scope.

### 6. Renovate self-hosted Action — ✅ DONE (`a010c4f`)

`renovate.json`: `dependencyDashboard: true`, grouped PRs (`npm non-major`, `npm major updates`, `github-actions`), weekly window (`before 6am on monday`, `America/Chicago`), **`automerge: false`**, `lockFileMaintenance` weekly, vuln alerts any-time, concurrency limits. `.github/workflows/renovate.yml`: self-hosted `renovatebot/github-action@v46.1.18` (Mend-hosted app intentionally avoided), weekly Monday cron + `workflow_dispatch` (log-level choice), scoped to this repo only (`RENOVATE_REPOSITORIES`, autodiscover off).

**Verification:** `renovate-config-validator --strict` (renovate 43.x) → **"Config validated successfully", exit 0**, both as a passed-file check and auto-discovered as a **repository** config. Workflow YAML valid, action pin confirmed. (Refined mid-task: dropped a `configurationFile: renovate.json` input that would have loaded the repo config as *global* config — `renovate.json` is auto-read as the repo config.)

**⚠️ Activation needed (morning queue):** Renovate will not open PRs until a **`RENOVATE_TOKEN`** repo/org secret exists — a PAT for the account Renovate should post PRs as (classic: `repo` + `workflow`, or fine-grained with contents + PR write). Auto-discovers all four `package.json` + lockfiles (root/server/client/sdk). Auto-merge is OFF, so nothing merges without human review regardless.

### 7. anthropics/skills cherry-pick — ✅ DONE (`aede160`)

Hand-copied **only** `mcp-builder` and `claude-api` from `github.com/anthropics/skills` into `.claude/skills/` (76 files). **Did NOT install the marketplace bundle.** Both are Apache-2.0 (verified `LICENSE.txt`). Method: shallow-cloned to a temp dir, reviewed every file, copied the two folders, deleted the clone.

**Security review (every file read / grepped before copy — "reject surprises"):**
- `claude-api` = 100% markdown docs (per-language API examples: csharp/curl/go/java/php/python/ruby/typescript/shared) + LICENSE. No runnable scripts.
- `mcp-builder/scripts/` = the only executable code: `connections.py` (151 lines — standard MCP client wrapper over the official `mcp` lib, stdio/SSE/HTTP), `evaluation.py` (373 lines — MCP eval harness using the official `anthropic` SDK), `requirements.txt` = `anthropic>=0.39.0` + `mcp>=1.1.0`.
- Grep for `os.system|subprocess(shell)|eval(|exec(|child_process|pickle.load|base64.b64decode|__import__|shell=True` across both folders → **no code hits** (only doc prose about MCP "subprocess" transport + one benign `subprocess.check_output(["git","show",...])` example inside a markdown doc).
- All `http(s)` hosts across both folders resolve to legitimate destinations (platform.claude.com, api.anthropic.com, github.com, modelcontextprotocol.io, example.com placeholders, Slack/Linear/Notion MCP examples, apache.org). No exfiltration domains, no raw IPs, no `curl|sh`.
- Runtime network reach: only `api.anthropic.com` (via SDK) + the user-supplied MCP server URL. No hardcoded endpoints or credentials.

_Note: `.claude/skills/` was already untracked in this working tree (existing `fable-*`, `sc-deploy` skills are uncommitted too); this commit adds only the two new folders._

### 8. pino hardening (if time) — ✅ ALREADY IMPLEMENTED (no code change tonight)

**The thing item 8 asks for already exists.** `server/index.ts:556–616` wires `pino-http` with: per-request UUID `req.id` propagated to the **`X-Request-Id`** response header (honoring an inbound `x-request-id` when well-formed), structured JSON in prod / `pino-pretty` in dev, health/ready-probe filtering, custom req/res serializers, and **extensive redaction** of auth headers + password/TOTP/refresh-token fields + AI-route PII bodies (`question`/`text`/`notes`/`vendorNotes`/…). Building request-ID-correlated structured logging would rebuild shipped work — verified live before touching anything (`git grep` + read of the block).

**Correction to §4's note:** knip flagged base `pino` as "unused," which I initially read as corroborating "pino underused." That's a **knip false positive** — `pino-http` is loaded via `require('pino-http')` (dynamic, so knip misses it), and base `pino` is pulled transitively. Request logging is fully wired, not underused.

**Real remaining gap (optional follow-up — NOT done tonight):** application-level logging still uses ~200 raw `console.error/warn/log` calls (startup checks, route handlers) that bypass pino and are **not** request-ID-correlated or structured. `pino-http` already attaches a child logger as `req.log` (req-id bound), so the infrastructure to fix this exists — it's an adoption refactor (swap `console.*` → `req.log.*` in routes). Deferred because (a) it's a large, broad change, not a "smallest useful change," and (b) server jest tests need a live `:3001` dev server that can't run in this automated session, so "tests green" isn't verifiable here. Flagged for Dustin to scope.

### 9. promptfoo eval (if time) — ✅ DONE (`6b01cd7`)

`evals/fable-research/promptfooconfig.yaml` — one representative fable-research-style question ported into a promptfoo YAML eval as proof-of-pattern. Assertions encode the doctrine the original benchmark scored: `regex` for a cited source URL (§4), `icontains-any` for labeled recency/confidence (§3/§6), and an `llm-rubric` grading citation-integrity + no-false-certainty. In-file comment notes promptfoo is **MIT** and **OpenAI-owned since Mar 2026** (still OSS).

**Verification:** `promptfoo 0.121.18 validate` → **"Configuration is valid", exit 0**; YAML parses. Running the eval (vs `validate`) needs `ANTHROPIC_API_KEY` and a current Sonnet model id (documented in-file; points at the vendored `.claude/skills/claude-api/shared/models.md` for the id).

**Provenance caveat:** the original 6 benchmark questions were run ad-hoc during the benchmarking session and are **not committed** anywhere in the repo (searched). This is a faithful *representative* question, not a verbatim port — clearly labeled as such in-file. Adding the real 6 later is just more `tests:` entries.

---

## MORNING QUEUE (need Dustin live)

- **CrowdSec install on droplets** — prod change; dry-run + his confirm required. Not touched tonight (no-prod scope).
- **Better Stack activation** — needs his login. Already provisioned; SOC2-backlog item.
- **Merge `tooling-adoptions` → `main`** after CI green. `main` = linear history only: rebase/ff or squash, never merge commits.
- **knip deletion decisions** — triaged findings below (§4); safe-delete vs needs-Dustin split there.
- **Confirm whether `servicecyclehq` is a GitHub org or personal account** — determines gitleaks-action licensing. Moot once #2 (CLI swap) ships, but worth a definitive answer.
- **Check CCA-F Partner Academy course completion status** (softwareone.com email) — exam invite gated behind 4 courses; Sept 24 first-15 bonus race.
- **Add `RENOVATE_TOKEN` repo/org secret** (item 6) — Renovate opens no PRs until it exists. PAT with `repo` + `workflow` (classic) or contents + PR write (fine-grained).
- **Declare knip's 6 unlisted deps** (item 4) — `openai`, `jszip`, `archiver`, `swagger-ui-dist`, `ms` (server), `png-to-ico` (client). Especially confirm the `openai` import at `server/lib/ai.ts:501` (not installed at all). Changes package.json + lockfiles.
- **Decide the `docs/DEMO_LANDMINES_v8.md` partial-key finding** (item 2) — redact the truncated `gsk_…`/`AQ.…` prefixes vs. accept; currently baselined in `.gitleaksignore`.
- **Optional promotions/refactors:** promote dependency-cruiser boundary+cycle rules to a blocking gate (item 5, currently 0 errors); adopt `req.log` structured logging across route `console.*` calls (item 8 gap).

---

## Git / push log
_(commits recorded per item as they land)_
