'use strict';

// tsx/cjs registers TypeScript-aware require() resolution so this CommonJS
// script can load TypeScript library files (e.g. lib/newsScanner.ts) when
// invoked via plain `node` inside the Docker container (which uses tsx for
// runtime compilation but does not pre-compile to a dist/ directory).
try { require('tsx/cjs'); } catch (_) { /* running under tsx already -- no-op */ }

/**
 * scripts/seed-demo.js
 * --------------------
 * Demo data generator for ServiceCycle (electrical equipment maintenance
 * compliance, NFPA 70B:2023). Three entry points:
 *
 *   node server/scripts/seed-demo.js               — one-shot seed (CLI)
 *   const { resetAndSeedDemo } = require(...);     — programmatic, used by the
 *                                                     nightly DEMO_MODE cron and
 *                                                     POST /api/admin/reset-demo
 *   const { seedAccountForUser } = require(...);   — per-visitor sandbox seed,
 *                                                     used by the DEMO_MODE
 *                                                     registration handler in
 *                                                     routes/auth.ts
 *
 * What the full demo seed produces (account pinned to DEMO_ACCOUNT_ID):
 *   - 1 demo Account: "Meridian Manufacturing" — fictional industrial
 *     facility operator (everything below is invented; no real companies)
 *   - 5 users (incl. tech@demo.local / Tech1234!, role field_tech): admin@demo.local (Admin1234!), manager@demo.local
 *     (Manager1234!), viewer@demo.local (Viewer1234!), consultant@demo.local
 *     (Consultant1234!) — roles match the local-part
 *   - The GLOBAL standards library + task matrix via seedStandards() (runs
 *     first so schedules have task definitions to hang off)
 *   - 2 sites demonstrating the flexible hierarchy:
 *       Riverside Plant — full chain: building "Main Production" → areas
 *         "Substation A" / "Mezzanine MCC Room" → named equipment positions
 *         ("SWGR-1A Cubicle 1..4", "XFMR Pad 1"...)
 *       Eastgate Distribution Center — flat: positions hang directly off the
 *         site (no buildings/areas), the small-facility shape
 *   - 2 NETA-accredited contractors with 5 field techs (ANSI/NETA ETT
 *     LEVEL_II..LEVEL_IV)
 *   - 18 assets with per-type nameplateData JSON: 3 liquid transformers,
 *     4 switchgear, 2 generators, 2 dry transformers, 2 MCCs, 1 UPS/battery,
 *     plus 4 taxonomy-expansion types (ATS fed from GEN-1, panelboard,
 *     emergency lighting, switchgear-control battery system). Key assets
 *     carry the 2026-06 risk dimensions (criticalityScore 1-5,
 *     repairCostEstimate, spareLeadTimeWeeks, redundancyStatus,
 *     requiresPredictiveMaintenance) so the priority dashboard tabs have a
 *     story; the rest stay unscored to exercise nulls-last sorting
 *   - maintenance schedules with lastCompletedDate values engineered so
 *     the dashboard tells a story on any reset day:
 *       5 OVERDUE  — one >90 days overdue on the C3 switchgear (regulatory-
 *                    breach alert tier), one ~25d, one ~9d, ATS IR ~18d,
 *                    battery ohmic ~14d
 *       6 due within 30 days (incl. CURRENT ATS monthly transfer test +
 *                    emergency-lighting monthly functional)
 *       5 due within 60–90 days
 *       rest comfortably in the future
 *     nextDueDate is computed locally with the same NFPA 70B condition math
 *     lib/maintenanceInterval.ts uses (see intervalMonthsFor below) — this is
 *     a plain-JS script so the TS module isn't imported.
 *   - 5 work orders: 2 COMPLETE (one GREEN decal, one YELLOW with as-found/
 *     as-left insulation-resistance TestMeasurements and a RECOMMENDED
 *     deficiency), 1 IN_PROGRESS, 2 SCHEDULED (one against the overdue C3
 *     switchgear IR scan)
 *   - 4 deficiencies: 1 IMMEDIATE open (C3 switchgear B-phase hot joint),
 *     2 RECOMMENDED open, 1 ADVISORY resolved
 *   - 1 DGA LabSample (IEEE C57.104 gases incl. O2/N2, detectable C2H2 →
 *     YELLOW caution via Duval D1 arcing rule; ieeeStatus 1 absolute)
 *   - 3 SystemStudies at Riverside: arc_flash ~4.2yr ago (5-year clock →
 *     expiry-warning territory, IEEE 1584-2018 + PE provenance),
 *     short_circuit ~3yr ago, one_line_review ~6mo ago
 *   - 4 AuditVisits (insurance loss-control ~5mo ago passed_with_findings,
 *     internal walkdown ~2mo ago, AHJ fire marshal ~10mo ago passed, and an
 *     UPCOMING insurance survey at Eastgate) with 6 AuditRecommendations
 *   - 3 archived assets (retired SWGR-1A-4 section, decommissioned UPS,
 *     salvaged dry transformer) so the Archived Assets view has content
 *   - 17 Alert rows mirroring what lib/alertEngine.ts would have fired for
 *     the engineered schedules (overdue/escalation/breach ladder + lead-time
 *     tiers, statuses spanning pending/sent/acknowledged) so the Alerts page
 *     renders immediately after a reset instead of waiting for the 07:00 cron
 *   - 2 REAL compliance snapshots (account-wide + Riverside) generated via
 *     lib/snapshotPipeline so downloads verify sha256 against a stored PDF
 *   - ~5 assets carry an owner (admin/manager) for owner-aware alert routing
 *   - 1 BlackoutWindow (planned outage window ~45 days out, 48h)
 *   - ONBOARDING_COMPLETE account setting + a few activity-log rows so the
 *     Activity page isn't empty on first load
 *
 * Reset behaviour: resetAndSeedDemo() deletes the demo account tree child-
 * first (most account FKs are RESTRICT, so no cascade shortcut), then
 * recreates everything. The pinned DEMO_ACCOUNT_ID makes this idempotent and
 * precisely scoped — real tenant accounts are never touched. InstanceConfig
 * is left alone (the admin route / cron stamp demoLastResetAt themselves).
 *
 * All dates are computed relative to NOW so the seeded story stays coherent
 * no matter which day the reset runs.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { addMonths } = require('date-fns');
// Seeded users skip the registration flow that writes activity rows, so a
// fresh demo account would show an empty Activity Log until the first real
// write. Emit a few rows here (same writer the routes use).
const { writeLog: writeActivityLog } = require('../lib/activityLog');
// Global standards library + NFPA 70B / NETA Appendix B task matrix. Runs
// first on every demo seed — idempotent upsert-by-taskCode.
const { seedStandards } = require('./seed-standards');

const prisma = new PrismaClient();

// Pinned ID so the reset path can target this account precisely without
// scanning by name. Valid UUID v4 with a recognisable repeating pattern.
const DEMO_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';

// ── Date / condition helpers ─────────────────────────────────────────────────

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Worst-of reducer over NFPA 70B condition axes — C3 beats C2 beats C1.
// Mirrors lib/maintenanceInterval.ts::worstCondition.
const CONDITION_SEVERITY = { C1: 1, C2: 2, C3: 3 };
function worstCondition(...ratings) {
  let worst = null;
  for (const r of ratings) {
    if (!r || !CONDITION_SEVERITY[r]) continue;
    if (worst === null || CONDITION_SEVERITY[r] > CONDITION_SEVERITY[worst]) worst = r;
  }
  return worst || 'C2';
}

// Months between performances for a given governing condition. Local re-
// derivation of lib/maintenanceInterval.ts::intervalMonthsFor (this is a .js
// script; the TS module isn't importable here). Explicit C1/C3 columns win;
// null columns derive from the C2 base:
//   C1 = min(round(c2 × 2.5), 60)         — 60-month ceiling
//   C3 = max(1, min(round(c2 × 0.25), 12)) — 12-month ceiling, 1-month floor
function intervalMonthsFor(taskDef, condition) {
  const base = taskDef.intervalC2Months;
  if (condition === 'C1') {
    if (taskDef.intervalC1Months != null) return taskDef.intervalC1Months;
    return Math.min(Math.round(base * 2.5), 60);
  }
  if (condition === 'C3') {
    if (taskDef.intervalC3Months != null) return taskDef.intervalC3Months;
    return Math.max(1, Math.min(Math.round(base * 0.25), 12));
  }
  return base;
}

// ── Reset ────────────────────────────────────────────────────────────────────
// Most child→Account FKs are RESTRICT in the ServiceCycle schema, so we can't
// delete the Account and rely on cascade. Delete children explicitly in
// dependency order (leaves → trunk). Each deleteMany is a no-op when nothing
// exists, so this is safe on first run. Kept in sync with
// lib/demoPrune.ts::pruneAccount() — if you add a new owned model, update both.
async function _resetDemoAccount() {
  const filter = { accountId: DEMO_ACCOUNT_ID };

  // Activity/audit rows can carry accountId only, a user join, or an asset
  // join (accountId is SetNull on account delete — orphans would survive).
  await prisma.activityLog.deleteMany({
    where: {
      OR: [
        { accountId: DEMO_ACCOUNT_ID },
        { user:  { accountId: DEMO_ACCOUNT_ID } },
        { asset: { accountId: DEMO_ACCOUNT_ID } },
      ],
    },
  }).catch(() => {});

  // ── Work-order / asset leaves ─────────────────────────────────────────────
  await prisma.alert.deleteMany({ where: filter }).catch(() => {});
  await prisma.testMeasurement.deleteMany({ where: filter }).catch(() => {});
  await prisma.deficiency.deleteMany({ where: filter }).catch(() => {});
  await prisma.labSample.deleteMany({ where: filter }).catch(() => {});
  await prisma.workOrder.deleteMany({ where: filter }).catch(() => {});
  await prisma.maintenanceSchedule.deleteMany({ where: filter }).catch(() => {});
  // Account-scoped CUSTOM task definitions only — global (accountId NULL)
  // matrix rows are shared by every tenant and must survive the reset.
  await prisma.maintenanceTaskDefinition.deleteMany({ where: filter }).catch(() => {});

  // ── Asset-attached leaves ─────────────────────────────────────────────────
  await prisma.customFieldValue.deleteMany({ where: { asset: { accountId: DEMO_ACCOUNT_ID } } }).catch(() => {});
  await prisma.communication.deleteMany({ where: filter }).catch(() => {});
  await prisma.document.deleteMany({ where: filter }).catch(() => {});
  // Arc-flash field records are scalar-FK (no cascade) — clear them explicitly so
  // they don't accumulate across reseeds.
  // 2026-07-08 Run 2 (W1-M5/L7): extended to full parity with lib/demoPrune.ts
  // — this block previously covered only 3 of these 7 tables, so
  // arcFlashIngest/arcFlashIngestBus/protectionCurve/arcFlashIncident rows
  // accumulated across every reseed instead of resetting; arcFlashIncident in
  // particular was being createMany'd again further down this same file
  // without ever being cleared first, duplicating rows on every reseed.
  await prisma.arcFlashIngestBus.deleteMany({ where: filter }).catch(() => {});
  await prisma.arcFlashIngest.deleteMany({ where: filter }).catch(() => {});
  await prisma.deviceTestRecord.deleteMany({ where: filter }).catch(() => {});
  await prisma.arcFlashCollectionTask.deleteMany({ where: filter }).catch(() => {});
  await prisma.protectionCurve.deleteMany({ where: filter }).catch(() => {});
  await prisma.protectiveDevice.deleteMany({ where: filter }).catch(() => {});
  await prisma.arcFlashIncident.deleteMany({ where: filter }).catch(() => {});
  await prisma.asset.deleteMany({ where: filter });

  // ── Hierarchy + site-scoped rows ──────────────────────────────────────────
  await prisma.equipmentPosition.deleteMany({ where: filter }).catch(() => {});
  await prisma.area.deleteMany({ where: filter }).catch(() => {});
  await prisma.building.deleteMany({ where: filter }).catch(() => {});
  await prisma.auditRecommendation.deleteMany({ where: filter }).catch(() => {});
  await prisma.auditVisit.deleteMany({ where: filter }).catch(() => {});
  await prisma.systemStudy.deleteMany({ where: filter }).catch(() => {});
  await prisma.blackoutWindow.deleteMany({ where: filter }).catch(() => {});
  await prisma.quoteRequest.deleteMany({ where: filter }).catch(() => {});
  await prisma.incidentLog.deleteMany({ where: filter }).catch(() => {});
  await prisma.spareInventory.deleteMany({ where: { accountId: filter.accountId } }).catch(() => {});
  await prisma.part.deleteMany({ where: filter }).catch(() => {});
  await prisma.site.deleteMany({ where: filter });

  // ── Contractors ───────────────────────────────────────────────────────────
  await prisma.contractorTech.deleteMany({ where: { contractor: { accountId: DEMO_ACCOUNT_ID } } }).catch(() => {});
  await prisma.contractor.deleteMany({ where: filter });

  // ── Compliance snapshots ──────────────────────────────────────────────────
  // Rows would cascade with the account, but each one points at a REAL stored
  // PDF (seeded via lib/snapshotPipeline.generateSnapshot) that would orphan
  // in document storage on every nightly reset — delete the files first, then
  // the rows explicitly.
  try {
    const { deleteFile } = require('../lib/storage');
    const snaps = await prisma.complianceSnapshot.findMany({
      where: filter, select: { filePath: true },
    });
    for (const s of snaps) {
      try { await deleteFile(s.filePath, filter.accountId); } catch (_) { /* best-effort */ }
    }
  } catch (_) { /* storage module unavailable — rows still wiped below */ }
  await prisma.complianceSnapshot.deleteMany({ where: filter }).catch(() => {});

  // ── Demo disaster events ──────────────────────────────────────────────────
  // 2026-07-13 (pre-go-live review fix): these are guarded by nwsAlertId
  // ('demo-seed-*') so re-running the seed doesn't duplicate them, but that
  // same guard meant they were NEVER deleted on reset -- and every one pins
  // affectedSiteIds to riverside/eastgate's UUIDs, which are freshly
  // regenerated on every reset (site.create with no pinned id, below). Net
  // effect: after the FIRST reseed post-deploy, every seeded disaster event
  // still exists but points at dead site UUIDs, so GET /api/disaster-events'
  // affectedSiteIds-intersection filter (routes/disasterEvents.ts) matches
  // nothing and the Disaster Response page silently goes back to "no active
  // events" -- exactly what these rows exist to prevent. Some of these carry
  // accountId: account.id (grid-failure-eastgate, earthquake-report) and
  // others are accountId-null regional broadcasts, so this can't use the
  // `filter` (accountId-scoped) where-clause above -- match by the nwsAlertId
  // prefix instead, which is demo-seed-only and can never touch a real NWS
  // alert (those use FEMA/NWS's own id format, not this literal prefix).
  await prisma.disasterEvent.deleteMany({ where: { nwsAlertId: { startsWith: 'demo-seed-' } } }).catch(() => {});

  // ── Account-scoped lookups / infra ────────────────────────────────────────
  // [C-13/reseed fix] PartnerEventLog has a required, non-cascading accountId FK;
  // clear it before account.delete() or the reset throws P2003 (partner_event_logs_accountId_fkey).
  await prisma.partnerEventLog.deleteMany({ where: filter }).catch(() => {});
  await prisma.standardRevisionAlert.deleteMany({ where: filter }).catch(() => {});
  await prisma.notificationLog.deleteMany({ where: filter }).catch(() => {});
  await prisma.outboundWebhookDLQ.deleteMany({ where: filter }).catch(() => {});
  await prisma.webhookEndpoint.deleteMany({ where: filter }).catch(() => {});
  await prisma.apiKey.deleteMany({ where: filter }).catch(() => {});
  await prisma.consultantAccess.deleteMany({ where: filter }).catch(() => {});
  await prisma.userInvite.deleteMany({ where: filter }).catch(() => {});
  await prisma.accountSetting.deleteMany({ where: filter }).catch(() => {});
  await prisma.backupLog.deleteMany({ where: filter }).catch(() => {});
  await prisma.customFieldDefinition.deleteMany({ where: filter }).catch(() => {});

  // ── User-scoped leaves, then users, then the account row ─────────────────
  await prisma.alertPreference.deleteMany({ where: { user: { accountId: DEMO_ACCOUNT_ID } } }).catch(() => {});
  await prisma.userPreference.deleteMany({ where: { user: { accountId: DEMO_ACCOUNT_ID } } }).catch(() => {});
  await prisma.aiUsage.deleteMany({ where: { user: { accountId: DEMO_ACCOUNT_ID } } }).catch(() => {});
  await prisma.refreshToken.deleteMany({ where: { user: { accountId: DEMO_ACCOUNT_ID } } }).catch(() => {});
  await prisma.user.deleteMany({ where: filter });

  try {
    await prisma.account.delete({ where: { id: DEMO_ACCOUNT_ID } });
  } catch (err) {
    if (err.code !== 'P2025') throw err; // P2025 = "record not found"
  }
}

// ── Shared populator pieces ──────────────────────────────────────────────────

// Global (accountId NULL) task definitions grouped by equipmentType.
async function _loadGlobalDefsByType(db) {
  const defs = await db.maintenanceTaskDefinition.findMany({
    where: { accountId: null, archivedAt: null },
  });
  const byType = {};
  for (const d of defs) {
    (byType[d.equipmentType] = byType[d.equipmentType] || []).push(d);
  }
  return byType;
}

/**
 * Create one MaintenanceSchedule per (asset, matching global task def).
 *
 * `story` maps "ASSETKEY:TASK_CODE" → { dueIn: days } (engineer the due date
 * relative to now) or { completedAgo: days } (anchor lastCompletedDate; the
 * due date falls wherever the interval math puts it — used for schedules that
 * pair with COMPLETE work orders so the two records agree).
 *
 * Schedules without a story entry get a deterministic future spread starting
 * ~120 days out (clamped so lastCompletedDate is always in the past).
 *
 * Returns { byKey, count } where byKey["T-1:XFMR_DGA"] = created row.
 */
async function _createSchedules(db, accountId, assetsByKey, defsByType, story) {
  const now = new Date();
  const byKey = {};
  let count = 0;
  let spreadIdx = 0;

  for (const [assetKey, asset] of Object.entries(assetsByKey)) {
    const defs = defsByType[asset.equipmentType] || [];
    for (const def of defs) {
      const condition = asset.governingCondition;
      const interval  = intervalMonthsFor(def, condition);
      const s = story[`${assetKey}:${def.taskCode}`];

      let lastCompleted;
      if (s && s.completedAgo != null) {
        lastCompleted = addDays(now, -s.completedAgo);
      } else {
        // Target due offset (days from now; negative = overdue). Default
        // spread keeps non-story schedules comfortably outside the 90-day
        // dashboard horizon, clamped so lastCompleted never lands in the
        // future on short-interval tasks.
        let dueIn = s && s.dueIn != null
          ? s.dueIn
          : 120 + ((spreadIdx++ * 53) % 480);
        const maxDueIn = interval * 30 - 14;
        if (dueIn > maxDueIn) dueIn = maxDueIn;
        lastCompleted = addMonths(addDays(now, dueIn), -interval);
      }

      const row = await db.maintenanceSchedule.create({
        data: {
          accountId,
          assetId:           asset.id,
          taskDefinitionId:  def.id,
          lastCompletedDate: lastCompleted,
          nextDueDate:       addMonths(lastCompleted, interval),
        },
      });
      byKey[`${assetKey}:${def.taskCode}`] = row;
      count++;
    }
  }
  return { byKey, count };
}

// Create an asset, deriving governingCondition = worst of the three axes.
async function _createHistoricalWorkOrders(db, accountId, schedulesByKey, contractorId, techId = null, years = 2) {
  const now = new Date();
  const cutoff = addDays(now, -years * 365);
  const conds = ['C1', 'C1', 'C2', 'C1', 'C2', 'C3'];
  const batch = [];
  let i = 0;
  for (const sched of Object.values(schedulesByKey)) {
    const last = new Date(sched.lastCompletedDate);
    const next = new Date(sched.nextDueDate);
    let intervalDays = Math.round((next - last) / 86400000);
    if (!Number.isFinite(intervalDays) || intervalDays < 30) intervalDays = 365;
    let due = addDays(last, -intervalDays);
    while (due >= cutoff) {
      // On-time rate trends ~80% (oldest) -> ~100% (recent) with a gentle
      // month-to-month wiggle, clamped to 80-100. Endpoint counts on-time as
      // completedDate within a 7-day grace of the due date.
      const recency = Math.max(0, Math.min(1, (due - cutoff) / (now - cutoff)));
      const monthIdx = Math.round((due - cutoff) / (30.44 * 86400000));
      let target = 80 + 20 * recency + 6 * Math.sin(monthIdx * 0.8);
      target = Math.max(80, Math.min(100, target));
      const h = (i * 73 + monthIdx * 17) % 100;
      const lateDays = h < target ? (h % 6) : (12 + (h % 28));
      const completed = addDays(due, lateDays);
      if (completed < now) {
        const c = conds[i % conds.length];
        batch.push({
          accountId,
          scheduleId: sched.id,
          assetId: sched.assetId,
          contractorId: contractorId || null,
          assignedTechId: techId || null,
          status: 'COMPLETE',
          scheduledDate: new Date(due),
          completedDate: completed,
          asFoundCondition: c,
          asLeftCondition: c === 'C3' ? 'C2' : c,
          notes: 'Routine scheduled maintenance completed on cycle; '
            + (c === 'C1' ? 'no deficiencies noted.'
               : c === 'C2' ? 'minor wear within limits, no action required.'
               : 'corrective action taken, condition restored.')
            + ' [history-fill]',
          createdAt: completed,
        });
        i++;
      }
      due = addDays(due, -intervalDays);
    }
  }
  for (let k = 0; k < batch.length; k += 500) {
    await db.workOrder.createMany({ data: batch.slice(k, k + 500) });
  }
  return batch.length;
}
async function _createAsset(db, accountId, spec) {
  const cp = spec.conditionPhysical    || 'C2';
  const cc = spec.conditionCriticality || 'C2';
  const ce = spec.conditionEnvironment || 'C2';
  return db.asset.create({
    data: {
      accountId,
      siteId:               spec.siteId,
      buildingId:           spec.buildingId || null,
      areaId:               spec.areaId || null,
      positionId:           spec.positionId || null,
      // Responsible person (drives owner-aware alert routing + the
      // "equipment owner" answer auditors expect).
      ownerId:              spec.ownerId || null,
      equipmentType:        spec.equipmentType,
      manufacturer:         spec.manufacturer || null,
      model:                spec.model || null,
      serialNumber:         spec.serialNumber || null,
      nameplateData:        spec.nameplateData || null,
      installDate:          spec.installDate || null,
      conditionPhysical:    cp,
      conditionCriticality: cc,
      conditionEnvironment: ce,
      governingCondition:   worstCondition(cp, cc, ce),
      // Risk dimensions (2026-06-07): infrastructure criticality (1-5),
      // financial exposure, resilience posture. All optional — unscored
      // assets exercise the nulls-last sorting paths.
      criticalityScore:              spec.criticalityScore ?? null,
      // Degradation axis (1=good .. 5=severe) + stored DPS. The route layer
      // recomputes priorityScore on every condition write; the seed must set
      // both here or the Degradation-Priority sort and the WorkOrders/Assets
      // condition column read null for the very assets built to tell the
      // degradation story.
      conditionScore:                spec.conditionScore ?? null,
      priorityScore: (spec.conditionScore != null && spec.criticalityScore != null)
        ? spec.conditionScore * spec.criticalityScore
        : null,
      repairCostEstimate:            spec.repairCostEstimate ?? null,
      spareLeadTimeWeeks:            spec.spareLeadTimeWeeks ?? null,
      redundancyStatus:              spec.redundancyStatus || null,
      requiresPredictiveMaintenance: spec.requiresPredictiveMaintenance === true,
      // Power-path link (resolved from fedFromKey by the caller's loop).
      fedFromAssetId:       spec.fedFromAssetId || null,
      notes:                spec.notes || null,
    },
  });
}

// ── Full demo account seed ───────────────────────────────────────────────────

