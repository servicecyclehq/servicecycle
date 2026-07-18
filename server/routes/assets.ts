/**
 * /api/assets — electrical equipment asset CRUD.
 *
 * An Asset is one piece of electrical equipment under maintenance management
 * (liquid/dry transformer, switchgear, generator, MCC, UPS string, ...).
 * Every asset belongs to a Site; the intermediate hierarchy levels
 * (Building → Area → EquipmentPosition) are optional nullable links so a
 * single-room facility can skip levels while a large industrial site uses
 * all five. Chain consistency is validated here on every write — the DB
 * only enforces the FKs, not "area belongs to the same building".
 *
 * NFPA 70B:2023 condition of maintenance: each asset carries a three-axis
 * assessment (physical / criticality / environment), each C1|C2|C3. The
 * stored governingCondition is the WORST of the three (C3 wins) and is
 * recomputed here on every condition write so list queries and the
 * scheduler never re-derive it. It drives interval selection on
 * MaintenanceTaskDefinition (intervalC1/C2/C3Months).
 *
 * Auth: authenticateToken is applied at the mount point in index.ts.
 * Writes are manager+ (requireManager); reads are any authenticated role.
 * TENANCY: every prisma query in this file filters by req.user.accountId.
 */

const router = require('express').Router();
const { z } = require('zod');
const { requireManager } = require('../middleware/roles');
const { validateBody, UuidStr, emptyToUndef } = require('../lib/validate');
// Shared per-type value coercion — the asset write path enforces the exact
// same rules as the Settings → Custom Fields CRUD so the two can't drift.
const { validateValueForDefinition } = require('./customFields');
const { resolveAsset } = require('../lib/assetIdentity'); // #3 fuzzy asset identity resolution
const { assetLabel } = require('../lib/assetLabel');
import prisma from '../lib/prisma';
import { notifyConditionDegradation, notifyAssetDecommissioned } from '../lib/assetAlertNotifier';

// ─── Condition helpers ────────────────────────────────────────────────────────
// Governing condition = worst of the three axes. C3 (poor) dominates C2
// (fair) dominates C1 (good) — the find() walks worst-first and returns the
// first rating any axis holds. Defensive 'C2' fallback matches the schema
// default and can only fire on malformed input that zod already rejects.
const CONDITION_VALUES = ['C1', 'C2', 'C3'];

// Query-param uuid gate for list filters (zod validates bodies; list query
// params are validated inline like the other filters). Same literal lives in
// routes/bootstrap.ts — keep them identical.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Variadic worst-of (C3 > C2 > C1). Takes the three human axes plus the
// computed governing flags (autoConditionC3 -> 'C3', autoConditionMonitoring
// -> 'C2'); extra nullable args are tolerated.
const worstCondition = (...ratings) =>
  ['C3', 'C2', 'C1'].find(v => ratings.includes(v)) || 'C2';

// Canonical EquipmentType list — single source of truth in lib/equipmentTypes
// (mirrors the Prisma enum; this file used to carry its own copy and drifted).
const { EQUIPMENT_TYPES } = require('../lib/equipmentTypes');
// R3: condition-based interval engine — recompute schedule due dates when an
// asset's governing condition changes (close the loop) + power what-if preview.
const { computeNextDueDate, intervalMonthsFor } = require('../lib/maintenanceInterval');
const { buildIrScanMap } = require('../lib/irScanStatus'); // #29 §7.4 Last IR Scan

// Redundancy posture vocabulary (Asset.redundancyStatus is a String column;
// the route layer owns the enum).
const REDUNDANCY_VALUES = ['N', 'N_PLUS_1', 'TWO_N'];

// ─── Activity logging helper ──────────────────────────────────────────────────
// Non-fatal fire-and-forget — a logging failure never blocks the response.
// (Local helper rather than lib/activityLog because asset routes log against
// ActivityLog.assetId; see the action conventions in lib/activityLog.)
async function logActivity(assetId, userId, accountId, action, details = null) {
  try {
    await prisma.activityLog.create({
      data: { assetId, userId, accountId: accountId ?? null, action, details: details ?? undefined },
    });
  } catch (err) {
    console.error('logActivity error:', err.message);
  }
}

// Human-readable labels for the fields_updated action
const TRACKED_FIELDS: any = {
  siteId:               'Site',
  buildingId:           'Building',
  areaId:               'Area',
  positionId:           'Position',
  ownerId:              'Owner',
  equipmentType:        'Equipment Type',
  manufacturer:         'Manufacturer',
  model:                'Model',
  serialNumber:         'Serial Number',
  nameplateData:        'Nameplate Data',
  installDate:          'Install Date',
  lastCommissionedDate: 'Last Commissioned',
  conditionPhysical:    'Physical Condition',
  conditionCriticality: 'Criticality',
  conditionEnvironment: 'Environment Condition',
  inService:            'In Service',
  isEnergized:          'Energized',
  notes:                'Notes',
  fedFromAssetId:       'Fed From',
  // Risk dimensions (2026-06-07): infrastructure criticality, financial
  // exposure, resilience posture.
  criticalityScore:              'Criticality Score',
  conditionScore:                'Condition Score (DPS)',
  repairCostEstimate:            'Repair Cost Estimate',
  spareLeadTimeWeeks:            'Spare Lead Time (weeks)',
  redundancyStatus:              'Redundancy Status',
  requiresPredictiveMaintenance: 'Predictive Maintenance Required',
};

// ─── Zod schemas ──────────────────────────────────────────────────────────────
// Same approach as the heavy write endpoints elsewhere: zod rejects patently
// bad payloads at the door; cross-tenant ownership and hierarchy-consistency
// checks remain inside the handlers. Each optional field is wrapped so the
// SPA's blank form inputs ('') resolve to undefined/null cleanly.
const ConditionEnum = z.enum(['C1', 'C2', 'C3']);
const DateLike  = z.preprocess(emptyToUndef, z.union([z.string(), z.date()]).nullable().optional());
const Str       = z.string().max(2000).nullable().optional();
const ShortStr  = z.string().max(500).nullable().optional();
const BoolLike  = z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional();
const OptUuid   = UuidStr.nullable().optional().or(z.literal(''));

// ── Risk-field shapes ────────────────────────────────────────────────────────
// All five are optional + nullable (unscored assets are legitimate); the SPA
// sends '' from blank inputs, which emptyToUndef collapses to undefined.
// criticalityScore: 1 (low) … 5 (failure = injury/shutdown/fines).
const CriticalityLike = z.preprocess(emptyToUndef,
  z.union([z.number().int().min(1).max(5), z.string().regex(/^[1-5]$/)]).nullable().optional());
// Non-negative money value — number or numeric string ("850000", "850000.00").
const MoneyLike = z.preprocess(emptyToUndef,
  z.union([z.number().nonnegative().finite(), z.string().regex(/^\d{1,12}(\.\d{1,2})?$/)]).nullable().optional());
// Non-negative integer weeks.
const WeeksLike = z.preprocess(emptyToUndef,
  z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,4}$/)]).nullable().optional());
const RedundancyEnum = z.preprocess(emptyToUndef,
  z.enum(REDUNDANCY_VALUES as any).nullable().optional());

// Coercers for the validated risk shapes above (zod admits the string forms;
// the DB columns are Int / Decimal / Boolean).
const toIntOrNull   = (v) => (v === null || v === undefined ? null : parseInt(String(v), 10));
const toMoneyOrNull = (v) => (v === null || v === undefined ? null : String(Number(v)));
const toBool        = (v) => v === true || v === 'true';

const AssetWritableFields: any = {
  siteId:               UuidStr.optional(),
  buildingId:           OptUuid,
  areaId:               OptUuid,
  positionId:           OptUuid,
  // Responsible person for this asset (drives owner-aware alert routing).
  // Must be an ACTIVE user on THIS account — validated in the handlers via
  // resolveOwner. Null/'' clears the owner (asset falls back to role routing).
  ownerId:              OptUuid,
  equipmentType:        z.enum(EQUIPMENT_TYPES as any).optional(),
  manufacturer:         ShortStr,
  model:                ShortStr,
  serialNumber:         ShortStr,
  // Nameplate fields vary wildly by equipment type (kVA + voltages for
  // transformers, kW + RPM for generators, AIC for breakers...) — accepted
  // as a free-shape object into the JSONB column. Per-type validation is a
  // documented follow-up; the column is display-only today.
  nameplateData:        z.record(z.any()).nullable().optional(),
  installDate:          DateLike,
  lastCommissionedDate: DateLike,
  conditionPhysical:    ConditionEnum.optional(),
  conditionCriticality: ConditionEnum.optional(),
  conditionEnvironment: ConditionEnum.optional(),
  inService:            BoolLike,
  isEnergized:          BoolLike,
  notes:                Str,
  // Power-path topology: the asset this one is FED FROM (upstream source).
  // Must be a same-account asset, not the asset itself, and must not create
  // a feed loop — validated in the handlers via resolveFeedSource.
  // Null/'' clears the link.
  fedFromAssetId:       OptUuid,
  // ── Risk dimensions ─────────────────────────────────────────────────────
  // Infrastructure criticality (1-5; deliberately separate from the NFPA 70B
  // conditionCriticality C-axis), financial exposure, resilience posture.
  criticalityScore:              CriticalityLike,
  // DPS conditionScore: 1 (good) … 5 (severe) on the degradation axis.
  // DPS = conditionScore × criticalityScore (stored as priorityScore).
  conditionScore:                CriticalityLike,
  repairCostEstimate:            MoneyLike,
  spareLeadTimeWeeks:            WeeksLike,
  redundancyStatus:              RedundancyEnum,
  requiresPredictiveMaintenance: BoolLike,
  // Admin-defined custom field values, keyed by CustomFieldDefinition id.
  // Zod only gates the container shape — per-type coercion happens against
  // the stored definitions in resolveCustomFields, which zod can't see.
  customFields:         z.record(z.union([z.string(), z.number(), z.boolean()]).nullable()).optional(),
};

// Create requires siteId + equipmentType; everything else optional.
const CreateAssetSchema = z.object({
  ...AssetWritableFields,
  siteId:        UuidStr,
  equipmentType: z.enum(EQUIPMENT_TYPES as any),
}).strict();

// Update is fully partial — handler gates each field by `!== undefined`.
const UpdateAssetSchema = z.object(AssetWritableFields).strict();

