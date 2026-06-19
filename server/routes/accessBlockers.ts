/**
 * /api/access-blockers — Missing-access / open-items blocker log (stretch).
 *
 * Assets that couldn't be fully inspected (locked door, outage needed, missing
 * label, access limit) recorded as customer-owned blockers tied to a compliance
 * impact: each blocker on an asset surfaces how many active maintenance
 * schedules on that asset are effectively blocked from being performed/verified.
 *
 * Keeps the contractor blameless and the deal moving — the customer owns the
 * blocker and clears it. Mounted behind authenticateToken; every query filters
 * accountId = req.user.accountId (IDOR). The AccessBlocker model is scalar-only
 * (FKs enforced in SQL), so asset/site/user labels are stitched in here.
 */

const router = require('express').Router();
const { requireManager } = require('../middleware/roles');
const prisma = require('../lib/prisma').default;

const VALID_KINDS = ['LOCKED_DOOR', 'OUTAGE_NEEDED', 'MISSING_LABEL', 'ACCESS_LIMIT', 'OTHER'];
const VALID_STATUS = ['open', 'resolved'];

function assetLabel(a: any): string {
  if (!a) return 'Asset';
  const base = [a.manufacturer, a.model].filter(Boolean).join(' ');
  const serial = a.serialNumber ? ` #${a.serialNumber}` : '';
  return base ? base + serial : (a.equipmentType || 'Asset');
}

// Stitch asset/site/user labels + compliance-impact counts onto a blocker list.
async function decorate(accountId: string, blockers: any[]) {
  const assetIds = [...new Set(blockers.map((b) => b.assetId).filter(Boolean))];
  const siteIds = [...new Set(blockers.map((b) => b.siteId).filter(Boolean))];
  const userIds = [...new Set(blockers.flatMap((b) => [b.createdById, b.resolvedById]).filter(Boolean))];

  const [assets, sites, users, blockedCounts] = await Promise.all([
    assetIds.length ? prisma.asset.findMany({ where: { id: { in: assetIds }, accountId }, select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true, siteId: true } }) : [],
    siteIds.length ? prisma.site.findMany({ where: { id: { in: siteIds }, accountId }, select: { id: true, name: true } }) : [],
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
    // Compliance impact: active schedules on the blocked assets (the work that
    // can't be performed/verified while the blocker stands).
    assetIds.length ? prisma.maintenanceSchedule.groupBy({ by: ['assetId'], where: { accountId, isActive: true, assetId: { in: assetIds } }, _count: { _all: true } }) : [],
  ]);

  const assetMap = new Map<string, any>(assets.map((a: any) => [a.id, a]));
  const siteMap = new Map<string, any>(sites.map((s: any) => [s.id, s.name]));
  const userMap = new Map<string, any>(users.map((u: any) => [u.id, u.name]));
  const blockedMap = new Map<string, number>(blockedCounts.map((r: any) => [r.assetId, r._count._all || 0]));

  return blockers.map((b) => {
    const asset = b.assetId ? assetMap.get(b.assetId) : null;
    return {
      ...b,
      assetLabel: asset ? assetLabel(asset) : null,
      siteName: b.siteId ? (siteMap.get(b.siteId) || null) : (asset ? (siteMap.get(asset.siteId) || null) : null),
      createdByName: b.createdById ? (userMap.get(b.createdById) || null) : null,
      resolvedByName: b.resolvedById ? (userMap.get(b.resolvedById) || null) : null,
      blockedSchedules: b.assetId ? (blockedMap.get(b.assetId) || 0) : 0,
    };
  });
}

// ── GET /api/access-blockers ──────────────────────────────────────────────────
router.get('/', async (req: any, res: any) => {
  try {
    const where: any = { accountId: req.user.accountId };
    if (req.query.status) {
      const status = String(req.query.status);
      if (!VALID_STATUS.includes(status)) return res.status(400).json({ success: false, error: 'invalid status' });
      where.status = status;
    }
    if (req.query.assetId) where.assetId = String(req.query.assetId);
    if (req.query.siteId) where.siteId = String(req.query.siteId);

    const blockers = await prisma.accessBlocker.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 500,
    });
    const decorated = await decorate(req.user.accountId, blockers);
    const openCount = decorated.filter((b: any) => b.status === 'open').length;
    return res.json({ success: true, data: { blockers: decorated, openCount } });
  } catch (err: any) {
    console.error('[accessBlockers GET /]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to list blockers.' });
  }
});

