# Overnight Autonomous Build — ServiceCycle Arc Flash (Slices 2.7 → 4)

> Paste this whole file as the first message of a FRESH Cowork session to kick off the overnight run.
> (Fresh context = more headroom for a long autonomous session.) This file is a scratch doc — do NOT commit it.

You are resuming the **ServiceCycle arc-flash build** (the hero feature). Dustin is asleep. Run **autonomously, safely, and back-to-back**, and leave a clear morning report. **Do NOT ask questions** — make reasonable, reversible decisions, document them, and keep moving. When in doubt, choose the safe/reversible option and flag it for the morning.

---

## STEP 0 — Orient before touching anything (do this first, every time)

1. **Read these memory files** (authoritative — they hold state, gotchas, conventions):
   - `servicecycle-arc-flash-build.md` — THE arc-flash thread: full state, the roadmap, every gotcha. START HERE.
   - `servicecycle-deploy-via-mcp.md` — exactly how to deploy.
   - `MEMORY.md` (index), `feedback_parallel_sessions.md`, `feedback_file_writes.md`, `servicecycle-vps-mcp-limits.md`.
2. **Verify git state** — I run PARALLEL sessions; never rebuild shipped work:
   `cd C:\Users\ddeni\Desktop\ServiceCycle && git fetch origin && git log origin/main --oneline -15`
   At handoff, the latest arc-flash commit is **c1084cc** (Slice 2.6). If `origin/main` is ahead, read the new commits before building. Make local `main` == `origin/main` before starting.

