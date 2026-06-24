/**
 * /api/parts — Parts catalog + SpareInventory CRUD
 *
 * Part: account-scoped catalog entry (part number, description, cost…).
 * SpareInventory: links a Part to an Asset (or Site for site-level stock)
 *   with qty on hand, min stocking level, and bin location.
 *
 * All endpoints: manager+ only; accountId always from req.user (never caller-supplied).
 *
 * Routes:
 *   GET    /api/parts                          list catalog
 *   POST   /api/parts                          create part
 *   GET    /api/parts/:id                      get part + inventory entries
 *   PATCH  /api/parts/:id                      update part
 *   DELETE /api/parts/:id                      delete (blocked if inventory exists)
 *   GET    /api/parts/:id/inventory            list inventory entries for part
 *   POST   /api/parts/:id/inventory            add inventory entry
 *   PATCH  /api/parts/:id/inventory/:entryId   update entry (qty / location)
 *   DELETE /api/parts/:id/inventory/:entryId   remove entry
 *   GET    /api/parts/by-asset/:assetId        all spares for an asset (with part info)
 */

const router = require('express').Router();
const prisma = require('../lib/prisma').default;
const { requireManager } = require('../middleware/roles');
const { writeLog } = require('../lib/activityLog');

// ── helpers ────────────────────────────────────────────────────────────────────

function str(v: any, max = 500): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s || undefined;
}
function posInt(v: any): number | undefined {
  const n = parseInt(v, 10);
  // Cap at PG INT max to avoid runtime overflow errors instead of 400s.
  return Number.isFinite(n) && n >= 0 && n <= 2_147_483_647 ? n : undefined;
}
function posDec(v: any): number | undefined {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const VALID_CATEGORIES = ['BREAKER', 'TRANSFORMER', 'RELAY', 'CABLE', 'FUSE', 'CONSUMABLE', 'OTHER'];

// ── Part catalog ───────────────────────────────────────────────────────────────

// GET /api/parts
router.get('/', requireManager, async (req: any, res: any) => {
  try {
    const { accountId } = req.user;
    const search = str(req.query.search);
    const category = str(req.query.category);
    const where: any = { accountId };
    if (category && VALID_CATEGORIES.includes(category.toUpperCase())) {
      where.category = category.toUpperCase();
    }
    if (search) {
      where.OR = [
        { partNumber: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { manufacturer: { contains: search, mode: 'insensitive' } },
      ];
    }
    const parts = await prisma.part.findMany({
      where,
      orderBy: [{ category: 'asc' }, { partNumber: 'asc' }],
      include: {
        _count: { select: { inventory: true } },
      },
    });
    return res.json({ success: true, data: parts });
  } catch (err: any) {
    console.error('[parts GET /]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to list parts.' });
  }
});

// GET /api/parts/by-asset/:assetId
router.get('/by-asset/:assetId', requireManager, async (req: any, res: any) => {
  try {
    const { accountId } = req.user;
    const assetId = String(req.params.assetId);
    // Verify asset belongs to account
    const asset = await prisma.asset.findFirst({ where: { id: assetId, accountId }, select: { id: true } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found.' });

    const entries = await prisma.spareInventory.findMany({
      where: { accountId, assetId },
      include: { part: true },
      orderBy: [{ part: { category: 'asc' } }, { part: { partNumber: 'asc' } }],
    });
    return res.json({ success: true, data: entries });
  } catch (err: any) {
    console.error('[parts GET /by-asset]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to load asset spares.' });
  }
});

// POST /api/parts
router.post('/', requireManager, async (req: any, res: any) => {
  try {
    const { accountId, id: userId } = req.user;
    const partNumber = str(req.body?.partNumber, 100);
    const description = str(req.body?.description, 500);
    if (!partNumber || !description) {
      return res.status(400).json({ success: false, error: 'partNumber and description are required.' });
    }
    const rawCategory = str(req.body?.category, 30)?.toUpperCase();
    const category = rawCategory && VALID_CATEGORIES.includes(rawCategory) ? rawCategory : undefined;

    const part = await prisma.part.create({
      data: {
        accountId,
        partNumber,
        description,
        manufacturer: str(req.body?.manufacturer, 200),
        category,
        unitCost: posDec(req.body?.unitCost),
        leadTimeWeeks: posInt(req.body?.leadTimeWeeks),
        notes: str(req.body?.notes, 2000),
      },
    });
    writeLog({ accountId, userId, assetId: null, action: 'part_created', details: { partId: part.id, partNumber } });
    return res.status(201).json({ success: true, data: part });
  } catch (err: any) {
    console.error('[parts POST /]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to create part.' });
  }
});

// GET /api/parts/:id
router.get('/:id', requireManager, async (req: any, res: any) => {
  try {
    const { accountId } = req.user;
    const part = await prisma.part.findFirst({
      where: { id: String(req.params.id), accountId },
      include: { inventory: { include: { asset: { select: { id: true, manufacturer: true, model: true, equipmentType: true, siteId: true } }, site: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } } },
    });
    if (!part) return res.status(404).json({ success: false, error: 'Part not found.' });
    return res.json({ success: true, data: part });
  } catch (err: any) {
    console.error('[parts GET /:id]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch part.' });
  }
});

