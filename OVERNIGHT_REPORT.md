# Overnight Arc-Flash Build — Morning Report (2026-06-21 → 06-22)

## TL;DR
Shipped + deployed **Slice 2.7 (field-collection + photo-read) end-to-end**, plus the **arc-flash dashboard surfacing card**, plus the **extraction accuracy harness**. Everything is green (arc-flash suite **57/57**, `tsc` clean, client build clean) and live on servicecycle.app behind the existing `arc_flash_studies` UI gate. I stopped before Slices 2.8 / 3 / 3.5 / 4 (the larger remaining slices) — clear next step at the bottom. No destructive ops; demo untouched; only the ServiceCycle repo touched.

Starting point was `12162ea` (Slice 2.6 + pdfplumber perf). All work is on `main`, fast-forwarded, no parallel-session conflicts.

## What shipped + deployed

**0. Extraction accuracy harness — `b901ea8`** (committed; dev script, not deployed)
- `server/scripts/af-accuracy.ts` — runs the REAL pipeline (text path + forced rasterized-vision) + the gap engine over the local sample PDFs and dumps a per-file readout. Dual-purpose: always runs the deterministic probe; runs the AI extract when a key is present.
- Ran the deterministic probe on all 6 samples (pdfplumber + pypdfium2). Findings in `OVERNIGHT_SAMPLES_ACCURACY.md`: both real study reports are text-extractable (Brady 41.6k chars; e-Hazard 53k chars / 25 tables / 381 rows with a clean per-bus IE table); one EasyPower PDF is vision-only (0 text); the rest are reference docs.
- The AI bus/gap pass was **not** run (no local AI key — see Needs Dustin). Sample PDFs kept OUT of git.

**1. Slice 2.7 backend — `47acd74` (schema), `4dc86a9` (manager surface), `f75f60d` (field surface)** — DEPLOYED
- Models (migration `20260621120000`, additive, applied local + prod): `ProtectiveDevice` (durable collected device; frame/sensor + LSIG/fuse settings; versioned via `supersededById`) and `ArcFlashCollectionTask` (generated from blocked buses; carries PPE/outage/qualified-person sequencing). Scalar FKs only → pure-append schema edit.
- `lib/arcFlashDevice.ts`: `buildCollectionTasks` (gap punch-list → tasks), `extractDeviceFromPhoto` (vision → device draft), `deviceToBusFields`, `regapIngestBusAfterDevice` (apply collected device → re-gap the bus → re-roll ingest summary).
- `/api/arc-flash` (manager+): `POST /ingest/:id/collection-tasks`, `GET /collection-tasks`, `PATCH /collection-tasks/:id`, `POST /devices`, `GET /devices`, `POST /devices/:id/supersede`, `POST /photo-read`.
- `/api/field/arc-flash` (field_tech-scoped, manager+ account-wide): `GET /tasks`, `POST /tasks/:id/collect` (creates the device, marks the task collected, re-gaps the linked ingest bus → a blocked bus moves toward ready).
- Verified live: health=200; `/api/arc-flash/collection-tasks` and `/api/field/arc-flash/tasks` return 401 unauth (mounted); migration applied on prod.

**2. Slice 2.7 UI — `a136405`** — DEPLOYED (client published)
- "Field collection" section in `ArcFlashIngestPanel`: "Generate field tasks from gaps" button; per-task DANGER/WARNING badge + outage / qualified-person flags + instructions + conservative PPE note; inline "Record device" form (type / sensor rating / trip-settings JSON / cable) and a **Photo-read** button that pre-fills the form from a breaker/fuse photo; save → bus re-gaps in place.

**3. Surfacing — dashboard card — `934b695`** — DEPLOYING (server + client at end of run)
- `GET /api/arc-flash/dashboard`: DANGER buses (>40 cal/cm² OR >600 V), studies expiring within 90 days, blocked buses still needing data, open field-collection tasks, and a top-danger list.
- `ArcFlashDashboardCard.jsx` mounted on the Dashboard; **self-hides when every count is zero** (so lean/non-arc-flash accounts never see it — no feature-flag wiring needed).

