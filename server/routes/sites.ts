/**
 * /api/sites — site + facility-hierarchy CRUD.
 *
 * The hierarchy is sites → buildings → areas → equipment_positions → assets,
 * and it's deliberately FLEXIBLE: a small facility can hang areas (or even
 * positions) directly off the site, while a large industrial campus uses
 * every level. Each nested write here validates parent ownership against
 * req.user.accountId before touching the child row — Building/Area/Position
 * rows carry a denormalized accountId precisely so these checks (and future
 * list queries) never need a join back through Site.
 *
 * Blackout windows are customer-declared downtime windows attached to a
 * site. isOutageWindow=true means "outage work may be scheduled INSIDE this
 * window" (planned shutdown); false means a freeze — no work at all inside
 * it (production run, audit period). The scheduler reads these; this file
 * only manages the records.
 *
 * Auth: authenticateToken is applied at the mount point in index.ts.
 * Writes are manager+ (requireManager); reads are any authenticated role.
 * TENANCY: every prisma query in this file filters by req.user.accountId.
 */

const router = require('express').Router();
const { requireManager } = require('../middleware/roles');
import prisma from '../lib/prisma';

// ─── Activity logging helper ──────────────────────────────────────────────────
// Non-fatal fire-and-forget. Site-level events have no assetId — the log row
// is account-scoped only (ActivityLog.assetId is nullable for exactly this).
async function logActivity(userId, accountId, action, details = null) {
  try {
    await prisma.activityLog.create({
      data: { assetId: null, userId, accountId: accountId ?? null, action, details: details ?? undefined },
    });
  } catch (err) {
    console.error('logActivity error:', err.message);
  }
}

// Per-account site name uniqueness is enforced by the DB
// (@@unique([accountId, name])) — a P2002 here means a duplicate-create
// race or a rename collision, surfaced as 409 so the form can prompt.
function isUniqueViolation(err) {
  return err && err.code === 'P2002';
}

// ─── GET /api/sites ───────────────────────────────────────────────────────────
// List sites with non-archived asset counts and open-deficiency counts.
// ?archived=true shows ONLY archived sites; default excludes them.
router.get('/', async (req, res) => {
  try {
    const where: any = { accountId: req.user.accountId };
    if (req.query.archived === 'true') where.NOT = { archivedAt: null };
    else where.archivedAt = null;

    const [sites, openDefs] = await Promise.all([
      prisma.site.findMany({
        where,
        orderBy: { name: 'asc' },
        include: {
          _count: {
            select: {
              assets:    { where: { archivedAt: null } },
              buildings: true,
            },
          },
        },
      }),
      // Deficiency carries no siteId — the site rollup goes through the
      // asset. Open deficiencies are a small working set per tenant
      // (resolved rows fall out of the filter), so one fetch + JS tally
      // beats N per-site count queries.
      prisma.deficiency.findMany({
        where:  { accountId: req.user.accountId, resolvedAt: null },
        select: { asset: { select: { siteId: true } } },
      }),
    ]);

    const defsBySite = new Map();
    for (const d of openDefs) {
      const sid = d.asset?.siteId;
      if (!sid) continue;
      defsBySite.set(sid, (defsBySite.get(sid) || 0) + 1);
    }

    const decorated = sites.map((s) => ({
      ...s,
      assetCount:          s._count?.assets ?? 0,
      openDeficiencyCount: defsBySite.get(s.id) || 0,
    }));

    res.json({ success: true, data: { sites: decorated } });
  } catch (err) {
    console.error('List sites error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch sites' });
  }
});