// ─── Hierarchy consistency check ──────────────────────────────────────────────
// Validates that every supplied hierarchy link belongs to THIS account and
// chains consistently: building.siteId === siteId, area.siteId === siteId
// (and area.buildingId === buildingId when both are set), position.siteId
// === siteId (and position.areaId === areaId when both are set). The
// intermediate levels are optional — null links always pass. Returns
// { error } on the first inconsistency, { site } on success.
async function resolveHierarchy(accountId, { siteId, buildingId, areaId, positionId }) {
  const site = await prisma.site.findFirst({
    where: { id: siteId, accountId },
  });
  if (!site) return { error: 'Site not found' };

  if (buildingId) {
    const building = await prisma.building.findFirst({
      where: { id: buildingId, siteId, accountId },
    });
    if (!building) return { error: 'Building not found at this site' };
  }
  if (areaId) {
    const area = await prisma.area.findFirst({
      where: { id: areaId, siteId, accountId },
    });
    if (!area) return { error: 'Area not found at this site' };
    // An area created directly under the site (buildingId null) may be
    // paired with any building-less asset; when BOTH sides carry a
    // building they must agree.
    if (buildingId && area.buildingId && area.buildingId !== buildingId) {
      return { error: 'Area does not belong to the specified building' };
    }
  }
  if (positionId) {
    const position = await prisma.equipmentPosition.findFirst({
      where: { id: positionId, siteId, accountId },
    });
    if (!position) return { error: 'Position not found at this site' };
    if (areaId && position.areaId && position.areaId !== areaId) {
      return { error: 'Position does not belong to the specified area' };
    }
  }
  return { site };
}

// ─── Custom field resolution + persistence ────────────────────────────────────
// Validates an incoming { [definitionId]: value } map against THIS account's
// CustomFieldDefinitions BEFORE anything is written: every key must name an
// active (non-archived) definition owned by the account, and every value must
// pass the shared per-type coercion (number → finite numeric string, date →
// YYYY-MM-DD, checkbox → 'true'/'false', select → member of options). Returns
// { error } on the first bad entry, or { entries: [{ definition, value }] }
// where value is the canonical string to store (null = clear the row).
async function resolveCustomFields(accountId, customFields) {
  const raw = Object.entries(customFields || {});
  if (raw.length === 0) return { entries: [] };

  const defs = await prisma.customFieldDefinition.findMany({
    where: { id: { in: raw.map(([id]) => id) }, accountId },
  });
  const byId = new Map(defs.map(d => [d.id, d]));

  const entries = [];
  for (const [definitionId, value] of raw) {
    const definition = byId.get(definitionId);
    // Unknown id and other-tenant id are deliberately the same error —
    // don't confirm a foreign definition exists.
    if (!definition) return { error: 'Unknown custom field' };
    if (definition.archivedAt) {
      return { error: `${definition.name} is archived and no longer accepts values` };
    }
    try {
      entries.push({ definition, value: validateValueForDefinition(definition, value) });
    } catch (e) {
      return { error: e.message };
    }
  }
  return { entries };
}

// Persist resolved entries for one asset. Upsert on the (assetId,
// definitionId) unique; a null canonical value DELETES the row so cleared
// fields don't linger as empty strings in exports. Returns the display names
// of fields whose stored value actually changed (feeds fields_updated).
async function writeCustomFieldValues(assetId, entries, db: any = prisma) {
  if (entries.length === 0) return [];
  const existing = await db.customFieldValue.findMany({
    where: { assetId, definitionId: { in: entries.map(e => e.definition.id) } },
  });
  const prevByDef = new Map(existing.map(v => [v.definitionId, v.value]));

  const changedNames = [];
  for (const { definition, value } of entries) {
    if (value === null) {
      if (prevByDef.has(definition.id)) {
        await db.customFieldValue.delete({
          where: { assetId_definitionId: { assetId, definitionId: definition.id } },
        });
        changedNames.push(definition.name);
      }
    } else {
      await db.customFieldValue.upsert({
        where:  { assetId_definitionId: { assetId, definitionId: definition.id } },
        create: { assetId, definitionId: definition.id, value },
        update: { value },
      });
      if (prevByDef.get(definition.id) !== value) changedNames.push(definition.name);
    }
  }
  return changedNames;
}

// ─── Owner validation ─────────────────────────────────────────────────────────
// Asset owner must be an ACTIVE user on THIS account. Unknown id, other-tenant
// id, and deactivated user are deliberately the same error — don't confirm a
// foreign user exists. Returns null on success, error string otherwise.
async function resolveOwner(accountId, ownerId) {
  const owner = await prisma.user.findFirst({
    where:  { id: ownerId, accountId, isActive: true },
    select: { id: true },
  });
  return owner ? null : 'Owner must be an active user on this account';
}

// ─── Feed-source validation (power-path topology) ─────────────────────────────
// fedFromAssetId must name a same-account asset (unknown id and other-tenant
// id are deliberately the same error), must not be the asset itself, and must
// not create a feed loop. Cycle prevention: walk the NEW parent's fedFrom
// chain (max 25 hops — deeper than any real electrical distribution tree);
// if the walk reaches selfAssetId the link would close a loop. A feed loop
// is always data-entry error — electricity has a source. selfAssetId is null
// on create (a not-yet-existing asset can't appear in any chain, so only the
// existence check applies). Returns null on success, error string otherwise.
const FEED_CHAIN_MAX_HOPS = 25;

async function resolveFeedSource(accountId, selfAssetId, fedFromAssetId) {
  if (selfAssetId && fedFromAssetId === selfAssetId) {
    return 'An asset cannot be fed from itself';
  }

  const parent = await prisma.asset.findFirst({
    where:  { id: fedFromAssetId, accountId },
    select: { id: true, fedFromAssetId: true },
  });
  if (!parent) return 'Fed-from asset not found';

  if (!selfAssetId) return null; // create path — no loop possible yet

  // Walk upstream from the new parent. Visited-set guards against a
  // pre-existing loop in the data (shouldn't exist, but never hang on it).
  const visited = new Set([parent.id]);
  let cursorId = parent.fedFromAssetId;
  for (let hop = 0; cursorId && hop < FEED_CHAIN_MAX_HOPS; hop++) {
    if (cursorId === selfAssetId) return 'Feed loop detected';
    if (visited.has(cursorId)) break; // existing cycle upstream — stop walking
    visited.add(cursorId);
    const node = await prisma.asset.findFirst({
      where:  { id: cursorId, accountId },
      select: { fedFromAssetId: true },
    });
    if (!node) break;
    cursorId = node.fedFromAssetId;
  }
  return null;
}

// Shared include shape for single-row responses (create/update return the
// same hierarchy context the list and detail views need). owner is the
// responsible-person User (detail view widens this with email).
const ASSET_INCLUDE: any = {
  site:     { select: { id: true, name: true, address: true, city: true, state: true, postalCode: true } },
  building: { select: { id: true, name: true } },
  area:     { select: { id: true, name: true } },
  position: { select: { id: true, name: true, code: true } },
  owner:    { select: { id: true, name: true } },
};

// Decorate an asset row with nextDue = the soonest active-schedule due date.
// nextDueDate lives on MaintenanceSchedule (one row per asset×task); the
// asset-level "next maintenance due" is the min across active schedules.
function decorateNextDue(asset) {
  const next = asset.schedules?.[0]?.nextDueDate ?? null;
  const { schedules, ...rest } = asset;
  return { ...rest, nextDue: next };
}

// Slim schedules include used purely to derive nextDue (take-1 asc).
const NEXT_DUE_SCHEDULES: any = {
  where:   { isActive: true, nextDueDate: { not: null } },
  orderBy: { nextDueDate: 'asc' },
  take:    1,
  select:  { nextDueDate: true },
};