async function _seedAccount() {
  const now = new Date();

  // ── Account + users ───────────────────────────────────────────────────────
  const account = await prisma.account.create({
    data: {
      id:           DEMO_ACCOUNT_ID,
      companyName:  'Meridian Manufacturing',
      status:       'active',
      planType:     'saas',
      planTier:     'mid',
      // Hosted demo showcases the AI maintenance brief; self-host installs
      // keep the default false and opt in via Settings → AI.
      aiBriefEnabled: true,
      fteCount:     380,
      lastActiveAt: now,
      // Service rep contact — shown in Settings and used by the Quote Request
      // feature to pre-fill who to call.
      serviceRepName:  'Jordan Rivera',
      serviceRepEmail: 'service.rep@example-electrical.com',
      serviceRepPhone: '(555) 400-7890',
    },
  });

  const [adminHash, managerHash, viewerHash, consultantHash, techHash] = await Promise.all([
    bcrypt.hash('Admin1234!', 12),
    bcrypt.hash('Manager1234!', 12),
    bcrypt.hash('Viewer1234!', 12),
    bcrypt.hash('Consultant1234!', 12),
    bcrypt.hash('Tech1234!', 12),
  ]);
  // 2026-07-14: admin email set to a REAL inbox (servicecyclehq@gmail.com) so the
  // live demo box actually DELIVERS alert digests here — a controlled live-email
  // test. The seeded overdue MaintenanceSchedules below (dueIn -120/-25/-18/-14/-9)
  // cross the admin alert tiers (-7 escalation, -30, -90 regulatory_breach) every
  // cycle, and those tiers are NEVER preference-suppressed (alertEngine.ts ~L692),
  // so the 07:00 alertEngine cron emails this inbox after each nightly reseed.
  // Requires EMAIL_MOCK=false on the droplet. Login: servicecyclehq@gmail.com / Admin1234!
  const admin = await prisma.user.create({ data: {
    accountId: account.id, name: 'Avery Sandoval', email: 'servicecyclehq@gmail.com',
    passwordHash: adminHash, role: 'admin',
  } });
  const manager = await prisma.user.create({ data: {
    accountId: account.id, name: 'Marcus Webb', email: 'manager@demo.local',
    passwordHash: managerHash, role: 'manager',
  } });
  const viewer = await prisma.user.create({ data: {
    accountId: account.id, name: 'Lena Ortiz', email: 'viewer@demo.local',
    passwordHash: viewerHash, role: 'viewer',
  } });
  const consultant = await prisma.user.create({ data: {
    accountId: account.id, name: 'Theo Brandt', email: 'consultant@demo.local',
    passwordHash: consultantHash, role: 'consultant',
  } });
  // Field-labor login: assigned-jobs-only, default-deny outside /api/field.
  const tech = await prisma.user.create({ data: {
    accountId: account.id, name: 'Terry Vance', email: 'tech@demo.local',
    passwordHash: techHash, role: 'field_tech',
  } });

  // Pre-seeded account — skip the onboarding wizard.
  await prisma.accountSetting.create({
    data: { accountId: account.id, key: 'ONBOARDING_COMPLETE', value: 'true' },
  });

  // Lean demo: most advanced surfaces OFF (the code is intact behind per-account
  // flags — lib/accountFeatures / lib/leanProgram). EXCEPTION: arc_flash_studies
  // is ON — it's the headline feature and the demo seeds a full arc-flash story
  // (studies, source model, devices, NETA drift, labels). Customers can turn it
  // off in their own account. Defaults are written explicitly so the demo is
  // reproducible and survives any future default flip.
  await prisma.accountSetting.createMany({
    data: [
      ...['dga_import',
        'enterprise_trust', 'neta_full_battery',
      ].map((f) => ({ accountId: account.id, key: `feature.${f}`, value: 'false' })),
      { accountId: account.id, key: 'feature.arc_flash_studies', value: 'true' },
      // IR/thermography ON for the demo so the per-asset IR tab + NFPA 70B 7.4 survey
      // surfaces stay visible across reseeds (matches the live-verified IR build).
      { accountId: account.id, key: 'feature.thermography_import', value: 'true' },
      // Dustin approved (2026-07): QEMW wallet ON for the demo only — the QEMW
      // cert-wallet page + the 60d/14d expiry-alert cron have real, varied
      // ContractorTech credential data seeded below to show off.
      { accountId: account.id, key: 'feature.qemw_wallet', value: 'true' },
    ],
    skipDuplicates: true,
  });

  // ── Sites / hierarchy ─────────────────────────────────────────────────────
  // Riverside Plant: the full five-level chain.
  const riverside = await prisma.site.create({ data: {
    accountId: account.id, name: 'Riverside Plant',
    address: '4100 Foundry Road', city: 'Davenport', state: 'IA', postalCode: '52802',
    primaryContactName: 'Marcus Webb', primaryContactEmail: 'manager@demo.local',
    primaryContactPhone: '563-555-0144',
    notes: '24/5 stamping + assembly. Substation A feeds the production floor; mezzanine MCC room is the known dust problem area.',
    oneLineDiagramOnFile: true, oneLineDiagramDate: new Date('2023-08-15'),
  } });
  const mainProduction = await prisma.building.create({ data: {
    accountId: account.id, siteId: riverside.id, name: 'Main Production',
  } });
  const substationA = await prisma.area.create({ data: {
    accountId: account.id, siteId: riverside.id, buildingId: mainProduction.id,
    name: 'Substation A',
  } });
  const mezzanine = await prisma.area.create({ data: {
    accountId: account.id, siteId: riverside.id, buildingId: mainProduction.id,
    name: 'Mezzanine MCC Room',
    notes: 'Adjacent to the grinding line — heavy conductive dust accumulation; filters on the room HVAC chronically overdue.',
  } });

  const posSpecs = [
    { key: 'CUB1',  areaId: substationA.id, name: 'SWGR-1A Cubicle 1', code: 'SWGR-1A-1' },
    { key: 'CUB2',  areaId: substationA.id, name: 'SWGR-1A Cubicle 2', code: 'SWGR-1A-2' },
    { key: 'CUB3',  areaId: substationA.id, name: 'SWGR-1A Cubicle 3', code: 'SWGR-1A-3' },
    // Cubicle 4 is deliberately VACANT — positions persist across asset swaps
    // and this one's occupant was scrapped in 2024.
    { key: 'CUB4',  areaId: substationA.id, name: 'SWGR-1A Cubicle 4', code: 'SWGR-1A-4',
      notes: 'Vacant since the 2024 section replacement project.' },
    { key: 'PAD1',  areaId: substationA.id, name: 'XFMR Pad 1', code: 'XFMR-PAD-1' },
    { key: 'PAD2',  areaId: substationA.id, name: 'XFMR Pad 2', code: 'XFMR-PAD-2' },
    { key: 'SWGR2M', areaId: mezzanine.id,  name: 'SWGR-2M Section 1', code: 'SWGR-2M' },
    { key: 'MCC1',  areaId: mezzanine.id,   name: 'MCC-1 Lineup', code: 'MCC-1' },
  ];
  const rsPos = {};
  for (const p of posSpecs) {
    rsPos[p.key] = await prisma.equipmentPosition.create({ data: {
      accountId: account.id, siteId: riverside.id, areaId: p.areaId,
      name: p.name, code: p.code, notes: p.notes || null,
    } });
  }

  // Eastgate: flat hierarchy — positions hang directly off the site.
  const eastgate = await prisma.site.create({ data: {
    accountId: account.id, name: 'Eastgate Distribution Center',
    address: '880 Logistics Parkway', city: 'Moline', state: 'IL', postalCode: '61265',
    primaryContactName: 'Dotty Reinhart', primaryContactEmail: 'd.reinhart@meridian-demo.local',
    primaryContactPhone: '309-555-0187',
    notes: 'Single-building DC; small enough that buildings/areas are skipped — equipment positions sit directly under the site.',
  } });
  const egPosSpecs = [
    { key: 'MSB',    name: 'Main Switchboard Room', code: 'MSB-1' },
    { key: 'GENPAD', name: 'Generator Yard Pad',    code: 'GEN-E1' },
    { key: 'DOCK',   name: 'Dock Transformer Pad',  code: 'XFMR-E1' },
  ];
  const egPos = {};
  for (const p of egPosSpecs) {
    egPos[p.key] = await prisma.equipmentPosition.create({ data: {
      accountId: account.id, siteId: eastgate.id, areaId: null,
      name: p.name, code: p.code,
    } });
  }

  // ── Contractors + techs ───────────────────────────────────────────────────
  const apex = await prisma.contractor.create({ data: {
    accountId: account.id, name: 'Apex Electrical Testing',
    netaAccredited: true,
    supportEmail: 'dispatch@apextesting-demo.local', supportPhone: '800-555-0102',
    scoreSupport: 5, scoreSatisfaction: 4,
    notes: 'Primary NETA testing partner. Handles annual IR campaign and all substation outage testing.',
  } });
  const apexTechs = {};
  // Qualification provenance (NFPA 70E 110.2(A)(1)): employer designation
  // ~2 years ago, retraining clock ~1 year out (inside the ≤3yr interval).
  // Rios carries thermographer Level II — the insurer minimum for signing
  // IR reports — since she runs the annual IR campaign.
  // qemwDays = days-from-now this tech's QEMW cert (ANSI/NETA EMW-2026) expires.
  // Mix straddles the runQemwAlerts cron tiers (fires at 60d and 14d, ±1-day
  // window): rios comfortably valid; okafor sits ON the 60-day tier; lindgren ON
  // the 14-day tier — so the daily cron actually emits an alert against the demo
  // account. qemwCert=null means "no QEMW credential on file yet" (rios keeps one
  // too so the wallet has a clearly-green row).
  for (const t of [
    { key: 'rios',    name: 'Carmen Rios',    title: 'Field Technician',        level: 'LEVEL_II',  email: 'c.rios@apextesting-demo.local', therm: 'II', qemwCert: 'NETA-QEMW-2025-0417', qemwDays: 400 },
    { key: 'okafor',  name: 'David Okafor',   title: 'Senior Test Technician',  level: 'LEVEL_III', email: 'd.okafor@apextesting-demo.local', qemwCert: 'NETA-QEMW-2022-0139', qemwDays: 60 },
    { key: 'lindgren', name: 'Sofia Lindgren', title: 'Principal Engineer',     level: 'LEVEL_IV',  email: 's.lindgren@apextesting-demo.local', qemwCert: 'NETA-QEMW-2022-0088', qemwDays: 14 },
  ]) {
    apexTechs[t.key] = await prisma.contractorTech.create({ data: {
      contractorId: apex.id, name: t.name, title: t.title,
      netaCertLevel: t.level, email: t.email,
      qualifiedPersonDesignatedAt: addDays(now, -730),
      trainingExpiresAt:           addDays(now, 365),
      thermographerCertLevel:      t.therm || null,
      qemwCertNumber:  t.qemwCert || null,
      qemwExpiresAt:   t.qemwCert ? addDays(now, t.qemwDays) : null,
      qemwIssuingBody: t.qemwCert ? 'NETA' : null,
    } });
  }
  const murphy = await prisma.contractor.create({ data: {
    accountId: account.id, name: 'Murphy Switchgear Services',
    netaAccredited: true,
    supportEmail: 'service@murphyswgr-demo.local', supportPhone: '800-555-0119',
    scoreSupport: 4, scoreSatisfaction: 4,
    notes: 'Switchgear/breaker specialty shop; preferred for retrofit and breaker-shop work.',
  } });
  const murphyTechs = {};
  // tran's QEMW cert is already EXPIRED (renewal lapsed); hale's is comfortably
  // valid — the wallet shows both an expired-red and a valid-green row.
  for (const t of [
    { key: 'tran', name: 'Kim Tran',     title: 'Switchgear Technician', level: 'LEVEL_II',  email: 'k.tran@murphyswgr-demo.local', qemwCert: 'NETA-QEMW-2020-0271', qemwDays: -30 },
    { key: 'hale', name: 'Gabriel Hale', title: 'Lead Field Engineer',   level: 'LEVEL_III', email: 'g.hale@murphyswgr-demo.local', qemwCert: 'NETA-QEMW-2025-0602', qemwDays: 600 },
  ]) {
    murphyTechs[t.key] = await prisma.contractorTech.create({ data: {
      contractorId: murphy.id, name: t.name, title: t.title,
      netaCertLevel: t.level, email: t.email,
      qemwCertNumber:  t.qemwCert || null,
      qemwExpiresAt:   t.qemwCert ? addDays(now, t.qemwDays) : null,
      qemwIssuingBody: t.qemwCert ? 'NETA' : null,
    } });
  }

  // ── Demo-completeness techs: exercise every credential state ────────────────
  // A NETA Level I apprentice, a Level III thermographer, an entry-level (I)
  // thermographer, and one already-LAPSED 70E retraining date so the
  // ContractorDetail cert wallet shows the full NETA level range (I-IV), all
  // three thermographer levels (I/II/III), and an expired-training (red) state.
  apexTechs['delacruz'] = await prisma.contractorTech.create({ data: {
    contractorId: apex.id, name: 'Miguel De La Cruz', title: 'Apprentice Test Technician',
    netaCertLevel: 'LEVEL_I', email: 'm.delacruz@apextesting-demo.local',
    qualifiedPersonDesignatedAt: addDays(now, -300),
    trainingExpiresAt:           addDays(now, -45), // 70E retraining lapsed -> expired (red)
    thermographerCertLevel:      'III',
  } });
  murphyTechs['boyd'] = await prisma.contractorTech.create({ data: {
    contractorId: murphy.id, name: 'Nadia Boyd', title: 'Thermography Technician',
    netaCertLevel: 'LEVEL_II', email: 'n.boyd@murphyswgr-demo.local',
    qualifiedPersonDesignatedAt: addDays(now, -500),
    trainingExpiresAt:           addDays(now, 300),
    thermographerCertLevel:      'I',
  } });

  // ── Assets ────────────────────────────────────────────────────────────────
  // Tier 1 (liquid transformers, switchgear, generators) have global task
  // defs and get schedules. Dry transformers, MCCs, and the UPS string have
  // NO global matrix rows yet — they seed as schedule-less assets on purpose,
  // demonstrating the Tier 2 coverage gap in the demo.
  const assetSpecs = [
    // — Riverside / Substation A —
    { key: 'T-1', siteId: riverside.id, buildingId: mainProduction.id, areaId: substationA.id,
      positionId: rsPos.PAD1.id, equipmentType: 'TRANSFORMER_LIQUID',
      ownerId: manager.id, // owner-aware alert routing demo
      manufacturer: 'Kestrel Power Apparatus', model: 'KPA-2500S', serialNumber: 'KPA-97-18254',
      installDate: new Date('1997-06-12'),
      // Risk profile: single main transformer, no spare, 26-week replacement
      // lead — the worst financial-exposure asset on the books.
      criticalityScore: 5, conditionScore: 3, repairCostEstimate: 850000, spareLeadTimeWeeks: 26,
      redundancyStatus: 'N', requiresPredictiveMaintenance: true,
      nameplateData: { kVA: 2500, primaryVoltage: '13.8 kV delta', secondaryVoltage: '480Y/277 V', impedancePercent: 5.75, oilType: 'mineral', gallons: 690 },
      notes: 'Main plant transformer. Gasket weeping noted at NW radiator flange (open deficiency).' },
    { key: 'T-2', siteId: riverside.id, buildingId: mainProduction.id, areaId: substationA.id,
      positionId: rsPos.PAD2.id, equipmentType: 'TRANSFORMER_LIQUID',
      ownerId: manager.id,
      manufacturer: 'Kestrel Power Apparatus', model: 'KPA-1500S', serialNumber: 'KPA-14-90417',
      installDate: new Date('2014-03-28'),
      criticalityScore: 3, conditionScore: 1, // modest — refurbished, partial backup via T-1
      conditionPhysical: 'C1', // refurbished 2024 — physical axis upgraded; governing stays worst-of
      nameplateData: { kVA: 1500, primaryVoltage: '13.8 kV delta', secondaryVoltage: '480Y/277 V', impedancePercent: 5.5, oilType: 'mineral', gallons: 480 },
      notes: 'Re-gasketed and oil-processed during 2024 outage; physical condition assessed C1.' },
    { key: 'SWGR-1A-1', siteId: riverside.id, buildingId: mainProduction.id, areaId: substationA.id,
      positionId: rsPos.CUB1.id, equipmentType: 'SWITCHGEAR',
      ownerId: admin.id,
      manufacturer: 'NorthStar Switchgear Co.', model: 'NS-MV15', serialNumber: 'NS-96-3311-1',
      installDate: new Date('1996-09-04'),
      // Lead section of the SWGR-1A lineup — 1996 vintage, parts scarce.
      criticalityScore: 4, conditionScore: 4, repairCostEstimate: 250000, spareLeadTimeWeeks: 16,
      requiresPredictiveMaintenance: true,
      nameplateData: { voltageClass: '15 kV', busRating: '1200 A', aic: '25 kA' } },
    { key: 'SWGR-1A-2', siteId: riverside.id, buildingId: mainProduction.id, areaId: substationA.id,
      positionId: rsPos.CUB2.id, equipmentType: 'SWITCHGEAR',
      manufacturer: 'NorthStar Switchgear Co.', model: 'NS-MV15', serialNumber: 'NS-96-3311-2',
      installDate: new Date('1996-09-04'),
      nameplateData: { voltageClass: '15 kV', busRating: '1200 A', aic: '25 kA' } },
    { key: 'SWGR-1A-3', siteId: riverside.id, buildingId: mainProduction.id, areaId: substationA.id,
      positionId: rsPos.CUB3.id, equipmentType: 'SWITCHGEAR',
      manufacturer: 'NorthStar Switchgear Co.', model: 'NS-MV15', serialNumber: 'NS-96-3311-3',
      installDate: new Date('1996-09-04'),
      nameplateData: { voltageClass: '15 kV', busRating: '1200 A', aic: '25 kA' } },
    // — Riverside / Mezzanine MCC Room (the C3 environment story) —
    { key: 'SWGR-2M', siteId: riverside.id, buildingId: mainProduction.id, areaId: mezzanine.id,
      positionId: rsPos.SWGR2M.id, equipmentType: 'SWITCHGEAR',
      ownerId: admin.id, // the C3 problem child routes its alerts to the admin owner too
      manufacturer: 'NorthStar Switchgear Co.', model: 'NS-LV600', serialNumber: 'NS-99-7702',
      installDate: new Date('1999-11-19'),
      conditionEnvironment: 'C3', // dusty mezzanine — governing condition C3
      criticalityScore: 3, conditionScore: 4, repairCostEstimate: 90000, // modest exposure
      nameplateData: { voltageClass: '600 V', busRating: '2000 A', aic: '65 kA' },
      notes: 'Mezzanine dust loading drives the C3 environment rating; IR scan compressed to 6-month interval. B-phase hot joint flagged IMMEDIATE.' },
    { key: 'MCC-1', siteId: riverside.id, buildingId: mainProduction.id, areaId: mezzanine.id,
      positionId: rsPos.MCC1.id, equipmentType: 'MCC',
      manufacturer: 'Pinnacle Drive Systems', model: 'PD-800', serialNumber: 'PD-01-4458',
      installDate: new Date('2001-05-02'),
      nameplateData: { voltage: '480 V', busRating: '800 A', sections: 6, aic: '42 kA' },
      notes: 'No global task matrix rows for MCCs yet (Tier 2) — schedule coverage gap is intentional in the demo.' },
    // — Riverside / Main Production (building-level, no area) —
    { key: 'GEN-1', siteId: riverside.id, buildingId: mainProduction.id,
      equipmentType: 'GENERATOR',
      ownerId: manager.id,
      manufacturer: 'Calder Engine & Generator', model: 'CG-750D', serialNumber: 'CG-05-2210',
      installDate: new Date('2005-08-23'),
      // Life-safety source — top criticality, sole standby unit.
      criticalityScore: 5, conditionScore: 2, repairCostEstimate: 120000, spareLeadTimeWeeks: 12,
      redundancyStatus: 'N',
      nameplateData: { kw: 750, voltage: '480Y/277 V', rpm: 1800, fuelType: 'diesel', tankGallons: 1100 },
      notes: 'Emergency/standby unit for life safety + process ride-through. NFPA 110 monthly exercise mandate.' },
    { key: 'TXD-1', siteId: riverside.id, buildingId: mainProduction.id,
      equipmentType: 'TRANSFORMER_DRY',
      manufacturer: 'Vantage Electric Works', model: 'VE-300DT', serialNumber: 'VE-16-7741',
      installDate: new Date('2016-02-10'),
      nameplateData: { kVA: 300, primaryVoltage: '480 V delta', secondaryVoltage: '208Y/120 V', tempRiseC: 150, kFactor: 'K-13' } },
    { key: 'UPS-1', siteId: riverside.id, buildingId: mainProduction.id,
      equipmentType: 'UPS_BATTERY',
      manufacturer: 'Stonebridge Power Systems', model: 'SB-80U', serialNumber: 'SB-18-0954',
      installDate: new Date('2018-10-30'),
      criticalityScore: 4, conditionScore: 2, repairCostEstimate: 60000, spareLeadTimeWeeks: 8,
      redundancyStatus: 'N_PLUS_1', // second module carries the PLC load during service
      nameplateData: { kVA: 80, voltage: '480 V', batteryType: 'VRLA', strings: 2, cellsPerString: 40 },
      notes: 'Controls UPS for the stamping line PLCs.' },
    // — Riverside: 2026-06 taxonomy-expansion assets (new equipment types) —
    { key: 'ATS-1', siteId: riverside.id, buildingId: mainProduction.id,
      equipmentType: 'TRANSFER_SWITCH',
      ownerId: manager.id,
      fedFromKey: 'GEN-1', // power path: ATS sits downstream of the standby generator
      manufacturer: 'Sentry Transfer Systems', model: 'STS-800A', serialNumber: 'STS-05-1187',
      installDate: new Date('2005-08-23'),
      criticalityScore: 5, conditionScore: 2, repairCostEstimate: 45000, spareLeadTimeWeeks: 10,
      redundancyStatus: 'N',
      nameplateData: { amps: 800, voltage: '480Y/277 V', poles: 4, transitionType: 'open' },
      notes: 'Life-safety ATS between GEN-1 and the emergency distribution. NFPA 110 monthly transfer-test mandate.' },
    { key: 'PNL-1', siteId: riverside.id, buildingId: mainProduction.id,
      equipmentType: 'PANELBOARD',
      manufacturer: 'Vantage Electric Works', model: 'VE-P42', serialNumber: 'VE-21-3308',
      installDate: new Date('2021-04-15'),
      criticalityScore: 2,
      nameplateData: { voltage: '208Y/120 V', mainBreaker: '225 A', circuits: 42 },
      notes: 'Office wing lighting/receptacle panel.' },
    { key: 'ELTG-1', siteId: riverside.id, buildingId: mainProduction.id,
      equipmentType: 'EMERGENCY_LIGHTING',
      manufacturer: 'Beacon Safety Lighting', model: 'BSL-90', serialNumber: 'BSL-19-7724',
      installDate: new Date('2019-06-03'),
      criticalityScore: 4,
      nameplateData: { heads: 24, batteryType: 'NiCd', runtimeMinutes: 90, circuits: 'egress corridors A-D' },
      notes: 'Egress lighting bank, production floor exits. NFPA 101 monthly 30-second functional test.' },
    { key: 'BATT-1', siteId: riverside.id, buildingId: mainProduction.id, areaId: substationA.id,
      equipmentType: 'BATTERY_SYSTEM',
      manufacturer: 'Stonebridge Power Systems', model: 'SB-125DC', serialNumber: 'SB-10-2241',
      installDate: new Date('2010-09-08'),
      criticalityScore: 4, conditionScore: 3, repairCostEstimate: 28000, spareLeadTimeWeeks: 6,
      nameplateData: { voltage: '125 V DC', batteryType: 'flooded lead-acid', cells: 60, chargerAmps: 25 },
      notes: 'Switchgear control battery for Substation A breaker tripping — IEEE 450 vented-cell program: quarterly per-cell float voltage + supplementary ohmic trend, annual capacity test.' },
    // — Eastgate (flat hierarchy) —
    { key: 'T-E1', siteId: eastgate.id, positionId: egPos.DOCK.id,
      equipmentType: 'TRANSFORMER_LIQUID',
      manufacturer: 'Kestrel Power Apparatus', model: 'KPA-1000S', serialNumber: 'KPA-08-33190',
      installDate: new Date('2008-04-17'),
      nameplateData: { kVA: 1000, primaryVoltage: '12.47 kV delta', secondaryVoltage: '480Y/277 V', impedancePercent: 5.16, oilType: 'FR3 natural ester', gallons: 410 } },
    { key: 'GEN-E1', siteId: eastgate.id, positionId: egPos.GENPAD.id,
      equipmentType: 'GENERATOR',
      manufacturer: 'Calder Engine & Generator', model: 'CG-350NG', serialNumber: 'CG-12-5524',
      installDate: new Date('2012-06-05'),
      criticalityScore: 3, repairCostEstimate: 70000, // modest — DC ride-through only
      nameplateData: { kw: 350, voltage: '480Y/277 V', rpm: 1800, fuelType: 'natural gas' } },
    { key: 'TXD-E1', siteId: eastgate.id, positionId: egPos.MSB.id,
      equipmentType: 'TRANSFORMER_DRY',
      manufacturer: 'Vantage Electric Works', model: 'VE-150DT', serialNumber: 'VE-19-9913',
      installDate: new Date('2019-09-12'),
      nameplateData: { kVA: 150, primaryVoltage: '480 V delta', secondaryVoltage: '208Y/120 V', tempRiseC: 115, kFactor: 'K-4' } },
    { key: 'MCC-E1', siteId: eastgate.id,
      equipmentType: 'MCC',
      manufacturer: 'Pinnacle Drive Systems', model: 'PD-600', serialNumber: 'PD-09-8821',
      installDate: new Date('2009-12-01'),
      nameplateData: { voltage: '480 V', busRating: '600 A', sections: 4, aic: '35 kA' } },
    // — Demo-completeness assets: one per remaining EquipmentType so no
    //   classification bucket / equipment report reads empty. FIRE_PUMP_CONTROLLER
    //   and GROUNDING_SYSTEM auto-enroll into the NFPA 25 / IEEE 81 global task
    //   matrix via _createSchedules, filling those two otherwise-empty programs.
    { key: 'SWBD-1', siteId: riverside.id, buildingId: mainProduction.id, areaId: substationA.id,
      equipmentType: 'SWITCHBOARD',
      manufacturer: 'NorthStar Switchgear Co.', model: 'NS-SB416', serialNumber: 'NS-14-5502',
      installDate: new Date('2014-03-19'), criticalityScore: 4, conditionScore: 2,
      nameplateData: { voltage: '4.16 kV', busRating: '2000 A', sections: 5, aic: '50 kA' },
      notes: 'Medium-voltage distribution switchboard feeding the Substation A unit substations.' },
    { key: 'BUS-1', siteId: riverside.id, buildingId: mainProduction.id,
      equipmentType: 'BUSWAY',
      manufacturer: 'Galvan Bus Systems', model: 'GB-1600P', serialNumber: 'GB-17-2231',
      installDate: new Date('2017-07-08'),
      nameplateData: { voltage: '480 V', ampacity: '1600 A', type: 'plug-in', lengthFt: 220 },
      notes: 'Plug-in busway riser serving the stamping-line MCCs.' },
    { key: 'MTR-1', siteId: riverside.id, buildingId: mainProduction.id,
      equipmentType: 'MOTOR',
      manufacturer: 'Crestline Electric Machines', model: 'CE-449T', serialNumber: 'CE-15-8890',
      installDate: new Date('2015-11-02'), criticalityScore: 3, conditionScore: 2,
      nameplateData: { hp: 400, voltage: '460 V', rpm: 1785, frame: '449T', service: 'induced-draft fan' },
      notes: 'ID fan motor on the process exhaust train; driven by VFD-1.' },
    { key: 'VFD-1', siteId: riverside.id, buildingId: mainProduction.id, fedFromKey: 'MCC-1',
      equipmentType: 'VFD',
      manufacturer: 'Pinnacle Drive Systems', model: 'PD-VF400', serialNumber: 'PD-15-9014',
      installDate: new Date('2015-11-02'),
      nameplateData: { hp: 400, voltage: '480 V', ampacity: '477 A', service: 'ID fan drive' },
      notes: 'Variable-frequency drive for the ID fan motor (MTR-1).' },
    { key: 'FSG-1', siteId: eastgate.id,
      equipmentType: 'FUSE_GEAR',
      manufacturer: 'Ironclad Power Products', model: 'IC-FS600', serialNumber: 'IC-11-4471',
      installDate: new Date('2011-05-14'),
      nameplateData: { voltage: '600 V', ampacity: '400 A', fuseClass: 'RK1', switches: 6 },
      notes: 'Fusible-switch distribution cabinet; Class RK1 current-limiting fuses.' },
    { key: 'GFP-1', siteId: riverside.id, buildingId: mainProduction.id, areaId: substationA.id,
      equipmentType: 'GROUND_FAULT_PROTECTION',
      manufacturer: 'Sentinel Protection', model: 'SP-GFP12', serialNumber: 'SP-16-3320',
      installDate: new Date('2016-02-28'),
      nameplateData: { type: 'zero-sequence', pickupA: 1200, standard: 'NEC 230.95' },
      notes: 'Ground-fault protection on the 2000 A service main — NEC 230.95 performance test.' },
    { key: 'SPD-1', siteId: riverside.id, buildingId: mainProduction.id,
      equipmentType: 'SURGE_ARRESTER',
      manufacturer: 'Voltguard Systems', model: 'VG-T1-100', serialNumber: 'VG-20-7761',
      installDate: new Date('2020-08-11'),
      nameplateData: { class: 'Type 1', voltage: '480Y/277 V', ratingKA: 100, modes: 'L-N/L-G/N-G' },
      notes: 'Service-entrance surge protective device at the main switchboard.' },
    { key: 'CBL-LV-1', siteId: eastgate.id,
      equipmentType: 'CABLE_LV',
      manufacturer: 'Copperline Cable', model: '500-XHHW2', serialNumber: 'CL-13-1180',
      installDate: new Date('2013-09-01'),
      nameplateData: { voltage: '600 V', size: '500 kcmil', material: 'Cu', run: 'MSB -> MCC-E1' },
      notes: 'Low-voltage feeder run; annual IR test history tracked.' },
    { key: 'CBL-MV-1', siteId: riverside.id, buildingId: mainProduction.id, areaId: substationA.id,
      equipmentType: 'CABLE_MV_HV', criticalityScore: 4,
      manufacturer: 'Copperline Cable', model: '2/0-EPR-15KV', serialNumber: 'CL-12-6640',
      installDate: new Date('2012-04-22'),
      nameplateData: { voltage: '15 kV', size: '2/0 AWG', insulation: 'EPR 133%', run: 'utility -> SWGR-1A' },
      notes: 'Medium-voltage service cable; VLF / partial-discharge program.' },
    { key: 'TRAY-1', siteId: riverside.id, buildingId: mainProduction.id, areaId: substationA.id,
      equipmentType: 'CABLE_TRAY',
      manufacturer: 'Girder & Rung Co.', model: 'GR-LAD24', serialNumber: 'GR-14-9902',
      installDate: new Date('2014-03-19'),
      nameplateData: { material: 'aluminum ladder', widthIn: 24, fillPercent: 42, run: 'Substation A feeders' },
      notes: 'Cable tray run over Substation A; corrosion / loading inspection.' },
    { key: 'GND-1', siteId: riverside.id, buildingId: mainProduction.id, areaId: substationA.id,
      equipmentType: 'GROUNDING_SYSTEM',
      conditionEnvironment: 'C1', // clean, indoor substation ground grid -> best environment axis
      manufacturer: 'Terrafirm Grounding', model: 'TF-GRID', serialNumber: 'TF-14-5503',
      installDate: new Date('2014-03-19'),
      nameplateData: { type: 'ground grid', resistanceOhms: 1.8, method: 'fall-of-potential', electrodes: 12 },
      notes: 'Substation A ground grid — IEEE 81 fall-of-potential program.' },
    { key: 'AFP-1', siteId: riverside.id, buildingId: mainProduction.id, areaId: substationA.id,
      equipmentType: 'ARC_FLASH_PANEL',
      manufacturer: 'Sentinel Protection', model: 'SP-ARC751', serialNumber: 'SP-19-8140',
      installDate: new Date('2019-10-05'),
      nameplateData: { type: 'remote-racking + arc-flash relay', zones: 4, relay: 'SEL-751' },
      notes: 'Arc-flash mitigation panel (remote racking + light-sensing relay) for SWGR-1A.' },
    { key: 'FPC-1', siteId: riverside.id, buildingId: mainProduction.id,
      equipmentType: 'FIRE_PUMP_CONTROLLER',
      criticalityScore: 5, conditionScore: 2, redundancyStatus: 'N',
      manufacturer: 'Redland Fire Controls', model: 'RF-EFC100', serialNumber: 'RF-13-2205',
      installDate: new Date('2013-06-17'),
      nameplateData: { hp: 100, voltage: '480 V', type: 'electric across-the-line', pumpGpm: 1500, standard: 'NFPA 20/25' },
      notes: 'Electric fire-pump controller — NFPA 25 weekly churn + annual flow program.' },
    { key: 'DISC-1', siteId: eastgate.id,
      equipmentType: 'DISCONNECT_SWITCH',
      manufacturer: 'Ironclad Power Products', model: 'IC-DS400', serialNumber: 'IC-12-7788',
      installDate: new Date('2012-05-14'),
      nameplateData: { voltage: '600 V', ampacity: '400 A', type: 'fused load-break', poles: 3 },
      notes: 'Fused load-break disconnect ahead of the dock MCC.' },
    { key: 'RLY-1', siteId: riverside.id, buildingId: mainProduction.id, areaId: substationA.id,
      equipmentType: 'PROTECTION_RELAY',
      manufacturer: 'Sentinel Protection', model: 'SEL-751', serialNumber: 'SEL-18-4417',
      installDate: new Date('2018-01-30'),
      nameplateData: { type: 'multifunction feeder relay', functions: '50/51/87', comms: 'IEC 61850' },
      notes: 'Feeder protection relay on SWGR-1A — calibration vs coordination-study settings.' },
  ];

  const assets = {};
  for (const spec of assetSpecs) {
    // Power-path links reference earlier specs by key (specs are created in
    // array order, so the upstream asset always exists by the time its
    // downstream spec resolves — ATS-1 is fed from GEN-1).
    if (spec.fedFromKey) spec.fedFromAssetId = assets[spec.fedFromKey].id;
    assets[spec.key] = await _createAsset(prisma, account.id, spec);
  }

  // ── Schedules — the dashboard story ───────────────────────────────────────
  // dueIn = days from now until nextDueDate (negative = overdue).
  // completedAgo anchors lastCompletedDate to pair with COMPLETE work orders.
  //
  // Engineered buckets:
  //   OVERDUE (6):  SWGR-2M IR scan 120d overdue (C3 + >90d ⇒ regulatory-
  //                 breach alert tier), T-1 oil screen 25d, GEN-1 load bank 9d,
  //                 ATS-1 IR 18d, BATT-1 ohmic 14d, SWGR-2M insulation ~418d
  //                 (via its completedAgo: 600 WO #16 anchor below)
  //   ≤30d (3):     GEN-1 monthly exercise (~10d, via 20d-ago completion),
  //                 T-2 DGA 22d, GEN-E1 monthly exercise 6d
  //   60–90d (3):   SWGR-1A-3 IR 64d, GEN-E1 fuel analysis 70d, T-1 TTR 75d
  //   future:       everything else spreads deterministically from ~120d out
  const story = {
    // overdue
    'SWGR-2M:SWGR_IR_THERMO':       { dueIn: -120 },
    'T-1:XFMR_OIL_QUALITY':         { dueIn: -25 },
    'GEN-1:GEN_LOAD_BANK':          { dueIn: -9 },
    'ATS-1:ATS_IR_THERMO':          { dueIn: -18 },        // taxonomy-expansion: ATS scan slipped
    'BATT-1:BATT_OHMIC_FLOAT':      { dueIn: -14 },        // quarterly ohmic ~2 weeks overdue
    // due within 30 days
    'GEN-1:GEN_MONTHLY_EXERCISE':   { completedAgo: 20 }, // due ≈ +10d; pairs with WO #1
    'T-2:XFMR_DGA':                 { dueIn: 22 },
    'GEN-E1:GEN_MONTHLY_EXERCISE':  { dueIn: 6 },
    'ATS-1:ATS_MONTHLY_TRANSFER':   { completedAgo: 12 }, // monthly transfer test CURRENT, due ≈ +18d
    'ELTG-1:ELTG_MONTHLY_FUNCTIONAL': { completedAgo: 10 }, // monthly functional CURRENT, due ≈ +20d
    // due in 60–90 days
    'SWGR-1A-3:SWGR_IR_THERMO':     { dueIn: 64 },
    'GEN-E1:GEN_FUEL_ANALYSIS':     { dueIn: 70 },
    'T-1:XFMR_TTR':                 { dueIn: 75 },
    // anchors for the COMPLETE work orders below
    'SWGR-1A-1:SWGR_INSULATION_RES': { completedAgo: 45 }, // pairs with WO #2 (YELLOW)
    'T-2:XFMR_INSULATION_RES':       { completedAgo: 30 }, // pairs with WO #1 (GREEN)
    // 24-month history anchors (populate the EMP maintenance-history section)
    'T-1:XFMR_DGA':                  { completedAgo: 90 },
    'T-1:XFMR_INSULATION_RES':       { completedAgo: 400 },
    'T-E1:XFMR_INSULATION_RES':      { completedAgo: 550 },
    'SWGR-1A-1:SWGR_IR_THERMO':      { completedAgo: 365 },
    'SWGR-1A-2:SWGR_INSULATION_RES': { completedAgo: 120 },
    'SWGR-1A-3:SWGR_INSULATION_RES': { completedAgo: 380 },
    'SWGR-1A-2:SWGR_IR_THERMO':      { completedAgo: 210 }, // pairs with WO #12; due ~ +155d
    'T-E1:XFMR_DGA':                 { completedAgo: 200 }, // pairs with WO #8; due ~ +165d
    // Pairs with WO #16 (the last documented test). 6-month C3 interval puts
    // this ~418d overdue -- the mezzanine problem child's insulation-resistance
    // program lapsed along with everything else on that lineup.
    'SWGR-2M:SWGR_INSULATION_RES':   { completedAgo: 600 },
    'T-2:XFMR_OIL_QUALITY':          { completedAgo: 150 },
    // GEN-E1:GEN_FUEL_ANALYSIS skipped -- dueIn:70 entry above drives the
    // dashboard; WO #20 uses its own completedDate for EMP history.
  };

  const defsByType = await _loadGlobalDefsByType(prisma);
  const { byKey: schedules, count: scheduleCount } =
    await _createSchedules(prisma, account.id, assets, defsByType, story);
  const _histWO = await _createHistoricalWorkOrders(prisma, account.id, schedules, apex.id, apexTechs.okafor.id, 2);
  console.log('  seeded ' + _histWO + ' historical work orders (2yr, attributed)');

  // ── Archived assets (G2) ──────────────────────────────────────────────────
  // Retired equipment so the Archived Assets view (?archived=true) isn't
  // empty. Created AFTER _createSchedules and kept out of the `assets` map so
  // they get no schedules/work orders. Same accountId filter wipes them on
  // reset. SWGR-1A-4 is the scrapped occupant of the deliberately-vacant
  // Cubicle 4 position (positionId stays null — the position stays vacant).
  const archivedSpecs = [
    { spec: { siteId: riverside.id, buildingId: mainProduction.id, areaId: substationA.id,
        equipmentType: 'SWITCHGEAR',
        manufacturer: 'NorthStar Switchgear Co.', model: 'NS-MV15', serialNumber: 'NS-96-3311-4',
        installDate: new Date('1996-09-04'),
        nameplateData: { voltageClass: '15 kV', busRating: '1200 A', aic: '25 kA' },
        notes: 'Former SWGR-1A Cubicle 4 section. Scrapped during the 2024 section replacement project after arc-damage assessment found the bus bracing uneconomical to repair.' },
      archivedAgo: 550 },
    { spec: { siteId: riverside.id, buildingId: mainProduction.id,
        equipmentType: 'UPS_BATTERY',
        manufacturer: 'Stonebridge Power Systems', model: 'SB-60U', serialNumber: 'SB-09-4417',
        installDate: new Date('2009-03-12'),
        nameplateData: { kVA: 60, voltage: '480 V', batteryType: 'VRLA', strings: 1, cellsPerString: 40 },
        notes: 'Original stamping-line controls UPS, replaced by SB-80U (UPS-1). Battery string beyond end-of-life; unit decommissioned and removed.' },
      archivedAgo: 200 },
    { spec: { siteId: eastgate.id,
        equipmentType: 'TRANSFORMER_DRY',
        manufacturer: 'Vantage Electric Works', model: 'VE-75DT', serialNumber: 'VE-03-1108',
        installDate: new Date('2003-07-22'),
        nameplateData: { kVA: 75, primaryVoltage: '480 V delta', secondaryVoltage: '208Y/120 V', tempRiseC: 150 },
        notes: 'Fed the old dock office wing; load removed in the renovation. De-energized, disconnected, and released for salvage.' },
      archivedAgo: 90 },
  ];
  let archivedAssetCount = 0;
  for (const { spec, archivedAgo } of archivedSpecs) {
    const a = await _createAsset(prisma, account.id, spec);
    await prisma.asset.update({
      where: { id: a.id },
      data:  { archivedAt: addDays(now, -archivedAgo) },
    });
    archivedAssetCount++;
  }

  // ── Work orders ───────────────────────────────────────────────────────────
  // Test-condition + instrument provenance for the COMPLETE jobs (NETA MTS
  // §5.4.2 #4, §5.3): ambient readings + a calibrated DLRO and IR camera.
  // Calibration dates computed relative to NOW so they stay inside the
  // 12-months-of-test-date window on every reset.
  const testEquipmentProvenance = [
    { make: 'Veritas Instruments', model: 'VI-DLRO 200 micro-ohmmeter',
      serial: 'VI-23-08841', calDate: addDays(now, -140).toISOString().slice(0, 10) },
    { make: 'Thermoline Optics',   model: 'TX-640 thermal imager',
      serial: 'TX-21-5527',  calDate: addDays(now, -95).toISOString().slice(0, 10) },
  ];

  // WO #1 — COMPLETE, GREEN decal: T-2 insulation resistance + PI (Apex).
  const wo1 = await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['T-2:XFMR_INSULATION_RES'].id,
    assetId: assets['T-2'].id,
    contractorId: apex.id, assignedTechId: apexTechs.rios.id,
    netaCertLevel: 'LEVEL_II',
    status: 'COMPLETE',
    scheduledDate: addDays(now, -32), startedAt: addDays(now, -30), completedDate: addDays(now, -30),
    asFoundCondition: 'C1', asLeftCondition: 'C1',
    netaDecal: 'GREEN',
    ambientTempC: 21.5, humidityPct: 41.0,
    testEquipment: testEquipmentProvenance,
    notes: 'IR + PI on both windings well above IEEE minimums post-refurb. No findings.',
  } });

  // WO #2 — COMPLETE, YELLOW decal: SWGR-1A-1 insulation resistance (Murphy).
  // Carries NETA MTS 5.4 as-found/as-left TestMeasurements and spawns a
  // RECOMMENDED deficiency on the low C-phase reading.
  const wo2 = await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['SWGR-1A-1:SWGR_INSULATION_RES'].id,
    assetId: assets['SWGR-1A-1'].id,
    contractorId: murphy.id, assignedTechId: murphyTechs.tran.id,
    netaCertLevel: 'LEVEL_II',
    status: 'COMPLETE',
    scheduledDate: addDays(now, -47), startedAt: addDays(now, -45), completedDate: addDays(now, -45),
    asFoundCondition: 'C2', asLeftCondition: 'C2',
    netaDecal: 'YELLOW',
    ambientTempC: 17.5, humidityPct: 56.0,
    testEquipment: testEquipmentProvenance,
    notes: 'C-phase bus IR trending low vs. 2024 baseline; cleaned and re-tested — improved but still below adjacent phases. Deficiency logged.',
  } });
  const wo2Measurements = [
    { phase: 'A-G', asFound: 5200, asLeft: 5400, passFail: 'GREEN' },
    { phase: 'B-G', asFound: 4800, asLeft: 5100, passFail: 'GREEN' },
    { phase: 'C-G', asFound: 620,  asLeft: 890,  passFail: 'YELLOW',
      notes: 'Low vs. adjacent phases (>80% deviation). Suspect surface contamination / moisture ingress at roof penetration.' },
  ];
  for (const m of wo2Measurements) {
    await prisma.testMeasurement.create({ data: {
      accountId: account.id, workOrderId: wo2.id,
      measurementType: 'insulation_resistance', phase: m.phase,
      asFoundValue: m.asFound, asFoundUnit: 'MΩ',
      asLeftValue: m.asLeft,  asLeftUnit: 'MΩ',
      passFail: m.passFail, notes: m.notes || null,
    } });
  }

  // WO #3 — IN_PROGRESS: GEN-1 load bank test (9 days overdue, Apex on site).
  const wo3 = await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['GEN-1:GEN_LOAD_BANK'].id,
    assetId: assets['GEN-1'].id,
    contractorId: apex.id, assignedTechId: apexTechs.okafor.id,
    // Field-tech world (2026-07-03): Terry Vance owns the in-app capture for
    // this job -- it appears in his /field "My Jobs" as the in-progress item.
    assignedUserId: tech.id,
    status: 'IN_PROGRESS',
    scheduledDate: addDays(now, -1), startedAt: addDays(now, -1),
    notes: 'Load bank staged in generator yard; 50%/75% kW steps per NFPA 110 §8.4.2.3 running today -- clearing the load-bank task that came due 9 days ago (monthly NFPA 110 exercise remains current, completed ~20 days ago).',
  } });

  // WO #4 — SCHEDULED against the 120-day-overdue C3 switchgear IR scan.
  const wo4 = await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['SWGR-2M:SWGR_IR_THERMO'].id,
    assetId: assets['SWGR-2M'].id,
    contractorId: apex.id, assignedTechId: apexTechs.rios.id,
    netaCertLevel: 'LEVEL_II',
    status: 'SCHEDULED',
    scheduledDate: addDays(now, 21),
    notes: 'Catch-up IR scan for the overdue mezzanine lineup. Scan under ≥40% load; B-phase hot joint (IMMEDIATE deficiency) to be re-imaged first.',
  } });

  // WO #5 — SCHEDULED: SWGR-1A-1 contact resistance during the outage window.
  const wo5 = await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['SWGR-1A-1:SWGR_CONTACT_RES'].id,
    assetId: assets['SWGR-1A-1'].id,
    contractorId: murphy.id, assignedTechId: murphyTechs.hale.id,
    netaCertLevel: 'LEVEL_II',
    status: 'SCHEDULED',
    scheduledDate: addDays(now, 46), // inside the annual production outage window
    notes: 'De-energized micro-ohm survey of bus joints; aligned to the annual production shutdown window.',
  } });

  // ── Work orders: 24-month history (WOs #6-#22) ────────────────────────────
  // These populate the EMP Section 5b maintenance-history table and give the
  // Compliance by Standard / Activity reports meaningful data to render.

  // WO #6 -- COMPLETE: T-1 dissolved-gas analysis 90 days ago (Apex, C2 YELLOW).
  // Detectable C2H2 triggers a YELLOW caution (Duval D1 arcing rule) -- matches the LabSample story.
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['T-1:XFMR_DGA'].id,
    assetId: assets['T-1'].id,
    contractorId: apex.id, assignedTechId: apexTechs.rios.id,
    netaCertLevel: 'LEVEL_II',
    status: 'COMPLETE',
    scheduledDate: addDays(now, -92), startedAt: addDays(now, -90), completedDate: addDays(now, -90),
    asFoundCondition: 'C2', asLeftCondition: 'C2',
    netaDecal: 'YELLOW',
    ambientTempC: 20.0, humidityPct: 44.0,
    testEquipment: testEquipmentProvenance,
    notes: 'DGA oil sample collected per IEEE C57.104; C2H2 at 2.8 ppm (newly detectable vs. <0.5 ppm prior baseline). YELLOW decal applied: individual gases within Condition 1 absolute limits, but detectable acetylene = Duval D1 low-energy arcing -> caution. Resample in 90 days recommended.',
  } });

  // WO #7 -- COMPLETE: T-1 insulation resistance + PI ~13 months ago (Murphy, C1 GREEN).
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['T-1:XFMR_INSULATION_RES'].id,
    assetId: assets['T-1'].id,
    contractorId: murphy.id, assignedTechId: murphyTechs.hale.id,
    netaCertLevel: 'LEVEL_II',
    status: 'COMPLETE',
    scheduledDate: addDays(now, -402), startedAt: addDays(now, -400), completedDate: addDays(now, -400),
    asFoundCondition: 'C1', asLeftCondition: 'C1',
    netaDecal: 'GREEN',
    ambientTempC: 19.5, humidityPct: 38.0,
    testEquipment: testEquipmentProvenance,
    notes: 'Insulation resistance + polarisation index on HV and LV windings; all readings above IEEE 43 minimums for transformer age and kV class. No findings.',
  } });

  // WO #8 -- COMPLETE: T-E1 DGA ~6.5 months ago (Apex, C1 GREEN).
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['T-E1:XFMR_DGA'].id,
    assetId: assets['T-E1'].id,
    contractorId: apex.id, assignedTechId: apexTechs.okafor.id,
    netaCertLevel: 'LEVEL_II',
    status: 'COMPLETE',
    scheduledDate: addDays(now, -202), startedAt: addDays(now, -200), completedDate: addDays(now, -200),
    asFoundCondition: 'C1', asLeftCondition: 'C1',
    netaDecal: 'GREEN',
    ambientTempC: 18.5, humidityPct: 40.0,
    testEquipment: testEquipmentProvenance,
    notes: 'Annual DGA on FR3 natural-ester oil per IEEE C57.104; all gases within Condition 1 limits. Oil chemistry healthy -- no furfural detected.',
  } });

  // WO #9 -- COMPLETE: T-E1 insulation resistance ~18 months ago (Murphy, C1 GREEN).
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['T-E1:XFMR_INSULATION_RES'].id,
    assetId: assets['T-E1'].id,
    contractorId: murphy.id, assignedTechId: murphyTechs.tran.id,
    netaCertLevel: 'LEVEL_II',
    status: 'COMPLETE',
    scheduledDate: addDays(now, -552), startedAt: addDays(now, -550), completedDate: addDays(now, -550),
    asFoundCondition: 'C1', asLeftCondition: 'C1',
    netaDecal: 'GREEN',
    ambientTempC: 17.0, humidityPct: 35.0,
    testEquipment: testEquipmentProvenance,
    notes: 'IR + PI on Eastgate 1000 kVA transformer; PI > 2.0 on both windings. Asset in excellent condition for installation age.',
  } });

  // WO #10 -- COMPLETE: SWGR-1A-1 IR thermography ~12 months ago (Apex, C2 YELLOW).
  // Moderate hotspot found, noted but within NETA MTS acceptable range.
  // Bound to a variable: deficiency def5 below is the finding this WO logged.
  const wo10 = await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['SWGR-1A-1:SWGR_IR_THERMO'].id,
    assetId: assets['SWGR-1A-1'].id,
    contractorId: apex.id, assignedTechId: apexTechs.rios.id,
    netaCertLevel: 'LEVEL_II',
    status: 'COMPLETE',
    scheduledDate: addDays(now, -367), startedAt: addDays(now, -365), completedDate: addDays(now, -365),
    asFoundCondition: 'C2', asLeftCondition: 'C2',
    netaDecal: 'YELLOW',
    ambientTempC: 22.0, humidityPct: 48.0,
    testEquipment: testEquipmentProvenance,
    notes: 'Annual IR thermography under 62% load. C-phase cubicle 1 main bus joint showing delta-T 14 deg C above ambient -- NETA MTS Table 100.18: probable deficiency, repair as time permits (11-20 deg C over-ambient band). Deficiency logged.',
  } });

  // WO #11 -- COMPLETE: SWGR-1A-2 insulation resistance ~4 months ago (Murphy, C1 GREEN).
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['SWGR-1A-2:SWGR_INSULATION_RES'].id,
    assetId: assets['SWGR-1A-2'].id,
    contractorId: murphy.id, assignedTechId: murphyTechs.hale.id,
    netaCertLevel: 'LEVEL_II',
    status: 'COMPLETE',
    scheduledDate: addDays(now, -122), startedAt: addDays(now, -120), completedDate: addDays(now, -120),
    asFoundCondition: 'C1', asLeftCondition: 'C1',
    netaDecal: 'GREEN',
    ambientTempC: 16.5, humidityPct: 42.0,
    testEquipment: testEquipmentProvenance,
    notes: 'Phase-to-ground insulation resistance survey on Substation A cubicles 2. All phases > 5 GΩ. No findings; GREEN decal.',
  } });

  // WO #12 -- COMPLETE: SWGR-1A-2 IR thermography ~7 months ago (Apex, C1 GREEN).
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['SWGR-1A-2:SWGR_IR_THERMO'].id,
    assetId: assets['SWGR-1A-2'].id,
    contractorId: apex.id, assignedTechId: apexTechs.okafor.id,
    netaCertLevel: 'LEVEL_II',
    status: 'COMPLETE',
    scheduledDate: addDays(now, -212), startedAt: addDays(now, -210), completedDate: addDays(now, -210),
    asFoundCondition: 'C1', asLeftCondition: 'C1',
    netaDecal: 'GREEN',
    ambientTempC: 21.0, humidityPct: 43.0,
    testEquipment: testEquipmentProvenance,
    notes: 'IR scan at 70% load; all bus joints and connections within NETA MTS Table 100.18 limits (< 1 deg C differential -- no action). No corrective action required.',
  } });

  // WO #13 -- COMPLETE: SWGR-1A-3 insulation resistance ~12.5 months ago (Murphy, C1 GREEN).
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['SWGR-1A-3:SWGR_INSULATION_RES'].id,
    assetId: assets['SWGR-1A-3'].id,
    contractorId: murphy.id, assignedTechId: murphyTechs.tran.id,
    netaCertLevel: 'LEVEL_II',
    status: 'COMPLETE',
    scheduledDate: addDays(now, -382), startedAt: addDays(now, -380), completedDate: addDays(now, -380),
    asFoundCondition: 'C1', asLeftCondition: 'C1',
    netaDecal: 'GREEN',
    ambientTempC: 18.0, humidityPct: 36.0,
    testEquipment: testEquipmentProvenance,
    notes: 'Cubicle 3 insulation resistance survey; all results well above NETA MTS minimum acceptance criteria.',
  } });

  // WO #14 -- COMPLETE: SWGR-1A-3 IR thermography ~18 months ago (Apex, C1 GREEN).
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['SWGR-1A-3:SWGR_IR_THERMO'].id,
    assetId: assets['SWGR-1A-3'].id,
    contractorId: apex.id, assignedTechId: apexTechs.rios.id,
    netaCertLevel: 'LEVEL_II',
    status: 'COMPLETE',
    scheduledDate: addDays(now, -542), startedAt: addDays(now, -540), completedDate: addDays(now, -540),
    asFoundCondition: 'C1', asLeftCondition: 'C1',
    netaDecal: 'GREEN',
    ambientTempC: 20.5, humidityPct: 39.0,
    testEquipment: testEquipmentProvenance,
    notes: 'Annual thermographic survey of Substation A cubicle 3 under load. No elevated temperatures detected. All connections within NETA Table 100.18 limits (no action).',
  } });

  // WO #15 -- COMPLETE: SWGR-2M IR thermography ~12 months ago (Apex, C2 YELLOW).
  // Mezzanine C3 environment with dust loading; scan showed early hotspot at B-phase.
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['SWGR-2M:SWGR_IR_THERMO'].id,
    assetId: assets['SWGR-2M'].id,
    contractorId: apex.id, assignedTechId: apexTechs.okafor.id,
    netaCertLevel: 'LEVEL_II',
    status: 'COMPLETE',
    scheduledDate: addDays(now, -352), startedAt: addDays(now, -350), completedDate: addDays(now, -350),
    asFoundCondition: 'C2', asLeftCondition: 'C2',
    netaDecal: 'YELLOW',
    ambientTempC: 27.0, humidityPct: 55.0,
    testEquipment: testEquipmentProvenance,
    notes: 'Mezzanine lineup IR scan at 55% load. B-phase bus connection showing delta-T 12 deg C -- NETA MTS Table 100.18: probable deficiency, repair as time permits. Deficiency logged as RECOMMENDED; follow-up scan required at next scheduled interval.',
  } });

  // WO #16 -- COMPLETE: SWGR-2M insulation resistance ~20 months ago (Murphy, C2 YELLOW).
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['SWGR-2M:SWGR_INSULATION_RES'].id,
    assetId: assets['SWGR-2M'].id,
    contractorId: murphy.id, assignedTechId: murphyTechs.hale.id,
    netaCertLevel: 'LEVEL_II',
    status: 'COMPLETE',
    scheduledDate: addDays(now, -602), startedAt: addDays(now, -600), completedDate: addDays(now, -600),
    asFoundCondition: 'C2', asLeftCondition: 'C2',
    netaDecal: 'YELLOW',
    ambientTempC: 29.0, humidityPct: 60.0,
    testEquipment: testEquipmentProvenance,
    notes: 'Mezzanine lineup C3 environment -- compressed 6-month interval. Insulation values acceptable but trending lower vs. prior cycle; surface contamination from airborne particulates suspected. Cleaning performed.',
  } });

  // WO #17 -- COMPLETE: GEN-1 monthly exercise ~20 days ago (Apex, C1 GREEN).
  // Pairs with schedule anchor completedAgo: 20.
  const wo17 = await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['GEN-1:GEN_MONTHLY_EXERCISE'].id,
    assetId: assets['GEN-1'].id,
    contractorId: apex.id, assignedTechId: apexTechs.okafor.id,
    status: 'COMPLETE',
    scheduledDate: addDays(now, -22), startedAt: addDays(now, -20), completedDate: addDays(now, -20),
    asFoundCondition: 'C1', asLeftCondition: 'C1',
    netaDecal: 'GREEN',
    notes: 'NFPA 110 monthly exercise at 30-minute rated load. Engine started on first attempt; transfer to utility within spec (< 10 s). Oil, coolant, and battery checks satisfactory. Governor calibration (re-adjusted after the prior overspeed-trip finding) confirmed stable -- no faults this cycle.',
  } });

  // WO #18 -- COMPLETE: GEN-E1 monthly exercise ~24 days ago (Apex, C1 GREEN).
  // Pairs with schedule anchor dueIn: 6 (lastCompleted = ~24 days ago).
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['GEN-E1:GEN_MONTHLY_EXERCISE'].id,
    assetId: assets['GEN-E1'].id,
    contractorId: apex.id, assignedTechId: apexTechs.rios.id,
    status: 'COMPLETE',
    scheduledDate: addDays(now, -26), startedAt: addDays(now, -24), completedDate: addDays(now, -24),
    asFoundCondition: 'C1', asLeftCondition: 'C1',
    netaDecal: 'GREEN',
    notes: 'Monthly natural-gas generator exercise; Eastgate distribution. Transfer test at 100% nameplate load for 30 minutes. No faults recorded.',
  } });

  // WO #19 -- COMPLETE: GEN-1 fuel analysis ~6 months ago (Murphy, C1 GREEN).
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['GEN-1:GEN_FUEL_ANALYSIS'].id,
    assetId: assets['GEN-1'].id,
    contractorId: murphy.id, assignedTechId: murphyTechs.hale.id,
    status: 'COMPLETE',
    scheduledDate: addDays(now, -182), startedAt: addDays(now, -180), completedDate: addDays(now, -180),
    asFoundCondition: 'C1', asLeftCondition: 'C1',
    netaDecal: 'GREEN',
    notes: 'Annual diesel fuel analysis per NFPA 110 A.8.5.2; fuel stability, water content, and microbial growth all within ASTM D975 limits. Fuel polishing not required.',
  } });

  // WO #20 -- COMPLETE: GEN-E1 fuel analysis ~11 months ago (Apex, C1 GREEN).
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['GEN-E1:GEN_FUEL_ANALYSIS'].id,
    assetId: assets['GEN-E1'].id,
    contractorId: apex.id, assignedTechId: apexTechs.okafor.id,
    status: 'COMPLETE',
    scheduledDate: addDays(now, -332), startedAt: addDays(now, -330), completedDate: addDays(now, -330),
    asFoundCondition: 'C1', asLeftCondition: 'C1',
    netaDecal: 'GREEN',
    notes: 'Natural-gas generator: annual fuel train and governor inspection. Gas pressure at rated spec; governor response within NFPA 110 tolerance. Block heater and battery float charger confirmed operational.',
  } });

  // WO #21 -- COMPLETE: T-2 oil quality ~5 months ago (Murphy, C2 YELLOW).
  // Elevated moisture triggers YELLOW; dehydration recommended.
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['T-2:XFMR_OIL_QUALITY'].id,
    assetId: assets['T-2'].id,
    contractorId: murphy.id, assignedTechId: murphyTechs.tran.id,
    netaCertLevel: 'LEVEL_II',
    status: 'COMPLETE',
    scheduledDate: addDays(now, -152), startedAt: addDays(now, -150), completedDate: addDays(now, -150),
    asFoundCondition: 'C2', asLeftCondition: 'C2',
    netaDecal: 'YELLOW',
    ambientTempC: 15.5, humidityPct: 70.0,
    testEquipment: testEquipmentProvenance,
    notes: 'Annual oil quality screen per ASTM D1816; moisture content 28 ppm (IEEE C57.106 Class I for <=69 kV class; <=35 ppm limit). Dielectric breakdown 28 kV (ASTM D1816, 2 mm gap) -- below the ~40 kV service-aged minimum for this class. Dehydration filtration recommended; deficiency logged as ADVISORY.',
  } });

  // WO #22 -- COMPLETE: ATS-1 monthly transfer test ~12 days ago (Apex, C1 GREEN).
  // Pairs with schedule anchor completedAgo: 12.
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['ATS-1:ATS_MONTHLY_TRANSFER'].id,
    assetId: assets['ATS-1'].id,
    contractorId: apex.id, assignedTechId: apexTechs.rios.id,
    status: 'COMPLETE',
    scheduledDate: addDays(now, -14), startedAt: addDays(now, -12), completedDate: addDays(now, -12),
    asFoundCondition: 'C1', asLeftCondition: 'C1',
    netaDecal: 'GREEN',
    notes: 'NFPA 110 monthly ATS manual transfer test; normal-to-emergency in 8.2 s (within 10 s spec). Retransfer to normal complete. No alarms.',
  } });

  // WO #23 -- COMPLETE: ELTG-1 monthly functional test ~10 days ago (Apex, C1 GREEN).
  // Pairs with schedule anchor completedAgo: 10.
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['ELTG-1:ELTG_MONTHLY_FUNCTIONAL'].id,
    assetId: assets['ELTG-1'].id,
    contractorId: apex.id, assignedTechId: apexTechs.okafor.id,
    status: 'COMPLETE',
    scheduledDate: addDays(now, -12), startedAt: addDays(now, -10), completedDate: addDays(now, -10),
    asFoundCondition: 'C1', asLeftCondition: 'C1',
    netaDecal: 'GREEN',
    notes: 'NFPA 101 30-second functional self-test on all 24 heads. All units illuminated and held illumination for full test period. Battery float current normal.',
  } });

  // -- Field-tech assignments (2026-07-03): Terry Vance / tech@demo.local ----
  // Give the field_tech login a working world: /field "My Jobs" lists the
  // IN_PROGRESS load-bank job (WO #3 above, assignedUserId added there) plus
  // the SCHEDULED job below; the COMPLETE one from yesterday fills history.
  // Neither new WO touches a schedule anchor or nextDueDate, so the
  // "Engineered buckets" dashboard story above is unchanged (overdue counts,
  // hero-bus DANGER arc, and alert ladders are all driven by schedules /
  // deficiencies, not by work-order rows).

  // WO #24 -- SCHEDULED (+2d): GEN-E1 monthly exercise, brought in-house.
  // The schedule stays due in ~6 days (due-30 bucket unchanged); Terry is
  // booked two days out on the Eastgate generator -- a clean standalone
  // asset that makes an easy QR-scan target in field-mode demos.
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    scheduleId: schedules['GEN-E1:GEN_MONTHLY_EXERCISE'].id,
    assetId: assets['GEN-E1'].id,
    assignedUserId: tech.id,
    status: 'SCHEDULED',
    scheduledDate: addDays(now, 2),
    notes: 'Monthly NFPA 110 exercise brought in-house this cycle (contract techs are tied up on the Riverside load-bank job). 30-minute run at available load; log transfer time and battery float readings in Field Mode.',
  } });

  // WO #25 -- COMPLETE (yesterday): ad-hoc corrective check on BATT-1.
  // scheduleId null (CORRECTIVE) so no schedule anchor moves: the ohmic-scan
  // schedule stays 14 days overdue and the open RECOMMENDED battery
  // deficiency stays open -- this is the interim weekly float-voltage check
  // that deficiency's corrective action calls for.
  await prisma.workOrder.create({ data: {
    accountId: account.id,
    assetId: assets['BATT-1'].id,
    assignedUserId: tech.id,
    status: 'COMPLETE',
    workOrderType: 'CORRECTIVE',
    scheduledDate: addDays(now, -1), startedAt: addDays(now, -1), completedDate: addDays(now, -1),
    asFoundCondition: 'C2', asLeftCondition: 'C2',
    notes: 'Interim weekly float-voltage check on flagged cells 1-C4 and 2-C7 (per the open battery deficiency). Float voltages holding within 0.05 V of string average; no thermal runaway indicators. Quarterly ohmic scan remains outstanding under its own schedule.',
  } });

  // ── Deficiencies ──────────────────────────────────────────────────────────
  const def1 = await prisma.deficiency.create({ data: {
    accountId: account.id, assetId: assets['SWGR-2M'].id,
    severity: 'IMMEDIATE',
    description: 'Severe overheating at B-phase bus connection — ΔT 38°C above ambient under 60% load',
    correctiveAction: 'De-energize at first opportunity; clean, torque, and re-test B-phase main bus joint. Replace hardware if pitted. Re-image under load after repair.',
    createdAt: addDays(now, -12),
  } });
  const def2 = await prisma.deficiency.create({ data: {
    accountId: account.id, assetId: assets['SWGR-1A-1'].id, workOrderId: wo2.id,
    severity: 'RECOMMENDED',
    description: 'C-phase bus insulation resistance trending low vs. 2024 baseline (890 MΩ as-left vs. >5 GΩ adjacent phases)',
    correctiveAction: 'Investigate roof penetration sealing above Cubicle 1; re-test at next outage. Consider heater circuit check.',
    createdAt: addDays(now, -45),
  } });
  const def3 = await prisma.deficiency.create({ data: {
    accountId: account.id, assetId: assets['T-1'].id,
    severity: 'RECOMMENDED',
    description: 'Oil weeping at NW radiator flange gasket; staining on pad, level holding steady',
    correctiveAction: 'Monitor weekly; schedule gasket replacement with next de-energized maintenance window.',
    createdAt: addDays(now, -70),
  } });
  const def4 = await prisma.deficiency.create({ data: {
    accountId: account.id, assetId: assets['GEN-1'].id,
    severity: 'ADVISORY',
    description: 'Block heater coolant hose showing surface weathering/cracking at jacket inlet',
    correctiveAction: 'Replaced hose and clamps during monthly exercise visit.',
    createdAt: addDays(now, -120),
    resolvedAt: addDays(now, -60), resolvedById: manager.id,
  } });

  // Additional deficiencies: fuller severity breakdown for the Overdue
  // Maintenance by Severity report and the EMP Section 6 open-deficiency table.
  // def5 is the finding WO #10 (SWGR-1A-1 IR thermography, completed -365d)
  // logged -- description mirrors that WO's notes and createdAt matches its
  // completedDate.
  const def5 = await prisma.deficiency.create({ data: {
    accountId: account.id, assetId: assets['SWGR-1A-1'].id, workOrderId: wo10.id,
    severity: 'RECOMMENDED',
    description: 'C-phase cubicle 1 main bus joint showing delta-T 14 deg C above ambient at 62% load (NETA MTS Table 100.18: probable deficiency, repair as time permits -- 11-20 deg C over-ambient band)',
    correctiveAction: 'Clean and re-torque C-phase bus connection at next outage window; re-image under load to confirm resolution.',
    createdAt: addDays(now, -365),
  } });
  await prisma.deficiency.create({ data: {
    accountId: account.id, assetId: assets['SWGR-2M'].id,
    severity: 'RECOMMENDED',
    description: 'B-phase bus connection delta-T 12 deg C above ambient at 55% load (NETA MTS Table 100.18: probable deficiency, repair as time permits -- early-stage thermal signature). History: 38 deg C in most recent scan.',
    correctiveAction: 'Superseded by the current IMMEDIATE deficiency (38 deg C) on this same B-phase joint -- the early-stage signature progressed; tracking now consolidated under the open IMMEDIATE item.',
    createdAt: addDays(now, -350),
    resolvedAt: addDays(now, -12), resolvedById: admin.id,
  } });
  await prisma.deficiency.create({ data: {
    accountId: account.id, assetId: assets['T-2'].id,
    severity: 'ADVISORY',
    description: 'Oil moisture content 28 ppm (IEEE C57.106 Class I for <=69 kV); dielectric breakdown 28 kV (ASTM D1816, 2 mm gap) -- below the ~40 kV service-aged minimum for this class',
    correctiveAction: 'Schedule oil dehydration filtration within next planned maintenance window. Re-test after treatment.',
    createdAt: addDays(now, -150),
  } });
  await prisma.deficiency.create({ data: {
    accountId: account.id, assetId: assets['BATT-1'].id,
    severity: 'RECOMMENDED',
    description: 'Two battery cells (cells 1-C4 and 2-C7) showing internal ohmic resistance ~40% above baseline. IEEE 450 (vented) bases replacement on the annual capacity test (<80% rated); the rising ohmic trend is a supplementary early indicator -- flag these cells for capacity verification. Cell voltage still holding.',
    correctiveAction: 'Replace cells 1-C4 and 2-C7 at next scheduled ohmic inspection window; order spares now (6-week lead time). Interim: add to weekly float-voltage monitoring.',
    createdAt: addDays(now, -14),
  } });
  await prisma.deficiency.create({ data: {
    accountId: account.id, assetId: assets['GEN-E1'].id,
    severity: 'ADVISORY',
    description: 'Natural-gas pressure regulator body showing minor corrosion pitting at downstream fitting; no leak detected on soap-bubble test',
    correctiveAction: 'Schedule regulator replacement at next annual fuel-train inspection; apply corrosion-inhibiting coating in interim.',
    createdAt: addDays(now, -330),
    resolvedAt: null,
  } });

  // ── Lab sample — DGA on T-1 (IEEE C57.104) ────────────────────────────────
  // Mildly elevated acetylene (C2H2) justifies the YELLOW rating: any
  // detectable C2H2 warrants attention (possible low-energy arcing).
  const labSample = await prisma.labSample.create({ data: {
    accountId: account.id, assetId: assets['T-1'].id,
    sampleType: 'dga', sampleDate: addDays(now, -28),
    labName: 'Delta Insulating Fluids Laboratory',
    h2: 42, ch4: 36, c2h2: 2.8, c2h4: 24, c2h6: 19, co: 340, co2: 3100,
    // O2/N2 ratio ≈ 0.03 — sealed-unit reference table applies.
    o2: 1850, n2: 56400,
    // Gases within Condition 1 ABSOLUTE limits (corrected C57.104 four-condition table),
    // but newly-detectable acetylene = Duval D1 low-energy arcing -> YELLOW caution + resample.
    ieeeStatus: 1, faultCode: 'D1',
    resultRating: 'YELLOW',
    notes: 'C2H2 detectable at 2.8 ppm (was <0.5 ppm in prior sample) -- possible low-energy discharge. Lab recommends resample in 90 days; other gases within IEEE C57.104 Condition 1 limits for transformer age.',
  } });

  // Prior T-1 DGA sample (~15 months ago) -- Condition 1 (GREEN), establishes trend baseline.
  await prisma.labSample.create({ data: {
    accountId: account.id, assetId: assets['T-1'].id,
    sampleType: 'dga', sampleDate: addDays(now, -455),
    labName: 'Delta Insulating Fluids Laboratory',
    h2: 12, ch4: 14, c2h2: 0.3, c2h4: 8, c2h6: 7, co: 210, co2: 2100,
    o2: 2200, n2: 62000,
    ieeeStatus: 1, faultCode: null,
    resultRating: 'GREEN',
    notes: 'All gases within IEEE C57.104 Condition 1 limits. C2H2 < 0.5 ppm (below significance threshold). Transformer in normal service.',
  } });

  // T-E1 DGA sample (~6.5 months ago) -- Condition 1 (GREEN), FR3 natural-ester oil.
  await prisma.labSample.create({ data: {
    accountId: account.id, assetId: assets['T-E1'].id,
    sampleType: 'dga', sampleDate: addDays(now, -200),
    labName: 'Delta Insulating Fluids Laboratory',
    h2: 5, ch4: 9, c2h2: 0, c2h4: 3, c2h6: 4, co: 95, co2: 980,
    o2: 3100, n2: 70000,
    ieeeStatus: 1, faultCode: null,
    resultRating: 'GREEN',
    notes: 'FR3 natural-ester fluid reference table applied. All gases well within Condition 1 limits; no detectable acetylene. Eastgate 1000 kVA transformer performing normally.',
  } });

  // T-2 oil quality sample (~5 months ago) -- elevated moisture, YELLOW.
  await prisma.labSample.create({ data: {
    accountId: account.id, assetId: assets['T-2'].id,
    sampleType: 'oil_quality', sampleDate: addDays(now, -150),
    labName: 'Delta Insulating Fluids Laboratory',
    resultRating: 'YELLOW',
    notes: 'Moisture 28 ppm (IEEE C57.106 Class I for <=69 kV); dielectric breakdown 28 kV (ASTM D1816, 2 mm gap, below the ~40 kV service-aged minimum). Oil dehydration filtration recommended. Acid number and color within limits.',
  } });

  // ── Demo disaster events (DEMO_FIXES 2.4) ───────────────────────────────
  // Seed one active and one resolved DisasterEvent so the Disaster Response
  // page shows content rather than 'no active events'. affectedSiteIds uses
  // the real site UUIDs so GET /api/disaster-events filters them in.
  // nwsAlertId guards are stable IDs so re-running the seed is idempotent.
  const _deExisting1 = await prisma.disasterEvent.findFirst(
    { where: { nwsAlertId: 'demo-seed-severe-thunderstorm-watch' } }
  ).catch(() => null);
  if (!_deExisting1) {
    await prisma.disasterEvent.create({ data: {
      eventType:        'severe_thunderstorm',
      severity:         'watch',
      title:            'Severe Thunderstorm Watch -- Scott County, IA / Rock Island County, IL',
      region:           'Quad Cities -- Scott County (IA), Rock Island County (IL)',
      affectedStates:   ['IA', 'IL'],
      affectedSiteIds:  [riverside.id, eastgate.id],
      nwsAlertId:       'demo-seed-severe-thunderstorm-watch',
      source:           'nws',
      declaredAt:       addDays(now, -2),
    } });
  }
  const _deExisting2 = await prisma.disasterEvent.findFirst(
    { where: { nwsAlertId: 'demo-seed-blizzard-warning-jan' } }
  ).catch(() => null);
  if (!_deExisting2) {
    await prisma.disasterEvent.create({ data: {
      eventType:        'blizzard',
      severity:         'warning',
      title:            'Winter Storm Warning -- 8-12 inches of snowfall expected',
      region:           'Eastern Iowa / Northwestern Illinois -- Quad Cities metro',
      affectedStates:   ['IA', 'IL'],
      affectedSiteIds:  [riverside.id, eastgate.id],
      nwsAlertId:       'demo-seed-blizzard-warning-jan',
      source:           'nws',
      declaredAt:       addDays(now, -175),
      resolvedAt:       addDays(now, -173),
    } });
  }
  // Active tornado warning at Riverside (highest NWS severity) — shows the
  // Disaster Response page with an urgent open event, not just a watch.
  const _deExisting3 = await prisma.disasterEvent.findFirst(
    { where: { nwsAlertId: 'demo-seed-tornado-warning' } }
  ).catch(() => null);
  if (!_deExisting3) {
    await prisma.disasterEvent.create({ data: {
      eventType:        'tornado',
      severity:         'warning',
      title:            'Tornado Warning -- Scott County, IA -- take shelter now',
      region:           'Quad Cities -- Scott County (IA)',
      affectedStates:   ['IA'],
      affectedSiteIds:  [riverside.id],
      nwsAlertId:       'demo-seed-tornado-warning',
      source:           'nws',
      declaredAt:       addDays(now, -1),
    } });
  }
  // Customer-declared grid-failure emergency at Eastgate (source=manual,
  // declaredBy set) — demonstrates the "Declare Emergency" self-service path
  // alongside the system-detected NWS events above.
  const _deExisting4 = await prisma.disasterEvent.findFirst(
    { where: { nwsAlertId: 'demo-seed-grid-failure-eastgate' } }
  ).catch(() => null);
  if (!_deExisting4) {
    await prisma.disasterEvent.create({ data: {
      accountId:        account.id,
      eventType:        'grid_failure',
      severity:         'emergency',
      title:            'Utility Grid Failure -- Eastgate DC on standby generator',
      region:           'Moline, IL -- Eastgate Distribution Center',
      affectedStates:   ['IL'],
      affectedSiteIds:  [eastgate.id],
      nwsAlertId:       'demo-seed-grid-failure-eastgate',
      source:           'manual',
      declaredBy:       admin.id,
      declaredAt:       addDays(now, -4),
      resolvedAt:       addDays(now, -3),
    } });
  }

  // ── System studies — the documents loss-control auditors ask for by name ──
  // Arc flash study approaching the NFPA 70E 5-year clock.
  const afPerformed = addDays(now, -Math.round(4.2 * 365)); // ~4.2 years ago
  const arcFlash = await prisma.systemStudy.create({ data: {
    accountId: account.id, siteId: riverside.id,
    studyType: 'arc_flash',
    performedDate: afPerformed,
    expiresAt: addMonths(afPerformed, 60),
    performedBy: 'Hawthorne Power Engineering, PLLC',
    method: 'IEEE 1584-2018',
    peName: 'S. Hawthorne, PE',
    trigger: 'scheduled',
    notes: 'Site-wide incident energy analysis incl. Substation A and mezzanine lineup. Re-study due inside 10 months — budget approval pending.',
  } });

  // Arc-flash PRIOR study (~9 yr ago) + per-bus incident-energy bindings on the
  // SWGR-1A lead 15 kV switchgear, so the Slice 1 per-asset ArcFlashTrend card
  // renders a real DANGER-class rising-energy history. The arc_flash study above
  // stays the CURRENT one (preserving the "approaching 5-yr clock" narrative).
  const afPriorPerformed = addDays(now, -Math.round(9 * 365));
  const arcFlashPrior = await prisma.systemStudy.create({ data: {
    accountId: account.id, siteId: riverside.id,
    studyType: 'arc_flash',
    performedDate: afPriorPerformed,
    expiresAt: addMonths(afPriorPerformed, 60),
    performedBy: 'Hawthorne Power Engineering, PLLC',
    method: 'IEEE 1584-2002',
    peName: 'S. Hawthorne, PE', peLicense: 'IA PE 21487',
    trigger: 'scheduled',
    notes: 'Prior incident-energy study at Substation A; superseded by the current study after the utility transformer upsizing raised available fault current.',
  } });
  // The current arc_flash study supersedes this prior one.
  await prisma.systemStudy.update({ where: { id: arcFlashPrior.id }, data: { supersededById: arcFlash.id } });
  // Bind the SWGR-1A-1 lead 15 kV switchgear to both studies; incident energy
  // rises 14.2 -> 19.6 cal/cm2 across revisions. DANGER signal word here is a documented house labeling-philosophy rule (ANSI Z535.4)
  // applied to >600 V buses, matching the dashboard (volts>600) and fleet rules so every
  // surface agrees on DANGER. NOTE: NFPA 70E 130.5(H) governs label CONTENT, not signal
  // words -- DANGER vs WARNING is an ANSI Z535.4 convention, not voltage-mandated by 70E.
  const afTrendBus = assets['SWGR-1A-1'];
  if (afTrendBus) {
    await prisma.systemStudyAsset.create({ data: {
      accountId: account.id, studyId: arcFlashPrior.id, assetId: afTrendBus.id,
      busName: 'SWGR-1A Main Bus', nominalVoltage: '13.8kV',
      incidentEnergyCalCm2: 14.2, arcFlashBoundaryIn: 68, workingDistanceIn: 36, ppeCategory: 3,
      boltedFaultCurrentKA: 20.0, arcingCurrentKA: 19.1, electrodeConfig: 'VCB',
      conductorGapMm: 152, clearingTimeMs: 240, upstreamDevice: 'Utility 51 relay / CB-101',
    } });
    const afCurrentBind = await prisma.systemStudyAsset.create({ data: {
      accountId: account.id, studyId: arcFlash.id, assetId: afTrendBus.id,
      busName: 'SWGR-1A Main Bus', nominalVoltage: '13.8kV',
      incidentEnergyCalCm2: 19.6, arcFlashBoundaryIn: 88, workingDistanceIn: 36, ppeCategory: 3,
      requiredArcRatingCalCm2: 25, labelSeverity: 'danger',
      boltedFaultCurrentKA: 24.0, arcingCurrentKA: 22.7, electrodeConfig: 'VCB',
      conductorGapMm: 152, clearingTimeMs: 255, upstreamDevice: 'Utility 51 relay / CB-101',
      deviceType: 'relay', tripUnitType: 'electronic_lsig', deviceRatingA: 1200,
    } });

    // Source / system model for the current study (per-asset source card + risk).
    await prisma.studySourceModel.create({ data: {
      accountId: account.id, siteId: riverside.id, studyId: arcFlash.id,
      utilityMaxFaultKA: 32.0, utilityMinFaultKA: 18.5, utilityXr: 12.4,
      transformerKva: 2500, transformerPrimaryV: 13800, transformerSecondaryV: 480,
      transformerImpedancePct: 5.75, transformerConnection: 'delta-wye',
      notes: 'Utility raised available fault current after the 2500 kVA transformer upsizing.',
    } }).catch(() => {});

    // Collected upstream protective device (devices list + timeline event).
    await prisma.protectiveDevice.create({ data: {
      accountId: account.id, siteId: riverside.id, assetId: afTrendBus.id,
      label: 'Utility 51 relay / CB-101', deviceType: 'relay',
      manufacturer: 'SEL', model: '751', sensorRatingA: 1200,
      settings: { pickupA: 960, timeDial: 3.5, curve: 'U3' },
      source: 'field', settingsCollectedAt: addDays(now, -120),
    } }).catch(() => {});

    // NETA as-found/as-left test WITH drift -> stale-study banner + timeline event
    // + caps the data-confidence band below green.
    await prisma.deviceTestRecord.create({ data: {
      accountId: account.id, siteId: riverside.id, assetId: afTrendBus.id,
      testType: 'as_found_as_left', testDate: addDays(now, -90), performedBy: 'NETA tech - Substation A',
      asFoundSettings: { pickupA: 1040, timeDial: 4.0 }, asLeftSettings: { pickupA: 960, timeDial: 3.5 },
      matchesStudy: false, driftFlagged: true, result: 'conditional',
      notes: 'As-found relay pickup higher than the study assumed; reset to study values. Re-study recommended.',
    } }).catch(() => {});

    // A previously-printed QR label snapshot at the OLDER value, so scanning the
    // public /l/<token> portal shows a printed-vs-current mismatch (current 19.6
    // vs printed 14.2 cal/cm2 -> "reprint" banner).
    await prisma.systemStudyAsset.update({ where: { id: afCurrentBind.id }, data: {
      publicToken: 'demoswgr1a1' + Math.random().toString(36).slice(2, 12),
      printedAt: addDays(now, -Math.round(3.8 * 365)),
      printedSnapshot: { nominalVoltage: '13.8kV', incidentEnergyCalCm2: 14.2, arcFlashBoundaryIn: 68, workingDistanceIn: 36, ppeCategory: 3, requiredArcRatingCalCm2: 25, labelSeverity: 'danger' },
    } }).catch(() => {});

    console.log('  [seed] arc-flash trend on SWGR-1A-1 (' + afTrendBus.id + '): 14.2 -> 19.6 cal/cm2 DANGER (13.8 kV); + source model, device, NETA drift, stale printed label');
  }

  // Short-circuit study ~3 years ago — PE license on the report cover.
  const scPerformed = addDays(now, -Math.round(3 * 365));
  await prisma.systemStudy.create({ data: {
    accountId: account.id, siteId: riverside.id,
    studyType: 'short_circuit',
    performedDate: scPerformed,
    expiresAt: addMonths(scPerformed, 60),
    performedBy: 'Hawthorne Power Engineering, PLLC',
    method: 'ANSI/IEEE C37 series',
    peName: 'S. Hawthorne, PE', peLicense: 'IA PE 21487',
    trigger: 'scheduled',
    notes: 'Available fault current verified at Substation A main, feeders, and mezzanine lineup; device duty within ratings throughout.',
  } });

  // One-line review ~6 months ago — drawings confirmed current after the
  // compressor-room feeder addition (HSB: update drawings on every change).
  const olrPerformed = addDays(now, -182);
  await prisma.systemStudy.create({ data: {
    accountId: account.id, siteId: riverside.id,
    studyType: 'one_line_review',
    performedDate: olrPerformed,
    expiresAt: addMonths(olrPerformed, 60),
    performedBy: 'Meridian Manufacturing — plant engineering',
    trigger: 'system_change',
    notes: 'One-line diagrams walked down and red-lined after the compressor-room feeder addition; CAD masters updated and posted at Substation A.',
  } });

  // ── Audit visit — insurance loss-control survey (~5 months ago) ──────────
  const auditVisit = await prisma.auditVisit.create({ data: {
    accountId: account.id, siteId: riverside.id,
    auditType: 'insurance',
    auditorName: 'P. Okonjo',
    auditorOrg: 'Granite Mutual', // fictional carrier
    scheduledDate: addDays(now, -158), performedDate: addDays(now, -150),
    outcome: 'passed_with_findings',
    notes: 'Annual loss-control survey. Maintenance program, testing records, and study currency reviewed; two recommendations issued (one since closed).',
  } });
  await prisma.auditRecommendation.create({ data: {
    accountId: account.id, auditVisitId: auditVisit.id,
    source: 'insurer', severity: 'recommendation',
    description: 'Reprint and post current arc-flash labels on the mezzanine lineup — labels in place reference superseded study values.',
    dueDate: addDays(now, -105),
    status: 'completed',
    responseNotes: 'Labels reprinted from the current incident-energy study and applied; photo evidence returned to the carrier.',
    respondedAt: addDays(now, -130), completedAt: addDays(now, -118),
  } });
  await prisma.auditRecommendation.create({ data: {
    accountId: account.id, auditVisitId: auditVisit.id,
    source: 'insurer', severity: 'recommendation',
    description: 'Document the written qualified-person designation for in-house staff performing routine switching and inspections (NFPA 70E 110.2).',
    dueDate: addDays(now, 30),
    status: 'open',
    assignedToUserId: manager.id,
  } });

  // Second audit visit -- internal electrical safety audit ~2 months ago.
  const auditVisit2 = await prisma.auditVisit.create({ data: {
    accountId: account.id, siteId: riverside.id,
    auditType: 'internal',
    auditorName: 'Avery Sandoval',
    auditorOrg: 'Meridian Manufacturing -- EHS',
    scheduledDate: addDays(now, -65), performedDate: addDays(now, -63),
    outcome: 'passed_with_findings',
    notes: 'Quarterly internal electrical safety walkdown per NFPA 70E 110.1. Covered Substation A, mezzanine lineup, and emergency power systems. Three findings issued.',
  } });
  await prisma.auditRecommendation.create({ data: {
    accountId: account.id, auditVisitId: auditVisit2.id,
    source: 'internal', severity: 'finding',
    description: 'ARC flash PPE kits in Substation A not up to date with current incident-energy study values; two kits contain cal/cm2 ratings from the superseded (prior) study.',
    dueDate: addDays(now, -20),
    status: 'completed',
    responseNotes: 'All PPE kits inventoried and re-labelled with current incident-energy study values; two kits replaced.',
    respondedAt: addDays(now, -58), completedAt: addDays(now, -50),
  } });
  await prisma.auditRecommendation.create({ data: {
    accountId: account.id, auditVisitId: auditVisit2.id,
    source: 'internal', severity: 'finding',
    description: 'Generator GEN-1 transfer switch exercise log not posted at the generator; NFPA 110 8.4.2 requires log maintained at the equipment.',
    dueDate: addDays(now, 14),
    status: 'open',
    assignedToUserId: manager.id,
  } });
  await prisma.auditRecommendation.create({ data: {
    accountId: account.id, auditVisitId: auditVisit2.id,
    source: 'internal', severity: 'observation',
    description: 'SWGR-2M mezzanine lineup room housekeeping: combustible material (cardboard, spare parts packaging) stored within 3 ft of energized equipment.',
    dueDate: addDays(now, 7),
    status: 'open',
    assignedToUserId: admin.id,
  } });

  // Third audit visit (G2) -- AHJ / fire marshal inspection ~10 months ago,
  // clean pass with one (since-completed) recommendation. Varies auditType,
  // outcome, and date so the Audits page shows a real history.
  const auditVisit3 = await prisma.auditVisit.create({ data: {
    accountId: account.id, siteId: riverside.id,
    auditType: 'ahj',
    auditorName: 'Lt. R. Calloway',
    auditorOrg: 'Davenport Fire Marshal\'s Office',
    scheduledDate: addDays(now, -310), performedDate: addDays(now, -305),
    outcome: 'passed',
    notes: 'Routine fire-prevention inspection covering the electrical rooms. Egress, working clearances (NEC 110.26), and emergency lighting verified. One advisory note on panel labeling.',
  } });
  await prisma.auditRecommendation.create({ data: {
    accountId: account.id, auditVisitId: auditVisit3.id,
    source: 'ahj', severity: 'recommendation',
    description: 'Update circuit directory cards on the office-wing panelboard (PNL-1) -- several handwritten entries illegible or outdated.',
    dueDate: addDays(now, -275),
    status: 'completed',
    responseNotes: 'Directory cards re-typed from as-built drawings and verified circuit-by-circuit during a lunch-hour shutdown.',
    respondedAt: addDays(now, -300), completedAt: addDays(now, -290),
  } });

  // Fourth audit visit (G2) -- UPCOMING insurance loss-control survey, shows
  // the scheduled/pending state on the Audits page.
  await prisma.auditVisit.create({ data: {
    accountId: account.id, siteId: eastgate.id,
    auditType: 'insurance',
    auditorName: 'P. Okonjo',
    auditorOrg: 'Granite Mutual',
    scheduledDate: addDays(now, 35), performedDate: null,
    outcome: 'pending',
    notes: 'Annual loss-control survey for the Eastgate Distribution Center -- first carrier visit to this site. Evidence pack to be generated from ServiceCycle ahead of the visit.',
  } });

  // ── Blackout window — planned production shutdown ────────────────────────
  const outageStart = addDays(now, 45);
  await prisma.blackoutWindow.create({ data: {
    accountId: account.id, siteId: riverside.id,
    startsAt: outageStart, endsAt: addDays(outageStart, 2), // 48 hours
    isOutageWindow: true,
    reason: 'Annual production shutdown',
  } });

  // ── Alerts (G2/F5) ────────────────────────────────────────────────────────
  // Alert rows normally come only from lib/alertEngine.ts (07:00 UTC cron),
  // so the Alerts page sat empty between the 03:30 demo reset and the next
  // engine run. Seed the rows the engine WOULD have produced for the
  // engineered overdue/due-soon schedules, using the engine's exact row shape:
  // leadDays positive for maintenance_due lead tiers, negative for the
  // overdue (-1) / escalation (-7,-30) / regulatory_breach (-90) ladder.
  //
  // Dedup safety: the engine's per-cycle dedup key is
  // (scheduleId, alertType, leadDays) over status sent|acknowledged, so the
  // 07:00 run skips everything seeded here as sent/acknowledged. The two
  // 'pending' rows use lead tiers outside the engine's ±5-day crossing window
  // so they can't be double-fired either.
  //
  // `at` = days from now for scheduledAt/createdAt/sentAt (matches each
  // schedule's engineered dueIn); GET /api/alerts shows pending|sent only.
  const alertSpecs = [
    // SWGR-2M IR scan — 120d overdue: the full escalation ladder.
    { sched: 'SWGR-2M:SWGR_IR_THERMO',  type: 'overdue',           leadDays: -1,  at: -119, status: 'acknowledged', ackAt: -110 },
    { sched: 'SWGR-2M:SWGR_IR_THERMO',  type: 'escalation',        leadDays: -7,  at: -113, status: 'acknowledged', ackAt: -110 },
    { sched: 'SWGR-2M:SWGR_IR_THERMO',  type: 'escalation',        leadDays: -30, at: -90,  status: 'sent' },
    { sched: 'SWGR-2M:SWGR_IR_THERMO',  type: 'regulatory_breach', leadDays: -90, at: -30,  status: 'sent' },
    // T-1 oil screen — 25d overdue.
    { sched: 'T-1:XFMR_OIL_QUALITY',    type: 'overdue',           leadDays: -1,  at: -24,  status: 'sent' },
    { sched: 'T-1:XFMR_OIL_QUALITY',    type: 'escalation',        leadDays: -7,  at: -18,  status: 'sent' },
    // GEN-1 load bank — 9d overdue; first ping acked (WO #3 is on site).
    { sched: 'GEN-1:GEN_LOAD_BANK',     type: 'overdue',           leadDays: -1,  at: -8,   status: 'acknowledged', ackAt: -6 },
    { sched: 'GEN-1:GEN_LOAD_BANK',     type: 'escalation',        leadDays: -7,  at: -2,   status: 'sent' },
    // ATS-1 IR scan — 18d overdue.
    { sched: 'ATS-1:ATS_IR_THERMO',     type: 'overdue',           leadDays: -1,  at: -17,  status: 'sent' },
    { sched: 'ATS-1:ATS_IR_THERMO',     type: 'escalation',        leadDays: -7,  at: -11,  status: 'sent' },
    // BATT-1 ohmic — 14d overdue.
    { sched: 'BATT-1:BATT_OHMIC_FLOAT', type: 'overdue',           leadDays: -1,  at: -13,  status: 'sent' },
    { sched: 'BATT-1:BATT_OHMIC_FLOAT', type: 'escalation',        leadDays: -7,  at: -7,   status: 'sent' },
    // Upcoming work — maintenance_due lead-time tiers.
    { sched: 'GEN-E1:GEN_MONTHLY_EXERCISE', type: 'maintenance_due', leadDays: 7,  at: -1,  status: 'sent' },
    { sched: 'T-2:XFMR_DGA',                type: 'maintenance_due', leadDays: 30, at: -8,  status: 'sent' },
    { sched: 'GEN-E1:GEN_FUEL_ANALYSIS',    type: 'maintenance_due', leadDays: 90, at: -20, status: 'sent' },
    // Queued-not-yet-emailed rows (the lead tier already passed for these — the
    // engine won't re-cross it, so no duplicate risk). T-1 TTR due +75d -> 90d
    // tier crossed 15d ago; T-E1 DGA due ~+165d -> 180d tier crossed 15d ago.
    { sched: 'T-1:XFMR_TTR',                type: 'maintenance_due', leadDays: 90,  at: -15, status: 'pending' },
    { sched: 'T-E1:XFMR_DGA',               type: 'maintenance_due', leadDays: 180, at: -15, status: 'pending' },
  ];
  let alertCount = 0;
  for (const a of alertSpecs) {
    const sched = schedules[a.sched];
    if (!sched) continue; // task-matrix drift — skip rather than crash the seed
    await prisma.alert.create({ data: {
      accountId:      account.id,
      scheduleId:     sched.id,
      assetId:        sched.assetId,
      alertType:      a.type,
      leadDays:       a.leadDays,
      scheduledAt:    addDays(now, a.at),
      createdAt:      addDays(now, a.at),
      sentAt:         a.status === 'pending' ? null : addDays(now, a.at),
      acknowledgedAt: a.status === 'acknowledged' ? addDays(now, a.ackAt) : null,
      status:         a.status,
    } });
    alertCount++;
  }

  // ── Quote Requests — demo data for the Quote Request feature ────────────────
  // Demonstrates the full lifecycle: one requested, one quoted, one accepted,
  // one declined. Driver variety shows both normal and emergency flows.
  // Dossier snapshots are intentionally minimal here
  // (real snapshots built live by the server on POST /api/quote-requests).
  const dossierSnapshotT1 = {
    assetId: assets['T-1'].id, name: 'T-1 Main Transformer',
    equipmentType: 'TRANSFORMER_LIQUID', ageYears: 29, criticality: 5,
    openDeficiencies: [{ severity: 'RECOMMENDED', description: 'Elevated DGA dissolved-gas levels trending upward' }],
    overdueTaskCount: 2,
    snapshotAt: now.toISOString(),
  };
  const dossierSnapshotGen1 = {
    assetId: assets['GEN-1'].id, name: 'GEN-1 Emergency Generator',
    equipmentType: 'GENERATOR', ageYears: 21, criticality: 5,
    openDeficiencies: [],
    overdueTaskCount: 0,
    snapshotAt: now.toISOString(),
  };

  // QR #1's outage window is computed from seed time (the next Saturday at
  // least 10 days out) so the copy never goes stale the way the original
  // hardcoded "Weekend of July 12th" did for most of the year.
  const outageSat = addDays(now, 10);
  outageSat.setDate(outageSat.getDate() + ((6 - outageSat.getDay()) % 7)); // roll forward to Saturday
  const outageSun = addDays(outageSat, 1);
  const fmtMonthDay = (d) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const outageRange = outageSat.getMonth() === outageSun.getMonth()
    ? fmtMonthDay(outageSat) + '-' + outageSun.getDate()
    : fmtMonthDay(outageSat) + ' - ' + fmtMonthDay(outageSun);

  const qr1 = await prisma.quoteRequest.create({ data: {
    accountId: account.id, assetId: assets['T-1'].id, requestedById: manager.id,
    status: 'quoted', driver: 'suspected_failing', timeline: 'within_1_week',
    outageAvailable: true, outageWindow: 'Weekend of ' + fmtMonthDay(outageSat),
    budgeted: false, budgetNotes: 'Need a number for Q3 capital request',
    attachmentNotes: 'DGA trend report from oil lab (emailed separately)',
    emergencyMode: false, dossierSnapshot: dossierSnapshotT1,
    // triggerType feeds the Revenue Attribution funnel (lib/revenueAttribution.ts):
    // any non-null triggerType counts as platform/system-triggered. T-1 is the
    // 1997 main transformer flagged by the modernization RUL model + rising DGA,
    // so this quote plausibly originated from a MODERNIZATION_EOL alert.
    triggerType: 'MODERNIZATION_EOL',
    quotedAt: addDays(now, -3),
    quoteNotes: 'Quote for full power transformer testing + oil sampling: $4,200. Includes DGA, power factor, and turns ratio. Available ' + outageRange + '.',
  } });

  // Accepted T-1 quote — wired to a COMPLETE work order below so it shows as
  // REALIZED (accepted → converted → completed) revenue in the attribution report.
  const qrT1Accepted = await prisma.quoteRequest.create({ data: {
    accountId: account.id, assetId: assets['T-1'].id, requestedById: admin.id,
    status: 'accepted', driver: 'failed_inspection', timeline: 'within_30_days',
    outageAvailable: true, outageWindow: 'Any weekday after 6pm',
    budgeted: true,
    emergencyMode: false, dossierSnapshot: dossierSnapshotT1,
    triggerType: 'MODERNIZATION_EOL',
    quotedAt: addDays(now, -60), respondedAt: addDays(now, -55),
    resolvedAt: addDays(now, -55),
    quoteNotes: 'Infrared thermography + partial discharge survey: $1,800.',
    createdAt: addDays(now, -65),
  } });

  // GEN-1 budget-estimate request — deliberately LEFT MANUAL (no triggerType):
  // a genuine customer-submitted quote keeps platformDrivenPct realistic (< 100%)
  // instead of every quote looking system-generated.
  await prisma.quoteRequest.create({ data: {
    accountId: account.id, assetId: assets['GEN-1'].id, requestedById: manager.id,
    status: 'requested', driver: 'budgetary', timeline: 'next_budget_cycle',
    outageAvailable: false,
    budgeted: false, budgetNotes: 'FY2027 budget planning — need rough estimate for annual generator NETA test',
    emergencyMode: false, dossierSnapshot: dossierSnapshotGen1,
  } });

  await prisma.quoteRequest.create({ data: {
    accountId: account.id, assetId: assets['SWGR-2M'].id, requestedById: admin.id,
    status: 'declined', driver: 'planned_replacement', timeline: 'next_budget_cycle',
    outageAvailable: true,
    budgeted: false,
    emergencyMode: false,
    dossierSnapshot: { assetId: assets['SWGR-2M'].id, name: 'SWGR-2M Mezzanine Switchgear', snapshotAt: now.toISOString() },
    triggerType: 'MODERNIZATION_EOL',
    quotedAt: addDays(now, -90), respondedAt: addDays(now, -85),
    resolvedAt: addDays(now, -85),
    quoteNotes: 'Quote sent for switchgear replacement: $180,000.',
    declineReason: 'Capital project deferred to FY2027. Will re-request closer to budget approval.',
    createdAt: addDays(now, -95),
  } });

  // ── Additional platform-triggered quote requests (Revenue Attribution demo) ──
  // Widen the funnel so lib/revenueAttribution.ts reports non-trivial numbers on
  // EVERY stage: a mix of all four triggerTypes, statuses spanning
  // requested→quoted→accepted→declined, and three accepted quotes wired to a
  // COMPLETE WorkOrder (quoteRequestId) so `attribution.systemTriggered`,
  // `value.realized`, funnel.converted and funnel.completed are all meaningful.
  // Dossier snapshots kept minimal (mirrors the four above; live snapshots are
  // built server-side on real POST /api/quote-requests).
  const snap = (key, name) => ({ assetId: assets[key].id, name, snapshotAt: now.toISOString() });

  // (1) REALIZED — SWGR-1A-1 arc-flash re-study, accepted + completed. repairCost 250k.
  const qrArcAccepted = await prisma.quoteRequest.create({ data: {
    accountId: account.id, assetId: assets['SWGR-1A-1'].id, requestedById: admin.id,
    status: 'accepted', driver: 'failed_inspection', timeline: 'within_30_days',
    outageAvailable: true, budgeted: true, emergencyMode: false,
    dossierSnapshot: snap('SWGR-1A-1', 'SWGR-1A-1 Lead 15kV Switchgear'),
    triggerType: 'ARC_FLASH_STUDY',
    quotedAt: addDays(now, -48), respondedAt: addDays(now, -44), resolvedAt: addDays(now, -44),
    quoteNotes: 'IEEE 1584-2018 arc-flash re-study of the SWGR-1A lineup after the utility fault-current increase: $9,500.',
    createdAt: addDays(now, -52),
  } });

  // (2) REALIZED — UPS-1 telemetry-CRIT driven inspection, accepted + completed. repairCost 60k.
  const qrTelemAccepted = await prisma.quoteRequest.create({ data: {
    accountId: account.id, assetId: assets['UPS-1'].id, requestedById: manager.id,
    status: 'accepted', driver: 'suspected_failing', timeline: 'within_1_week',
    outageAvailable: false, budgeted: true, emergencyMode: false,
    dossierSnapshot: snap('UPS-1', 'UPS-1 Stamping-Line PLC UPS'),
    triggerType: 'TELEMETRY_CRIT',
    quotedAt: addDays(now, -30), respondedAt: addDays(now, -27), resolvedAt: addDays(now, -27),
    quoteNotes: 'Battery-string capacity test + module inspection after a continuous-monitoring CRIT alert on cell voltage: $3,400.',
    createdAt: addDays(now, -33),
  } });

  // (3) REALIZED — ATS-1 modernization, accepted + completed. repairCost 45k.
  const qrAtsAccepted = await prisma.quoteRequest.create({ data: {
    accountId: account.id, assetId: assets['ATS-1'].id, requestedById: manager.id,
    status: 'accepted', driver: 'planned_replacement', timeline: 'next_budget_cycle',
    outageAvailable: true, budgeted: true, emergencyMode: false,
    dossierSnapshot: snap('ATS-1', 'ATS-1 Life-Safety Transfer Switch'),
    triggerType: 'MODERNIZATION_EOL',
    quotedAt: addDays(now, -70), respondedAt: addDays(now, -66), resolvedAt: addDays(now, -66),
    quoteNotes: 'Controls upgrade / modernization of the 2005 transfer switch: $38,000.',
    createdAt: addDays(now, -75),
  } });

  // (4) OPEN pipeline — SWGR-2M second arc-flash quote, requested (priced 90k).
  await prisma.quoteRequest.create({ data: {
    accountId: account.id, assetId: assets['SWGR-2M'].id, requestedById: manager.id,
    status: 'requested', driver: 'failed_inspection', timeline: 'within_30_days',
    outageAvailable: true, budgeted: false, emergencyMode: false,
    dossierSnapshot: snap('SWGR-2M', 'SWGR-2M Mezzanine Switchgear'),
    triggerType: 'ARC_FLASH_STUDY',
    notes: 'Auto-triggered: IMMEDIATE B-phase hot-joint deficiency on SWGR-2M may affect protective-device behaviour — arc-flash re-study recommended (NFPA 70E §130.5(G)).',
  } });

  // (5) OPEN pipeline — BATT-1 QEMW training, quoted (priced 28k).
  await prisma.quoteRequest.create({ data: {
    accountId: account.id, assetId: assets['BATT-1'].id, requestedById: admin.id,
    status: 'quoted', driver: 'budgetary', timeline: 'next_budget_cycle',
    outageAvailable: false, budgeted: false, emergencyMode: false,
    dossierSnapshot: snap('BATT-1', 'BATT-1 Substation-A Control Battery'),
    triggerType: 'QEMW_TRAINING',
    quotedAt: addDays(now, -12),
    quoteNotes: 'QEMW certification training for two Substation-A maintenance techs per ANSI/NETA EMW-2026: $2,600 per technician.',
    createdAt: addDays(now, -15),
  } });

  // (6) OPEN pipeline — MCC-1 modernization, requested. UNPRICED (no repairCostEstimate)
  // so the report's priced-vs-unpriced split is exercised.
  await prisma.quoteRequest.create({ data: {
    accountId: account.id, assetId: assets['MCC-1'].id, requestedById: manager.id,
    status: 'requested', driver: 'planned_replacement', timeline: 'next_budget_cycle',
    outageAvailable: true, budgeted: false, emergencyMode: false,
    dossierSnapshot: snap('MCC-1', 'MCC-1 Mezzanine Motor Control Center'),
    triggerType: 'MODERNIZATION_EOL',
    notes: 'Auto-triggered: 2001-vintage MCC past its condition-adjusted expected life; modernization planning quote.',
  } });

  // (7) DECLINED — GEN-E1 modernization at Eastgate (priced 70k, declined → funnel only).
  await prisma.quoteRequest.create({ data: {
    accountId: account.id, assetId: assets['GEN-E1'].id, requestedById: admin.id,
    status: 'declined', driver: 'planned_replacement', timeline: 'next_budget_cycle',
    outageAvailable: true, budgeted: false, emergencyMode: false,
    dossierSnapshot: snap('GEN-E1', 'GEN-E1 Eastgate Standby Generator'),
    triggerType: 'MODERNIZATION_EOL',
    quotedAt: addDays(now, -120), respondedAt: addDays(now, -110), resolvedAt: addDays(now, -110),
    quoteNotes: 'Natural-gas generator controls modernization: $52,000.',
    declineReason: 'DC ride-through only — deferred; no capital allocated this cycle.',
    createdAt: addDays(now, -125),
  } });

  // (8) OPEN pipeline — SWGR-1A-2 arc-flash, quoted. UNPRICED.
  await prisma.quoteRequest.create({ data: {
    accountId: account.id, assetId: assets['SWGR-1A-2'].id, requestedById: admin.id,
    status: 'quoted', driver: 'failed_inspection', timeline: 'within_30_days',
    outageAvailable: true, budgeted: false, emergencyMode: false,
    dossierSnapshot: snap('SWGR-1A-2', 'SWGR-1A-2 Switchgear Cubicle 2'),
    triggerType: 'ARC_FLASH_STUDY',
    quotedAt: addDays(now, -6),
    quoteNotes: 'Arc-flash label refresh for cubicle 2 following the lineup re-study: $1,200.',
    createdAt: addDays(now, -9),
  } });

  // COMPLETE work orders that realize the three accepted quotes above (and the
  // accepted T-1 modernization quote). quoteRequestId is the #22 closed-loop link
  // lib/revenueAttribution.ts reads for funnel.converted / funnel.completed and
  // value.realized (summing each asset's repairCostEstimate).
  const _realizedWOs = [
    { qr: qrT1Accepted,    key: 'T-1',       note: 'IR thermography + partial-discharge survey on T-1 completed; hot-spot cleared, PD within limits.' },
    { qr: qrArcAccepted,   key: 'SWGR-1A-1', note: 'IEEE 1584-2018 arc-flash re-study of the SWGR-1A lineup completed; labels reissued.' },
    { qr: qrTelemAccepted, key: 'UPS-1',     note: 'UPS-1 battery-string capacity test + module inspection completed after the CRIT alert.' },
    { qr: qrAtsAccepted,   key: 'ATS-1',     note: 'ATS-1 transfer-switch controls modernization completed; NFPA 110 transfer test passed.' },
  ];
  for (let i = 0; i < _realizedWOs.length; i++) {
    const w = _realizedWOs[i];
    await prisma.workOrder.create({ data: {
      accountId: account.id, assetId: assets[w.key].id, quoteRequestId: w.qr.id,
      contractorId: apex.id, assignedTechId: apexTechs.okafor.id,
      status: 'COMPLETE', workOrderType: 'CORRECTIVE', netaDecal: 'GREEN',
      scheduledDate: addDays(now, -(40 - i * 3)), startedAt: addDays(now, -(38 - i * 3)),
      completedDate: addDays(now, -(38 - i * 3)),
      notes: w.note,
    } });
  }

  // -- Parts catalog + spare inventory ----------------------------------------
  // 7 parts; mix of below-min and healthy stock. Demonstrates the Parts page
  // and the per-asset SpareInventoryPanel on AssetDetail.

  const partBreaker15kv = await prisma.part.create({ data: {
    accountId:    account.id,
    partNumber:   'SWGR-CB-15KV-1200A',
    description:  'Main Switchgear Circuit Breaker, 15kV 1200A vacuum interrupt',
    manufacturer: 'GE Grid Solutions',
    category:     'BREAKER',
    unitCost:     8500,
    leadTimeWeeks: 16,
    notes:        'OEM-preferred replacement for SWGR-1A lineup (1996 vintage). Long lead — order pre-emptively.',
  }});

  const partBushing = await prisma.part.create({ data: {
    accountId:    account.id,
    partNumber:   'XFMR-BUSHING-13KV-HV',
    description:  'Transformer HV Bushing, 15kV class, for Eaton VFI series',
    manufacturer: 'Eaton Cooper Power',
    category:     'TRANSFORMER',
    unitCost:     2200,
    leadTimeWeeks: 8,
    notes:        'Fits T-1 and T-2. Last bushing failure was a dielectric breakdown — keep minimum 1 on hand.',
  }});

  const partGenBattery = await prisma.part.create({ data: {
    accountId:    account.id,
    partNumber:   'GEN-BATT-12V-1000CCA',
    description:  'Generator Starting Battery, 12V 1000 CCA AGM',
    manufacturer: 'Interstate',
    category:     'OTHER',
    unitCost:     280,
    leadTimeWeeks: 1,
    notes:        'NFPA 110 §8.3.6 requires monthly battery testing; replace on indication of defect (not a fixed annual NFPA schedule). Many sites still replace generator starting batteries on a ~2-3 yr preventive cycle. Stock 2 minimum.',
  }});

  const partRelay = await prisma.part.create({ data: {
    accountId:    account.id,
    partNumber:   'SEL-751-R301',
    description:  'SEL-751 Feeder Protection Relay',
    manufacturer: 'Schweitzer Engineering',
    category:     'RELAY',
    unitCost:     3400,
    leadTimeWeeks: 12,
    notes:        'Current model on SWGR-1A-1. Firmware update to R301 resolves CID-2021-0017.',
  }});

  const partFuse = await prisma.part.create({ data: {
    accountId:    account.id,
    partNumber:   'FUSE-15KV-65E-SMD',
    description:  '15kV Current-Limiting Fuse, 65E SMD',
    manufacturer: 'S&C Electric',
    category:     'FUSE',
    unitCost:     85,
    leadTimeWeeks: 3,
    notes:        'Expulsion fuses on T-E1 and feeder taps. Keep 6+ on hand.',
  }});

  const partStarter = await prisma.part.create({ data: {
    accountId:    account.id,
    partNumber:   'MCC-STARTER-NEMA3-480V',
    description:  'NEMA Size 3 Combination Motor Starter, 480V, 45A',
    manufacturer: 'Eaton',
    category:     'OTHER',
    unitCost:     950,
    leadTimeWeeks: 4,
    notes:        'Common bucket type in MCC-1 stamping lineup.',
  }});

  const partOil = await prisma.part.create({ data: {
    accountId:    account.id,
    partNumber:   'OIL-XFMR-MINERAL-55GAL',
    description:  'Inhibited Mineral Transformer Oil, 55-gal drum (Type II)',
    manufacturer: 'Petro-Canada',
    category:     'TRANSFORMER',
    unitCost:     340,
    leadTimeWeeks: 2,
    notes:        'Top-up and dielectric test fluid for T-1 and T-2. Keep 2 drums minimum.',
  }});

  // Spare inventory — mix of healthy, at-minimum, and below-minimum stock
  await prisma.spareInventory.createMany({ data: [
    // SWGR-1A-1: 1 main breaker on hand (at minimum) — flags in the panel
    { accountId: account.id, partId: partBreaker15kv.id, assetId: assets['SWGR-1A-1'].id,
      qtyOnHand: 1, qtyMin: 1, location: 'Substation A cage shelf B-3',
      notes: 'At minimum. Long lead — reorder before any maintenance outage.' },
    // T-1: 0 HV bushings on hand (below minimum) — drives the alert story
    { accountId: account.id, partId: partBushing.id, assetId: assets['T-1'].id,
      qtyOnHand: 0, qtyMin: 1, location: 'Substation A cage shelf B-1',
      notes: 'Below minimum. Last unit consumed in the 2024 dielectric failure repair.' },
    // Site-level: 4 gen batteries (healthy stock)
    { accountId: account.id, partId: partGenBattery.id, siteId: riverside.id,
      qtyOnHand: 4, qtyMin: 2, location: 'Maintenance shop bin G-7',
      notes: 'Preventive replacement ~annually (condition-based per NFPA 110 §8.3.6 testing, not an NFPA mandate). ~2 used per generator per year.' },
    // SWGR-1A-1: 1 protection relay on hand
    { accountId: account.id, partId: partRelay.id, assetId: assets['SWGR-1A-1'].id,
      qtyOnHand: 1, qtyMin: 0, location: 'Substation A control cabinet 2-C',
      notes: 'Pre-staged for hot swap. Firmware pre-loaded to R301.' },
    // Site-level: 12 fuses (healthy)
    { accountId: account.id, partId: partFuse.id, siteId: riverside.id,
      qtyOnHand: 12, qtyMin: 6, location: 'Maintenance shop bin F-2',
      notes: 'Check after any fault operation — expulsion fuses are single-use.' },
    // MCC-1: 3 motor starters on hand (healthy)
    { accountId: account.id, partId: partStarter.id, assetId: assets['MCC-1'].id,
      qtyOnHand: 3, qtyMin: 2, location: 'MCC room spare bucket rack',
      notes: 'Standard bucket swap. 2 minimum to cover priority loads.' },
    // T-1: 1 drum transformer oil (below minimum of 2) — alert story
    { accountId: account.id, partId: partOil.id, assetId: assets['T-1'].id,
      qtyOnHand: 1, qtyMin: 2, location: 'Substation A hazmat pad H-1',
      notes: 'Below minimum. Used partial drum for T-2 oil top-up 3 months ago.' },
  ]});

  console.log('  seeded 7 parts + 7 spare inventory records');

  // -- Incident logs -----------------------------------------------------------
  // 6 incidents demonstrating the incident register: 5 resolved, 1 open.
  // Types: PROTECTIVE_TRIP, RELAY_OPERATION, ALARM, ARC_FLASH_EVENT, OTHER.
  // An open incident on SWGR-2M (45d ago) feeds the risk-score upgrade story.

  await prisma.incidentLog.createMany({ data: [
    // 1. ARC_FLASH_EVENT — resolved, 18 months ago on SWGR-1A-1
    {
      accountId:   account.id,
      assetId:     assets['SWGR-1A-1'].id,
      type:        'ARC_FLASH_EVENT',
      occurredAt:  addDays(now, -548),
      note:        'Low-energy arc event during racking operation on section 1A-1. No injuries; PPE (Cat 4) properly worn. Caused by debris on draw-out rails. Area decontaminated; study rescoped to include updated incident-energy values on this bus. PPE labels replaced.',
      resolvedAt:  addDays(now, -545),
      resolvedById: admin.id,
      createdById:  manager.id,
    },
    // 2. PROTECTIVE_TRIP — resolved, 2.5 years ago on SWGR-1A-1
    {
      accountId:   account.id,
      assetId:     assets['SWGR-1A-1'].id,
      type:        'PROTECTIVE_TRIP',
      occurredAt:  addDays(now, -912),
      note:        'CB-1A tripped on overcurrent during load restoration after utility outage. Downstream fault on MCC-1 feeder cleared by branch breaker. SWGR-1A-1 inspected; no damage found. Breaker mechanism checked, reclosed under supervision.',
      resolvedAt:  addDays(now, -910),
      resolvedById: manager.id,
      createdById:  manager.id,
    },
    // 3. RELAY_OPERATION — resolved, 14 months ago on SWGR-2M
    {
      accountId:   account.id,
      assetId:     assets['SWGR-2M'].id,
      type:        'RELAY_OPERATION',
      occurredAt:  addDays(now, -425),
      note:        'SEL-751 relay operated on B-phase overcurrent in the mezzanine lineup. Coincided with confirmed thermal overload on the B-phase bus connection (see open deficiency). Connection retorqued and thermal compound applied. Relay event log exported and reviewed by relay engineer.',
      resolvedAt:  addDays(now, -420),
      resolvedById: manager.id,
      createdById:  admin.id,
    },
    // 4. ALARM — resolved, 8 months ago on T-2 (Buchholz)
    {
      accountId:   account.id,
      assetId:     assets['T-2'].id,
      type:        'ALARM',
      occurredAt:  addDays(now, -243),
      note:        "Buchholz relay gas alarm triggered during load restoration after planned outage. Gas-in-oil analysis returned normal; attributed to air pocket introduced during oil sampling procedure. No evidence of internal fault. Alarm reset; oil level adjusted and verified.",
      resolvedAt:  addDays(now, -241),
      resolvedById: admin.id,
      createdById:  manager.id,
    },
    // 5. PROTECTIVE_TRIP — resolved, 3 months ago on GEN-1
    {
      accountId:   account.id,
      assetId:     assets['GEN-1'].id,
      type:        'PROTECTIVE_TRIP',
      occurredAt:  addDays(now, -91),
      note:        'Overspeed relay tripped GEN-1 during monthly NFPA 110 transfer test. Engine governor system found drifted out of calibration. Governor adjusted by Caterpillar-certified technician. Unit passed load test post-repair. NFPA 110 log updated.',
      resolvedAt:  addDays(now, -88),
      resolvedById: manager.id,
      createdById:  manager.id,
    },
    // 6. ALARM — UNRESOLVED, 45 days ago on SWGR-2M (open incident feeds risk score)
    {
      accountId:   account.id,
      assetId:     assets['SWGR-2M'].id,
      type:        'ALARM',
      occurredAt:  addDays(now, -45),
      note:        'Thermal imaging alarm from permanent IR monitoring window on SWGR-2M B-phase bus connection. Spot temperature 74°C ambient-corrected (delta-T 38°C above ambient); threshold 60°C for Category III. Open investigation. Interim: load reduced on affected feeder. Outage window requested for re-torque and cleaning.',
      createdById: admin.id,
    },
  ]});

  console.log('  seeded 6 incident log entries (5 resolved, 1 open)');

  // -- Arc-flash incident register ---------------------------------------------
  // DEMO-9-2: the arc-flash incident register + per-asset "Incidents & near-misses"
  // card read prisma.arcFlashIncident (arcFlashIngest.ts register/fleet/risk-score +
  // ArcFlashAssetTab.jsx), NOT incidentLog. Seed the arc-flash-relevant incidents
  // here so the hero feature's register is populated: the 18-month ARC_FLASH_EVENT on
  // the SWGR-1A hero bus (drives the per-asset tab + "incident outranks DANGER%" sort)
  // and the open SWGR-2M thermal-alarm near-miss (feeds the risk-score upgrade story),
  // plus a couple of resolved near-misses. incidentType uses the arcFlashIncident enum
  // (near_miss | arc_flash | shock | equipment_failure | other), distinct from the
  // incidentLog types above. busName matches the SystemStudyAsset binding so the
  // register links to the bus.
  await prisma.arcFlashIncident.createMany({ data: [
    // 1. arc_flash — resolved/closed, 18 months ago on the SWGR-1A hero bus
    {
      accountId:        account.id,
      assetId:          assets['SWGR-1A-1'].id,
      siteId:           riverside.id,
      busName:          'SWGR-1A Main Bus',
      incidentType:     'arc_flash',
      occurredAt:       addDays(now, -548),
      description:      'Low-energy arc event during racking operation on section 1A-1. No injuries; PPE (Cat 4) properly worn. Caused by debris on draw-out rails. Area decontaminated; study rescoped to include updated incident-energy values on this bus. PPE labels replaced.',
      injury:           false,
      ppeWorn:          'Cat 4 arc suit, face shield, voltage-rated gloves',
      workType:         'energized',
      oshaRecordable:   false,
      correctiveAction: 'Draw-out rails cleaned; racking procedure updated to require rail inspection. Study rescoped; arc-flash labels reprinted at current values.',
      status:           'closed',
      resolvedAt:       addDays(now, -545),
      reportedById:     manager.id,
    },
    // 2. near_miss — OPEN, 45 days ago on SWGR-2M (feeds the risk-score upgrade story)
    {
      accountId:    account.id,
      assetId:      assets['SWGR-2M'].id,
      siteId:       riverside.id,
      busName:      'SWGR-2M Section 1',
      incidentType: 'near_miss',
      occurredAt:   addDays(now, -45),
      description:  'Thermal imaging alarm from permanent IR monitoring window on SWGR-2M B-phase bus connection. Spot temperature 74C ambient-corrected (delta-T 38C above ambient); threshold 60C for Category III. Open investigation. Interim: load reduced on affected feeder. Outage window requested for re-torque and cleaning.',
      injury:       false,
      workType:     'inspection',
      status:       'open',
      reportedById: admin.id,
    },
    // 3. near_miss — resolved/closed, 14 months ago on SWGR-2M (relay operation)
    {
      accountId:        account.id,
      assetId:          assets['SWGR-2M'].id,
      siteId:           riverside.id,
      busName:          'SWGR-2M Section 1',
      incidentType:     'near_miss',
      occurredAt:       addDays(now, -425),
      description:      'SEL-751 relay operated on B-phase overcurrent in the mezzanine lineup, coinciding with a confirmed thermal overload on the B-phase bus connection. No arc, no injury. Connection retorqued and thermal compound applied; relay event log reviewed by relay engineer.',
      injury:           false,
      workType:         'de_energized',
      oshaRecordable:   false,
      correctiveAction: 'B-phase connection retorqued to spec; thermal compound applied. Added to IR monitoring watch list.',
      status:           'closed',
      resolvedAt:       addDays(now, -420),
      reportedById:     admin.id,
    },
    // 4. equipment_failure — resolved/closed, 3 months ago on GEN-1 (overspeed trip)
    {
      accountId:        account.id,
      assetId:          assets['GEN-1'].id,
      siteId:           riverside.id,
      busName:          'GEN-1 Output',
      incidentType:     'equipment_failure',
      occurredAt:       addDays(now, -91),
      description:      'Overspeed relay tripped GEN-1 during monthly NFPA 110 transfer test. No arc, no injury. Engine governor system found drifted out of calibration. Unit isolated during repair.',
      injury:           false,
      workType:         'de_energized',
      oshaRecordable:   false,
      correctiveAction: 'Governor adjusted by Caterpillar-certified technician; unit passed load test post-repair. NFPA 110 log updated.',
      status:           'closed',
      resolvedAt:       addDays(now, -88),
      reportedById:     manager.id,
    },
  ]});

  console.log('  seeded 4 arc-flash incidents (1 arc_flash hero-bus event + 1 open near-miss + 2 resolved)');

  // -- LOTO Procedures -------------------------------------------------------
  // One active procedure on T-1 (most critical asset), one draft on GEN-1.

  const lotoT1 = await prisma.lotoProc.create({ data: {
    accountId: account.id,
    assetId:   assets['T-1'].id,
    title:     '15kV Main Transformer T-1 Lockout Procedure Rev 1',
    status:    'active',
    version:   1,
    createdById:  admin.id,
    approvedById: manager.id,
    approvedAt:   addDays(now, -45),
    notes: 'Applies to both primary (13.8kV) and secondary (480V) sides. Minimum 2-person crew required.',
    energySources: { create: [
      {
        accountId: account.id, sortOrder: 0,
        energyType: 'electrical',
        description: '13.8kV utility feed from Riverside Plant main substation, breaker CB-101',
        isolationPoint: 'CB-101 in main substation switchgear lineup',
        isolationMethod: 'Open CB-101 using remote racking tool. Apply LOTO hasp to breaker and insert personal lock. Hang danger tag.',
        verificationMethod: 'Test primary HV terminals with hotstick-mounted voltage indicator. Confirm absence of voltage reading.',
      },
      {
        accountId: account.id, sortOrder: 1,
        energyType: 'electrical',
        description: '480V secondary output, bus tied to MCC-1 via T-1 secondary breaker CB-201',
        isolationPoint: 'CB-201 in MCC-1 main switchboard',
        isolationMethod: 'Open CB-201. Apply hasp and personal lock. Verify MCC-1 de-energised downstream.',
        verificationMethod: 'Test 480V secondary terminals with Fluke T6 or equivalent. Confirm 0V at all phases.',
      },
      {
        accountId: account.id, sortOrder: 2,
        energyType: 'thermal',
        description: 'Residual heat in transformer core and oil -- core temperature may remain elevated for 2+ hours after de-energisation',
        isolationPoint: 'N/A -- time-based isolation',
        isolationMethod: 'Allow minimum 2-hour cool-down after de-energisation before opening inspection covers.',
        verificationMethod: 'Confirm oil temperature gauge reads below 40 deg C before opening access panels.',
      },
    ]},
    steps: { create: [
      { accountId: account.id, sortOrder: 0, category: 'shutdown', instruction: 'Notify operations supervisor and affected downstream loads. Obtain written permit to proceed.' },
      { accountId: account.id, sortOrder: 1, category: 'shutdown', instruction: 'Transfer any downstream critical loads (ATS-1, UPS-1) to alternate source and confirm transfer complete.' },
      { accountId: account.id, sortOrder: 2, category: 'isolation', instruction: 'Open primary breaker CB-101 at main substation using remote racking tool. Verify open indication on SCADA.' },
      { accountId: account.id, sortOrder: 3, category: 'isolation', instruction: 'Open secondary breaker CB-201 at MCC-1 main switchboard.' },
      { accountId: account.id, sortOrder: 4, category: 'lockout', instruction: 'Apply LOTO hasp to CB-101. Each crew member inserts personal lock. Attach Danger tag with name, date, and permit number.' },
      { accountId: account.id, sortOrder: 5, category: 'lockout', instruction: 'Apply LOTO hasp to CB-201. Each crew member inserts personal lock.' },
      { accountId: account.id, sortOrder: 6, category: 'verify', instruction: 'Test primary HV terminals with hotstick-mounted voltage indicator. Confirm absence of voltage on all phases.', requiresVerification: true },
      { accountId: account.id, sortOrder: 7, category: 'verify', instruction: 'Test 480V secondary terminals at T-1 with Fluke T6. Confirm 0V on all phases.', requiresVerification: true },
      { accountId: account.id, sortOrder: 8, category: 'verify', instruction: 'Attempt to re-close CB-101 via normal operating mechanism to confirm lock prevents operation (do not force).', requiresVerification: true },
      { accountId: account.id, sortOrder: 9, category: 'verify', instruction: 'Confirm oil temperature gauge reads below 40 deg C before opening inspection covers.' },
      { accountId: account.id, sortOrder: 10, category: 'lockout', instruction: 'Post "Equipment Under Maintenance" sign on transformer pad and install physical barrier tape.' },
    ]},
  }});

  // Draft procedure on GEN-1
  await prisma.lotoProc.create({ data: {
    accountId: account.id,
    assetId:   assets['GEN-1'].id,
    title:     '750 kW Emergency Generator GEN-1 Lockout Procedure Draft',
    status:    'draft',
    version:   1,
    createdById: manager.id,
    notes: 'DRAFT -- pending review. Mechanical (fuel/cooling) sources need verification with OEM service team.',
    energySources: { create: [
      {
        accountId: account.id, sortOrder: 0,
        energyType: 'electrical',
        description: '480V generator output breaker GB-1 to emergency bus',
        isolationPoint: 'GB-1 in emergency switchboard E-SWG-1',
        isolationMethod: 'Open GB-1. Apply LOTO hasp and personal locks.',
        verificationMethod: 'Test output terminals with Fluke T6. Confirm 0V.',
      },
      {
        accountId: account.id, sortOrder: 1,
        energyType: 'mechanical',
        description: 'Engine starter motor and battery bank -- engine can be inadvertently cranked',
        isolationPoint: 'Battery disconnect switch on generator skid (red handle, left side)',
        isolationMethod: 'Open battery disconnect switch. Apply lock.',
        verificationMethod: 'Attempt to start engine via normal start button -- confirm no crank.',
      },
      {
        accountId: account.id, sortOrder: 2,
        energyType: 'thermal',
        description: 'Engine coolant and exhaust -- residual heat after shutdown',
        isolationPoint: 'N/A -- time-based',
        isolationMethod: 'Allow minimum 30-minute cool-down after engine shutdown.',
        verificationMethod: 'Confirm exhaust temp gauge below 60 deg C before contacting engine block.',
      },
    ]},
    steps: { create: [
      { accountId: account.id, sortOrder: 0, category: 'shutdown', instruction: 'Confirm generator is not carrying load. If on automatic start, disable auto-start mode at controller.' },
      { accountId: account.id, sortOrder: 1, category: 'shutdown', instruction: 'Perform normal engine shutdown via generator controller. Confirm engine stops and RPM reads 0.' },
      { accountId: account.id, sortOrder: 2, category: 'isolation', instruction: 'Open output breaker GB-1 at emergency switchboard E-SWG-1.' },
      { accountId: account.id, sortOrder: 3, category: 'isolation', instruction: 'Open battery disconnect switch on generator skid (red handle, left side).' },
      { accountId: account.id, sortOrder: 4, category: 'lockout', instruction: 'Apply LOTO hasp to GB-1 and battery disconnect. Each crew member inserts personal lock.' },
      { accountId: account.id, sortOrder: 5, category: 'verify', instruction: 'Test output terminals with Fluke T6. Confirm 0V on all phases.', requiresVerification: true },
      { accountId: account.id, sortOrder: 6, category: 'verify', instruction: 'Attempt normal start via controller to confirm auto-start and manual start are both disabled.', requiresVerification: true },
    ]},
  }});

  // Active procedure on the SWGR-1A-1 lead 15kV switchgear (Riverside).
  await prisma.lotoProc.create({ data: {
    accountId: account.id,
    assetId:   assets['SWGR-1A-1'].id,
    title:     '15kV Switchgear SWGR-1A-1 Lockout Procedure Rev 2',
    status:    'active',
    version:   2,
    createdById:  admin.id,
    approvedById: manager.id,
    approvedAt:   addDays(now, -30),
    notes: 'Metal-clad MV switchgear; racking-out the breaker is the primary isolation. Minimum 2-person crew.',
    energySources: { create: [
      {
        accountId: account.id, sortOrder: 0,
        energyType: 'electrical',
        description: '13.8kV bus energised from the T-1 secondary via the SWGR-1A main breaker',
        isolationPoint: 'SWGR-1A-1 main breaker, racked to TEST/DISCONNECT',
        isolationMethod: 'Rack the breaker to the disconnected position using the remote racking tool. Apply LOTO hasp to the racking port and insert personal lock.',
        verificationMethod: 'Confirm disconnected-position indication; test bus with hotstick voltage indicator through the viewing port.',
      },
      {
        accountId: account.id, sortOrder: 1,
        energyType: 'electrical',
        description: 'Control power for the breaker close/trip coils and space heaters',
        isolationPoint: 'Control-power fuse block / disconnect on the cubicle door',
        isolationMethod: 'Open the control-power disconnect and apply lock.',
        verificationMethod: 'Confirm no close/trip response at the control switch.',
      },
    ]},
    steps: { create: [
      { accountId: account.id, sortOrder: 0, category: 'shutdown', instruction: 'Notify operations; transfer downstream loads and obtain a written switching permit.' },
      { accountId: account.id, sortOrder: 1, category: 'isolation', instruction: 'Trip the SWGR-1A-1 main breaker and rack it out to the disconnected position with the remote racking tool.' },
      { accountId: account.id, sortOrder: 2, category: 'isolation', instruction: 'Open the cubicle control-power disconnect.' },
      { accountId: account.id, sortOrder: 3, category: 'lockout', instruction: 'Apply LOTO hasps to the racking port and control-power disconnect. Each crew member inserts a personal lock and danger tag.' },
      { accountId: account.id, sortOrder: 4, category: 'verify', instruction: 'Test the bus with a hotstick voltage indicator through the viewing port. Confirm absence of voltage on all phases.', requiresVerification: true },
    ]},
  }});

  // Draft procedure on the Eastgate dock transformer T-E1.
  await prisma.lotoProc.create({ data: {
    accountId: account.id,
    assetId:   assets['T-E1'].id,
    title:     '1000 kVA Dock Transformer T-E1 Lockout Procedure Draft',
    status:    'draft',
    version:   1,
    createdById: manager.id,
    notes: 'DRAFT -- pending Eastgate site-lead review. FR3-fluid transformer feeding the DC main switchboard.',
    energySources: { create: [
      {
        accountId: account.id, sortOrder: 0,
        energyType: 'electrical',
        description: '12.47kV primary feed from the utility riser pole',
        isolationPoint: 'Utility sectionalizing switch / primary fused cutout at the pad',
        isolationMethod: 'Open the primary cutouts; apply LOTO and confirm with the utility if it is a shared point.',
        verificationMethod: 'Test primary terminals with a hotstick voltage indicator.',
      },
      {
        accountId: account.id, sortOrder: 1,
        energyType: 'electrical',
        description: '480V secondary to the DC main switchboard main breaker',
        isolationPoint: 'Main switchboard incoming main breaker MSB-M1',
        isolationMethod: 'Open MSB-M1; apply hasp and personal lock.',
        verificationMethod: 'Test 480V secondary terminals with a Fluke T6. Confirm 0V.',
      },
    ]},
    steps: { create: [
      { accountId: account.id, sortOrder: 0, category: 'shutdown', instruction: 'Coordinate the DC outage window; transfer critical loads to the standby generator if required.' },
      { accountId: account.id, sortOrder: 1, category: 'isolation', instruction: 'Open the primary cutouts at the pad and the MSB-M1 secondary main.' },
      { accountId: account.id, sortOrder: 2, category: 'lockout', instruction: 'Apply LOTO hasps and personal locks at both isolation points.' },
      { accountId: account.id, sortOrder: 3, category: 'verify', instruction: 'Test primary and secondary terminals for absence of voltage.', requiresVerification: true },
    ]},
  }});

  // -- Documents -- OEM manual URL + test report ----------------------------
  await prisma.document.create({ data: {
    accountId:   account.id,
    assetId:     assets['T-1'].id,
    uploadedBy:  admin.id,
    filename:    'Eaton Cooper Power Transformer O&M Manual (Type VFI)',
    fileType:    'text/uri-list',
    filePath:    '__external__',
    encrypted:   false,
    docType:     'oem_manual',
    externalUrl: 'https://www.cooperpowerseriesservice.com/documents/manual-vfi',
  }});

  await prisma.document.create({ data: {
    accountId:   account.id,
    assetId:     assets['T-1'].id,
    uploadedBy:  admin.id,
    filename:    'T-1 Wiring Diagram -- Primary and Secondary One-Line',
    fileType:    'text/uri-list',
    filePath:    '__external__',
    encrypted:   false,
    docType:     'wiring_diagram',
    externalUrl: 'https://internal.example-electrical.com/docs/t1-oneline',
  }});

  await prisma.document.create({ data: {
    accountId:   account.id,
    assetId:     assets['GEN-1'].id,
    uploadedBy:  manager.id,
    filename:    'Caterpillar C175 Generator Set Operation and Maintenance Manual',
    fileType:    'text/uri-list',
    filePath:    '__external__',
    encrypted:   false,
    docType:     'oem_manual',
    externalUrl: 'https://www.cat.com/en_US/support/documentation/c175-generator-set.html',
  }});

  // -- Eastgate documents (spread coverage off Riverside) --------------------
  await prisma.document.create({ data: {
    accountId:   account.id,
    assetId:     assets['T-E1'].id,
    uploadedBy:  manager.id,
    filename:    'Cooper Power FR3 Fluid-Filled Transformer O&M Manual',
    fileType:    'text/uri-list',
    filePath:    '__external__',
    encrypted:   false,
    docType:     'oem_manual',
    externalUrl: 'https://www.cooperpowerseriesservice.com/documents/fr3-transformer-om',
  }});
  await prisma.document.create({ data: {
    accountId:   account.id,
    assetId:     assets['MCC-E1'].id,
    uploadedBy:  admin.id,
    filename:    'MCC-E1 NETA Acceptance Test Report (Eastgate DC)',
    fileType:    'text/uri-list',
    filePath:    '__external__',
    encrypted:   false,
    docType:     'test_report',
    externalUrl: 'https://internal.example-electrical.com/docs/mcc-e1-neta-report',
  }});
  await prisma.document.create({ data: {
    accountId:   account.id,
    assetId:     assets['GEN-E1'].id,
    uploadedBy:  manager.id,
    filename:    'GEN-E1 Natural-Gas Generator Commissioning (SAT) Report',
    fileType:    'text/uri-list',
    filePath:    '__external__',
    encrypted:   false,
    docType:     'commissioning_report',
    externalUrl: 'https://internal.example-electrical.com/docs/gen-e1-sat',
  }});

  // -- Real downloadable one-line drawings (SITE-level) ----------------------
  // Branded as-built one-line PDFs in object storage, attached at the SITE
  // level (not one asset) so each surfaces on EVERY asset at that site via the
  // asset<->site union. provenance 'as_built' -- demo drawings, NOT PE-sealed.
  // Non-fatal: a missing asset file must not break the seed.
  try {
    const fs = require('fs');
    const { uploadFile } = require('../lib/storage');
    const seedSiteOneLine = async (site, file, name) => {
      const bytes = fs.readFileSync(require('path').join(__dirname, 'demo-assets', file));
      const up = await uploadFile(account.id, null, name, bytes, 'application/pdf');
      await prisma.document.create({ data: {
        accountId:  account.id,
        siteId:     site.id,
        uploadedBy: admin.id,
        filename:   name,
        fileType:   'application/pdf',
        filePath:   up.storageKey,
        encrypted:  false,
        docType:    'wiring_diagram',
        provenance: 'as_built',
      }});
      return bytes.length;
    };
    const rB = await seedSiteOneLine(riverside, 'riverside-substation-a-oneline.pdf', 'Riverside Substation A -- Electrical One-Line (As-Built).pdf');
    let eB = 0;
    try {
      eB = await seedSiteOneLine(eastgate, 'eastgate-dc-oneline.pdf', 'Eastgate DC -- Electrical One-Line (As-Built).pdf');
    } catch (e2) {
      console.error('[seed] eastgate one-line skipped (file missing?):', (e2 && e2.message) || e2);
    }
    console.log('  seeded site-level one-line PDFs: Riverside ' + rB + 'B, Eastgate ' + eB + 'B');
  } catch (e) {
    console.error('[seed] one-line document seed failed (non-fatal):', (e && e.message) || e);
  }

  // -- EMP account settings --------------------------------------------------
  // Seed the three settings that drive the EMP cover page and footer so the
  // demo document renders with real values instead of placeholder warnings.
  await prisma.accountSetting.upsert({
    where:  { accountId_key: { accountId: account.id, key: 'EMP_COORDINATOR_USER_ID' } },
    update: { value: admin.id },
    create: { accountId: account.id, key: 'EMP_COORDINATOR_USER_ID', value: admin.id },
  });
  await prisma.accountSetting.upsert({
    where:  { accountId_key: { accountId: account.id, key: 'RETENTION_POLICY_TEXT' } },
    update: { value: 'All electrical maintenance records, test reports, work orders, and supporting documentation shall be retained for a minimum of five (5) years from the date of the maintenance activity, or as required by the applicable authority having jurisdiction (AHJ), whichever is longer. Records shall be stored in a secure, retrievable format and made available for inspection by the insurer, AHJ, or internal EHS auditors upon request. Digital records maintained in the ServiceCycle platform are supplemented by physical binder copies archived in the Substation A control room.' },
    create: { accountId: account.id, key: 'RETENTION_POLICY_TEXT', value: 'All electrical maintenance records, test reports, work orders, and supporting documentation shall be retained for a minimum of five (5) years from the date of the maintenance activity, or as required by the applicable authority having jurisdiction (AHJ), whichever is longer. Records shall be stored in a secure, retrievable format and made available for inspection by the insurer, AHJ, or internal EHS auditors upon request. Digital records maintained in the ServiceCycle platform are supplemented by physical binder copies archived in the Substation A control room.' },
  });
  await prisma.accountSetting.upsert({
    where:  { accountId_key: { accountId: account.id, key: 'EMP_LAST_REVIEWED_AT' } },
    update: { value: addDays(now, -182).toISOString() },
    create: { accountId: account.id, key: 'EMP_LAST_REVIEWED_AT', value: addDays(now, -182).toISOString() },
  });

  // -- Activity log -- so the Activity page isn't empty on first load --------
  await writeActivityLog({
    assetId: assets['T-1'].id, userId: admin.id, accountId: account.id,
    action: 'asset_created',
    details: { equipmentType: 'TRANSFORMER_LIQUID', site: 'Riverside Plant', source: 'demo_seed' },
  });
  await writeActivityLog({
    assetId: assets['T-2'].id, userId: manager.id, accountId: account.id,
    action: 'work_order_completed',
    details: { workOrderId: wo1.id, netaDecal: 'GREEN', contractor: 'Apex Electrical Testing' },
  });
  await writeActivityLog({
    assetId: assets['SWGR-2M'].id, userId: admin.id, accountId: account.id,
    action: 'condition_changed',
    details: { axis: 'environment', from: 'C2', to: 'C3', governingCondition: 'C3', reason: 'Dust loading in mezzanine MCC room' },
  });
  await writeActivityLog({
    assetId: assets['SWGR-2M'].id, userId: admin.id, accountId: account.id,
    action: 'deficiency_created',
    details: { severity: 'IMMEDIATE', description: 'B-phase bus connection severe overheating -- delta-T 38 deg C', source: 'demo_seed' },
  });
  await writeActivityLog({
    assetId: assets['T-1'].id, userId: manager.id, accountId: account.id,
    action: 'work_order_completed',
    details: { netaDecal: 'YELLOW', contractor: 'Apex Electrical Testing', test: 'DGA oil sample -- elevated C2H2' },
  });
  await writeActivityLog({
    assetId: assets['GEN-1'].id, userId: admin.id, accountId: account.id,
    action: 'work_order_completed',
    details: { netaDecal: 'GREEN', contractor: 'Apex Electrical Testing', test: 'NFPA 110 monthly exercise' },
  });
  await writeActivityLog({
    assetId: assets['SWGR-1A-1'].id, userId: manager.id, accountId: account.id,
    action: 'work_order_completed',
    details: { netaDecal: 'YELLOW', contractor: 'Murphy Switchgear Services', test: 'Insulation resistance -- C-phase trending low' },
  });
  await writeActivityLog({
    assetId: assets['T-2'].id, userId: manager.id, accountId: account.id,
    action: 'deficiency_created',
    details: { severity: 'ADVISORY', description: 'Oil moisture content elevated -- dehydration filtration recommended' },
  });
  await writeActivityLog({
    assetId: assets['BATT-1'].id, userId: admin.id, accountId: account.id,
    action: 'deficiency_created',
    details: { severity: 'RECOMMENDED', description: 'Two cells with rising ohmic trend -- flagged for IEEE 450 capacity verification' },
  });

  // ── Equipment templates (item 4.1 + section 2 seeding) ─────────────────────
  // The Equipment Templates page was empty (asset_templates had 0 rows), so it
  // showed its "Templates will appear here once the seed data is applied" empty
  // state. Seed account-custom templates so the page demonstrates real content.
  // They cascade-delete with the account on reseed (asset_templates -> account
  // is onDelete:Cascade), so no explicit cleanup is needed. Tasks are linked
  // from the GLOBAL task-definition matrix (accountId NULL), which survives the
  // reset, keeping the links stable across reseeds.
  const _defsByType = await _loadGlobalDefsByType(prisma);
  const templateSpecs = [
    { name: 'Liquid-Filled Power Transformer — 1000+ kVA', equipmentType: 'TRANSFORMER_LIQUID',
      description: 'Oil-filled substation transformer profile: DGA oil analysis, fluid quality, and bushing power-factor tasks pre-selected.',
      defaultCriticalityScore: 5, defaultRedundancyStatus: 'N', defaultRequiresPredictiveMaintenance: true,
      nameplateDefaults: { 'kVA': '', 'Primary Voltage': '', 'Secondary Voltage': '', 'Cooling Class': 'ONAN/ONAF', 'Impedance %': '' } },
    { name: 'Medium-Voltage Switchgear Lineup', equipmentType: 'SWITCHGEAR',
      description: 'Metal-clad MV switchgear: infrared survey, breaker primary-injection, and bus insulation-resistance tasks.',
      defaultCriticalityScore: 4, defaultRedundancyStatus: 'N_PLUS_1', defaultRequiresPredictiveMaintenance: false,
      nameplateDefaults: { 'Bus Rating (A)': '', 'Voltage Class (kV)': '', 'Short-Circuit Rating (kA)': '', 'Manufacturer': '' } },
    { name: 'Standby Diesel Generator Set', equipmentType: 'GENERATOR',
      description: 'NFPA 110 emergency generator: monthly load-bank exercise, fuel polishing, and battery-bank checks.',
      defaultCriticalityScore: 5, defaultRedundancyStatus: 'N', defaultRequiresPredictiveMaintenance: false,
      nameplateDefaults: { 'kW': '', 'Voltage': '', 'Fuel Type': 'Diesel', 'Tank Capacity (gal)': '' } },
    { name: 'Automatic Transfer Switch', equipmentType: 'TRANSFER_SWITCH',
      description: 'Life-safety ATS: NFPA 110 monthly transfer test and contact-resistance verification.',
      defaultCriticalityScore: 5, defaultRedundancyStatus: 'N', defaultRequiresPredictiveMaintenance: false,
      nameplateDefaults: { 'Amperage': '', 'Poles': '', 'Voltage': '', 'Withstand Rating (kA)': '' } },
    { name: 'Stationary Battery System', equipmentType: 'BATTERY_SYSTEM',
      description: 'IEEE 450/1188 string: quarterly ohmic readings, connection-torque checks, and capacity testing.',
      defaultCriticalityScore: 4, defaultRedundancyStatus: 'N', defaultRequiresPredictiveMaintenance: true,
      nameplateDefaults: { 'Nominal Voltage': '', 'Cell Count': '', 'Ah Rating': '', 'Chemistry': 'VRLA' } },
    { name: 'Critical LV Motor — 100+ HP', equipmentType: 'MOTOR',
      description: 'Process-critical motor: insulation resistance/PI, vibration analysis, and bearing lubrication.',
      defaultCriticalityScore: 3, defaultRedundancyStatus: 'N', defaultRequiresPredictiveMaintenance: true,
      nameplateDefaults: { 'HP': '', 'Voltage': '', 'FLA': '', 'RPM': '', 'Frame': '' } },
  ];
  let templateCount = 0;
  for (const spec of templateSpecs) {
    const tmpl = await prisma.assetTemplate.create({ data: {
      accountId: account.id,
      name: spec.name,
      description: spec.description,
      equipmentType: spec.equipmentType,
      defaultCriticalityScore: spec.defaultCriticalityScore,
      defaultRedundancyStatus: spec.defaultRedundancyStatus,
      defaultRequiresPredictiveMaintenance: spec.defaultRequiresPredictiveMaintenance,
      nameplateDefaults: spec.nameplateDefaults,
    } });
    templateCount++;
    // Link up to 5 matching global task definitions (best-effort).
    for (const d of (_defsByType[spec.equipmentType] || []).slice(0, 5)) {
      await prisma.assetTemplateTask.create({
        data: { templateId: tmpl.id, taskDefinitionId: d.id },
      }).catch(() => {});
    }
  }

  // ── Industry news: pull REAL items from the live RSS scanner (no fakes) ────
  // Previously this seeded fabricated articles with fake URLs — a bad look in a
  // demo. Trigger the real newsScanner instead (OSHA + electrical trade-press
  // RSS, filtered to compliance terms, deduped by URL). NewsItem is global (no
  // accountId) so the reset never wipes it; the login trigger (routes/auth.ts)
  // keeps it fresh per session.
  let newsCount = 0;
  try {
    const { runNewsScanner } = require('../lib/newsScanner');
    await runNewsScanner();
  } catch (e) {
    console.warn('[seed-demo] live news scan skipped:', e.message);
  }
  try { newsCount = await prisma.newsItem.count(); } catch (_) {}

  // ── PowerDB equipment + multi-year test history ────────────────────────────
  // Layer the shared PowerDB seed (4 substations + 45 breakers + 9 years of
  // WorkOrders/TestMeasurements) onto THIS demo account so it shows under
  // admin@demo.local. It is account-scoped, so the reset above wipes & this
  // recreates it on every nightly demo reset. Called exactly once per seed.
  const { seedPowerDbInto } = require('./seed-powerdb-demo');
  const pdb = await seedPowerDbInto(prisma, account.id, { siteName: 'Cedar Ridge Facility', ownerUserId: admin.id });

  // ── Extra arc-flash bus coverage across sites (Fleet Dashboard / Heat Map /
  //    Label Report demo) ──────────────────────────────────────────────────────
  // Before this, only SWGR-1A-1 was an instrumented bus, so the arc-flash Fleet
  // rollup showed "1 labelled bus" account-wide. Bind more switchgear/MCC-class
  // assets to arc_flash studies with realistic, VARIED IEEE 1584 label data:
  // a spread of incident energies + PPE categories 1-4, a mix of DANGER
  // (>40 cal/cm2 OR >600 V) and lower-severity buses, one deliberately BLOCKED
  // bus (missing fault current + device) and varied study age / device
  // provenance so the dashboard's avg-confidence and blocked-bus stats are not
  // trivially 100%/0. Riverside buses bind to the existing current arc_flash
  // study; Eastgate and Cedar Ridge get their own. (LabelSeverity enum is only
  // warning|danger — there is no 'safe' band — so low-energy 480 V buses read as
  // low-PPE WARNING. No 4.16 kV-class asset exists in the seed, so the voltage
  // spread here is 13.8 kV / 600 V / 480 V.) Runs after the PowerDB seed so the
  // Cedar Ridge site + its unit-substation assets already exist. NOT wrapped in a
  // swallowing try/catch on purpose — a write error here should fail the seed
  // loudly, not silently drop the buses.
  const cedarRidge = await prisma.site.findFirst({ where: { accountId: account.id, name: 'Cedar Ridge Facility' } });
  const cedarSubs = cedarRidge
    ? await prisma.asset.findMany({ where: { accountId: account.id, siteId: cedarRidge.id, equipmentType: 'SWITCHGEAR' }, orderBy: { serialNumber: 'asc' }, take: 4 })
    : [];

  const egPerformed = addDays(now, -Math.round(1.5 * 365)); // fresh study
  const egStudy = await prisma.systemStudy.create({ data: {
    accountId: account.id, siteId: eastgate.id, studyType: 'arc_flash',
    performedDate: egPerformed, expiresAt: addMonths(egPerformed, 60),
    performedBy: 'Hawthorne Power Engineering, PLLC', method: 'IEEE 1584-2018',
    peName: 'S. Hawthorne, PE', peLicense: 'IA PE 21487', trigger: 'scheduled',
    notes: 'Eastgate DC incident-energy analysis: main switchboard + MCC lineup.',
  } });

  let crStudy = null;
  if (cedarRidge) {
    const crPerformed = addDays(now, -Math.round(2.6 * 365));
    crStudy = await prisma.systemStudy.create({ data: {
      accountId: account.id, siteId: cedarRidge.id, studyType: 'arc_flash',
      performedDate: crPerformed, expiresAt: addMonths(crPerformed, 60),
      performedBy: 'Meridian Power Studies, Inc.', method: 'IEEE 1584-2018',
      peName: 'R. Okonkwo, PE', peLicense: 'WI PE 44120', trigger: 'scheduled',
      notes: 'Cedar Ridge four unit-substation incident-energy analysis (480Y/277 V).',
    } });
  }

  // ppeMethod + calcMethod default onto EVERY bus (they were 100% null before);
  // per-bus `o` can still override. enclosureType is set per bus (varies by class).
  const _busRow = (studyId, assetId, o) => ({ accountId: account.id, studyId, assetId, ppeMethod: 'incident_energy', calcMethod: 'ieee_1584_2018', ...o });
  const extraBuses = [
    // Riverside — bind to the current arc_flash study (`arcFlash`). 13.8 kV = DANGER.
    _busRow(arcFlash.id, assets['SWGR-1A-2'].id, { busName: 'SWGR-1A Cubicle 2', nominalVoltage: '13.8kV',
      incidentEnergyCalCm2: 16.8, arcFlashBoundaryIn: 74, workingDistanceIn: 36, ppeCategory: 3, requiredArcRatingCalCm2: 25, labelSeverity: 'danger',
      boltedFaultCurrentKA: 24.0, arcingCurrentKA: 22.7, electrodeConfig: 'VCB', conductorGapMm: 152, clearingTimeMs: 255,
      upstreamDevice: 'SWGR-1A feeder relay', deviceType: 'relay', tripUnitType: 'electronic_lsig', deviceRatingA: 1200 }),
    // SWGR-1A-3 — deliberately BLOCKED: no fault current, no protective device →
    // analyzeBusGaps readiness 'blocked' → non-zero blockedBuses + lowConfidence.
    _busRow(arcFlash.id, assets['SWGR-1A-3'].id, { busName: 'SWGR-1A Cubicle 3', nominalVoltage: '13.8kV',
      incidentEnergyCalCm2: 13.1, arcFlashBoundaryIn: 66, workingDistanceIn: 36, ppeCategory: 3, labelSeverity: 'danger' }),
    // SWGR-2M — 600 V (NOT >600) low-severity WARNING, PPE 2.
    _busRow(arcFlash.id, assets['SWGR-2M'].id, { busName: 'SWGR-2M Mezzanine LV Switchgear', nominalVoltage: '600V',
      incidentEnergyCalCm2: 8.4, arcFlashBoundaryIn: 44, workingDistanceIn: 18, ppeCategory: 2, requiredArcRatingCalCm2: 8, labelSeverity: 'warning',
      boltedFaultCurrentKA: 42.0, arcingCurrentKA: 31.4, electrodeConfig: 'VCB', conductorGapMm: 32, clearingTimeMs: 60,
      upstreamDevice: 'MCC-1 main breaker', deviceType: 'breaker', tripUnitType: 'thermal_magnetic', deviceRatingA: 2000 }),
    // MCC-1 — 480 V, low incident energy, PPE 1 (the low end of the spread).
    _busRow(arcFlash.id, assets['MCC-1'].id, { busName: 'MCC-1 Lineup', nominalVoltage: '480V',
      incidentEnergyCalCm2: 4.2, arcFlashBoundaryIn: 30, workingDistanceIn: 18, ppeCategory: 1, requiredArcRatingCalCm2: 4, labelSeverity: 'warning',
      boltedFaultCurrentKA: 35.0, arcingCurrentKA: 24.1, electrodeConfig: 'VCB', conductorGapMm: 25, clearingTimeMs: 50,
      upstreamDevice: 'SWGR-2M feeder', deviceType: 'breaker', tripUnitType: 'thermal_magnetic', deviceRatingA: 800 }),
    // Eastgate — 480 V DANGER by incident energy (>40 cal), PPE 4; field-verified
    // device (added below) pushes this bus to GREEN confidence.
    _busRow(egStudy.id, assets['MCC-E1'].id, { busName: 'MCC-E1 Main Bus', nominalVoltage: '480V',
      incidentEnergyCalCm2: 48.2, arcFlashBoundaryIn: 120, workingDistanceIn: 18, ppeCategory: 4, requiredArcRatingCalCm2: 40, labelSeverity: 'danger',
      boltedFaultCurrentKA: 38.0, arcingCurrentKA: 27.3, electrodeConfig: 'VCB', conductorGapMm: 25, clearingTimeMs: 480,
      upstreamDevice: 'MSB main breaker', deviceType: 'breaker', tripUnitType: 'electronic_lsi', deviceRatingA: 600,
      deviceSettings: { ltPickupA: 540, ltDelayS: 12, stPickupX: 6, instX: 8 } }),
  ];
  // Cedar Ridge — four 480 V unit substations, spread of severities + PPE 1-4.
  const _crBusSpecs = [
    { ie: 2.1,  ppe: 1, ab: 24,  wd: 18, req: 2,  sev: 'warning', bolt: 33, arc: 23, gap: 25, clr: 45,  tu: 'thermal_magnetic', dr: 3000 },
    { ie: 6.8,  ppe: 2, ab: 40,  wd: 18, req: 6,  sev: 'warning', bolt: 40, arc: 28, gap: 25, clr: 90,  tu: 'electronic_lsig', dr: 2000, ds: { ltPickupA: 1800, ltDelayS: 15 } },
    { ie: 12.4, ppe: 2, ab: 58,  wd: 18, req: 12, sev: 'warning', bolt: 44, arc: 31, gap: 25, clr: 150, tu: 'thermal_magnetic', dr: 1600 },
    { ie: 41.6, ppe: 4, ab: 110, wd: 18, req: 40, sev: 'danger',  bolt: 46, arc: 33, gap: 25, clr: 420, tu: 'electronic_lsi', dr: 3000, ds: { ltPickupA: 2700, ltDelayS: 18, instX: 8 } },
  ];
  if (crStudy) {
    cedarSubs.forEach((sub, i) => {
      const s = _crBusSpecs[i % _crBusSpecs.length];
      extraBuses.push(_busRow(crStudy.id, sub.id, {
        busName: (sub.serialNumber || ('Unit Sub ' + (i + 1))) + ' Main Bus', nominalVoltage: '480V',
        incidentEnergyCalCm2: s.ie, arcFlashBoundaryIn: s.ab, workingDistanceIn: s.wd, ppeCategory: s.ppe,
        requiredArcRatingCalCm2: s.req, labelSeverity: s.sev, enclosureType: 'lv_switchgear',
        boltedFaultCurrentKA: s.bolt, arcingCurrentKA: s.arc, electrodeConfig: 'VCB', conductorGapMm: s.gap, clearingTimeMs: s.clr,
        upstreamDevice: 'Unit-sub main breaker', deviceType: 'breaker', tripUnitType: s.tu, deviceRatingA: s.dr,
        ...(s.ds ? { deviceSettings: s.ds } : {}),
      }));
    });
  }
  // Demo-completeness buses: fill the arc-flash buckets that read empty across
  // ALL seeded buses so far — a 4.16 kV bus (nominalVoltage), a PPE-category-0
  // very-low-energy bus, and fuse- + switch-protected buses (deviceType +
  // FuseClass). enclosureType set here; ppeMethod/calcMethod come from _busRow.
  // 4.16 kV MV switchboard: >600 V => DANGER by voltage, but a fast current-
  // limiting upstream device keeps incident energy < 1.2 cal/cm2 => PPE cat 0.
  extraBuses.push(_busRow(arcFlash.id, assets['SWBD-1'].id, { busName: 'SWBD-1 4.16 kV Main Bus', nominalVoltage: '4.16kV',
    incidentEnergyCalCm2: 0.9, arcFlashBoundaryIn: 18, workingDistanceIn: 36, ppeCategory: 0, requiredArcRatingCalCm2: 1.2, labelSeverity: 'danger',
    boltedFaultCurrentKA: 18.0, arcingCurrentKA: 16.4, electrodeConfig: 'VCB', conductorGapMm: 104, clearingTimeMs: 20,
    upstreamDevice: 'SWBD-1 MV feeder relay', deviceType: 'relay', tripUnitType: 'electronic_lsig', deviceRatingA: 200, enclosureType: 'mv_switchgear' }));
  // 600 V fusible switchgear: fuse-protected (deviceType=fuse + FuseClass RK1).
  extraBuses.push(_busRow(egStudy.id, assets['FSG-1'].id, { busName: 'FSG-1 600 V Fusible Switchgear', nominalVoltage: '600V',
    incidentEnergyCalCm2: 5.6, arcFlashBoundaryIn: 36, workingDistanceIn: 18, ppeCategory: 2, requiredArcRatingCalCm2: 6, labelSeverity: 'warning',
    boltedFaultCurrentKA: 22.0, arcingCurrentKA: 14.8, electrodeConfig: 'VCB', conductorGapMm: 32, clearingTimeMs: 8,
    upstreamDevice: 'FSG-1 Class RK1 current-limiting fuse', deviceType: 'fuse', fuseClass: 'RK1', deviceRatingA: 400, enclosureType: 'lv_switchgear' }));
  // 480 V fused disconnect: switch-protected (deviceType=switch), low PPE 1.
  extraBuses.push(_busRow(egStudy.id, assets['DISC-1'].id, { busName: 'DISC-1 480 V Fused Disconnect', nominalVoltage: '480V',
    incidentEnergyCalCm2: 3.1, arcFlashBoundaryIn: 26, workingDistanceIn: 18, ppeCategory: 1, requiredArcRatingCalCm2: 4, labelSeverity: 'warning',
    boltedFaultCurrentKA: 20.0, arcingCurrentKA: 13.5, electrodeConfig: 'VCB', conductorGapMm: 25, clearingTimeMs: 55,
    upstreamDevice: 'DISC-1 load-break switch + fuses', deviceType: 'switch', deviceRatingA: 400, enclosureType: 'other' }));
  for (const data of extraBuses) {
    await prisma.systemStudyAsset.create({ data });
  }
  // Field-verified device on the Eastgate DANGER bus → device provenance 'field'
  // scores +20 confidence, giving the fleet at least one GREEN bus.
  await prisma.protectiveDevice.create({ data: {
    accountId: account.id, siteId: eastgate.id, assetId: assets['MCC-E1'].id,
    label: 'MSB main breaker', deviceType: 'breaker',
    manufacturer: 'Square D', model: 'PowerPact', sensorRatingA: 600,
    settings: { ltPickupA: 540, ltDelayS: 12 },
    source: 'field', settingsCollectedAt: addDays(now, -40),
  } }).catch(() => {});

  // Cedar Ridge documents + one active LOTO (third site with a procedure).
  if (cedarRidge && cedarSubs[0]) {
    await prisma.document.create({ data: {
      accountId: account.id, assetId: cedarSubs[0].id, uploadedBy: admin.id,
      filename: 'Cedar Ridge Unit-Substation One-Line (As-Built)',
      fileType: 'text/uri-list', filePath: '__external__', encrypted: false,
      docType: 'wiring_diagram', provenance: 'as_built',
      externalUrl: 'https://internal.example-electrical.com/docs/cedar-ridge-oneline',
    }});
    await prisma.document.create({ data: {
      accountId: account.id, assetId: cedarSubs[0].id, uploadedBy: admin.id,
      filename: 'Square D Unit Substation O&M Manual',
      fileType: 'text/uri-list', filePath: '__external__', encrypted: false,
      docType: 'oem_manual', externalUrl: 'https://www.se.com/us/en/product-range/unit-substation-om',
    }});
    if (cedarSubs[1]) {
      await prisma.document.create({ data: {
        accountId: account.id, assetId: cedarSubs[1].id, uploadedBy: admin.id,
        filename: 'Cedar Ridge Annual NETA Breaker Test Report',
        fileType: 'text/uri-list', filePath: '__external__', encrypted: false,
        docType: 'test_report', externalUrl: 'https://internal.example-electrical.com/docs/cedar-ridge-neta',
      }});
    }
    await prisma.lotoProc.create({ data: {
      accountId: account.id, assetId: cedarSubs[0].id,
      title: 'Cedar Ridge Unit Substation Lockout Procedure Rev 1',
      status: 'active', version: 1, createdById: admin.id, approvedById: manager.id, approvedAt: addDays(now, -20),
      notes: '480Y/277 V LV unit substation; rack out the main and lock the transformer primary.',
      energySources: { create: [
        { accountId: account.id, sortOrder: 0, energyType: 'electrical',
          description: '480 V main bus energised from the unit-substation transformer secondary',
          isolationPoint: 'Unit-substation main breaker (racked to DISCONNECT)',
          isolationMethod: 'Trip and rack out the main breaker; apply LOTO hasp and personal lock.',
          verificationMethod: 'Test the bus for absence of voltage with a Fluke T6.' },
      ]},
      steps: { create: [
        { accountId: account.id, sortOrder: 0, category: 'isolation', instruction: 'Trip and rack out the unit-substation main breaker.' },
        { accountId: account.id, sortOrder: 1, category: 'lockout', instruction: 'Apply LOTO hasp and personal locks to the racking port.' },
        { accountId: account.id, sortOrder: 2, category: 'verify', instruction: 'Confirm 0 V on all phases at the bus.', requiresVerification: true },
      ]},
    }});
  }
  console.log('  seeded ' + extraBuses.length + ' additional arc-flash labelled buses across Riverside/Eastgate/Cedar Ridge (+ Cedar Ridge docs + LOTO)');

  // ── Demo-completeness backfill ──────────────────────────────────────────────
  // Fills the remaining classification buckets that otherwise read empty in the
  // demo account: work-order status/type, quote driver/timeline/status, alert
  // type/status, document type/provenance, LOTO energy types + archived status,
  // IR-thermography measurement priorities, and edge disaster event types. Runs
  // after all base data so the compliance snapshot below captures it.
  {
    // -- Work orders: EMERGENCY, AWAITING_APPROVAL, CANCELLED, INSPECTION --
    await prisma.workOrder.create({ data: {
      accountId: account.id, assetId: assets['SWGR-2M'].id,
      contractorId: murphy.id, assignedTechId: murphyTechs.tran.id,
      status: 'IN_PROGRESS', workOrderType: 'EMERGENCY', netaCertLevel: 'LEVEL_II',
      scheduledDate: addDays(now, -1), startedAt: addDays(now, -1),
      notes: 'EMERGENCY: smoke reported from the SWGR-2M mezzanine lineup; de-energized and dispatched for immediate inspection/repair.',
    } });
    await prisma.workOrder.create({ data: {
      accountId: account.id, assetId: assets['T-1'].id,
      status: 'AWAITING_APPROVAL', workOrderType: 'CORRECTIVE', netaCertLevel: 'LEVEL_III',
      scheduledDate: addDays(now, 20), laborCostCents: 4200000,
      notes: 'Proposed T-1 bushing replacement + oil processing ($42k) — awaiting manager approval before the outage is scheduled.',
    } });
    await prisma.workOrder.create({ data: {
      accountId: account.id, assetId: assets['T-1'].id,
      status: 'CANCELLED', workOrderType: 'PREVENTIVE', netaCertLevel: 'LEVEL_II',
      scheduledDate: addDays(now, 30),
      notes: 'Routine TTR PM cancelled — folded into the approved T-1 modernization scope instead of running as a standalone visit.',
    } });
    // INSPECTION: an IR-thermography survey with NETA priority hot-spots. Fills
    // both the INSPECTION work-order type and severityPriority, which was 100%
    // null across every seeded measurement.
    const irWO = await prisma.workOrder.create({ data: {
      accountId: account.id, assetId: assets['SWGR-1A-1'].id,
      contractorId: apex.id, assignedTechId: apexTechs.rios.id,
      status: 'COMPLETE', workOrderType: 'INSPECTION', netaDecal: 'YELLOW', netaCertLevel: 'LEVEL_II',
      scheduledDate: addDays(now, -12), startedAt: addDays(now, -12), completedDate: addDays(now, -12),
      notes: 'Annual IR thermography survey of the SWGR-1A lineup (Infraspection Level II). Hot-spots graded to NETA Table 100.18 dT priorities.',
    } });
    const _irSpots = [
      { loc: 'SWGR-1A-1 Phase A line-side lug', dt: 22.4, p: 1, load: 68 },
      { loc: 'SWGR-1A-1 Phase B line-side lug', dt: 3.1,  p: 4, load: 68 },
      { loc: 'SWGR-1A-1 Phase C line-side lug', dt: 1.8,  p: 4, load: 68 },
      { loc: 'Main breaker load-side terminal A', dt: 9.6, p: 2, load: 72 },
      { loc: 'Main breaker load-side terminal B', dt: 7.2, p: 2, load: 72 },
      { loc: 'Feeder 3 disconnect stab', dt: 18.9, p: 1, load: 55 },
      { loc: 'Feeder 5 lug torque joint', dt: 5.4, p: 3, load: 61 },
      { loc: 'Bus tie splice plate', dt: 12.1, p: 2, load: 64 },
      { loc: 'CT secondary terminal block', dt: 2.3, p: 4, load: 58 },
      { loc: 'PT primary fuse clip', dt: 6.7, p: 3, load: 58 },
      { loc: 'Ground bus bond', dt: 16.8, p: 1, load: 70 },
      { loc: 'Feeder 2 cable termination', dt: 4.9, p: 3, load: 66 },
      { loc: 'Neutral bus connection', dt: 10.3, p: 2, load: 66 },
      { loc: 'Space heater circuit lug', dt: 1.2, p: 4, load: 40 },
    ];
    for (const h of _irSpots) {
      await prisma.testMeasurement.create({ data: {
        accountId: account.id, workOrderId: irWO.id,
        measurementType: 'ir_thermography', label: h.loc,
        asFoundValue: h.dt, asFoundUnit: 'C',
        loadPercent: h.load, severityPriority: h.p,
        passFail: h.p <= 1 ? 'RED' : h.p <= 2 ? 'YELLOW' : 'GREEN',
        expectedRange: 'dT <= 3C vs similar component (NETA Table 100.18)',
        notes: 'IR hot-spot dT vs. similar component under load.',
      } });
    }

    // -- Quote requests: down_now + immediately + emergencyMode, and a draft --
    await prisma.quoteRequest.create({ data: {
      accountId: account.id, assetId: assets['SWGR-2M'].id, requestedById: manager.id,
      status: 'requested', driver: 'down_now', timeline: 'immediately',
      outageAvailable: true, budgeted: false, emergencyMode: true, priority: 'emergency',
      dossierSnapshot: snap('SWGR-2M', 'SWGR-2M Mezzanine Switchgear'),
      notes: 'EMERGENCY — mezzanine switchgear tripped and will not reclose; production line down. Need a tech on site today.',
      createdAt: addDays(now, -1),
    } });
    await prisma.quoteRequest.create({ data: {
      accountId: account.id, assetId: assets['MCC-1'].id, requestedById: admin.id,
      status: 'draft', driver: 'planned_replacement', timeline: 'next_budget_cycle',
      outageAvailable: false, budgeted: false, emergencyMode: false,
      dossierSnapshot: snap('MCC-1', 'MCC-1 Lineup'),
      notes: 'DRAFT — gathering scope for an MCC-1 bucket refurbishment; not yet submitted to the service rep.',
      createdAt: addDays(now, -3),
    } });

    // -- Documents: fill the remaining docType + provenance buckets --
    const _extDoc = (o) => prisma.document.create({ data: {
      accountId: account.id, uploadedBy: admin.id,
      fileType: 'text/uri-list', filePath: '__external__', encrypted: false, ...o,
    }});
    await _extDoc({ assetId: assets['SWGR-1A-1'].id, filename: 'Riverside Substation A One-Line (PE-Sealed)',
      docType: 'wiring_diagram', provenance: 'pe_sealed',
      externalUrl: 'https://internal.example-electrical.com/docs/riverside-subA-oneline-sealed' });
    await _extDoc({ assetId: assets['T-1'].id, filename: 'Riverside Property Insurance Electrical Inspection Report',
      docType: 'inspection_report', provenance: 'engineered',
      externalUrl: 'https://internal.example-electrical.com/docs/riverside-insurer-inspection' });
    await _extDoc({ assetId: assets['UPS-1'].id, filename: 'Stonebridge SB-80U UPS Warranty Certificate',
      docType: 'warranty', provenance: 'vendor',
      externalUrl: 'https://www.stonebridge-demo.local/warranty/SB-18-0954' });
    await _extDoc({ assetId: assets['SWGR-2M'].id, filename: 'SWGR-2M Scanned LOTO Procedure (PDF backup)',
      docType: 'loto_pdf', provenance: 'as_built',
      externalUrl: 'https://internal.example-electrical.com/docs/swgr-2m-loto-scan' });
    await _extDoc({ assetId: assets['GEN-1'].id, filename: 'GEN-1 Site Photo Set (misc)',
      docType: 'other', provenance: 'unverified',
      externalUrl: 'https://internal.example-electrical.com/docs/gen-1-photos' });

    // -- LOTO: a multi-energy active procedure (pneumatic / hydraulic / chemical /
    //    gravity, which were absent) + one archived (superseded) revision --
    await prisma.lotoProc.create({ data: {
      accountId: account.id, assetId: assets['MTR-1'].id,
      title: 'MTR-1 ID-Fan Motor Skid Lockout Procedure Rev 2',
      status: 'active', version: 2, createdById: admin.id, approvedById: manager.id, approvedAt: addDays(now, -30),
      notes: 'Multi-energy isolation for the ID-fan motor skid: electrical + stored mechanical, hydraulic, pneumatic, gravity, and process-chemical sources.',
      energySources: { create: [
        { accountId: account.id, sortOrder: 0, energyType: 'electrical',
          description: '480 V VFD feed to the ID-fan motor (VFD-1 output).',
          isolationPoint: 'MCC-1 bucket for VFD-1', isolationMethod: 'Open and lock the feeder breaker; apply hasp + personal lock.',
          verificationMethod: 'Test motor terminals for absence of voltage.' },
        { accountId: account.id, sortOrder: 1, energyType: 'mechanical',
          description: 'Stored rotational energy in the fan wheel / motor rotor.',
          isolationPoint: 'Fan shaft coupling', isolationMethod: 'Allow spin-down; engage the shaft brake pin.',
          verificationMethod: 'Confirm zero rotation for 60 s.' },
        { accountId: account.id, sortOrder: 2, energyType: 'hydraulic',
          description: 'Pressurized lube-oil system for the sleeve bearings.',
          isolationPoint: 'Lube-oil supply valve LV-14', isolationMethod: 'Close and lock LV-14; bleed the accumulator.',
          verificationMethod: 'Confirm 0 psi on the lube-oil gauge.' },
        { accountId: account.id, sortOrder: 3, energyType: 'pneumatic',
          description: 'Instrument air to the inlet-damper actuator.',
          isolationPoint: 'Air header block valve AV-3', isolationMethod: 'Close and lock AV-3; vent the actuator.',
          verificationMethod: 'Confirm 0 psi at the actuator; damper drifts to fail position.' },
        { accountId: account.id, sortOrder: 4, energyType: 'gravity',
          description: 'Suspended inlet-damper counterweight can fall when air is removed.',
          isolationPoint: 'Counterweight arm', isolationMethod: 'Pin the counterweight arm in the down position.',
          verificationMethod: 'Confirm the pin is seated and load-bearing.' },
        { accountId: account.id, sortOrder: 5, energyType: 'chemical',
          description: 'Process gas / coolant line tapping into the fan housing.',
          isolationPoint: 'Coolant isolation valve CV-2 (double-block-and-bleed)', isolationMethod: 'Close both block valves; open the bleed; lock all three.',
          verificationMethod: 'Confirm 0 flow and atmospheric pressure at the bleed.' },
      ]},
      steps: { create: [
        { accountId: account.id, sortOrder: 0, category: 'shutdown', instruction: 'Stop the drive from the local HMI and confirm the fan is coasting down.' },
        { accountId: account.id, sortOrder: 1, category: 'isolation', instruction: 'Isolate all six energy sources per the source list.' },
        { accountId: account.id, sortOrder: 2, category: 'lockout', instruction: 'Apply LOTO hasps and personal locks at every isolation point.' },
        { accountId: account.id, sortOrder: 3, category: 'verify', instruction: 'Verify zero energy at every source before work begins.', requiresVerification: true },
      ]},
    }});
    await prisma.lotoProc.create({ data: {
      accountId: account.id, assetId: assets['SWGR-2M'].id,
      title: 'SWGR-2M Mezzanine Switchgear Lockout Procedure Rev 1 (superseded)',
      status: 'archived', version: 1, createdById: admin.id, approvedById: manager.id, approvedAt: addDays(now, -400),
      notes: 'Superseded by Rev 2 after the 2025 bus-bracing modification changed the racking sequence. Retained for audit history.',
      energySources: { create: [
        { accountId: account.id, sortOrder: 0, energyType: 'electrical',
          description: '600 V feed from the MCC-1 main breaker (pre-modification arrangement).',
          isolationPoint: 'MCC-1 main breaker', isolationMethod: 'Open and lock the main breaker.',
          verificationMethod: 'Test the bus for absence of voltage.' },
      ]},
      steps: { create: [
        { accountId: account.id, sortOrder: 0, category: 'lockout', instruction: 'Open and lock the MCC-1 main breaker (old sequence).' },
        { accountId: account.id, sortOrder: 1, category: 'verify', instruction: 'Confirm 0 V on the SWGR-2M bus.', requiresVerification: true },
      ]},
    }});

    // -- Alerts: fill the remaining alertType + status buckets. Guarded by
    //    schedule presence (task-matrix drift => skip rather than crash). --
    const _mkAlert = async (schedKey, type, status, extra = {}) => {
      const sched = schedules[schedKey];
      if (!sched) return;
      await prisma.alert.create({ data: {
        accountId: account.id, scheduleId: sched.id, assetId: sched.assetId,
        alertType: type, scheduledAt: addDays(now, -10), createdAt: addDays(now, -10),
        sentAt: status === 'pending' ? null : addDays(now, -10),
        status, ...extra,
      }});
    };
    await _mkAlert('SWGR-2M:SWGR_IR_THERMO', 'condition_degradation', 'escalated', { escalatedAt: addDays(now, -4) });
    await _mkAlert('SWGR-1A-1:SWGR_INSULATION_RES', 'deficiency_alert', 'sent');
    await _mkAlert('SWGR-1A-1:SWGR_IR_THERMO', 'arc_flash_expiry', 'sent');
    await _mkAlert('BATT-1:BATT_OHMIC_FLOAT', 'asset_decommission', 'cancelled');

    // -- Disaster events: edge eventTypes (hurricane / ice_storm / earthquake).
    //    Guarded by nwsAlertId (accountId-null NWS rows survive the reset). --
    const _mkDisaster = async (guardId, data) => {
      const exists = await prisma.disasterEvent.findFirst({ where: { nwsAlertId: guardId } }).catch(() => null);
      if (!exists) await prisma.disasterEvent.create({ data: { ...data, nwsAlertId: guardId } });
    };
    await _mkDisaster('demo-seed-hurricane-remnants', {
      eventType: 'hurricane', severity: 'watch',
      title: 'Flood Watch — remnants of a Gulf hurricane tracking up the Mississippi Valley',
      region: 'Upper Mississippi Valley — Quad Cities metro',
      affectedStates: ['IA', 'IL'], affectedSiteIds: [riverside.id, eastgate.id],
      source: 'nws', declaredAt: addDays(now, -95), resolvedAt: addDays(now, -92),
    });
    await _mkDisaster('demo-seed-ice-storm-warning', {
      eventType: 'ice_storm', severity: 'warning',
      title: 'Ice Storm Warning — 0.5 in. ice accumulation, widespread outages likely',
      region: 'Eastern Iowa / Northwestern Illinois — Quad Cities metro',
      affectedStates: ['IA', 'IL'], affectedSiteIds: [riverside.id, eastgate.id],
      source: 'nws', declaredAt: addDays(now, -60), resolvedAt: addDays(now, -58),
    });
    await _mkDisaster('demo-seed-earthquake-report', {
      accountId: account.id,
      eventType: 'earthquake', severity: 'emergency',
      title: 'M4.6 Earthquake — New Madrid seismic activity felt at Riverside; inspection triggered',
      region: 'Riverside Plant — Scott County, IA',
      affectedStates: ['IA'], affectedSiteIds: [riverside.id],
      source: 'manual', declaredBy: admin.id, declaredAt: addDays(now, -30), resolvedAt: addDays(now, -29),
    });
  }

  // ── Compliance snapshots (G1) — REAL generated evidence packs ─────────────
  // Snapshot downloads stream the stored file and verify sha256, so fake rows
  // 404. lib/snapshotPipeline.generateSnapshot is the same render → hash →
  // store → row → audit-anchor pipeline the UI button uses; run it twice so
  // the Compliance Snapshots list shows account-wide and per-site evidence.
  // Runs LAST so the PDFs capture the fully-seeded account. Cleanup: the
  // reset deletes the stored files + rows (see _resetDemoAccount).
  // Best-effort — a storage/render failure must not sink the whole seed.
  let snapshotCount = 0;
  {
    const { generateSnapshot } = require('../lib/snapshotPipeline');
    // Each scope is generated + guarded INDEPENDENTLY. generateSnapshot throws
    // NO_DATA for a site with no standard/schedule coverage (e.g. the Cedar Ridge
    // PowerDB breaker site has WorkOrders/measurements but no maintenance
    // schedules) — that must skip only THAT scope, not abort the whole block the
    // way a single shared try/catch did.
    const _snapScopes = [
      { label: 'account-wide (all sites)', args: {} },
      { label: 'Riverside Plant', args: { siteId: riverside.id } },
      { label: 'Eastgate Distribution Center', args: { siteId: eastgate.id } },
      ...(cedarRidge ? [{ label: 'Cedar Ridge Facility', args: { siteId: cedarRidge.id } }] : []),
    ];
    for (const scope of _snapScopes) {
      try {
        await generateSnapshot(prisma, {
          accountId: account.id, userId: admin.id, userName: admin.name, ...scope.args,
        });
        snapshotCount++;
      } catch (e) {
        console.warn('[seed-demo] compliance snapshot skipped for ' + scope.label + ':', e.message);
      }
    }
  }

  return {
    accountId: account.id,
    companyName: account.companyName,
    users: { admin: admin.email, manager: manager.email, viewer: viewer.email, consultant: consultant.email, tech: tech.email },
    counts: {
      users: 5,
      powerDbAssets: pdb.assets, powerDbWorkOrders: pdb.workOrders, powerDbMeasurements: pdb.measurements,
      sites: 2, buildings: 1, areas: 2, positions: posSpecs.length + egPosSpecs.length,
      contractors: 2, contractorTechs: 5,
      assets: assetSpecs.length, archivedAssets: archivedAssetCount,
      schedules: scheduleCount,
      workOrders: 29, testMeasurements: wo2Measurements.length,
      deficiencies: 9, labSamples: 4, systemStudies: 5,
      auditVisits: 4, auditRecommendations: 6,
      alerts: alertCount,
      assetsWithOwner: 6, blackoutWindows: 1, quoteRequests: 12, parts: 7, incidentLogs: 6,
      activityLogs: 9,
      lotoProcs: 5, documents: 9,
      assetTemplates: templateCount, newsItems: newsCount,
      complianceSnapshots: snapshotCount,
    },
    dashboardStory: {
      overdue: 5, regulatoryBreachTier: 1,
      dueWithin30Days: 6, due60To90Days: 5,
      openDeficiencies: 8, immediateOpen: 1,
      arcFlashExpiringWithinMonths: 10,
      criticalityScored: 11, predictiveMaintenanceFlagged: 2,
    },
  };
}

