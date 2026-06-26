# DEMO_LANDMINES_v3.md

**Generated:** 2026-06-26  
**Scan type:** 8-agent adversarial audit — all-new personas vs. v2  
**Total findings:** 105 across 8 categories  
**Status:** All v2 findings (S1-S5, D1-D5, SEC1-SEC6, R1-R10, UX1-UX12, P1-P7, T1-T4, A5-A6/Q2) are NOT duplicated here — this is net-new only.

---

## Quick Severity Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| INS — Insurance/Risk Underwriter | 4 | 7 | 4 | 0 | 15 |
| ESP — Electrical Safety Program (NFPA 70E) | 1 | 5 | 6 | 0 | 12 |
| DB — Database Performance | 2 | 6 | 6 | 0 | 14 |
| LEG — Legal/Contract Counsel | 0 | 0 | 4 | 7 | 11 |
| UXR — UX Researcher (Onboarding/Cognitive Load) | 0 | 2 | 8 | 4 | 14 |
| INFRA — Cloud Architect | 2 | 5 | 5 | 1 | 13 |
| INT — Enterprise Integration Architect | 2 | 5 | 4 | 1 | 12 |
| PMF — Product-Market Fit / PE Due Diligence | 0 | 4 | 7 | 3 | 14 |
| **TOTAL** | **11** | **34** | **44** | **16** | **105** |

---

## INS — Insurance / Risk Underwriter

*Scope: Technology E&O / Cyber / Professional Liability exposure*

---

### [INS-1] CRITICAL — Placeholder Text Printed on Live Safety Label

**File:** `server/lib/arcFlashLabelDoc.ts`, line 143

When a study record is missing both `firmName` and `peName`, the generated label literally prints the string `Study by: [PE firm name — enter in study record]` as live label text. This is not a UI warning — it is baked into the PDF/label document and will appear on a physical label posted on energized equipment.

**Liability:** A worker sees a label with bracket placeholder text. If they interpret it as a draft/unchecked label and rely on the listed PPE category anyway, the label becomes Exhibit A in a negligence claim.

**Fix:** Block label generation entirely if `peName` and `firmName` are both absent. Surface a hard UI error: "PE attribution required before printing."

---

### [INS-2] CRITICAL — Disclaimer Claims Study Validity Was "Checked" — Overstates Scope

**File:** `server/lib/arcFlashPermit.ts`, line 98

The permit disclaimer begins: `"ServiceCycle pre-filled this permit from the current study and checked the study is valid."` The actual validation in `validatePermitIssuance()` (lines 37–46) checks only three structural conditions: no study bound, study superseded flag, and expiry date. It does NOT verify whether input data has drifted (load changes, relay setting changes, equipment modifications) — the most common real-world invalidation scenarios under NFPA 70E §130.5(G).

**Liability:** SC has made an affirmative representation of validity that it cannot substantiate. "ServiceCycle checked the study is valid" reads as a warranty.

**Fix:** Change to: *"ServiceCycle verified this study has not been superseded or expired by date. Operational validity must be confirmed by a qualified person under NFPA 70E §130.5(G)."* Remove the word "checked."

---

### [INS-3] CRITICAL — Notification Log Records "sent" Even When All Emails Fail

**File:** `server/lib/arcFlashIntegrity.ts`, lines 247–256

The email dispatch loop catches individual failures silently (`console.error` only). After the loop, `notificationLog.create()` is always called with `status: 'sent'` — even if every `sendEmail()` call threw. On the next cron run, the 30-day dedup check finds the `status: 'sent'` row and skips re-notification. The facility never receives the arc flash expiry warning, but SC's database records it as delivered.

**Liability:** SC's system records delivery; the customer testifies they received nothing; a worker enters a boundary without current PPE protection. SC cannot prove delivery because it never actually confirmed delivery. The audit log becomes the plaintiff's evidence.

**Fix:** `status: emailsSent > 0 ? 'sent' : 'failed'`. Add a retry job that picks up `status: 'failed'` rows. Do not create the log row before confirming at least one email succeeded.

---

### [INS-4] CRITICAL — Incident Register Schema Missing Mandatory NFPA 70E / OSHA Fields

**File:** `server/prisma/schema.prisma`, lines 1243–1263

The `IncidentLog` model has: `id`, `accountId`, `assetId`, `type` (enum), `occurredAt`, `note` (free text), `resolvedAt`, `resolvedById`, `createdById`. Missing structured fields:

- PPE worn at time of event (NFPA 70E §130.9)
- Personnel injured / involved (OSHA 300 log)
- Root cause classification (NFPA 70E §130.9)
- OSHA recordable flag (29 CFR 1904.7)
- Corrective action taken
- Witness list
- Photo evidence attachments

**Liability:** In discovery, opposing counsel requests SC's structured incident data. SC produces a `note` field. That looks like a system designed to avoid creating a paper trail.

**Fix:** Add a structured `IncidentLogDetails` JSONB column with typed fields for PPE worn, personnel count, OSHA recordable boolean, root cause enum, and corrective actions.

---

### [INS-5] HIGH — Incident Record Create/Patch Has No Audit Trail

**File:** `server/routes/assets.ts`, lines 1262–1311

Neither the incident creation nor patch endpoint calls `writeActivityLog()`. A manager can edit an incident note after the fact — changing the PPE description, who was present, root cause — with no before/after record.

**Liability:** Post-incident record alteration is one of the most common spoliation scenarios in workers' comp and OSHA litigation.

**Fix:** Call `writeActivityLog` with before/after diff on every `PATCH` to an incident record (pattern already exists in `workOrders.ts` lines 1012–1024).

---

### [INS-6] HIGH — Arc Flash Re-Study Trigger Relies on Free-Text Keyword Match

**File:** `server/lib/arcFlashIntegrity.ts`, lines 421–444

Path 3 alert — determining whether a deficiency triggers an arc flash re-study quote request — uses `contains` text matching on the free-text `description` field. A technician writing "breaker settings were off" instead of "breaker_calibration" silently misses the NFPA 70E §130.5(G) trigger.

**Fix:** Add a `deficiencyType` enum column to the `Deficiency` model (`RELAY_SETTINGS`, `BREAKER_CALIBRATION`, `PROTECTION_COORDINATION`, etc.). Match on enum values, not free text.

---

### [INS-7] HIGH — No Study Expiry Date on Printed Label

**File:** `server/lib/arcFlashLabelDoc.ts`, line 139

Label renders `studyDate` but no expiry date. The expiry date exists in the system but is not printed. A 2019 label in 2026 has no physical prompt that a 5-year re-evaluation is overdue.

**Fix:** Add `Study expiry:` line to label footer. If expiry is past, print `STUDY EXPIRED — DO NOT USE` in red.

---

### [INS-8] HIGH — Disclaimer on Printed Label Is 6pt Gray — Effectively Invisible

**File:** `server/lib/arcFlashLabelDoc.ts`, lines 146–147

The sole legal disclaimer is rendered at `fontSize: 6` in color `#94a3b8` (light gray). On a standard 4×6 thermal label in an industrial environment, this text is functionally invisible. A plaintiff's photographic exhibit of the label makes SC's "we disclaimed it" argument collapse.

**Fix:** Minimum 8pt disclaimer in dark text (`#374151` or black). Abbreviate if needed, but keep legible.

---

### [INS-9] HIGH — Mitigation ROI Returns Projected IE Without Enforced Caveat Display

**File:** `server/lib/arcFlashMitigation.ts`, lines 131–144

`estimateMitigationRoi()` returns `ieAfterCalCm2` as part of the response. The caveat is a string field the API consumer may choose not to display. No enforcement that the caveat is shown.

**Liability:** Customer uses projected "8.4 cal/cm²" to downgrade PPE without a re-study. Actual post-modification IE turns out to be 24 cal/cm².

**Fix:** Remove `ieAfterCalCm2` from the response or rename to `estimatedIeAfterCalCm2_requiresRestudy`. Require caveat to render inline on the front-end, not in a tooltip.

---

### [INS-10] HIGH — Part Usage Hard-Deleted With No Audit Trail

**File:** `server/routes/workOrders.ts`, lines 1329–1344

`DELETE /api/work-orders/:id/parts/:usageId` calls `prisma.workOrderPartUsage.delete()` — a hard delete with no soft-delete pattern and no `writeActivityLog` call. A manager can delete a part usage record to conceal that a non-spec part was installed.

**Fix:** Add `deletedAt DateTime?` to `WorkOrderPartUsage`, change to soft delete, add `writeActivityLog` call.

---

### [INS-11] HIGH — Audit Log Is Fire-and-Forget — Safety Events Lost on DB Failure

**File:** `server/routes/workOrders.ts`, lines 673–687

Every `writeActivityLog` call is fire-and-forget. If the audit DB write fails (disk full, pool exhausted), the primary operation (work order completed, condition changed) succeeds but the audit record is silently lost.

**Fix:** For safety-critical events (`work_order_completed`, `condition_changed`, `work_order_approved`), write the activity log in the same database transaction as the primary operation.

