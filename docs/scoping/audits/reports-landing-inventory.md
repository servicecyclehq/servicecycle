# Reports/Dashboard Surfaces Inventory

Date: 2026-07-05
Scope: Inventory of existing reporting/dashboard surfaces + buildability scoping for 8 candidate new backend report endpoints. Documentation only -- no source files modified, no routes built.

Repo root: `C:\Users\ddeni\Desktop\ServiceCycle`

---

## 1. Existing surfaces inventory

| Surface | Route file(s) | Client file(s) | Backing models/notes |
|---|---|---|---|
| `/reports/arc-flash` | `server\routes\arcFlashIngest.ts` -- `GET /api/arc-flash/report` (mounted at `/api/arc-flash` in `server\index.ts:1366`, handler ~line 1534, gated `requireManager`) | `client\src\pages\ArcFlashReport.jsx` (client route `/reports/arc-flash` registered in `App.jsx` ~465-469) | `SystemStudyAsset.findMany` (filtered on `study: { supersededById: null }` for "current" studies), `SystemStudy`, `ProtectiveDevice`, `DeviceTestRecord`. **Model is named `SystemStudy`, not `ArcFlashStudy`** -- a schema comment (schema.prisma ~line 1292) confirms it was renamed 2026-06-07 to generalize across 4 study types (`arc_flash` / `short_circuit` / `coordination` / `one_line_review`). |
| `/installed-base` | `server\routes\installedBase.ts` -- `GET /benchmarks`, `GET /benchmarks/:assetId`, `GET /modernization-pipeline`, `GET /attach-rate` (mounted at `/api/installed-base`, `server\index.ts:1544`) | `client\src\pages\InstalledBasePage.jsx` (route `/installed-base`, `App.jsx` ~376-380) | Computation logic lives in `server\lib\installedBaseIntel.ts`. Percentile benchmarks come from `TestMeasurement.findMany` (`asFoundValue`/`asFoundUnit`/`measurementType`). Watch/Plan/Act pipeline comes from `Asset.findMany` (`manufacturer`, `installDate`, `governingCondition`, `endOfSupport`, `obsolescenceStatus`, `modernizationRiskScore`, `repairCostEstimate`, `spareLeadTimeWeeks`, `redundancyStatus`, `criticalityScore`). Attach-rate funnel comes from `Deficiency` + `QuoteRequest`. |
| `/sales` dashboard | `server\routes\sales.ts` -- `GET /rollup`, `GET /reps`, `POST /reassign` (mounted `/api/sales`, `server\index.ts:1514`) | `client\src\pages\SalesRollup.jsx` (route `/sales`, `App.jsx` ~384-388) | `Account.findMany`, `User.findMany`, `Deficiency.groupBy`, `WorkOrder.groupBy`, `MaintenanceSchedule.groupBy`, `Asset.groupBy`. |
| Monthly digest + customer digest email | Cron registered in `server\index.ts:1851` (`15 7 * * *`) -> `runMonthlyDigest()` in `server\lib\monthlyDigest.ts` | N/A -- email output, not a page | Pulls from `buildComplianceGap` / `buildComplianceByCustomer` / `buildComplianceBySite` (all in `server\lib\complianceReport.ts`), plus XLSX rendering via `buildDigestXlsxBuffer` / `buildCustomerXlsxBuffer` in `server\lib\digestExcel.ts`. Underlying models: `MaintenanceSchedule`, `Account`, `AlertPreference`, `Deficiency`, `WorkOrder`, `BlackoutWindow`, `User`. **Note:** the older standalone weekly customer-digest cron has been folded into this same engine (`index.ts` ~2506-2512); `server\lib\customerDigest.ts`'s `runCustomerDigestCron()` still exists in the codebase but is only reachable via a preview endpoint -- it is not on a live schedule. |
| 5 configurable alert types | Prisma `enum AlertType` (`schema.prisma` ~161-170, actually enumerates 8 values, of which 5 are the "configurable" set called out in memory). Generators: `server\lib\assetAlertNotifier.ts` (condition_degradation, asset_decommission), `server\lib\deficiencyAlerts.ts` (deficiency_alert; cron `0 8 * * *`), `server\lib\arcFlashIntegrity.ts` (arc_flash_expiry; cron `30 9 * * *`), `server\lib\alertEngine.ts` (overdue / maintenance_due / escalation / regulatory_breach; cron `0 7 * * *`) | N/A | `Alert` model (schema.prisma ~1780-1806), `AlertPreference` (~1808-1824, `@@unique([userId, alertType])`). Underlying source data: `Asset`, `Deficiency`, `SystemStudy` / `SystemStudyAsset`, `MaintenanceSchedule`, `NotificationLog`. |

All 5 surfaces confirmed present and live in the current codebase.

---

## 2. Schema reference (`server\prisma\schema.prisma`, ~3429 lines)

Key models and their relevant fields (exact names as found):

