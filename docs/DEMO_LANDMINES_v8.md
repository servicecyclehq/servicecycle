# DEMO_LANDMINES_v8 - ServiceCycle Acquisition-Readiness Scan

Generated: 2026-06-26
Round: v8 (acquisition kill-shots + demo-day credibility)
Personas: POP-8, DEMO-8, DD-8, CFO-8, COMP-8, NETA-8, INFOSEC-8, LEGAL-8, CUST-8, UX-8

Total findings: 145
  CRITICAL: 26
  HIGH: 48
  MEDIUM: 65
  LOW: 6

Methodology: 10 parallel adversarial-persona agents, each reading the codebase at
HEAD 85d10fa and producing verified, file+line-referenced findings. Focus this round
is NOT missing features (expected for v1) but things that would make a buyer's team
lose confidence or visibly break during a live walkthrough: demo-day credibility,
legal/safety liability, DD deal-risk, and untrustworthy numbers.

---


# POP-8 — PE Firm Operating Partner

Audit round v8. Persona: Marcus Hale, operating partner who will run ServiceCycle post-close. Focus: bus factor, manual/founder-only processes, silent-failure monitoring, DR gaps, and diligence-document accuracy. Every finding below was verified against code at HEAD 85d10fa. Where an earlier hypothesis failed verification (e.g. "no CI exists" — CI in fact exists at `.github/workflows/ci.yml`), it was dropped rather than reported.

---

**[POP-8-1] CRITICAL: Sole-operator bus factor is written into the incident-response plan by name**
`docs/INCIDENT_RESPONSE.md` names a single human — "Dustin (founder / sole operator)" — as Owner, and `docs/ENGINEERING_HANDOFF.md` states "There is currently one engineer (the founding engineer)." Every P0 containment step (kill sessions, take server offline, Cloudflare WAF, DO console) assumes that one person's access and knowledge; there is no second responder, no escalation path, and no documented credential-recovery path if he is unavailable for two weeks. For an acquirer this is the single largest valuation risk — the business does not survive a two-week founder absence. Fix: designate and document a backup operator, move droplet/Cloudflare/DO/Brevo access into a shared secret manager with break-glass procedure, and remove the single named owner from the IR plan in favor of a role.
File: docs/INCIDENT_RESPONSE.md lines 4, 198-208; docs/ENGINEERING_HANDOFF.md lines 129-131

**[POP-8-2] CRITICAL: Production is deployed from the founder's laptop working tree — no build provenance**
`deploy-sc-server.ps1` tars the local `server/` directory on `C:\Users\ddeni\Desktop\ServiceCycle` (hardcoded path, line 13) and `scp`s it to the droplet, then `docker compose up --build`. Production therefore runs whatever is on Dustin's machine — not a tagged git commit, not a CI-built image, with no checksum tying deployed bytes to a reviewed commit. The CI pipeline (`.github/workflows/ci.yml`) and GHCR image path (`manual-ghcr-push.ps1`) exist but the *actual* documented server deploy bypasses both. If his laptop is lost, the deploy capability is lost. Fix: make the GHCR-image path (CI-built, tagged, digest-pinned) the only production deploy route and retire the tar-the-laptop script.
File: deploy-sc-server.ps1 lines 13-37; deploy-sc-client.ps1 lines 12-32