// ─── GET /api/sites/:id ───────────────────────────────────────────────────────
// Site detail with the full hierarchy tree. Because the hierarchy is
// flexible, the tree comes back in three branches:
//   buildings[] (each with its areas, each with its positions)
//   areas[]     — areas hanging DIRECTLY off the site (buildingId null)
//   positions[] — positions hanging DIRECTLY off the site (areaId null)
// plus the non-archived asset count and upcoming blackout windows.
router.get('/:id', async (req, res) => {
  try {
    const site = await prisma.site.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      include: {
        buildings: {
          orderBy: { name: 'asc' },
          include: {
            areas: {
              orderBy: { name: 'asc' },
              include: { positions: { orderBy: { name: 'asc' } } },
            },
          },
        },
        areas: {
          where:   { buildingId: null },
          orderBy: { name: 'asc' },
          include: { positions: { orderBy: { name: 'asc' } } },
        },
        positions: {
          where:   { areaId: null },
          orderBy: { name: 'asc' },
        },
        blackoutWindows: {
          where:   { endsAt: { gte: new Date() } },
          orderBy: { startsAt: 'asc' },
        },
        _count: {
          select: { assets: { where: { archivedAt: null } } },
        },
      },
    });

    if (!site) {
      return res.status(404).json({ success: false, error: 'Site not found' });
    }

    res.json({ success: true, data: { site } });
  } catch (err) {
    console.error('Get site error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch site' });
  }
});

// ─── POST /api/sites ──────────────────────────────────────────────────────────
router.post('/', requireManager, async (req, res) => {
  try {
    const {
      name, address, city, state, postalCode,
      primaryContactName, primaryContactEmail, primaryContactPhone, notes,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Site name is required' });
    }
    if (name.length > 200) {
      return res.status(400).json({ success: false, error: 'Site name must be 200 characters or fewer' });
    }

    const site = await prisma.site.create({
      data: {
        accountId:           req.user.accountId,
        name:                name.trim(),
        address:             address || null,
        city:                city || null,
        state:               state || null,
        postalCode:          postalCode || null,
        primaryContactName:  primaryContactName || null,
        primaryContactEmail: primaryContactEmail || null,
        primaryContactPhone: primaryContactPhone || null,
        notes:               notes || null,
      },
    });

    await logActivity(req.user.id, req.user.accountId, 'site_created', { name: site.name });

    res.status(201).json({ success: true, data: { site } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ success: false, error: 'A site with this name already exists' });
    }
    console.error('Create site error:', err);
    res.status(500).json({ success: false, error: 'Failed to create site' });
  }
});

// ─── PUT /api/sites/:id ───────────────────────────────────────────────────────
router.put('/:id', requireManager, async (req, res) => {
  try {
    const existing = await prisma.site.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Site not found' });
    }

    const {
      name, address, city, state, postalCode,
      primaryContactName, primaryContactEmail, primaryContactPhone, notes,
    } = req.body;

    const updateData: any = {};
    if (name !== undefined) {
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Site name cannot be empty' });
      }
      if (name.length > 200) {
        return res.status(400).json({ success: false, error: 'Site name must be 200 characters or fewer' });
      }
      updateData.name = name.trim();
    }
    if (address !== undefined)             updateData.address = address || null;
    if (city !== undefined)                updateData.city = city || null;
    if (state !== undefined)               updateData.state = state || null;
    if (postalCode !== undefined)          updateData.postalCode = postalCode || null;
    if (primaryContactName !== undefined)  updateData.primaryContactName = primaryContactName || null;
    if (primaryContactEmail !== undefined) updateData.primaryContactEmail = primaryContactEmail || null;
    if (primaryContactPhone !== undefined) updateData.primaryContactPhone = primaryContactPhone || null;
    if (notes !== undefined)               updateData.notes = notes || null;

    const site = await prisma.site.update({
      where: { id: req.params.id },
      data:  updateData,
    });

    res.json({ success: true, data: { site } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ success: false, error: 'A site with this name already exists' });
    }
    console.error('Update site error:', err);
    res.status(500).json({ success: false, error: 'Failed to update site' });
  }
});

// ─── POST /api/sites/:id/archive ──────────────────────────────────────────────
// Soft-delete. Assets keep their siteId — an archived site's equipment
// history stays addressable; the site just drops out of the default list.
router.post('/:id/archive', requireManager, async (req, res) => {
  try {
    const existing = await prisma.site.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Site not found' });
    }

    const site = await prisma.site.update({
      where: { id: req.params.id },
      data:  { archivedAt: new Date() },
    });

    await logActivity(req.user.id, req.user.accountId, 'site_archived', { name: site.name });

    res.json({ success: true, data: { site } });
  } catch (err) {
    console.error('Archive site error:', err);
    res.status(500).json({ success: false, error: 'Failed to archive site' });
  }
});

