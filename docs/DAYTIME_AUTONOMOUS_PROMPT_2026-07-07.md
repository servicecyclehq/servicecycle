# Daytime Autonomous Session — 2026-07-07 (Dustin in office, ~10hr window)

Self-authored, following the same pattern as `OVERNIGHT_AUTONOMOUS_PROMPT_2026-07-07.md`
(last night). Grounded in real recon, not guesses. Executed in the same session that wrote it.

## Context carried in from last night

- **BLOCKER, still open at kickoff:** `origin/main` stuck at `521f812`; local `main` has 2
  unpushed commits (`7a25813` arc-flash F4/F6/F7, `3c0c48e` signPayload/mojibake). Root
  cause: GCM's `servicecyclehq` push credential needs a one-time interactive re-auth Dustin
  hasn't done yet. Retry the push periodically through tonight in case he fixes it
  mid-session from his phone/another machine; don't let it block other work.
- Earlier today: researched DigitalOcean CSPM, DigitalOcean's MCP server, and Probo
  (self-hosted GRC, getprobo.com) as a SOC2-dashboard stack. All three verified real
  (not hallucinated) against primary docs. Dustin's decision: back-log the SOC2 dashboard
  work, do *some* tonight, but Probo hosting prep is **explicitly last priority** — only
  touch it if every other item below is done and there's still time left. He also confirmed
  neither SharpEdge (1GB RAM, 94MB free, already swapping) nor ServiceCycle's own droplet
  (2GB RAM, 918MB available) has headroom for Probo's stated 4GB RAM / 20GB disk minimum —
  do NOT install Probo on either box tonight. Prep-only (compose files + runbook), no deploy,
  no new droplet spend without Dustin's explicit go-ahead.

## Standing constraints (same discipline as every other overnight session)

- ServiceCycle repo only. Forbidden to touch LapseIQ or Forgerift repos/code without asking
  — read-only recon on SharpEdge/LapseIQ droplets is fine, no writes.
- All git/tsc/jest through the `windows-shell` MCP (`run_powershell`), never the bash sandbox,
  for this repo.
- Targeted `git add` only, never `git add -A`. New `server/__tests__` files need `git add -f`.
- No live AI/Gemini/vision calls — don't burn quota.
- No SOC2-adjacent items owned by the separate "SOC2 readiness assessment" session unless
  Dustin has asked here directly (he has, for the dashboard research — proceed).
- No client-side/UI changes — backend/schema/docs/infra only. Anything needing visual QA
  gets scoped out and flagged, not built blind.
- Schema changes additive only (new nullable columns/tables). `tsc --noEmit` + jest clean
  before every commit.
- Deploy only when runtime code changed; verify `get_app_status` healthy after.
- Real-Postgres tests for anything DB-touching, never mocked Prisma for new coverage.
- Use vps-control MCP tools directly for all droplet ops — never hand Dustin a command to
  paste, unless the MCP genuinely can't do it (say why if so).

## Ambitious list, roughly in priority order

1. **Retry git push** at start, midpoint, and end of session. If it succeeds, push both
   pending commits and deploy them (rebuild+restart per canonical deploy ref — F4/F6/F7 and
   signPayload/mojibake are both runtime-code commits).
2. **Persist SOC2 dashboard research to memory** — done as part of authoring this doc;
   verify the backlog memory file reads cleanly afterward.
3. **SOC2 quick win: enable DigitalOcean CSPM (free Standard Rules tier)** on the account —
   zero cost, agentless, no code. Check if this is reachable via the DO API/MCP or needs
   Dustin to click it in the control panel; if the latter, note it plainly rather than guess.
4. **SOC2 quick win: "Database Isolation Proof" 1-pager** — a short markdown doc explaining
   SC's `accountId`/tenant-filter isolation pattern (already true in the code — this is
   documentation, not a build), suitable to hand an auditor or acquirer.
5. **SOC2 quick win: OS/dependency vuln-scan cron via Trivy-in-Docker** — `docker` is on the
   VPS MCP's approved-binary allowlist, `trivy` itself is not, so run it as
   `docker run aquasec/trivy image ...` against the running server image, on a weekly
   schedule, dumping results to an evidence file. Needs `engineering-guidelines` skill
   consult first (new scheduled job on prod).
6. **EDMS Phase 1 — schema-only slice** (deferred twice now, scope frozen in
   `docs/scoping/EDMS_MODULE_SCOPE_2026-07-04.md` §5/§14 Phase 1). Do ONLY the additive
   schema migration: new tables (`DrawingRevision`, `DrawingAnnotation`,
   `DrawingSymbolLink`, `DrawingShareLink`, `DrawingPageText`) + nullable columns on
   `Document`/`Site`/`Account`. Explicitly do NOT touch `storage.ts`/R2 wiring, the
   `DrawingConverter` adapter, or the Dockerfile (LibreOffice/LibreDWG) — those need a live
   smoke test per the scope doc's own Phase 1 definition ("no user-visible change yet" is
   the bar; the storage/Docker pieces are a bigger blast radius than a blind overnight
   change should take on).
7. **FAQ / Help Center backlog** — write the still-missing customer-facing docs: RUL
   scoring methodology, NFPA 70B rating explainer, forecast-range explainer (arc flash
   QEMW already done per memory). Pure docs, zero code risk.
8. **Cron test-coverage audit** — grep for any scheduled job still lacking a real-DB
   regression test, following the exact Tier1/2/3 pattern from the 2026-07-06 cron-hunt
   session. Only build tests for genuine gaps found live, not from a stale list.
9. **Re-verify one more old audit doc for stale/already-fixed claims** if time remains —
   same discipline as re-checking F4/F6/F7 against live code before trusting a doc's
   "still open" status.
10. **LAST PRIORITY — Probo self-host prep, no deploy.** Only if everything above is done
    and there's still runway: write the Docker Compose file (using Probo's documented
    `compose.prod.yaml` as the base), a secrets-generation script, and a short deploy
    runbook doc, saved in the repo (e.g. `docs/scoping/PROBO_DEPLOY_PREP_2026-07-07.md` +
    a `deploy/probo/` folder). No droplet touched, no money spent, nothing actually run.

## Closing recap requirement

Same as every session: write a recap memory file + update `MEMORY.md`'s index. Call out
explicitly: (a) git push status at end of session, (b) which of the 10 items above got
done vs. skipped and why, (c) anything flagged as needing Dustin's live input.
