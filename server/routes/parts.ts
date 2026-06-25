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
 *   GET    /api/parts/low-stock               count + list of below-min inventory entries
 *   GET    /api/parts/import/template         download blank CSV import template
 *   POST   /api/parts/import?preview=true     parse CSV, return row statuses (no writes)
 *   POST   /api/parts/import                  upsert parts + inventory from CSV
 *   GET    /api/parts/required-by/:assetId    required parts for an asset (with stock status)
 *   POST   /api/parts/required-by/:assetId    add/update a required-part link
 *   DELETE /api/parts/required-by/:assetId/:partId  remove a required-part link
 */

const router = require('express').Router();
const prisma = require('../lib/prisma').default;
const { requireManager } = require('../middleware/roles');
const { writeLog } = require('../lib/activityLog');
const { resolveAccountFeatures } = require('../lib/accountFeatures');

// Feature guard: parts_module defaults ON. Returns 403 if account has disabled it.
router.use(async (req: any, res: any, next: any) => {
  if (!req.user) return next(); // unauthenticated — let requireManager handle 401
  try {
    const features = await resolveAccountFeatures(req.user.accountId);
    if (!features.parts_module) {
      return res.status(403).json({
        success: false,
        error: 'Parts & Inventory module is disabled. Enable it in Settings → General.',
      });
    }
    next();
  } catch { next(); }
});

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

// ── Low-stock summary (dashboard card) ─────────────────────────────────────────

// GET /api/parts/low-stock
// Returns count of SpareInventory entries where qtyOnHand < qtyMin (qtyMin not null).
// Used by the dashboard Parts Alerts tile.
router.get('/low-stock', requireManager, async (req: any, res: any) => {
  try {
    const { accountId } = req.user;
    const entries = await prisma.spareInventory.findMany({
      where: { accountId, qtyMin: { not: null } },
      select: {
        qtyOnHand: true,
        qtyMin: true,
        part: { select: { id: true, partNumber: true, description: true, category: true, leadTimeWeeks: true } },
        asset: { select: { id: true, equipmentType: true, manufacturer: true, model: true } },
        site: { select: { id: true, name: true } },
      },
    });
    const LONG_LEAD_WEEKS = 8; // flag as procurement risk when lead time >= this
    const low = entries
      .filter((e: any) => e.qtyMin != null && e.qtyOnHand < e.qtyMin)
      .map((e: any) => ({
        ...e,
        procurementRisk: e.part?.leadTimeWeeks != null && e.part.leadTimeWeeks >= LONG_LEAD_WEEKS,
      }));
    const procurementRiskCount = low.filter((e: any) => e.procurementRisk).length;
    return res.json({ success: true, data: { count: low.length, items: low, procurementRiskCount } });
  } catch (err: any) {
    console.error('[parts GET /low-stock]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch low-stock summary.' });
  }
});

// ── CSV import ─────────────────────────────────────────────────────────────────

// GET /api/parts/import/template  — download a blank CSV template
router.get('/import/template', requireManager, (_req: any, res: any) => {
  const header = 'partNumber,description,manufacturer,category,unitCost,leadTimeWeeks,notes,qtyOnHand,qtyMin,location';
  const example = 'CH-QO130L,30A 1-pole QO breaker,Square D,BREAKER,24.99,2,,10,3,Warehouse A Bin 4';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="parts-import-template.csv"');
  return res.send(header + '\n' + example + '\n');
});

// POST /api/parts/import?preview=true|false
// Body: multipart form-data with field "file" (CSV), OR raw text/csv body.
// preview=true → parse and return rows with status (new/update/error); no DB writes.
// preview=false (or absent) → upsert all valid rows; returns summary.
const multer = require('multer');
// fileFilter: accept CSV and plain-text MIME types. Some browsers (notably
// Excel on Windows) send application/vnd.ms-excel for .csv files; text/plain
// is also common. We reject clearly-binary types (images, PDFs, ZIPs, etc.)
// as defence-in-depth even though the buffer is only ever text-parsed.
const _csvFilter = (_req: any, file: any, cb: any) => {
  const ok = /^(text\/(csv|plain)|application\/(csv|vnd\.ms-excel))$/i.test(file.mimetype)
             || file.originalname.toLowerCase().endsWith('.csv');
  if (ok) return cb(null, true);
  cb(Object.assign(new Error('Only CSV files are accepted.'), { status: 400 }));
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 }, fileFilter: _csvFilter });