// -- Per-visitor sandbox seed ------------------------------------------------

/**
 * seedAccountForUser(userId)
 *
 * Populate a freshly-created per-visitor demo Account with a SMALLER version
 * of the canned facility (1 site, 6 assets, full schedule set for the Tier 1
 * assets, 2 work orders, 2 deficiencies). Used by the DEMO_MODE registration
 * handler in routes/auth.ts after it creates the visitor's User + Account;
 * lib/demoPrune.ts reaps these sandboxes after 5 days of inactivity.
 *
 * Idempotency: this is NOT idempotent -- it always creates new rows. Calling
 * twice on the same account doubles the data (site name collision will throw
 * on the @@unique(accountId, name), which is the desired guard).
 */
async function seedAccountForUser(userId) {
  if (!userId) throw new Error('seedAccountForUser: userId is required');
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { id: true, accountId: true },
  });
  if (!user) throw new Error(`seedAccountForUser: user ${userId} not found`);
  const accountId = user.accountId;
  const now = new Date();

  // Sandbox conveniences -- each block independently guarded so a failure
  // never produces an empty sandbox.
  try {
    await prisma.account.update({ where: { id: accountId }, data: { fteCount: 240, aiBriefEnabled: true } });
  } catch (e) { console.warn('[seed-demo] sandbox account update failed:', e.message); }
  try {
    await prisma.accountSetting.upsert({
      where:  { accountId_key: { accountId, key: 'ONBOARDING_COMPLETE' } },
      update: { value: 'true' },
      create: { accountId, key: 'ONBOARDING_COMPLETE', value: 'true' },
    });
  } catch (e) { console.warn('[seed-demo] onboarding flag failed:', e.message); }
  // DEMO_FIXES 2.6 — mark the instance as set up so a freshly seeded DB is
  // immediately usable without a manual SQL UPDATE or running the setup wizard.
  // Idempotent upsert; leaves demoLastResetAt/demoMode alone.
  try {
    await prisma.instanceConfig.upsert({
      where:  { id: 'singleton' },
      update: { setupCompletedAt: new Date() },
      create: { id: 'singleton', setupCompletedAt: new Date() },
    });
  } catch (e) { console.warn('[seed-demo] setupCompletedAt failed:', e.message); }
  // Pre-record AI consent so AI features work immediately without the modal
  // (demo data is fabricated; the sandbox banner warns not to enter real data).
  try {
    const { getCurrentConsentVersion, getActiveProvider } = require('../lib/aiConsent');
    await prisma.user.update({
      where: { id: user.id },
      data: {
        aiConsentDismissedAt:          new Date(),
        aiConsentVersion:              getCurrentConsentVersion(),
        aiConsentProviderAtAcceptance: getActiveProvider(),
        aiConsentSilenced:             true,
      },
    });
  } catch (e) { console.warn('[seed-demo] AI consent pre-ack failed:', e.message); }

  // The global matrix normally exists (deploy + demo cron both seed it);
  // backstop for a sterile database.
  let defsByType = await _loadGlobalDefsByType(prisma);
  if (Object.keys(defsByType).length === 0) {
    await seedStandards(prisma);
    defsByType = await _loadGlobalDefsByType(prisma);
  }

  // 1 contractor + tech for the work orders.
  const contractor = await prisma.contractor.create({ data: {
    accountId, name: 'Cascade Power Testing',
    netaAccredited: true,
    supportEmail: 'service@cascadetesting-demo.local', supportPhone: '800-555-0150',
  } });
  const tech = await prisma.contractorTech.create({ data: {
    contractorId: contractor.id, name: 'Rosa Imani',
    title: 'Senior Test Technician', netaCertLevel: 'LEVEL_III',
  } });

  // 1 flat site with a couple of named positions.
  const site = await prisma.site.create({ data: {
    accountId, name: 'Harborview Plant',
    address: '212 Pierhead Avenue', city: 'Green Bay', state: 'WI', postalCode: '54302',
    notes: 'Sandbox facility -- flat hierarchy (positions directly under the site).',
  } });
  const padPos = await prisma.equipmentPosition.create({ data: {
    accountId, siteId: site.id, name: 'XFMR Pad 1', code: 'XFMR-PAD-1',
  } });
  const swgrPos = await prisma.equipmentPosition.create({ data: {
    accountId, siteId: site.id, name: 'Main Switchgear Lineup', code: 'SWGR-1',
  } });

  // 6 assets -- 5 Tier 1 (get schedules) + 1 dry transformer (matrix gap).
  const assetSpecs = [
    { key: 'T-1', siteId: site.id, positionId: padPos.id, equipmentType: 'TRANSFORMER_LIQUID',
      manufacturer: 'Kestrel Power Apparatus', model: 'KPA-2000S', serialNumber: 'KPA-02-44102',
      installDate: new Date('2002-05-21'),
      nameplateData: { kVA: 2000, primaryVoltage: '13.8 kV delta', secondaryVoltage: '480Y/277 V', impedancePercent: 5.6, oilType: 'mineral', gallons: 560 } },
    { key: 'T-2', siteId: site.id, equipmentType: 'TRANSFORMER_LIQUID',
      manufacturer: 'Kestrel Power Apparatus', model: 'KPA-750S', serialNumber: 'KPA-11-58320',
      installDate: new Date('2011-08-09'),
      nameplateData: { kVA: 750, primaryVoltage: '13.8 kV delta', secondaryVoltage: '480Y/277 V', impedancePercent: 5.3, oilType: 'mineral', gallons: 300 } },
    { key: 'SWGR-1', siteId: site.id, positionId: swgrPos.id, equipmentType: 'SWITCHGEAR',
      manufacturer: 'NorthStar Switchgear Co.', model: 'NS-MV15', serialNumber: 'NS-02-5160',
      installDate: new Date('2002-05-21'),
      nameplateData: { voltageClass: '15 kV', busRating: '1200 A', aic: '25 kA' } },
    { key: 'SWGR-2', siteId: site.id, equipmentType: 'SWITCHGEAR',
      manufacturer: 'NorthStar Switchgear Co.', model: 'NS-LV600', serialNumber: 'NS-07-8841',
      installDate: new Date('2007-03-14'),
      conditionEnvironment: 'C3',
      nameplateData: { voltageClass: '600 V', busRating: '1600 A', aic: '50 kA' },
      notes: 'Boiler-room environment drives the C3 rating; compressed intervals.' },
    { key: 'GEN-1', siteId: site.id, equipmentType: 'GENERATOR',
      manufacturer: 'Calder Engine & Generator', model: 'CG-500D', serialNumber: 'CG-09-3317',
      installDate: new Date('2009-10-27'),
      nameplateData: { kw: 500, voltage: '480Y/277 V', rpm: 1800, fuelType: 'diesel', tankGallons: 750 } },
    { key: 'TXD-1', siteId: site.id, equipmentType: 'TRANSFORMER_DRY',
      manufacturer: 'Vantage Electric Works', model: 'VE-225DT', serialNumber: 'VE-17-6612',
      installDate: new Date('2017-01-19'),
      nameplateData: { kVA: 225, primaryVoltage: '480 V delta', secondaryVoltage: '208Y/120 V', tempRiseC: 150, kFactor: 'K-13' },
      notes: 'No global task matrix rows for dry transformers yet -- schedule coverage gap.' },
  ];
  const assets = {};
  for (const spec of assetSpecs) {
    assets[spec.key] = await _createAsset(prisma, accountId, spec);
  }

  // Schedules: 1 overdue, a couple inside 30 days, rest in the future.
  const story = {
    'SWGR-2:SWGR_IR_THERMO':      { dueIn: -35 },
    'T-1:XFMR_DGA':               { dueIn: 12 },
    'SWGR-1:SWGR_IR_THERMO':      { dueIn: 25 },
    'GEN-1:GEN_MONTHLY_EXERCISE': { completedAgo: 18 },
    'T-1:XFMR_INSULATION_RES':    { completedAgo: 25 },
  };
  const { byKey: schedules, count: scheduleCount } =
    await _createSchedules(prisma, accountId, assets, defsByType, story);

  // 2 work orders: one COMPLETE (GREEN), one SCHEDULED against the overdue scan.
  const wo1 = await prisma.workOrder.create({ data: {
    accountId,
    scheduleId: schedules['T-1:XFMR_INSULATION_RES'].id,
    assetId: assets['T-1'].id,
    contractorId: contractor.id, assignedTechId: tech.id,
    netaCertLevel: 'LEVEL_II',
    status: 'COMPLETE',
    scheduledDate: addDays(now, -27), startedAt: addDays(now, -25), completedDate: addDays(now, -25),
    asFoundCondition: 'C2', asLeftCondition: 'C2',
    netaDecal: 'GREEN',
    notes: 'IR + PI within IEEE limits on all windings. No findings.',
  } });
  const wo2 = await prisma.workOrder.create({ data: {
    accountId,
    scheduleId: schedules['SWGR-2:SWGR_IR_THERMO'].id,
    assetId: assets['SWGR-2'].id,
    contractorId: contractor.id, assignedTechId: tech.id,
    netaCertLevel: 'LEVEL_II',
    status: 'SCHEDULED',
    scheduledDate: addDays(now, 14),
    notes: 'Catch-up IR scan for the overdue boiler-room lineup; scan under load.',
  } });

  // 2 deficiencies: 1 RECOMMENDED + 1 ADVISORY, both open.
  await prisma.deficiency.create({ data: {
    accountId, assetId: assets['SWGR-2'].id,
    severity: 'RECOMMENDED',
    description: 'Heavy dust accumulation on standoff insulators; tracking risk under humid conditions',
    correctiveAction: 'Clean and vacuum lineup at next de-energized window; improve room filtration.',
    createdAt: addDays(now, -20),
  } });
  await prisma.deficiency.create({ data: {
    accountId, assetId: assets['T-1'].id,
    severity: 'ADVISORY',
    description: 'Paint blistering on radiator fins (cosmetic); no oil weep detected',
    correctiveAction: 'Monitor at annual visual inspection.',
    createdAt: addDays(now, -40),
  } });

  // A first activity row so the visitor's Activity page has content.
  await writeActivityLog({
    assetId: assets['T-1'].id, userId: user.id, accountId,
    action: 'asset_created',
    details: { equipmentType: 'TRANSFORMER_LIQUID', site: 'Harborview Plant', source: 'demo_sandbox_seed' },
  });

  return {
    accountId,
    sites: 1,
    contractors: 1,
    assets: assetSpecs.length,
    schedules: scheduleCount,
    workOrders: 2,
    deficiencies: 2,
  };
}