// ─── POST /api/sites/:id/unarchive ────────────────────────────────────────────
router.post('/:id/unarchive', requireManager, async (req, res) => {
  try {
    const existing = await prisma.site.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Site not found' });
    }

    const site = await prisma.site.update({
      where: { id: req.params.id },
      data:  { archivedAt: null },
    });

    await logActivity(req.user.id, req.user.accountId, 'site_unarchived', { name: site.name });

    res.json({ success: true, data: { site } });
  } catch (err) {
    console.error('Unarchive site error:', err);
    res.status(500).json({ success: false, error: 'Failed to unarchive site' });
  }
});

// ═══ Buildings ════════════════════════════════════════════════════════════════

// ─── POST /api/sites/:siteId/buildings ────────────────────────────────────────
router.post('/:siteId/buildings', requireManager, async (req, res) => {
  try {
    const site = await prisma.site.findFirst({
      where: { id: req.params.siteId, accountId: req.user.accountId },
    });
    if (!site) return res.status(404).json({ success: false, error: 'Site not found' });

    const { name, notes } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Building name is required' });
    }

    const building = await prisma.building.create({
      data: {
        accountId: req.user.accountId,
        siteId:    req.params.siteId,
        name:      name.trim(),
        notes:     notes || null,
      },
    });

    res.status(201).json({ success: true, data: { building } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ success: false, error: 'A building with this name already exists at this site' });
    }
    console.error('Create building error:', err);
    res.status(500).json({ success: false, error: 'Failed to create building' });
  }
});

// ─── PUT /api/sites/buildings/:id ─────────────────────────────────────────────
router.put('/buildings/:id', requireManager, async (req, res) => {
  try {
    const existing = await prisma.building.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Building not found' });

    const { name, notes } = req.body;
    const updateData: any = {};
    if (name !== undefined) {
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Building name cannot be empty' });
      }
      updateData.name = name.trim();
    }
    if (notes !== undefined) updateData.notes = notes || null;

    const building = await prisma.building.update({
      where: { id: existing.id },
      data:  updateData,
    });

    res.json({ success: true, data: { building } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ success: false, error: 'A building with this name already exists at this site' });
    }
    console.error('Update building error:', err);
    res.status(500).json({ success: false, error: 'Failed to update building' });
  }
});

// ─── DELETE /api/sites/buildings/:id ──────────────────────────────────────────
// Hard delete — buildings carry no history of their own. The FK constraints
// (areas.buildingId, assets.buildingId) block deletion while children point
// at the row; we surface that as a 409 with a human explanation instead of
// a raw P2003.
router.delete('/buildings/:id', requireManager, async (req, res) => {
  try {
    const existing = await prisma.building.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Building not found' });

    await prisma.building.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (err) {
    if (err && err.code === 'P2003') {
      return res.status(409).json({ success: false, error: 'Building still has areas or assets — reassign or remove them first' });
    }
    console.error('Delete building error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete building' });
  }
});

// ═══ Areas ════════════════════════════════════════════════════════════════════

// ─── POST /api/sites/:siteId/areas ────────────────────────────────────────────
// buildingId is optional — small sites hang areas directly under the site.
// When supplied it must belong to THIS site (chain consistency on write).
router.post('/:siteId/areas', requireManager, async (req, res) => {
  try {
    const site = await prisma.site.findFirst({
      where: { id: req.params.siteId, accountId: req.user.accountId },
    });
    if (!site) return res.status(404).json({ success: false, error: 'Site not found' });

    const { name, buildingId, notes } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Area name is required' });
    }

    if (buildingId) {
      const building = await prisma.building.findFirst({
        where: { id: buildingId, siteId: req.params.siteId, accountId: req.user.accountId },
      });
      if (!building) {
        return res.status(400).json({ success: false, error: 'Building not found at this site' });
      }
    }

    const area = await prisma.area.create({
      data: {
        accountId:  req.user.accountId,
        siteId:     req.params.siteId,
        buildingId: buildingId || null,
        name:       name.trim(),
        notes:      notes || null,
      },
    });

    res.status(201).json({ success: true, data: { area } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ success: false, error: 'An area with this name already exists at this site' });
    }
    console.error('Create area error:', err);
    res.status(500).json({ success: false, error: 'Failed to create area' });
  }
});

