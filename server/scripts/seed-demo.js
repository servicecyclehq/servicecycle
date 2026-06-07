'use strict';

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
 *   - 4 users: admin@demo.local (Admin1234!), manager@demo.local
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
 *   - 1 DGA LabSample (IEEE C57.104 gases incl. O2/N2, mildly elevated C2H2 →
 *     YELLOW, ieeeStatus 2, Duval D1)
 *   - 3 SystemStudies at Riverside: arc_flash ~4.2yr ago (5-year clock →
 *     expiry-warning territory, IEEE 1584-2018 + PE provenance),
 *     short_circuit ~3yr ago, one_line_review ~6mo ago
 *   - 1 AuditVisit (insurance loss-control, "Granite Mutual", ~5mo ago,
 *     passed_with_findings) with 2 AuditRecommendations (1 completed,
 *     1 open due ~30d out, assigned to the manager)
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
  await prisma.ingestionSession.deleteMany({ where: filter }).catch(() => {});
  await prisma.document.deleteMany({ where: filter }).catch(() => {});
  await prisma.asset.deleteMany({ where: filter });

  // ── Hierarchy + site-scoped rows ──────────────────────────────────────────
  await prisma.equipmentPosition.deleteMany({ where: filter }).catch(() => {});
  await prisma.area.deleteMany({ where: filter }).catch(() => {});
  await prisma.building.deleteMany({ where: filter }).catch(() => {});
  await prisma.auditRecommendation.deleteMany({ where: filter }).catch(() => {});
  await prisma.auditVisit.deleteMany({ where: filter }).catch(() => {});
  await prisma.systemStudy.deleteMany({ where: filter }).catch(() => {});
  await prisma.blackoutWindow.deleteMany({ where: filter }).catch(() => {});
  await prisma.site.deleteMany({ where: filter });

  // ── Contractors ───────────────────────────────────────────────────────────
  await prisma.contractorTech.deleteMany({ where: { contractor: { accountId: DEMO_ACCOUNT_ID } } }).catch(() => {});
  await prisma.contractor.deleteMany({ where: filter });

  // ── Account-scoped lookups / infra ────────────────────────────────────────
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
    },
  });

  const [adminHash, managerHash, viewerHash, consultantHash] = await Promise.all([
    bcrypt.hash('Admin1234!', 12),
    bcrypt.hash('Manager1234!', 12),
    bcrypt.hash('Viewer1234!', 12),
    bcrypt.hash('Consultant1234!', 12),
  ]);
  const admin = await prisma.user.create({ data: {
    accountId: account.id, name: 'Avery Sandoval', email: 'admin@demo.local',
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

  // Pre-seeded account — skip the onboarding wizard.
  await prisma.accountSetting.create({
    data: { accountId: account.id, key: 'ONBOARDING_COMPLETE', value: 'true' },
  });

  // ── Sites / hierarchy ─────────────────────────────────────────────────────
  // Riverside Plant: the full five-level chain.
  const riverside = await prisma.site.create({ data: {
    accountId: account.id, name: 'Riverside Plant',
    address: '4100 Foundry Road', city: 'Davenport', state: 'IA', postalCode: '52802',
    primaryContactName: 'Marcus Webb', primaryContactEmail: 'manager@demo.local',
    primaryContactPhone: '563-555-0144',
    notes: '24/5 stamping + assembly. Substation A feeds the production floor; mezzanine MCC room is the known dust problem area.',
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
  for (const t of [
    { key: 'rios',    name: 'Carmen Rios',    title: 'Field Technician',        level: 'LEVEL_II',  email: 'c.rios@apextesting-demo.local', therm: 'II' },
    { key: 'okafor',  name: 'David Okafor',   title: 'Senior Test Technician',  level: 'LEVEL_III', email: 'd.okafor@apextesting-demo.local' },
    { key: 'lindgren', name: 'Sofia Lindgren', title: 'Principal Engineer',     level: 'LEVEL_IV',  email: 's.lindgren@apextesting-demo.local' },
  ]) {
    apexTechs[t.key] = await prisma.contractorTech.create({ data: {
      contractorId: apex.id, name: t.name, title: t.title,
      netaCertLevel: t.level, email: t.email,
      qualifiedPersonDesignatedAt: addDays(now, -730),
      trainingExpiresAt:           addDays(now, 365),
      thermographerCertLevel:      t.therm || null,
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
  for (const t of [
    { key: 'tran', name: 'Kim Tran',     title: 'Switchgear Technician', level: 'LEVEL_II',  email: 'k.tran@murphyswgr-demo.local' },
    { key: 'hale', name: 'Gabriel Hale', title: 'Lead Field Engineer',   level: 'LEVEL_III', email: 'g.hale@murphyswgr-demo.local' },
  ]) {
    murphyTechs[t.key] = await prisma.contractorTech.create({ data: {
      contractorId: murphy.id, name: t.name, title: t.title,
      netaCertLevel: t.level, email: t.email,
    } });
  }

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
      criticalityScore: 5, repairCostEstimate: 850000, spareLeadTimeWeeks: 26,
      redundancyStatus: 'N', requiresPredictiveMaintenance: true,
      nameplateData: { kVA: 2500, primaryVoltage: '13.8 kV delta', secondaryVoltage: '480Y/277 V', impedancePercent: 5.75, oilType: 'mineral', gallons: 690 },
      notes: 'Main plant transformer. Gasket weeping noted at NW radiator flange (open deficiency).' },
    { key: 'T-2', siteId: riverside.id, buildingId: mainProduction.id, areaId: substationA.id,
      positionId: rsPos.PAD2.id, equipmentType: 'TRANSFORMER_LIQUID',
      ownerId: manager.id,
      manufacturer: 'Kestrel Power Apparatus', model: 'KPA-1500S', serialNumber: 'KPA-14-90417',
      installDate: new Date('2014-03-28'),
      criticalityScore: 3, // modest — refurbished, partial backup via T-1
      conditionPhysical: 'C1', // refurbished 2024 — physical axis upgraded; governing stays worst-of
      nameplateData: { kVA: 1500, primaryVoltage: '13.8 kV delta', secondaryVoltage: '480Y/277 V', impedancePercent: 5.5, oilType: 'mineral', gallons: 480 },
      notes: 'Re-gasketed and oil-processed during 2024 outage; physical condition assessed C1.' },
    { key: 'SWGR-1A-1', siteId: riverside.id, buildingId: mainProduction.id, areaId: substationA.id,
      positionId: rsPos.CUB1.id, equipmentType: 'SWITCHGEAR',
      ownerId: admin.id,
      manufacturer: 'NorthStar Switchgear Co.', model: 'NS-MV15', serialNumber: 'NS-96-3311-1',
      installDate: new Date('1996-09-04'),
      // Lead section of the SWGR-1A lineup — 1996 vintage, parts scarce.
      criticalityScore: 4, repairCostEstimate: 250000, spareLeadTimeWeeks: 16,
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
      criticalityScore: 3, repairCostEstimate: 90000, // modest exposure
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
      criticalityScore: 5, repairCostEstimate: 120000, spareLeadTimeWeeks: 12,
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
      criticalityScore: 4, repairCostEstimate: 60000, spareLeadTimeWeeks: 8,
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
      criticalityScore: 5, repairCostEstimate: 45000, spareLeadTimeWeeks: 10,
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
      criticalityScore: 4, repairCostEstimate: 28000, spareLeadTimeWeeks: 6,
      nameplateData: { voltage: '125 V DC', batteryType: 'flooded lead-acid', cells: 60, chargerAmps: 25 },
      notes: 'Switchgear control battery for Substation A breaker tripping — IEEE 450 quarterly ohmic program.' },
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
  //   OVERDUE (3):  SWGR-2M IR scan 120d overdue (C3 + >90d ⇒ regulatory-
  //                 breach alert tier), T-1 oil screen 25d, GEN-1 load bank 9d
  //   ≤30d (4):     GEN-1 monthly exercise (~10d, via 20d-ago completion),
  //                 T-2 DGA 22d, SWGR-1A-2 IR 27d, GEN-E1 monthly exercise 6d
  //   60–90d (5):   SWGR-1A-3 IR 64d, GEN-E1 fuel analysis 70d, T-1 TTR 75d,
  //                 T-E1 DGA 82d, SWGR-2M insulation resistance 88d
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
    'SWGR-1A-2:SWGR_IR_THERMO':     { dueIn: 27 },
    'GEN-E1:GEN_MONTHLY_EXERCISE':  { dueIn: 6 },
    'ATS-1:ATS_MONTHLY_TRANSFER':   { completedAgo: 12 }, // monthly transfer test CURRENT, due ≈ +18d
    'ELTG-1:ELTG_MONTHLY_FUNCTIONAL': { completedAgo: 10 }, // monthly functional CURRENT, due ≈ +20d
    // due in 60–90 days
    'SWGR-1A-3:SWGR_IR_THERMO':     { dueIn: 64 },
    'GEN-E1:GEN_FUEL_ANALYSIS':     { dueIn: 70 },
    'T-1:XFMR_TTR':                 { dueIn: 75 },
    'T-E1:XFMR_DGA':                { dueIn: 82 },
    'SWGR-2M:SWGR_INSULATION_RES':  { dueIn: 88 },
    // anchors for the COMPLETE work orders below
    'SWGR-1A-1:SWGR_INSULATION_RES': { completedAgo: 45 }, // pairs with WO #2 (YELLOW)
    'T-2:XFMR_INSULATION_RES':       { completedAgo: 30 }, // pairs with WO #1 (GREEN)
  };

  const defsByType = await _loadGlobalDefsByType(prisma);
  const { byKey: schedules, count: scheduleCount } =
    await _createSchedules(prisma, account.id, assets, defsByType, story);

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
    status: 'IN_PROGRESS',
    scheduledDate: addDays(now, -1), startedAt: addDays(now, -1),
    notes: 'Load bank staged in generator yard; 50%/75% kW steps per NFPA 110 §8.4.2.3 running today.',
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
    scheduledDate: addDays(now, 46), // inside the Thanksgiving outage window
    notes: 'De-energized micro-ohm survey of bus joints; aligned to the Thanksgiving shutdown window.',
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
    // IEEE C57.104-2019 status 2 (caution) + Duval D1 (low-energy discharge)
    // matching the detectable-acetylene story below.
    ieeeStatus: 2, faultCode: 'D1',
    resultRating: 'YELLOW',
    notes: 'C2H2 detectable at 2.8 ppm (was <0.5 ppm in prior sample) — possible low-energy discharge. Lab recommends resample in 90 days; other gases within IEEE C57.104 Condition 1 limits for transformer age.',
  } });

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

  // ── Blackout window — planned production shutdown ────────────────────────
  const outageStart = addDays(now, 45);
  await prisma.blackoutWindow.create({ data: {
    accountId: account.id, siteId: riverside.id,
    startsAt: outageStart, endsAt: addDays(outageStart, 2), // 48 hours
    isOutageWindow: true,
    reason: 'Annual Thanksgiving production shutdown',
  } });

  // ── Activity log — so the Activity page isn't empty on first load ─────────
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

  return {
    accountId: account.id,
    companyName: account.companyName,
    users: { admin: admin.email, manager: manager.email, viewer: viewer.email, consultant: consultant.email },
    counts: {
      users: 4,
      sites: 2, buildings: 1, areas: 2, positions: posSpecs.length + egPosSpecs.length,
      contractors: 2, contractorTechs: 5,
      assets: assetSpecs.length,
      schedules: scheduleCount,
      workOrders: 5, testMeasurements: wo2Measurements.length,
      deficiencies: 4, labSamples: 1, systemStudies: 3,
      auditVisits: 1, auditRecommendations: 2,
      assetsWithOwner: 6, blackoutWindows: 1,
      activityLogs: 3,
    },
    dashboardStory: {
      overdue: 5, regulatoryBreachTier: 1,
      dueWithin30Days: 6, due60To90Days: 5,
      openDeficiencies: 3, immediateOpen: 1,
      arcFlashExpiringWithinMonths: 10,
      // Priority-tab seeds (2026-06 risk dimensions): critical tab led by
      // T-1/GEN-1/ATS-1 (score 5), value tab led by T-1 ($850k, 26wk lead),
      // ATS monthly transfer current vs. ATS IR scan + battery ohmic overdue.
      criticalityScored: 11, predictiveMaintenanceFlagged: 2,
    },
  };
}

// ── Per-visitor sandbox seed ─────────────────────────────────────────────────

/**
 * seedAccountForUser(userId)
 *
 * Populate a freshly-created per-visitor demo Account with a SMALLER version
 * of the canned facility (1 site, 6 assets, full schedule set for the Tier 1
 * assets, 2 work orders, 2 deficiencies). Used by the DEMO_MODE registration
 * handler in routes/auth.ts after it creates the visitor's User + Account;
 * lib/demoPrune.ts reaps these sandboxes after 5 days of inactivity.
 *
 * Idempotency: this is NOT idempotent — it always creates new rows. Calling
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

  // Sandbox conveniences — each block independently guarded so a failure
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
    notes: 'Sandbox facility — flat hierarchy (positions directly under the site).',
  } });
  const padPos = await prisma.equipmentPosition.create({ data: {
    accountId, siteId: site.id, name: 'XFMR Pad 1', code: 'XFMR-PAD-1',
  } });
  const swgrPos = await prisma.equipmentPosition.create({ data: {
    accountId, siteId: site.id, name: 'Main Switchgear Lineup', code: 'SWGR-1',
  } });

  // 6 assets — 5 Tier 1 (get schedules) + 1 dry transformer (matrix gap).
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
      conditionEnvironment: 'C3', // boiler-room heat + dust — governing C3
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
      notes: 'No global task matrix rows for dry transformers yet — schedule coverage gap.' },
  ];
  const assets = {};
  for (const spec of assetSpecs) {
    assets[spec.key] = await _createAsset(prisma, accountId, spec);
  }

  // Schedules: 1 overdue, a couple inside 30 days, rest in the future.
  const story = {
    'SWGR-2:SWGR_IR_THERMO':      { dueIn: -35 },          // overdue (C3, 6-month interval)
    'T-1:XFMR_DGA':               { dueIn: 12 },
    'SWGR-1:SWGR_IR_THERMO':      { dueIn: 25 },
    'GEN-1:GEN_MONTHLY_EXERCISE': { completedAgo: 18 },     // due ≈ +12d
    'T-1:XFMR_INSULATION_RES':    { completedAgo: 25 },     // pairs with the COMPLETE WO
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
async function resetAndSeedDemo(opts = {}) {
  await seedStandards(prisma);
  await _resetDemoAccount();
  const summary = await _seedAccount();
  return { ...summary, trigger: opts.trigger || 'cli' };
}

// ── CLI entry ────────────────────────────────────────────────────────────────
if (require.main === module) {
  resetAndSeedDemo({ trigger: 'cli' })
    .then((s) => {
      console.log('Demo seed complete:');
      console.log(JSON.stringify(s, null, 2));
      console.log('\nLogin credentials:');
      console.log('  admin@demo.local      / Admin1234!');
      console.log('  manager@demo.local    / Manager1234!');
      console.log('  viewer@demo.local     / Viewer1234!');
      console.log('  consultant@demo.local / Consultant1234!');
      return prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error('Seed failed:', err);
      await prisma.$disconnect();
      process.exit(1);
    });
}

module.exports = { resetAndSeedDemo, seedAccountForUser, DEMO_ACCOUNT_ID };
