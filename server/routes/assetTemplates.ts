/**
 * /api/asset-templates — Equipment Template Library.
 *
 * Templates pre-fill the New Asset form and auto-schedule a curated task list.
 * Global rows (accountId = NULL) are seeded by the platform; account-custom
 * rows are created by managers and are only visible within their account.
 *
 * Mounted at /api/asset-templates in server/index.ts (auth-gated).
 * Every write guards accountId = req.user.accountId (IDOR).
 *
 *   GET    /                  — list templates (global + account-custom)
 *   GET    /equipment-types   — list distinct equipment types that have templates
 *   GET    /:id               — single template with task definitions
 *   POST   /                  — create account-custom template (manager+)
 *   PUT    /:id               — update account-custom template (manager+)
 *   DELETE /:id               — delete account-custom template (manager+)
 */

'use strict';

const router = require('express').Router();
const { requireManager } = require('../middleware/roles');
const prisma = require('../lib/prisma').default;
const { writeLog: writeActivityLog } = require('../lib/activityLog');

// ── helpers ───────────────────────────────────────────────────────────────────

const VALID_REDUNDANCY = ['N', 'N_PLUS_1', 'TWO_N'];

function parseTemplate(body: any) {
  const {
    name, description, equipmentType,
    defaultCriticalityScore, defaultRedundancyStatus,
    defaultRequiresPredictiveMaintenance,
    nameplateDefaults, taskDefinitionIds,
  } = body;
  return {
    name:                                name ? String(name).trim() : null,
    description:                         description ? String(description).trim() : null,
    equipmentType:                       equipmentType ? String(equipmentType).trim() : null,
    defaultCriticalityScore:             defaultCriticalityScore != null ? parseInt(String(defaultCriticalityScore), 10) : null,
    defaultRedundancyStatus:             defaultRedundancyStatus || null,
    defaultRequiresPredictiveMaintenance: Boolean(defaultRequiresPredictiveMaintenance),
    nameplateDefaults:                   nameplateDefaults ?? null,
    taskDefinitionIds:                   Array.isArray(taskDefinitionIds) ? taskDefinitionIds.map(String) : [],
  };
}