---

### [INS-12] MEDIUM — Local-Only Backup Risk Silently Suppressed — No Admin Alert

**File:** `server/lib/backup.ts`, lines 64–68

`warnIfLocalDest()` calls `console.warn` when `BACKUP_DEST=local`. No admin email is sent, no dashboard alert surfaced, no BetterStack event logged. A self-hosted customer can run for months with no off-box backup and never know.

**Fix:** On first backup run with `BACKUP_DEST=local`, send a one-time admin email warning and surface a persistent dashboard banner.

---

### [INS-13] MEDIUM — Permit Generation Not Audit-Logged

**File:** `server/lib/arcFlashPermit.ts` (no `writeActivityLog` call anywhere)

No audit trail of when an energized work permit was generated, which study version it was based on, or who requested it. NFPA 70E §130.6(A) requires an authorization record for energized work.

**Fix:** Log `arc_flash_permit_generated` to `ActivityLog` on every permit build, including `studyId`, `studyVersion`, `requestedBy`, `incidentEnergyAtTime`, `ppeCategoryAtTime`.

---

### [INS-14] MEDIUM — Label Generated With No Hazard Data When Both IE and PPE Category Are Null

**File:** `server/lib/arcFlashLabelDoc.ts`, lines 49–52

When both `incidentEnergyCalCm2` and `ppeCategory` are null, label generation proceeds. The hazard section renders blank. A blank hazard section is worse than no label — workers may interpret blank as "no hazard."

**Fix:** Add pre-flight check: if both are null, throw `400` — "Cannot generate label: no incident energy or PPE category on file."

---

### [INS-15] MEDIUM — pg_dump Backs Up Entire Multi-Tenant Database Regardless of AccountId

**File:** `server/lib/backup.ts`, lines 128–183

`runBackup(accountId, ...)` takes an `accountId` parameter used only for log routing. `runPgDump()` dumps the entire `PGDATABASE` — all tenants — regardless. If an admin-triggered manual backup exists, they receive a dump containing every other tenant's data.

**Fix:** Either remove admin-triggered manual backup, scope exports to `accountId`, or document and enforce that backup is system-admin-only.

---

## ESP — Electrical Safety Program (NFPA 70E / OSHA)

*Scope: NFPA 70E-2024, OSHA 29 CFR 1910.333/147, NETA MTS-2023, NFPA 70B:2023*

---

### [ESP-1] CRITICAL — LOTO Procedure Has No "Performed-By" Sign-Off Field

**File:** `server/prisma/schema.prisma` (`LotoProc` model); `server/routes/loto.ts` lines 280–312

**Citation:** OSHA 29 CFR 1910.147(f)(1), NFPA 70E §120.3(E)

`LotoProc` stores `approvedById`/`approvedAt` (who activated it) but has no field for who actually executed the lockout, no per-step `performedBy`/`performedAt`, and no execution record tied to a work order. The route code explicitly defers this: *"future: digital sign-off / performed-by tracking on work orders."*

**Fix:** Add a `LotoProcExecution` model with `workOrderId`, `performedById`, `executedAt`, and per-step tick array. Block work order `COMPLETE` transition when `requiresOutage=true` and no linked execution record exists.

---

### [ESP-2] HIGH — LOTO Activation Allows Procedures With No Zero-Energy Verification Step

**File:** `server/routes/loto.ts` lines 260–312 (`PATCH /status`)

**Citation:** OSHA 29 CFR 1910.147(d)(6), NFPA 70E §120.3(B)(4)

The `PATCH /status` route promotes a `LotoProc` from `draft` to `active` with no content validation. A procedure with zero steps, or no `category: 'verify'` step, passes. Voltage absence verification is never enforced.

**Fix:** Before setting `status='active'`: assert `energySources.length >= 1`, at least one `category: 'verify'` step with `requiresVerification: true`, at least one `category: 'lockout'` step. Return HTTP 422 on failure.

---

### [ESP-3] HIGH — Safe Work Permit `toComplete` List Missing Required §130.2(B)(2) Elements

**File:** `server/lib/arcFlashPermit.ts` lines 88–96

**Citation:** NFPA 70E-2024 §130.2(B)(2)(a)(d)(f)(h)(i)

The permit's 7-item `toComplete` array omits: circuit identifier beyond `busName`; equipment-specific safe work practices; specific boundary distances for restricting unqualified persons; means of alerting unqualified persons; job briefing completion (§130.3 mandatory).

**Fix:** Expand `toComplete` to 9–10 items mapping 1-to-1 to §130.2(B)(2)(a)–(i), embedding pre-calculated boundary distances inline.

---

### [ESP-4] HIGH — Overdue/Deficient Assets Are Never BLOCKED From New Work Orders

**File:** `server/routes/workOrders.ts` lines 301–402 (POST)

**Citation:** NFPA 70B:2023 §5.4.1, OSHA 29 CFR 1910.334(b)(2)

The `POST /api/work-orders` handler performs no check whether the asset has an open IMMEDIATE-severity deficiency or is overdue for mandatory inspection. An `EMERGENCY` work order can be created and completed on a critical-condition asset with no gate.

**Fix:** On work order creation with `requiresEnergized=true`, call `validatePermitIssuance`. For `CORRECTIVE` type on assets with an open IMMEDIATE deficiency, require `emergencyJustification` (min 20 chars).

---

### [ESP-5] HIGH — Arc Flash Incident Register Is Never Mounted as a Route

**File:** `server/lib/arcFlashIncident.ts` (entire file, lines 1–107); `server/index.ts` (no mount found)

**Citation:** NFPA 70E-2024 §130.9(A)(B), OSHA 29 CFR 1904

`arcFlashIncident.ts` defines `INCIDENT_TYPES = ['near_miss', 'arc_flash', 'shock', 'equipment_failure', 'other']` but no route is ever mounted in `server/index.ts`. The `ArcFlashIncident` schema model exists but is unreachable via any API endpoint.

**Fix:** Create `server/routes/arcFlashIncidents.ts` with GET/POST/PATCH and mount it. Near-miss entries should require `rootCauseInvestigation` within 5 business days and auto-escalate if uninvestigated.

---

### [ESP-6] HIGH — Energized Work Justification Not Stored or Enforced

**File:** `server/lib/arcFlashPermit.ts` lines 52–100; `server/prisma/schema.prisma` (no `energizedJustification` field)

**Citation:** NFPA 70E-2024 §130.2(A), §130.2(B)(2)(b)

The permit mentions justification as a plain-language reminder but no structured field captures or stores it. No `energizedJustification` or `deEnergizationFeasibility` field exists. A permit can be generated and printed with the justification blank — the system retains no record.

**Fix:** Add `energizedJustification String?` and `energizedJustificationCategory` (enum: `additional_hazard | infeasible_design | operational_continuous | other`) to `WorkOrder`. Require it (min 20 chars) when `requiresEnergized=true`.

---

### [ESP-7] MEDIUM — No NETA MTS Table 100.1 Section Mapping on Task Definitions

**File:** `server/prisma/schema.prisma` lines 948–981 (`MaintenanceTaskDefinition`)

**Citation:** ANSI/NETA MTS-2023 Table 100.1

`MaintenanceTaskDefinition` has `standardRef` (free text) but no structured `netaMtsTableSection` reference and no `requiredMeasurementTypes` list. A work order on `SWITCHGEAR` can be completed with `netaDecal=GREEN` even if only 1 of the 12+ MTS §7.18 required test types was performed.

**Fix:** Add `netaMtsTableSection String?` and `requiredMeasurementTypes String[]`. At `COMPLETE` transition, if `netaDecal` is set and `requiredMeasurementTypes` is non-empty, validate that `measurements` contains at least one entry per required type.

---

### [ESP-8] MEDIUM — Test Instrument Calibration Age Not Validated at Work Order Completion

**File:** `server/routes/workOrders.ts` lines 70–78 (`TestEquipmentSchema`)

**Citation:** NETA MTS-2023 §3.2, §5.3

`TestEquipmentSchema` accepts `{ make, model, serial, calDate }` with all fields optional. A work order can be completed with `netaDecal=GREEN` and a null `calDate` or a 1990 date. NETA requires instruments calibrated within 12 months.

**Fix:** When transitioning to `COMPLETE` with a non-null `netaDecal`: reject if `testEquipment` is null; parse each `calDate` and reject if any instrument is older than 12 months before `completedDate`.

---

### [ESP-9] MEDIUM — Near-Miss Events Have No Investigation-Due Workflow or Escalation

**File:** `server/prisma/schema.prisma` lines 1243–1264 (`IncidentLog`)

**Citation:** NFPA 70E-2024 §130.9(B), OSHA 1904.7

`ArcFlashIncident` has `status: String @default("open")` but no `investigationStatus`, no `investigationDueAt`, no auto-escalation for uninvestigated near-misses, and no OSHA 300-log export capability.

