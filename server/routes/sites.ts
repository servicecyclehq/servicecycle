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
const { resolveTargetAccount } = require('../lib/oemTargetAccount');
const { resolveDownstreamAssetIds } = require('../lib/powerPath');

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
    // #14: an oem_admin can list a fleet customer's sites via ?targetAccountId
    // (so the cross-account ingest flow can create assets at the right site).
    let scopedAccountId: string;
    try { scopedAccountId = await resolveTargetAccount(req); }
    catch (e: any) { return res.status(e.httpStatus || 400).json({ success: false, error: e.message }); }

    const where: any = { accountId: scopedAccountId };
    if (req.query.archived === 'true') where.NOT = { archivedAt: null };
    else where.archivedAt = null;

    // [CUST-8-10] Optional pagination. Backward-compatible: callers that pass no
    // limit/offset/page get the full list (existing behavior) PLUS a `pagination`
    // block + `total`. Callers that opt in (limit/page) get a bounded page so the
    // endpoint can't return an unbounded payload at real volume. Page size is
    // capped at 200; offset takes precedence over page when both are given.
    const PAGE_CAP = 200;
    const rawLimit  = req.query.limit  !== undefined ? parseInt(String(req.query.limit), 10)  : NaN;
    const rawOffset = req.query.offset !== undefined ? parseInt(String(req.query.offset), 10) : NaN;
    const rawPage   = req.query.page   !== undefined ? parseInt(String(req.query.page), 10)   : NaN;
    const paginated = Number.isFinite(rawLimit) || Number.isFinite(rawOffset) || Number.isFinite(rawPage);
    const limit  = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, PAGE_CAP) : (paginated ? 50 : undefined);
    let   offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    if (!Number.isFinite(rawOffset) && Number.isFinite(rawPage) && rawPage > 1 && limit) offset = (rawPage - 1) * limit;

    const total = await prisma.site.count({ where });

    const [sites, openDefs] = await Promise.all([
      prisma.site.findMany({
        where,
        orderBy: { name: 'asc' },
        ...(limit !== undefined ? { skip: offset, take: limit } : {}),
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
        where:  { accountId: scopedAccountId, resolvedAt: null },
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

    res.json({
      success: true,
      data: {
        sites: decorated,
        total,
        pagination: {
          total,
          limit:    limit ?? total,
          offset:   limit !== undefined ? offset : 0,
          returned: decorated.length,
          // hasMore is meaningful only when paginating; full-list responses return everything.
          hasMore:  limit !== undefined ? (offset + decorated.length) < total : false,
        },
      },
    });
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
        // Engineering studies for the site (SystemStudy — renamed from
        // ArcFlashStudy; carries all four study types). Newest first; the
        // supersededById scalar keeps the revision chain visible.
        systemStudies: {
          orderBy: { performedDate: 'desc' },
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

// ═══ System Studies ═══════════════════════════════════════════════════════════
// Site-level engineering studies (SystemStudy — renamed from ArcFlashStudy):
//   arc_flash       — NFPA 70E 130.5(G) incident-energy analysis; review ≤5yr
//   short_circuit   — fault-current study; ≤5yr or after system changes
//   coordination    — protective device coordination study; same cadence
//   one_line_review — dated confirmation the one-line reflects the system
// PE provenance (peName/peLicense) is what loss-control auditors ask for.
// supersededById chains revisions; a superseding study must live at the
// SAME site (validated on write).

const STUDY_TYPES = ['arc_flash', 'short_circuit', 'coordination', 'one_line_review'];

// performedDate + 5 years — the NFPA 70E / insurer review clock. Used when
// the caller doesn't supply an explicit expiresAt.
function defaultStudyExpiry(performedDate) {
  const d = new Date(performedDate);
  d.setFullYear(d.getFullYear() + 5);
  return d;
}

// ─── GET /api/sites/:siteId/studies ───────────────────────────────────────────
// All study types for one site, newest performedDate first. The slim
// supersededBy/supersedes includes make the revision chain renderable
// without a second fetch.
router.get('/:siteId/studies', async (req, res) => {
  try {
    const site = await prisma.site.findFirst({
      where:  { id: req.params.siteId, accountId: req.user.accountId },
      select: { id: true },
    });
    if (!site) return res.status(404).json({ success: false, error: 'Site not found' });

    const studies = await prisma.systemStudy.findMany({
      where:   { siteId: site.id, accountId: req.user.accountId },
      orderBy: { performedDate: 'desc' },
      include: {
        supersededBy: { select: { id: true, studyType: true, performedDate: true } },
        supersedes:   { select: { id: true, studyType: true, performedDate: true } },
        // #25: how many assets/buses this study covers (label-data readiness).
        _count:       { select: { coveredAssets: true } },
      },
    });

    res.json({ success: true, data: { studies } });
  } catch (err) {
    console.error('List system studies error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch system studies' });
  }
});

// ─── POST /api/sites/:siteId/studies ──────────────────────────────────────────
// Body: { studyType?, performedDate, expiresAt?, performedBy?, method?,
//         peName?, peLicense?, trigger?, reportPdfUrl?, notes?, supersededById? }
// studyType defaults to 'arc_flash' (schema default); expiresAt defaults to
// performedDate + 5 years when absent.
router.post('/:siteId/studies', requireManager, async (req, res) => {
  try {
    const site = await prisma.site.findFirst({
      where: { id: req.params.siteId, accountId: req.user.accountId },
    });
    if (!site) return res.status(404).json({ success: false, error: 'Site not found' });

    const {
      studyType, performedDate, expiresAt, performedBy, method,
      peName, peLicense, trigger, reportPdfUrl, notes, supersededById,
    } = req.body;

    const type = studyType || 'arc_flash';
    if (!STUDY_TYPES.includes(type)) {
      return res.status(400).json({ success: false, error: `studyType must be one of ${STUDY_TYPES.join(', ')}` });
    }
    if (!performedDate) {
      return res.status(400).json({ success: false, error: 'performedDate is required' });
    }
    const performed = new Date(performedDate);
    if (Number.isNaN(performed.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid performedDate' });
    }
    let expiry;
    if (expiresAt) {
      expiry = new Date(expiresAt);
      if (Number.isNaN(expiry.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid expiresAt' });
      }
    } else {
      expiry = defaultStudyExpiry(performed);
    }

    // The superseded study must exist at THIS site (and this account) —
    // cross-site/cross-tenant chains are meaningless and leak existence.
    if (supersededById) {
      const prior = await prisma.systemStudy.findFirst({
        where:  { id: supersededById, siteId: site.id, accountId: req.user.accountId },
        select: { id: true },
      });
      if (!prior) {
        return res.status(400).json({ success: false, error: 'supersededById must reference a study at this site' });
      }
    }

    const study = await prisma.systemStudy.create({
      data: {
        accountId:      req.user.accountId,
        siteId:         site.id,
        studyType:      type,
        performedDate:  performed,
        expiresAt:      expiry,
        performedBy:    performedBy || null,
        method:         method || null,
        peName:         peName || null,
        peLicense:      peLicense || null,
        trigger:        trigger || null,
        reportPdfUrl:   reportPdfUrl || null,
        notes:          notes || null,
        supersededById: supersededById || null,
      },
    });

    await logActivity(req.user.id, req.user.accountId, 'system_study_recorded', {
      studyType: study.studyType,
      siteId:    site.id,
    });

    res.status(201).json({ success: true, data: { study } });
  } catch (err) {
    console.error('Create system study error:', err);
    res.status(500).json({ success: false, error: 'Failed to create system study' });
  }
});

// ─── PUT /api/sites/studies/:id ───────────────────────────────────────────────
// Partial update, same fields as create. Clearing expiresAt ('' / null)
// recomputes the default 5-year clock from the effective performedDate.
router.put('/studies/:id', requireManager, async (req, res) => {
  try {
    const existing = await prisma.systemStudy.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Study not found' });

    const {
      studyType, performedDate, expiresAt, performedBy, method,
      peName, peLicense, trigger, reportPdfUrl, notes, supersededById,
    } = req.body;

    const updateData: any = {};
    if (studyType !== undefined) {
      if (!STUDY_TYPES.includes(studyType)) {
        return res.status(400).json({ success: false, error: `studyType must be one of ${STUDY_TYPES.join(', ')}` });
      }
      updateData.studyType = studyType;
    }
    if (performedDate !== undefined) {
      if (!performedDate) {
        return res.status(400).json({ success: false, error: 'performedDate cannot be cleared' });
      }
      const performed = new Date(performedDate);
      if (Number.isNaN(performed.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid performedDate' });
      }
      updateData.performedDate = performed;
    }
    if (expiresAt !== undefined) {
      if (expiresAt) {
        const expiry = new Date(expiresAt);
        if (Number.isNaN(expiry.getTime())) {
          return res.status(400).json({ success: false, error: 'Invalid expiresAt' });
        }
        updateData.expiresAt = expiry;
      } else {
        // expiresAt is non-nullable — clearing re-derives the 5-year default.
        updateData.expiresAt = defaultStudyExpiry(updateData.performedDate || existing.performedDate);
      }
    }
    if (performedBy !== undefined)  updateData.performedBy = performedBy || null;
    if (method !== undefined)       updateData.method = method || null;
    if (peName !== undefined)       updateData.peName = peName || null;
    if (peLicense !== undefined)    updateData.peLicense = peLicense || null;
    if (trigger !== undefined)      updateData.trigger = trigger || null;
    if (reportPdfUrl !== undefined) updateData.reportPdfUrl = reportPdfUrl || null;
    if (notes !== undefined)        updateData.notes = notes || null;
    if (supersededById !== undefined) {
      if (supersededById) {
        if (supersededById === existing.id) {
          return res.status(400).json({ success: false, error: 'A study cannot supersede itself' });
        }
        const prior = await prisma.systemStudy.findFirst({
          where:  { id: supersededById, siteId: existing.siteId, accountId: req.user.accountId },
          select: { id: true },
        });
        if (!prior) {
          return res.status(400).json({ success: false, error: 'supersededById must reference a study at this site' });
        }
      }
      updateData.supersededById = supersededById || null;
    }

    const study = await prisma.systemStudy.update({
      where: { id: existing.id },
      data:  updateData,
    });

    // [LEGAL-8-3] Audit every changed study field with before/after. peName /
    // peLicense are rendered as "Study by: …, PE" on the printed NFPA 70E label,
    // and performedDate drives the 5-year expiry / "is this study current" gate —
    // so a back-dated date or a swapped PE name must leave a trace. Routed through
    // ActivityLog so the tamper-evident hash chain commits to the values
    // (LEGAL-8-6). PE-attribution changes are emitted as a distinct, alertable
    // action so a non-engineer attaching a PE's name surfaces loudly.
    const AUDITED_STUDY_FIELDS = ['studyType', 'performedDate', 'expiresAt', 'performedBy', 'method', 'peName', 'peLicense', 'trigger', 'supersededById'];
    const toIso = (v: any) => (v instanceof Date ? v.toISOString() : v);
    const studyChanges: Record<string, { from: any; to: any }> = {};
    for (const f of AUDITED_STUDY_FIELDS) {
      if (updateData[f] === undefined) continue;
      const before = toIso((existing as any)[f]);
      const after  = toIso((study as any)[f]);
      if (before !== after) studyChanges[f] = { from: before, to: after };
    }
    if (Object.keys(studyChanges).length > 0) {
      const peChanged = studyChanges.peName !== undefined || studyChanges.peLicense !== undefined;
      await logActivity(
        req.user.id,
        req.user.accountId,
        peChanged ? 'system_study_pe_attribution_changed' : 'system_study_updated',
        { studyId: existing.id, siteId: existing.siteId, changedBy: req.user.id, changes: studyChanges },
      );
    }

    res.json({ success: true, data: { study } });
  } catch (err) {
    console.error('Update system study error:', err);
    res.status(500).json({ success: false, error: 'Failed to update system study' });
  }
});

// ═══ #25 Arc-flash study asset coverage + incident-energy labels ═══════════════
// A SystemStudy (esp. arc_flash) covers a set of assets/buses. Each binding can
// carry the NFPA 70E §130.5(H) label fields the standard requires posted ON the
// equipment: nominal voltage, arc-flash boundary, incident energy + working
// distance OR PPE category, plus the study date (from the parent study). The
// power-path graph lets one root bus expand coverage to its whole downstream
// tree in one call.

// Coerce a numeric label field; '' / null clears, NaN / negative rejected.
// Returns { ok, value } where value is undefined (skip), null (clear), or Number.
function coerceLabelNum(raw) {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === '') return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

function assetLabel(a) {
  if (!a) return 'Unknown asset';
  return [a.manufacturer, a.model].filter(Boolean).join(' ')
    || a.serialNumber
    || a.equipmentType;
}

// IEEE 1584-2018 electrode configurations (validated on input).
const ELECTRODE_CONFIGS = new Set(['VCB', 'VCBB', 'HCB', 'VOA', 'HOA']);

// Parse a nominal-voltage label string ("480V", "13.8kV", "208") to volts.
function parseVolts(raw) {
  if (!raw) return null;
  const m = String(raw).match(/([\d.]+)\s*(kv|v)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /kv/i.test(m[2] || '') ? n * 1000 : n;
}

// NFPA 70E §130.5(H): the label header is red DANGER when incident energy
// exceeds 40 cal/cm² OR system voltage is over 600V; otherwise orange WARNING.
function hazardClass(incidentEnergyCalCm2, nominalVoltage) {
  const volts = parseVolts(nominalVoltage);
  if ((incidentEnergyCalCm2 != null && incidentEnergyCalCm2 > 40) || (volts != null && volts > 600)) {
    return 'DANGER';
  }
  return 'WARNING';
}

// ─── POST /api/sites/studies/:id/assets ───────────────────────────────────────
// Bind one asset (and optionally its power-path downstream) to a study, with
// per-bus incident-energy label data. Idempotent upsert on (studyId, assetId).
// Body: { assetId, busName?, nominalVoltage?, incidentEnergyCalCm2?,
//         arcFlashBoundaryIn?, workingDistanceIn?, ppeCategory?, includeDownstream? }
router.post('/studies/:id/assets', requireManager, async (req, res) => {
  try {
    const study = await prisma.systemStudy.findFirst({
      where:  { id: req.params.id, accountId: req.user.accountId },
      select: { id: true, accountId: true },
    });
    if (!study) return res.status(404).json({ success: false, error: 'Study not found' });

    const {
      assetId, busName, nominalVoltage,
      incidentEnergyCalCm2, arcFlashBoundaryIn, workingDistanceIn,
      ppeCategory, includeDownstream,
      // IEEE 1584-2018 calculation inputs (optional)
      boltedFaultCurrentKA, arcingCurrentKA, electrodeConfig,
      conductorGapMm, clearingTimeMs, upstreamDevice,
    } = req.body;

    if (!assetId) return res.status(400).json({ success: false, error: 'assetId is required' });

    const rootAsset = await prisma.asset.findFirst({
      where:  { id: assetId, accountId: req.user.accountId },
      select: { id: true },
    });
    if (!rootAsset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const ie = coerceLabelNum(incidentEnergyCalCm2);
    const afb = coerceLabelNum(arcFlashBoundaryIn);
    const wd = coerceLabelNum(workingDistanceIn);
    // IEEE 1584 numeric inputs (same non-negative coercion).
    const bfc = coerceLabelNum(boltedFaultCurrentKA);
    const arc = coerceLabelNum(arcingCurrentKA);
    const gap = coerceLabelNum(conductorGapMm);
    const clr = coerceLabelNum(clearingTimeMs);
    if (!ie.ok || !afb.ok || !wd.ok || !bfc.ok || !arc.ok || !gap.ok || !clr.ok) {
      return res.status(400).json({ success: false, error: 'Numeric label/input fields must be non-negative numbers' });
    }
    let electrode: string | null | undefined;
    if (electrodeConfig === undefined) electrode = undefined;
    else if (electrodeConfig === null || electrodeConfig === '') electrode = null;
    else {
      const e = String(electrodeConfig).toUpperCase();
      if (!ELECTRODE_CONFIGS.has(e)) {
        return res.status(400).json({ success: false, error: 'electrodeConfig must be one of VCB, VCBB, HCB, VOA, HOA' });
      }
      electrode = e;
    }
    let ppe: number | null | undefined;
    if (ppeCategory === undefined) ppe = undefined;
    else if (ppeCategory === null || ppeCategory === '') ppe = null;
    else {
      const p = Number(ppeCategory);
      if (!Number.isInteger(p) || p < 0 || p > 4) {
        return res.status(400).json({ success: false, error: 'ppeCategory must be an integer 0-4' });
      }
      ppe = p;
    }

    // Upsert the ROOT binding with full label data.
    const rootData: any = {
      busName:        busName || null,
      nominalVoltage: nominalVoltage || null,
    };
    if (ie.value !== undefined)  rootData.incidentEnergyCalCm2 = ie.value;
    if (afb.value !== undefined) rootData.arcFlashBoundaryIn = afb.value;
    if (wd.value !== undefined)  rootData.workingDistanceIn = wd.value;
    if (ppe !== undefined)       rootData.ppeCategory = ppe;
    // IEEE 1584 inputs
    if (bfc.value !== undefined)       rootData.boltedFaultCurrentKA = bfc.value;
    if (arc.value !== undefined)       rootData.arcingCurrentKA = arc.value;
    if (gap.value !== undefined)       rootData.conductorGapMm = gap.value;
    if (clr.value !== undefined)       rootData.clearingTimeMs = clr.value;
    if (electrode !== undefined)       rootData.electrodeConfig = electrode;
    if (upstreamDevice !== undefined)  rootData.upstreamDevice = upstreamDevice || null;

    // [LEGAL-8-7] Capture the prior label values for the root binding BEFORE the
    // upsert so the audit records what incident energy / PPE / boundary was
    // replaced (not just that a bind happened).
    const priorRootBinding = await prisma.systemStudyAsset.findUnique({
      where:  { studyId_assetId: { studyId: study.id, assetId: rootAsset.id } },
      select: { incidentEnergyCalCm2: true, arcFlashBoundaryIn: true, workingDistanceIn: true, ppeCategory: true, nominalVoltage: true },
    });

    await prisma.systemStudyAsset.upsert({
      where:  { studyId_assetId: { studyId: study.id, assetId: rootAsset.id } },
      update: rootData,
      create: { ...rootData, accountId: study.accountId, studyId: study.id, assetId: rootAsset.id },
    });

    let downstreamAdded = 0;
    if (includeDownstream) {
      const ids = await resolveDownstreamAssetIds(req.user.accountId, rootAsset.id);
      for (const id of ids) {
        // createMany would skip duplicates but we want per-row safety + count.
        const r = await prisma.systemStudyAsset.upsert({
          where:  { studyId_assetId: { studyId: study.id, assetId: id } },
          update: {}, // leave existing label data untouched
          create: { accountId: study.accountId, studyId: study.id, assetId: id },
        }).then(() => true).catch(() => false);
        if (r) downstreamAdded++;
      }
    }

    const count = await prisma.systemStudyAsset.count({ where: { studyId: study.id } });
    // [LEGAL-8-7] Include the hazard label values set/replaced on the root binding
    // (prior -> new) so the bind log is reconstructable, not just a count. Routed
    // through ActivityLog so the hash chain (LEGAL-8-6) commits to the values.
    const toNum = (v: any) => (v == null ? null : Number(v));
    const labelBefore = priorRootBinding ? {
      incidentEnergyCalCm2: toNum(priorRootBinding.incidentEnergyCalCm2),
      arcFlashBoundaryIn:   toNum(priorRootBinding.arcFlashBoundaryIn),
      workingDistanceIn:    toNum(priorRootBinding.workingDistanceIn),
      ppeCategory:          priorRootBinding.ppeCategory ?? null,
      nominalVoltage:       priorRootBinding.nominalVoltage ?? null,
    } : null;
    const labelAfter = {
      incidentEnergyCalCm2: rootData.incidentEnergyCalCm2 !== undefined ? toNum(rootData.incidentEnergyCalCm2) : (labelBefore?.incidentEnergyCalCm2 ?? null),
      arcFlashBoundaryIn:   rootData.arcFlashBoundaryIn   !== undefined ? toNum(rootData.arcFlashBoundaryIn)   : (labelBefore?.arcFlashBoundaryIn ?? null),
      workingDistanceIn:    rootData.workingDistanceIn    !== undefined ? toNum(rootData.workingDistanceIn)    : (labelBefore?.workingDistanceIn ?? null),
      ppeCategory:          rootData.ppeCategory          !== undefined ? rootData.ppeCategory                 : (labelBefore?.ppeCategory ?? null),
      nominalVoltage:       rootData.nominalVoltage ?? (labelBefore?.nominalVoltage ?? null),
    };
    await logActivity(req.user.id, req.user.accountId, 'arc_flash_study_assets_bound', {
      studyId: study.id, rootAssetId: rootAsset.id, includeDownstream: !!includeDownstream, downstreamAdded,
      changedBy: req.user.id, busName: rootData.busName ?? null, labelBefore, labelAfter,
    });

    res.status(201).json({ success: true, data: { studyId: study.id, rootAssetId: rootAsset.id, downstreamAdded, coveredCount: count } });
  } catch (err) {
    console.error('Bind study assets error:', err);
    res.status(500).json({ success: false, error: 'Failed to bind study assets' });
  }
});

// ─── DELETE /api/sites/studies/:id/assets/:assetId ────────────────────────────
router.delete('/studies/:id/assets/:assetId', requireManager, async (req, res) => {
  try {
    const study = await prisma.systemStudy.findFirst({
      where:  { id: req.params.id, accountId: req.user.accountId },
      select: { id: true },
    });
    if (!study) return res.status(404).json({ success: false, error: 'Study not found' });

    const link = await prisma.systemStudyAsset.findFirst({
      where:  { studyId: study.id, assetId: req.params.assetId },
      select: { id: true, busName: true, nominalVoltage: true, incidentEnergyCalCm2: true, arcFlashBoundaryIn: true, workingDistanceIn: true, ppeCategory: true, requiredArcRatingCalCm2: true },
    });
    if (!link) return res.status(404).json({ success: false, error: 'Asset is not bound to this study' });

    await prisma.systemStudyAsset.delete({ where: { id: link.id } });
    const count = await prisma.systemStudyAsset.count({ where: { studyId: study.id } });

    // [LEGAL-8-7] Deleting a binding erases the recorded incident energy / PPE for
    // that bus. Audit the deletion WITH the values that were removed so there is a
    // trace the hazard record ever existed. Routed through ActivityLog -> hash
    // chain (LEGAL-8-6).
    const toN = (v: any) => (v == null ? null : Number(v));
    await logActivity(req.user.id, req.user.accountId, 'arc_flash_study_asset_unbound', {
      studyId: study.id, assetId: req.params.assetId, deletedBy: req.user.id,
      removedLabel: {
        busName:                 link.busName ?? null,
        nominalVoltage:          link.nominalVoltage ?? null,
        incidentEnergyCalCm2:    toN(link.incidentEnergyCalCm2),
        arcFlashBoundaryIn:      toN(link.arcFlashBoundaryIn),
        workingDistanceIn:       toN(link.workingDistanceIn),
        ppeCategory:             link.ppeCategory ?? null,
        requiredArcRatingCalCm2: toN(link.requiredArcRatingCalCm2),
      },
    });

    res.json({ success: true, data: { studyId: study.id, coveredCount: count } });
  } catch (err) {
    console.error('Unbind study asset error:', err);
    res.status(500).json({ success: false, error: 'Failed to unbind study asset' });
  }
});

// ─── GET /api/sites/studies/:id/label-data ────────────────────────────────────
// NFPA 70E §130.5(H) incident-energy label export: per-bus rows ready to print
// onto equipment labels, plus the study provenance (date, PE, method) every
// label must reference. Any authenticated role may read.
router.get('/studies/:id/label-data', async (req, res) => {
  try {
    const study = await prisma.systemStudy.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      include: {
        site: { select: { id: true, name: true } },
        coveredAssets: {
          orderBy: { createdAt: 'asc' },
          include: {
            asset: { select: { id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true, siteId: true } },
          },
        },
      },
    });
    if (!study) return res.status(404).json({ success: false, error: 'Study not found' });

    const labels = study.coveredAssets.map((c: any) => {
      const ie  = c.incidentEnergyCalCm2 != null ? Number(c.incidentEnergyCalCm2) : null;
      const afb = c.arcFlashBoundaryIn != null ? Number(c.arcFlashBoundaryIn) : null;
      const wd  = c.workingDistanceIn != null ? Number(c.workingDistanceIn) : null;
      // A label is "complete" per §130.5(H) when it carries nominal voltage,
      // arc-flash boundary, and EITHER incident energy + working distance OR a
      // PPE category.
      const hasEnergyMethod = ie != null && wd != null;
      const hasPpeMethod    = c.ppeCategory != null;
      const complete = !!c.nominalVoltage && afb != null && (hasEnergyMethod || hasPpeMethod);
      return {
        assetId:              c.assetId,
        assetLabel:           assetLabel(c.asset),
        equipmentType:        c.asset?.equipmentType ?? null,
        busName:              c.busName,
        nominalVoltage:       c.nominalVoltage,
        incidentEnergyCalCm2: ie,
        arcFlashBoundaryIn:   afb,
        workingDistanceIn:    wd,
        ppeCategory:          c.ppeCategory,
        labelComplete:        complete,
        hazardClass:          hazardClass(ie, c.nominalVoltage),
        // IEEE 1584 inputs (engineering review + trend/what-if)
        boltedFaultCurrentKA: c.boltedFaultCurrentKA != null ? Number(c.boltedFaultCurrentKA) : null,
        arcingCurrentKA:      c.arcingCurrentKA != null ? Number(c.arcingCurrentKA) : null,
        electrodeConfig:      c.electrodeConfig ?? null,
        conductorGapMm:       c.conductorGapMm != null ? Number(c.conductorGapMm) : null,
        clearingTimeMs:       c.clearingTimeMs != null ? Number(c.clearingTimeMs) : null,
        upstreamDevice:       c.upstreamDevice ?? null,
      };
    });

    res.json({
      success: true,
      data: {
        study: {
          id:            study.id,
          studyType:     study.studyType,
          siteId:        study.siteId,
          siteName:      study.site?.name ?? null,
          performedDate: study.performedDate,
          expiresAt:     study.expiresAt,
          peName:        study.peName,
          peLicense:     study.peLicense,
          method:        study.method,
        },
        labels,
        coveredCount:  labels.length,
        completeCount: labels.filter((l) => l.labelComplete).length,
      },
    });
  } catch (err) {
    console.error('Study label-data error:', err);
    res.status(500).json({ success: false, error: 'Failed to build label data' });
  }
});

// ─── GET /api/sites/arc-flash/asset/:assetId/trend ────────────────────────────
// Per-asset incident-energy history across every arc-flash study that has
// covered this asset, oldest→newest. The data-trend moat: shows whether a bus
// is getting more hazardous over study revisions, with DANGER/WARNING class and
// the IEEE 1584 inputs behind each point. Any authenticated role may read.
router.get('/arc-flash/asset/:assetId/trend', async (req, res) => {
  try {
    const asset = await prisma.asset.findFirst({
      where:  { id: req.params.assetId, accountId: req.user.accountId },
      select: { id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true },
    });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const rows = await prisma.systemStudyAsset.findMany({
      where: { assetId: asset.id, accountId: req.user.accountId, study: { studyType: 'arc_flash' } },
      include: {
        study: { select: { id: true, performedDate: true, expiresAt: true, method: true, peName: true, performedBy: true, supersededById: true } },
      },
    });

    const points = rows
      .map((r: any) => {
        const ie = r.incidentEnergyCalCm2 != null ? Number(r.incidentEnergyCalCm2) : null;
        return {
          studyId:              r.study.id,
          performedDate:        r.study.performedDate,
          expiresAt:            r.study.expiresAt,
          isCurrent:            r.study.supersededById == null,
          method:               r.study.method,
          peName:               r.study.peName,
          performedBy:          r.study.performedBy,
          busName:              r.busName,
          nominalVoltage:       r.nominalVoltage,
          incidentEnergyCalCm2: ie,
          arcFlashBoundaryIn:   r.arcFlashBoundaryIn != null ? Number(r.arcFlashBoundaryIn) : null,
          workingDistanceIn:    r.workingDistanceIn != null ? Number(r.workingDistanceIn) : null,
          ppeCategory:          r.ppeCategory,
          hazardClass:          hazardClass(ie, r.nominalVoltage),
          boltedFaultCurrentKA: r.boltedFaultCurrentKA != null ? Number(r.boltedFaultCurrentKA) : null,
          arcingCurrentKA:      r.arcingCurrentKA != null ? Number(r.arcingCurrentKA) : null,
          electrodeConfig:      r.electrodeConfig ?? null,
          clearingTimeMs:       r.clearingTimeMs != null ? Number(r.clearingTimeMs) : null,
        };
      })
      .sort((a: any, b: any) => new Date(a.performedDate).getTime() - new Date(b.performedDate).getTime());

    // Trend delta across the energy-method points (PPE-only points carry no number).
    const energyPts = points.filter((p: any) => p.incidentEnergyCalCm2 != null);
    let trend: any = null;
    if (energyPts.length >= 2) {
      const first = energyPts[0].incidentEnergyCalCm2;
      const last  = energyPts[energyPts.length - 1].incidentEnergyCalCm2;
      trend = {
        first, last,
        deltaCalCm2: Math.round((last - first) * 100) / 100,
        direction:   last > first ? 'increasing' : last < first ? 'decreasing' : 'flat',
        everDanger:  energyPts.some((p: any) => p.incidentEnergyCalCm2 > 40),
      };
    }

    res.json({
      success: true,
      data: {
        asset:  { id: asset.id, label: assetLabel(asset), equipmentType: asset.equipmentType },
        points,
        latest: points.length ? points[points.length - 1] : null,
        trend,
      },
    });
  } catch (err) {
    console.error('Arc flash trend error:', err);
    res.status(500).json({ success: false, error: 'Failed to build arc flash trend' });
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