// ─── GET /api/assets ──────────────────────────────────────────────────────────
// List assets with pagination, search, and filters.
//   ?page / ?limit            — pagination (default 1 / 25)
//   ?search=                  — manufacturer / model / serial # / site name
//   ?equipmentType=           — EquipmentType enum value
//   ?siteId=                  — narrow to one site
//   ?governingCondition=      — C1 | C2 | C3
//   ?inService=true|false
//   ?ownerId=                 — uuid (that owner) | 'unassigned' (no owner)
//   ?dueWithin=               — 'overdue' | '30' | '60' | '90' — has an active
//                               schedule overdue / due within N days
//   ?minCriticality=          — 1..5 — criticalityScore >= N (unscored excluded)
//   ?requiresPredictiveMaintenance=true — only predictive-class assets
//   ?archived=true            — show ONLY archived assets (default excludes them)
//   ?sort=createdAt|nextDue|criticality|repairCost
//                             — default nextDue (soonest maintenance first);
//                               criticality/repairCost default DESC, nulls last
//   ?sortDir=asc|desc
router.get('/', async (req, res) => {
  try {
    const {
      page = 1, limit = 25,
      search, equipmentType, siteId, governingCondition, inService, archived,
      ownerId, dueWithin, minCriticality, requiresPredictiveMaintenance, minPriorityScore,
      sort = 'nextDue', sortDir,
    } = req.query;

    const skip = (Math.max(parseInt(page as string) || 1, 1) - 1) * Math.min(Math.max(parseInt(limit as string) || 25, 1), 200);
    const take = Math.min(Math.max(parseInt(limit as string) || 25, 1), 200);

    const where: any = { accountId: req.user.accountId };

    // Soft-delete default: hide archived assets unless explicitly requested.
    // archived=true flips to archived-only (the Archived view), mirroring
    // the soft-delete convention used across the app.
    if (archived === 'true') where.NOT = { archivedAt: null };
    else where.archivedAt = null;

    if (equipmentType && EQUIPMENT_TYPES.includes(equipmentType)) where.equipmentType = equipmentType;
    if (siteId) where.siteId = siteId;
    if (governingCondition && CONDITION_VALUES.includes(governingCondition)) {
      where.governingCondition = governingCondition;
    }
    if (inService === 'true')       where.inService = true;
    else if (inService === 'false') where.inService = false;

    // Owner filter: a uuid narrows to that owner's assets; the literal
    // 'unassigned' selects assets with no owner set. Anything else is
    // silently ignored (consistent with the other validated filters).
    // ⚠ Mirrored in routes/bootstrap.ts — keep the two in sync.
    if (ownerId === 'unassigned') {
      where.ownerId = null;
    } else if (ownerId && UUID_RE.test(String(ownerId))) {
      where.ownerId = String(ownerId);
    }

    // Due-window filter on the asset's ACTIVE schedules:
    //   'overdue'        — at least one active schedule past due
    //   '30'|'60'|'90'   — at least one active schedule due inside the
    //                      forward window (overdue excluded — that's its own
    //                      bucket, mirroring the dashboard tiles)
    // ⚠ Mirrored in routes/bootstrap.ts — keep the two in sync.
    if (dueWithin === 'overdue') {
      where.schedules = { some: { isActive: true, nextDueDate: { lt: new Date() } } };
    } else if (['30', '60', '90'].includes(String(dueWithin))) {
      const now = new Date();
      const horizon = new Date(now.getTime() + parseInt(String(dueWithin), 10) * 86_400_000);
      where.schedules = { some: { isActive: true, nextDueDate: { gte: now, lte: horizon } } };
    }

    // Risk filters. minCriticality narrows to scored assets at/above the
    // threshold (SQL gte excludes nulls — unscored assets never match);
    // requiresPredictiveMaintenance=true narrows to the predictive class.
    // Bad values are silently ignored, consistent with the other filters.
    // ⚠ Mirrored in routes/bootstrap.ts — keep the two in sync.
    if (['1', '2', '3', '4', '5'].includes(String(minCriticality))) {
      where.criticalityScore = { gte: parseInt(String(minCriticality), 10) };
    }
    if (requiresPredictiveMaintenance === 'true') {
      where.requiresPredictiveMaintenance = true;
    }
    // High-Priority filter: DPS >= N (e.g. ?minPriorityScore=16 for the
    // "High Priority" badge — nulls excluded, consistent with minCriticality).
    if (minPriorityScore) {
      const minDps = parseInt(String(minPriorityScore), 10);
      if (!isNaN(minDps) && minDps >= 1 && minDps <= 25) {
        where.priorityScore = { gte: minDps };
      }
    }

    // Search across nameplate identity fields AND the parent site name —
    // "where is that Square D transformer" and "everything at Plant 2"
    // both need to work from one box.
    // Broad asset search: equipment identity (manufacturer/model/serial), free
    // text (notes), and the full location hierarchy + equipment-position tag, so
    // an identifier like "SWGR-1A-1" (the position code) or a location name
    // surfaces the asset. ⚠ Mirrored in routes/bootstrap.ts — keep in sync.
    if (search) {
      where.OR = [
        { manufacturer: { contains: search, mode: 'insensitive' } },
        { model:        { contains: search, mode: 'insensitive' } },
        { serialNumber: { contains: search, mode: 'insensitive' } },
        { notes:        { contains: search, mode: 'insensitive' } },
        { site:     { name: { contains: search, mode: 'insensitive' } } },
        { building: { name: { contains: search, mode: 'insensitive' } } },
        { area:     { name: { contains: search, mode: 'insensitive' } } },
        { position: { name: { contains: search, mode: 'insensitive' } } },
        { position: { code: { contains: search, mode: 'insensitive' } } },
        // #29 §7.4: an IR finding's component label ("Panel 3, Phase B lug")
        // makes its asset findable — the hot spot is often the only place that
        // text exists.
        { thermographyFindings: { some: { component: { contains: search, mode: 'insensitive' } } } },
      ];
    }

    const dir = sortDir === 'desc' ? 'desc' : 'asc';

    const include: any = {
      ...ASSET_INCLUDE,
      schedules: NEXT_DUE_SCHEDULES,
      // Open-deficiency badge for the list view (filtered relation count).
      _count: { select: { deficiencies: { where: { resolvedAt: null } } } },
    };

    let assets;
    const total = await prisma.asset.count({ where });

    if (sort === 'nextDue') {
      // nextDue is min(active schedules' nextDueDate) — a relation
      // aggregate Prisma can't ORDER BY directly. Two-step: pull a slim
      // (id, nextDue) projection for the whole filtered set, sort + slice
      // in JS, then hydrate just the page. Capped at 5000 rows — well
      // above any realistic per-tenant asset population for the PoC scope;
      // a raw-SQL LATERAL join is the upgrade path if that ceiling moves.
      const slim = await prisma.asset.findMany({
        where,
        select: { id: true, schedules: NEXT_DUE_SCHEDULES },
        take: 5000,
      });
      const keyed = slim.map(a => ({
        id: a.id,
        due: a.schedules?.[0]?.nextDueDate ? new Date(a.schedules[0].nextDueDate).getTime() : null,
      }));
      keyed.sort((a, b) => {
        // nulls last in both directions — an asset with no schedule yet
        // shouldn't dominate the "what's due next" view.
        if (a.due === null && b.due === null) return 0;
        if (a.due === null) return 1;
        if (b.due === null) return -1;
        return dir === 'desc' ? b.due - a.due : a.due - b.due;
      });
      const pageIds = keyed.slice(skip, skip + take).map(k => k.id);

      const rows = await prisma.asset.findMany({
        where: { id: { in: pageIds }, accountId: req.user.accountId },
        include,
      });
      const byId = new Map(rows.map(r => [r.id, r]));
      assets = pageIds.map(id => byId.get(id)).filter(Boolean);
    } else {
      // DB-side sorts. Risk sorts (criticality / repairCost) default DESC —
      // highest-risk first — with unscored assets last in either direction.
      // ⚠ sortMap mirrored in routes/bootstrap.ts — keep the two in sync.
      const riskDir = sortDir === 'asc' ? 'asc' : 'desc';
      const sortMap: any = {
        createdAt:     { createdAt: dir },
        criticality:   { criticalityScore:   { sort: riskDir, nulls: 'last' } },
        repairCost:    { repairCostEstimate: { sort: riskDir, nulls: 'last' } },
        priorityScore: { priorityScore:      { sort: riskDir, nulls: 'last' } },
      };
      assets = await prisma.asset.findMany({
        where,
        skip,
        take,
        orderBy: sortMap[sort] || { createdAt: dir },
        include,
      });
    }

    // #29 §7.4 "Last IR Scan": two grouped queries for the whole page (see
    // lib/irScanStatus.ts), never one per asset. Non-IR equipment types are
    // absent from the map and get nulls, so the column renders "—" for them.
    const irScan = await buildIrScanMap(prisma, req.user.accountId, assets as any);

    const decorated = assets.map(a => {
      const d = decorateNextDue(a);
      const ir = irScan.get(a.id) || null;
      return {
        ...d,
        openDeficiencyCount: a._count?.deficiencies ?? 0,
        lastIrScanDate: ir ? ir.lastIrScanDate : null,
        irStatus:       ir ? ir.irStatus : null,
        irNextDueDate:  ir ? ir.irNextDueDate : null,
      };
    });

    res.json({
      success: true,
      data: {
        assets: decorated,
        pagination: {
          page:  parseInt(page),
          limit: take,
          total,
          pages: Math.ceil(total / take),
        },
      },
    });
  } catch (err) {
    console.error('List assets error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch assets' });
  }
});

// ─── GET /api/assets/:id ──────────────────────────────────────────────────────
// Full asset detail: hierarchy context, maintenance schedules (with task
// definitions so the UI can render interval + standard reference), recent
// work orders, open deficiencies, recent lab samples, and documents.
router.get('/:id', async (req, res) => {
  try {
    const asset = await prisma.asset.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      include: {
        ...ASSET_INCLUDE,
        // Detail view widens the shared include with the owner's email so the
        // page can render a mailto without a second fetch.
        owner: { select: { id: true, name: true, email: true } },
        // Power-path context: immediate upstream source + how many assets
        // this one directly feeds (the Power Path card's summary line; the
        // full chain comes from GET /:id/power-path).
        fedFrom: { select: { id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true } },
        _count:  { select: { feedsDownstream: true } },
        schedules: {
          orderBy: { nextDueDate: 'asc' },
          // standard {code, edition} rides along so the detail page can
          // group schedules by governing standard (per-standard compliance
          // proof) without a second fetch. Null standard = account-defined
          // custom task.
          include: {
            taskDefinition: {
              include: { standard: { select: { id: true, code: true, edition: true, title: true } } },
            },
          },
        },
        workOrders: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            contractor:   { select: { id: true, name: true, netaAccredited: true } },
            assignedTech: { select: { id: true, name: true, netaCertLevel: true } },
          },
        },
        deficiencies: {
          where:   { resolvedAt: null },
          orderBy: { createdAt: 'desc' },
        },
        labSamples: {
          orderBy: { sampleDate: 'desc' },
          take: 10,
        },
        documents: {
          orderBy: { uploadedAt: 'desc' },
          include: { uploader: { select: { id: true, name: true } } },
        },
        // Admin-defined custom field values, with enough of the definition
        // for the detail page to render each one without a second fetch
        // (archived definitions stay readable — values outlive retirement).
        customFieldValues: {
          orderBy: { definition: { displayOrder: 'asc' } },
          include: {
            definition: {
              select: {
                id: true, name: true, fieldKey: true, type: true, options: true,
                required: true, displayOrder: true, archivedAt: true,
              },
            },
          },
        },
      },
    });

    if (!asset) {
      return res.status(404).json({ success: false, error: 'Asset not found' });
    }

    res.json({ success: true, data: { asset } });
  } catch (err) {
    console.error('Get asset error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch asset' });
  }
});