// ── POST /api/access-blockers ─────────────────────────────────────────────────
// Any authenticated user can log a blocker (field staff report them).
router.post('/', async (req: any, res: any) => {
  try {
    const { kind, description, assetId, siteId } = req.body || {};
    if (!VALID_KINDS.includes(kind)) {
      return res.status(400).json({ success: false, error: `kind must be one of ${VALID_KINDS.join(', ')}` });
    }
    // Validate optional asset / site belong to this account.
    let resolvedSiteId: string | null = null;
    if (assetId) {
      const asset = await prisma.asset.findFirst({ where: { id: String(assetId), accountId: req.user.accountId }, select: { id: true, siteId: true } });
      if (!asset) return res.status(404).json({ success: false, error: 'Asset not found.' });
      resolvedSiteId = asset.siteId ?? null;
    }
    if (siteId) {
      const site = await prisma.site.findFirst({ where: { id: String(siteId), accountId: req.user.accountId }, select: { id: true } });
      if (!site) return res.status(404).json({ success: false, error: 'Site not found.' });
      resolvedSiteId = site.id;
    }

    const blocker = await prisma.accessBlocker.create({
      data: {
        accountId: req.user.accountId,
        assetId: assetId ? String(assetId) : null,
        siteId: resolvedSiteId,
        kind,
        description: description ? String(description).slice(0, 2000) : null,
        createdById: req.user.id,
        status: 'open',
      },
    });
    const [decorated] = await decorate(req.user.accountId, [blocker]);
    return res.status(201).json({ success: true, data: decorated });
  } catch (err: any) {
    console.error('[accessBlockers POST /]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to create blocker.' });
  }
});

// ── PATCH /api/access-blockers/:id ────────────────────────────────────────────
// Resolve / reopen / edit description. Any authenticated user.
router.patch('/:id', async (req: any, res: any) => {
  try {
    const existing = await prisma.accessBlocker.findFirst({ where: { id: req.params.id, accountId: req.user.accountId }, select: { id: true, status: true } });
    if (!existing) return res.status(404).json({ success: false, error: 'Blocker not found.' });

    const data: any = {};
    if (req.body?.status !== undefined) {
      const status = String(req.body.status);
      if (!VALID_STATUS.includes(status)) return res.status(400).json({ success: false, error: 'invalid status' });
      data.status = status;
      if (status === 'resolved') { data.resolvedAt = new Date(); data.resolvedById = req.user.id; }
      else { data.resolvedAt = null; data.resolvedById = null; }
    }
    if (req.body?.description !== undefined) data.description = req.body.description ? String(req.body.description).slice(0, 2000) : null;
    if (Object.keys(data).length === 0) return res.status(400).json({ success: false, error: 'No changes provided.' });

    const updated = await prisma.accessBlocker.update({ where: { id: existing.id }, data });
    const [decorated] = await decorate(req.user.accountId, [updated]);
    return res.json({ success: true, data: decorated });
  } catch (err: any) {
    console.error('[accessBlockers PATCH /:id]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to update blocker.' });
  }
});

// ── DELETE /api/access-blockers/:id ───────────────────────────────────────────
router.delete('/:id', requireManager, async (req: any, res: any) => {
  try {
    const existing = await prisma.accessBlocker.findFirst({ where: { id: req.params.id, accountId: req.user.accountId }, select: { id: true } });
    if (!existing) return res.status(404).json({ success: false, error: 'Blocker not found.' });
    await prisma.accessBlocker.delete({ where: { id: existing.id } });
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[accessBlockers DELETE /:id]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to delete blocker.' });
  }
});

module.exports = router;

export {};
