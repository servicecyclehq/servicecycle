// -----------------------------------------------------------------------------
// routes/group.ts -- Phase 4 #9 enterprise-group (HoldCo over OpCos) roll-up.
//
//   GET  /api/group/dashboard         -> per-OpCo summary cards + group totals
//   GET  /api/group/accounts/:id      -> single-OpCo read-only drill-down
//   GET  /api/group/rate-cards        -> group-standard rate cards (master data)
//   PUT  /api/group/rate-cards        -> upsert a group-level rate card
//   DELETE /api/group/rate-cards/:serviceType -> clear a group-level rate card
//
// Auth: group_admin role required (read-only over OpCos; siblings isolated).
// Scope: all accounts sharing the caller's enterpriseGroupId. Fail-closed: a
// null group never falls back to all-accounts in production (only demo /
// super_admin), mirroring fleetDashboard's fleetFallbackBlocked.
// -----------------------------------------------------------------------------

const router = require('express').Router();
import prisma from '../lib/prisma';
const { requireGroupAdmin } = require('../middleware/roles');
const { buildRateResolver, SERVICE_TYPES } = require('../lib/rateResolver');

const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// group_admin on every /api/group/* route.
router.use(requireGroupAdmin);

// Fail-closed: a group_admin whose account has no enterpriseGroupId would
// otherwise roll up EVERY account on the platform. Block in prod; allow the
// all-accounts view only for the demo sandbox or a super_admin.
function groupFallbackBlocked(req: any, groupId: string | null | undefined): boolean {
  return !groupId && req.user.role !== 'super_admin' && process.env.DEMO_MODE !== 'true';
}

async function resolveGroupScope(req: any): Promise<{ groupId: string | null; group: any; blocked: boolean }> {
  const caller = await prisma.account.findUnique({
    where: { id: req.user.accountId },
    select: { enterpriseGroupId: true, enterpriseGroup: { select: { id: true, name: true, logoUrl: true, primaryColor: true } } },
  });
  const groupId = caller?.enterpriseGroupId ?? null;
  return { groupId, group: caller?.enterpriseGroup ?? null, blocked: groupFallbackBlocked(req, groupId) };
}

