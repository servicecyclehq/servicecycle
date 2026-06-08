/**
 * /api/assets/:assetId/loto — Lockout / Tagout Procedures
 *
 * OSHA 29 CFR 1910.147 requires a written, equipment-specific LOTO procedure
 * for every piece of equipment whose complexity warrants it. This router stores
 * procedures as structured data (energy sources + ordered steps) rather than
 * PDF uploads — the PDF backup lives in Document with docType=loto_pdf.
 *
 * Lifecycle: draft → active → archived
 *   Activating a procedure auto-archives any currently-active one for this asset.
 *   Each PUT (full update) increments the version counter and re-sets status
 *   to draft (re-approval required).
 *
 * Routes:
 *   GET  /api/assets/:assetId/loto              — list all procedures for asset
 *   GET  /api/assets/:assetId/loto/:id          — full procedure with sources + steps
 *   POST /api/assets/:assetId/loto              — create new procedure (draft)
 *   PUT  /api/assets/:assetId/loto/:id          — full update (increments version → draft)
 *   PATCH /api/assets/:assetId/loto/:id/status  — transition status (manager+)
 *   DELETE /api/assets/:assetId/loto/:id        — hard delete (manager+, draft only)
 *
 * Every query filters accountId = req.user.accountId (IDOR).
 * Mounted at /api/assets/:assetId/loto in index.ts (mergeParams: true).
 */

const router = require('express').Router({ mergeParams: true });
const { requireManager } = require('../middleware/roles');
const prisma = require('../lib/prisma').default;

const VALID_STATUSES  = ['draft', 'active', 'archived'];
const VALID_ENERGY    = ['electrical','pneumatic','hydraulic','mechanical','thermal','chemical','gravity'];
const VALID_CATS      = ['shutdown','isolation','lockout','verify','restore','release'];

// ── helpers ──────────────────────────────────────────────────────────────────

function assetLabel(a: { manufacturer?: string|null, model?: string|null, serialNumber?: string|null, equipmentType?: string|null }): string {
  const base = [a.manufacturer, a.model].filter(Boolean).join(' ');
  const serial = a.serialNumber ? ` #${a.serialNumber}` : '';
  return base ? base + serial : (a.equipmentType ?? 'Asset');
}

/** Build sorted energy sources + steps from request body. Validates types. */
function parseSourcesAndSteps(body: any): { sources: any[], steps: any[], error?: string } {
  const { energySources = [], steps = [] } = body;

  for (const s of energySources) {
    if (!VALID_ENERGY.includes(s.energyType)) {
      return { sources: [], steps: [], error: `invalid energyType: ${s.energyType}` };
    }
    if (!s.description || !s.isolationPoint || !s.isolationMethod || !s.verificationMethod) {
      return { sources: [], steps: [], error: 'each energySource needs description, isolationPoint, isolationMethod, verificationMethod' };
    }
  }

  for (const step of steps) {
    if (!step.instruction) return { sources: [], steps: [], error: 'each step needs instruction' };
    if (step.category && !VALID_CATS.includes(step.category)) {
      return { sources: [], steps: [], error: `invalid step category: ${step.category}` };
    }
  }

  return { sources: energySources, steps };
}