// Shape a template row for API responses
function formatTemplate(t: any) {
  return {
    id:                                  t.id,
    accountId:                           t.accountId,
    isGlobal:                            t.accountId === null,
    name:                                t.name,
    description:                         t.description,
    equipmentType:                       t.equipmentType,
    defaultCriticalityScore:             t.defaultCriticalityScore,
    defaultRedundancyStatus:             t.defaultRedundancyStatus,
    defaultRequiresPredictiveMaintenance: t.defaultRequiresPredictiveMaintenance,
    nameplateDefaults:                   t.nameplateDefaults,
    taskDefinitions:                     (t.taskDefinitions ?? []).map((td: any) => ({
      id:          td.taskDefinition.id,
      taskName:    td.taskDefinition.taskName,
      taskCode:    td.taskDefinition.taskCode,
      standardRef: td.taskDefinition.standardRef,
      intervalC2Months: td.taskDefinition.intervalC2Months,
      requiresOutage:   td.taskDefinition.requiresOutage,
    })),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

const TEMPLATE_INCLUDE = {
  taskDefinitions: {
    include: {
      taskDefinition: {
        select: {
          id: true, taskName: true, taskCode: true, standardRef: true,
          intervalC2Months: true, requiresOutage: true,
        },
      },
    },
  },
};

// ── GET / ─────────────────────────────────────────────────────────────────────
// Returns global templates + account-custom templates for this account.
// Optional ?equipmentType= filter.

router.get('/', async (req, res) => {
  try {
    const { equipmentType } = req.query;
    const typeFilter = equipmentType ? { equipmentType: String(equipmentType) as any } : {};

    const templates = await prisma.assetTemplate.findMany({
      where: {
        OR: [
          { accountId: null },
          { accountId: req.user.accountId },
        ],
        ...typeFilter,
      },
      include: TEMPLATE_INCLUDE,
      orderBy: [{ accountId: 'asc' }, { equipmentType: 'asc' }, { name: 'asc' }],
    });

    return res.json({ success: true, data: { templates: templates.map(formatTemplate) } });
  } catch (err) {
    console.error('[assetTemplates GET /]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── GET /equipment-types ──────────────────────────────────────────────────────
// Distinct equipment types that have at least one template (for filter UI).

router.get('/equipment-types', async (req, res) => {
  try {
    const rows = await prisma.assetTemplate.findMany({
      where: {
        OR: [{ accountId: null }, { accountId: req.user.accountId }],
      },
      select: { equipmentType: true },
      distinct: ['equipmentType'],
      orderBy: { equipmentType: 'asc' },
    });
    return res.json({ success: true, data: { equipmentTypes: rows.map((r: any) => r.equipmentType) } });
  } catch (err) {
    console.error('[assetTemplates GET /equipment-types]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const t = await prisma.assetTemplate.findFirst({
      where: {
        id: req.params.id,
        OR: [{ accountId: null }, { accountId: req.user.accountId }],
      },
      include: TEMPLATE_INCLUDE,
    });
    if (!t) return res.status(404).json({ success: false, error: 'Template not found' });
    return res.json({ success: true, data: { template: formatTemplate(t) } });
  } catch (err) {
    console.error('[assetTemplates GET /:id]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── POST / ────────────────────────────────────────────────────────────────────

router.post('/', requireManager, async (req, res) => {
  try {
    const parsed = parseTemplate(req.body);
    if (!parsed.name)          return res.status(400).json({ success: false, error: 'name required' });
    if (!parsed.equipmentType) return res.status(400).json({ success: false, error: 'equipmentType required' });
    if (parsed.defaultCriticalityScore != null &&
        (parsed.defaultCriticalityScore < 1 || parsed.defaultCriticalityScore > 5)) {
      return res.status(400).json({ success: false, error: 'defaultCriticalityScore must be 1–5' });
    }
    if (parsed.defaultRedundancyStatus && !VALID_REDUNDANCY.includes(parsed.defaultRedundancyStatus)) {
      return res.status(400).json({ success: false, error: `defaultRedundancyStatus must be one of ${VALID_REDUNDANCY.join(', ')}` });
    }

    // Verify task definition IDs belong to global or this account
    if (parsed.taskDefinitionIds.length > 0) {
      const tasks = await prisma.maintenanceTaskDefinition.findMany({
        where: {
          id: { in: parsed.taskDefinitionIds },
          OR: [{ accountId: null }, { accountId: req.user.accountId }],
        },
        select: { id: true },
      });
      if (tasks.length !== parsed.taskDefinitionIds.length) {
        return res.status(400).json({ success: false, error: 'One or more task definition IDs are invalid' });
      }
    }

    const t = await prisma.assetTemplate.create({
      data: {
        accountId:                           req.user.accountId,
        name:                                parsed.name,
        description:                         parsed.description,
        equipmentType:                       parsed.equipmentType as any,
        defaultCriticalityScore:             parsed.defaultCriticalityScore,
        defaultRedundancyStatus:             parsed.defaultRedundancyStatus,
        defaultRequiresPredictiveMaintenance: parsed.defaultRequiresPredictiveMaintenance,
        nameplateDefaults:                   parsed.nameplateDefaults ?? undefined,
        taskDefinitions: parsed.taskDefinitionIds.length > 0 ? {
          create: parsed.taskDefinitionIds.map((tid: string) => ({ taskDefinitionId: tid })),
        } : undefined,
      },
      include: TEMPLATE_INCLUDE,
    });

    writeActivityLog({
      accountId: req.user.accountId, userId: req.user.id, action: 'asset_template_created',
      details: { templateId: t.id, name: t.name, equipmentType: t.equipmentType, taskDefinitionCount: parsed.taskDefinitionIds.length },
    });

    return res.status(201).json({ success: true, data: { template: formatTemplate(t) } });
  } catch (err) {
    console.error('[assetTemplates POST /]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── PUT /:id ──────────────────────────────────────────────────────────────────

router.put('/:id', requireManager, async (req, res) => {
  try {
    // Verify it's an account-custom template owned by this account (can't edit global)
    const existing = await prisma.assetTemplate.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Template not found or is a global template (read-only)' });

    const parsed = parseTemplate(req.body);
    if (parsed.defaultCriticalityScore != null &&
        (parsed.defaultCriticalityScore < 1 || parsed.defaultCriticalityScore > 5)) {
      return res.status(400).json({ success: false, error: 'defaultCriticalityScore must be 1–5' });
    }
    if (parsed.defaultRedundancyStatus && !VALID_REDUNDANCY.includes(parsed.defaultRedundancyStatus)) {
      return res.status(400).json({ success: false, error: `defaultRedundancyStatus must be one of ${VALID_REDUNDANCY.join(', ')}` });
    }

    if (parsed.taskDefinitionIds.length > 0) {
      const tasks = await prisma.maintenanceTaskDefinition.findMany({
        where: {
          id: { in: parsed.taskDefinitionIds },
          OR: [{ accountId: null }, { accountId: req.user.accountId }],
        },
        select: { id: true },
      });
      if (tasks.length !== parsed.taskDefinitionIds.length) {
        return res.status(400).json({ success: false, error: 'One or more task definition IDs are invalid' });
      }
    }

    const updateData: any = {};
    if (parsed.name)          updateData.name          = parsed.name;
    if (parsed.description !== null) updateData.description = parsed.description;
    if (parsed.equipmentType) updateData.equipmentType = parsed.equipmentType;
    if (parsed.defaultCriticalityScore !== null) updateData.defaultCriticalityScore = parsed.defaultCriticalityScore;
    updateData.defaultRedundancyStatus             = parsed.defaultRedundancyStatus;
    updateData.defaultRequiresPredictiveMaintenance = parsed.defaultRequiresPredictiveMaintenance;
    if (parsed.nameplateDefaults !== null) updateData.nameplateDefaults = parsed.nameplateDefaults;

    // Replace task associations entirely
    await prisma.$transaction([
      prisma.assetTemplateTask.deleteMany({ where: { templateId: req.params.id } }),
      prisma.assetTemplate.update({
        where: { id: req.params.id },
        data:  {
          ...updateData,
          taskDefinitions: parsed.taskDefinitionIds.length > 0 ? {
            create: parsed.taskDefinitionIds.map((tid: string) => ({ taskDefinitionId: tid })),
          } : undefined,
        },
      }),
    ]);

    const updated = await prisma.assetTemplate.findFirst({
      where: { id: req.params.id },
      include: TEMPLATE_INCLUDE,
    });
    writeActivityLog({
      accountId: req.user.accountId, userId: req.user.id, action: 'asset_template_updated',
      details: { templateId: req.params.id, name: updated?.name ?? null, equipmentType: updated?.equipmentType ?? null },
    });

    return res.json({ success: true, data: { template: formatTemplate(updated) } });
  } catch (err) {
    console.error('[assetTemplates PUT /:id]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────

router.delete('/:id', requireManager, async (req, res) => {
  try {
    const existing = await prisma.assetTemplate.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Template not found or is a global template (read-only)' });

    await prisma.assetTemplate.delete({ where: { id: req.params.id } });

    writeActivityLog({
      accountId: req.user.accountId, userId: req.user.id, action: 'asset_template_deleted',
      details: { templateId: req.params.id },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('[assetTemplates DELETE /:id]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

export {};