- **Asset** (~790-923): `id, accountId, siteId, equipmentType, manufacturer?, model?, serialNumber?, nameplateData(Json?), installDate?, lastCommissionedDate?, conditionPhysical/conditionCriticality/conditionEnvironment(ConditionRating), governingCondition, criticalityScore?, conditionScore?, priorityScore?, repairCostEstimate(Decimal 14,2), spareLeadTimeWeeks?, redundancyStatus?, requiresPredictiveMaintenance, inService, isEnergized, archivedAt?, endOfManufacture?, endOfSupport?, obsolescenceStatus?, criticalSparesAvailable?, sparePartsLeadTimeDays?, replacementCostCents?, modernizationRiskScore(Float?), createdAt, updatedAt`.
  - **No NETA-class field anywhere on Asset or elsewhere in the schema.**
  - `modernizationRiskScore` is the closest existing stored "RUL-like" artifact (computed daily by `computeModernizationRiskScore()` in `server\lib\modernizationAlerts.ts`).

- **WorkOrder** (~1046-1128): `id, accountId, scheduleId?, assetId, status(WorkOrderStatus), scheduledDate?, startedAt?, completedDate?, workOrderType, laborHours(Decimal 6,2)?, laborCostCents(Int?), netaCertLevel?, reportPdfUrl?, ...`.
  - **No dedicated `dueDate` field** -- `scheduledDate` is the closest analog.
  - **No generic estimated-cost field** -- only post-hoc `laborCostCents` (actual, not estimate) and, via `WorkOrderPartUsage.unitCostCents`, post-hoc parts cost.
  - No direct Site foreign key -- Site is reached transitively via `asset.siteId`.

- **Deficiency** (~1173-1197): `id, accountId, workOrderId?, assetId, severity(DeficiencySeverity: IMMEDIATE|RECOMMENDED|ADVISORY), description, correctiveAction?, resolvedAt?, resolvedById?, createdAt, updatedAt`.
  - Purpose-built index already exists: `@@index([accountId, severity, resolvedAt])`.
  - No direct Site FK -- via `asset.siteId`.

- **SystemStudy** (renamed from ArcFlashStudy; ~1296-1329): `id, accountId, siteId, studyType(String), performedDate, expiresAt, performedBy?, method?, peName?, peLicense?, trigger?, reportPdfUrl?, supersededById?(self-relation), createdAt, updatedAt`. Has a direct Site relation.

- **SystemStudyAsset** (~1338-1415): `id, accountId, studyId, assetId, busName?, ppeCategory?, incidentEnergyCalCm2?, arcFlashBoundaryIn?, requiredArcRatingCalCm2, ...` (plus IEEE 1584-2018 calculation inputs). `@@unique([studyId, assetId])`. Expiry is tracked per-study (`SystemStudy.expiresAt`), not per-asset.

- **Site** (~681-718): `id, accountId, name, address?, city?, state?, postalCode?, oneLineDiagramOnFile, oneLineDiagramDate?, archivedAt?, ...`.

- **TestMeasurement** (~1133-1167 -- this is the pass/fail model; there is no model literally named "TestReport"): `id, accountId, workOrderId, measurementType(String, free-text), phase?(String, free-text), asFoundValue(Decimal 16,4)?, asFoundUnit?, asLeftValue?, asLeftUnit?, passFail(ResultRating: GREEN|YELLOW|RED)?, expectedRange?(narrative text, not structured), createdAt, updatedAt, deletedAt`.
  - No direct Site relation -- reached via `workOrder.asset.siteId`.

- **NFPA 70B / RUL / compliance state:** There is no stored "compliance state" column anywhere. It is always computed at request time in `server\lib\complianceReport.ts` (`buildComplianceGap`, `buildStandardsSummary`, `buildOverdueReport`) by comparing `MaintenanceSchedule.nextDueDate` / `isActive` against the current time (rank order: overdue=0, current=1, unbaselined=2, inactive=3). `MaintenanceTaskDefinition` (~962-996) stores the NFPA 70B interval matrix (`intervalC1Months / intervalC2Months / intervalC3Months`). The interval math itself is implemented as pure functions in `server\lib\maintenanceInterval.ts` (`effectiveCondition`, `worstCondition`, `intervalMonthsFor`, `computeNextDueDate`, `recomputeScheduleDates`), and is covered by `server\tests\maintenanceInterval.test.js`.

---

## 3. Candidate new reports