// ── GET /api/assets/:assetId/loto ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { assetId } = req.params;
    const accountId   = req.user.accountId;

    const asset = await prisma.asset.findFirst({ where: { id: assetId, accountId }, select: { id: true } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const procs = await prisma.lotoProc.findMany({
      where:   { assetId, accountId },
      include: {
        createdBy:    { select: { id: true, name: true } },
        approvedBy:   { select: { id: true, name: true } },
        _count:       { select: { energySources: true, steps: true } },
      },
      orderBy: [{ status: 'asc' }, { version: 'desc' }],
    });

    return res.json({ success: true, data: procs });
  } catch (err) {
    console.error('[loto GET /]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── GET /api/assets/:assetId/loto/:id ─────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { assetId } = req.params;
    const accountId   = req.user.accountId;

    const proc = await prisma.lotoProc.findFirst({
      where:   { id: req.params.id, assetId, accountId },
      include: {
        asset:         { select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true, site: { select: { name: true } } } },
        createdBy:     { select: { id: true, name: true } },
        approvedBy:    { select: { id: true, name: true } },
        energySources: { orderBy: { sortOrder: 'asc' } },
        steps:         { orderBy: { sortOrder: 'asc' } },
      },
    });

    if (!proc) return res.status(404).json({ success: false, error: 'Procedure not found' });

    return res.json({
      success: true,
      data: {
        ...proc,
        asset: { ...proc.asset, name: assetLabel(proc.asset) },
      },
    });
  } catch (err) {
    console.error('[loto GET /:id]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── POST /api/assets/:assetId/loto ────────────────────────────────────────────
// Creates a new draft procedure. Does NOT auto-activate.
// Manager+ only — LOTO procedures are OSHA-compliance documents; viewers and
// consultants are read-only (matches the canWrite gate on AssetLotoCard and
// the requireManager gate on PATCH/DELETE below).
router.post('/', requireManager, async (req, res) => {
  try {
    const { assetId } = req.params;
    const accountId   = req.user.accountId;
    const { title, notes, energySources = [], steps = [] } = req.body;

    if (!title?.trim()) return res.status(400).json({ success: false, error: 'title required' });

    const asset = await prisma.asset.findFirst({ where: { id: assetId, accountId }, select: { id: true } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const { sources, steps: parsedSteps, error } = parseSourcesAndSteps(req.body);
    if (error) return res.status(400).json({ success: false, error });

    const proc = await prisma.lotoProc.create({
      data: {
        accountId,
        assetId,
        title:       title.trim(),
        notes:       notes || null,
        status:      'draft',
        version:     1,
        createdById: req.user.id,
        energySources: {
          create: sources.map((s: any, i: number) => ({
            accountId,
            energyType:         s.energyType,
            description:        s.description,
            isolationPoint:     s.isolationPoint,
            isolationMethod:    s.isolationMethod,
            verificationMethod: s.verificationMethod,
            sortOrder:          s.sortOrder ?? i,
          })),
        },
        steps: {
          create: parsedSteps.map((s: any, i: number) => ({
            accountId,
            sortOrder:            s.sortOrder ?? i,
            instruction:          s.instruction,
            category:             s.category || 'lockout',
            requiresVerification: Boolean(s.requiresVerification),
          })),
        },
      },
      include: {
        energySources: { orderBy: { sortOrder: 'asc' } },
        steps:         { orderBy: { sortOrder: 'asc' } },
        createdBy:     { select: { id: true, name: true } },
      },
    });

    return res.status(201).json({ success: true, data: proc });
  } catch (err) {
    console.error('[loto POST /]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── PUT /api/assets/:assetId/loto/:id ─────────────────────────────────────────
// Full replace of title, notes, energySources, and steps.
// Increments version and resets status to draft (re-approval required).
// Manager+ only (see POST above).
router.put('/:id', requireManager, async (req, res) => {
  try {
    const { assetId } = req.params;
    const accountId   = req.user.accountId;
    const { title, notes, energySources = [], steps = [] } = req.body;

    if (!title?.trim()) return res.status(400).json({ success: false, error: 'title required' });

    const existing = await prisma.lotoProc.findFirst({
      where:  { id: req.params.id, assetId, accountId },
      select: { id: true, version: true },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Procedure not found' });

    const { sources, steps: parsedSteps, error } = parseSourcesAndSteps(req.body);
    if (error) return res.status(400).json({ success: false, error });

    // Replace children in a transaction
    const proc = await prisma.$transaction(async (tx: any) => {
      await tx.lotoEnergySource.deleteMany({ where: { lotoId: req.params.id } });
      await tx.lotoStep.deleteMany({ where: { lotoId: req.params.id } });

      return tx.lotoProc.update({
        where: { id: req.params.id },
        data: {
          title:        title.trim(),
          notes:        notes || null,
          status:       'draft',                      // re-approval required
          version:      existing.version + 1,
          approvedById: null,
          approvedAt:   null,
          energySources: {
            create: sources.map((s: any, i: number) => ({
              accountId,
              energyType:         s.energyType,
              description:        s.description,
              isolationPoint:     s.isolationPoint,
              isolationMethod:    s.isolationMethod,
              verificationMethod: s.verificationMethod,
              sortOrder:          s.sortOrder ?? i,
            })),
          },
          steps: {
            create: parsedSteps.map((s: any, i: number) => ({
              accountId,
              sortOrder:            s.sortOrder ?? i,
              instruction:          s.instruction,
              category:             s.category || 'lockout',
              requiresVerification: Boolean(s.requiresVerification),
            })),
          },
        },
        include: {
          energySources: { orderBy: { sortOrder: 'asc' } },
          steps:         { orderBy: { sortOrder: 'asc' } },
          createdBy:     { select: { id: true, name: true } },
        },
      });
    });

    return res.json({ success: true, data: proc });
  } catch (err) {
    console.error('[loto PUT /:id]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── PATCH /api/assets/:assetId/loto/:id/status ───────────────────────────────
// Transition: draft→active or active→archived. Manager+ only.
// Activating auto-archives any other active procedure on this asset.
router.patch('/:id/status', requireManager, async (req, res) => {
  try {
    const { assetId } = req.params;
    const accountId   = req.user.accountId;
    const { status }  = req.body;

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: `status must be one of ${VALID_STATUSES.join(', ')}` });
    }

    const existing = await prisma.lotoProc.findFirst({
      where:  { id: req.params.id, assetId, accountId },
      select: { id: true, status: true },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Procedure not found' });

    const updateData: any = { status };

    // Activating: record approver + auto-archive any current active procedure
    if (status === 'active') {
      updateData.approvedById = req.user.id;
      updateData.approvedAt   = new Date();
    }

    const proc = await prisma.$transaction(async (tx: any) => {
      if (status === 'active') {
        // Archive any other active procedures on this asset
        await tx.lotoProc.updateMany({
          where: { assetId, accountId, status: 'active', id: { not: req.params.id } },
          data:  { status: 'archived' },
        });
      }
      return tx.lotoProc.update({
        where:   { id: req.params.id },
        data:    updateData,
        include: {
          approvedBy:    { select: { id: true, name: true } },
          energySources: { orderBy: { sortOrder: 'asc' } },
          steps:         { orderBy: { sortOrder: 'asc' } },
        },
      });
    });

    return res.json({ success: true, data: proc });
  } catch (err) {
    console.error('[loto PATCH /:id/status]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── DELETE /api/assets/:assetId/loto/:id ─────────────────────────────────────
// Hard delete — only allowed on draft procedures (active/archived are permanent record).
router.delete('/:id', requireManager, async (req, res) => {
  try {
    const { assetId } = req.params;
    const accountId   = req.user.accountId;

    const existing = await prisma.lotoProc.findFirst({
      where:  { id: req.params.id, assetId, accountId },
      select: { id: true, status: true },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Procedure not found' });
    if (existing.status !== 'draft') {
      return res.status(409).json({ success: false, error: 'Only draft procedures may be deleted; archive active/approved ones instead.' });
    }

    await prisma.lotoProc.delete({ where: { id: req.params.id } });
    return res.json({ success: true });
  } catch (err) {
    console.error('[loto DELETE /:id]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

export {};