// ─── GET /api/assets/:id/test-history ─────────────────────────────────────────
// Annual test-report history for the Testing & Trends tab. Returns each test
// EVENT (a work order that has recorded measurements) oldest→newest with its
// measurements, so the client can pivot readings year over year. as-found value
// is the trended reading; as-left is carried for reference.
router.get('/:id/test-history', async (req, res) => {
  try {
    const asset = await prisma.asset.findFirst({
      where:  { id: req.params.id, accountId: req.user.accountId },
      select: { id: true },
    });
    if (!asset) {
      return res.status(404).json({ success: false, error: 'Asset not found' });
    }

    const workOrders = await prisma.workOrder.findMany({
      // Soft-deleted readings are excluded: only events with at least one live
      // measurement, and only the live measurements within them.
      where:   { assetId: asset.id, accountId: req.user.accountId, measurements: { some: { deletedAt: null } } },
      orderBy: [{ completedDate: 'asc' }, { createdAt: 'asc' }],
      include: {
        contractor:   { select: { name: true } },
        assignedTech: { select: { name: true } },
        measurements: { where: { deletedAt: null }, orderBy: [{ measurementType: 'asc' }, { phase: 'asc' }] },
      },
    });

    // #27 year-0 baseline anchor: the (earliest) acceptance/commissioning test
    // if one exists, otherwise the earliest test event. Events are already
    // sorted oldest→newest, so the first matching id wins.
    const baselineEventId =
      (workOrders.find((wo) => wo.isAcceptanceTest)?.id) ||
      (workOrders[0]?.id) || null;

    const events = workOrders.map((wo) => ({
      id:       wo.id,
      date:     wo.completedDate || wo.scheduledDate || wo.createdAt,
      isAcceptanceTest: wo.isAcceptanceTest,
      isBaseline: wo.id === baselineEventId,
      vendor:   wo.contractor?.name || null,
      techName: wo.assignedTech?.name || null,
      measurements: wo.measurements.map((m) => ({
        id:              m.id,
        measurementType: m.measurementType,
        phase:           m.phase,
        value:           m.asFoundValue,
        unit:            m.asFoundUnit,
        asLeftValue:     m.asLeftValue,
        asLeftUnit:      m.asLeftUnit,
        passFail:        m.passFail,
        expectedRange:   m.expectedRange,
        testVoltage:     m.testVoltage,
        loadPercent:     m.loadPercent,
        notes:           m.notes,
      })),
    }));

    res.json({ success: true, data: { events, baselineEventId } });
  } catch (err) {
    console.error('Get asset test-history error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch test history' });
  }
});

// ─── POST /api/assets/identity-check ──────────────────────────────────────────
// #3 warn-before-create: the nameplate-scan / field add-equipment flow calls
// this AFTER OCR and BEFORE creating, so a scan of an existing serial offers a
// one-tap "same device?" confirm instead of silently spawning a duplicate.
// Read-only, manager+ (same tier as create). Returns the ranked candidate list
// with match reason + last-tested context; an empty list means "safe to create
// new". This is a non-breaking addition — POST /api/assets is unchanged.
const IdentityCheckSchema = z.object({
  serialNumber:  emptyToUndef(z.string().max(120)).optional(),
  siteId:        UuidStr.optional(),
  equipmentType: emptyToUndef(z.string().max(60)).optional(),
  positionId:    UuidStr.optional(),
  manufacturer:  emptyToUndef(z.string().max(120)).optional(),
  model:         emptyToUndef(z.string().max(120)).optional(),
});
router.post('/identity-check', requireManager, async (req, res) => {
  const parsed = validateBody(req, res, IdentityCheckSchema);
  if (!parsed) return;
  try {
    const { best, candidates } = await resolveAsset({
      accountId: req.user.accountId,
      serialNumber:  parsed.serialNumber,
      siteId:        parsed.siteId,
      equipmentType: parsed.equipmentType,
      positionId:    parsed.positionId,
      manufacturer:  parsed.manufacturer,
      model:         parsed.model,
    });
    // duplicate = a serial-based hit; site/type-only matches are weaker context
    // and shouldn't, on their own, block creating a genuinely new asset.
    const isDuplicate = !!best && (best.reason === 'serial_exact' || best.reason === 'serial_fuzzy');
    return res.json({ success: true, data: { isDuplicate, best, candidates } });
  } catch (err) {
    console.error('[assets/identity-check] failed:', err);
    return res.status(500).json({ success: false, error: 'Identity check failed' });
  }
});