## CURRENT STATE (all shipped + LIVE on servicecycle.app)
- **Slice 1** — per-bus IEEE 1584 inputs, DANGER class, per-asset trend card.
- **Slice 2** — upload one-line/study → extract (**deterministic-first**: pdfplumber text+tables via `lib/pdfText.ts` → AI structuring; pdfjs fallback; **vision only when there is NO text layer**, so no vision tokens are spent on text studies; scanned/vector PDFs auto-rasterize via `pypdfium2`) → IEEE 1584 gap punch-list → review → confirm (creates assets + optional study). UI = `ArcFlashIngestPanel` on **SiteDetail → System Studies card** (gated by `arc_flash_studies` flag).
- **Slice 2.6** — device ratings+settings + feeder cable modeled; gap engine reworked to how studies are ACTUALLY collected: 3 composite must-obtains = system voltage; fault current (value OR feeder cable length+size); upstream device (type+rating+settings OR explicit clearing time). Typicals (electrode/gap/working-distance) IEEE-defaulted. `analyzeSystemGaps` for utility max/min + X/R at the PCC.
- Demo reseeded clean; DANGER trend on Riverside `SWGR-1A-1`.
- **Real sample studies are downloaded** at `C:\Users\ddeni\Desktop\ServiceCycle\Arc Flash Samples\` (6 PDFs: `Arc_Flash_Risk_Assessment_Sample_Report.pdf` = Brady 21pp, and `Arc-Flash-Study-Report-Example.pdf` = e-Hazard — both text-extractable study reports; the rest are EasyPower/NTT references). Use them for the accuracy pass below. **Keep them OUT of git** (binaries).

---

## THE WORK — build in this order (front-loads VISIBLE value; Dustin's #1 gripe is the feature is buried)

For EACH slice: design → additive migration (if needed) → code → tests → `tsc` clean → arc-flash suite GREEN → commit → deploy → verify → update the `servicecycle-arc-flash-build.md` memory → next. Ship behind the `arc_flash_studies` flag. Reuse existing code (named below) — do not reinvent.

### 0. Extraction accuracy pass against the real samples (do FIRST, time-boxed ~30 min)
Better extraction helps every slice, and we now have real study PDFs at `C:\Users\ddeni\Desktop\ServiceCycle\Arc Flash Samples\`.
- Write `server/scripts/af-accuracy.ts`: for each sample, run the REAL pipeline — `extractArcFlashDocument` (real `ai` cascade) on the full PDF (text path) AND on a rasterized one-line page (vision path, via `lib/rasterizePdf`) — then `analyzeBusGaps` per bus. Dump a readable `C:\Users\ddeni\Desktop\ServiceCycle\OVERNIGHT_SAMPLES_ACCURACY.md`: per file → method, # buses, the extracted system model, and the gap punch-list.
- Run it where the AI keys are: check `server/.env` for a usable cascade key (grep `GROQ_|GEMINI_|ANTHROPIC_|AI_API_KEY` — do NOT print values). If present → `npx tsx scripts/af-accuracy.ts` locally. If NOT local, the keys are on the droplet → note in the report that the pass should run there or interactively with Dustin, and move on (don't block).
- If the readout shows an OBVIOUS, safe miss (e.g. a field the model clearly returned that the normalizer dropped), fix it (small, tested, green, commit). DEEP prompt tuning + ground-truth comparison is a morning-with-Dustin item — don't rabbit-hole.
- Do NOT commit the sample PDFs or any extracted content to git.

### 1. Slice 2.7 — Field-collection module + photo-read (HIGHEST VALUE / the moat)
- **Durable `ProtectiveDevice` model** (additive migration, scalar FKs, no big-model edits): accountId, siteId, assetId?, label, deviceType, manufacturer, model, partNumber, frameRatingA, sensorRatingA, settings(Json), settingsCollectedAt, collectedById, photoKey, supersededById (versioning), timestamps + indexes.
- **Field-collection tasks from the gap punch-list**: for an ingest's blocked buses, generate "open panel X → record device type/rating/trip settings + feeder cable length/size" tasks. FIRST check `WorkOrder` (schema + `server/routes/workOrders*`) — reuse it with a type/category if it fits; else a small new model. Route under `/api/arc-flash`.
- **Photo-read device settings** (the killer easy-button): reuse `server/routes/assetPhotoInspect.ts` + `lib/ai.completeWithImage` to read a breaker trip-unit / fuse photo into structured `deviceSettings`. New endpoint: POST multipart → vision → returns a parsed device+settings draft for review. **Mock `ai` in tests.**
- **Safety sequencing** (your brother would insist): the collection task carries a conservative/existing PPE level (from the bus's current label `hazardClass` or a default), references outage windows (`BlackoutWindow` model exists), and requires a qualified person (`accountFeatures.qemw_wallet` + contractorTech QEMW fields). Wire the references/flags; don't over-build.
- **UI**: richer device entry in `ArcFlashIngestPanel` (let the reviewer enter deviceType/rating/settings/cable inline → re-gap); a field-mode collection screen + device-photo capture (check the existing field-capture / `field_tech` UI — voice/QR capture already exists).
- **AI keys ARE set** — the droplet has the 2–3 cascade provider keys (same providers, same free budget), so field-mode photo-read + extraction reuse `ai.completeWithImage` / `ai.complete` directly. No new key, nothing to flag. Still **mock `ai` in unit tests**.

### 2. Surfacing pass (pull part of Slice 3 forward so it's VISIBLE by morning)
- **Per-asset "Arc Flash" tab/section** on `AssetDetail`: label data + DANGER status + IEEE 1584 inputs + study coverage + the existing `ArcFlashTrend` card + print-label. Gated by `arc_flash_studies`.
- **Dashboard card** for arc-flash issues: DANGER buses, studies expiring, blocked buses needing data, collection tasks due. Check the dashboard route/components.

### 3. Slice 2.8 — Readiness scoring + change → re-study
- Per-site/fleet **study-readiness score** (% must-obtains collected across buses + what's missing); surface on dashboard + per-asset tab.
- **Versioning + change detection**: compare a new one-line ingest's buses vs the prior confirmed revision; a MATERIAL change (added/removed bus, changed voltage/fault/device-settings/topology) → re-study recommendation flag + a trigger (reuse the `arcFlashIntegrity.ts` quote pattern). Folds in the old "Slice 2.5 one-line diff."

### 4. Slice 3 — Finish surfacing
- Fleet arc-flash dashboard; **printable arc-flash report** in Reports (check `server/routes/reports*` + `ReportsHub.jsx`); easy-button summary; insurer/auditor package section (check the insurer-package / compliance-snapshot code).

### 5. Slice 3.5 — Close the loop
- **SKM/EasyPower export** of the collected model (structured CSV/JSON). **Import stamped study results** (extend the study-report ingest). **Label lifecycle**: generate from results, reprint-on-re-study, **stale-label detection** (there's already label-data + print + an audit-rec about superseded labels in the demo).

### 6. Slice 4 — Incident-energy-reduction upsell
- DANGER bus → recommend a trip-setting change / maintenance-mode switch → quote. Reuse `QuoteRequest` + the revenue-attribution engine.

---

## SAFETY RAILS (non-negotiable)
- **Work ONLY in the ServiceCycle repo.** Never touch LapseIQ or ForgeRift.
- **Additive Prisma migrations only.** No drops/renames/destructive changes. New timestamp AFTER the latest (handoff latest = `20260621110000`). Apply to LOCAL `localhost:5432/servicecycle_dev` first.
- **Never deploy a red build.** Before EVERY deploy: `npx tsc --noEmit` (0 errors) AND `npx jest arcFlash --runInBand` (all green). If red, fix or revert — never ship red.
- **Never run destructive ops on prod.** The demo is already clean — do NOT reseed/wipe it. No `docker compose down -v`, no prod data deletes.
- **Big files** (`schema.prisma` ~2900 lines, `seed-demo.js`): targeted unique-anchor edits ONLY; run `npx prisma validate` after schema edits. NEVER full-file rewrite them.
- **Parallel-session hygiene**: `git pull --rebase origin main` before every push; commit SPECIFIC files (never `git add -A`; never commit this prompt, `OVERNIGHT_REPORT.md`, or `server/_*.txt` scratch). Serialize deploys — one at a time; verify no mid-flight parallel deploy first.
- **Ship dark / behind flags** where risky, so a half-finished piece never breaks the live demo. Reversible > clever.
- **Verify every write**: a write isn't done until a build/test/diff confirms it.

## THE DEPLOY LOOP (exact — via the ServiceCycle vps-control MCP, the `29075510…` connector)
1. Push: windows-shell `git push origin main` (after `git pull --rebase`).
2. MCP `git_pull` (dry_run:true, then dry_run:false).
3. MCP `run_approved_command`: `docker compose -f /root/ServiceCycle/docker-compose.yml up -d --build server` with `run_in_background:true`; poll `get_job_status`. (Build ~60–150s on the 2GB box; output is head-truncated — confirm via Status:success, not the tail.)
4. Verify: MCP `docker logs --tail 10 servicecycle-migrate` (new migration applied) + `curl -sS -o /dev/null -w "health=%{http_code}" http://127.0.0.1:3002/api/health` (expect 200) + new route returns 401 unauth (mounted).
5. Client (if UI changed): MCP `deploy_client` (dry_run:true,confirm:true → then dry_run:false,confirm:true); poll `get_deploy_status`.

