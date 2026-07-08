# Semgrep first-real-run triage — 2026-07-08

Semgrep's CI workflow (`.github/workflows/semgrep.yml`) shipped overnight
2026-07-07→08 as report-only (`continue-on-error: true`, not a required
check). This is the triage of its first real findings, per the header
comment's own instruction: "do not mark it required until a human has
reviewed at least one real run's findings."

## Signal-to-noise summary

**49 total findings, 7 distinct rule types.** Breakdown:

| Rule | Instances | Verdict |
|---|---|---|
| `github-actions-mutable-action-tag` | 11 files (~22 action refs) | Real, deferred — see fix plan below |
| `raw-html-format` (XSS) | 3 files | **1 real bug fixed** (fleetDashboard.ts), 2 false positives (already escaped, suppressed) |
| `dependabot-missing-cooldown` | 1 | Fixed — added `cooldown: {default-days: 7}` to all 3 dependabot.yml entries |
| `npm-missing-minimum-release-age` | 1 | Deferred — needs npm ≥11.10, Docker base image (`node:20-slim`) ships 10.8.2; documented in `server/.npmrc` |
| `gcm-no-tag-length` | 1 | Fixed — `rotate-master-key.js`'s `createDecipheriv` now passes `authTagLength` explicitly, matching the pattern already used in `lib/crypto.ts`/`lib/backupCrypto.ts`/`lib/docCrypto.ts` |
| `plaintext-http-link` | 1 file, 2 links | False positive, suppressed via `.semgrepignore` — standalone repo-root reference doc, not served by the app |
| `request-host-used` (nginx) | 1 | False positive, suppressed via inline `nosemgrep` — standard reverse-proxy Host forwarding, never trusted downstream for anything security-sensitive |

**Real signal-to-noise: 2 genuine bugs found and fixed** (1 real XSS gap, 1
crypto hardening gap) out of 49 raw findings — but the ruleset itself isn't
noisy in the "wrong tool" sense; it's mostly ONE repeated finding
(action-tag pinning, 11 files) plus a handful of one-off config-hardening
suggestions that were either genuinely quick wins or legitimate false
positives specific to how this app is built. Worth keeping in CI. Not yet
recommending it become a required/blocking check — the action-tag-pinning
backlog below should land first so a future contributor doesn't inherit an
already-red required check on day one.

## Fixed today

1. **`server/routes/fleetDashboard.ts` — real XSS gap.** `partnerOrg.name`
   (user-editable — any user who can create/edit a partner org profile
   controls it) was interpolated raw into invitation-email HTML sent to the
   *invitee's* inbox, in both `POST /invites` and `POST /invites/:id/resend`.
   Unlike the sibling `esc()` pattern already used in `disasterEvents.ts` and
   `proposals.ts`, this handler had no escaping at all. Fixed: added the same
   local `esc()` helper, applied to every `orgName` interpolation.
2. **`server/scripts/rotate-master-key.js` — GCM tag-length hardening.**
   `createDecipheriv` didn't pass `authTagLength` explicitly, so tag-length
   enforcement relied entirely on `setAuthTag()`'s own validation rather than
   being locked in at cipher-creation time. Every other AES-GCM decrypt site
   in the codebase (`lib/crypto.ts`, `lib/backupCrypto.ts`,
   `lib/docCrypto.ts`) — and even this script's own test file,
   `rotate-master-key.test.js` — already used the explicit-length form, so
   this brings the one outlier in line with the established convention.
   Verified via `node scripts/rotate-master-key.test.js` (34 assertions, all
   pass, including tamper-detection and cross-key-rejection cases).
3. **`.github/dependabot.yml` — cooldown.** Added `cooldown: {default-days:
   7}` to all three `updates` entries (server npm, client npm, github-actions).