// ─── POST /api/assets ─────────────────────────────────────────────────────────
router.post('/', requireManager, async (req, res) => {
  const parsed = validateBody(req, res, CreateAssetSchema);
  if (!parsed) return;

  try {
    const {
      siteId, buildingId, areaId, positionId, ownerId,
      equipmentType, manufacturer, model, serialNumber, nameplateData,
      installDate, lastCommissionedDate,
      conditionPhysical, conditionCriticality, conditionEnvironment,
      inService, isEnergized, notes, fedFromAssetId,
      criticalityScore, repairCostEstimate, spareLeadTimeWeeks,
      redundancyStatus, requiresPredictiveMaintenance,
    } = parsed;

    // Hierarchy ownership + chain consistency (tenancy: every level is
    // checked against req.user.accountId inside resolveHierarchy).
    const chain = await resolveHierarchy(req.user.accountId, {
      siteId,
      buildingId: buildingId || null,
      areaId:     areaId || null,
      positionId: positionId || null,
    });
    if (chain.error) {
      return res.status(400).json({ success: false, error: chain.error });
    }

    // Custom field values are validated up-front so a bad value 400s
    // before the asset row exists, never after.
    const cf = await resolveCustomFields(req.user.accountId, parsed.customFields);
    if (cf.error) {
      return res.status(400).json({ success: false, error: cf.error });
    }

    // Owner must be an active same-account user.
    const effOwnerId = ownerId || null;
    if (effOwnerId) {
      const ownerErr = await resolveOwner(req.user.accountId, effOwnerId);
      if (ownerErr) {
        return res.status(400).json({ success: false, error: ownerErr });
      }
    }

    // Feed source must be a same-account asset (no self/loop possible on
    // create — the asset doesn't exist yet).
    const effFedFromId = fedFromAssetId || null;
    if (effFedFromId) {
      const feedErr = await resolveFeedSource(req.user.accountId, null, effFedFromId);
      if (feedErr) {
        return res.status(400).json({ success: false, error: feedErr });
      }
    }

    // Default each unset axis to C2 (base interval) per NFPA 70B — an
    // unassessed asset is treated as "fair" until a qualified person rates it.
    const physical    = conditionPhysical    || 'C2';
    const criticality = conditionCriticality || 'C2';
    const environment = conditionEnvironment || 'C2';

    // [2026-07-08 audit item 9] A malformed date string (e.g. "not-a-date")
    // previously sailed through `new Date(x)` as an Invalid Date, which
    // Prisma then threw on at write time — a 500 that also pollutes the
    // server-error alerting pipeline with a false row for what is really a
    // caller input mistake. Reject it here with a clean 400 instead.
    const installDateParsed = installDate ? new Date(installDate) : null;
    if (installDateParsed && Number.isNaN(installDateParsed.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid installDate' });
    }
    const lastCommissionedDateParsed = lastCommissionedDate ? new Date(lastCommissionedDate) : null;
    if (lastCommissionedDateParsed && Number.isNaN(lastCommissionedDateParsed.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid lastCommissionedDate' });
    }

    const asset = await prisma.$transaction(async (tx) => {
      const created = await tx.asset.create({
        data: {
          accountId: req.user.accountId,
          siteId,
          buildingId: buildingId || null,
          areaId:     areaId || null,
          positionId: positionId || null,
          ownerId:    effOwnerId,
          equipmentType,
          manufacturer:  manufacturer || null,
          model:         model || null,
          serialNumber:  serialNumber || null,
          nameplateData: nameplateData ?? undefined,
          installDate:          installDateParsed,
          lastCommissionedDate: lastCommissionedDateParsed,
          conditionPhysical:    physical,
          conditionCriticality: criticality,
          conditionEnvironment: environment,
          governingCondition:   worstCondition(physical, criticality, environment) as any,
          inService:   inService !== undefined ? (inService === true || inService === 'true') : true,
          isEnergized: isEnergized !== undefined ? (isEnergized === true || isEnergized === 'true') : true,
          notes: notes || null,
          fedFromAssetId: effFedFromId,
          // Risk dimensions — zod already validated shape; coerce string forms.
          criticalityScore:              toIntOrNull(criticalityScore),
          conditionScore:                toIntOrNull(parsed.conditionScore),
          // DPS = conditionScore × criticalityScore (null if either unset).
          priorityScore: (parsed.conditionScore != null && criticalityScore != null)
            ? toIntOrNull(parsed.conditionScore)! * toIntOrNull(criticalityScore)!
            : null,
          repairCostEstimate:            toMoneyOrNull(repairCostEstimate),
          spareLeadTimeWeeks:            toIntOrNull(spareLeadTimeWeeks),
          redundancyStatus:              redundancyStatus ?? null,
          requiresPredictiveMaintenance: requiresPredictiveMaintenance !== undefined
            ? toBool(requiresPredictiveMaintenance) : false,
        },
        include: ASSET_INCLUDE,
      }); // tx.asset.create
      // Values were pre-validated above; on a fresh asset nulls are no-ops.
      await writeCustomFieldValues(created.id, cf.entries, tx);
      return created;
    }); // prisma.$transaction

    await logActivity(asset.id, req.user.id, req.user.accountId, 'asset_created', {
      equipmentType: asset.equipmentType,
      siteName:      chain.site.name,
      manufacturer:  asset.manufacturer,
      model:         asset.model,
    });

    res.status(201).json({ success: true, data: { asset } });
  } catch (err) {
    console.error('Create asset error:', err);
    res.status(500).json({ success: false, error: 'Failed to create asset' });
  }
});

// ─── PUT /api/assets/:id ──────────────────────────────────────────────────────
// Partial update. Recomputes governingCondition whenever any condition axis
// changes (worst-of-three) and logs condition_changed when the GOVERNING
// rating moved — that's the event that re-anchors maintenance intervals.
router.put('/:id', requireManager, async (req, res) => {
  const parsed = validateBody(req, res, UpdateAssetSchema);
  if (!parsed) return;

  try {
    const existing = await prisma.asset.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Asset not found' });
    }

    const {
      siteId, buildingId, areaId, positionId, ownerId,
      equipmentType, manufacturer, model, serialNumber, nameplateData,
      installDate, lastCommissionedDate,
      conditionPhysical, conditionCriticality, conditionEnvironment,
      inService, isEnergized, notes, fedFromAssetId,
      criticalityScore, repairCostEstimate, spareLeadTimeWeeks,
      redundancyStatus, requiresPredictiveMaintenance,
    } = parsed;

    // Resolve the EFFECTIVE hierarchy chain (incoming value when supplied,
    // stored value otherwise) so a sparse update can't leave the asset with
    // an inconsistent chain — e.g. moving siteId without clearing a
    // buildingId that belongs to the old site.
    const hierarchyTouched =
      siteId !== undefined || buildingId !== undefined ||
      areaId !== undefined || positionId !== undefined;

    const effSiteId     = siteId !== undefined ? siteId : existing.siteId;
    const effBuildingId = buildingId !== undefined ? (buildingId || null) : existing.buildingId;
    const effAreaId     = areaId     !== undefined ? (areaId || null)     : existing.areaId;
    const effPositionId = positionId !== undefined ? (positionId || null) : existing.positionId;

    if (hierarchyTouched) {
      const chain = await resolveHierarchy(req.user.accountId, {
        siteId:     effSiteId,
        buildingId: effBuildingId,
        areaId:     effAreaId,
        positionId: effPositionId,
      });
      if (chain.error) {
        return res.status(400).json({ success: false, error: chain.error });
      }
    }

    // Resolve custom-field values BEFORE the row update so a bad value
    // 400s with nothing written.
    const cf = await resolveCustomFields(req.user.accountId, parsed.customFields);
    if (cf.error) {
      return res.status(400).json({ success: false, error: cf.error });
    }

    const updateData: any = {};
    if (siteId !== undefined)     updateData.siteId = effSiteId;
    if (buildingId !== undefined) updateData.buildingId = effBuildingId;
    if (areaId !== undefined)     updateData.areaId = effAreaId;
    if (positionId !== undefined) updateData.positionId = effPositionId;
    // Owner: '' / null clears; a non-null value must be an active
    // same-account user.
    if (ownerId !== undefined) {
      const effOwnerId = ownerId || null;
      if (effOwnerId) {
        const ownerErr = await resolveOwner(req.user.accountId, effOwnerId);
        if (ownerErr) {
          return res.status(400).json({ success: false, error: ownerErr });
        }
      }
      updateData.ownerId = effOwnerId;
    }
    // Feed source: '' / null clears; a non-null value must be a same-account
    // asset, not this asset, and must not close a feed loop (cycle walk
    // inside resolveFeedSource, max 25 hops).
    if (fedFromAssetId !== undefined) {
      const effFedFromId = fedFromAssetId || null;
      if (effFedFromId) {
        const feedErr = await resolveFeedSource(req.user.accountId, req.params.id, effFedFromId);
        if (feedErr) {
          return res.status(400).json({ success: false, error: feedErr });
        }
      }
      updateData.fedFromAssetId = effFedFromId;
    }
    if (equipmentType !== undefined) updateData.equipmentType = equipmentType;
    if (manufacturer !== undefined)  updateData.manufacturer = manufacturer || null;
    if (model !== undefined)         updateData.model = model || null;
    if (serialNumber !== undefined)  updateData.serialNumber = serialNumber || null;
    if (nameplateData !== undefined) updateData.nameplateData = nameplateData ?? undefined;
    // [2026-07-08 audit item 9] Same NaN-check as POST /api/assets — a
    // malformed date string must 400, not fall through to a Prisma write
    // error (500) that pollutes the error-alerting pipeline.
    if (installDate !== undefined) {
      const parsed = installDate ? new Date(installDate) : null;
      if (parsed && Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid installDate' });
      }
      updateData.installDate = parsed;
    }
    if (lastCommissionedDate !== undefined) {
      const parsed = lastCommissionedDate ? new Date(lastCommissionedDate) : null;
      if (parsed && Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid lastCommissionedDate' });
      }
      updateData.lastCommissionedDate = parsed;
    }
    if (inService !== undefined)   updateData.inService = inService === true || inService === 'true';
    if (isEnergized !== undefined) updateData.isEnergized = isEnergized === true || isEnergized === 'true';
    if (notes !== undefined)       updateData.notes = notes || null;
    // ── Risk dimensions (null clears; zod validated the shapes) ─────────────
    if (criticalityScore !== undefined)   updateData.criticalityScore = toIntOrNull(criticalityScore);
    if (parsed.conditionScore !== undefined) updateData.conditionScore = toIntOrNull(parsed.conditionScore);
    if (repairCostEstimate !== undefined) updateData.repairCostEstimate = toMoneyOrNull(repairCostEstimate);
    if (spareLeadTimeWeeks !== undefined) updateData.spareLeadTimeWeeks = toIntOrNull(spareLeadTimeWeeks);
    if (redundancyStatus !== undefined)   updateData.redundancyStatus = redundancyStatus ?? null;
    if (requiresPredictiveMaintenance !== undefined) {
      updateData.requiresPredictiveMaintenance = toBool(requiresPredictiveMaintenance);
    }
    // ── DPS recompute: priorityScore = conditionScore × criticalityScore ─────
    // Recompute whenever either factor changes; resolve effective values from
    // the in-flight updateData first (just set above), then fall back to the
    // existing row so a partial update still produces the correct product.
    if (parsed.conditionScore !== undefined || criticalityScore !== undefined) {
      const effCondition   = 'conditionScore'   in updateData ? updateData.conditionScore   : existing.conditionScore;
      const effCriticality = 'criticalityScore' in updateData ? updateData.criticalityScore : existing.criticalityScore;
      updateData.priorityScore = (effCondition != null && effCriticality != null)
        ? effCondition * effCriticality
        : null;
    }

    // ── Condition axes + governing recompute ─────────────────────────────────
    const conditionTouched =
      conditionPhysical !== undefined ||
      conditionCriticality !== undefined ||
      conditionEnvironment !== undefined;

    let governingFrom = null;
    let governingTo   = null;
    if (conditionTouched) {
      const physical    = conditionPhysical    !== undefined ? conditionPhysical    : existing.conditionPhysical;
      const criticality = conditionCriticality !== undefined ? conditionCriticality : existing.conditionCriticality;
      const environment = conditionEnvironment !== undefined ? conditionEnvironment : existing.conditionEnvironment;

      if (conditionPhysical !== undefined)    updateData.conditionPhysical = physical;
      if (conditionCriticality !== undefined) updateData.conditionCriticality = criticality;
      if (conditionEnvironment !== undefined) updateData.conditionEnvironment = environment;

      // NFPA 70B §9.3.1 / condition-based maintenance: the auto flags are
      // SEPARATE governing inputs, so a qualified person re-assessing the
      // physical/criticality/environment axes here never silently drops a
      // neglect-driven C3 (missed cycles) or a telemetry-driven C2 (unaddressed
      // continuous-monitoring notification). Worst-of folds them back in.
      const newGoverning = worstCondition(
        physical, criticality, environment,
        existing.autoConditionC3 ? 'C3' : null,
        existing.autoConditionMonitoring ? 'C2' : null,
      );
      updateData.governingCondition = newGoverning;
      if (newGoverning !== existing.governingCondition) {
        governingFrom = existing.governingCondition;
        governingTo   = newGoverning;
      }
    }

    // ── Detect what changed (for activity log) ───────────────────────────────
    const changedFields = [];
    for (const [key, label] of Object.entries<any>(TRACKED_FIELDS)) {
      if (key in updateData) {
        // nameplateData is JSONB — String() collapses every object to
        // '[object Object]', so compare the canonical JSON instead.
        const prevVal = key === 'nameplateData' ? JSON.stringify(existing[key] ?? null) : String(existing[key] ?? '');
        const nextVal = key === 'nameplateData' ? JSON.stringify(updateData[key] ?? null) : String(updateData[key] ?? '');
        if (prevVal !== nextVal) changedFields.push(label);
      }
    }

    const { asset, changedCustomFields, schedulesRecomputed } = await prisma.$transaction(async (tx) => {
      const updated = await tx.asset.update({
        where: { id: req.params.id },
        data: updateData,
        include: ASSET_INCLUDE,
      }); // tx.asset.update

      // Custom field upserts/deletes - names of fields whose stored value
      // actually moved join the fields_updated log entry below.
      const changedCf = await writeCustomFieldValues(req.params.id, cf.entries, tx);

      // R3: close the loop - recompute schedule due dates on condition change
      // Previously a condition change updated governingCondition but left every
      // schedule's nextDueDate anchored to the OLD interval until the next
      // completion. Now a C2->C3 change tightens intervals immediately.
      // Schedules with a per-schedule conditionOverride are left alone.
      let schedulesRecomputed = 0;
      if (governingTo) {
        const scheds = await tx.maintenanceSchedule.findMany({
          where: { assetId: req.params.id, accountId: req.user.accountId, isActive: true, conditionOverride: null },
          select: {
            id: true, lastCompletedDate: true, nextDueDate: true,
            taskDefinition: { select: { intervalC1Months: true, intervalC2Months: true, intervalC3Months: true } },
          },
        });
        const nowTs = new Date();
        for (const s of scheds) {
          let nd;
          if (s.lastCompletedDate)      nd = computeNextDueDate(s.lastCompletedDate, s.taskDefinition, governingTo);
          else if (s.nextDueDate)       nd = computeNextDueDate(nowTs, s.taskDefinition, governingTo);
          else                          nd = null;
          if (s.nextDueDate || s.lastCompletedDate) {
            await tx.maintenanceSchedule.update({ where: { id: s.id }, data: { nextDueDate: nd } });
            schedulesRecomputed++;
          }
        }
      }

      return { asset: updated, changedCustomFields: changedCf, schedulesRecomputed };
    }); // prisma.$transaction

    changedFields.push(...changedCustomFields);

    // Log activity (non-fatal, after successful update)
    if (changedFields.length > 0) {
      await logActivity(req.params.id, req.user.id, req.user.accountId, 'fields_updated', {
        fields: changedFields,
      });
    }
    if (governingTo) {
      await logActivity(req.params.id, req.user.id, req.user.accountId, 'condition_changed', {
        from: governingFrom,
        to:   governingTo,
      });
      // Alert notification — fire-and-forget, must not delay response
      notifyConditionDegradation({
        accountId: req.user.accountId,
        assetId: req.params.id,
        assetName: assetLabel(asset, req.params.id),
        oldCondition: governingFrom,
        newCondition: governingTo,
        triggeredBy: req.user.name || req.user.email || 'manual',
      }).catch(() => {});
    }

    // Decommission alert: fire when inService just changed to false
    if (inService !== undefined && updateData.inService === false && existing.inService !== false) {
      notifyAssetDecommissioned({
        accountId: req.user.accountId,
        assetId: req.params.id,
        assetName: assetLabel(asset, req.params.id),
        decommissionedBy: req.user.name || req.user.email,
      }).catch(() => {});
    }

    res.json({ success: true, data: { asset, schedulesRecomputed } });
  } catch (err) {
    console.error('Update asset error:', err);
    res.status(500).json({ success: false, error: 'Failed to update asset' });
  }
});

// ─── GET /api/assets/:id/interval-preview?condition=C1|C2|C3 ──────────────────
// R3 what-if: "if this asset were C3, here's how each schedule's interval +
// next-due would shift." Read-only — powers the one-tap condition proposal on
// AssetDetail. Schedules with a per-schedule conditionOverride don't move
// (their override governs regardless of the asset condition).
router.get('/:id/interval-preview', async (req, res) => {
  try {
    const requested = String(req.query.condition || '').toUpperCase();
    if (!['C1', 'C2', 'C3'].includes(requested)) {
      return res.status(400).json({ success: false, error: 'condition must be C1, C2 or C3' });
    }
    const asset = await prisma.asset.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      select: { id: true, governingCondition: true },
    });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const scheds = await prisma.maintenanceSchedule.findMany({
      where: { assetId: req.params.id, accountId: req.user.accountId, isActive: true },
      select: {
        id: true, conditionOverride: true, lastCompletedDate: true, nextDueDate: true,
        taskDefinition: { select: { taskName: true, intervalC1Months: true, intervalC2Months: true, intervalC3Months: true } },
      },
    });

    const now = new Date();
    let sumCurrent = 0, sumProjected = 0, affected = 0;
    const rows = scheds.map((s) => {
      const td = s.taskDefinition;
      const currentCond   = s.conditionOverride || asset.governingCondition || 'C2';
      const projectedCond = s.conditionOverride || requested; // override wins → unchanged
      const currentIv   = intervalMonthsFor(td, currentCond);
      const projectedIv = intervalMonthsFor(td, projectedCond);
      const projectedNextDue = s.lastCompletedDate
        ? computeNextDueDate(s.lastCompletedDate, td, projectedCond)
        : (s.nextDueDate ? computeNextDueDate(now, td, projectedCond) : null);
      if (!s.conditionOverride) { sumCurrent += currentIv; sumProjected += projectedIv; affected++; }
      return {
        scheduleId: s.id, taskName: td.taskName, hasOverride: !!s.conditionOverride,
        currentCondition: currentCond, currentIntervalMonths: currentIv, currentNextDue: s.nextDueDate,
        projectedCondition: projectedCond, projectedIntervalMonths: projectedIv, projectedNextDue,
      };
    });

    const intervalChangePct = sumCurrent > 0 ? Math.round(((sumProjected - sumCurrent) / sumCurrent) * 100) : 0;
    return res.json({
      success: true,
      data: {
        assetId: asset.id, currentGoverning: asset.governingCondition, requestedCondition: requested,
        affectedCount: affected, intervalChangePct, schedules: rows,
      },
    });
  } catch (err) {
    console.error('Interval preview error:', err);
    return res.status(500).json({ success: false, error: 'Failed to build interval preview' });
  }
});