/**
 * Wipe the demo account tree and re-seed from scratch.
 * Ensures the global standards/task matrix exists first (idempotent).
 * @param {{ trigger?: 'cli'|'cron'|'manual' }} opts
 */
// -- Platform rate sheet (Revenue Intelligence dollar estimates) --------------
// Single platform-level row (no accountId), so it is NOT wiped by the demo-
// account reset. Researched US-average rates so /admin/opportunities estimates
// are accurate and defensible in a demo. lastConfirmedAt = now => 'fresh', so
// dollar estimates are visible immediately after a reseed.
async function _seedRateSheet() {
  await prisma.rateSheet.deleteMany({});
  await prisma.rateSheet.create({ data: {
    arcFlashStudyPerPanelCents:  15000,    // $150/panel (per bus) -- small <20-panel studies run $3.5k-$7.5k
    arcFlashStudyMinimumCents:   350000,   // $3,500 small-facility floor
    arcFlashStudyMaximumCents:   5000000,  // $50,000 site cap (large studies reach $50k+)
    pmServiceHourlyRateCents:    16500,    // $165/hr NETA field-service billing rate
    pmVisitMinimumCents:         75000,    // $750 -- 4-hour field minimum + mobilization
    oneLineDiagramCreationCents: 150000,   // $1,500 flat (~10-12 hrs design + field verify)
    equipmentReplacementRanges: {
      CIRCUIT_BREAKER: { min: 250000,  max: 2500000 },  // $2,500 - $25,000 power/MV breaker, installed
      TRANSFORMER:     { min: 800000,  max: 7500000 },  // $8,000 - $75,000 dry-type to pad-mount, installed
      SWITCHGEAR:      { min: 1500000, max: 7500000 },  // $15,000 - $75,000 section / small lineup, installed
      MCC:             { min: 800000,  max: 3000000 },  // $8,000 - $30,000 section, installed
    },
    expiresAfterDays: 180,
    lastConfirmedAt: new Date(),
  } });
}