// PATCH /api/parts/:id
router.patch('/:id', requireManager, async (req: any, res: any) => {
  try {
    const { accountId, id: userId } = req.user;
    const existing = await prisma.part.findFirst({ where: { id: String(req.params.id), accountId }, select: { id: true, partNumber: true } });
    if (!existing) return res.status(404).json({ success: false, error: 'Part not found.' });

    const updates: any = {};
    if (req.body?.partNumber != null) updates.partNumber = str(req.body.partNumber, 100) || existing.partNumber;
    if (req.body?.description != null) updates.description = str(req.body.description, 500);
    if (req.body?.manufacturer != null) updates.manufacturer = str(req.body.manufacturer, 200) ?? null;
    if (req.body?.category != null) {
      const raw = String(req.body.category).toUpperCase();
      updates.category = VALID_CATEGORIES.includes(raw) ? raw : null;
    }
    if (req.body?.unitCost != null) updates.unitCost = posDec(req.body.unitCost) ?? null;
    if (req.body?.leadTimeWeeks != null) updates.leadTimeWeeks = posInt(req.body.leadTimeWeeks) ?? null;
    if (req.body?.notes != null) updates.notes = str(req.body.notes, 2000) ?? null;

    const part = await prisma.part.update({ where: { id: existing.id }, data: updates });
    writeLog({ accountId, userId, assetId: null, action: 'part_updated', details: { partId: part.id, fields: Object.keys(updates) } });
    return res.json({ success: true, data: part });
  } catch (err: any) {
    console.error('[parts PATCH /:id]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to update part.' });
  }
});