**Fix:** Add `investigationStatus` enum and `investigationDueAt DateTime?`. Emit a `deficiency_alert` when a `near_miss` or `arc_flash` incident has `status != 'closed'` after 5 business days.

---

### [ESP-10] MEDIUM — Expired Arc Flash Study Only Blocks External API; Native Work Order Creation Is Ungated

**File:** `server/routes/workOrders.ts` lines 308–402 (POST)

**Citation:** NFPA 70E-2024 §130.5(B)

The public v1 API (`GET /api/v1/arc-flash/work-order-precheck`) correctly returns `canIssue: false` when a study is expired. However, the native `POST /api/work-orders` route never calls `validatePermitIssuance`. An admin can create a work order on an asset with an expired study from years ago with no friction.

**Fix:** In `POST /api/work-orders`, if the asset has a `SystemStudyAsset` binding, call `validatePermitIssuance`. If `!canIssue` and caller lacks admin bypass flag, return HTTP 422.

---

### [ESP-11] MEDIUM — Duplicate Sentence in Compliance Alert Email Undermines Credibility

**File:** `server/lib/arcFlashIntegrity.ts` lines 56–58

"An outdated or invalidated study exposes personnel to unquantified arc flash hazard." appears twice in consecutive lines in the same `<p>` tag. Official compliance notifications should not have obvious duplication.

**Fix:** Remove the duplicate at line 58. Replace with a single sentence citing both Annex D (5-year best practice) and §130.5(G) (mandatory re-study after system changes).

---

### [ESP-12] MEDIUM — No PPE Acknowledgment Captured at Field Work Order Completion

**File:** `server/routes/fieldRoutes.ts` lines 397–427 (POST field completion)

**Citation:** NFPA 70E-2024 §130.7(C)(14), §130.5(F)

The field completion endpoint accepts `asLeftCondition` and `notes` with no PPE acknowledgment. A tech can mark a job complete via API without any record of PPE confirmation.

**Fix:** Add `ppeAcknowledgedAt DateTime?` and `ppeAcknowledgedCategory String?` to `WorkOrder`. In field completion POST, if the asset has a study with non-null `ppeCategory`, require `ppeCategory` in the request body.

---

## DB — Database Performance

*Scope: N+1 queries, missing indexes, unscoped scans, transaction issues at 50 accounts × 10,000 assets*

---

### [DB-1] CRITICAL — `account.findMany()` with No Filter or Limit in Monthly Digest Runner

**File:** `server/lib/monthlyDigest.ts` line 492

```ts
await prisma.account.findMany();
```

Fallback branch when no specific `accountId` is passed. Loads every account row then runs 5–8 DB queries per account in a serial loop. At 500 accounts this is a 4,000-query sequential chain and a memory bomb.

**Fix:** Cursor-based pagination loop with `take: 50`. Never call `findMany()` with no arguments on a multi-tenant table.

---

### [DB-2] CRITICAL — N+1 in `arcFlashIntegrity.ts` Path 3: Up to 2,000 Sequential Queries per Cron Run

**File:** `server/lib/arcFlashIntegrity.ts` lines 424–491

```ts
for (const def of relayBreakerDefs) {       // up to 500 items
  const admins      = await getAdmins(def.accountId);
  const alreadySent = await prisma.notificationLog.findFirst(...)
  const account     = await prisma.account.findUnique(...)
  await prisma.notificationLog.create(...)
}
```

Same N+1 pattern in Paths 1 and 2 (lines 271–352, 357–415): 5 sequential DB queries per deficiency.

**Fix:** Collect all unique `accountId`s before the loop. One `user.findMany({ where: { accountId: { in: [...] } } })`, one `account.findMany`, one `notificationLog.findMany` for dedup, then a single `notificationLog.createMany`.

---

### [DB-3] HIGH — Unbounded `asset.findMany()` Loads Entire Serial Inventory During CSV Import

**File:** `server/routes/assetsImport.ts` line 628

No `take:` on serial number deduplication query. An account with 50,000 serials loads all of them into Node RAM for every concurrent import request.

**Fix:** `where: { accountId, serialNumber: { in: submittedSerials } }` — only check the serials actually in the submitted batch (already capped at 500).

---

### [DB-4] HIGH — 500 Sequential `await tx.asset.create()` Calls Inside One Long-Held Transaction

**File:** `server/routes/assetsImport.ts` lines 751–944

```ts
txResult = await prisma.$transaction(async (tx) => {
  for (let i = 0; i < normalizedRows.length; i++) {   // up to 500 iterations
    const asset = await tx.asset.create({ ... });
    // + building.create, area.create, equipmentPosition.create per row
  }
});
```

500 sequential INSERTs inside one open transaction holds row locks on `assets`, `buildings`, `areas`, and `maintenance_schedules` for the entire duration.

**Fix:** Collect all rows into arrays, call `tx.asset.createMany({ data: allRows })` once, `tx.maintenanceSchedule.createMany({ data: allSchedules })` once.

---

### [DB-5] HIGH — N+1 per-row `maintenanceSchedule.update` Loop Inside Interactive `$transaction`

**File:** `server/routes/workOrders.ts` lines 658–663

```ts
for (const r of outageRolls) {
  await tx.maintenanceSchedule.update({ where: { id: r.id }, data: { ... } });
}
```

No server-side cap on `outageRolls`. Each element is a sequential UPDATE inside an already-open transaction.

**Fix:** `Promise.all(outageRolls.map(r => tx.maintenanceSchedule.update(...)))` or a single `$executeRaw` with a `CASE` expression.

---

### [DB-6] HIGH — Cross-Account `ILIKE` Scan on `deficiency.description` With 7 Clauses and No Text Index

**File:** `server/lib/arcFlashIntegrity.ts` lines 424–435

```ts
prisma.deficiency.findMany({
  where: {
    severity: 'IMMEDIATE', resolvedAt: null,
    OR: [
      { description: { contains: 'relay',   mode: 'insensitive' } },
      // ... 6 more ILIKE conditions ...
    ],
    // NO accountId filter
  },
  take: 500,
});
```

No `accountId` filter. PostgreSQL scans every unresolved IMMEDIATE deficiency across all tenants, applying 7 `ILIKE '%keyword%'` predicates. The existing `@@index([accountId, severity, resolvedAt])` is unused because `accountId` is absent from the `where` clause.

**Fix:** Add `pg_trgm` GIN index on `description`. Short term: add `accountId: { in: activeAccountIds }` to limit scan scope.

---

### [DB-7] HIGH — Two Unbounded `maintenanceSchedule.findMany` Fetches on Every Dashboard Load

**File:** `server/routes/dashboard.ts` lines 77–83 and 495–505

Both queries have no `take` and no date range (volume tab query fetches every schedule ever). An account with 10,000 active schedules returns 10,000 rows on every dashboard page load for in-process aggregation.

**Fix:** Push aggregation to PostgreSQL. Site rollup → `groupBy`. Volume tab histogram → `$queryRaw` with `date_trunc` bucketing.

---

### [DB-8] HIGH — Alert Engine Dedup Query With 2,000-Item `IN` List and No `accountId` Guard

**File:** `server/lib/alertEngine.ts` lines 524–530

```ts
const existing = await prisma.alert.findMany({
  where: {
    scheduleId: { in: scheduleIds },   // up to 2,000 IDs, no accountId
    status: { in: ['sent', 'acknowledged'] },
  },
});
```

No `accountId`. A 2,000-item `IN` list may cause PostgreSQL to abandon the existing index. If `scheduleIds` were ever cross-polluted, this silently returns cross-tenant alert history.

**Fix:** Add `accountId` to the `where` clause. Cap `scheduleIds` batch size to 500 and loop.

---

### [DB-9] MEDIUM — Cross-Account `systemStudy.findMany` With No `accountId` and No Matching Index

**File:** `server/lib/arcFlashIntegrity.ts` lines 154–163

```ts
prisma.systemStudy.findMany({
  where: { studyType: 'arc_flash', supersededById: null },  // no accountId
})
```

No `(studyType, supersededById)` index. PostgreSQL must use `@@index([accountId])` as a post-filter or fall back to a full table scan.

**Fix:** Add `@@index([studyType, supersededById])`. Long term: add `accountId` to the where clause.

---

### [DB-10] MEDIUM — `activityLog.findMany` With `distinct` but No `take`; Full 7-Day Window Scan

**File:** `server/routes/admin.ts` lines 121–124

No `take:` limit on a `distinct: ['userId']` query over 7 days of activity logs. An active account generates millions of activity log rows.

**Fix:** Add `take: 500` as a safety cap, or rewrite as `$queryRaw SELECT DISTINCT "userId" ... LIMIT 500`.

---

### [DB-11] MEDIUM — `taskDefinition.findMany` Without `accountId: null` May Return Cross-Tenant Rows

**File:** `server/routes/assetsImport.ts` line 915

```ts
const taskDefs = await tx.maintenanceTaskDefinition.findMany({
  where: { equipmentType: { in: types } },   // no accountId predicate
});
```