| Report | Backing models/fields (exact) | Query vs Model task | Complexity | Notes |
|---|---|---|---|---|
| 1. Overdue Work Orders by Site | `WorkOrder.status`, `WorkOrder.scheduledDate` (no dedicated `dueDate`); Site reached via `asset.siteId` | Query task | Simple | Direct precedent already exists: `sales.ts` uses `workOrder.groupBy`, and `complianceReport.ts` already has a `bySite` grouping pattern to copy. |
| 2. Failed-Test Recap (30/90/365d) | `TestMeasurement.passFail` (GREEN/YELLOW/RED), `TestMeasurement.createdAt` | Query task | Simple-medium | Simple for a flat count; medium if also grouping by the free-text `measurementType`/`phase` fields (no enum, so grouping requires string handling). |
| 3. Deficiency Summary by Severity x Site | `Deficiency.severity`, Site via `asset.siteId` | Query task | Simple | The exact index needed already exists: `@@index([accountId, severity, resolvedAt])`. |
| 4. Arc-Flash Coverage (assets with vs without current study, by site) | `Asset.studyAssets -> SystemStudyAsset -> SystemStudy` (`studyType`, `expiresAt`, `supersededById`) | Query task | Medium | The "current study" filter pattern (`study: { supersededById: null }`) is already used in `arcFlashIngest.ts` ~line 1539. The added complexity is the anti-join needed to find assets with ZERO current studies -- Prisma doesn't do this natively, so it needs either raw SQL or a fetch-all-assets-then-diff-in-JS approach. |
| 5. Installed-Base Age by OEM | `Asset.manufacturer`, `Asset.installDate` -- already fetched by the existing `modernization-pipeline` query in `installedBaseIntel.ts` | Query task | Simple | Roughly 90% of the plumbing already exists; this is primarily a re-aggregation by `manufacturer` instead of by individual asset. |
| 6. Deferred Maintenance $ Estimate (sum estimatedCost on overdue WOs) | **No `estimatedCost` / `cost` / `price` field exists on `WorkOrder`.** Only post-hoc actuals exist (`laborCostCents`, `WorkOrderPartUsage.unitCostCents`). The closest existing estimate field is `Asset.repairCostEstimate`, which is asset-level, not per-work-order. | Model task (true version) / Query task (proxy version) | Complex (true) / Simple (proxy) | A literal implementation needs a new `WorkOrder` field + migration + a decision on backfill for historical WOs. A proxy version -- summing `Asset.repairCostEstimate` across assets tied to overdue `MaintenanceSchedule`s -- is buildable today with existing fields but changes the semantics from "cost of the deferred work order" to "replacement cost of the deferred asset." Must be scoped explicitly before promising either version. |
| 7. Compliance Status by NETA Class | **No "NETA Class" field or enum exists anywhere in the schema.** (`WorkOrder.netaCertLevel` is a technician/person certification concept, not an asset classification -- it does not answer this question.) The compliance-state computation itself already exists and is simple (`complianceReport.ts`), but there is no NETA-class dimension to group by. | Model task | Complex | This cannot be built as literally specified without a schema/modeling decision. The nearest usable substitute today is grouping by `Asset.equipmentType` (a real, populated enum with ~26 values), which is a materially different axis than "NETA Class" and should not be silently substituted without flagging it to stakeholders. |
| 8. Asset RUL Watchlist (assets nearing end of NFPA 70B interval) | `Asset.modernizationRiskScore` (stored score from `modernizationAlerts.ts`) OR `MaintenanceSchedule.nextDueDate` proximity (via `maintenanceInterval.ts` / `alertEngine.ts` tiering logic) | Query task | Simple | Two independent, already-computed notions of "RUL" both satisfy this report without any new fields -- either is a straightforward query/sort against existing data. |

---

## 4. Recommendation

Priority order for a backend-only API build pass (easiest / highest-value-per-effort first):

1. **Deficiency Summary by Severity x Site** -- a purpose-built DB index already exists for exactly this access pattern; simplest possible win with immediate ops-triage value.
2. **Overdue Work Orders by Site** -- every field needed already exists, and a direct implementation precedent is already in the codebase (`sales.ts`, `complianceReport.ts`); trivial lift.
3. **Failed-Test Recap** -- `passFail` + `createdAt` map directly onto the ask; only mild complexity if the response also needs to break out by measurement type.
4. **Installed-Base Age by OEM** -- nearly free to add; the underlying data is already being fetched by an existing endpoint, so this is a re-aggregation, not new data plumbing.
5. **Asset RUL Watchlist** -- two already-computed fields (`modernizationRiskScore`, or `nextDueDate` proximity) directly satisfy the ask; this just needs a report-shaped endpoint wrapping existing service logic.
6. **Arc-Flash Coverage by Site** -- all relations and the "current study" concept already exist and are already queried elsewhere in the codebase, but the "assets with zero coverage" anti-join adds real query complexity (raw SQL or fetch-and-diff in application code).
7. **Deferred Maintenance $ Estimate** -- only buildable today as an explicit semantic compromise (sum `Asset.repairCostEstimate` for assets tied to overdue schedules, not true per-work-order estimated cost); a literal implementation requires a schema migration. Scope the compromise explicitly with stakeholders before building.
8. **Compliance Status by NETA Class** -- cannot be built as literally specified; no NETA-class field or enum exists anywhere in the schema. Lowest priority for a backend-only pass because it blocks on a modeling/product decision (introduce a real NETA-class field, or officially substitute `equipmentType` as the grouping dimension) rather than on query work. Should be a design conversation before any endpoint code is written.

---

*No source files were modified. No routes were created. No git commands were run. This document is inventory/scoping only.*