// DELETE /api/parts/:id  (blocked if any SpareInventory entries exist)
router.delete('/:id', requireManager, async (req: any, res: any) => {
  try {
    const { accountId, id: userId } = req.user;
    const existing = await prisma.part.findFirst({
      where: { id: String(req.params.id), accountId },
      include: { _count: { select: { inventory: true } } },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Part not found.' });
    if (existing._count.inventory > 0) {
      return res.status(409).json({ success: false, error: `Cannot delete — ${existing._count.inventory} inventory entry/entries exist. Remove them first.` });
    }
    await prisma.part.delete({ where: { id: existing.id } });
    writeLog({ accountId, userId, assetId: null, action: 'part_deleted', details: { partId: existing.id, partNumber: existing.partNumber } });
    return res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    console.error('[parts DELETE /:id]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to delete part.' });
  }
});

// ── SpareInventory ─────────────────────────────────────────────────────────────

// GET /api/parts/:id/inventory
router.get('/:id/inventory', requireManager, async (req: any, res: any) => {
  try {
    const { accountId } = req.user;
    const part = await prisma.part.findFirst({ where: { id: String(req.params.id), accountId }, select: { id: true } });
    if (!part) return res.status(404).json({ success: false, error: 'Part not found.' });
    const entries = await prisma.spareInventory.findMany({
      where: { accountId, partId: part.id },
      include: {
        asset: { select: { id: true, manufacturer: true, model: true, equipmentType: true } },
        site: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return res.json({ success: true, data: entries });
  } catch (err: any) {
    console.error('[parts GET /:id/inventory]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch inventory.' });
  }
});

// POST /api/parts/:id/inventory
router.post('/:id/inventory', requireManager, async (req: any, res: any) => {
  try {
    const { accountId, id: userId } = req.user;
    const part = await prisma.part.findFirst({ where: { id: String(req.params.id), accountId }, select: { id: true, partNumber: true } });
    if (!part) return res.status(404).json({ success: false, error: 'Part not found.' });

    // Validate assetId / siteId belong to account if provided
    const assetId = str(req.body?.assetId, 50);
    const siteId = str(req.body?.siteId, 50);
    if (assetId) {
      const a = await prisma.asset.findFirst({ where: { id: assetId, accountId }, select: { id: true } });
      if (!a) return res.status(400).json({ success: false, error: 'Asset not found in this account.' });
    }
    if (siteId) {
      const s = await prisma.site.findFirst({ where: { id: siteId, accountId }, select: { id: true } });
      if (!s) return res.status(400).json({ success: false, error: 'Site not found in this account.' });
    }
    const qtyOnHand = posInt(req.body?.qtyOnHand) ?? 0;
    const qtyMin = posInt(req.body?.qtyMin);

    const entry = await prisma.spareInventory.create({
      data: {
        accountId,
        partId: part.id,
        assetId: assetId ?? null,
        siteId: siteId ?? null,
        qtyOnHand,
        qtyMin: qtyMin ?? null,
        location: str(req.body?.location, 200),
        notes: str(req.body?.notes, 1000),
      },
    });
    writeLog({
      accountId, userId, assetId: assetId ?? null,
      action: 'spare_inventory_added',
      details: { entryId: entry.id, partId: part.id, partNumber: part.partNumber, qtyOnHand },
    });
    return res.status(201).json({ success: true, data: entry });
  } catch (err: any) {
    console.error('[parts POST /:id/inventory]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to add inventory entry.' });
  }
});

// PATCH /api/parts/:id/inventory/:entryId
router.patch('/:id/inventory/:entryId', requireManager, async (req: any, res: any) => {
  try {
    const { accountId, id: userId } = req.user;
    const entry = await prisma.spareInventory.findFirst({
      where: { id: String(req.params.entryId), accountId, partId: String(req.params.id) },
    });
    if (!entry) return res.status(404).json({ success: false, error: 'Inventory entry not found.' });

    const updates: any = {};
    if (req.body?.qtyOnHand != null) updates.qtyOnHand = posInt(req.body.qtyOnHand) ?? entry.qtyOnHand;
    if (req.body?.qtyMin != null) updates.qtyMin = posInt(req.body.qtyMin) ?? null;
    if (req.body?.location != null) updates.location = str(req.body.location, 200) ?? null;
    if (req.body?.notes != null) updates.notes = str(req.body.notes, 1000) ?? null;

    const updated = await prisma.spareInventory.update({ where: { id: entry.id }, data: updates });
    writeLog({
      accountId, userId, assetId: entry.assetId ?? null,
      action: 'spare_inventory_updated',
      details: { entryId: entry.id, fields: Object.keys(updates) },
    });
    return res.json({ success: true, data: updated });
  } catch (err: any) {
    console.error('[parts PATCH /:id/inventory/:entryId]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to update inventory entry.' });
  }
});

// DELETE /api/parts/:id/inventory/:entryId
router.delete('/:id/inventory/:entryId', requireManager, async (req: any, res: any) => {
  try {
    const { accountId, id: userId } = req.user;
    const entry = await prisma.spareInventory.findFirst({
      where: { id: String(req.params.entryId), accountId, partId: String(req.params.id) },
    });
    if (!entry) return res.status(404).json({ success: false, error: 'Inventory entry not found.' });

    await prisma.spareInventory.delete({ where: { id: entry.id } });
    writeLog({
      accountId, userId, assetId: entry.assetId ?? null,
      action: 'spare_inventory_removed',
      details: { entryId: entry.id, partId: entry.partId },
    });
    return res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    console.error('[parts DELETE /:id/inventory/:entryId]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to remove inventory entry.' });
  }
});

module.exports = router;
export {};