// ─── PUT /api/sites/areas/:id ─────────────────────────────────────────────────
router.put('/areas/:id', requireManager, async (req, res) => {
  try {
    const existing = await prisma.area.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Area not found' });

    const { name, buildingId, notes } = req.body;
    const updateData: any = {};
    if (name !== undefined) {
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Area name cannot be empty' });
      }
      updateData.name = name.trim();
    }
    if (buildingId !== undefined) {
      if (buildingId) {
        // Re-parenting an area must stay within its own site.
        const building = await prisma.building.findFirst({
          where: { id: buildingId, siteId: existing.siteId, accountId: req.user.accountId },
        });
        if (!building) {
          return res.status(400).json({ success: false, error: 'Building not found at this site' });
        }
      }
      updateData.buildingId = buildingId || null;
    }
    if (notes !== undefined) updateData.notes = notes || null;

    const area = await prisma.area.update({
      where: { id: existing.id },
      data:  updateData,
    });

    res.json({ success: true, data: { area } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ success: false, error: 'An area with this name already exists at this site' });
    }
    console.error('Update area error:', err);
    res.status(500).json({ success: false, error: 'Failed to update area' });
  }
});

// ─── DELETE /api/sites/areas/:id ──────────────────────────────────────────────
router.delete('/areas/:id', requireManager, async (req, res) => {
  try {
    const existing = await prisma.area.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Area not found' });

    await prisma.area.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (err) {
    if (err && err.code === 'P2003') {
      return res.status(409).json({ success: false, error: 'Area still has positions or assets — reassign or remove them first' });
    }
    console.error('Delete area error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete area' });
  }
});

// ═══ Equipment Positions ══════════════════════════════════════════════════════
// A named physical slot equipment occupies — "Substation A, Cubicle 3",
// "MCC-1 Bucket 4B". An asset swap (replace the transformer) keeps the
// position's history intact, which is why positions are first-class records
// rather than a text field on the asset.

// ─── POST /api/sites/:siteId/positions ────────────────────────────────────────
// areaId is optional — positions can hang directly off a site.
router.post('/:siteId/positions', requireManager, async (req, res) => {
  try {
    const site = await prisma.site.findFirst({
      where: { id: req.params.siteId, accountId: req.user.accountId },
    });
    if (!site) return res.status(404).json({ success: false, error: 'Site not found' });

    const { name, code, areaId, notes } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Position name is required' });
    }

    if (areaId) {
      const area = await prisma.area.findFirst({
        where: { id: areaId, siteId: req.params.siteId, accountId: req.user.accountId },
      });
      if (!area) {
        return res.status(400).json({ success: false, error: 'Area not found at this site' });
      }
    }

    const position = await prisma.equipmentPosition.create({
      data: {
        accountId: req.user.accountId,
        siteId:    req.params.siteId,
        areaId:    areaId || null,
        name:      name.trim(),
        code:      code || null,
        notes:     notes || null,
      },
    });

    res.status(201).json({ success: true, data: { position } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ success: false, error: 'A position with this name already exists at this site' });
    }
    console.error('Create position error:', err);
    res.status(500).json({ success: false, error: 'Failed to create position' });
  }
});

