# Overnight autonomous session — 2026-07-07 night → 2026-07-08

Self-authored, Dustin heading to bed. Pulled from the memory backlog and verified against
live code first (this project has a strong pattern of stale "still open" items — an agent
pass confirmed which of these are real before this list was finalized). Note: a *different*
overnight prompt with the same 2026-07-07 date already exists and already ran
(`OVERNIGHT_AUTONOMOUS_PROMPT_2026-07-07.md`, test-report capture gaps / arc-flash honesty /
EDMS schema slice / mojibake cleanup — see its own commits, already shipped). This is a
separate, later list — work top-down; don't rush the #1 item to get to the bottom of the
list, it's the one Dustin explicitly called a requirement.

**Boundaries:** ServiceCycle repo only — do not touch LapseIQ or Forgerift per standing
project instructions. Don't spend money or sign up for new external accounts (Better Stack,
Gemini prepay, etc.) — those stay parked for Dustin. Don't guess on genuine product-judgment
calls (ambiguous UX/business semantics) — write a scoping/design doc instead of shipping a
guess, same treatment EDMS/Probo/BYO-storage got in prior sessions. Commit + push regularly
via `windows-shell` (git credential confirmed working 2026-07-07, PowerShell may report a
`NativeCommandError` on git's normal remote status-check stderr chatter even on a *successful*
push — check the actual output for a `<sha>..<sha> main -> main` line before treating it as a
failure). Use the `engineering-guidelines` skill before any schema migration or background
job work. Targeted `git add` only, never `git add -A`.

## 1. Per-tenant BYO storage (REQUIREMENT — top priority)

Dustin, 2026-07-07: "that's a requirement not a nice to have." Full verified scope already
in memory `servicecycle-byo-storage-requirement-2026-07-07` — re-read it via the memory
system if this session doesn't have it in context. Summary: `server/lib/storage.ts` is
already a clean local-vs-S3-compatible-endpoint abstraction (13 call sites, all through the
shared module). Today it's global env-var config; needs to become per-account:

1. Add a storage-config field (bucket, endpoint, encrypted credentials) to the tenant/account
   model in `server/prisma/schema.prisma`. Design the encryption approach for tenant-supplied
   secrets — likely reuse whatever pattern `MASTER_KEY`-based encryption already uses
   elsewhere in the codebase (check `server/lib/backup.js` / wherever secrets are already
   encrypted at rest for precedent) rather than inventing a new one.
2. Change `getS3Client()`/`getConfig()` in `storage.ts` to resolve config per-`accountId`
   instead of reading `process.env` directly. Keep a fallback to the existing global env vars
   for accounts that haven't configured their own storage (don't break the demo/existing
   accounts).
3. Thread `accountId` through the ~13 call sites — they already carry it for key-building, so
   this should be mechanical.
4. Real-DB tests: an account with custom storage config uses its own bucket; an account
   without one falls back to the global default; a cross-tenant isolation check (account A's
   config never leaks into account B's calls).
5. This is a real schema migration touching a config surface — additive only (new nullable
   columns/tables), `tsc --noEmit` + full jest clean before commit, backward-compatible so
   existing accounts keep working through the deploy.

If you get through this and it's solid (tsc clean, tests green, migration applied cleanly
against a real local DB), that's a full, successful night on its own — don't feel obligated
to rush into the items below.

## 2. npmrc hardening (quick, safe)

Verified 2026-07-07: `server/.npmrc` does not exist. Add it with `save-exact=true` and
`ignore-scripts=true`. Verify `npm install` / the deploy build still completes cleanly after
adding it (some packages rely on postinstall scripts — check the build doesn't break before
committing; if something needs an `ignore-scripts` exception, document why rather than
silently dropping the hardening).

## 3. Semgrep in CI

Verified 2026-07-07: no Semgrep step exists in any `.github/workflows/*.yml` (CodeQL already
does — don't duplicate that). Add a Semgrep step using the `p/owasp-top-ten` + `p/nodejs` +
`p/python` rulesets (per the original SOC2 AI-code-security research,
`docs/security/AI_CODE_SECURITY_RESEARCH_2026-07-07.md`). Start it as report-only /
non-blocking on first run — review whatever it finds, and only make it a merge-blocking gate
if the findings are clean or clearly false-positive (don't let a noisy first run block
Dustin's own future pushes without him having seen the findings first).

## 4. measurementSanity.ts coverage check

Verified 2026-07-07: `server/lib/measurementSanity.ts` exists and is mostly covered
(`checkMeasurementSanity` has direct tests in `complianceIntegrityB.test.ts`), but
`checkMeasurement(s)` and `applyNameplateDowngrades` coverage wasn't confirmed. Check whether
real-DB tests exist for those two; if not, add them. This is a narrow gap-fill, not a
from-scratch build.

## 5. Role-on-assignment

Deferred item from two separate roadmap memories (`servicecycle-ux-cluster-shipped`,
`servicecycle-arcflash-roadmap-additions`). Concrete definition per memory: "assign role
automatically when field_tech is assigned to a WO [Work Order]." That memory is 12+ days old
— re-verify against the live schema first (check for a WorkOrder assignment model and how
field_tech role currently works) before assuming the scope is still accurate. If the exact
product semantics are genuinely ambiguous (e.g. what role gets assigned, whether it's
per-WO-type, whether it affects permissions or is just informational), write a short scoping
note instead of guessing — same treatment EDMS/Probo/storage got. If it's clear enough to
implement safely, implement it with tests.

## 6. First-customer pilot kickoff doc + generic SOW template

Per `servicecycle-first-customer` memory: two docs are missing for the (not-yet-scheduled)
first prospect meeting. **Do not name the company anywhere** — write generically for "a
NETA-accredited electrical testing/maintenance contractor."

1. A "Contractor Pilot Kickoff" doc: what happens after they say yes — what data they bring,
   week 1 onboarding, what they see in week 2. Ground it in what's actually in the product
   (check `docs/DEMO_SCRIPT.md` for the real feature set/flow rather than inventing
   capabilities).
2. A generic pilot proposal/SOW template — the pitch/terms structure, not a filled-in
   contract (no pricing commitments — flag pricing as a TBD placeholder for Dustin to fill
   in, don't invent numbers).

Save both under `docs/` (e.g. `docs/CONTRACTOR_PILOT_KICKOFF.md`,
`docs/PILOT_SOW_TEMPLATE.md`).

## 7. LAST PRIORITY: CCA-F study gap docs

Only if everything above is done and there's still time — same "run out of ideas" framing
Dustin used for Probo prep. Per `servicecycle-cca-f-examprep-2026-07-06` memory, the
identified study gaps were hooks, MCP primitives, and prompt caching. Write 1-3 more study
docs on those specific topics, same style/location as the 5 already-shipped study PDFs from
that session (check where those live before adding more, keep consistent).

## Final step (do this regardless of how far down the list you get)

Write a recap memory summarizing what shipped, what's still open, and any judgment calls
made along the way (mirroring `servicecycle-daytime-2026-07-07`). Update `MEMORY.md`. Note
HEAD commit hash for whatever got pushed.