async function resetAndSeedDemo(opts = {}) {
  await seedStandards(prisma);
  await _resetDemoAccount();
  await _seedRateSheet();
  const summary = await _seedAccount();
  // Partner-org "contractor with a sales team" book -- separate from the
  // standalone Meridian account above, so the demo shows BOTH the manager
  // roll-up / per-rep digest path and the standalone fallback. Best-effort:
  // a failure here must never break the core Meridian seed.
  let contractor = null;
  try {
    const { seedContractorBook } = require('./seedContractorBook');
    contractor = await seedContractorBook(prisma);
  } catch (e) {
    console.error('[resetAndSeedDemo] contractor-book seed failed (non-fatal):', (e && e.message) || e);
  }
  // Cedar Hollow + Northgate matched 2022->2026 drift demo: two extra sites with prior/current
  // arc-flash studies + the four downloadable report PDFs. Best-effort (must never break the core
  // seed) and runs AFTER the account reset above, so these survive the nightly demo reseed. Sites
  // first, then the documents that attach to them.
  try {
    await require('./seed-cedar-northgate-drift-demo').run(prisma);
    await require('./seed-demo-documents').run(prisma);
  } catch (e) {
    console.error('[resetAndSeedDemo] cedar/northgate drift add-on failed (non-fatal):', (e && e.message) || e);
  }

  return { ...summary, contractor, trigger: opts.trigger || 'cli' };
}

