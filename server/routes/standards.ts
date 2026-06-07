/**
 * /api/standards — compliance standards + the maintenance task matrix.
 *
 * Two resource families:
 *
 *   ComplianceStandard — the governing documents (NFPA 70B/70E/110, NETA
 *   MTS/ATS, IEEE C57.104/43, OSHA 1910 Subpart S). GLOBAL rows, no tenancy:
 *   there are no public APIs for NFPA/NETA content, so editions are seeded as
 *   data and refreshed through the manual revision workflow
 *   (StandardRevisionAlert). Read-only over the API by design — edits happen
 *   via the seed/update scripts so every tenant sees one consistent library.
 *
 *   MaintenanceTaskDefinition — the NFPA 70B / NETA Appendix B interval
 *   matrix (what maintenance each equipment type needs, how often per
 *   condition rating). Two ownership tiers:
 *     accountId = NULL  → global seeded matrix, shared by all tenants.
 *                         NEVER editable through the API (403): a standards
 *                         revision patches one place for everyone, and a
 *                         tenant must not be able to quietly stretch the
 *                         shared intervals out of compliance.
 *     accountId = <id>  → tenant-defined custom tasks. Full CRUD for that
 *                         account's admins; soft-retired via /archive so
 *                         existing schedules keep their FK.
 *
 * Mounted behind authenticateToken in index.ts. Task-definition reads filter
 * (accountId IS NULL OR accountId = caller's) — one tenant's custom tasks are
 * invisible to another.
 */

const router = require('express').Router();
const { z } = require('zod');
const { requireAdmin } = require('../middleware/roles');
const { validateBody, UuidStr, emptyToUndef } = require('../lib/validate');
const prisma = require('../lib/prisma').default;

// Canonical EquipmentType list — single source of truth in lib/equipmentTypes.
const { EQUIPMENT_TYPES } = require('../lib/equipmentTypes');
const NETA_CERT_LEVELS = ['LEVEL_I', 'LEVEL_II', 'LEVEL_III', 'LEVEL_IV'];

// Positive-int months, accepting numeric strings from the SPA form.
const MonthsLike = z.preprocess(emptyToUndef,
  z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).optional());
const MonthsLikeNullable = z.preprocess(emptyToUndef,
  z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).nullable().optional());

const TaskDefWritableFields: any = {
  standardId:            UuidStr.nullable().optional().or(z.literal('')),
  description:           z.string().max(2000).nullable().optional(),
  intervalC1Months:      MonthsLikeNullable,
  intervalC3Months:      MonthsLikeNullable,
  requiresOutage:        z.boolean().optional(),
  requiresEnergized:     z.boolean().optional(),
  requiresNetaCertified: z.boolean().optional(),
  netaCertLevelMin:      z.enum(NETA_CERT_LEVELS).nullable().optional().or(z.literal('')),
  standardRef:           z.string().max(500).nullable().optional(),
};

const CreateTaskDefSchema = z.object({
  ...TaskDefWritableFields,
  equipmentType:    z.enum(EQUIPMENT_TYPES),
  taskName:         z.string().min(1).max(500),
  taskCode:         z.string().min(1).max(100),
  intervalC2Months: MonthsLike.refine(v => v !== undefined, { message: 'intervalC2Months is required' }),
}).strict();

const UpdateTaskDefSchema = z.object({
  ...TaskDefWritableFields,
  taskName:         z.string().min(1).max(500).optional(),
  taskCode:         z.string().min(1).max(100).optional(),
  intervalC2Months: MonthsLike,
  // equipmentType intentionally NOT updatable — existing schedules were
  // validated against it at pairing time; changing it would silently break
  // the asset/task type match invariant.
}).strict();

const toInt = (v) => (v == null ? v : parseInt(v, 10));

// ─── GET /api/standards ───────────────────────────────────────────────────────
// The standards library. Global — intentionally no accountId filter (these
// rows have no tenant column); content is the same for everyone.
router.get('/', async (req, res) => {
  try {
    const standards = await prisma.complianceStandard.findMany({
      orderBy: [{ code: 'asc' }, { edition: 'desc' }],
      include: { _count: { select: { taskDefinitions: true } } },
    });

    res.json({ success: true, data: { standards } });
  } catch (err) {
    console.error('List standards error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch standards' });
  }
});