// ─── GET /api/assets/:id/test-history ─────────────────────────────────────────
// Test measurements grouped into events (one per parent work order) for the
// Testing & Trends tab. Populated by the PDF test-report ingest (R1).
router.get('/:id/test-history', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const asset = await prisma.asset.findFirst({ where: { id: req.params.id, accountId }, select: { id: true } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const rows = await prisma.testMeasurement.findMany({
      where: { accountId, deletedAt: null, workOrder: { assetId: req.params.id } },
      select: {
        id: true, measurementType: true, phase: true, asFoundValue: true, asFoundUnit: true,
        asLeftValue: true, passFail: true, expectedRange: true, testVoltage: true, notes: true,
        workOrder: { select: { id: true, completedDate: true, scheduledDate: true, contractor: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const byWo = new Map<string, any>();
    for (const r of rows as any[]) {
      const wo = r.workOrder;
      if (!byWo.has(wo.id)) {
        byWo.set(wo.id, { id: wo.id, date: wo.completedDate || wo.scheduledDate, vendor: wo.contractor?.name || null, techName: null, measurements: [] });
      }
      byWo.get(wo.id).measurements.push({
        id: r.id, measurementType: r.measurementType, phase: r.phase,
        value: r.asFoundValue != null ? Number(r.asFoundValue) : (r.asLeftValue != null ? Number(r.asLeftValue) : null),
        unit: r.asFoundUnit || null, passFail: r.passFail, expectedRange: r.expectedRange,
        testVoltage: r.testVoltage, notes: r.notes,
      });
    }
    const events = [...byWo.values()].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    return res.json({ success: true, data: { events } });
  } catch (err) {
    console.error('[assets/test-history]', err);
    return res.status(500).json({ success: false, error: 'Failed to load test history' });
  }
});

// ─── Incident / protective-device-operation log (#24, EMP element 9) ──────────
// Quick-log breaker trips, relay operations, and alarms from field mode + the
// asset detail. NFPA 70B §9.3.1 condition criteria reference unaddressed
// notifications, so an open (unresolved) incident is a C2/C3 input and the
// EMP's incident-feedback section reads from this stream.
const INCIDENT_TYPES = ['PROTECTIVE_TRIP', 'RELAY_OPERATION', 'ALARM', 'ARC_FLASH_EVENT', 'OTHER'];
const IncidentCreateSchema = z.object({
  type:       z.enum(INCIDENT_TYPES as any).optional(),
  occurredAt: emptyToUndef(z.string().max(40)).optional(),
  note:       emptyToUndef(z.string().max(2000)).optional(),
});
const IncidentPatchSchema = z.object({
  resolved:   z.boolean().optional(),
  note:       emptyToUndef(z.string().max(2000)).optional(),
});

// GET /:id/incidents — newest first, account-scoped.
router.get('/:id/incidents', async (req, res) => {
  try {
    const asset = await prisma.asset.findFirst({ where: { id: req.params.id, accountId: req.user.accountId }, select: { id: true } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const incidents = await prisma.incidentLog.findMany({
      where:   { assetId: asset.id, accountId: req.user.accountId },
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
    });
    const openCount = incidents.filter((i: any) => !i.resolvedAt).length;
    return res.json({ success: true, data: { incidents, openCount } });
  } catch (err) {
    console.error('[assets/incidents:list]', err);
    return res.status(500).json({ success: false, error: 'Failed to load incidents' });
  }
});

// POST /:id/incidents — log an incident (manager+, same tier as other writes).
router.post('/:id/incidents', requireManager, async (req, res) => {
  const parsed = validateBody(req, res, IncidentCreateSchema);
  if (!parsed) return;
  try {
    const asset = await prisma.asset.findFirst({ where: { id: req.params.id, accountId: req.user.accountId }, select: { id: true } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    let occurredAt = new Date();
    if (parsed.occurredAt) {
      const d = new Date(parsed.occurredAt);
      if (isNaN(d.getTime())) return res.status(400).json({ success: false, error: 'Invalid occurredAt' });
      occurredAt = d;
    }
    const incident = await prisma.incidentLog.create({
      data: {
        accountId: req.user.accountId, assetId: asset.id,
        type: (parsed.type as any) || 'OTHER',
        occurredAt, note: parsed.note || null,
        createdById: req.user.id,
      },
    });
    return res.status(201).json({ success: true, data: { incident } });
  } catch (err) {
    console.error('[assets/incidents:create]', err);
    return res.status(500).json({ success: false, error: 'Failed to log incident' });
  }
});

// PATCH /:id/incidents/:incidentId — resolve/reopen or edit the note.
router.patch('/:id/incidents/:incidentId', requireManager, async (req, res) => {
  const parsed = validateBody(req, res, IncidentPatchSchema);
  if (!parsed) return;
  try {
    const existing = await prisma.incidentLog.findFirst({
      where:  { id: req.params.incidentId, assetId: req.params.id, accountId: req.user.accountId },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Incident not found' });
    const data: any = {};
    if (parsed.resolved !== undefined) {
      data.resolvedAt   = parsed.resolved ? new Date() : null;
      data.resolvedById = parsed.resolved ? req.user.id : null;
    }
    if (parsed.note !== undefined) data.note = parsed.note || null;
    const incident = await prisma.incidentLog.update({ where: { id: existing.id }, data });
    return res.json({ success: true, data: { incident } });
  } catch (err) {
    console.error('[assets/incidents:patch]', err);
    return res.status(500).json({ success: false, error: 'Failed to update incident' });
  }
});

// ─── POST /api/assets/:id/archive ─────────────────────────────────────────────
// Soft-delete: history (work orders, lab samples, deficiencies) stays
// addressable; the list view simply stops showing the asset by default.
router.post('/:id/archive', requireManager, async (req, res) => {
  try {
    const existing = await prisma.asset.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Asset not found' });
    }

    // Atomic claim (same guarded-updateMany pattern as workOrders.ts /approve
    // and deficiencies.ts /resolve, 2026-07-12 race-siblings sweep): the where
    // clause re-checks archivedAt===null at write time, not just at the
    // findFirst read above. A losing concurrent archive gets count 0 -> 409
    // instead of silently re-archiving and re-firing the activity log +
    // decommission notification a second time. NOTE: this also closes a
    // pre-existing non-concurrent gap -- unlike standards.ts (which already
    // 400s on a second sequential archive call), this endpoint previously had
    // no archivedAt precondition at all, so repeated non-racing calls also
    // duplicated the log entry + notification; this guard now rejects those too.
    const claim = await prisma.asset.updateMany({
      where: { id: req.params.id, accountId: req.user.accountId, archivedAt: null },
      data:  { archivedAt: new Date() },
    });
    if (claim.count === 0) {
      return res.status(409).json({ success: false, error: 'Asset was already archived by another request.' });
    }
    const asset = await prisma.asset.findFirst({ where: { id: req.params.id } });

    await logActivity(req.params.id, req.user.id, req.user.accountId, 'asset_archived', null);
    // Decommission alert — fire-and-forget
    notifyAssetDecommissioned({
      accountId: req.user.accountId,
      assetId: req.params.id,
      assetName: [existing.manufacturer, existing.model].filter(Boolean).join(' ').trim() || req.params.id,
      decommissionedBy: req.user.name || req.user.email,
    }).catch(() => {});

    res.json({ success: true, data: { asset } });
  } catch (err) {
    console.error('Archive asset error:', err);
    res.status(500).json({ success: false, error: 'Failed to archive asset' });
  }
});

// ─── POST /api/assets/:id/unarchive ───────────────────────────────────────────
router.post('/:id/unarchive', requireManager, async (req, res) => {
  try {
    const existing = await prisma.asset.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Asset not found' });
    }

    const asset = await prisma.asset.update({
      where: { id: req.params.id },
      data:  { archivedAt: null },
    });

    await logActivity(req.params.id, req.user.id, req.user.accountId, 'asset_unarchived', null);

    res.json({ success: true, data: { asset } });
  } catch (err) {
    console.error('Unarchive asset error:', err);
    res.status(500).json({ success: false, error: 'Failed to unarchive asset' });
  }
});

// ─── GET /api/assets/:id/power-path ───────────────────────────────────────────
// Electrical topology view for one asset:
//   upstream:        ordered chain from the immediate parent to the source
//                    (walks fedFrom links; visited-set + hop cap guard
//                    against any pre-existing loop in the data)
//   downstream:      direct children (assets fed FROM this one), each with
//                    its own direct-downstream count
//   totalDownstream: count of ALL transitive descendants — the outage-impact
//                    number ("de-energize this switchgear → N assets lose
//                    power"). BFS, capped at 500 nodes, cycle-guarded.
// TENANCY: every query filters by req.user.accountId.
const POWER_PATH_NODE_SELECT: any = {
  id: true, equipmentType: true, manufacturer: true, model: true,
  serialNumber: true, inService: true, governingCondition: true,
};
const POWER_PATH_MAX_UPSTREAM   = 50;
const POWER_PATH_MAX_DOWNSTREAM = 500;

router.get('/:id/power-path', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const asset = await prisma.asset.findFirst({
      where:  { id: req.params.id, accountId },
      select: { id: true, fedFromAssetId: true },
    });
    if (!asset) {
      return res.status(404).json({ success: false, error: 'Asset not found' });
    }

    // ── Upstream chain: immediate parent → ... → source ──────────────────────
    const upstream = [];
    const seenUp = new Set([asset.id]);
    let cursorId = asset.fedFromAssetId;
    while (cursorId && upstream.length < POWER_PATH_MAX_UPSTREAM) {
      if (seenUp.has(cursorId)) break; // loop in existing data — stop, never hang
      seenUp.add(cursorId);
      const node: any = await prisma.asset.findFirst({
        where:  { id: cursorId, accountId },
        select: { ...POWER_PATH_NODE_SELECT, fedFromAssetId: true },
      });
      if (!node) break; // dangling link (should be impossible — FK + SetNull)
      const { fedFromAssetId: nextId, ...shape } = node;
      upstream.push(shape);
      cursorId = nextId;
    }

    // ── Direct children, each with its own downstream count ──────────────────
    const children: any[] = await prisma.asset.findMany({
      where:   { fedFromAssetId: asset.id, accountId },
      orderBy: { createdAt: 'asc' },
      select:  {
        ...POWER_PATH_NODE_SELECT,
        _count: { select: { feedsDownstream: true } },
      },
    });
    const downstream = children.map((c) => {
      const { _count, ...shape } = c;
      return { ...shape, downstreamCount: _count?.feedsDownstream ?? 0 };
    });

    // ── Total transitive descendants (BFS, capped, cycle-guarded) ────────────
    const visited = new Set([asset.id]);
    let frontier = children.map((c) => c.id).filter((id) => !visited.has(id));
    frontier.forEach((id) => visited.add(id));
    let totalDownstream = frontier.length;

    while (frontier.length > 0 && totalDownstream < POWER_PATH_MAX_DOWNSTREAM) {
      const next = await prisma.asset.findMany({
        where:  { fedFromAssetId: { in: frontier }, accountId },
        select: { id: true },
      });
      frontier = [];
      for (const row of next) {
        if (visited.has(row.id)) continue; // cycle guard
        frontier.push(row.id);
        totalDownstream++;
        if (totalDownstream >= POWER_PATH_MAX_DOWNSTREAM) break;
      }
    }

    res.json({ success: true, data: { upstream, downstream, totalDownstream } });
  } catch (err) {
    console.error('Asset power-path error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch power path' });
  }
});

// ─── GET /api/assets/:id/activity ─────────────────────────────────────────────
// Paginated activity-log entries for one asset, newest first.
router.get('/:id/activity', async (req, res) => {
  try {
    const asset = await prisma.asset.findFirst({
      where:  { id: req.params.id, accountId: req.user.accountId },
      select: { id: true },
    });
    if (!asset) {
      return res.status(404).json({ success: false, error: 'Asset not found' });
    }

    const { page = 1, limit = 50 } = req.query;
    const take = Math.min(parseInt(limit) || 50, 100);
    const skip = ((parseInt(page) || 1) - 1) * take;

    // Defense-in-depth: scope log queries by accountId too (not only the
    // ownership check above), so these never return another tenant's entries.
    const logWhere = { assetId: asset.id, accountId: req.user.accountId };
    const [logs, total] = await Promise.all([
      prisma.activityLog.findMany({
        where:   logWhere,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.activityLog.count({ where: logWhere }),
    ]);

    res.json({
      success: true,
      data: {
        logs,
        pagination: {
          page:  parseInt(page) || 1,
          limit: take,
          total,
          pages: Math.ceil(total / take),
        },
      },
    });
  } catch (err) {
    console.error('Asset activity log error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch activity log' });
  }
});

// ─── Nameplate scan: save / clear (W3 confidence-reviewed onboarding) ─────────
// The tech scans a nameplate (POST /api/assets/:id/ocr-nameplate returns
// per-field values + confidence), reviews the red/yellow/green fields, then
// commits HERE. We persist the reviewed flat values to Asset.nameplateData
// (back-compat with the brief + seeds) and stash the confidence map + the saved
// photo reference under a reserved `_scan` key. DELETE clears it for the
// "attached to the wrong asset" case (delete here → re-scan on the right one).
// [2026-07-05 review fix, S2] No fileFilter meant ANY file type was accepted
// under the "image" field name -- the sibling nameplate/photo upload path
// (routes/assetPhotoInspect.ts photoUpload) restricts to JPEG/PNG/WebP/HEIC;
// this one didn't, so an arbitrary file could be normalized/stored as a
// "nameplate photo" document. Mirrors the same accepted-type set.
const _NP_ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const _npMulter = require('multer')({
  storage: require('multer').memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req: any, file: any, cb: any) => {
    const mt = (file.mimetype || '').toLowerCase();
    const heicName = /\.heic$|\.heif$/i.test(file.originalname || '');
    if (_NP_ACCEPTED_MIME.has(mt) || heicName) return cb(null, true);
    return cb(new Error('Only JPEG, PNG, WebP, or HEIC images are accepted.'));
  },
});
const { uploadFile: _npUpload, deleteFile: _npDelete } = require('../lib/storage');
const NP_KEYS = ['manufacturer','model','serialNumber','voltage','kva','amperage','phases','frequency','year','enclosureRating'];

// A fileFilter rejection is an Error passed to next(err), which would
// otherwise fall through to the generic 5xx JSON error handler in index.ts
// (correct client-facing shape, but wrong status + noisy 5xx telemetry for
// what is really a 400-level upload-validation failure). Mirrors
// assetPhotoInspect.ts's photoUploadMiddleware wrapper.
function _npUploadMiddleware(req: any, res: any, next: any) {
  _npMulter.single('image')(req, res, (err: any) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image too large — 10MB maximum.' : (err.message || 'Upload failed.');
      return res.status(400).json({ success: false, error: msg });
    }
    return next();
  });
}

async function _deleteNameplatePhoto(accountId: string, documentId: string) {
  try {
    const doc = await prisma.document.findFirst({ where: { id: documentId, accountId }, select: { id: true, filePath: true } });
    if (!doc) return;
    try { await _npDelete(doc.filePath); } catch (_e) { /* storage best-effort */ }
    await prisma.document.delete({ where: { id: doc.id } });
  } catch (e: any) { console.error('[nameplate] prior photo delete failed:', e?.message); }
}

router.post('/:id/nameplate', requireManager, _npUploadMiddleware, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const asset = await prisma.asset.findFirst({
      where: { id: req.params.id, accountId, archivedAt: null },
      select: { id: true, nameplateData: true },
    });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    // [W8-nameplate] `fields`/`confidence` are the REVIEWED VALUES the tech
    // just confirmed on screen -- the entire point of this endpoint. A parse
    // failure here (truncated multipart body, client bug, proxy mangling)
    // used to be silently tolerated by defaulting to `{}`, which persisted
    // an EMPTY nameplateData and still returned `{success:true}` --
    // indistinguishable from "the tech reviewed and there was nothing to
    // save." That is a real capture loss disguised as success, so a
    // genuinely malformed payload now 400s instead. An OMITTED `fields`
    // field (not sent at all) is left tolerant -- {} -- since that is a
    // legitimate "nothing changed" shape some older/lighter clients may send.
    let fields: any = {}, confidence: any = {};
    if (req.body?.fields !== undefined) {
      try { fields = JSON.parse(req.body.fields); }
      catch (_e) { return res.status(400).json({ success: false, error: 'Invalid fields payload -- could not parse JSON.' }); }
    }
    if (req.body?.confidence !== undefined) {
      try { confidence = JSON.parse(req.body.confidence); }
      catch (_e) { return res.status(400).json({ success: false, error: 'Invalid confidence payload -- could not parse JSON.' }); }
    }

    // Ground-truth capture (2026-07-03 nameplate review §2.2 H5, §5 #5): the
    // client sends the ORIGINAL AI read + which fields the tech edited so the
    // correction diff persists as free training/calibration data. Payloads
    // are best-effort — a client that omits them still saves normally. Unlike
    // `fields` above, a parse failure here does NOT block the save (the
    // reviewed values are what matters); it only loses the calibration diff
    // for this one save, so it's logged rather than fully silent.
    let aiRead: any = null, touched: any = {};
    try { aiRead = req.body?.aiRead ? JSON.parse(req.body.aiRead) : null; }
    catch (_e: any) { console.warn('[nameplate] aiRead payload failed to parse -- correction-diff calibration data lost for this save:', _e?.message); aiRead = null; }
    try { touched = req.body?.touched ? JSON.parse(req.body.touched) : {}; }
    catch (_e: any) { console.warn('[nameplate] touched payload failed to parse:', _e?.message); touched = {}; }

    const values: any = {};
    for (const k of NP_KEYS) {
      const v = fields[k];
      if (v !== null && v !== undefined && String(v).trim() !== '') values[k] = v;
    }

    const prevNameplateData: any = (asset.nameplateData && typeof asset.nameplateData === 'object')
      ? (asset.nameplateData as any) : null;
    const prevScan: any = prevNameplateData ? prevNameplateData._scan : null;

    // [Resolved 2026-07-05, Dustin's call: "if the tech clears it there's
    // likely a reason... is there some sort of indicator we can make that
    // says data was here but the tech removed it and needs to manually
    // reenter it."] Previously a blanked field was silently indistinguishable
    // from a field that was never populated -- the JSON blob just rebuilds
    // fresh each save, so the old value evaporates with no record, and (for
    // manufacturer/model/serialNumber specifically) the top-level Asset
    // column is left untouched with no signal it wasn't reconfirmed this
    // scan. Detect: the field was part of THIS submission (present in
    // `fields`, so the tech's form actually included it) but blank, AND the
    // asset had a real prior value for it. Keep the old top-level column
    // value in place (nothing downstream breaks) but stamp who/when it was
    // cleared + what it used to be, so it reads as "needs re-entry," not
    // "verified today." A field that was simply never sent this submission
    // (not in `fields` at all) is NOT touched here -- that's a client that
    // didn't include the field, not a tech decision to clear it.
    //
    // Carried forward across saves (not just detected fresh each time): once
    // flagged, the SAME original priorValue/clearedAt/clearedBy persists on
    // every subsequent save until the tech actually re-enters a real value
    // for that field -- otherwise a second partial save (that doesn't resend
    // the field at all) would silently drop the flag with nothing resolved.
    const priorClearedFields: Record<string, any> = (prevScan && prevScan.clearedFields && typeof prevScan.clearedFields === 'object')
      ? prevScan.clearedFields : {};
    const clearedFields: Record<string, { priorValue: any; clearedAt: string; clearedBy: string }> = {};
    for (const k of Object.keys(priorClearedFields)) {
      if (values[k] !== undefined) continue; // re-entered this save -- flag resolves itself
      clearedFields[k] = priorClearedFields[k];
    }
    for (const k of NP_KEYS) {
      if (!(k in fields)) continue;
      const v = fields[k];
      const isBlank = v === null || v === undefined || String(v).trim() === '';
      if (!isBlank) continue;
      const priorValue = prevNameplateData ? prevNameplateData[k] : null;
      const priorHasValue = priorValue !== null && priorValue !== undefined && String(priorValue).trim() !== '';
      if (priorHasValue) {
        clearedFields[k] = { priorValue, clearedAt: new Date().toISOString(), clearedBy: req.user.id };
      }
    }

    let photoKey: string | null = prevScan?.photoKey || null;
    let photoDocId: string | null = prevScan?.photoDocumentId || null;
    // [W8-nameplate] When a NEW photo was uploaded with this save but its
    // persist fails, the code falls back to whatever photo (if any) was
    // already on the asset — the fields/confidence being saved are from
    // THIS scan, but the attached photo would silently be from an EARLIER
    // one (or absent entirely). That's a real evidence/data mismatch: a
    // future reviewer sees a saved nameplate paired with a photo that
    // doesn't actually correspond to it. Non-fatal to the save (the tech's
    // reviewed values still matter more than the photo), but now flagged in
    // `_scan` so it isn't silently indistinguishable from a normal save.
    let photoUploadFailed = false;
    if (req.file?.buffer?.length) {
      try {
        const { normalizeImage } = require('../lib/imageNormalize');
        const _n = await normalizeImage(req.file.buffer, req.file.mimetype); // EXIF-rotate, HEIC→JPEG, size cap
        const filename = `nameplate-${Date.now()}.jpg`;
        const { storageKey } = await _npUpload(accountId, asset.id, filename, _n.buffer, _n.mimeType);
        const doc = await prisma.document.create({
          data: { accountId, assetId: asset.id, filename, filePath: storageKey, fileType: _n.mimeType, uploadedBy: req.user.id },
          select: { id: true },
        });
        // Re-scan replaces — drop the prior nameplate photo.
        if (prevScan?.photoDocumentId && prevScan.photoDocumentId !== doc.id) {
          await _deleteNameplatePhoto(accountId, prevScan.photoDocumentId);
        }
        photoKey = storageKey; photoDocId = doc.id;
      } catch (e: any) {
        console.error('[nameplate] photo persist failed (non-fatal):', e?.message);
        photoUploadFailed = true;
      }
    }

    // Build the diff: fields where the tech's saved value differs from the
    // AI's original read. This is the *training* signal — per-field precision
    // by confidence tier drives future calibration. Keep only whitelisted keys.
    let correctionDiff: Record<string, { ai: any; saved: any; touched: boolean }> | null = null;
    if (aiRead && aiRead.fields && typeof aiRead.fields === 'object') {
      const diff: Record<string, { ai: any; saved: any; touched: boolean }> = {};
      for (const k of NP_KEYS) {
        const aiVal = aiRead.fields[k];
        const savedVal = values[k];
        // Only record when the AI actually read *something* (so blank fields
        // the tech typed in aren't spurious corrections) — the tech may still
        // add data, but it's not a "correction" of an AI value.
        const aiHasVal = aiVal !== undefined && aiVal !== null && String(aiVal).trim() !== '';
        const savedHasVal = savedVal !== undefined && savedVal !== null;
        if (aiHasVal && (savedHasVal ? String(aiVal) !== String(savedVal) : true)) {
          diff[k] = { ai: aiVal, saved: savedHasVal ? savedVal : null, touched: !!touched[k] };
        }
      }
      if (Object.keys(diff).length > 0) correctionDiff = diff;
    }

    const nameplateData: any = {
      ...values,
      _scan: {
        confidence, photoDocumentId: photoDocId, photoKey,
        scannedAt: new Date().toISOString(), scannedBy: req.user.id,
        // [W8-nameplate] Set only when a new photo was attempted and failed
        // to persist. photoStale=true means the photoDocumentId/photoKey
        // above are carried over from an EARLIER scan, not this one; when
        // there was no prior photo either, photoStale is false/omitted but
        // photoUploadFailed still records that a photo was expected here.
        ...(photoUploadFailed ? { photoUploadFailed: true, photoStale: !!photoDocId } : {}),
        ...(Object.keys(clearedFields).length ? { clearedFields } : {}),
        // aiRead = the model's original read + confidence + model id, kept
        // verbatim for future confidence calibration (isotonic-style,
        // per-field precision by tier). Optional — best-effort payload.
        ...(aiRead ? { aiRead: {
          fields:     aiRead.fields ?? null,
          confidence: aiRead.confidence ?? null,
          model:      aiRead.model ?? null,
          scannedAt:  aiRead.scannedAt ?? null,
        } } : {}),
        ...(correctionDiff ? { correctionDiff } : {}),
      },
    };
    // Lift the identity fields onto the top-level columns too (search/match).
    const top: any = { nameplateData };
    if (values.manufacturer) top.manufacturer = String(values.manufacturer);
    if (values.model)        top.model        = String(values.model);
    if (values.serialNumber) top.serialNumber = String(values.serialNumber);
    await prisma.asset.update({ where: { id: asset.id }, data: top });

    void prisma.activityLog.create({ data: { assetId: asset.id, userId: req.user.id, accountId, action: 'nameplate_saved', details: { fields: Object.keys(values), hasPhoto: !!photoDocId } } }).catch(() => {});
    return res.json({ success: true, data: { nameplateData } });
  } catch (err) {
    console.error('[assets/nameplate POST]', err);
    return res.status(500).json({ success: false, error: 'Failed to save nameplate' });
  }
});

router.delete('/:id/nameplate', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const asset = await prisma.asset.findFirst({
      where: { id: req.params.id, accountId, archivedAt: null },
      select: { id: true, nameplateData: true },
    });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const prevScan: any = (asset.nameplateData && typeof asset.nameplateData === 'object')
      ? (asset.nameplateData as any)._scan : null;
    if (prevScan?.photoDocumentId) await _deleteNameplatePhoto(accountId, prevScan.photoDocumentId);
    await prisma.asset.update({ where: { id: asset.id }, data: { nameplateData: null } });
    void prisma.activityLog.create({ data: { assetId: asset.id, userId: req.user.id, accountId, action: 'nameplate_cleared', details: {} } }).catch(() => {});
    return res.json({ success: true });
  } catch (err) {
    console.error('[assets/nameplate DELETE]', err);
    return res.status(500).json({ success: false, error: 'Failed to clear nameplate' });
  }
});