// -- CLI entry ----------------------------------------------------------------
if (require.main === module) {
  resetAndSeedDemo({ trigger: 'cli' })
    .then(async (s) => {
      console.log('Demo seed complete:');
      console.log(JSON.stringify(s, null, 2));
      console.log('\nLogin credentials:');
      console.log('  servicecyclehq@gmail.com / Admin1234!   (admin — REAL inbox for live alert-email test)');
      console.log('  manager@demo.local    / Manager1234!');
      console.log('  viewer@demo.local     / Viewer1234!');
      console.log('  consultant@demo.local / Consultant1234!');
      console.log('  tech@demo.local       / Tech1234!');
      await prisma.$disconnect();
      // 2026-07-08: root cause of a recurring CI hang (job "tsc + jest +
      // smoke" going silent for up to the full 15min job timeout, always
      // right after this script's own "Demo seed complete" log line).
      // Confirmed via gh run log inspection with per-step timeouts added as
      // a diagnostic: this script does ALL its work, prints the summary +
      // credentials, disconnects Prisma -- and then the Node process itself
      // never exits. prisma.$disconnect() only closes the DB connection; it
      // does nothing about the open HTTP keep-alive socket(s) the live
      // newsScanner RSS fetch (rss-parser, a few lines above via
      // seedContractorBook -> ... -> runNewsScanner) can leave behind,
      // which keep the event loop alive until something external kills the
      // process. Locally these evidently close fast enough to never matter;
      // in CI's network they apparently don't. The CLI's own failure branch
      // right below already force-exits after disconnecting -- this brings
      // the success branch in line with that existing pattern instead of
      // relying on a natural (and apparently unreliable) event-loop drain.
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Seed failed:', err);
      await prisma.$disconnect();
      process.exit(1);
    });
}

// 2026-07-07 fallback-masks-capture fix: DEMO_ACCOUNT_ID was NOT exported,
// so lib/demoPrune.ts's `const { DEMO_ACCOUNT_ID } = require('../scripts/seed-demo')`
// destructured to `undefined` -- silently disabling BOTH (a) the hard guard
// against ever pruning the legacy shared demo account, and (b) the
// `id: { not: DEMO_ACCOUNT_ID }` exclusion filter in pruneInactiveDemoAccounts()'s
// TTL/cap sweep (Prisma treats `not: undefined` as "no filter", i.e. the legacy
// account was NEVER actually excluded from the hourly demoPrune cron). The
// nightly demoReset cron re-seeds it a few hours later, which masked the
// symptom, but the safety guard itself was dead code. See
// __tests__/lib/demoPruneCrashPath.test.ts.
module.exports = { resetAndSeedDemo, seedAccountForUser, DEMO_ACCOUNT_ID };