**[POP-8-3] CRITICAL: Cron job-level monitoring is opt-in and off by default — silent scheduler death is invisible**
All ~40 scheduled jobs (backup, restore-test, prunes, alert engine, digests, weather/news scanners) run inside the single API process and are wrapped by `pingHeartbeat`, but `server/lib/heartbeat.ts` is a complete no-op unless `HEALTHCHECKS_PING_KEY` (or per-check `HEALTHCHECKS_URL_*`) is set in `.env`, AND each healthchecks.io check must be hand-created in a third-party dashboard first (lines 22-30). If the process OOM-restarts as a web-only worker, or the key is unset, every cron silently stops and nobody is paged — the failure surfaces "weeks later when a customer notices the missing renewal alert" (the module's own words). For a single-node deploy this is the difference between a missed backup being caught in minutes vs. discovered only after data loss. Fix: ship a sane default monitor (or fail-loud startup warning when no heartbeat key is configured in production) and document the dashboard pre-creation as a required go-live step, not optional.
File: server/lib/heartbeat.ts lines 45-98; server/index.ts lines 1524-1550

**[POP-8-4] CRITICAL: `server/.env` carries live, billable third-party API keys in plaintext on the founder's machine**
`server/.env` contains a real Groq key (`gsk_gl74H1...`), a real Gemini key (`AQ.Ab8RN6L...`), and a real base64 `MASTER_KEY`. It is gitignored and not tracked in git (verified: `git ls-files server/.env` is empty), so it is not in history — but it lives in plaintext in the working tree that the deploy tooling operates against, the keys are active and chargeable, and they exist nowhere in a secret manager. `docs/ENGINEERING_HANDOFF.md` line 33 claims "[the key] is not in the repo... not in the docker image... it lives only in the VPS .env and in your heads" — yet a working MASTER_KEY plus two cloud-AI keys sit in this file. Fix: rotate all three keys immediately, delete the plaintext dev `.env`, and source local secrets from a vault or `.env` that is generated, never authored by hand.
File: server/.env lines 3, 10, 12

**[POP-8-5] HIGH: ENGINEERING_HANDOFF.md — the CTO's day-1 map — points at four files that do not exist**
The handoff (audience: "Incoming engineering lead or CTO post-acquisition") repeatedly cites `server/prisma/reseed.ts` (3x, incl. demo-seed and reseed sections), `server/lib/aiCascade.ts`, `server/middleware/multiTenantMiddleware.ts`, and `server/lib/arcFlashLabels.ts`. All four were verified non-existent (Read returns "File does not exist"). The real files are `server/scripts/seed-demo.js`, `server/lib/ai.ts` (cascade), per-route `accountId` filtering via `server/middleware/auth.ts`, and `server/lib/arcFlashLabel.ts`/`arcFlashLabelDoc.ts`. The Day-1 reading list literally tells the new lead to read two files that aren't there. In technical diligence, a handoff doc that fails its own file-path check signals the docs were never validated against the tree. Fix: regenerate the handoff against actual filenames and add a CI doc-link check.
File: docs/ENGINEERING_HANDOFF.md lines 25, 45, 70, 96, 106, 121

**[POP-8-6] HIGH: RISK_REGISTER claims security controls (offsite S3 backups) that depend on unverifiable operator config**
`docs/RISK_REGISTER.md` R-03 lists "daily Postgres backups (encrypted, offsite S3)" as an *active control* that drops residual risk to 6. But offsite is only real if `BACKUP_DEST=s3` and `BACKUP_S3_*` are set in the droplet `.env`; the default is `local` (`server/lib/backup.ts` lines 50-67, which warns on every boot that local-only = "100% data loss if the host fails"). The repo cannot prove S3 is live, and the parallel `scripts/backup-db.sh` is local-only. If a buyer's DD asks to see the S3 bucket and it is local-only, the register misrepresents the control. Fix: make the register state the configured value, add a `/api/admin/backup-config` evidence check to diligence, and enforce `BACKUP_DEST=s3` in production via a startup guard.
File: docs/RISK_REGISTER.md line 21; server/lib/backup.ts lines 55-92

**[POP-8-7] HIGH: Incident-response forensic commands reference a container name that does not exist**
`docs/INCIDENT_RESPONSE.md` instructs responders to run `docker exec -i servicecycle-server-1 ...` (login-failure query, line 50-52) and `docker logs servicecycle-server-1` (lines 82, 94) during a live P0. But `docker-compose.yml` pins `container_name: servicecycle-server` (verified line 170) — there is no `-1` suffix. Every one of these emergency commands fails with "No such container" exactly when minutes matter and the operator is under stress. Fix: correct the container names to `servicecycle-server` / `servicecycle-db` throughout the IR plan, and dry-run the runbook against the live box.
File: docs/INCIDENT_RESPONSE.md lines 50-52, 82, 94; docker-compose.yml line 170

**[POP-8-8] HIGH: Cron-leader "fail-closed" lock guard silently falls through and is a dead variable**
On boot the app grabs a Postgres advisory lock so exactly one instance owns the crons. The catch block for a failed lock probe (DB blip at startup) sets `cronLeader = false` and the comment says it "fail[s] CLOSED: do NOT register crons" — but there is no `return`, so execution falls straight through into the cron-registration block below. Worse, `cronLeader` is assigned once and referenced nowhere else (verified: single occurrence in the file), so it is a no-op. The stated safety property is not implemented; on a transient DB error at boot the box registers crons anyway, and in any future multi-instance deploy this double-fires backups, prunes, and digests. Fix: `return` after the failed-probe branch (or gate registration on the lock result) and delete the dead variable.
File: server/index.ts lines 1696-1703

**[POP-8-9] HIGH: Three divergent deploy paths with three different droplet directories — pure tribal knowledge**
Production can be updated three incompatible ways: (a) `deploy-sc-server.ps1` → `/root/ServiceCycle` via build-on-box `docker-compose.yml`; (b) `manual-ghcr-push.ps1` + `docker-compose.ghcr.yml` → `/root/servicecycle` via pulled images; (c) `scripts/sync-droplet-compose.sh` → `/root/servicecycle-src/` then copy to `/root/servicecycle`, which exists solely to patch a silent gotcha where compose `environment:` whitelist changes "ship to the repo but never reach the running droplet." Three paths, three case-sensitive directories, and an undocumented env-passthrough failure mode that only the founder knows to fix. A new operator will deploy to the wrong directory or ship an env var the container never sees. Fix: collapse to one deploy path and one canonical droplet directory, and document the compose-env-whitelist requirement in the runbook.
File: scripts/sync-droplet-compose.sh lines 4-34; deploy-sc-server.ps1 line 29; scripts/manual-ghcr-push.ps1 lines 240-244

**[POP-8-10] HIGH: ENGINEERING_HANDOFF describes the wrong email vendor and a wrong AI cascade order**
The handoff (line 15) states the stack uses "Resend for email" and an AI cascade of "Anthropic Claude (primary) → Google Gemini → Groq." Both are wrong against code: `server/lib/email.ts` uses Brevo (`https://api.brevo.com/v3/smtp/email`, line 19) and contains an explicit warning that "ServiceCycle no longer uses Resend" (lines 82-84); the real cascade in `server/lib/ai.ts` is provider-configurable with a Cloudflare → HuggingFace → Groq fallback chain (lines 17, 34-35), not Anthropic→Gemini→Groq. An acquirer reconciling vendor contracts and DPAs against this doc will mis-scope the vendor list (and `docs/INCIDENT_RESPONSE.md` line 19/205 still lists Resend as a live vendor). Fix: correct the vendor and cascade descriptions in both docs to match `email.ts`/`ai.ts`.
File: docs/ENGINEERING_HANDOFF.md lines 15, 94-96; server/lib/email.ts lines 19, 82-84

**[POP-8-11] MEDIUM: Demo reseed is terminal-only and the runbook seed step is hand-run, with no automated re-seed**
The deploy runbook §6 requires an operator to manually `docker compose exec server node ... scripts/seed-standards.js` then `scripts/seed-demo.js` after every fresh deploy (lines 174-177), and the handoff confirms "the reseed script requires a terminal... not wired to any API endpoint" (line 70). Refreshing the live demo at `servicecycle.app` therefore depends on the founder opening a shell on the droplet (consistent with the standing note that "reseed still needs Dustin's terminal"). For a sales-critical demo environment that an acquirer will exercise, the inability to re-seed without one specific person is an availability and continuity gap. Fix: expose a guarded admin-only reseed endpoint or a one-command script any operator can run, and document it.
File: docs/DEPLOY_RUNBOOK.md lines 170-189; docs/ENGINEERING_HANDOFF.md line 70

**[POP-8-12] MEDIUM: Off-box backup copy, DO snapshots, uptime monitor, and disk alerts are "operator must remember" — not automated**
DEPLOY_RUNBOOK §11 lists the actual DR safety net — "Copy pg_dump backups off-box," "Enable DigitalOcean droplet backups," "External uptime monitor," "Disk-space alert," and "take a manual snapshot after go-live" — entirely under "You should set up soon after go-live (operator, not in repo)" (lines 299-305). None of these are codified; they live in the founder's head and his discipline. The handoff's claimed "RTO ~2h, RPO ~24h" (line 56) is only achievable if every one of these manual steps was actually performed, which the repo cannot evidence. Fix: convert these into provisioned infrastructure (Terraform/automation) or at minimum a checked-off go-live runbook stored with the account, so DR does not depend on memory.
File: docs/DEPLOY_RUNBOOK.md lines 299-305; docs/ENGINEERING_HANDOFF.md line 56

**[POP-8-13] MEDIUM: The deepest backup-restore validation silently no-ops without an undocumented env var**
The monthly `deepRestoreTest` cron — the only job that actually asserts row counts on a restored dump, the true proof a backup is recoverable — returns "skipped" whenever `PG_TEST_DB_URL` is unset (server/index.ts lines 2062-2065), and that var is not in `.env.example` or the runbook's required vars. The weekly `restoreTest` only runs `pg_restore --list` (parse check, not a real restore). So on the live box the strongest restore proof is most likely silently skipped, and `runOnce` reports green for a skip. An acquirer asking "prove you can restore" gets a passing dashboard that never actually restored anything. Fix: provision a sidecar Postgres + `PG_TEST_DB_URL` in production, document it, and make a persistent "skipped" state alarm rather than report success.
File: server/index.ts lines 2053-2074

**[POP-8-14] MEDIUM: Orphaned standalone backup script writes local-only to a path that matches no deployment**
`scripts/backup-db.sh` ships with a cron-install header (`0 3 * * * /opt/servicecycle/scripts/backup-db.sh`) and dumps to `/opt/servicecycle/backups` — a path used by no documented deploy (the droplet lives at `/root/ServiceCycle`, the app writes to `./backups`). It is referenced nowhere except itself (verified via `git grep`). An operator who follows the script's own header wires up a *second*, local-only, offsite-blind backup that silently duplicates and conflicts with the in-app cron and gives false confidence. Fix: delete the orphaned script, or align it with the in-app backup (S3-capable, correct path) and reference it from the runbook.
File: scripts/backup-db.sh lines 3-22

**[POP-8-15] MEDIUM: RISK_REGISTER scored a security risk DOWN based on controls described with a wrong location, and overstates deploy safety**
R-05 (supply-chain) was downgraded 6→4 (review history line 56) citing "npm audit in CI" and "`.github/dependabot.yml` ... CI now active." These controls do exist (verified `.github/workflows/ci.yml` and `.github/dependabot.yml`), so the control is real — but the same register's R-06 claims "Zero-downtime ... Docker Compose rolling rebuild" while the runbook itself admits "No zero-downtime: docker compose up -d has a brief restart window" (line 309). A register that contradicts the runbook on whether deploys are zero-downtime undermines confidence in every other residual score during diligence. Fix: reconcile R-06 with the runbook (state the real restart-window behavior) and add a cross-check pass so the register's claims trace to verifiable artifacts.
File: docs/RISK_REGISTER.md lines 24, 56; docs/DEPLOY_RUNBOOK.md line 309

---

# DEMO-8 — Live Demo Session Tester

Scope: I clicked the exact buyer flow — login → dashboard → asset detail → work order → arc flash tab → reports → field tech — and traced `server/scripts/seed-demo.js` (+ `seed-arcflash-trend-demo.js`) against `FleetDashboard.jsx`, `Dashboard.jsx`, `AssetDetail.jsx`, `WorkOrderDetail.jsx`, `ArcFlashAssetTab.jsx`, `ArcFlashFleet.jsx`, `ArcFlashReport.jsx`, `ReportsHub.jsx`, and `client/src/pages/field/*`. Findings are verified in code with file + line cites.

---

**[DEMO-8-1] CRITICAL: Arc-flash HERO bus shows DANGER on the dashboard card but WARNING on every detail page — the demo's flagship feature contradicts itself in the room**
The seed hard-codes `labelSeverity: 'warning'` on the 13.8 kV SWGR-1A-1 bus (the headline arc-flash trend asset). The account dashboard card counts danger purely as `IE>40 OR volts>600` and so reports this 13.8 kV bus as **1 DANGER bus** (arcFlashIngest.ts:851-852), while the per-asset Arc Flash tab, the Arc Flash Fleet rollup, and the Arc Flash Label Report all honor the stored `labelSeverity` first and render the SAME bus as **WARNING / 0 DANGER** (arcFlashIngest.ts:1552, v1/arcFlash.ts:76, ArcFlashReport.jsx:44). A buyer who clicks the dashboard "1 DANGER bus" → Arc Flash report sees "0 DANGER" — a glaring self-contradiction on the product's hero feature. Fix: drop the explicit `labelSeverity` from the seed binding (let it derive to `danger` for >600 V) OR make `/dashboard` respect stored severity like the other three paths.
File: server/scripts/seed-demo.js lines 1424, 1464; server/routes/arcFlashIngest.ts lines 851-861, 1552

**[DEMO-8-2] CRITICAL: The two arc-flash seed scripts tell opposite stories on the same bus (WARNING vs DANGER)**
`seed-demo.js` binds SWGR-1A-1 at 19.6 cal/cm² with `labelSeverity: 'warning'` and a comment "WARNING class; IE=19.6 cal/cm² < 40", yet the printed-label snapshot on the very same row is stamped `labelSeverity: 'danger'`, and the companion `seed-arcflash-trend-demo.js` re-targets the best MV switchgear and logs "Trend: 14.2 → 19.6 cal/cm2 … DANGER (13.8kV)". If both scripts run (the trend script "ADDS rows" and re-binds), the asset can end up with conflicting WARNING and DANGER bindings/snapshots for one bus. A diligence reviewer reading the seed will immediately flag the inconsistency. Fix: pick one severity convention (13.8 kV ⇒ DANGER) and apply it identically in both scripts and the printed snapshot.
File: server/scripts/seed-demo.js lines 1410, 1424, 1464; server/scripts/seed-arcflash-trend-demo.js lines 16-18, 162-171

**[DEMO-8-3] CRITICAL: Seed sets `conditionScore` on 8 assets but `_createAsset` silently drops it — Degradation Priority sort and the WorkOrders condition column show "—" for the assets the demo built to be the degradation story**
Asset specs carry `conditionScore: 4/3/2…` (seed-demo.js lines 609, 618, 628, 648, 664, 677, 688), but the `_createAsset` writer (lines 378-415) never reads `spec.conditionScore`, so it is never persisted and the stored DPS (`conditionScore × criticalityScore`, schema.prisma:825) stays null. The client DOES read it: AssetsList offers a "Degradation Priority Score (DPS)" sort (AssetsList.jsx:755) and WorkOrdersList renders `a.conditionScore ?? '—'` (WorkOrdersList.jsx:405). Result: the DPS sort does nothing and the condition column is "—" on every row — including SWGR-1A-1 (conditionScore:4) and T-1 (conditionScore:3) that the seed comments tout as the worst-condition assets. Fix: add `conditionScore: spec.conditionScore ?? null` to `_createAsset` data.
File: server/scripts/seed-demo.js lines 378-415, 609; client/src/pages/WorkOrdersList.jsx line 405; client/src/pages/AssetsList.jsx line 755

**[DEMO-8-4] HIGH: Seed creates ~hundreds of "historical" work orders that flood "Recent work orders" with anonymous, taskless rows**
`_createHistoricalWorkOrders` back-fills 5 years of COMPLETE work orders across every schedule (seed-demo.js lines 331-377, logged as "seeded N historical work orders (5yr)"), each created with only `scheduleId`/`assetId`/`contractorId` and no task-name enrichment. The dashboard "Recent work orders" card sorts by `updatedAt` and renders task name + contractor (Dashboard.jsx:1025-1057). Because these bulk rows are created together (`createMany`), a reset can leave the "most recently updated" feed showing a wall of identical-looking historical jobs instead of the 5 curated WOs (#1-#23) — diluting the crafted story a buyer is meant to see. Fix: stagger `createdAt/updatedAt` on the historical batch into the past, or exclude `scheduleId`-less synthetic rows from the recent feed.
File: server/scripts/seed-demo.js lines 331-377, 796-797; client/src/pages/Dashboard.jsx lines 1019-1060

**[DEMO-8-5] HIGH: FleetDashboard account detail renders the service-rep bar only when `data.account.serviceRep` is truthy — a field the seed never sets**
The OEM Fleet account panel gates the rep contact block on `data.account.serviceRep` (FleetDashboard.jsx:174), but the seed sets `serviceRepName/Email/Phone` on the Account, not a `serviceRep` boolean (seed-demo.js lines 437-439). Unless the `/api/fleet/accounts/:id` route synthesizes `serviceRep`, the rep bar never appears in the demo even though rep data exists — the "who do I call" value prop silently vanishes from the fleet view a partner/OEM buyer is shown. Fix: gate on `serviceRepName` (which is what's rendered two lines down) or have the route return `serviceRep: true`.
File: client/src/pages/FleetDashboard.jsx lines 174-188; server/scripts/seed-demo.js lines 437-439

**[DEMO-8-6] HIGH: GEN-1's seeded story self-contradicts — "no faults, started first attempt" monthly exercise vs. an overspeed TRIP on the monthly transfer test**
WO #17 (GEN-1 monthly exercise, ~20 days ago) reads "Engine started on first attempt … checks satisfactory" with a GREEN decal and C1/C1 (seed-demo.js lines 1119-1129), while incident #5 says GEN-1 "Overspeed relay tripped GEN-1 during monthly NFPA 110 transfer test. Engine governor … drifted out of calibration" ~91 days ago (lines 1896-1906). Both surface on the GEN-1 detail page (work-order history + arc-flash/incident register). A buyer reading the asset's own records sees a generator that both "passed clean" and "tripped on overspeed" in adjacent monthly tests with no narrative bridge. Fix: align dates/notes so the trip pre-dates and is closed out by the clean exercise, or reference the governor repair in WO #17's notes.
File: server/scripts/seed-demo.js lines 1119-1129, 1896-1906

**[DEMO-8-7] HIGH: SWGR-2M shows an OPEN IMMEDIATE deficiency (ΔT 38°C) AND an OPEN "RECOMMENDED early-stage 12°C" deficiency for the same B-phase joint — contradictory severities on one connection**
Deficiency #1 (IMMEDIATE, "ΔT 38°C above ambient", created 12 days ago, unresolved) and the extra RECOMMENDED deficiency ("delta-T 12 deg C … early-stage thermal signature", created 350 days ago, `resolvedAt: null`) both sit OPEN on SWGR-2M's B-phase bus connection (seed-demo.js lines 1217-1223, 1256-1263). On the asset's Deficiencies list a buyer sees the same joint simultaneously flagged "repair at earliest convenience (early-stage)" and "de-energize at first opportunity (severe)" — the older one should be resolved/superseded. The seed comment even admits "Consolidate corrective actions." Fix: set `resolvedAt` on the 350-day-old RECOMMENDED row (superseded by the IMMEDIATE).
File: server/scripts/seed-demo.js lines 1217-1223, 1256-1263

**[DEMO-8-8] MEDIUM: Quote-request dossier snapshots freeze obviously wrong equipment ages (T-1 "16 yr" but installed 1997 ≈ 29 yr; GEN-1 "8 yr" but installed 2005 ≈ 21 yr)**
`dossierSnapshotT1` hard-codes `ageYears: 16` and `dossierSnapshotGen1` `ageYears: 8` (seed-demo.js lines 1674, 1679), but the assets' install dates are 1997-06-12 and 2005-08-23 (lines 606-611, 661-667) → ~29 and ~21 years at the 2026 demo date. These snapshots are attached to seeded QuoteRequests and viewable in the quote dossier. A buyer who opens a quote and cross-checks the asset sees the age off by 13 years. Fix: compute `ageYears` from `installDate` at seed time instead of literals.
File: server/scripts/seed-demo.js lines 1674-1684, 606, 662

**[DEMO-8-9] MEDIUM: "Clears DANGER (>40)?" what-if can never say "Yes" for the seeded arc-flash bus, making the headline mitigation ROI feel inert**
The mitigation what-if labels success as "Clears DANGER (>40)?" and computes `removesDanger = ie>40 && ieAfter<=40` (ArcFlashAssetTab.jsx:652; arcFlashMitigation.ts:140). The only seeded bus with incident energy is 19.6 cal/cm² (already <40), so `requestQuote`/`runWhatIf` always returns "Clears DANGER: No" — and for a bus the platform elsewhere calls "DANGER (13.8 kV)". When a buyer drives the flagship incident-energy-reduction tool, the answer to "does this remove the danger?" is permanently "No," which reads as the feature not working. Fix: seed a >40 cal/cm² bus (or one with a meaningful PPE-category drop) so the what-if demonstrates a real "Yes."
File: client/src/components/ArcFlashAssetTab.jsx lines 648-654; server/lib/arcFlashMitigation.ts lines 119, 140

**[DEMO-8-10] MEDIUM: Disaster Response page is seeded with WISCONSIN events, but both demo sites are in IOWA/ILLINOIS — geographically incoherent in the room**
The seed creates a "Severe Thunderstorm Watch — Milwaukee/Waukesha County" and a "Blizzard Warning — Northern/Central Wisconsin" with `affectedStates: ['WI']` (seed-demo.js lines 1346-1373), but Riverside Plant is Davenport, IA and Eastgate is Moline, IL (lines 491, 533). The events are wired to the real site IDs so they DO render on the Disaster Response page, showing Wisconsin weather "affecting" Iowa/Illinois facilities. A buyer who knows the site addresses (shown on Sites) will notice the mismatch. Fix: relabel the seeded events to IA/IL regions matching the sites.
File: server/scripts/seed-demo.js lines 1346-1373, 491, 533

**[DEMO-8-11] MEDIUM: ArcFlashFleet AFX panel advertises ARCAD/SKM/EasyPower templates as "EXACT (verified)", a diligence-risk overclaim with no seeded backing**
The AFX panel renders per-tool template buttons with a green "EXACT" badge whose tooltip asserts "column names verified from vendor-published import templates" for ARCAD, SKM PTW, and EasyPower (ArcFlashFleet.jsx:171-179, 390-397). Per project memory the AFX per-tool templates are a DEFERRED item still needing the real vendor files. Presenting unverified mappings as "EXACT — verified" to an OEM/PE buyer during diligence is the kind of overstatement that surfaces in technical review. Fix: demote all four to "DRAFT" until the vendor templates are actually validated, matching the deferred status.
File: client/src/pages/ArcFlashFleet.jsx lines 171-179, 390-403

**[DEMO-8-12] MEDIUM: Field "My Day" can show a generator under "Overdue" with a passing GREEN monthly-exercise WO completed days earlier — mixed signals for the tech**
GEN-1's load-bank schedule is seeded 9 days overdue (dueIn:-9) and its monthly-exercise WO #17 is COMPLETE GREEN ~20 days ago (seed-demo.js lines 762, 1119-1129). In FieldHome the same asset appears in the red "Overdue" section (load bank) while its recent history is clean (FieldHome.jsx:377-389). That's defensible, but combined with the IN_PROGRESS load-bank WO #3 "running today" (lines 900-908), a tech sees GEN-1 simultaneously "9d overdue," "in progress today," and "passed 20 days ago" with no linkage — easy to read as stale data. Fix: ensure the IN_PROGRESS WO suppresses or annotates the overdue chip for the same schedule.
File: server/scripts/seed-demo.js lines 762, 900-908, 1119-1129; client/src/pages/field/FieldHome.jsx lines 377-389

**[DEMO-8-13] MEDIUM: AuditRecommendation notes reference a "2022 study" for PPE re-labeling, but the seeded current arc-flash study is ~4.2 years old (≈2022) AND described as the one being superseded — date/era drift in audit evidence**
The internal audit finding's response notes say kits were "re-labelled with current 2022 study values" (seed-demo.js line 1541), and another insurer rec says labels "reference superseded study values" (line 1510), while the actual current `arc_flash` study is performed ~4.2 yr ago with the prior at ~9 yr (lines 1378, 1395). Hard-coding "2022" into evidence text that's rendered on the Audits page means on any reset day the prose year drifts from the relative-dated study, and a buyer reading both the audit note and the study tab sees inconsistent vintages. Fix: drop the literal "2022" from audit note text (use relative phrasing) so it tracks the relative study dates.
File: server/scripts/seed-demo.js lines 1510, 1538-1541, 1378, 1395

**[DEMO-8-14] LOW: ReportsHub still shows "Maintenance Activity Summary" and "Trend Analysis" as greyed PLANNED cards — a buyer reads unfinished product on the Reports page**
ReportsHub renders the registry and the intro text explicitly says "Activity summaries and test-value trending are planned" with disabled cards (ReportsHub.jsx:222-223, 76-86). With 24 months of seeded work-order history present, leaving two named reports visibly "Planned" on the headline Reports surface signals an incomplete product during a demo. Fix: either ship/flip these (data exists) or hide planned cards from the demo account rather than displaying them greyed.
File: client/src/pages/ReportsHub.jsx lines 76-86, 219-224; client/src/tables/reportsRegistry.js

---

# DD-8 — M&A Technical Due Diligence Lead

Scope: read-only source audit of the ServiceCycle monorepo at HEAD 85d10fa for an acquisition / technical-DD scan (v8). Focus on deal-killers: secrets, auth bypasses, audit-trail integrity, dependency/license risk, and diligence hygiene. The core auth surfaces (auth/roles/demoGuard middleware, SSO, 2FA, API-key auth, storage, inbound-email & SCIM signature verification, SSRF guard, startup secret-validation) are genuinely mature — six prior rounds show. The findings below are the residual risks a buyer's tech-DD team will actually write down. Every finding is verified against the cited source.

**[DD-8-1] HIGH: Live third-party AI API keys sit in plaintext in the deployment working tree (server/.env)**
`server/.env` on the box contains real, active credentials — `GROQ_API_KEY=gsk_<REDACTED>` and `GEMINI_API_KEY=AQ.<REDACTED>` — alongside a base64 `MASTER_KEY` that encrypts all stored TOTP secrets and DB-stored credentials. The file is correctly git-ignored (never committed — verified via `git log --all -- server/.env` returning empty), so this is not a history leak, but a DD reviewer granted repo/host access immediately sees billable live keys and the document-encryption root key in cleartext on disk. Rotate both AI keys before any data-room/host handover and inject all three via the orchestrator's secret store, never a file in the app directory.
File: server/.env lines 1-13

**[DD-8-2] HIGH: Audit-trail tamper-evidence is fully reversible by any actor with app-server access — material for a SOC2 / safety buyer**
The ActivityLog hash chain (`activityLogChain.ts`) is the integrity control behind safety (arc-flash) and financial mutations, but its own header concedes it "Does NOT defeat: insider with both DB access AND app-server access (or knowledge of the canonical() function) who rewrites the chain and recomputes all subsequent hashes." There is no external anchoring (no notarization, no append-only WORM store, no signing key held in a separate trust domain / HSM). For a CMMS whose value proposition is defensible arc-flash and compliance records, "can the audit log be silently rewritten?" is a standard DD/SOC2 question whose honest answer here is "yes, by anyone who roots the one app server." Document the residual risk explicitly and plan periodic external anchoring (e.g. daily head-hash notarization).
File: server/lib/activityLogChain.ts lines 30-95

**[DD-8-3] HIGH: Source comments name the pilot customer relationship and informal owner-driven process throughout the codebase**
Memory policy is explicit that the first pilot (a NETA contractor) must not be named in any artifact, yet shipped source comments repeatedly reference the pilot relationship and an informal "[owner] said" development process: `outagePlanner.ts:4` ("The brother's question is..."), `alertCadence.ts:5` ("The brother's reality:"), `email.ts:377` ("pilot scope — [owner] reads every one of these"), `ingestConfidenceGate.ts:10` ("agreed with [owner]"), plus several `client/src` files. A code-level DD review reads these. They (a) risk disclosing the unannounced pilot/customer relationship and (b) signal a bus-factor-of-one, requirements-by-conversation engineering process — both diligence concerns that affect valuation and reps/warranties. Scrub personal names and customer-identifying narrative from comments before the data room opens.
File: server/lib/email.ts line 377; server/routes/outagePlanner.ts line 4; server/lib/alertCadence.ts line 5

**[DD-8-4] MEDIUM: Security TODO references a migration that does not exist, overstating remediation status**
`auth.ts:243` documents the in-memory login-lockout limitation and points to a fix "see schema.prisma — model to be added in migration 20260626_security." No such migration exists in `server/prisma/migrations/`, and no `FailedLoginAttempt` model exists. The in-memory lockout itself is an accepted/deferred item, but a TODO that cites a concrete, non-existent migration is a paper-trail defect: a DD reviewer cross-checking "claimed fix" vs. "actual code" finds the reference dangling, which undermines confidence in every other "fixed in migration X" claim in the tree. Either land the migration or correct the comment to say the work is unscheduled.
File: server/routes/auth.ts lines 242-247

**[DD-8-5] MEDIUM: Per-account SCIM replay protection can be silently disabled by an env var**
`ssoScim.ts:12-15` reads `SCIM_WEBHOOK_TOLERANCE_MS` and `isFreshTimestamp` (`scim.ts:95-99`) treats any value `<= 0` as "replay window disabled, return true." An operator who sets `SCIM_WEBHOOK_TOLERANCE_MS=0` (plausible if they misread it as "no limit") turns off the timestamp-freshness defense, leaving only the dedupe ledger between a captured-and-replayed signed directory event and a user (de)provisioning action. The signature secret still gates forgery, so impact is bounded, but a security control that silently no-ops on a footgun value is worth a guardrail (treat `0` as invalid, or floor at 60s).
File: server/lib/scim.ts lines 94-99; server/routes/ssoScim.ts lines 12-15

**[DD-8-6] MEDIUM: Per-user TOTP brute-force counter is process-local and resets on every deploy**
`twoFactor.ts:42-72` implements the per-`userId` 2FA fail counter (`_totpUserFailMap`) entirely in process memory; the comment acknowledges "a restart clears counts." Combined with the 5-minute pending-2FA token TTL the practical exposure is small, but on a single-node deployment a deploy/PM2 restart resets the per-user lockout for everyone mid-attack, and a multi-replica future makes the IP+user limiter per-replica (N× the intended budget). A DD security reviewer flags in-memory auth-state on a product positioning itself for enterprise SSO. The same pattern recurs in the login-lockout map (DD-8-4). Back these with the DB or a shared store before claiming enterprise-grade brute-force protection.
File: server/routes/twoFactor.ts lines 42-72

**[DD-8-7] MEDIUM: Disorganized working tree — large debug dumps and scratch scripts present beside production source**
`server/` is littered with ad-hoc artifacts: `_cb2.txt` (361 KB), `_suite.log`, `_rev2.txt`/`_rev3.txt`, `_sso3.txt`, `_dump_brady.py`, `_brady_model.json`, `_ae.txt`, etc., and the repo root carries `_p.py` plus many `OVERNIGHT_*.md` / `QA_REPORT.md` scratch files. They are correctly git-ignored (not committed — verified) so they don't ship, but a code-quality DD reviewer cloning the box sees a noisy tree that reads as "no separation between exploration and product." This is a hygiene/maturity signal, not a security hole. Move scratch output out of the source tree (or into a git-ignored `/scratch`) before diligence.
File: server/_cb2.txt (361 KB); server/_dump_brady.py; server/_rev2.txt

**[DD-8-8] MEDIUM: Single-process cron/queue model is the binding scalability constraint — disclosed in code, will surface in DD**
`index.ts:1671-1690` guards cron with a Postgres advisory lock so only one instance runs scheduled jobs, and `ingestWorker.ts` polls via in-process `setInterval` with no Redis/queue. The comments are candid ("Single-droplet: in-process setInterval poll. No Redis."). Single-node/no-HA is an accepted item, but the way it's wired (cron, the ingest worker, all in-memory rate-limit/lockout maps) means the product cannot horizontally scale without re-architecting the background-job and rate-limit layers. A buyer's technical team will price this remediation; better to have a one-page scaling plan ready than to let them discover the coupling cold.
File: server/index.ts lines 1671-1690; server/lib/ingestWorker.ts lines 14-44

**[DD-8-9] MEDIUM: `bootstrap` aggregation endpoint duplicates the assets query-filter logic by design, creating an authorization drift surface**
`bootstrap.ts` deliberately re-implements (not shares) the `where`/`orderBy`/search logic of `routes/assets.ts` GET `/`, with eight "⚠ Mirrored in routes/assets.ts — keep in sync" warnings. Both are account-scoped so today's behavior is correct, but two hand-maintained copies of a data-access filter are exactly where an account-scoping or filter-validation fix lands in one and not the other. A DD code reviewer reads "keep these in sync" comments as a latent-bug marker. Consolidate behind a shared, tested query-builder so the security-relevant `accountId` scoping cannot diverge.
File: server/routes/bootstrap.ts lines 29-122

**[DD-8-10] MEDIUM: License/IP provenance — proprietary code depends on a large third-party tree the data room must enumerate**
`LICENSE` declares the code "PROPRIETARY AND CONFIDENTIAL, Copyright ForgeRift LLC, All rights reserved," which is the right posture for a sale, but the deal value rests on clean IP. The server tree pulls AWS SDK, ExcelJS, Prisma, jsonwebtoken, Papa Parse, Ory Polis (SSO), etc., and the client pulls React, recharts, react-markdown, lucide-react, and others. `npm audit --omit=dev` reports 0 vulnerabilities (good), but there is no committed third-party license inventory / SBOM attestation in-repo to back the "all rights reserved" claim against copyleft contamination. Generate and ship a dependency-license report (the `server/sbom/` dir exists but is not a current attestation) so counsel can clear the IP reps quickly.
File: LICENSE lines 1-3; server/package.json; client/package.json

**[DD-8-11] MEDIUM: SSO callback provisions/logs in users without `id_token` validation when Polis OIDC keys are absent**
`sso.ts:153-158` handles the case where the IdP returns no `id_token` by logging a warning and proceeding on "PKCE/state/userinfo" alone — it then provisions or updates a user and mints app tokens. PKCE + single-use state + the tenant cross-check do provide real protection, and the path is gated behind operator config, but a DD reviewer evaluating the SSO security model will flag that signed-assertion validation is best-effort rather than mandatory: a misconfigured/downgraded Polis (no OIDC signing keys) drops the cryptographic identity proof to a userinfo fetch. Make `id_token` validation required (fail closed) for any production connection, or document this as an explicit, accepted configuration constraint.
File: server/routes/sso.ts lines 140-165

**[DD-8-12] LOW: Two `$queryRawUnsafe` / `$executeRawUnsafe` call sites raise an immediate audit flag (verified safe, but they invite scrutiny)**
`ingestWorker.ts:31-42` and `ingestAck.ts:36-39` use Prisma's raw `*Unsafe` APIs. Both are clean — the worker query is 100% static SQL (no interpolation) and the ack query parameterizes `batchId` via `$1` — so there is no injection here. However, any automated DD SAST sweep and most human reviewers grep for `Unsafe` first; these two hits will appear at the top of the buyer's scanner report and force a manual clear. Add an inline `// SAFE: static SQL` / `// SAFE: parameterized $1` annotation at each call site (the codebase already does this at `admin.ts:393`) to pre-empt the question.
File: server/lib/ingestWorker.ts lines 30-44; server/lib/ingestAck.ts lines 36-39

**[DD-8-13] LOW: `optionalAuthenticateToken` (never-rejects soft auth) is mounted on a route — correctly scoped, but a pattern to audit**
`index.ts:1354` mounts `/api/errors` with `optionalAuthenticateToken`, which by design populates `req.user` when a valid bearer is present and sets it to `null` otherwise, never returning 401. The implementation correctly honors token-epoch revocation (`auth.ts:167`) and the route is the render-crash telemetry sink that legitimately must accept pre-auth traffic (documented at `errors.ts:87`). This is fine today, but "an auth middleware that never rejects" is exactly the kind of helper that a future contributor mounts on a sensitive route by mistake. DD note: keep `optionalAuthenticateToken` usage to the single telemetry endpoint and add a lint/test asserting it is never composed with a data-mutating router.
File: server/middleware/auth.ts lines 150-177; server/index.ts line 1354

**[DD-8-14] LOW: Setup wizard writes AI provider keys to the DB in plaintext on the wizard path, deferring encryption to a manual re-save**
`setup.ts:300-358` (POST `/api/setup/ai`) stores `AI_API_KEY` via `encryptIfNeeded` — good — but the header comment and response (`encryptionNote`) still describe a flow where the operator must "re-save via Settings → AI after first login" to trigger at-rest encryption, language inconsistent with the now-encrypting code. A DD reviewer reading the comment concludes keys land unencrypted at setup time; reading the code concludes they're encrypted. The mismatch is a documentation-vs-code drift defect (and a moment where a future refactor could re-introduce the plaintext write the comment still describes). Reconcile the comment/response with the actual `encryptIfNeeded` behavior.
File: server/routes/setup.ts lines 291-358

---

# CFO-8 — CFO / Finance Buyer

Scope: financial/aggregation correctness of every dollar, percentage, and rollup the platform surfaces to a customer, an insurer, or a board. I must be able to defend these numbers to an investment committee. Verified against HEAD 85d10fa. Units established from schema: `ServiceRateCard.minCents/maxCents` and `WorkOrderPartUsage.unitCostCents` / `WorkOrder.laborCostCents` are **USD cents**; `Asset.repairCostEstimate` is `Decimal(14,2)` in **whole USD dollars** (schema line 830). The cents-vs-dollars split between these two cost sources is the root of several findings below.

**[CFO-8-1] CRITICAL: Monthly digest "Service pipeline" prices routine maintenance at full equipment-REPLACEMENT rates, overstating pipeline by orders of magnitude**
`gatherAccountDigest` prices every upcoming maintenance *schedule* (a routine inspection/test that is merely due) by calling `resolver.forEquip(a.equipmentType)`, which maps e.g. `TRANSFORMER_LIQUID → TRANSFORMER_REPLACEMENT` and `SWITCHGEAR → SWITCHGEAR_MODERNIZATION` (rateResolver `EQUIP_TO_SERVICE_TYPE`). So a transformer that simply needs its annual oil sample is counted at the full transformer-replacement rate, and these are summed into `pipelineMin/pipelineMax` shown as "Service pipeline" $ in the manager roll-up, rep email, and totals strip. A board reading the digest sees a pipeline figure inflated by 10–100×. Fix: price routine schedules at the `INSPECTION` rate (or a per-task service rate), reserving modernization/replacement rates for the actual EOL/modernization path.
File: server/lib/monthlyDigest.ts lines 177-181 (with server/lib/rateResolver.ts lines 28-40)

**[CFO-8-2] CRITICAL: Customer-facing CapEx forecast diverges from the OEM forecast for the same assets (missing installDate filter)**
`/api/fleet/forecast` (OEM view) filters at-risk assets with `installDate: { not: null }` (line 539), but `/api/fleet/account-forecast` (the customer's own dashboard, lines 636-644) omits that filter entirely. The same account therefore shows a *larger* CapEx forecast on the customer dashboard than the contractor sees in the fleet view — assets with a null install date but a risk score are priced in one place and not the other. Two authoritative surfaces give two different dollar totals for the identical question. Fix: apply identical asset filters (and identical year-bucketing) to both endpoints, ideally sharing one helper.
File: server/routes/fleetDashboard.ts lines 535-548 vs 636-644

**[CFO-8-3] CRITICAL: Leave-behind PDF truncates every dollar figure to whole dollars via `Math.round(cents/100)` — totals won't tie to rate cards**
`fmtMoney` in the leave-behind renderer is `'$' + Math.round(cents / 100).toLocaleString()`. Because it rounds (not floors) at the cent→dollar boundary on each individual range endpoint, a rate of $12,345.50 prints as $12,346 and $999.50 prints as $1,000. The "What to Budget For" section a field tech hands the facilities manager/CFO will not foot to the rate card or to any other report that formats the same `minCents/maxCents` differently (the CFO PDF and proposal PDF use `Math.round(Number(n))` on already-dollar inputs). Fix: format cents with `(cents/100).toLocaleString(undefined,{minimumFractionDigits:2})` or a single shared money formatter used by every PDF/CSV.
File: server/lib/leaveBehindPdf.ts lines 69-71

**[CFO-8-4] HIGH: "Path to 100%" promise is mathematically broken by rounding — clearing every action does not land on 100%**
`buildComplianceGap` computes `pointPerUnit = Math.round((100/denom)*10)/10` and assigns it as `pointsRecovered` to most actions, while `overallRate = Math.round((current/denom)*1000)/10`. The documented contract ("each unmet obligation is worth 100/D points; clearing the whole list lands on 100%") fails whenever `100/denom` is not a clean tenth: e.g. denom=7 gives pointPerUnit=14.3, and 7×14.3 = 100.1, not 100. The per-action points shown to the customer therefore sum to something other than the actual `pointsToFull`, and the headline maturity score (which equals `overallRate`) won't reconcile with the action list a customer is told to work. Fix: distribute the exact residual (compute points so they sum to exactly `100 - overallRate`) or present a single aggregate rather than per-action point credits.
File: server/lib/complianceReport.ts lines 705-707, 729, 746, 762

**[CFO-8-5] HIGH: Maintenance Debt totals sum already-rounded per-site values, so the account total ≠ the true sum (penny/dollar drift, compounding across 120 sites)**
Each per-site row is rounded independently (`round(...)` at maintenanceDebt lines 120-124), then the account `totals`/`plan` are built by summing those *rounded* per-site numbers (lines 148-158). Across a large portfolio (the product targets 120-site books) the rounding error accumulates: the TOTAL row in the CSV and the CFO report's capital-plan figure can be off by up to ±(siteCount/2) dollars from the true aggregate, and the displayed per-site rows won't add up to the displayed total. For a board-grade capital plan, "the rows don't sum to the total" is an immediate credibility hit. Fix: aggregate raw (unrounded) values and round once at the end, for both the total and each displayed row.
File: server/lib/maintenanceDebt.ts lines 118-158

**[CFO-8-6] HIGH: Maintenance Debt CSV "Modernization" column double-counts vs the year columns and vs the on-screen total**
In `debtLedgerToCsv` the per-row Modernization min/max is `year1+year3+year5` (lines 192-193), and the same three-year sum feeds `Year 5` (which is cumulative: deferred + repair + mod1 + mod3 + mod5). A spreadsheet user who adds "Repair backlog + Modernization (max)" expecting it to reconcile to "Year 5 (max)" will be off by the deferred-maintenance amount, and adding the three year columns double-counts modernization (since Year 3 already contains Year 1, and Year 5 contains Year 3). The exported workbook does not internally reconcile, which an acquirer's diligence team will catch immediately. Fix: label columns unambiguously (incremental vs cumulative) and ensure a documented identity (e.g. Year5 = Deferred + Repair + ModTotal) holds in the row.
File: server/lib/maintenanceDebt.ts lines 188-213

**[CFO-8-7] HIGH: Proposal "Recommended (phased)" option total includes ALL non-deferrable work regardless of year, contradicting its "years 1–3" description**
`buildProposal` builds the Recommended option from `nonDefer = lineItems.filter(i => i.recommendation !== 'defer')` and prices `sumRange(nonDefer)`, but a repair line can be assigned `year` only by severity and a replace line gets year 1 or 3 — there is no upper bound, and crucially the description states "scheduled across years 1–3." Any non-deferrable item is included in the Recommended total even though every repair/replace year is in {1,3}, so in practice it equals Essential+year3; but the option total and the `byYear` breakdown are computed from different filters (`byYear` uses `i.year===3`, the option uses `recommendation!=='defer'`), so the three option cards and the year breakdown can present inconsistent subtotals of the same proposal. A customer/contractor cannot reconcile "Recommended = $X" against "Year 1 $A + Year 3 $B." Fix: derive option totals from the same year buckets shown in `byYear`, or state the exact membership rule on the card.
File: server/lib/proposalBuilder.ts lines 135-156, 168-169

**[CFO-8-8] HIGH: CFO report "estimated remediation spend" silently undercounts whenever assets lack a repair-cost estimate, presented as a single headline number**
`buildCfoReportData` sums `repairCostEstimate` only over assets that *have* one (`assetsWithEstimate`), and the board PDF prints `fmtMoney(sp.estimatedRemediation)` as a large accent-colored headline. The coverage caveat ("Based on N of M assets…") is real and present, but the headline dollar figure is a floor that will read as *the* remediation cost. If 3 of 50 deficient assets carry an estimate, the board sees a number that is ~6% of the true exposure with the qualifier in 9pt italic underneath. For an investment committee this is a materially misleading single number. Fix: present the figure as a range or explicitly as "known-scoped subset only," and surface the uncovered-asset count with equal visual weight.
File: server/lib/cfoReport.ts lines 69-82, 202-207

**[CFO-8-9] MEDIUM: Rate-card editor GET rounds cents to whole dollars, so a non-whole-dollar seeded/imported rate silently changes on display and round-trip**
`GET /api/rate-cards` returns `minDollars: Math.round(r.minCents/100)` (lines 36-37) and the `PUT` re-multiplies `minDollars*100`. A platform/partner default seeded as 123450 cents ($1,234.50) is shown to the manager as $1,235 (rounded up), and if they save without changing it, it is persisted as 123500 cents — the rate silently mutated by $0.50, and the PDF/digest formatters (which read the raw cents) now disagree with the editor. The editor is lossy for any rate not on a whole-dollar boundary. Fix: surface cents (or two-decimal dollars) in the editor, or store/enforce whole-dollar rates everywhere.
File: server/routes/rateCards.ts lines 35-37, 64-66

**[CFO-8-10] MEDIUM: `summarizeSchedules` compliance rate excludes "unbaselined" schedules from the denominator, flattering the headline % an insurer/board reads**
`complianceRate = current / (current + overdue)`; unbaselined (active schedules with no `nextDueDate`) are excluded from the denominator by design (documented at the top of the file). An account that has applied templates to 200 assets but baselined only 2 schedules — both current — reports **100% compliance** on the per-standard summary, the digest, and `buildComplianceByCustomer`. The "honest" blended rate exists only inside `buildComplianceGap`/maturity, not in the per-standard summary or the digest's headline. The same word ("compliance") names two very different numbers across surfaces, and the more flattering one is what reaches the insurer underwriting package's `complianceRate` field. Fix: either fold unbaselined into the rated denominator for the headline, or rename the per-standard figure to make clear it excludes un-baselined scope.
File: server/lib/complianceReport.ts lines 68-77 (consumed by underwritingPackage.ts line 66)

**[CFO-8-11] MEDIUM: `_money`/`fmtMoneyCompact` rounds to the nearest $1,000 with a "k" suffix in the digest, so the pipeline shown rounds away up to $499 per side**
The digest's totals strip and rep-email line items render dollars through `fmtMoneyCompact`, which for n ≥ 1000 returns `Math.round(n/1000) + 'k'`. A $1,499 figure prints "$1k"; a $2,500 figure prints "$3k". Combined with finding CFO-8-1, the headline "Service pipeline" is both mispriced *and* coarsely rounded, and the rounded email figure will not match the per-row sum in the attached Excel (which uses full `fmtCurrency`). A recipient reconciling the email banner against the spreadsheet total will find they disagree. Fix: show full currency in the banner, or clearly label it as rounded-to-thousands and ensure the Excel carries the same basis.
File: server/lib/monthlyDigest.ts lines 52-58, 247-249

**[CFO-8-12] MEDIUM: CFO report's compliance "trajectory" recomputes a rate from snapshot stats that is a different formula than the snapshot's own stored rate**
`buildCfoReportData` derives each trajectory point as `current/(current+overdue)` from `snapshot.stats` (lines 86-92), independent of whatever rate was authoritative when the snapshot was generated. If a snapshot was taken under a different rate definition (e.g. the blended overallRate, or a definition that later changed), the trend line in the board PDF will not match the historical numbers the customer was actually shown at those dates — and the snapshots are the *tamper-evident, hash-anchored* audit record. A board comparing the CFO PDF trend to an archived snapshot PDF will see different percentages for the same date. Fix: read the snapshot's recorded compliance rate as-stored rather than re-deriving it from a possibly-incompatible stats blob.
File: server/lib/cfoReport.ts lines 86-92

**[CFO-8-13] MEDIUM: Work-order labor/parts costs (cents) and asset `repairCostEstimate` (dollars) are never reconciled, and only the dollar field reaches financial reports**
Actual recorded spend lives on work orders in **cents** (`laborCostCents`, `WorkOrderPartUsage.unitCostCents` × `quantityUsed`), but every financial rollup the CFO/insurer sees (Maintenance Debt, CFO report, proposal, underwriting) uses the **estimate** field `repairCostEstimate` (dollars) and ignores realized work-order cost entirely. There is no actual-vs-estimate reconciliation, and the two live in different units, so any future code that sums them together will be off by 100×. A CFO asking "what did we actually spend vs. what you forecast" cannot get an answer from these reports, and the unit mismatch is a latent landmine. Fix: expose realized work-order cost (converted cents→dollars) alongside estimates, and standardize on one money unit across the financial layer.
File: server/routes/workOrders.ts lines 500-505, 1374; server/lib/cfoReport.ts lines 69-82

**[CFO-8-14] MEDIUM: Revenue-attribution "pipeline" and "realized" $ sum `repairCostEstimate` across quote statuses but quietly drop unpriced quotes from the dollar totals while still counting them in the funnel**
`buildRevenueAttribution` adds `est` (the asset's `repairCostEstimate`) into `value.realized`/`value.pipeline` only when present, counting the rest as `unpricedCompleted`/`unpricedOpen`. The funnel counts (submitted/quoted/accepted/completed) include those unpriced quotes, so the conversion percentages and the dollar value describe *different populations*: an account can show "10 completed, 80% conversion, $0 realized" if none of the completed quotes' assets carry an estimate. An acquirer valuing the "revenue-bearing digital twin" on these figures would over- or under-state attach-rate-to-dollars. Fix: report the priced-vs-unpriced split with equal prominence and never present a single realized-$ next to a funnel count drawn from a larger population without that caveat.
File: server/lib/revenueAttribution.ts lines 81-98, 124-129

---

# COMP-8 — Competitor Sales Rep

Persona: I sell an established CMMS (Limble / eMaint / Prometheus / Fiix). I am in a live competitive deal against ServiceCycle and I will say anything TRUE that wins it. Every finding below is verified in their own source and framed as the concrete weakness plus the line I would use on the prospect.

---

**[COMP-8-1] CRITICAL: "Real-time / continuous condition monitoring" is a 5-minute poll — there is no live channel anywhere in the client**
README line 16 sells "Continuous condition monitoring — real-time telemetry … CRIT breach auto-escalates asset to NFPA 70B C2," but the client has zero WebSocket/SSE/EventSource. The alert badge refreshes on a `setInterval(fetchCount, 5 * 60 * 1000)` (5 minutes); the ingest-review badge polls 60s. A CRIT arc-energy or thermal breach can sit unseen for up to five minutes, and the alert detail page fetches once on mount with no polling at all. Fix: add an SSE/WebSocket push for the alert + telemetry surfaces, or stop calling it "real-time." What I'd tell the prospect: "Ask them to trip a CRIT alarm and time how long until the screen reacts — it's a five-minute poll. Our condition alerts are pushed in real time. For an arc-flash safety platform, five minutes of blindness is the whole ballgame."
File: client/src/components/Sidebar.jsx lines 180, 600; README.md line 16

**[COMP-8-2] CRITICAL: "Complete, portable snapshot / no lock-in" export silently truncates at 5,000 rows**
README line 18 and export.ts line 239 promise "a complete, portable snapshot … all assets, work orders," and OFFBOARDING is pitched as the no-lock-in guarantee. But `exportAssets` and `exportWorkOrders` cap at `EXPORT_ROW_CAP = 5000`, slice the overflow off, and merely set an `X-Truncated: 1` header the UI does not surface. A 25,000-asset utility exporting their data gets 5,000 rows and a silent header. Fix: stream/paginate the XLSX/CSV export (cursor) so the "complete" claim is literally true. What I'd tell the prospect: "Their own diligence doc says no lock-in. Load 6,000 assets, hit Export, and count the rows — you'll get 5,000 and no warning. That's not portability, that's a data trap. Our export is the full set or nothing."
File: server/routes/export.ts lines 42, 116-132, 206-222

**[COMP-8-2b] HIGH: Full-account JSON export materializes every table in RAM and stringifies it — single-node OOM / DoS**
`GET /api/export/account` calls `buildAccountExport`, which loads ALL assets, schedules, work orders, deficiencies, documents, snapshots, arc-flash studies, parts and inventory with no `take:`/cursor, then does `JSON.stringify(data, null, 2)` and `res.send()` — the entire account held in memory twice. On a large tenant this OOMs the single node; a manager hitting it a few times in parallel is a cheap availability attack. Fix: stream the export (JSON lines / chunked writer), bound per-table reads. What I'd tell the prospect: "Their 'export everything' button loads your entire database into RAM on one server with no streaming. On a real dataset it either times out or takes the instance down. We stream exports of any size."
File: server/routes/export.ts lines 244-264; server/lib/accountExport.ts (buildAccountExport, all-table findMany with no take)

**[COMP-8-3] CRITICAL: The home dashboard loads every active schedule into memory on every login — hard scale ceiling**
The main `/api/dashboard` query (rendered on every sign-in) runs `prisma.maintenanceSchedule.findMany` with NO `take:`, selecting one row PER SCHEDULE, then computes compliance-by-site in a JS `for` loop. The code comment claims "site counts are bounded (tens)" — but the query returns a row per schedule, not per site, so a 100k-schedule account ships 100k rows to the app tier on every dashboard paint. `spareInventory.findMany` (same handler) is likewise unbounded and filtered in JS. Fix: replace with a Prisma `groupBy`/aggregate (count + conditional overdue count grouped by siteId). What I'd tell the prospect: "Their dashboard is fast in the demo because the demo has 200 schedules. At your scale it pulls every schedule row over the wire on every login. Ask for a load test at 50,000 assets."
File: server/routes/dashboard.ts lines 77-83, 115-124, 128-141

**[COMP-8-4] HIGH: "Works offline in the field" PWA does NOT cache work orders, schedules, or parts**
The service worker (vite.config.js) runtime-caches only GETs to `/api/field/`, `/api/bootstrap`, `/api/assets`, `/api/sites`. Work-order detail, maintenance schedules, and parts/spares have no offline cache rule, so a tech who loses signal in a plant basement — the exact scenario marketed — cannot open a work order or see the parts they need. Fix: add NetworkFirst cache rules for `/api/work-orders`, `/api/schedules`, `/api/parts`. What I'd tell the prospect: "Their field app 'works offline' for the asset list only. Walk into a Faraday-cage switchgear room and try to open your work order — it's blank. Our mobile caches the whole job packet."
File: client/vite.config.js lines 157-176

**[COMP-8-5] CRITICAL: Offline field mutations that the server rejects are silently dropped — guaranteed compliance-data loss**
The IndexedDB outbox replays queued mutations; on a 4xx/5xx it moves the entry to a `failed` store and never retries (outbox.js lines 160-177). But `failedEntries()` is exported and rendered NOWHERE in the client — grep confirms zero importers. So if a tech records a measurement offline and on sync the asset was archived (or any 409/422), the reading vanishes with no UI signal. The tech saw "Saved." Fix: surface `failedEntries()` in a banner/retry UI. What I'd tell the prospect: "On a compliance system, their offline queue silently discards any reading the server later rejects, and nothing tells the technician. That's a NETA audit landmine — you'll certify on data that was thrown away."
File: client/src/lib/outbox.js lines 120-124, 160-177

**[COMP-8-6] HIGH: Field nameplate/OCR edits bypass the offline queue entirely and die on a toast**
On the field asset page, `applyOcrToAsset` writes via `api.put('/api/assets/:id')` (FieldAsset.jsx line 525) and the photo-inspect / OCR scans call `api.post(...)` directly — none go through `fieldMutate`/the outbox. Offline, the corrected nameplate save just shows "Could not save — try again." Same direct-`api.post` pattern in FieldNewAsset.jsx (line 122) and FieldBatchNameplate.jsx (line 59) for creating assets. Fix: route field writes through `fieldMutate` so they queue. What I'd tell the prospect: "Their own field app has two code paths and only one of them survives a dropped connection. The nameplate fixes your tech just typed in the field? Gone if the signal blips."
File: client/src/pages/field/FieldAsset.jsx lines 446, 503, 525; FieldNewAsset.jsx line 122; FieldBatchNameplate.jsx line 59

**[COMP-8-7] HIGH: "Predictive" condition/drift intelligence is a fixed rules engine, not ML**
README/brief market "predictive" condition monitoring and RUL. The shipped `driftDetector` is hard-coded thresholds: trailing 730-day window, deficiency open >120 days, `>= 3` failures = "repeat_failure" (driftDetector.ts lines 26-29). It's a deterministic if/else, and the brief itself admits "the ML layer is the next build." No regression/model code exists anywhere. Fix: stop using "predictive/ML" language for a threshold engine, or build the model. What I'd tell the prospect: "Ask to see the model. There isn't one — it's three hard-coded thresholds in a file. We've shipped actual failure-prediction models trained on fleet data. They're selling arithmetic as AI."
File: server/lib/driftDetector.ts lines 26-44

**[COMP-8-8] HIGH: "Voice field entry" is regex pattern-matching, not speech understanding**
`parseVoiceReading` is a deterministic lexicon of regexes (voiceCapture.ts) — any phrasing outside the hard-coded synonym tables yields `measurementType: null`/`value: null`. Speech-to-text is offloaded to the browser's Web Speech API, which is Chrome-only and itself needs a network round-trip to Google. Fix: set expectations ("structured voice shortcuts") and note the browser dependency. What I'd tell the prospect: "Their 'voice capture' is a list of keyword regexes. Say it slightly wrong and it captures nothing — and it only works in Chrome with a live internet connection, which contradicts the offline pitch."
File: server/lib/voiceCapture.ts lines 25-46, 124-189

**[COMP-8-9] HIGH: SOC 2 is control-design only — README implies more than they have**
README line 91 lists "SOC 2 Type I Trust Service Criteria mapping (13 gaps closed)" in a diligence index; their own SOC2_CONTROLS doc says Type II evidence collection hasn't started (the 6-month clock begins only "once Type I readiness is confirmed"). A business buyer reads "SOC 2" as audited. They have neither a Type I report nor a Type II. Fix: state plainly "pre-audit control mapping; no SOC 2 report issued." What I'd tell the prospect: "Ask for the SOC 2 report PDF and the auditor's name. They can't produce either — it's a self-assessment spreadsheet. We hand you a current Type II from a Big-Four-adjacent firm."
File: README.md line 91; docs/SOC2_CONTROLS.md

**[COMP-8-10] MEDIUM: AI vision (nameplate OCR, photo inspect) silently requires a SECOND vendor key and has no fallback when it's missing**
With the demo default `AI_PROVIDER=cloudflare`, all image calls detour to `AI_VISION_PROVIDER` (default `anthropic`) — Cloudflare Workers AI is text-only here (ai.ts lines 315-358). So nameplate scanning needs an `ANTHROPIC_API_KEY` set IN ADDITION to the CF credentials; if a self-host operator configured only Cloudflare, every nameplate/photo scan throws. The text cascade (CF→Groq→HF) does NOT cover the vision path. Fix: document the hard vision-key dependency and fail with a clear setup error. What I'd tell the prospect: "Their headline 'snap a nameplate' feature quietly depends on a second AI vendor's key the install guide buries. Set up the documented default and the camera feature is dead on arrival."
File: server/lib/ai.ts lines 312-358

**[COMP-8-11] MEDIUM: Single AI text-block assumption will crash extraction on a refusal/tool/empty completion**
`_anthropicComplete` and `_anthropicImage` return `msg.content[0].text.trim()` with no guard (ai.ts lines 402, 428); the OpenAI paths assume `choices[0].message.content` is a string (lines 451, 468). If Anthropic returns a non-text first block (refusal, safety stop, empty content array) the `.text`/`.trim()` throws a raw TypeError that surfaces to the user as a 500, not a graceful "couldn't read that." Fix: defensively find the first text block and handle empties. What I'd tell the prospect: "Their AI parsing assumes the model always replies with text in slot zero. The day the model refuses or returns empty — and it will — the feature 500s instead of degrading. We handle that path."
File: server/lib/ai.ts lines 402, 428, 451, 468

**[COMP-8-12] MEDIUM: Asset-import dedup and validation load the entire asset + site tables into memory per import**
`prepareImport` pulls EVERY asset with a serial (`prisma.asset.findMany`, no `take:`) and EVERY site for the account on every preview AND commit, to build in-memory dedup maps (assetsImport.ts lines 616-636). The hierarchy preload then `findMany`s all buildings/areas/positions too (lines 737-744). The import file itself is capped at 500 rows, but the lookup side scales with the whole account — a 50k-asset tenant re-reads 50k rows for a 10-row import. Fix: query existing serials by the file's serial set (`where: { serialNumber: { in: fileSerials } }`), not the whole table. What I'd tell the prospect: "Every time your team imports a spreadsheet, their server reads your entire asset catalog into memory just to check duplicates. It gets slower with every asset you add — the opposite of what you want."
File: server/routes/assetsImport.ts lines 616-636, 737-744

**[COMP-8-13] MEDIUM: Telemetry channel list endpoint is unbounded — the OT-monitoring story doesn't scale**
The v1 telemetry channel list runs `prisma.telemetryChannel.findMany` with no `take:`/pagination (telemetry.ts line 96), returning every channel across every asset for the account. A facility wiring hundreds of assets × multiple channels each gets one ever-growing response. (The readings + notifications endpoints ARE paginated/capped — the channel list was missed.) Fix: paginate the channel list. What I'd tell the prospect: "Their edge-gateway telemetry list returns every channel in one unbounded call. Connect a real plant's sensor fleet and that endpoint balloons. We page everything."
File: server/routes/v1/telemetry.ts line 96

**[COMP-8-14] MEDIUM: A marketed feature — the industry/regulatory news feed — is dead code, and its refresh is an outbound-fetch DoS lever**
`routes/news.ts` is documented "NOT yet wired" (line 4): the news/summary/refresh endpoints aren't mounted. The product surfaces a regulatory-news value-prop that isn't actually running. Worse, `/refresh` (manager+) fires synchronous outbound HTTP to third-party RSS feeds (OSHA, trade press) and DB writes — a manager can spam external fetches, and there's no per-call rate limit on the scan itself. Fix: either wire and rate-limit it or remove it from the repo/marketing. What I'd tell the prospect: "Their 'stay ahead of NFPA/OSHA changes' feed isn't even turned on in the product — it's unmounted code. Don't pay for a roadmap slide."
File: server/routes/news.ts lines 4-27

**[COMP-8-15] MEDIUM: Fleet/OEM dashboard work-order query scales with the customer's account count, no cursor**
`fleetDashboard.ts` fetches completed work orders with `take: accountIds.length * 10` — bounded only by how many child accounts an OEM/HoldCo manages. A partner overseeing 500 customer accounts pulls 5,000 work orders in one shot with no cursor pagination, then aggregates. The multi-tenant rollup — a core acquisition selling point for OEM buyers — is exactly where this bites. Fix: cursor-paginate the fleet rollup. What I'd tell the prospect (the OEM buyer): "The HoldCo/fleet view they're pitching you pulls work orders as a multiple of your account count in a single query. Onboard your whole installed base and that screen is the first thing to fall over."
File: server/routes/fleetDashboard.ts lines 150-159

---

# NETA-8 — NETA Third-Party Inspector

Persona: NETA-certified third-party test technician logging real ATS/MTS acceptance and maintenance data and handing the customer a credible leave-behind at end of day. Findings below are verified against the actual code (ANSI/NETA ATS-2021 & MTS-2023, NFPA 70E-2024, NFPA 70B, IEEE 1584-2018, IEEE C57.104, IEEE 43).

---

**[NETA-8-1] CRITICAL: IR thermography parser discards the reference frame, so "over-ambient" hot-spots are graded on the similar-component scale and mis-classified per NETA Table 100.18**
`parseThermographyText` matches lines like "30 C over ambient" (its own regex captures `over`/`above`) but throws away whether the ΔT is over-ambient or between-similar-components, returning only a bare number. The ingest route applies one `req.body.reference` (defaulting to `'similar'`) to every hot-spot in the report. A real survey mixes both references; a 30 °C over-ambient rise is RECOMMENDED on the over-ambient table but is graded IMMEDIATE on the similar-component scale (>15 °C → IMMEDIATE), manufacturing false "repair immediately" deficiencies a thermographer would reject on sight. Fix: capture per-line reference in the parser ("over ambient"/"vs phase"/"similar") and pass it per-hotspot into `severityForDeltaT`.
File: server/lib/thermographyParse.ts lines 16-21, 46-54; server/routes/thermographyIngest.ts lines 45-50

**[NETA-8-2] CRITICAL: Live QR/NFC arc-flash label portal omits the shock approach boundaries that NFPA 70E §130.5(H) requires (and that the printed PDF shows)**
The public label API returns a snapshot including `shockLimitedApproachIn` and `shockRestrictedApproachIn`, but the client's `FIELD_LABEL` map (the only fields rendered) omits both, so a worker scanning the sticker sees incident energy, AFB and PPE but no shock boundaries. The printed PDF label (arcFlashLabelDoc.ts) does render them, so the physical label and the "live record" it points to disagree — exactly the mismatch the portal exists to prevent, on a life-safety field. Fix: add `shockLimitedApproachIn`/`shockRestrictedApproachIn` to `FIELD_LABEL`/`fmtVal`.
File: client/src/pages/PublicArcFlashLabel.jsx lines 11-22, 73-78

**[NETA-8-3] HIGH: DGA T1 thermal-fault classification is dead code — IEEE key-gas faults below 300 °C can never be reported**
In `keyGasFault`, the T2 branch (`if (c2h4 >= 50 || ch4 >= 120)`) is evaluated before the T1 branch (`if (h2 >= 100 && ch4 >= 120)`). Because T1 also requires `ch4 >= 120`, every case that could satisfy T1 already returns T2 one line earlier, so "Thermal fault <300 °C (T1)" is unreachable. A transformer with a genuine low-temperature thermal fault is mislabeled T2 (300–700 °C), overstating fault severity on the leave-behind. Fix: reorder so the more specific T1 condition is tested before the broader T2 condition, or gate T2 on ethylene only.
File: server/lib/dgaEvaluate.ts lines 58-68

**[NETA-8-4] HIGH: Field measurement entry caps insulation-resistance units at MΩ — no GΩ/TΩ — forcing wrong values on MV cable and large transformers**
The field job unit dropdown is `['MΩ','kΩ','Ω','μΩ','A','kV','V','ms','°C','%']`. Megger/IR testing of MV cable, large windings and switchgear routinely reads gigohms or teraohms (e.g. 50 GΩ); with no GΩ option a tech must enter 50000 MΩ or, worse, "50" with the wrong unit, which then drives the trend and the leave-behind. There is also no `ppm` (DGA), no `ratio` (PI/DAR/TTR), and no `μΩ` consistency (see NETA-8-12). Fix: add GΩ, TΩ, ppm, and ratio to the field unit list.
File: client/src/pages/field/FieldJob.jsx line 48

**[NETA-8-5] HIGH: Test-report value extractor grabs the first number after the label, so it captures the test voltage instead of the reading**
`parseTestReport` sets `valueStr = firstMatch(/\b([\d]+(?:\.\d+)?)\b/, seg…)` — the first number in the segment after the label. On a real Megger/PowerDB row ("Insulation Resistance … Test Voltage 5000 V … 2.5 GΩ") the first number is the 5000 V test voltage, not the 2.5 GΩ reading, so the committed `asFoundValue` is the energizing voltage. The unit regex also lacks GΩ/TΩ, compounding the error. Fix: prefer the number adjacent to a resistance unit (and exclude numbers immediately preceding "V/VDC/kV") rather than the first numeric token.
File: server/lib/testReportParse.ts lines 110-113

**[NETA-8-6] HIGH: Leave-behind "What We Found" prints IMMEDIATE/Recommended/Advisory — not the C1/C2/C3 NETA condition codes a customer expects, and it labels every non-immediate item the same**
`severityLabel`/`severityColor` collapse all severities to three buckets and render "Advisory" for anything that is not IMMEDIATE/RECOMMENDED. NETA acceptance/maintenance reports communicate condition as C1/C2/C3 (or priority 1–4); a deficiency table headed "Advisory" with no condition code looks unlike any NETA leave-behind and gives the facility no standard reference to act on. The doc's own header comment claims C1/C2/C3 ratings that the renderer never produces. Fix: map severity to the NETA condition/priority vocabulary and show the code alongside the description.
File: server/lib/leaveBehindPdf.ts lines 55-65, 186-204

**[NETA-8-7] HIGH: Leave-behind has no technician signature, certification, or company/PE block — it is not a defensible leave-behind**
`renderLeaveBehindPdf` ends with a rep-contact line and a generic disclaimer; there is no signature line, no NETA technician name/level or certification number, no test-company license block, and no "tested by / reviewed by" attestation. A NETA leave-behind that the facility files for compliance must carry the technician's identity and signature. (Contrast arcFlashLabelDoc.ts, which correctly blocks printing without PE attribution.) Fix: add a signature/certification block (technician name, NETA level/cert #, company, signature, date) populated from the work-order/contractor record.
File: server/lib/leaveBehindPdf.ts lines 310-326; server/lib/leaveBehindData.ts lines 38-58

**[NETA-8-8] HIGH: Shock approach boundaries are never computed from NFPA 70E Table 130.4 — the only references are display fields, so labels/permits carry blanks or unvalidated hand-entries**
A repo-wide search shows `shockLimitedApproachIn`/`shockRestrictedApproachIn` are referenced only where they are displayed (label snapshot, label PDF, permit) — never derived from the voltage via NFPA 70E Table 130.4. In practice they are null (label prints "[Required — not on file]") or whatever a user typed, with no check that, e.g., a 480 V bus shows Limited 42 in / Restricted 12 in. A NETA/PE reviewer expects these to follow from nominal voltage. Fix: add a deterministic Table 130.4 lookup keyed on nominalVoltage to populate/validate the two boundaries.
File: server/lib/arcFlashLabel.ts lines 17-21, 49-50; server/lib/arcFlashLabelDoc.ts lines 144-148

**[NETA-8-9] MEDIUM: Polarization Index and Dielectric Absorption pass/fail ignore the IEEE 43 absolute floors — only a year-over-year delta or a parsed operator can flag them**
PI and DAR are typed `bad: 'down'` but `critical: false`, and there is no absolute-threshold check anywhere: `evaluate()` only fires if the PDF text contains an explicit `>=`/`<=` operator, and the trend path needs a prior reading. A PI of 0.9 on a winding (IEEE 43 flags PI < 1.0 as a serious moisture/contamination indicator and < 2.0 as questionable for older insulation) commits as GREEN with no deficiency. Fix: add IEEE 43 absolute floors (PI < 1.0 → IMMEDIATE/RED, < 2.0 → ADVISORY; DAR < 1.0 → flag) in the evaluate/severity path.
File: server/lib/testReportParse.ts lines 54-69, 140-145; server/pyextract/neta_field_library.py lines 60-62

**[NETA-8-10] MEDIUM: DGA condition counts CO2 toward the overall transformer condition, contradicting IEEE C57.104 (CO2 is informational, not a condition driver)**
`LIMITS` includes `co2: [2500,4000,10000]` and `evaluateDga` folds every gas in `LIMITS` (except tdcg) into `worst`, so an elevated CO2 (common from normal cellulose aging) alone can push `overallCondition`/`resultRating` to YELLOW/RED. The file's own header says "CO2 is tracked but excluded from TDCG," but it is NOT excluded from the condition roll-up. A transformer with only high CO2 would be reported RED, which a DGA-literate reviewer would reject. Fix: exclude CO2 from the `worst`-condition computation (report it, don't grade on it).
File: server/lib/dgaEvaluate.ts lines 24-34, 76-93

**[NETA-8-11] MEDIUM: Out-of-spec test readings auto-create deficiencies with no NETA standard reference or pass/fail basis, so the fix-it list looks unsourced**
`commitAssetReadings` writes deficiency descriptions like "Contact Resistance (Ph A): 350µΩ — expected >=…" with `correctiveAction: 'Flagged from test report ingest — review reading…'`. There is no citation of the governing NETA table/acceptance criterion (e.g. ANSI/NETA ATS Table 100.1 / 100.12) and no record of WHY it failed beyond the raw expected string. A leave-behind that flags failures without a standard reference reads as arbitrary to a facility engineer. Fix: attach the governing standard/table reference to ingest-generated deficiencies.
File: server/lib/commitTestReport.ts lines 114-123

**[NETA-8-12] MEDIUM: Micro-ohm unit is entered as μΩ (U+03BC) in the field form but normalized to µΩ (U+00B5) everywhere else, so contact-resistance units split into two strings**
The field dropdown emits `'μΩ'` (Greek small letter mu, U+03BC), while the parser vocab, sanity bands and normalizers use `'µΩ'` (micro sign, U+00B5). The two are visually identical but distinct code points, so field-entered contact-resistance readings carry a different unit string than ingested ones — breaking unit grouping, trend keys, and any unit-equality check. Fix: standardize on one code point (U+00B5) across client and server.
File: client/src/pages/field/FieldJob.jsx line 48 (compare server/lib/testReportParse.ts line 24, server/pyextract/neta_field_library.py line 63)

**[NETA-8-13] MEDIUM: `evaluate()` RED/YELLOW band is unit-relative and ignores `bad` direction, so it mislabels how far out of spec a reading is**
`evaluate()` computes `ratio = |value - thr| / thr` and calls anything >25 % out "RED," but it never consults the measurement's `bad` direction and the 25 % band is arbitrary across measurement types. For insulation resistance a reading 24 % below a minimum is "YELLOW" while a contact-resistance reading 26 % above its max is "RED," with no NETA basis for the cutoff and no distinction between a barely-failing safety-critical contact resistance and a marginally-low IR. Fix: derive the verdict band from the measurement type's NETA acceptance criteria and `bad` direction, not a flat ±25 % of the threshold.
File: server/lib/testReportParse.ts lines 54-69

**[NETA-8-14] MEDIUM: AFX import silently coerces any unknown equipment type to PANELBOARD, changing the IEEE 1584 enclosure/gap defaults a bus inherits**
`mapEquipmentType` returns `'PANELBOARD'` for any unrecognized type. Because `arcFlashGap.ieee1584Defaults` keys electrode config, conductor gap and working distance off the equipment family, an imported "switchrack"/"metal-enclosed bus"/typo silently becomes a panelboard and inherits 25 mm gap / 18 in working distance instead of switchgear values (32 mm / 24 in), shifting the IEEE 1584 inputs a PE would then trust. Fix: leave unknown types unmapped (or flag for review) rather than defaulting to a specific enclosure class that drives the model.
File: server/lib/arcFlashAfxMultiTable.ts lines 413-422; server/lib/arcFlashGap.ts lines 77-94

**[NETA-8-15] MEDIUM: Thermography deficiency text reports a bare ΔT with no reference frame or load context, so the leave-behind hot-spot is not interpretable per NETA**
`thermographyIngest` writes `IR hot-spot (date): <loc> — ΔT 30°C (<label>)` with no statement of whether ΔT is over ambient or between phases, and no load-at-survey. NETA Table 100.18 severity is meaningless without the reference, and IR findings without load context are not actionable. Combined with NETA-8-1, the recorded deficiency can be both wrongly graded and undocumented as to basis. Fix: persist and print the reference frame (and load if available) in the hot-spot deficiency description.
File: server/routes/thermographyIngest.ts lines 84-92

---

# INFOSEC-8 — Enterprise IT / InfoSec Gatekeeper

Scope: SSO enforcement, session lifecycle, SCIM deprovisioning, CSP/CORS/security headers, rate-limiting on auth surfaces, admin audit completeness, object-storage exposure, secrets in logs. Every finding verified against HEAD 85d10fa source. Read-only.

---

**[INFOSEC-8-1] CRITICAL: SSO login path completely bypasses 2FA / mfaRequiredForAdmins**
The password login handler gates on `user.twoFactorEnabled` and issues a pending-2FA token, but the SSO `/callback` and `/exchange` handlers mint a full access+refresh pair via `issueTokenPair()` with no 2FA check at all. An admin who has enrolled TOTP (or an account with `mfaRequiredForAdmins=true`) can skip their second factor entirely by authenticating through the IdP — and an attacker who compromises the federated identity faces no MFA wall. A vendor questionnaire that asks "is MFA enforced for all administrative access" must be answered "no" for SSO accounts. Fix: after resolving the user in `/exchange`, if `twoFactorEnabled` (or account `mfaRequiredForAdmins` for admins), return a `requires2fa` pending token instead of full tokens, mirroring `routes/auth.ts`.
File: server/routes/sso.ts lines 258-268

**[INFOSEC-8-2] CRITICAL: SSO-required ("only SSO allowed") enforcement fails OPEN on any settings-read hiccup**
When `sso.required=true`, password login is supposed to be blocked for everyone except the local break-glass admin. But the entire gate is wrapped in a try/catch that, on any error reading the `AccountSetting` row, logs and **allows the password login to proceed**. A transient DB blip, a Prisma connection-pool exhaustion, or a deliberately-induced load spike converts a "SSO mandatory" account back into a password-accepting account for the duration. Customers who buy on the promise that they can force SSO-only will treat a fail-open authentication control as a veto-level defect. Fix: fail CLOSED — on the read error, reject the password login with `SSO_REQUIRED` (the break-glass admin still has the IdP-independent reset path).
File: server/routes/auth.ts lines 678-694

**[INFOSEC-8-3] HIGH: SSO callback accepts logins with NO id_token signature validation**
When Polis returns no `id_token` (OIDC signing keys not configured), the callback logs a warning and proceeds to provision/authenticate the user using only the back-channel userinfo response. The code comment claims PKCE + single-use state + tenant cross-check are sufficient, but without a signed id_token there is no cryptographic binding of the userinfo response to the authenticated subject, and the `nonce` replay defense is silently skipped. An InfoSec reviewer cannot accept "we sometimes validate the token signature, depending on IdP config." Fix: make a validated id_token mandatory when `SSO_ENABLED` — refuse the login (fail closed) if `token.id_token` is absent, and document the Polis OIDC-key requirement as a hard prerequisite.
File: server/routes/sso.ts lines 141-158

**[INFOSEC-8-4] HIGH: Admin/security audit events silently drop the source IP — `ipAddress` is never persisted**
`writeLog()` destructures only `{ assetId, userId, accountId, action, details }`; it has no `ipAddress` parameter. Multiple privileged-action call-sites pass `ipAddress: req.ip` (role change, scope-restriction change) expecting it to be recorded — it is silently discarded, so the audit trail for "who changed this user's role, and from what IP" has no IP. SOC 2 / vendor diligence specifically probes whether privileged changes are attributable. Fix: add an `ipAddress` column write to `writeLog` (or fold IP into `details` consistently at every call-site) so the IP actually lands in the row.
File: server/lib/activityLog.ts lines 40-54 (callers: server/routes/users.ts lines 473, 1098)

**[INFOSEC-8-5] HIGH: User reactivation is an unaudited privileged action**
`PUT /api/users/:id/activate` flips `isActive` back to true — restoring a deactivated/offboarded user's ability to log in — and writes **no** ActivityLog row, unlike its `deactivate` counterpart which logs `user_deactivated`. An admin (or an attacker who has compromised an admin) can silently re-enable a terminated employee's account with zero audit evidence. Reviewers reconciling deprovisioning events will find deactivations logged but reactivations invisible. Fix: write a `user_activated` audit row (actor, target, IP) in the activate handler.
File: server/routes/users.ts lines 575-591

**[INFOSEC-8-6] HIGH: Access/refresh tokens are returned in the JSON body (client-side storage), not httpOnly cookies**
Every auth path — login, register, refresh, SSO exchange, 2FA verify, invite-accept — returns `{ token, refreshToken }` in the response body. There is no `Set-Cookie` anywhere in the server (`res.cookie`/`httpOnly`/`SameSite` appear nowhere), yet the CORS block's own comments claim `credentials:true` is "required for refresh-token cookies." The client therefore holds long-lived (30-day) refresh tokens in JS-reachable storage, so any XSS becomes full, persistent account takeover with no httpOnly/SameSite mitigation. Vendor reviews flag bearer-token-in-localStorage as a material design weakness. Fix: move the refresh token into an httpOnly, Secure, SameSite=strict cookie scoped to the API path, and correct/remove the misleading cookie comments.
File: server/index.ts lines 584-604 (comment claims cookies); server/routes/auth.ts lines 518-519, 740-743

**[INFOSEC-8-7] HIGH: Password breach (HIBP) check fails OPEN, so a known-compromised password is accepted on any outage**
`checkBreached()` returns `{ breached: false }` whenever the HIBP k-anonymity API is unreachable or times out (3s). On any HIBP outage, slow network, or an attacker who can degrade egress, the breach gate silently disappears and a password from the breach corpus is accepted at registration / reset / admin-set. The comment frames fail-open as "conservative," but for an account-security control reviewers expect breached credentials to be rejected; the zxcvbn floor is a weak substitute for the actual breach list. Fix: at minimum log + flag the fail-open, and for high-value (admin) accounts treat a HIBP timeout as a soft reject or require a retry rather than a silent pass.
File: server/lib/passwordPolicy.ts lines 102-114

**[INFOSEC-8-8] MEDIUM: 2FA enrollment, disable, and backup-code regeneration require no step-up / recent-auth**
`/2fa/setup`, `/2fa/enable`, `DELETE /2fa/disable`, and `/2fa/backup-codes/regenerate` are gated only by `authenticateToken` — a valid (possibly hours-old, 1h-TTL) access token. Disable additionally asks for a current TOTP code, but **setup/enable** lets a hijacked session silently provision an attacker-controlled authenticator, and none of these require re-entering the password or a fresh re-auth. An attacker riding a stolen access token can pivot to durable account control. Reviewers expect MFA-management operations to demand step-up re-authentication. Fix: require a fresh password (or recent-auth assertion) before any 2FA state change.
File: server/routes/twoFactor.ts lines 197-279

**[INFOSEC-8-9] MEDIUM: No dedicated brute-force limiter on the 2FA verify-login userId — only IP limiter is at the edge**
`/2fa/verify-login` is protected by an IP limiter (5/15min) plus an in-process per-user counter. The per-user counter (`_totpUserFailMap`) is process-local and resets on every PM2 restart/deploy, and the IP limiter is trivially evaded by IP rotation (the same CF-edge rotation the codebase documents elsewhere). Across a deploy or from rotating IPs, the effective TOTP guess budget exceeds the intended 5, weakening the 6-digit second factor. Fix: persist the per-user TOTP failure counter (DB-backed, like the documented FailedLoginAttempt plan) so the cap survives restarts and is not IP-scoped.
File: server/routes/twoFactor.ts lines 42-72, 371-386

**[INFOSEC-8-10] MEDIUM: Internal company codename "ForgeRift" leaks to customers in the GDPR data-export sub-processor snapshot**
The GDPR Article 15 export embeds a note stating the data was processed "on **ForgeRift's** behalf," while the rest of the product, emails, and domains brand as ServiceCycle. Any data subject who exercises their access right receives a document naming a different controller entity than the one they contracted with — a privacy-notice/controller-identity inconsistency that a diligence reviewer (and a regulator) will flag, and a sloppy artifact to hand an acquirer. Fix: replace `ForgeRift` with the canonical product/controller name (or the correct legal entity) in the export note.
File: server/routes/users.ts line 658

**[INFOSEC-8-11] MEDIUM: CSP has no `upgrade-insecure-requests`, no `report-uri/report-to`, and `worker-src`/`manifest-src`/`media-src` are unspecified**
The CSP is otherwise strict (`default-src 'none'`, `script-src 'self'`), but it omits `upgrade-insecure-requests` (so any accidental `http://` subresource is not auto-upgraded), ships no `report-uri`/`report-to` (so violations in enforce mode are invisible — there is no telemetry to detect an injection attempt), and leaves `worker-src`/`manifest-src`/`media-src` to fall through. For a PWA (the app ships a service worker + manifest) the missing `worker-src`/`manifest-src` directives mean those load contexts are governed only by `default-src 'none'`, which can break or under-specify policy. Fix: add `upgradeInsecureRequests`, a CSP reporting endpoint, and explicit `workerSrc`/`manifestSrc 'self'`.
File: server/index.ts lines 471-482

**[INFOSEC-8-12] MEDIUM: CORS allows all credentialed no-Origin requests and never sets `Access-Control-Allow-Methods/Headers` allowlist**
The CORS `origin` function returns `callback(null, true)` for any request with no `Origin` header (curl, server-side, some same-origin XHR) while `credentials:true` is in effect, and the config defines no explicit `methods`/`allowedHeaders` allowlist (relying on the `cors` package defaults that reflect the request's `Access-Control-Request-Headers`). Reviewers running an automated CORS audit will flag both the no-Origin allow and the reflected-headers behavior as loosened posture for a credentialed API. Fix: pin `methods` and `allowedHeaders` to an explicit allowlist; the no-Origin allow is defensible but should be documented as an accepted exception.
File: server/index.ts lines 584-604

**[INFOSEC-8-13] MEDIUM: `/api/auth/logout` is unauthenticated and only revokes the single presented refresh token — no "log out all sessions" for the user**
`POST /api/auth/logout` takes a refresh token in the body, requires no access token, and revokes only that one token's row (the matching access token still works until its 1h TTL, since logout doesn't bump `tokenEpoch`). There is no self-service "sign out everywhere" — a user who suspects compromise cannot kill all their sessions; only an admin `revoke-sessions` (or a password change) does a full epoch bump. Reviewers expect a user-initiated global logout for session-compromise response. Fix: add an authenticated "logout-all" that revokes all refresh tokens and increments `tokenEpoch`, and consider bumping epoch on single logout too.
File: server/routes/auth.ts lines 852-868

**[INFOSEC-8-14] MEDIUM: SCIM webhook secret is shared per-instance, not per-directory — one tenant's leaked secret can forge events for all**
`scimWebhookSecret` comes from a single global env var (`SCIM_WEBHOOK_SECRET`) and is reused for every account's SCIM directory (`ssoConfig.ts` + `adminCreateDirectory` passes the same `cfg.scimWebhookSecret`). The handler does enforce a cross-tenant guard (it won't touch a user in another account), but signature validity itself is not tenant-scoped: any party who learns the one shared HMAC secret can submit signed deactivate/provision events targeting **any** account's directory, and the directory→account resolution trusts the (signed-but-shared-key) payload's `polisDirectoryId`. In a multi-tenant enterprise sale this single-shared-secret model is a hard question at diligence. Fix: derive/store a per-directory webhook secret and verify against the secret bound to the resolved directory.
File: server/lib/ssoConfig.ts lines 60-83; server/routes/ssoScim.ts lines 144-167

**[INFOSEC-8-15] LOW: S3 pre-signed document URLs are valid for a full hour with no per-request scoping or short expiry option**
`getFileUrl()` issues S3 GET pre-signed URLs with a hard-coded `expiresIn: 3600`. Once minted, that URL is a bearer capability to the object for a full hour — if it lands in a referrer header, browser history, proxy log, or a forwarded link, anyone holding it can fetch the (potentially sensitive equipment/customer) document with no further auth. One hour is long for a download link. Fix: shorten the default to ~60-300s, make it env-configurable, and prefer streaming through the authenticated `/api/documents/file` proxy (which the local path already does) over handing raw bucket capabilities to the client.
File: server/lib/storage.ts lines 217-237

---

# LEGAL-8 — Plaintiff's Expert Witness

Scope: arc-flash incident-energy / PPE / boundary data integrity, audit-trail coverage on safety mutations, de-energized/cleared verification, immutability of incident & LOTO records, AI-generated safety values, stale-label exposure, and disclaimer sufficiency. Every finding verified against current code at HEAD 85d10fa. Read-only scan.

The recurring theme a plaintiff's expert would exploit: ServiceCycle has built a sophisticated hash-chained audit log (`server/lib/activityLogChain.ts`) and uses it well for LOTO — but the arc-flash data-layer write paths that actually change the numbers a worker reads off a label (incident energy, PPE category, arc-flash boundary, PE attribution, study date) either bypass logging entirely or log only an aggregate count with no old→new values. The platform records WHO logged in but not WHO changed the hazard number on the panel.

---

**[LEGAL-8-1] CRITICAL: Incident register silently fails to capture the arc-flash data state at the moment of every incident**
The incident POST handler tries to snapshot the bus's current label/study state by querying `prisma.arcFlashLabel?.findFirst(...)`, but no `ArcFlashLabel` model exists in the schema (the real table is `SystemStudyAsset`); the call resolves to `undefined`, throws, and is swallowed by a bare `catch (_) {}`. The result is that `studyStateSnapshot` is **always null** on every incident ever logged — the single record whose stated purpose is "what did the label say at the moment this happened?" is empty by construction. A plaintiff's expert would argue ServiceCycle marketed and shipped an incident register that provably never preserved the hazard data it claimed to, destroying the post-incident evidentiary trail the buyer would rely on to defend itself. Fix: query `systemStudyAsset` (matching the public-label code path), and make snapshot failure a logged warning rather than a silent swallow.
File: server/routes/arcFlashIncidents.ts lines 99-111; server/prisma/schema.prisma lines 3237-3266 (no ArcFlashLabel model)

**[LEGAL-8-2] CRITICAL: Incident-energy / PPE / boundary values can be overwritten on a durable study with no who/what/when record of the change**
`POST /import-results` matches a PE results CSV to bound buses and writes `incidentEnergyCalCm2`, `arcFlashBoundaryIn`, `ppeCategory`, `requiredArcRatingCalCm2`, `workingDistanceIn` straight onto the live `SystemStudyAsset` rows. The only audit artifact is one aggregate `arc_flash_results_imported` row recording a COUNT (`applied`, `unmatched`) — not which bus changed, not the prior value, not the new value. Compare with `arcFlashPermit.ts` line 140, which correctly captures `incidentEnergyAtTime`/`ppeCategoryAtTime`; the write path that actually mutates those numbers captures neither. In litigation this means there is no way to reconstruct what a panel's label said before someone re-imported a CSV, or to detect a value that was raised/lowered to make work look compliant. Fix: write a per-bus activity-log row with `{busId, field, from, to}` for every applied change.
File: server/routes/arcFlashIngest.ts lines 2356-2366

**[LEGAL-8-3] CRITICAL: PE attribution and study date on a stamped study can be silently edited / back-dated with no audit record at all**
`PUT /api/sites/studies/:id` lets any manager change `performedDate`, `peName`, `peLicense`, `expiresAt`, and `method` on an existing study and persists them with `prisma.systemStudy.update(...)` — and writes **no** `logActivity` / `writeLog` of any kind. `peName`/`peLicense` are exactly the values rendered as "Study by: … , PE" on the printed NFPA 70E label (`arcFlashLabelDoc.ts` lines 171-174), and `performedDate` drives the 5-year expiry clock and the "is this study current" gate. A plaintiff's expert would argue the platform let a non-engineer attach a licensed PE's name to a label, or back-date a study to defeat the expiry gate, leaving no trace. Fix: log every study-field mutation with before/after, and treat PE-attribution changes as a distinct, alertable event.
File: server/routes/sites.ts lines 752-826

**[LEGAL-8-4] CRITICAL: Logged incident records are fully mutable by managers — injury status, OSHA-recordable flag, and occurrence date can be rewritten with no immutable history**
`PATCH /api/arc-flash-incidents/:id` accepts the entire field set including `injury`, `oshaRecordable`, `occurredAt`, and `description`, and overwrites them via `prisma.arcFlashIncident.update(...)` with no activity-log write and no append-only versioning. A manager can flip `injury: true → false`, clear `oshaRecordable`, change the description of what happened, or back-date `occurredAt` after the fact, and nothing records that the record was altered or what it previously said. This is the single most damaging exposure: the contemporaneous injury record — the document OSHA and a jury would treat as authoritative — is editable without trace. Fix: make incident records append-only (corrections as new linked rows) or at minimum write a full before/after audit-log entry on every PATCH.
File: server/routes/arcFlashIncidents.ts lines 144-195

**[LEGAL-8-5] HIGH: Reviewer edits to arc-flash hazard inputs/outputs on an ingest draft write no audit record**
`PATCH /ingest/:id/bus/:busId` lets a manager edit `incidentEnergyCalCm2`, `arcFlashBoundaryIn`, `ppeCategory`, `electrodeConfig`, `clearingTimeMs`, `workingDistanceIn`, and the protective-device settings on a bus, then re-derives DANGER/WARNING severity — with no `logActivity` call anywhere in the handler. Because these draft values flow into the durable study and label on confirm, a worker can be shown a PPE category or incident-energy figure that a reviewer typed in by hand, with no record of who entered it or what the extracted value was. Fix: log bus-field edits (especially the label-output fields) with before/after, mirroring the LOTO pattern.
File: server/routes/arcFlashIngest.ts lines 409-486

**[LEGAL-8-6] HIGH: The tamper-evident hash chain does not cover any safety data — only the log rows themselves**
`activityLogChain.ts` `canonical()` (lines 61-75) hashes only `id, accountId, assetId, action, details, createdAt` of `ActivityLog`. It provides zero integrity over `SystemStudyAsset` (incident energy/PPE/boundary), `SystemStudy` (PE name/date), `ArcFlashIncident`, or `LotoProc`. The chain's own threat-model comment concedes it does not defeat an insider with DB + app-server access. So even on the paths that DO log, the underlying hazard value can be edited directly in the database and the chain will never flag it, because the chain never committed to that value — only to a free-text `details` blob the route chose to write. A plaintiff's expert would characterize the "tamper-evident audit" as covering the bookkeeping while leaving the safety numbers unprotected. Fix: include a hash of the mutated safety record's material fields in the logged `details` so the chain transitively commits to the value.
File: server/lib/activityLogChain.ts lines 51-95

**[LEGAL-8-7] HIGH: Study-asset binding overwrites incident energy / PPE and the audit log omits the values; the matching DELETE logs nothing**
`POST /api/sites/studies/:id/assets` upserts `incidentEnergyCalCm2`, `arcFlashBoundaryIn`, `workingDistanceIn`, `ppeCategory` onto the binding (line 955), but the `logActivity` it writes (line 976) records only `{studyId, rootAssetId, includeDownstream, downstreamAdded}` — never the hazard values set or replaced. The companion `DELETE /api/sites/studies/:id/assets/:assetId` hard-deletes the binding (erasing the recorded incident energy/PPE for that bus) with **no** activity-log entry at all. Deleting the hazard record for a piece of equipment leaves no trace it ever existed. Fix: capture the label values in the bind log and add a deletion audit entry.
File: server/routes/sites.ts lines 938-959, 987-1009

**[LEGAL-8-8] HIGH: AFX multi-table import overwrites existing study fields in `overwrite` mode with only count-level logging**
`POST /afx/import-multi/apply` supports `mode: 'overwrite'` (line 2023) which lets a bulk spreadsheet clobber existing `SystemStudyAsset` fields via `tx.systemStudyAsset.updateMany(...)` (line 2049). The route's own header comment claims it "never overwrites existing values (can't clobber PE-stamped data)" and "every change goes to the activity log," but the `overwrite` flag contradicts the first claim, and the logging is aggregate, not per-field-before/after. A reviewer relying on the comment would wrongly believe PE-stamped incident energy is protected from a bulk import. Fix: either honor the no-clobber guarantee or log each overwritten field's prior value; reconcile the misleading comment.
File: server/routes/arcFlashIngest.ts lines 1990-1992 (comment), 2023-2050

**[LEGAL-8-9] HIGH: De-energized / work-type and OSHA determinations are recorded as unverified free entry with no second-person check**
The incident `workType` accepts `de_energized` and `oshaRecordable` is stored as a bare boolean from the request body with no verification, no qualified-person attestation, and no second-person sign-off (`arcFlashIncidents.ts` lines 125-126). Unlike LOTO activation, which enforces self-approval prevention (`loto.ts` lines 283-289), nothing prevents a single user from asserting work was de-energized or that an event was not OSHA-recordable. A plaintiff would argue the platform let one person unilaterally characterize the energization state and recordability of an injury event with no corroboration. Fix: require a distinct approver for incident classification fields and capture it immutably.
File: server/routes/arcFlashIncidents.ts lines 113-133

**[LEGAL-8-10] MEDIUM: AI-extracted arc-flash values carry no confidence/sign-off attestation through to the durable study**
`arcFlashExtract.ts` returns `aiProvider` and `promptVersion` but no per-field confidence, and the confirm path (`arcFlashIngest.ts` line 575+) writes AI-extracted incident energy / boundary / PPE into the durable study without recording that the value originated from an unverified AI read versus a PE entry, and without any PE sign-off gate. The `AiDisclaimer` `extract` variant is a soft "AI can make mistakes — verify each field" (`AiDisclaimer.jsx` line 53) shown in the review UI only; once confirmed, provenance is lost. A plaintiff's expert would argue a worker had no way to know a hazard figure was machine-extracted from a scanned PDF rather than engineer-verified. Fix: persist a per-field source (`ai_extracted` vs `pe_entered`) and a reviewer attestation on the binding.
File: server/lib/arcFlashExtract.ts lines 294-297; server/routes/arcFlashIngest.ts lines 607-639

**[LEGAL-8-11] MEDIUM: Printed-vs-current label mismatch is computed and returned but never blocks or alerts — a stale sticker reads as a valid live record**
The public label portal (`arcFlashLabelPublic.ts`) and `issue-label` both compute a `mismatch` between the physically-printed snapshot and the current study, but the portal returns HTTP 200 with the live label and a `mismatch` field the client may or may not surface — there is no hard "this printed label no longer matches the study; do not rely on it" gate, and `issue-label` re-stamps `printedSnapshot` on reprint without recording the prior printed values. If a panel's electrical configuration changed and incident energy rose, a worker scanning the old QR still gets a successful, official-looking response. Fix: when `mismatch` is material, return a prominent superseded state rather than a normal label payload, and version printed snapshots.
File: server/routes/arcFlashLabelPublic.ts lines 45-67; server/routes/arcFlashIngest.ts lines 1352-1358

**[LEGAL-8-12] MEDIUM: Permit issuance gate only checks study date/supersession — it cannot detect that the system changed since the study, yet pre-fills authoritative-looking hazard data**
`validatePermitIssuance` (`arcFlashPermit.ts` lines 38-47) blocks issuance only when the study is missing, superseded by an explicit newer revision, expired by date, or has no IE/voltage. It cannot detect an un-restudied physical system change (a swapped breaker, added load) that invalidates the incident energy. The permit nonetheless pre-fills incident energy, boundary, and PPE as concrete numbers and stamps `canIssue: true`. The disclaimer (line 126) does push operational-validity confirmation to a qualified person, which mitigates but does not eliminate the over-reliance risk of a fully pre-filled, "verified"-labeled permit. Fix: surface the most recent device-drift/ingest-drift signal in the gate and downgrade `canIssue` when unreviewed drift exists for the asset.
File: server/lib/arcFlashPermit.ts lines 38-47, 80-127

**[LEGAL-8-13] MEDIUM: The v1 public API can write protective-device settings (which drive clearing time → incident energy) with only an API-key scope and no actor/audit attribution**
`POST /api/v1/arc-flash/devices` (`v1/arcFlash.ts` lines 158-179) creates a `ProtectiveDevice` with trip `settings` under just `requireScope('write')` — no human actor, and no activity-log write. Protective-device settings determine the clearing time that feeds the IEEE 1584 incident-energy result, so an automated integration can inject device data that materially changes the hazard basis with no record of which key or integration did it. Fix: log v1 device writes with the API-key id and the device payload hash.
File: server/routes/v1/arcFlash.ts lines 144-179

**[LEGAL-8-14] MEDIUM: Generated arc-flash label omits mandatory shock-approach boundaries as a soft placeholder rather than blocking the print**
`arcFlashLabelDoc.ts` renders missing shock limited/restricted approach boundaries as the literal text `[Required — not on file]` (lines 144-147) and still produces the label PDF. NFPA 70E §130.5(H) treats shock-approach boundaries as mandatory label content; the code's own TODO at line 143 acknowledges this. A label printed and posted with placeholder text where a mandatory safety boundary belongs is a defect a plaintiff would attribute to the platform that generated it. Fix: block label generation (as is already done for missing IE/PPE at line 48 and missing PE at line 55) when shock-approach boundaries are absent, or clearly mark the label DRAFT/NOT-FOR-POSTING.
File: server/lib/arcFlashLabelDoc.ts lines 140-148

---

Cross-cutting recommendation for the buyer: introduce a single `logSafetyMutation({entity, id, field, from, to, actor})` helper invoked on every write to `SystemStudyAsset`, `SystemStudy`, `ArcFlashIncident`, `ProtectiveDevice`, and `LotoProc`, routed through the existing hash chain with the value committed in the canonical payload. The infrastructure already exists (LEGAL-8-6); it simply is not wired to the tables that carry the liability.

---

# CUST-8 — Plant Maintenance Manager (60 days in)

Sixty days in, the demo shine is gone and I run this thing every morning across ~500 assets, hundreds of work orders, and a thick stack of open deficiencies. These are the things that make me reach for Excel again, that quietly hide data from me, or that make me wonder whether the alerts I'm trusting are even firing. Every item below is verified in the actual code.

---

**[CUST-8-1] CRITICAL: The Alerts feed silently caps at 100 rows — beyond that, alerts and the bell count are just wrong**
`GET /api/alerts` hard-caps at `take: 100` with no pagination, no skip, and no total count returned; `AlertsPage` renders exactly what the server hands back and offers no "next page." At 500 assets across six lead tiers (180/120/90/60/30/7) plus overdue/escalation/breach, I routinely have well over 100 open alerts, so an unknown set of overdue/breach items never appears in the feed and the sidebar bell undercounts — I make staffing decisions off a list that is silently truncated. Fix: paginate the endpoint (return `pagination.total`, accept `page`) and add pager controls, or at minimum sort breach/overdue first AND surface "showing 100 of N — narrow filters."
File: server/routes/alerts.ts lines 103-126; client/src/pages/AlertsPage.jsx lines 141-152

**[CUST-8-2] CRITICAL: Maintenance lead alerts (e.g. 60-day) silently never fire if the cron misses ~5 days or an asset enters a tier mid-band**
The alert engine only fires a lead tier when `Math.abs(daysUntil - tier.leadDays) <= 5`, and the dedup key fires each tier at most once per cycle. If the nightly job is down for more than 5 days, or a schedule's due date lands more than 5 days inside a band (common after an import or a date edit), that tier's alert is skipped forever — the asset jumps straight from "no warning" to overdue. I trust these alerts to tell me what's coming; a missed 60-day window on a transformer that "ServiceCycle never warned me about" is exactly the kind of surprise that ends a renewal. Fix: widen the catch window or, better, fire any tier whose threshold has been crossed-and-not-yet-fired (`daysUntil <= leadDays` with the dedup key already preventing repeats).
File: server/lib/alertEngine.ts lines 570-581

**[CUST-8-3] CRITICAL: Deficiencies page shows only the first 200 with no pager — items 201+ are unreachable**
`DeficienciesPage` requests `limit: 200` (the server's hard max) and, when there are more, just prints "Showing the first 200 of N — narrow the filters to see the rest." There is no page control. With 500+ open findings after a big thermography sweep, the oldest/least-severe ~300 deficiencies cannot be viewed, resolved, or even counted by site unless they happen to fall out via the severity/site filters. Triaging my backlog is impossible past row 200. Fix: add Prev/Next pagination wired to the endpoint's existing `page` parameter (it already returns `pagination.pages`).
File: client/src/pages/DeficienciesPage.jsx lines 182-201, 427-431; server/routes/deficiencies.ts lines 52-87

**[CUST-8-4] CRITICAL: Assets list silently truncates at 500 — asset #501 is invisible and the per-column filters only see the truncated set**
`AssetsList` fetches a single page of `FETCH_LIMIT = 500` and runs all the Excel-style per-column filters and pagination CLIENT-side over that slice. With more than 500 assets I get a yellow "Showing first 500 assets" banner, but worse: the powerful per-column header filters and counts operate only on those 500, so filtering for "all CABLE assets" or "Open Deficiencies ≥ 1" returns wrong totals and hides matching equipment that lives past row 500. The page's own comment admits "revisit if a tenant ever approaches this" — I'm a plant; I'm past it. Fix: push column filters + pagination server-side so the whole register is queryable.
File: client/src/pages/AssetsList.jsx lines 44-49, 294-318, 706-710

**[CUST-8-5] HIGH: Monthly digest advances its watermark even when every email fails — that month's roll-up is silently lost, no retry**
In `monthlyDigest`, `markBriefingSent(acc.id, now)` runs unconditionally after the send block; `_sendEmails` swallows every error and merely returns a boolean that's only used to bump a counter. So if the mail provider is down or the recipient bounces, the watermark still moves forward and `dueForBriefing` returns false next run — I simply never receive that month's compliance roll-up, and nothing retries or warns. A maintenance manager who stops getting the digest assumes the feature is dead and stops valuing the product. Fix: only advance the watermark when at least one email actually sent, or track an "attempted" timestamp separately so failures retry on a sane cadence.
File: server/lib/monthlyDigest.ts lines 327-337, 562-582

**[CUST-8-6] HIGH: Overdue calendar drill-down only looks back 35 months, so 3-year-plus overdue items vanish and the count contradicts the dashboard tile**
When the dashboard "Overdue" tile deep-links into the Compliance Calendar, the page fetches a fixed 36-month window (`shiftYm(now, -35)`) and the code comment concedes "An item overdue for 3+ years would fall outside this window." Neglected facilities are the whole reason a plant buys a CMMS; equipment overdue by several years is exactly what I need to see, yet it's dropped from the list and the on-page count no longer matches the tile I clicked. Contradictory numbers erode trust fast. Fix: in overdue mode, query with no lower date bound (or a far older floor) so every past-due schedule is represented.
File: client/src/pages/ComplianceCalendar.jsx lines 232-237, 255-262

**[CUST-8-7] HIGH: No bulk resolve / close / assign anywhere — I resolve 30 deficiencies one modal at a time**
There are no bulk endpoints or multi-select UIs for the high-volume lists: deficiencies resolve one-by-one through a modal, work orders complete/cancel one-by-one, and there's no "select all → resolve/assign." After a single test event drops 30+ ADVISORY findings, clearing them is a 30-round-trip death march. Real plant volume makes this the #1 reason I'd export to a spreadsheet and stop living in the app. Fix: add `POST /api/deficiencies/bulk-resolve` and `POST /api/work-orders/bulk-close` plus checkbox selection on those lists (the schedules feature already has a `bulk-apply` precedent).
File: client/src/pages/DeficienciesPage.jsx lines 398-420; server/routes/deficiencies.ts lines 50-92; server/routes/workOrders.ts lines 57-60

**[CUST-8-8] HIGH: Work-order list filters and page reset every time I come back from a job**
`WorkOrdersList` keeps `status`, `siteId`, `contractorId`, and `page` in local `useState` only — the page's own comment notes filters "live in state, not the URL." Click a job, hit Back, and I'm dumped to "All statuses / page 1," having to re-pick my site and re-page every single time I work down a filtered queue. Over a 60-day daily grind this is constant, grinding friction. (DeficienciesPage already persists filters to the URL — do the same here.) Fix: move the filters/page into `useSearchParams` so Back/refresh restore them.
File: client/src/pages/WorkOrdersList.jsx lines 258-260, 296-315

**[CUST-8-9] HIGH: "All recommendations" tab is locked to 50 rows with no pager — audit findings past 50 can't be seen**
`AuditsPage`'s `AllRecommendations` calls `GET /api/audits/recommendations` with no `page` param and no pagination UI, so it only ever shows the server default of 50 (the endpoint supports paging but the client never asks). A facility with an active OSHA/insurance audit easily exceeds 50 open recommendations; the rest — including overdue mandatory items I'm legally on the hook for — are invisible with no way to reach them. Fix: add Prev/Next wired to the endpoint's existing `page`/`pages`, matching the Audit-visits tab that already paginates.
File: client/src/pages/AuditsPage.jsx lines 642-663; server/routes/audits.ts lines 224-298

**[CUST-8-10] HIGH: Sites, Contractors, and Parts lists load every row with zero pagination — perf cliff and unbounded payloads at real volume**
`GET /api/sites` returns all sites AND separately pulls every open deficiency for the account to tally per site in JS; `GET /api/contractors` returns all contractors with per-row tech/WO counts; `GET /api/parts` returns the entire catalog. None accept `page`/`limit`. A multi-site operation with a 500+ part catalog ships a giant payload and renders hundreds of rows on every visit, and the Parts/Sites pages jank. Fix: paginate all three endpoints (and move the site deficiency tally to a grouped count query) following the assets.ts pattern.
File: server/routes/sites.ts lines 52-85; server/routes/contractors.ts lines 57-64; server/routes/parts.ts lines 361-384

**[CUST-8-11] MEDIUM: Parts catalog has no search/category persistence and renders the whole list — finding one breaker means scrolling hundreds of rows**
`Parts.jsx` maps over the full unpaginated catalog with no client pager and no URL-persisted search/category, and each row independently lazy-loads its inventory detail. With a real spare-parts catalog this is a wall of rows; if I navigate away and back, whatever I'd filtered to is gone. Fix: persist the search/category in the URL, paginate the render, and rely on the (newly paginated) server endpoint.
File: client/src/pages/Parts.jsx lines 141-232

**[CUST-8-12] MEDIUM: The field "Clear" button for technician assignment doesn't actually clear anything until you also click Assign**
On `WorkOrderDetail`, the field-tech "Clear" button only does `setAssignUserId('')` in local state — it never calls the API. The label says "Clear," the dropdown blanks, and I walk away believing the tech was unassigned, but the work order still has its `assignedUserId` server-side until I notice the dropdown isn't blank-and-saved and separately press "Assign." A tech keeps seeing a job I thought I pulled. Fix: make "Clear" call `PUT /api/work-orders/:id/assignment` with `userId: null` directly (the same handler already accepts null).
File: client/src/pages/WorkOrderDetail.jsx lines 343-352, 1327-1334

**[CUST-8-13] MEDIUM: New-asset and nameplate entry has no draft/preserve — an accidental nav or tab-close loses everything typed**
`NewAsset.jsx` holds the whole multi-field equipment form in component state with no localStorage draft and no `beforeunload` guard (verified: zero draft/sessionStorage/beforeunload references). Standing at a switchgear lineup keying in nameplate data, one stray back-swipe or accidental link click wipes the entire form with no recovery. For field-heavy data entry this silently punishes exactly the "frictionless data-in" the product sells. Fix: autosave the form to localStorage keyed by a draft id and offer to restore, plus a `beforeunload` prompt when the form is dirty.
File: client/src/pages/NewAsset.jsx (whole form; no draft persistence present)

**[CUST-8-14] MEDIUM: Completing a work order with an open IMMEDIATE deficiency only fails AFTER the modal round-trip, with a terse toast and no path to fix**
The server correctly blocks completion when an open IMMEDIATE deficiency exists (good), but the client lets me fill out the entire Complete modal (date, as-found/as-left, decal), submit, and only then surfaces "Cannot complete: open IMMEDIATE deficiency must be resolved…" as a one-line error inside the modal — with no link to the blocking deficiency. On a job with several findings I'm left hunting for which one, re-scrolling the page. Fix: disable/annotate the Complete button when `deficiencies` includes an unresolved IMMEDIATE, naming the blocker and linking to it, before I invest in the modal.
File: client/src/pages/WorkOrderDetail.jsx lines 367-386, 1122-1133; server/routes/workOrders.ts lines 592-599

---

# UX-8 — Product Designer Polish Sweep

Scan round v8. Persona: senior product designer, pre-demo polish sweep. Read-only.
HEAD 85d10fa. All findings verified against actual code at `client/src/`.

---

**[UX-8-1] HIGH: Destructive actions still pop the ugly OS-native `window.confirm()` while neighbors use the branded modal**
The app ships a polished `ConfirmDialog` (focus-trapped, AA-tokened, ESC/Enter, doc'd as a "Drop-in replacement for window.confirm()") and a global `useConfirm()` hook mounted in `App.jsx`, yet 8 destructive call sites bypass it and fire the gray, foreign OS dialog: delete template, delete part, delete inventory entry, remove required-part link, remove spare, remove study asset, delete document. On demo day, deleting an asset shows the branded modal but deleting a part/template shows the native browser box — a jarring, visible inconsistency. Fix: route these through `useConfirm()` like the other pages already do (EquipmentTemplates.jsx doesn't even import the hook).
File: client/src/pages/EquipmentTemplates.jsx line 300; client/src/pages/Parts.jsx lines 172, 190; client/src/components/RequiredPartsPanel.jsx line 129; client/src/components/SpareInventoryPanel.jsx line 94; client/src/components/StudyAssetBinding.jsx lines 92, 102, 148; client/src/components/AssetDocumentsCard.jsx line 178

**[UX-8-2] HIGH: ErrorBoundary's recovery screen references tokens that don't exist, so it always paints hardcoded light-mode colors**
`ErrorBoundary.jsx` styles the crash screen with `var(--color-primary, #0d4f6e)`, `var(--color-bg, #fff)`, `var(--color-text, #111)`, `var(--font-size-ui)`, `var(--font-size-data)`, `var(--font-size-sm)`, `var(--font-size-xs)`. The real tokens live in `index.css` and several of these (`--color-bg`, `--color-text`, `--color-primary`) DO resolve — but the literal fallbacks (`#fff`, `#111`) are wired so that if the boundary fires before `index.css` is parsed, or on the very page whose CSS broke, the screen renders pure white bg / near-black text regardless of dark mode. The button is hardcoded `color: '#fff'` on petrol. A white error screen flashing in a dark-themed demo is exactly the moment you don't want it to look broken. Fix: use the confirmed `--color-page-bg`/`--color-ink` (or index.css canonical names) with no light-only literal fallbacks.
File: client/src/components/ErrorBoundary.jsx lines 85-115

**[UX-8-3] MEDIUM: No skeleton loaders anywhere — every async page flashes a bare "Loading…" string then snaps to full content**
`grep skeleton` across all of `client/src` returns zero matches. List and dashboard pages render a tiny gray text node ("Loading…", "Loading work orders…") that then jumps to a full data table, causing a visible content-shift on every navigation. Modern SaaS (the comp set a PE/OEM buyer will benchmark against) uses skeleton shimmer. Fix: add a shared `<SkeletonRows>`/`<SkeletonCard>` and swap it in for the text "Loading…" on the high-traffic list/detail/dashboard pages.
File: client/src/pages/WorkOrdersList.jsx lines 326, 427

**[UX-8-4] MEDIUM: Public arc-flash QR portal uses zero design tokens, `system-ui` font, and no dark mode — it's off-brand the moment a buyer scans a sticker**
`PublicArcFlashLabel.jsx` (the no-login page a customer hits by scanning equipment) is built entirely from hardcoded hex (`#b91c1c`, `#6b7280`, `#e5e7eb`, `#fafafa`, `#374151`, `#9ca3af`) and `fontFamily: 'system-ui'`, with no ServiceCycle brand mark, no Inter font, and no theme support. This is the most likely surface a prospect physically interacts with in the field. The "loading" state is the literal string `Loading label…`. Fix: render it with the brand tokens + BrandMark and a proper loading treatment so the public portal matches the product.
File: client/src/pages/PublicArcFlashLabel.jsx lines 9-93

**[UX-8-5] MEDIUM: Two parallel, divergent token systems — `tokens.css` is doc'd as "single source of truth" but only 2 of ~120 components consume it**
`tokens.css` opens with "Single source of truth… Every component pulls from these variables — never hardcode" and defines `--color-petrol`, `--font-size-body`, `--radius-md`, `--space-4`. In reality components consume a *different* set defined in `index.css` (`--color-primary`, `--font-size-ui`, `--radius`). A grep for `var(--color-petrol`/`var(--font-size-body`/`var(--radius-md` in `components/` hits only 2 files (`system/RowCheckbox.jsx`, `system/FormField.jsx`) — and FormField even claims "All visual styling pulls from tokens.css." The documented design system is effectively dead code. A technical buyer opening `tokens.css` during diligence will be actively misled about how the UI is themed. Fix: collapse to one token file (or have `tokens.css` alias into the live `index.css` names) and update the stale header comments.
File: client/src/styles/tokens.css lines 1-6, 51-160; client/src/index.css lines 1-15

**[UX-8-6] MEDIUM: Commented-out feature block with hardcoded styling shipped to a production page**
`UsersPage.jsx` contains a 9-line `{/* TODO CS-7: … */}` block inside the invite form JSX, including a fully written-out hardcoded inline-style banner (`background:'#fffbeb', border:'1px solid #f59e0b', … color:'#92400e'`) that's commented out pending an `emailMode` flag. Shipping commented-out dead UI with raw hex into a page a diligence engineer will read signals an unfinished feature. Fix: delete the dead block or finish wiring the mock-email warning; either way it shouldn't sit in the JSX as a comment.
File: client/src/pages/UsersPage.jsx lines 379-387

**[UX-8-7] MEDIUM: Nameplate photo previews use empty `alt=""` even though the image is the content the user just captured**
`NameplateReview.jsx` renders the captured equipment-nameplate photo with `alt=""` in two places. Empty alt is correct only for decorative images; here the photo IS the subject under review (the nameplate the AI just read), so a screen-reader user gets nothing. Fix: `alt="Captured equipment nameplate photo"`.
File: client/src/components/NameplateReview.jsx lines 140, 156

**[UX-8-8] MEDIUM: Dead token `--color-text-tertiary` always falls back to a hardcoded gray**
`DemoModeBanner.jsx` styles the "Show demo banner" restore link with `color: 'var(--color-text-tertiary, #9ca3af)'`, but `--color-text-tertiary` is defined in neither `index.css` nor `tokens.css`. It therefore always resolves to the literal `#9ca3af`, which ignores dark mode (where `#9ca3af` on the `#0a0d12` page is a low-contrast smudge). Fix: use the real `--color-text-secondary` (or define the tertiary token).
File: client/src/components/DemoModeBanner.jsx lines 107-109

**[UX-8-9] MEDIUM: `AiDisclaimer` promises a `renewalBrief` variant that doesn't exist — callers silently get the wrong copy**
The component's own header documents a `renewalBrief` variant ("AI-generated negotiation/renewal summary… stronger downstream-authority pointer"), but the `VARIANTS` map only defines `extract`, `maintenanceBrief`, and `ask`. Any `<AiDisclaimer variant="renewalBrief">` falls through `VARIANTS[variant] || VARIANTS.extract` and silently shows the generic "verify each field before approving" text on a renewal brief — wrong, misleading legal-ish copy. The component also hardcodes `#fde68a` and `#dde2eb` borders instead of tokens. Fix: add the `renewalBrief` variant (or remove it from the doc) and tokenize the borders.
File: client/src/components/AiDisclaimer.jsx lines 11-13, 37, 45, 51-70

**[UX-8-10] MEDIUM: Inconsistent brand treatment across adjacent auth pages — text wordmark vs. SVG BrandMark**
`SsoCallback.jsx` renders `<BrandMark size={40} />` (the real SVG logo), but `ForgotPassword.jsx` (and the other `login-page` screens) render a plain text `<div className="login-logo-name">ServiceCycle</div>`. A buyer clicking from SSO to "forgot password" sees the logo change from a real mark to flat text. Fix: standardize all auth screens on `<BrandMark>`.
File: client/src/pages/ForgotPassword.jsx lines 30-32; client/src/pages/SsoCallback.jsx lines 45-47

**[UX-8-11] MEDIUM: Raw axios error strings can surface to users as "Network Error" / "Request failed with status code 500"**
Several catch blocks fall back to the raw axios `e.message` when the server doesn't return a `.response.data.error`, which renders unfriendly junk: `FleetDashboard.jsx:743` (`e.response?.data?.error ?? e.message`), `AdminMetrics.jsx:32` (`… || e.message || …`), `useAiUsage.js:47` (`e?.response?.data?.error || e.message`). On a flaky-network demo the OEM dashboard would print "Network Error" verbatim. Fix: replace the `e.message` tail with a friendly generic ("Couldn't load the fleet dashboard. Please retry.").
File: client/src/pages/FleetDashboard.jsx line 743; client/src/pages/AdminMetrics.jsx line 32; client/src/hooks/useAiUsage.js line 47

**[UX-8-12] MEDIUM: Date formatting is browser-locale-dependent and inconsistent across the app**
Dates are rendered with bare `new Date(x).toLocaleDateString()` (no locale/options arg) in 27 page files and several components, so the same date shows `6/26/2026` for a US viewer and `26/06/2026` for an en-GB viewer — and the format differs page-to-page depending on whether a given call passed options. There's no shared `formatDate()` util. On a shared demo the inconsistency is visible (e.g. arc-flash study date vs. work-order date). Fix: centralize a `formatDate`/`formatDateTime` helper with an explicit format and replace the bare calls.
File: client/src/pages/PublicArcFlashLabel.jsx line 9; client/src/components/StudyAssetBinding.jsx line 104; client/src/pages/AssetDetail.jsx (3 occurrences); client/src/pages/Dashboard.jsx (3 occurrences)

**[UX-8-13] MEDIUM: NameplateCard / NameplateReview hardcode `#e5e7eb` borders instead of `--color-border`**
The nameplate capture surfaces (a hero "easy-button" AI flow shown in demos) draw photo and container borders with literal `#e5e7eb` rather than `var(--color-border)`. In dark mode `#e5e7eb` is a bright near-white hairline on a dark card — visibly wrong against every other bordered element on the page, which correctly tokenize. Fix: swap to `var(--color-border)`.
File: client/src/components/NameplateCard.jsx line 86; client/src/components/NameplateReview.jsx lines 140, 156

**[UX-8-14] LOW: Toast is single-slot — a second notification silently destroys the first before it can be read**
`Toast.jsx` is explicitly a "Single-toast model (NOT a stack) — calling setToast(...) again replaces whatever's currently showing." During a demo where two background events fire close together (e.g. "Draft saved" then "Export ready"), the first toast vanishes mid-read with no trace. The default `duration` is also 8000ms with no progress affordance. Fix: queue toasts (or at minimum let an in-flight toast finish) so transient confirmations aren't swallowed.
File: client/src/components/Toast.jsx lines 8-11, 62-71

---