// ─── GET /api/assets/condition-changes ────────────────────────────────────────
// Returns recent condition_changed activity log entries for the dashboard card.
// Query params:
//   ?days=30    — how many days back to look (1–90, default 30)
//   ?limit=50   — max records (1–200, default 50)
router.get('/condition-changes', async (req: any, res: any) => {
  try {
    const days  = Math.min(Math.max(parseInt(String(req.query.days  || '30'), 10), 1), 90);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10), 1), 200);
    const since = new Date(Date.now() - days * 86_400_000);

    const logs = await prisma.activityLog.findMany({
      where: {
        accountId: req.user.accountId,
        action: 'condition_changed',
        createdAt: { gte: since },
      },
      orderBy: [
        // Sort C3 first (by destination condition rank), then newest first
        { createdAt: 'desc' },
      ],
      take: limit,
      include: {
        asset: {
          select: {
            id: true, name: true, equipmentType: true,
            site: { select: { id: true, name: true } },
          },
        },
        user: { select: { id: true, name: true } },
      },
    });

    // Client-side sort: C3 changes first, then C2, then improvements
    const COND_RANK: Record<string, number> = { C3: 3, C2: 2, C1: 1 };
    const sorted = logs.sort((a: any, b: any) => {
      const toA = COND_RANK[(a.details as any)?.to ?? ''] ?? 0;
      const toB = COND_RANK[(b.details as any)?.to ?? ''] ?? 0;
      if (toB !== toA) return toB - toA;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    res.json({ success: true, data: { conditionChanges: sorted, days } });
  } catch (err: any) {
    console.error('[assets/condition-changes]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch condition changes' });
  }
});


module.exports = router;

export {};