`accountId` is nullable (null = global seed row). This query picks up account-specific task definitions from other tenants that match the equipment type.

**Fix:** `where: { equipmentType: { in: types }, accountId: null }` for global-only, or `{ OR: [{ accountId: null }, { accountId }] }` to allow per-account overrides.

---

### [DB-12] MEDIUM — N Individual `testMeasurement.create()` Calls Instead of `createMany`

**File:** `server/routes/workOrders.ts` lines 932–934

```ts
const measurements = await prisma.$transaction(
  prepared.map(data => prisma.testMeasurement.create({ data }))
);
```

N individual INSERTs wrapped in a transaction. At 20+ measurements per work order, this is 20 sequential inserts.

**Fix:** Use `createMany` then re-fetch with `findMany({ where: { id: { in: returnedIds } } })`.

---

### [DB-13] MEDIUM — Missing `@@index([accountId, status, completedDate])` on `WorkOrder` for Dashboard Trends

**File:** `server/prisma/schema.prisma`; query in `server/routes/dashboard.ts` lines 547–550

The existing `@@index([accountId, status])` covers the first two predicates but PostgreSQL must then scan all COMPLETE orders to filter by `completedDate`. Turns the trends query into a partial index scan that degrades linearly with account history.

**Fix:** Add `@@index([accountId, status, completedDate])`.

---

### [DB-14] MEDIUM — `SsoLoginState` and `SsoHandoff` Have `accountId` but No `@@index([accountId])`

**File:** `server/prisma/schema.prisma`

- `SsoLoginState`: only `@@index([expiresAt])`
- `SsoHandoff`: only `@@index([userId])` and `@@index([expiresAt])`

Any admin lookup or SCIM operation filtering by `accountId` is a full table scan.

**Fix:** Add `@@index([accountId])` to both models.

---

## LEG — Legal / Contract Counsel

*Scope: Pre-acquisition due diligence — IP, privacy, contractual representations*

---

### [LEG-1] MEDIUM — All Four Legal Documents Are AI Drafts, Unreviewed by Counsel, Served Live

**Files:** `client/src/legal/terms-draft-2026-05.md` line 1, `privacy-draft-2026-05.md` line 1, `eula-draft-2026-05.md` line 1, `sub-processors-2026-05.md` line 1 — all contain: `DISCLAIMER — DRAFT, NOT YET COUNSEL-REVIEWED`

All four foundational legal instruments are AI-generated drafts with an embedded disclaimer stating they have never been reviewed by qualified counsel. These are currently served to live users. An acquirer is inheriting commercial relationships governed by legally unvetted documents.

**Remediation:** Engage qualified counsel immediately. Do not close acquisition without counsel-executed legal documents in place.

---

### [LEG-2] MEDIUM — SOW Contains Unquantified Uptime Commitment Without a Backstop

**File:** `docs/PILOT_SOW_TEMPLATE.md` line 97: `"Maintain platform uptime per the published status page"`

The Pilot SOW commits to uptime per a status page that is explicitly deferred in `docs/ACQUISITION_BRIEF.md` line 112. There is no published SLA number, no credits mechanism, and no cap on the commitment. A buyer inheriting signed SOWs could face an open-ended breach claim.

**Remediation:** Define a specific uptime percentage and measurement methodology in the SOW before any additional signatures.

---

### [LEG-3] MEDIUM — GDPR Art. 17 Erasure Writes Erased User's Email to the Audit Log

**File:** `server/routes/users.ts` lines 826–830

```typescript
writeActivityLog({
  userId:  req.user.id,
  action:  'user_erased',
  details: { targetUserId: targetId, targetEmail: target.email },   // PII preserved
}).catch(() => {});
```

The erasure endpoint correctly anonymizes ActivityLog rows by nulling `userId` — but then immediately writes a new log entry containing `targetEmail: target.email` in plaintext. Under GDPR Art. 17, the erasure obligation extends to all personal data held about the subject.

**Remediation:** Replace `targetEmail: target.email` with `targetUserId: targetId` only, or a non-reversible hash.

---

### [LEG-4] MEDIUM — Privacy Policy's EU Exclusion Unsupported by DPA; Policy Served Without Review Notice

**File:** `client/src/legal/privacy-draft-2026-05.md` lines 22–23

The privacy policy limits geographic scope to US-based businesses. However, the product is self-hostable and the EULA shifts GDPR controller status to the operator for self-hosted installs, but no Data Processing Addendum (DPA) exists. A PE buyer with EU portfolio companies would inherit this gap immediately.

**Remediation:** Execute a standard DPA template before any EU-adjacent customer engagements.

---

### [LEG-5] LOW-MEDIUM — API Lacks Governing ToS; Key Holders Never Accept Use Restrictions

**File:** `server/data/openapi/v1.yaml` lines 28–34

Rate limiting IS implemented per-key correctly. However, the OpenAPI spec contains no reference to governing terms of service or acceptable use policy. If an API customer builds a competing product, there is no contractual hook to terminate their key or pursue a claim.

**Remediation:** Add `x-terms-of-service` reference in OpenAPI spec. Require API key holders to accept ToS at key-generation time.

---

### [LEG-6] LOW-MEDIUM — Hardcoded Credentials and Operational Secrets in Committed Documentation

**Files:**
- `docs/DEMO_FIXES.md` line 13: SSH key path (`unencrypted`)
- `docs/DEMO_FIXES.md` line 12: HTTP basic auth credentials
- `docs/DEPLOY_RUNBOOK.md` lines 185–188: All demo account passwords
- `docs/DATA_ROOM_INDEX.md` line 112: Production VPS IP in data room index

If this repo is transferred to an acquirer or inadvertently made public, these credentials provide direct server access. During due diligence the data room itself shares the production VPS IP with prospective buyers.

**Remediation:** Rotate all hardcoded credentials before the data room is shared. Remove operational secrets from committed files.

---

### [LEG-7] LOW-MEDIUM — Trademark Not Registered; AI Copyright Claim Is Self-Assessed

**File:** `docs/IP_OWNERSHIP.md` lines 59–66, 102

"ServiceCycle" mark is unregistered. The IP ownership statement asserts AI-generated code vests in "the human author" under "terms applicable at the time of generation" — a contested legal area. The statement was drafted by the same founder whose IP it describes and carries the caveat "does not constitute a legal opinion."

**Remediation:** (a) File USPTO intent-to-use application immediately. (b) Obtain independent IP counsel opinion on the AI-authorship question before close.

---

### [LEG-8] LOW — `check.js` Development Script Logs All User Emails to Console

**File:** `server/check.js` line 15: `users.forEach(u => console.log(\` - ${u.email} (${u.role})\`))`

This debug script queries all users and logs every email address and role to stdout. If run during incident response on production, it dumps all user PII to whatever log aggregation is running (including Better Stack sub-processor).

**Remediation:** Delete `check.js` or mask email addresses before logging.

---

### [LEG-9] LOW — Off-Box Backups Not Implemented; Data Room's RPO ~24h Claim Is Not Yet Accurate

**Files:** `docs/DEPLOY_RUNBOOK.md` line 302 (off-box copy explicitly deferred), `docs/DATA_ROOM_INDEX.md` line 113 (states `RPO ~24h` as fact)

The data room asserts RPO ~24h. The runbook says off-box backup is deferred "after go-live." In a total-loss VPS event, the stated RPO is not achievable.

**Remediation:** Implement off-box backup before finalizing the data room. Qualify the RPO claim as "planned" until verified.

---

### [LEG-10] LOW — SOW "No AI Training" Representation Not Scoped to Specific Providers

**File:** `docs/PILOT_SOW_TEMPLATE.md` line 98