// ─── PUT /api/sites/positions/:id ─────────────────────────────────────────────
router.put('/positions/:id', requireManager, async (req, res) => {
  try {
    const existing = await prisma.equipmentPosition.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Position not found' });

    const { name, code, areaId, notes } = req.body;
    const updateData: any = {};
    if (name !== undefined) {
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Position name cannot be empty' });
      }
      updateData.name = name.trim();
    }
    if (code !== undefined) updateData.code = code || null;
    if (areaId !== undefined) {
      if (areaId) {
        const area = await prisma.area.findFirst({
          where: { id: areaId, siteId: existing.siteId, accountId: req.user.accountId },
        });
        if (!area) {
          return res.status(400).json({ success: false, error: 'Area not found at this site' });
        }
      }
      updateData.areaId = areaId || null;
    }
    if (notes !== undefined) updateData.notes = notes || null;

    const position = await prisma.equipmentPosition.update({
      where: { id: existing.id },
      data:  updateData,
    });

    res.json({ success: true, data: { position } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ success: false, error: 'A position with this name already exists at this site' });
    }
    console.error('Update position error:', err);
    res.status(500).json({ success: false, error: 'Failed to update position' });
  }
});

// ─── DELETE /api/sites/positions/:id ──────────────────────────────────────────
router.delete('/positions/:id', requireManager, async (req, res) => {
  try {
    const existing = await prisma.equipmentPosition.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Position not found' });

    await prisma.equipmentPosition.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (err) {
    if (err && err.code === 'P2003') {
      return res.status(409).json({ success: false, error: 'Position still has assets — reassign or remove them first' });
    }
    console.error('Delete position error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete position' });
  }
});

// ═══ Blackout Windows ═════════════════════════════════════════════════════════

// ─── GET /api/sites/:siteId/blackout-windows ──────────────────────────────────
router.get('/:siteId/blackout-windows', async (req, res) => {
  try {
    const site = await prisma.site.findFirst({
      where: { id: req.params.siteId, accountId: req.user.accountId },
    });
    if (!site) return res.status(404).json({ success: false, error: 'Site not found' });

    const windows = await prisma.blackoutWindow.findMany({
      where:   { siteId: req.params.siteId, accountId: req.user.accountId },
      orderBy: { startsAt: 'asc' },
    });

    res.json({ success: true, data: { windows } });
  } catch (err) {
    console.error('List blackout windows error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch blackout windows' });
  }
});

// ─── POST /api/sites/:siteId/blackout-windows ─────────────────────────────────
// Body: { startsAt, endsAt, isOutageWindow?, reason? }
// isOutageWindow defaults true (planned shutdown — outage work allowed
// inside); pass false to declare a no-work freeze.
router.post('/:siteId/blackout-windows', requireManager, async (req, res) => {
  try {
    const site = await prisma.site.findFirst({
      where: { id: req.params.siteId, accountId: req.user.accountId },
    });
    if (!site) return res.status(404).json({ success: false, error: 'Site not found' });

    const { startsAt, endsAt, isOutageWindow, reason } = req.body;
    if (!startsAt || !endsAt) {
      return res.status(400).json({ success: false, error: 'startsAt and endsAt are required' });
    }
    const start = new Date(startsAt);
    const end   = new Date(endsAt);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ success: false, error: 'startsAt and endsAt must be valid dates' });
    }
    if (end <= start) {
      return res.status(400).json({ success: false, error: 'endsAt must be after startsAt' });
    }

    const window = await prisma.blackoutWindow.create({
      data: {
        accountId:      req.user.accountId,
        siteId:         req.params.siteId,
        startsAt:       start,
        endsAt:         end,
        isOutageWindow: isOutageWindow !== undefined
          ? (isOutageWindow === true || isOutageWindow === 'true')
          : true,
        reason: reason || null,
      },
    });

    res.status(201).json({ success: true, data: { window } });
  } catch (err) {
    console.error('Create blackout window error:', err);
    res.status(500).json({ success: false, error: 'Failed to create blackout window' });
  }
});

// ─── DELETE /api/sites/blackout-windows/:id ───────────────────────────────────
router.delete('/blackout-windows/:id', requireManager, async (req, res) => {
  try {
    const existing = await prisma.blackoutWindow.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Blackout window not found' });

    await prisma.blackoutWindow.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete blackout window error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete blackout window' });
  }
});

module.exports = router;

export {};