// ─── GET /api/standards/task-definitions ──────────────────────────────────────
// The task matrix visible to this tenant: global seed rows + the account's
// own custom rows. Filters: equipmentType; includeArchived=true to show
// soft-retired rows (default hides them).
router.get('/task-definitions', async (req, res) => {
  try {
    const { equipmentType, includeArchived } = req.query;

    if (equipmentType && !EQUIPMENT_TYPES.includes(String(equipmentType))) {
      return res.status(400).json({ success: false, error: `equipmentType must be one of ${EQUIPMENT_TYPES.join(', ')}` });
    }

    const where: any = {
      OR: [{ accountId: null }, { accountId: req.user.accountId }],
    };
    if (equipmentType) where.equipmentType = equipmentType;
    if (includeArchived !== 'true') where.archivedAt = null;

    const taskDefinitions = await prisma.maintenanceTaskDefinition.findMany({
      where,
      include: { standard: { select: { id: true, code: true, edition: true } } },
      orderBy: [{ equipmentType: 'asc' }, { taskName: 'asc' }],
    });

    res.json({ success: true, data: { taskDefinitions } });
  } catch (err) {
    console.error('List task definitions error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch task definitions' });
  }
});

// ─── POST /api/standards/task-definitions ─────────────────────────────────────
// Admin-only: create an account-scoped custom task (e.g. a plant-specific
// inspection the seeded NFPA 70B matrix doesn't carry). accountId is ALWAYS
// the caller's — there is no way to create a global row over the API; those
// come from the seed script's deterministic taskCode upserts.
router.post('/task-definitions', requireAdmin, async (req, res) => {
  const parsed = validateBody(req, res, CreateTaskDefSchema);
  if (!parsed) return;
  try {
    // Optional standard link — must reference a real (global) standard row.
    let standardId = parsed.standardId || null;
    if (standardId) {
      const standard = await prisma.complianceStandard.findUnique({
        where: { id: standardId },
        select: { id: true },
      });
      if (!standard) return res.status(404).json({ success: false, error: 'Standard not found' });
    }

    const taskDefinition = await prisma.maintenanceTaskDefinition.create({
      data: {
        accountId:             req.user.accountId, // tenant custom row, always
        standardId,
        equipmentType:         parsed.equipmentType,
        taskName:              parsed.taskName.trim(),
        taskCode:              parsed.taskCode.trim(),
        description:           parsed.description || null,
        intervalC1Months:      toInt(parsed.intervalC1Months) ?? null,
        intervalC2Months:      toInt(parsed.intervalC2Months),
        intervalC3Months:      toInt(parsed.intervalC3Months) ?? null,
        requiresOutage:        parsed.requiresOutage === true,
        requiresEnergized:     parsed.requiresEnergized === true,
        requiresNetaCertified: parsed.requiresNetaCertified === true,
        netaCertLevelMin:      parsed.netaCertLevelMin || null,
        standardRef:           parsed.standardRef || null,
      },
      include: { standard: { select: { id: true, code: true, edition: true } } },
    });

    res.status(201).json({ success: true, data: { taskDefinition } });
  } catch (err) {
    // (accountId, equipmentType, taskCode) unique.
    if (err && err.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'A task with this code already exists for that equipment type' });
    }
    console.error('Create task definition error:', err);
    res.status(500).json({ success: false, error: 'Failed to create task definition' });
  }
});

// ── Ownership gate for per-id task-definition writes ─────────────────────────
// Looks the row up within the caller's visible set (global + own). Returns:
//   { def }            — caller may edit (account-owned row)
//   { status, error }  — 404 (not visible) or 403 (global row: visible to
//                        everyone, editable by no one)
// The 403-vs-404 split is deliberate: a global row's existence is public
// knowledge (every tenant lists it), so refusing with 403 is honest and the
// error message can explain WHY. Another tenant's custom row stays a 404.
async function findEditableTaskDef(req) {
  const def = await prisma.maintenanceTaskDefinition.findFirst({
    where: {
      id: req.params.id,
      OR: [{ accountId: null }, { accountId: req.user.accountId }],
    },
  });
  if (!def) return { status: 404, error: 'Task definition not found' };
  if (def.accountId === null) {
    return { status: 403, error: 'Global task definitions cannot be modified — they are updated via the standards revision workflow' };
  }
  return { def };
}