The SOW makes an unqualified no-AI-training representation. The BYO-AI feature allows pointing to any AI provider, including ones that train on inputs (the EULA warns against Google AI Studio's free tier). A managed-cloud customer could have the representation breached by a provider change.

**Remediation:** Scope the SOW AI-training representation to "using the forgerift-operated hosted service." Add a clause for BYO-AI provider responsibility.

---

### [LEG-11] LOW — EULA IP Indemnification Is Uncapped and Covers a Codebase With Uncertain AI-Copyright Status

**File:** `client/src/legal/eula-draft-2026-05.md` lines 160–166

ForgeRift provides unilateral IP indemnification (including attorneys' fees) for patent/copyright/trademark claims. The general $100 liability cap explicitly excludes indemnification obligations (line 150). An acquirer's IP counsel may view this as a latent liability given the AI-generation disclosure.

**Remediation:** Counsel should review whether the IP indemnification scope is appropriate. Consider limiting with a monetary cap pending trademark registration and AI-copyright opinion.

---

## UXR — UX Researcher (Onboarding / Cognitive Load)

*Scope: First-run experience, empty states, error recovery, form validation — NOT accessibility (covered in v2)*

---

### [UXR-1] MEDIUM — Onboarding Wizard and Empty-State Card Both Render at Once With Conflicting CTAs

**File:** `client/src/pages/Dashboard.jsx` lines 876–906; `client/src/components/OnboardingWizard.jsx` lines 155–157

A brand-new user sees both the `OnboardingWizard` modal overlay AND the inline welcome card simultaneously, each offering different "Add your first site" paths that don't coordinate state. If the user clicks the inline card's CTA, the wizard disappears without advancing its step.

**Fix:** Gate the inline empty-state card behind `onboardingDone`, or ensure clicking its CTAs also advances wizard state.

---

### [UXR-2] HIGH — NewAsset Form Shows One Top-Level Error Instead of Per-Field Errors

**File:** `client/src/pages/NewAsset.jsx` lines 327–330

If multiple required fields are missing, only the first check fires and sets `setError('Site is required.')`. No inline per-field error states (no `aria-invalid`, no red border). The error banner appears at top of page without scrolling to the specific field.

**Fix:** Collect all validation errors before rendering, highlight each invalid field individually, and auto-scroll/focus the first error field.

---

### [UXR-3] HIGH — 10+ Components Use `window.confirm`/`window.prompt`, Bypassing the Themed ConfirmDialog

**Files:**
- `client/src/pages/EquipmentTemplates.jsx` line 300
- `client/src/pages/Parts.jsx` lines 172, 190
- `client/src/components/AssetDocumentsCard.jsx` line 178
- `client/src/components/RequiredPartsPanel.jsx` line 129
- `client/src/components/SpareInventoryPanel.jsx` line 94
- `client/src/components/LotoProcCard.jsx` line 81
- `client/src/components/LotoProcForm.jsx` line 345
- `client/src/components/PathTo100.jsx` line 77 (`window.prompt` for data entry)
- `client/src/components/ImportWebhookSection.jsx` line 75
- `client/src/pages/UsersPage.jsx` line 272 (`window.prompt` for GDPR erasure)

Browser-native dialogs are blocked in some browsers/WebViews, unstyled, and inconsistent. The GDPR erasure flow is effectively inaccessible if the browser blocks prompts.

**Fix:** Replace all `window.confirm` and `window.prompt` calls with the app's existing `useConfirm` hook.

---

### [UXR-4] MEDIUM — User Reactivation Fires Without Any Confirmation Step

**File:** `client/src/pages/UsersPage.jsx` lines 243–251

Clicking "Reactivate" immediately fires the API call with no confirmation. Deactivation has a two-step modal; reactivation fires silently. A manager who accidentally clicks Reactivate on the wrong row has no recovery moment.

**Fix:** Add a single confirmation step (using `useConfirm`) before `api.put(…/activate)`.

---

### [UXR-5] MEDIUM — ImportAssets "Download Sample CSV" Uses `href="#"` — Fails on Right-Click / Long-Press

**File:** `client/src/pages/ImportAssets.jsx` lines 217–222

The template CSV download is an `<a href="#">` with an `onClick` that calls `e.preventDefault()` and programmatically creates the download. Right-click "Open in new tab" does nothing. On mobile, long-pressing shows browser "Open link" options that go nowhere.

**Fix:** Use `href="data:text/csv;charset=utf-8,..."` or a proper `download` attribute, or style it as a button.

---

### [UXR-6] LOW — FieldHome Empty State Gives No Guidance to First-Time Field Techs

**File:** `client/src/pages/field/FieldHome.jsx` line 115

When all sections are empty (all counts zero), each section shows "Nothing here — clear." A new field tech who has just logged in for the first time, before their manager has assigned them anything, sees four sections with "Nothing here — clear" and no path forward.

**Fix:** When all counts are zero, show: "Your manager hasn't assigned any assets or work orders yet — check back after your first job is dispatched."

---

### [UXR-7] MEDIUM — OnboardingWizard Step 3 Links to `?bulkSchedules=1` Which Has No Handler If Assets = 0

**File:** `client/src/components/OnboardingWizard.jsx` line 69; `client/src/pages/AssetsList.jsx`

Step 3 navigates users to `/assets?bulkSchedules=1`. The `?bulkSchedules=1` URL param is not handled in `AssetsList.jsx`. If the user skipped step 2 (no assets), they land on the empty assets list with no indication of what `bulkSchedules=1` was supposed to trigger.

**Fix:** Handle `?bulkSchedules=1` in AssetsList.jsx to show a callout, or don't send users to step 3 if `assetCount === 0`.

---

### [UXR-8] MEDIUM — NewWorkOrderModal Asset Listbox Has No Per-Field Error Highlight on Failed Submit

**File:** `client/src/pages/WorkOrdersList.jsx` lines 144–157

When submit fails because no asset is selected, `setError('Pick an asset.')` banner appears at top of modal but the listbox itself shows no red state. The pick-list UX (scrollable `<select size={N}>`) may not signal "required" to new users.

**Fix:** Add red border directly to the listbox on failed submit. Consider a search-then-select pattern for the asset picker.

---

### [UXR-9] LOW — Dashboard "New Asset" Header Button Hidden When `assetCount = 0`

**File:** `client/src/pages/Dashboard.jsx` lines 862–866

The "+ New asset" button is gated behind `data && data.assetCount > 0`. If an admin has one asset and archives it, `assetCount` returns to 0 and the header button disappears unexpectedly.

**Fix:** Show the "+ New asset" button for all `canWrite` users regardless of `assetCount`.

---

### [UXR-10] MEDIUM — Parts Delete: No Loading State, No Toast, Uses `window.confirm`

**File:** `client/src/pages/Parts.jsx` lines 172, 190

Deleting a part fires the API with no loading state on the button (double-click could fire two DELETEs), and no toast is shown after successful deletion. Inconsistent with the rest of the app which uses `showToast`.

**Fix:** (1) Replace `window.confirm` with `useConfirm`. (2) Add loading state. (3) Show success toast.

---

### [UXR-11] LOW — "Work Order" vs "Job" Terminology Used Interchangeably Across Desktop and Field Views

**Files:** `client/src/pages/WorkOrdersList.jsx`, `client/src/pages/field/FieldHome.jsx`, `client/src/pages/field/FieldJobs.jsx`

Manager/admin users see "Work orders" everywhere. Field techs see "Jobs" in FieldJobs routing. The wizard says "Work Orders track each contractor visit" but field techs see "Jobs." Creates cognitive dissonance during onboarding.

**Fix:** Standardize on "Work Order" throughout, or document "job" as a deliberate field-mode alias.

---

### [UXR-12] MEDIUM — SetupWizard Password Field Has No Real-Time Strength Indicator

**File:** `client/src/pages/SetupWizardPage.jsx` lines 178–181

The admin account creation step shows a static hint ("At least 12 characters, one digit, one special character") but the password field has no inline validation feedback. A failed submit may destroy the wizard's progress state.

**Fix:** Add real-time client-side validation feedback beneath the password field (mini checklist that turns green as requirements are met).

---

### [UXR-13] LOW — FieldAsset.jsx PDF Generation Failure Uses `alert()` Instead of Toast

**File:** `client/src/pages/field/FieldAsset.jsx` lines 131–133

`alert('Could not generate PDF. Please try again when online.')` is used for PDF failure. All other error states use the `Toast` component (already imported). `alert()` is blocked in some iOS WebViews.

**Fix:** Replace `alert()` with `setToast(...)` using `variant: 'error'`.

---

### [UXR-14] LOW — ImportAssets "Back" Button Hardcoded to `/assets`, Ignores Navigation Origin

**File:** `client/src/pages/ImportAssets.jsx` lines 152–154

"Back to assets" always navigates to `/assets`. Unlike most pages (which use `BackLink` with `useFromState`), ImportAssets hardcodes its back destination. If a user arrived from the Dashboard's empty-state card, "Back" drops them on the empty assets list.

**Fix:** Use `BackLink` with `fallback="/assets"` so users return to their origin page.

---

## INFRA — Cloud Architect / Infrastructure

*Scope: Docker hardening, scaling, SPOF, DR gaps, observability. Does NOT duplicate R1-R10.*

---

### [INFRA-1] CRITICAL — No CPU Limits on Any Service; Single Malformed Document Can OOM the Entire Host

**File:** `docker-compose.yml` lines 72, 172, 379

`mem_limit` is set but no `cpus:` constraint appears anywhere. The `server` container runs PDF extraction (pdfplumber + Tesseract OCR) and AI inference synchronously in-process. A single oversized document can spin the Node event loop to 100% CPU, starving Postgres health probes and Caddy simultaneously. A fresh redeploy can transiently spike to 3 GB RAM + unconstrained CPU on a 4 GB droplet.

**Fix:** Add `cpus: "1.5"` on `server`, `cpus: "1.0"` on `db`. For AWS/Azure migration, replace with ECS task resource definitions or K8s resource requests/limits.

---

### [INFRA-2] CRITICAL — No Redis/Queue Bus; All Cron Jobs and Ingest Worker Run In-Process With No Backpressure

**File:** `server/index.ts` lines 1513–1542, `docker-compose.yml` (no Redis service)

All 20+ scheduled jobs share a single Node.js event loop with the HTTP server, competing for the same 10-connection Prisma pool (`connection_limit=10`). The `runOnce()` pattern prevents re-entrant execution of the same job but does not throttle cross-job concurrency.

**Blast radius:** Under 10+ concurrent accounts, the alert engine sweep + AI extraction + backup can exhaust the connection pool, causing all in-flight user requests to queue behind `pool_timeout=30s` and surface as 503s.

**Fix:** Extract cron jobs to a dedicated worker process or BullMQ/pgBoss queue. For AWS: SQS + Lambda workers or ECS Fargate scheduled tasks.

---

### [INFRA-3] HIGH — No Zero-Downtime Deploy; Hard 60-120s Restart Window on Every Push to `main`

**File:** `.github/workflows/deploy.yml` lines 64–82; `docs/DEPLOY_RUNBOOK.md` line 309

The deploy pipeline stops the running container, rebuilds the image on the droplet, and starts a new container. The runbook acknowledges: "No zero-downtime: `docker compose up -d` has a brief restart window." A 2-minute deploy window consumed 8× per day exhausts a 99.9% SLA annual budget in 2.5 days.

Additionally, the pre-deploy backup at deploy.yml line 62 is `|| echo "WARN: backup step failed (continuing)"` — a failed backup does not block a deploy that could break the DB schema.

**Fix:** Blue-green or rolling deploy. Remove the `|| echo "WARN"` on the pre-deploy backup — fail the pipeline instead.

---

### [INFRA-4] HIGH — Secret Management is `.env` File on Disk; No Rotation Automation, No Secret Scanning in CI

**File:** `docs/DEPLOY_RUNBOOK.md` lines 95–148; `.github/workflows/ci.yml` (no secret scanner step)

All secrets live in a single `.env` file at `/root/ServiceCycle/.env`. The deploy workflow SSHes as `root`, meaning the entire secret set is accessible to any process running as root. CI has `npm audit` for SCA but no TruffleHog/Gitleaks step. The `MASTER_KEY` used in CI is an all-zero key stored in plaintext in the workflow file.

**Fix:** Migrate to AWS Secrets Manager / Azure Key Vault. Add TruffleHog as a CI step. Deploy SSH should use a non-root `deploy` user.

---

### [INFRA-5] HIGH — Single Postgres Instance With No Standby; Named Volume on Ephemeral Block Storage

**File:** `docker-compose.yml` lines 53–134; `docs/DEPLOY_RUNBOOK.md` lines 301, 310

No streaming replication, no read replica, no Postgres HA. `docker compose down -v` (easy to type accidentally) destroys the named volume. `mem_limit: 1g` on the db container means an unexpected full-table scan can OOM-kill Postgres.

**Fix:** For AWS: RDS PostgreSQL Multi-AZ with automated backups (5-minute RPO via WAL streaming). For Azure: Azure Database for PostgreSQL Flexible Server with HA.

---

### [INFRA-6] HIGH — Backup Loaded Entirely Into RAM Before Upload; OOM at ~300 MB DB Size

**File:** `server/lib/backup.ts` lines 128–183, 255–264

`runPgDump()` dumps to a temp file then reads it entirely into a `Buffer` at line 177 (`await fsp.readFile(tmpFile)`). For a 500 MB database, peak in-memory footprint is ~1.5 GB against a `mem_limit: 1g` container ceiling. The code comment at line 140 acknowledges this and flags it as a deferred follow-up.

**Blast radius:** At DB sizes above ~300 MB, the 02:00 backup cron will OOM-kill the `server` container, taking down the entire API.

**Fix:** Stream `pg_dump` stdout directly through `zlib.createGzip()` → `crypto.createCipheriv()` → `@aws-sdk/lib-storage` `Upload` (multipart).

---

### [INFRA-7] MEDIUM — No Distributed Tracing; No Request-Level Correlation Across Services

**File:** `server/index.ts` lines 491–498

`X-Request-Id` is assigned per request but there is no OpenTelemetry instrumentation, no `traceparent` W3C header propagation between Caddy → server, and no slow-query correlation (a 4-second Prisma query cannot be tied to the Node request ID that caused it). HTTP request latency histograms (p50/p95/p99) are not instrumented anywhere.

**Fix:** Add `@opentelemetry/sdk-node` with automatic Express and Prisma instrumentation. Add `response_time_ms` to every pino-http log line and ship to Better Stack with a latency alert.

---

### [INFRA-8] MEDIUM — TLS Certificate Managed by Caddy With No Expiry Monitoring or Renewal Fallback

**File:** `docs/DEPLOY_RUNBOOK.md` lines 193–233

Caddy handles ACME via Let's Encrypt automatically, but there is no external certificate expiry monitor, no alert if Caddy's ACME renewal fails, and no documented manual renewal procedure. If port 80 is blocked (e.g., by a UFW rule change during hardening), Caddy's renewal fails silently from the application's perspective.

**Fix:** Add an external cert-expiry monitor (Better Stack, UptimeRobot, or Datadog). For enterprise: replace Caddy with AWS ACM + ALB.

---

### [INFRA-9] MEDIUM — Log Retention Bounded by Disk Size (~2-4 Hours); No Structured Log Aggregation Pipeline

**File:** `docker-compose.yml` lines 84–88

Each service uses `json-file` driver with `max-size: 10m` and `max-file: 3` — 30 MB per service × 4 services = 120 MB maximum retention (~2–4 hours of API traffic). Better Stack ships explicit `logEvent()` calls only; standard HTTP request logs (pino-http JSON lines) are not shipped.

**Fix:** Deploy a Fluent Bit sidecar or use Docker's `fluentd` log driver to ship all container stdout/stderr to Better Stack, Loki, or CloudWatch Logs.

---

### [INFRA-10] MEDIUM — Restore Test Validates Archive Parsability Only; No Documented RTO

**File:** `server/index.ts` lines 2028–2038; `docs/DEPLOY_RUNBOOK.md` lines 300–310

The weekly restore test runs `pg_restore --list` only. The monthly deep test requires `PG_TEST_DB_URL` — a separate Postgres instance documented as not configured on the demo droplet. The runbook gives "RTO ~1-2h" with no measured restore time and no documented restore runbook.

**Fix:** Provision a sidecar Postgres container for `PG_TEST_DB_URL`. Add row-count assertions to the monthly deep test. Document the restore procedure in `docs/dr.md` with measured times.

---

### [INFRA-11] MEDIUM — Prisma Pool Size Fixed at 10; No PgBouncer; Cron Jobs Share HTTP Pool

**File:** `docker-compose.yml` line 197: `connection_limit=10&pool_timeout=30`

10 Prisma connections serve both the HTTP server and all 20+ cron jobs. The alert engine at 07:00 sweeps all accounts serially, holding pool slots for minutes. Under 10+ concurrent users + cron firing, pool exhaustion causes 30-second queued requests.

**Fix:** Deploy PgBouncer in transaction-pooling mode. Separate the cron worker's connection pool from the HTTP server's pool using two `DATABASE_URL` strings with different `connection_limit` values.

---

### [INFRA-12] LOW — CI Deploy Workflow SSHes as Root; Contradicts Hardening Runbook

**File:** `.github/workflows/deploy.yml` line 10: `SC_SSH_USER  - root`

The runbook section 1.5 explicitly creates a non-root `deploy` user — but the deploy workflow contradicts this by using root. If the `SC_SSH_KEY` secret is compromised, the attacker has root on the production droplet plus all secrets in `.env`.

**Fix:** Create a `deploy` user with `docker` group membership. Update `SC_SSH_USER` to `deploy`.

---

### [INFRA-13] LOW — Post-Deploy Health Check Uses Liveness Endpoint, Not Readiness

**File:** `.github/workflows/deploy.yml` line 80

The post-deploy health check uses `/api/health` (liveness only — does NOT touch the DB per index.ts line 1084 comment). A deploy that breaks the database connection will return HTTP 200 from `/api/health` and the pipeline will report success.

**Fix:** Change deploy.yml line 80 from `/api/health` to `/api/ready`. Add `/api/ready?deep=1` as a post-deploy gate.

---

## INT — Enterprise Integration Architect

*Scope: Webhook reliability, API versioning, OAuth, tenant isolation edge cases. Does NOT duplicate P3, P6, P7.*

---

### [INT-1] CRITICAL — Webhook Payload Omits `accountId`; No Tenant Discriminator at Receiver

**File:** `server/lib/webhook.ts` lines 248–265 (`buildPayload`)

The outbound webhook payload body contains `assetId`, `scheduleId`, `siteName` etc. but no `accountId`. An enterprise ERP integration receiving webhooks from multiple tenants cannot distinguish which tenant fired the event without inspecting the HMAC secret. Deduplication logic keyed on `assetId` alone can collide between tenants sharing a receiver endpoint.

**Fix:** Add `"accountId": "<uuid>"` as a top-level field in `buildPayload()` at line 248.

---

### [INT-2] CRITICAL — Work-Order CSV Import Has No Idempotency Guard; Retry Creates Duplicate Records

**File:** `server/routes/workOrdersImport.ts` lines 436–474 (`/commit` handler)

The asset CSV import deduplicates on `(accountId, serialNumber)`. The work-order import has no equivalent guard — it calls `tx.workOrder.create()` unconditionally for every matched row (line 455). A request timeout after the server commits but before the response arrives results in a retry that creates duplicate work orders.

A Maximo export of 1,000 historical work orders arriving via an integration pipeline with retry-on-timeout will create 2,000 rows, corrupting maintenance history and RUL scoring.

**Fix:** Require an `externalId` column in the import file and add a `(accountId, externalId)` unique constraint.

---

### [INT-3] HIGH — `signPayload()` Silently Falls Back to Timestamp-Less HMAC for Legacy Callers

**File:** `server/lib/webhook.ts` lines 176–194

`signPayload(body, timestamp, secret)` includes the timestamp in the HMAC when called with three arguments — but the backwards-compatibility path at line 182–186 silently drops the timestamp when called with two. Any internal caller omitting `timestamp` produces a signature that does not defend against replay attacks.

**Fix:** Remove the two-argument overload entirely. Make `maybeSecret === undefined` throw `Error('signPayload: timestamp is required')` to force detection at test time.

---

### [INT-4] HIGH — API Scopes Are Account-Wide `read`/`write` Only; No Resource-Level Scoping

**File:** `server/routes/apiKeys.ts` lines 41–51; `server/middleware/apiKeyAuth.ts` lines 180–191

A compromised `write` key from a gateway device that only needs `POST /telemetry/readings` also gives the bearer the ability to create work orders and modify arc-flash device records. No principle of least privilege for individual integrations.

**Fix:** Extend the `scopes` array to include resource-level values: `read`, `write`, `telemetry:write`, `work_orders:write`, `arc_flash:write`.

---

### [INT-5] HIGH — SSO JIT Provisioning: IdP Group Rename Silently Downgrades User to `viewer`

**File:** `server/routes/sso.ts` lines 194–219; `server/lib/ssoRoleMap.ts` lines 34–54

When no mapping row matches any of the user's current groups, `mapClaimsToRole()` returns `defaultRole`. If an enterprise renames an IdP group (a routine AD/Okta operation) without updating the `ssoRoleMapping` table, the user silently downgrades to `viewer` on their next login. The role change is logged at line 231 but the old role is not recorded.

**Fix:** Add `previousRole` to the `sso_login_success` audit log payload. Add a distinct `sso_role_changed` event. Document in the SSO admin UI that IdP group renames require updating the mapping table.

---

### [INT-6] HIGH — `GET /api/v1/telemetry/notifications` Truncates at 200 Rows With No Pagination Contract

**File:** `server/routes/v1/telemetry.ts` lines 205–223

Returns `{ success, data, count }` with a hard `take: 200` and no pagination parameters. An enterprise with >200 CRIT notifications will silently miss records. `count` reports the returned rows, not the total. The SDK `types.ts` line 299 documents `ListTelemetryNotificationsParams` with no `page`/`limit` parameters, confirming the omission is baked into the SDK contract.

**Fix:** Add `page`/`limit` query params and return the standard `pagination` envelope. Update OpenAPI spec and SDK types.

---

### [INT-7] HIGH — DLQ Manual Retry Re-Builds `alertItem` From Wrong Legacy Shape; Replays Blank Payload

**File:** `server/routes/webhooks.ts` lines 152–165

The DLQ retry handler reads `payload.contractId` as a fallback for `payload.assetId` — a legacy field name from a retired contracts module — and synthesizes a `contract`-shaped `alertItem`. This does not match the `{ schedule, asset, alertType }` shape that `deliverWebhook` → `buildPayload` consumes. Retrying a DLQ row for a `maintenance.due` alert delivers `assetId: null`, `scheduleId: null`.

**Fix:** Store the raw pre-serialized payload in the DLQ row and POST it verbatim — exactly what `webhookRetry.ts` line 79 already does correctly.

---

### [INT-8] MEDIUM — Rate Limit 429 Response Does Not Include `Retry-After` Header; SDK Over-Waits 60s

**File:** `server/middleware/apiKeyAuth.ts` lines 34–46; `sdk/src/http.ts` lines 78–86

`express-rate-limit` with `standardHeaders: true` emits `RateLimit-*` headers but not `Retry-After` by default. The SDK's 429 handler reads `Retry-After` and falls back to 60 seconds when absent. A telemetry gateway hitting the 60 req/min limit at second 5 of a window will over-wait by 55 seconds.

**Fix:** Configure `express-rate-limit` with `standardHeaders: 'draft-7'` to emit `Retry-After`. In the SDK, also parse `RateLimit-Reset` as the fallback.

---

### [INT-9] MEDIUM — Arc-Flash Labels Response Envelope Diverges From All Other v1 List Endpoints; SDK Paginator Breaks

**File:** `server/routes/v1/arcFlash.ts` line 87

Returns `{ data, page, limit, total, totalPages }` — flat, non-nested, `success` field absent, `totalPages` instead of `pages`. The SDK's `paginator.ts` reads `result.pagination.pages` (line 30), which is `undefined` for arc-flash labels — `paginate()` terminates after the first page. `listAllLabels()` silently returns only the first 50 labels regardless of fleet size.

**Fix:** Wrap to match the standard envelope: `{ success: true, data: [...], pagination: { page, limit, total, pages: Math.ceil(total/limit) } }`.

---

### [INT-10] MEDIUM — SDK Has a Live Type Mismatch: `minArcRatingCalCm2` vs `requiredArcRatingCalCm2`

**File:** `sdk/src/types.ts` line 139 vs `server/routes/v1/arcFlash.ts` line 82

`sdk/src/types.ts` documents the field as `minArcRatingCalCm2`. The server returns `requiredArcRatingCalCm2`. Any integration reading `result.minArcRatingCalCm2` receives `undefined`. SDK is at `0.1.0` with no `CHANGELOG.md` and no changelog section.

**Fix (immediate):** Rename `sdk/src/types.ts` line 139 to `requiredArcRatingCalCm2`. **Fix (structural):** Add `CHANGELOG.md` to the SDK. Implement `Deprecation`/`Sunset` headers in the v1 middleware.

---

### [INT-11] MEDIUM — `assets.imported` Webhook Uses Separate Log Table With No DLQ or Admin Retry

**File:** `server/lib/webhookImport.ts` lines 120–148

The alert-engine webhooks have a full DLQ with admin retry UI. The `assets.imported` event uses a separate `WebhookDelivery` log table with no DLQ rows, no retry API, and no admin UI. A CMMS integration relying on `assets.imported` to trigger downstream sync jobs loses the notification on transient failure with no recovery path.

**Fix:** Route `webhookImport.ts` through the same `OutboundWebhookDLQ` + `persistFailedDelivery` path as the alert engine.

---

### [INT-12] LOW — Channel Auto-Creation Inside `ingestReadings` Splits History Silently on Naming Variation

**File:** `server/routes/v1/telemetry.ts` lines 125–136

`POST /telemetry/readings` auto-creates channels on first write via `prisma.telemetryChannel.upsert()`. A telemetry key used by two gateways with different naming conventions (`winding_temp` vs `WindingTemp`) can auto-create duplicate channels, splitting telemetry history.

**Fix:** Document the auto-create behavior in the API spec and SDK README. Gate auto-create behind an opt-in `X-SC-Auto-Create-Channels: true` header.

---

## PMF — Product-Market Fit / PE Due Diligence

*Scope: Gap between claimed capability and actual code; demo data accuracy; acquisition-blocking issues*

---

### [PMF-1] HIGH — Arc Flash PPE Category 0 Missing From Lookup Table

**File:** `server/lib/arcFlashMitigation.ts` lines 106–110

The `PPE_BANDS` lookup maps any IE below 4 cal/cm² to Category 1. NFPA 70E Table 130.7(C)(15)(a) defines Cat 0 below 1.2 cal/cm². The system overstates required PPE for low-energy equipment and is technically non-compliant in this range.

---

### [PMF-2] HIGH — Arc Flash Labels Missing PE/Firm Identity (NFPA 70E §130.5(H))

**File:** `server/lib/arcFlashLabelDoc.ts` (`buildLabelModel()` function)

NFPA 70E-2024 §130.5(H) requires the label to identify the qualified person or firm who performed the study. The generated label footer reads "Printed from ServiceCycle" (the SaaS vendor), not the performing PE. The `SystemStudy` schema has `performedBy` and `firmName` fields but they are never passed into the label builder. Every label generated is non-compliant on this element.

---

### [PMF-3] HIGH — Demo Seed Data Contains Domain Errors a NETA PE Will Catch on First Click

**File:** `server/scripts/seed-demo.js` lines ~1185, ~1401–1403, ~1417–1424, ~1978

Four specific errors:
1. 13.8 kV transformer work order notes reference "IEEE C57.106 Action Level 1 for **138 kV class**" — factor-of-10 voltage error.
2. Seeded arc flash study uses method `IEEE 1584-2018` but `performedDate` is 2017 (the standard was published September 2018).
3. Two seeded buses with IE of 14.2 and 19.6 cal/cm² are assigned `ppeCategory: 4` — NFPA 70E places those values in Cat 3.
4. LOTO document references "1500kW Emergency Generator" while the asset record for GEN-1 is 750 kW. Both are visible on the same screen in the demo.

---

### [PMF-4] HIGH — Billing Infrastructure Not Activated; No Path to a Paying Customer

**File:** `server/lib/stripe.ts`; `docs/PRICING.md`

The `requireTier()` middleware is implemented but `grep -r "requireTier" server/routes/` returns no matches — it is wired to nothing. No checkout flow, no customer portal, no webhook handling for `subscription.updated` or `invoice.payment_failed`. There is no mechanism for a prospect to become a paying SaaS customer without manual engineering intervention.

---

### [PMF-5] MEDIUM-HIGH — SSO Requires Manual Support Ticket, Not Self-Service

**File:** `client/src/pages/SsoSettings.jsx` lines 44–52

When the `sso` feature flag is off (default for all accounts), the page instructs users to email `support@servicecycle.app` for a one-business-day manual activation. The backend SSO code is fully implemented. Enterprise IT teams evaluating the product expect self-service SAML/OIDC configuration; a support email is a red flag in an enterprise demo.

---

### [PMF-6] MEDIUM — Three Production Cron Jobs Crashing Daily

Per `docs/DEMO_LANDMINES.md`, confirmed not resolved in current source:

1. **Nightly backup cron:** fails with `EACCES` — `/root/ServiceCycle/backups` is owned by root, Node runs as UID 1000. No backup has ever completed on the production droplet.
2. **`ServiceOpportunityTrigger` cron:** crashes because `asset.name` is referenced in a Prisma select but the field is computed (not stored) and does not exist on the Asset model.
3. **Weather alert cron (every 15 min):** throws `sendAlertEmail is not a function` — the export does not exist in `lib/email.ts`. Generates ~96 error logs per day; weather alert emails never fire.

---

### [PMF-7] MEDIUM — "Predictive Maintenance" Is a Moving Average, Not ML

**File:** `server/lib/telemetryLoadGrowth.ts`

The predictive maintenance feature computes a sliding-window average over the oldest 5 vs. newest 5 telemetry readings and returns a percentage delta. The file header self-describes as "Pure helpers." No model, no learning, no forecasting. Arc flash mitigation recommendations (`arcFlashMitigation.ts`) are a static lookup table of 6 rules filtered by device type and voltage class. The only genuine LLM inference is the AI maintenance brief, which is disabled by default (`AI_ENABLED=false`) on the demo environment.

---

### [PMF-8] MEDIUM — CMMS Import Capped at 1,000 Rows; Not Viable for Real Maximo Migrations

**File:** `server/routes/workOrdersImport.ts`

The import UI presents a professional three-step flow for IBM Maximo, SAP S/4HANA PM, Oracle EAM, and generic CSV. The server has a hard 1,000-row cap per import. A real Maximo migration at any meaningful facility will have 5,000–50,000 historical work orders. The UI gives no indication of this cap.

---

### [PMF-9] MEDIUM — Parts Inventory Has No Work Order Integration (No Consumption Tracking)

**Files:** Prisma schema `WorkOrder` model; `client/src/pages/Parts.jsx`

The Parts catalog and SpareInventory models are well-structured, but completing a work order does not decrement inventory. There is no parts-consumed-per-work-order tracking. The "Required Parts" panel on AssetDetail is read-only display. Every EAM competitor tracks this explicitly.

---

### [PMF-10] MEDIUM — No Work Order Type Distinction (PM vs. Corrective vs. Emergency)

**File:** Prisma schema `WorkOrder` model

The `WorkOrder` model has no `workOrderType` field — the only structural distinction is whether `scheduleId` is null. The CFO report and reliability dashboard cannot answer "what percentage of maintenance spend is reactive?" — the first question any reliability engineer asks during a technical demo.

---

### [PMF-11] MEDIUM — Legal Documents Self-Disclosed as AI Drafts, Visible to All Visitors

**File:** `client/src/pages/LegalDocPage.jsx` line 166

The Privacy Policy, Terms of Service, and EULA pages render a visible banner: "Draft — pending counsel review, not yet legally binding." The `draftBanner` prop defaults to `true` across all legal pages. Any compliance or legal team in an acquisition review will find this immediately.

---

### [PMF-12] MEDIUM — Legacy "Software Renewal Management" Branding Visible in Customer-Facing UI

**Files:**
- `client/src/pages/ForgotPassword.jsx` line 32: renders "Software Renewal Management" as the app tagline
- `client/src/lib/urgency.js`: contains a complete contract-renewal urgency model (`renewalUrgency()`, `evaluationStartByDate`)
- `client/src/components/settings/WebhooksSection.jsx` line 140: tells admins webhooks "fire at 60, 30, and 7 days before renewal or auto-renew cancellation deadlines"

An acquirer doing repo-level diligence finds contract-renewal logic and "Software Renewal Management" branding in an electrical maintenance platform.

---

### [PMF-13] LOW — 5-Year Arc Flash Re-Study Clock Cites Non-Normative Annex as Mandatory

**File:** `server/lib/arcFlashIntegrity.ts` lines 229, 289

The compliance alert claims "NFPA 70E §130.5(G) requires review every 5 years." The 5-year interval appears only in Annex D (informative, not normative). §130.5(G) requires updates when conditions change; there is no normative 5-year mandate. The system generates "regulatory breach" alerts based on a recommendation it characterizes as a requirement.

---

### [PMF-14] LOW — Disaster Response "Queue Position" Is a Database Count, Not a Dispatch System

**File:** `server/routes/disasterEvents.ts` line 194

The DisasterResponsePage shows the customer's "position in the emergency service queue." The backend counts other accounts that declared emergencies in overlapping states before the current declaration — a pure `SELECT COUNT(*)`. There is no dispatch system, no service rep assignment, no SLA tracking. `Account.serviceRepPhone` exists but is never used in the emergency flow.

---

## Prioritized Fix Order

### Fix immediately before any investor demo or PE diligence review:

1. **PMF-3** — Fix 4 specific seed data domain errors (PPE Cat 4 vs 3, IEEE 1584 date, 138kV/13.8kV, 1500kW/750kW)
2. **INS-3** — Notification log `status: 'sent'` even when all emails fail (systemic silent failure)
3. **INS-1** — Block label generation when PE name is missing (placeholder text on live labels)
4. **INS-2** — Remove "checked the study is valid" language from permit disclaimer
5. **ESP-5** — Mount the arc flash incident register route (the table exists, zero API access)
6. **PMF-11** / **LEG-1** — Remove "Draft" banner from live legal pages + engage counsel
7. **PMF-12** — Remove legacy "Software Renewal Management" branding from ForgotPassword.jsx
8. **PMF-6** — Fix 3 crashing cron jobs (backup chown, ServiceOpportunity Prisma field, weather alert export)
9. **INT-9** — Fix arc-flash labels API envelope mismatch (breaks SDK paginator silently)
10. **INT-10** — Fix `minArcRatingCalCm2` vs `requiredArcRatingCalCm2` SDK type mismatch (live bug)

### Fix before first enterprise customer onboarding:

11. **ESP-1** — LOTO performed-by sign-off (OSHA 1910.147(f)(1) compliance)
12. **ESP-6** — Add energized work justification field to WorkOrder + permit
13. **DB-1** — Paginate `account.findMany()` in digest runner (data breach risk at scale)
14. **DB-6**, **DB-11** — Cross-account queries (security boundary violations)
15. **INT-2** — Work-order import idempotency guard (duplicates on retry)
16. **INT-1** — Add `accountId` to webhook payload
17. **INS-6** — Replace free-text keyword matching with `deficiencyType` enum
18. **INFRA-3** — Fix pre-deploy backup failure swallowing (`|| echo "WARN"`)
19. **UXR-3** — Replace all `window.confirm`/`window.prompt` with `useConfirm` hook
20. **PMF-1**, **PMF-2** — Fix PPE Cat 0 missing, add PE/firm identity to label

### Backlog (address before Series A / acquisition close):

- **LEG-1** through **LEG-11** — All legal documents: counsel review, DPA, trademark filing
- **INFRA-1** through **INFRA-6** — Container CPU limits, queue bus, zero-downtime deploy, secrets management, Postgres HA, streaming backup
- **DB-2** through **DB-5** — N+1 patterns and transaction restructuring
- **PMF-4** — Activate billing infrastructure
- **ESP-2** through **ESP-12** — Full NFPA 70E compliance depth
- **INT-3** through **INT-8** — Integration hardening (signature replay, API scopes, rate limit headers)
- **INS-4** through **INS-15** — Insurance/liability exposure hardening

---

*End of DEMO_LANDMINES_v3.md — 105 findings across 8 personas*