// -- GET /api/group/dashboard -------------------------------------------------
router.get('/dashboard', async (req: any, res: any) => {
  try {
    const { groupId, group, blocked } = await resolveGroupScope(req);
    if (blocked) return res.status(403).json({ success: false, error: 'No enterprise group linked to your account.' });
    const now = new Date();

    const accountWhere: any = { status: 'active' };
    if (groupId) accountWhere.enterpriseGroupId = groupId; // else demo/super_admin -> all

    const accounts = await prisma.account.findMany({
      where: accountWhere,
      select: { id: true, companyName: true, planTier: true, createdAt: true },
      orderBy: { companyName: 'asc' },
    });
    if (accounts.length === 0) return res.json({ success: true, data: { group, opCos: [], totals: emptyTotals() } });

    const ids = accounts.map((a: any) => a.id);
    const [assetByAcct, overdueByAcct, activeSchedByAcct, immedByAcct, openWoByAcct] = await Promise.all([
      prisma.asset.groupBy({ by: ['accountId'], where: { accountId: { in: ids }, archivedAt: null }, _count: { id: true } }),
      prisma.maintenanceSchedule.groupBy({ by: ['accountId'], where: { accountId: { in: ids }, isActive: true, nextDueDate: { lt: now, not: null }, asset: { archivedAt: null } }, _count: { id: true } }),
      prisma.maintenanceSchedule.groupBy({ by: ['accountId'], where: { accountId: { in: ids }, isActive: true, asset: { archivedAt: null } }, _count: { id: true } }),
      prisma.deficiency.groupBy({ by: ['accountId'], where: { accountId: { in: ids }, severity: 'IMMEDIATE', resolvedAt: null }, _count: { id: true } }),
      prisma.workOrder.groupBy({ by: ['accountId'], where: { accountId: { in: ids }, status: { in: ['SCHEDULED', 'IN_PROGRESS'] } }, _count: { id: true } }),
    ]);
    const m = (rows: any[]) => new Map(rows.map((r: any) => [r.accountId, r._count.id]));
    const assetM = m(assetByAcct), overdueM = m(overdueByAcct), activeM = m(activeSchedByAcct), immedM = m(immedByAcct), openWoM = m(openWoByAcct);

    const opCos = accounts.map((a: any) => {
      const active = activeM.get(a.id) || 0;
      const overdue = overdueM.get(a.id) || 0;
      const compliancePct = active > 0 ? Math.round(((active - overdue) / active) * 100) : null;
      return {
        accountId: a.id, companyName: a.companyName, planTier: a.planTier,
        assetCount: assetM.get(a.id) || 0,
        overdueSchedules: overdue,
        activeSchedules: active,
        openImmediateDeficiencies: immedM.get(a.id) || 0,
        openWorkOrders: openWoM.get(a.id) || 0,
        compliancePct,
      };
    });

    const totals = opCos.reduce((t: any, o: any) => {
      t.opCoCount++; t.assetCount += o.assetCount; t.overdueSchedules += o.overdueSchedules;
      t.activeSchedules += o.activeSchedules; t.openImmediateDeficiencies += o.openImmediateDeficiencies;
      t.openWorkOrders += o.openWorkOrders; return t;
    }, emptyTotals());
    totals.compliancePct = totals.activeSchedules > 0
      ? Math.round(((totals.activeSchedules - totals.overdueSchedules) / totals.activeSchedules) * 100) : null;

    return res.json({ success: true, data: { group, opCos, totals } });
  } catch (err: any) {
    console.error('[group/dashboard] error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

function emptyTotals() {
  return { opCoCount: 0, assetCount: 0, overdueSchedules: 0, activeSchedules: 0, openImmediateDeficiencies: 0, openWorkOrders: 0, compliancePct: null };
}

// -- GET /api/group/accounts/:id (single-OpCo drill-down, read-only) ----------
router.get('/accounts/:id', async (req: any, res: any) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'Invalid account ID' });
    const { groupId, blocked } = await resolveGroupScope(req);
    if (blocked) return res.status(403).json({ success: false, error: 'No enterprise group linked to your account.' });

    // Membership wall: the target OpCo must be in the caller's group (unless
    // demo/super_admin with no group scope).
    const target = await prisma.account.findUnique({ where: { id }, select: { id: true, companyName: true, planTier: true, enterpriseGroupId: true } });
    if (!target) return res.status(404).json({ success: false, error: 'Account not found' });
    if (groupId && target.enterpriseGroupId !== groupId) {
      return res.status(403).json({ success: false, error: 'Account is not in your enterprise group' });
    }

    const now = new Date();
    const [assetCount, activeSchedules, overdue, defBySeverity, recentWo] = await Promise.all([
      prisma.asset.count({ where: { accountId: id, archivedAt: null } }),
      prisma.maintenanceSchedule.count({ where: { accountId: id, isActive: true, asset: { archivedAt: null } } }),
      prisma.maintenanceSchedule.count({ where: { accountId: id, isActive: true, nextDueDate: { lt: now, not: null }, asset: { archivedAt: null } } }),
      prisma.deficiency.groupBy({ by: ['severity'], where: { accountId: id, resolvedAt: null }, _count: { id: true } }),
      prisma.workOrder.findMany({ where: { accountId: id, status: 'COMPLETE' }, select: { id: true, completedDate: true, netaDecal: true, asset: { select: { equipmentType: true, serialNumber: true } } }, orderBy: { completedDate: 'desc' }, take: 10 }),
    ]);
    const deficiencies: any = { IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0 };
    for (const d of defBySeverity) deficiencies[d.severity] = d._count.id;
    const compliancePct = activeSchedules > 0 ? Math.round(((activeSchedules - overdue) / activeSchedules) * 100) : null;

    return res.json({ success: true, data: {
      account: { accountId: target.id, companyName: target.companyName, planTier: target.planTier },
      assetCount, activeSchedules, overdueSchedules: overdue, compliancePct,
      openDeficiencies: deficiencies, recentWorkOrders: recentWo,
    } });
  } catch (err: any) {
    console.error('[group/accounts/:id] error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// -- GET /api/group/rate-cards (group master data, resolved group>platform) ---
router.get('/rate-cards', async (req: any, res: any) => {
  try {
    const { groupId, blocked } = await resolveGroupScope(req);
    if (blocked) return res.status(403).json({ success: false, error: 'No enterprise group linked to your account.' });
    if (!groupId) return res.json({ success: true, data: { rates: [] } });
    // Fake accountId matches no account-scoped rows -> resolver returns group>platform.
    const resolver = await buildRateResolver(prisma, { accountId: `group:${groupId}`, enterpriseGroupId: groupId });
    const rates = resolver.resolvedAll().map((r: any) => ({ serviceType: r.serviceType, minCents: r.minCents, maxCents: r.maxCents, source: r.source }));
    return res.json({ success: true, data: { rates } });
  } catch (err: any) {
    console.error('[group/rate-cards GET] error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// -- PUT /api/group/rate-cards (upsert a group-level standard rate) -----------
router.put('/rate-cards', async (req: any, res: any) => {
  try {
    const { groupId, blocked } = await resolveGroupScope(req);
    if (blocked || !groupId) return res.status(403).json({ success: false, error: 'No enterprise group linked to your account.' });

    const { serviceType, minCents, maxCents, notes } = req.body || {};
    if (!SERVICE_TYPES.includes(serviceType)) return res.status(400).json({ success: false, error: 'Invalid serviceType' });
    const min = Number(minCents), max = Number(maxCents);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 0 || max < min) {
      return res.status(400).json({ success: false, error: 'minCents/maxCents must be non-negative integers with maxCents >= minCents' });
    }

    const existing = await prisma.serviceRateCard.findFirst({ where: { enterpriseGroupId: groupId, serviceType, accountId: null, partnerOrgId: null } });
    const card = existing
      ? await prisma.serviceRateCard.update({ where: { id: existing.id }, data: { minCents: min, maxCents: max, notes: notes ?? null } })
      : await prisma.serviceRateCard.create({ data: { enterpriseGroupId: groupId, serviceType, minCents: min, maxCents: max, notes: notes ?? null } });
    return res.json({ success: true, data: { id: card.id, serviceType: card.serviceType, minCents: card.minCents, maxCents: card.maxCents } });
  } catch (err: any) {
    console.error('[group/rate-cards PUT] error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// -- DELETE /api/group/rate-cards/:serviceType -------------------------------
router.delete('/rate-cards/:serviceType', async (req: any, res: any) => {
  try {
    const { groupId, blocked } = await resolveGroupScope(req);
    if (blocked || !groupId) return res.status(403).json({ success: false, error: 'No enterprise group linked to your account.' });
    const { serviceType } = req.params;
    if (!SERVICE_TYPES.includes(serviceType)) return res.status(400).json({ success: false, error: 'Invalid serviceType' });
    await prisma.serviceRateCard.deleteMany({ where: { enterpriseGroupId: groupId, serviceType, accountId: null, partnerOrgId: null } });
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[group/rate-cards DELETE] error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

export {};