## MCP / TOOLING GOTCHAS (learned the hard way)
- PowerShell `Select-String` patterns: **ASCII only** — unicode (checkmarks, em-dashes, bullets) breaks the parser.
- Seed/scripts that `require` a `.ts` lib must run via tsx: `docker exec servicecycle-server node node_modules/tsx/dist/cli.mjs scripts/<x>.js` (plain `node` fails on `.ts` imports). Scripts importing only npm packages run with plain `node`.
- Inline `python3 -c "..."` is MCP-BLOCKED (code-exec). Run committed `.py` files instead.
- `docker cp` and host `cp` are MCP-BLOCKED; `docker compose exec` HANGS — use plain `docker exec`. To get a new script into the container, a server rebuild bakes it in (source is COPY-at-build).
- The vps MCP L3 safety board is ON and returns "PROCEED WITH CAUTION" on rebuilds — that's expected, not a block.

## DO NOT
- Ask blocking questions (no one's awake) — decide, document, proceed.
- Deploy with a failing `tsc` or arc-flash suite.
- Reseed/wipe the demo, or any destructive prod op.
- Touch LapseIQ / ForgeRift.
- Full-file-rewrite `schema.prisma` or `seed-demo.js`.
- Make changes that REQUIRE Dustin's terminal / external accounts — build behind a flag, mock in tests, and FLAG it instead. (The AI cascade keys ARE set — reuse them; not a blocker.)
- Rabbit-hole. Prefer many small SHIPPED+GREEN pieces over one big unshipped one. If a slice stalls, ship the coherent part behind a flag (green), note it, move on.

## MORNING REPORT (leave this for Dustin)
At the end (or if you run low on context/time), write **`C:\Users\ddeni\Desktop\ServiceCycle\OVERNIGHT_REPORT.md`** (untracked) AND update `servicecycle-arc-flash-build.md`, covering:
- What shipped + deployed (per slice), with commit hashes + test counts.
- What's behind a flag / ships-dark.
- Anything BLOCKED or needing Dustin (e.g. sample studies for the accuracy pass — he's grabbing them tomorrow; any judgment calls deferred).
- Exactly where you stopped and the single next step.
- Any decisions you made autonomously that he should sanity-check.

Work the list top to bottom. Each slice: build → test → deploy → verify → memory → next. Go.
