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
import prisma from '../lib/prisma';

// ─── Condition helpers ────────────────────────────────────────────────────────
// Governing condition = worst of the three axes. C3 (poor) dominates C2
// (fair) dominates C1 (good) — the find() walks worst-first and returns the
// first rating any axis holds. Defensive 'C2' fallback matches the schema
// default and can only fire on malformed input that zod already rejects.
const CONDITION_VALUES = ['C1', 'C2', 'C3'];
const worstCondition = (a, b, c) =>
  ['C3', 'C2', 'C1'].find(v => [a, b, c].includes(v)) || 'C2';

const EQUIPMENT_TYPES = [
  'TRANSFORMER_LIQUID', 'TRANSFORMER_DRY', 'SWITCHGEAR', 'GENERATOR',
  'MOTOR', 'MCC', 'UPS_BATTERY', 'CIRCUIT_BREAKER', 'ARC_FLASH_PANEL',
  'VFD', 'FIRE_PUMP_CONTROLLER',
];

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

const AssetWritableFields: any = {
  siteId:               UuidStr.optional(),
  buildingId:           OptUuid,
  areaId:               OptUuid,
  positionId:           OptUuid,
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
async function writeCustomFieldValues(assetId, entries) {
  if (entries.length === 0) return [];
  const existing = await prisma.customFieldValue.findMany({
    where: { assetId, definitionId: { in: entries.map(e => e.definition.id) } },
  });
  const prevByDef = new Map(existing.map(v => [v.definitionId, v.value]));

  const changedNames = [];
  for (const { definition, value } of entries) {
    if (value === null) {
      if (prevByDef.has(definition.id)) {
        await prisma.customFieldValue.delete({
          where: { assetId_definitionId: { assetId, definitionId: definition.id } },
        });
        changedNames.push(definition.name);
      }
    } else {
      await prisma.customFieldValue.upsert({
        where:  { assetId_definitionId: { assetId, definitionId: definition.id } },
        create: { assetId, definitionId: definition.id, value },
        update: { value },
      });
      if (prevByDef.get(definition.id) !== value) changedNames.push(definition.name);
    }
  }
  return changedNames;
}

// Shared include shape for single-row responses (create/update return the
// same hierarchy context the list and detail views need).
const ASSET_INCLUDE: any = {
  site:     { select: { id: true, name: true } },
  building: { select: { id: true, name: true } },
  area:     { select: { id: true, name: true } },
  position: { select: { id: true, name: true, code: true } },
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
//   ?archived=true            — show ONLY archived assets (default excludes them)
//   ?sort=createdAt|nextDue   — default nextDue (soonest maintenance first)
//   ?sortDir=asc|desc
router.get('/', async (req, res) => {
  try {
    const {
      page = 1, limit = 25,
      search, equipmentType, siteId, governingCondition, inService, archived,
      sort = 'nextDue', sortDir = 'asc',
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

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

    // Search across nameplate identity fields AND the parent site name —
    // "where is that Square D transformer" and "everything at Plant 2"
    // both need to work from one box.
    if (search) {
      where.OR = [
        { manufacturer: { contains: search, mode: 'insensitive' } },
        { model:        { contains: search, mode: 'insensitive' } },
        { serialNumber: { contains: search, mode: 'insensitive' } },
        { site: { name: { contains: search, mode: 'insensitive' } } },
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
      // createdAt sort goes straight through the DB.
      assets = await prisma.asset.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: dir },
        include,
      });
    }

    const decorated = assets.map(a => {
      const d = decorateNextDue(a);
      return { ...d, openDeficiencyCount: a._count?.deficiencies ?? 0 };
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

// ─── POST /api/assets ─────────────────────────────────────────────────────────
router.post('/', requireManager, async (req, res) => {
  const parsed = validateBody(req, res, CreateAssetSchema);
  if (!parsed) return;

  try {
    const {
      siteId, buildingId, areaId, positionId,
      equipmentType, manufacturer, model, serialNumber, nameplateData,
      installDate, lastCommissionedDate,
      conditionPhysical, conditionCriticality, conditionEnvironment,
      inService, isEnergized, notes,
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

    // Default each unset axis to C2 (base interval) per NFPA 70B — an
    // unassessed asset is treated as "fair" until a qualified person rates it.
    const physical    = conditionPhysical    || 'C2';
    const criticality = conditionCriticality || 'C2';
    const environment = conditionEnvironment || 'C2';

    const asset = await prisma.asset.create({
      data: {
        accountId: req.user.accountId,
        siteId,
        buildingId: buildingId || null,
        areaId:     areaId || null,
        positionId: positionId || null,
        equipmentType,
        manufacturer:  manufacturer || null,
        model:         model || null,
        serialNumber:  serialNumber || null,
        nameplateData: nameplateData ?? undefined,
        installDate:          installDate ? new Date(installDate) : null,
        lastCommissionedDate: lastCommissionedDate ? new Date(lastCommissionedDate) : null,
        conditionPhysical:    physical,
        conditionCriticality: criticality,
        conditionEnvironment: environment,
        governingCondition:   worstCondition(physical, criticality, environment) as any,
        inService:   inService !== undefined ? (inService === true || inService === 'true') : true,
        isEnergized: isEnergized !== undefined ? (isEnergized === true || isEnergized === 'true') : true,
        notes: notes || null,
      },
      include: ASSET_INCLUDE,
    });

    // Values were pre-validated above; on a fresh asset nulls are no-ops.
    await writeCustomFieldValues(asset.id, cf.entries);

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
      siteId, buildingId, areaId, positionId,
      equipmentType, manufacturer, model, serialNumber, nameplateData,
      installDate, lastCommissionedDate,
      conditionPhysical, conditionCriticality, conditionEnvironment,
      inService, isEnergized, notes,
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
    if (equipmentType !== undefined) updateData.equipmentType = equipmentType;
    if (manufacturer !== undefined)  updateData.manufacturer = manufacturer || null;
    if (model !== undefined)         updateData.model = model || null;
    if (serialNumber !== undefined)  updateData.serialNumber = serialNumber || null;
    if (nameplateData !== undefined) updateData.nameplateData = nameplateData ?? undefined;
    if (installDate !== undefined)   updateData.installDate = installDate ? new Date(installDate) : null;
    if (lastCommissionedDate !== undefined) {
      updateData.lastCommissionedDate = lastCommissionedDate ? new Date(lastCommissionedDate) : null;
    }
    if (inService !== undefined)   updateData.inService = inService === true || inService === 'true';
    if (isEnergized !== undefined) updateData.isEnergized = isEnergized === true || isEnergized === 'true';
    if (notes !== undefined)       updateData.notes = notes || null;

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

      const newGoverning = worstCondition(physical, criticality, environment);
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

    const asset = await prisma.asset.update({
      where: { id: req.params.id },
      data: updateData,
      include: ASSET_INCLUDE,
    });

    // Custom field upserts/deletes — names of fields whose stored value
    // actually moved join the fields_updated log entry below.
    const changedCustomFields = await writeCustomFieldValues(req.params.id, cf.entries);
    changedFields.push(...changedCustomFields);

    // ── Log activity (non-fatal, after successful update) ────────────────────
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
    }

    res.json({ success: true, data: { asset } });
  } catch (err) {
    console.error('Update asset error:', err);
    res.status(500).json({ success: false, error: 'Failed to update asset' });
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

    const asset = await prisma.asset.update({
      where: { id: req.params.id },
      data:  { archivedAt: new Date() },
    });

    await logActivity(req.params.id, req.user.id, req.user.accountId, 'asset_archived', null);

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

    const [logs, total] = await Promise.all([
      prisma.activityLog.findMany({
        where:   { assetId: req.params.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.activityLog.count({ where: { assetId: req.params.id } }),
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

module.exports = router;

export {};