// ─── PUT /api/standards/task-definitions/:id ──────────────────────────────────
// Admin-only edit of an ACCOUNT-OWNED custom task. Global rows 403 (see gate).
router.put('/task-definitions/:id', requireAdmin, async (req, res) => {
  const parsed = validateBody(req, res, UpdateTaskDefSchema);
  if (!parsed) return;
  try {
    const gate: any = await findEditableTaskDef(req);
    if (!gate.def) return res.status(gate.status).json({ success: false, error: gate.error });

    if (parsed.standardId !== undefined && parsed.standardId) {
      const standard = await prisma.complianceStandard.findUnique({
        where: { id: parsed.standardId },
        select: { id: true },
      });
      if (!standard) return res.status(404).json({ success: false, error: 'Standard not found' });
    }

    const updateData: any = {};
    if (parsed.taskName !== undefined)         updateData.taskName = parsed.taskName.trim();
    if (parsed.taskCode !== undefined)         updateData.taskCode = parsed.taskCode.trim();
    if (parsed.standardId !== undefined)       updateData.standardId = parsed.standardId || null;
    if (parsed.description !== undefined)      updateData.description = parsed.description || null;
    if (parsed.intervalC1Months !== undefined) updateData.intervalC1Months = toInt(parsed.intervalC1Months) ?? null;
    if (parsed.intervalC2Months !== undefined) updateData.intervalC2Months = toInt(parsed.intervalC2Months);
    if (parsed.intervalC3Months !== undefined) updateData.intervalC3Months = toInt(parsed.intervalC3Months) ?? null;
    if (parsed.requiresOutage !== undefined)        updateData.requiresOutage = parsed.requiresOutage === true;
    if (parsed.requiresEnergized !== undefined)     updateData.requiresEnergized = parsed.requiresEnergized === true;
    if (parsed.requiresNetaCertified !== undefined) updateData.requiresNetaCertified = parsed.requiresNetaCertified === true;
    if (parsed.netaCertLevelMin !== undefined) updateData.netaCertLevelMin = parsed.netaCertLevelMin || null;
    if (parsed.standardRef !== undefined)      updateData.standardRef = parsed.standardRef || null;

    const taskDefinition = await prisma.maintenanceTaskDefinition.update({
      where: { id: gate.def.id },
      data: updateData,
      include: { standard: { select: { id: true, code: true, edition: true } } },
    });

    // NOTE: interval edits intentionally do NOT cascade into existing
    // schedules' nextDueDate — those recompute at their next completion.
    res.json({ success: true, data: { taskDefinition } });
  } catch (err) {
    if (err && err.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'A task with this code already exists for that equipment type' });
    }
    console.error('Update task definition error:', err);
    res.status(500).json({ success: false, error: 'Failed to update task definition' });
  }
});

// ─── POST /api/standards/task-definitions/:id/archive ─────────────────────────
// Soft-retire an account-owned custom task. Existing schedules keep their FK
// (history stays intact); the row simply stops appearing in pickers and
// bulk-apply. Global rows 403 — retiring a shared matrix row is a seed-script
// operation, not a tenant action.
router.post('/task-definitions/:id/archive', requireAdmin, async (req, res) => {
  try {
    const gate: any = await findEditableTaskDef(req);
    if (!gate.def) return res.status(gate.status).json({ success: false, error: gate.error });

    if (gate.def.archivedAt) {
      return res.status(400).json({ success: false, error: 'Task definition is already archived' });
    }

    const taskDefinition = await prisma.maintenanceTaskDefinition.update({
      where: { id: gate.def.id },
      data: { archivedAt: new Date() },
    });

    res.json({ success: true, data: { taskDefinition } });
  } catch (err) {
    console.error('Archive task definition error:', err);
    res.status(500).json({ success: false, error: 'Failed to archive task definition' });
  }
});

module.exports = router;

export {};