4. **False positives suppressed** (documented inline, not blanket-ignored):
   - `client/nginx.conf`'s `proxy_set_header Host $host;` — standard
     reverse-proxy idiom; `$host` is never used for an nginx-side security
     decision, and grepping the server confirmed `req.headers.host` /
     `req.hostname` are never trusted for anything sensitive either. A
     hardcoded host allowlist would also be actively worse here — SC is
     meant to be self-hosted on whatever domain the operator points at it.
   - `disasterEvents.ts` and `proposals.ts`'s `raw-html-format` matches —
     both already wrap every interpolated value in a local `esc()` helper;
     Semgrep's dataflow analysis doesn't trace through the helper call, so
     it flags accurate-looking-but-safe code. Left as accurate matches with
     an explanatory `nosemgrep` comment rather than restructuring working
     code to dodge a static-analysis blind spot.
   - `ArcFlash_Format_Sources.html` (+2 sibling repo-root reference HTML
     files) — standalone research/reference documents at the repo root, not
     served by nginx or Express (nginx only serves `client/dist`). Added
     `.semgrepignore` rather than one-off suppressions since more such files
     may get added later.

## Deferred — not fixed today

- **`npm-missing-minimum-release-age`** (`server/.npmrc`). Real protection,
  but only for `npm install <newpkg>` (registry re-resolution) — has zero
  effect on `npm ci`, which is the only install path Docker/CI ever use.
  Needs npm ≥11.10; `node:20-slim` (checked directly via `docker run
  node:20-slim npm --version`) ships 10.8.2. Real fix is a Node LTS bump
  (20→22) across `server/Dockerfile*`, `ci.yml`, and `package.json`'s
  `engines` field — that's a bigger, separate piece of work, not a one-line
  `.npmrc` addition. Documented inline in `.npmrc` for whoever picks up the
  Node-version bump next.

## Fix plan — GitHub Actions mutable tag pinning (not executed today)

**Finding:** `yaml.github-actions.security.github-actions-mutable-action-tag`
fires on every `uses: <action>@<tag>` reference across 11 workflow files
(`ci.yml`, `codeql.yml`, `dast-zap.yml`, `deploy.yml`, `gitleaks.yml`,
`release-evidence.yml`, `release-tag.yml`, `sbom.yml`, `semgrep.yml`,
`trivy.yml`, `verify-signed-commits.yml`), recommending each be pinned to a
full 40-character commit SHA instead of a mutable tag like `@v4` — tags can
be silently repointed by the action owner (real supply-chain incidents:
`tj-actions/changed-files`, `reviewdog/action-*` in 2025). Roughly 22
distinct action references total across these files (some actions repeat
across multiple workflows: `actions/checkout`, `actions/setup-node`,
`actions/upload-artifact` are each used 4+ times).

**Why not done live today:** this is mechanical but high-blast-radius if
rushed — pin the wrong SHA (wrong version, or a typo) in any of 11 files and
CI silently breaks or, worse, silently runs a *different* version than
intended. This session already spent significant effort getting CI to a
genuinely all-green state for the first time (see the daytime recap memory)
— not worth risking that on an unverified batch SHA-pinning pass with no
time left to watch 11 separate CI runs confirm cleanly.

**Recommended approach for whoever picks this up:**
1. For each unique `owner/repo@vX` pair, resolve the SHA via `gh api
   repos/<owner>/<repo>/git/refs/tags/vX` (or `git ls-remote --tags
   https://github.com/<owner>/<repo>`) — do NOT guess or copy a SHA from
   memory/training data, always resolve live.
2. Add the version as a trailing comment so the pin stays human-readable:
   `uses: actions/checkout@8ade135a41bc03ea155e62e844d188df1ea18608 # v4.x.x`
3. Land as its own PR/commit, separate from any functional change, so a CI
   failure is unambiguously attributable to a bad pin and easy to `git
   revert`.
4. Push and watch the FULL run (not just the job that changed) go green
   before considering it done — a bad SHA on an action used only in a
   rarely-triggered workflow (e.g. `release-tag.yml`) could sit broken for
   weeks unnoticed otherwise.
5. Consider Dependabot's `github-actions` ecosystem entry (already
   configured in `dependabot.yml`) for keeping pins current afterward —
   Dependabot resolves and PRs SHA bumps automatically once actions are
   pinned to SHAs, so this is a one-time manual lift, not an ongoing burden.

Not a security emergency (all 11 files use well-known, widely-trusted
publishers — `actions/*`, `github/*`, `aquasecurity/*`, `zaproxy/*`,
`softprops/*`, `gitleaks/*` — none of which have been compromised as of this
writing), but a real hardening improvement worth doing carefully rather than
rushing.