function parsePartsCSV(text: string): { rows: any[]; errors: string[] } {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(Boolean);
  if (lines.length < 2) return { rows: [], errors: ['CSV has no data rows.'] };
  // Strip BOM
  const headerLine = lines[0].replace(/^﻿/, '');
  const cols = headerLine.split(',').map((c: string) => c.trim().toLowerCase());
  const required = ['partnumber', 'description'];
  for (const r of required) {
    if (!cols.includes(r)) return { rows: [], errors: [`Missing required column: ${r}`] };
  }
  const idx = (name: string) => cols.indexOf(name);
  const rows: any[] = [];
  const errors: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    const get = (name: string) => (vals[idx(name)] || '').trim();
    const partNumber = get('partnumber');
    const description = get('description');
    if (!partNumber || !description) { errors.push(`Row ${i + 1}: partNumber and description are required.`); continue; }
    const rawCat = get('category').toUpperCase();
    const category = VALID_CATEGORIES.includes(rawCat) ? rawCat : undefined;
    const unitCost = parseFloat(get('unitcost'));
    const leadTimeWeeks = parseInt(get('leadtimeweeks'), 10);
    const qtyOnHand = parseInt(get('qtyonhand'), 10);
    const qtyMin = parseInt(get('qtymin'), 10);
    rows.push({
      partNumber,
      description,
      manufacturer: get('manufacturer') || undefined,
      category,
      unitCost: Number.isFinite(unitCost) && unitCost >= 0 ? unitCost : undefined,
      leadTimeWeeks: Number.isFinite(leadTimeWeeks) && leadTimeWeeks >= 0 ? leadTimeWeeks : undefined,
      notes: get('notes') || undefined,
      qtyOnHand: Number.isFinite(qtyOnHand) && qtyOnHand >= 0 ? qtyOnHand : 0,
      qtyMin: Number.isFinite(qtyMin) && qtyMin >= 0 ? qtyMin : undefined,
      location: get('location') || undefined,
    });
  }
  return { rows, errors };
}

router.post('/import', requireManager, upload.single('file'), async (req: any, res: any) => {
  try {
    const { accountId, id: userId } = req.user;
    const isPreview = String(req.query.preview) === 'true';

    let csvText: string;
    if (req.file) {
      csvText = req.file.buffer.toString('utf8');
    } else if (typeof req.body === 'string') {
      csvText = req.body;
    } else {
      return res.status(400).json({ success: false, error: 'Upload a CSV file.' });
    }

    const { rows, errors } = parsePartsCSV(csvText);
    if (errors.length && !rows.length) {
      return res.status(400).json({ success: false, error: errors[0], parseErrors: errors });
    }

    if (isPreview) {
      // Check which rows are new vs. updates
      const existingParts = await prisma.part.findMany({
        where: { accountId },
        select: { partNumber: true },
      });
      const existingSet = new Set(existingParts.map((p: any) => p.partNumber.toLowerCase()));
      const preview = rows.map((r: any) => ({
        ...r,
        status: existingSet.has(r.partNumber.toLowerCase()) ? 'update' : 'new',
      }));
      return res.json({ success: true, data: { preview, parseErrors: errors, total: rows.length } });
    }

    // Confirm import: upsert parts + create account-wide inventory entries
    let created = 0, updated = 0;
    for (const r of rows) {
      const existing = await prisma.part.findFirst({
        where: { accountId, partNumber: { equals: r.partNumber, mode: 'insensitive' } },
        select: { id: true },
      });
      if (existing) {
        await prisma.part.update({
          where: { id: existing.id },
          data: {
            description: r.description,
            manufacturer: r.manufacturer ?? undefined,
            category: r.category ?? undefined,
            unitCost: r.unitCost ?? undefined,
            leadTimeWeeks: r.leadTimeWeeks ?? undefined,
            notes: r.notes ?? undefined,
          },
        });
        // Update or create the account-wide inventory entry
        if (r.qtyOnHand != null || r.qtyMin != null) {
          const inv = await prisma.spareInventory.findFirst({
            where: { accountId, partId: existing.id, assetId: null, siteId: null },
            select: { id: true },
          });
          if (inv) {
            await prisma.spareInventory.update({
              where: { id: inv.id },
              data: { qtyOnHand: r.qtyOnHand ?? 0, qtyMin: r.qtyMin ?? null, location: r.location ?? null },
            });
          } else if (r.qtyOnHand > 0 || r.qtyMin != null) {
            await prisma.spareInventory.create({
              data: { accountId, partId: existing.id, qtyOnHand: r.qtyOnHand ?? 0, qtyMin: r.qtyMin ?? null, location: r.location ?? null },
            });
          }
        }
        updated++;
      } else {
        const part = await prisma.part.create({
          data: {
            accountId,
            partNumber: r.partNumber,
            description: r.description,
            manufacturer: r.manufacturer ?? null,
            category: r.category ?? null,
            unitCost: r.unitCost ?? null,
            leadTimeWeeks: r.leadTimeWeeks ?? null,
            notes: r.notes ?? null,
          },
        });
        if (r.qtyOnHand > 0 || r.qtyMin != null) {
          await prisma.spareInventory.create({
            data: { accountId, partId: part.id, qtyOnHand: r.qtyOnHand ?? 0, qtyMin: r.qtyMin ?? null, location: r.location ?? null },
          });
        }
        created++;
      }
    }
    writeLog({ accountId, userId, assetId: null, action: 'parts_imported', details: { created, updated, total: rows.length } });
    return res.json({ success: true, data: { created, updated, total: rows.length, parseErrors: errors } });
  } catch (err: any) {
    console.error('[parts POST /import]', err.message);
    return res.status(500).json({ success: false, error: 'Import failed.' });
  }
});