## Behind flags / ships-dark
- All new arc-flash UI sits under the existing `arc_flash_studies` UI gate (Riverside demo = ON). The dashboard card additionally self-hides on zero data.
- `photo-read` needs `AI_ENABLED` + a provider key (droplet has them; reuses the same cascade keys as ingest). Locally `AI_ENABLED=false` → returns 503 by design.

## Decisions made autonomously (worth a sanity-check)
1. **New model over WorkOrder.** WorkOrder requires a non-null `assetId` and is NETA-test-shaped; collection tasks target blocked buses that aren't assets yet → new `ArcFlashCollectionTask`. (Prompt explicitly allowed this.)
2. **No server-side feature gate on the new routes** — matched the existing arc-flash ingest routes (UI-gated + `requireManager`). If you'd prefer defense-in-depth, add a `requireFeature('arc_flash_studies')` across ALL arc-flash routes in one pass (noted as a follow-up).
3. **DANGER = >40 cal/cm² OR >600 V** (NFPA 70E label definition) for the dashboard metric.
4. **Field endpoints under `/api/field`** because `field_tech` is default-deny everywhere else; managers can use them too (desktop field mode).
5. **photo-read uses a lighter AI gate** (`AI_ENABLED` + `requireManager`) than `assetPhotoInspect`'s full consent/quota/budget stack — flagged as a hardening follow-up so the field flow stays simple for now.

## Blocked / needs Dustin
- **Accuracy AI pass (5 min):** no provider key locally. Steps in `OVERNIGHT_SAMPLES_ACCURACY.md` — set `AI_ENABLED=true` + one key in `server/.env`, run `npx tsx scripts/af-accuracy.ts` from `server/`, eyeball the per-bus gap output vs the PDFs. (The samples can't be pushed to the droplet — binaries, and cp is MCP-blocked — so this runs best on your machine where the PDFs live.) Deep prompt/normalizer tuning is a together-task.
- **Demo card visibility:** the dashboard card self-hides unless there's arc-flash data. Riverside's demo studies are MV (>600 V), so DANGER buses should be > 0 and the card should appear. If it doesn't show, confirm the demo account has bound study-assets (I did NOT touch/reseed the demo, per the safety rails).

## Where I stopped + single next step
Stopped after the dashboard surfacing card. **NEXT STEP:** add the per-asset "Arc Flash" section on `AssetDetail` (label data + DANGER status + study coverage + this asset's collection tasks, next to the existing `ArcFlashTrend` card). NOTE: `AssetDetail.jsx` is large — use a careful splice/anchored edit and re-build to avoid the Edit-truncation gotcha. After that: Slice 2.8 (readiness scoring + change→re-study), Slice 3 (fleet dashboard + printable report + insurer pkg), Slice 3.5 (SKM export + results import + label lifecycle), Slice 4 (incident-energy-reduction upsell).

## Health / suite (final)
- Arc-flash suite: **57/57**; `tsc` clean; client build clean.
- Prod after the 2.7 deploy: health=200; new routes 401 unauth; migration `20260621120000` applied.
- Final surfacing deploy: server rebuilt (job success, 78s) + health=200 + `/api/arc-flash/dashboard`=401; client published (deploy success, 157s). **All 6 commits live on servicecycle.app.** Hard-refresh / clear the PWA service worker to see the new UI.

## Commit ledger (all on `main`, pushed + deployed)
- `b901ea8` af-accuracy harness (dev script)
- `47acd74` schema + migration 20260621120000 (ProtectiveDevice + ArcFlashCollectionTask)
- `4dc86a9` 2.7 manager surface (collection-tasks, device CRUD+versioning, photo-read)
- `f75f60d` 2.7 field-tech surface (/api/field/arc-flash collect + re-gap)
- `a136405` 2.7 UI (FieldCollection in ArcFlashIngestPanel)
- `934b695` surfacing (dashboard endpoint + ArcFlashDashboardCard)