// ── Asset Part Requirements ─────────────────────────────────────────────────────
// Separate concept from SpareInventory (where/how many stocked) —
// this is "which parts does this asset need to have on hand".

// GET /api/parts/required-by/:assetId
router.get('/required-by/:assetId', requireManager, async (req: any, res: any) => {
  try {
    const { accountId } = req.user;
    const assetId = String(req.params.assetId);
    const asset = await prisma.asset.findFirst({ where: { id: assetId, accountId }, select: { id: true } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found.' });

    const requirements = await prisma.assetPartRequirement.findMany({
      where: { assetId, accountId },
      include: {
        part: {
          include: {
            inventory: {
              where: { accountId },
              select: { qtyOnHand: true, qtyMin: true, location: true, assetId: true, siteId: true },
            },
          },
        },
      },
      orderBy: [{ part: { category: 'asc' } }, { part: { partNumber: 'asc' } }],
    });

    // Annotate each requirement with total stock across all inventory entries
    const enriched = requirements.map((r: any) => {
      const totalOnHand = r.part.inventory.reduce((sum: number, e: any) => sum + e.qtyOnHand, 0);
      const stockStatus = totalOnHand === 0 ? 'OOS' : totalOnHand < r.qtyRequired ? 'LOW' : 'OK';
      return { ...r, totalOnHand, stockStatus };
    });
    return res.json({ success: true, data: enriched });
  } catch (err: any) {
    console.error('[parts GET /required-by]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to load required parts.' });
  }
});

// POST /api/parts/required-by/:assetId  body: { partId, qtyRequired?, notes? }
router.post('/required-by/:assetId', requireManager, async (req: any, res: any) => {
  try {
    const { accountId, id: userId } = req.user;
    const assetId = String(req.params.assetId);
    const partId = str(req.body?.partId, 50);
    if (!partId) return res.status(400).json({ success: false, error: 'partId is required.' });

    const [asset, part] = await Promise.all([
      prisma.asset.findFirst({ where: { id: assetId, accountId }, select: { id: true } }),
      prisma.part.findFirst({ where: { id: partId, accountId }, select: { id: true, partNumber: true } }),
    ]);
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found.' });
    if (!part) return res.status(404).json({ success: false, error: 'Part not found.' });

    const qtyRequired = posInt(req.body?.qtyRequired) ?? 1;
    const req_ = await prisma.assetPartRequirement.upsert({
      where: { assetId_partId: { assetId, partId } },
      create: { id: require('crypto').randomUUID(), accountId, assetId, partId, qtyRequired, notes: str(req.body?.notes, 500) ?? null },
      update: { qtyRequired, notes: str(req.body?.notes, 500) ?? null },
    });
    writeLog({ accountId, userId, assetId, action: 'asset_part_requirement_added', details: { partId, partNumber: part.partNumber, qtyRequired } });
    return res.status(201).json({ success: true, data: req_ });
  } catch (err: any) {
    if (err.code === 'P2002') return res.status(409).json({ success: false, error: 'This part is already linked to this asset.' });
    console.error('[parts POST /required-by]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to add requirement.' });
  }
});

// DELETE /api/parts/required-by/:assetId/:partId
router.delete('/required-by/:assetId/:partId', requireManager, async (req: any, res: any) => {
  try {
    const { accountId, id: userId } = req.user;
    const assetId = String(req.params.assetId);
    const partId = String(req.params.partId);
    const existing = await prisma.assetPartRequirement.findFirst({
      where: { assetId, partId, accountId },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Requirement not found.' });
    await prisma.assetPartRequirement.delete({ where: { id: existing.id } });
    writeLog({ accountId, userId, assetId, action: 'asset_part_requirement_removed', details: { partId } });
    return res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    console.error('[parts DELETE /required-by]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to remove requirement.' });
  }
});

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
    // Reject clearly-invalid quantities (negative / non-integer / > INT max)
    // with a 400 instead of silently clamping to 0, which masked client bugs.
    const qtyOnHand = req.body?.qtyOnHand != null ? posInt(req.body.qtyOnHand) : 0;
    if (qtyOnHand === undefined) return res.status(400).json({ success: false, error: 'qtyOnHand must be a non-negative integer.' });
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
    if (req.body?.qtyOnHand != null) {
      // Reject clearly-invalid quantities with a 400 rather than silently
      // keeping the prior value (which masked client bugs).
      const q = posInt(req.body.qtyOnHand);
      if (q === undefined) return res.status(400).json({ success: false, error: 'qtyOnHand must be a non-negative integer.' });
      updates.qtyOnHand = q;
    }
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
    if (!entry) return res.status(404).json({     success: false, error: 'Inventory entry not found.' });

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
