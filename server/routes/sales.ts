// ─────────────────────────────────────────────────────────────────────────────
// routes/sales.ts — Sales-manager roll-up (Chunk B-2)
//
// GET /api/sales/rollup — one card per Account Manager (Account.assignedRepId),
// each AM's book of customer accounts sorted worst-compliance-first, plus an
// Unassigned bucket. Read-only; ZERO manual data entry — every number is a
// byproduct SC already captures (compliance %, deficiencies, work orders).
//
// SECURITY: cross-account view → operator staff only (canViewSales). Account
// scope mirrors the fleet dashboard's partnerOrg guard (fail-closed); admin/
// manager are allowed only in DEMO_MODE for sandbox testing. A customer-account
// admin can never load the operator's book once customers have their own logins.
// ─────────────────────────────────────────────────────────────────────────────

const router = require('express').Router();
import prisma from '../lib/prisma';
const { buildComplianceGap } = require('../lib/complianceReport');
const { canViewSales, groupByAm } = require('../lib/salesRollup');

const DEMO = () => process.env.DEMO_MODE === 'true';
// Cap how many accounts we run the (heavier) compliance gap for per request.
const COMPLIANCE_CAP = 200;

// Fail-closed cross-account scope, identical posture to fleetDashboard:
// no partnerOrgId + not super_admin + not demo → block (don't fan out to every
// account on the platform).
function scopeBlocked(req: any, partnerOrgId: string | null | undefined): boolean {
  return !partnerOrgId && req.user.role !== 'super_admin' && !DEMO();
}

router.get('/rollup', async (req: any, res: any) => {
  try {
    if (!canViewSales(req.user, { demoMode: DEMO() })) {
      return res.status(403).json({ success: false, error: 'Sales roll-up is available to operator staff only.' });
    }

    const caller = await prisma.account.findUnique({
      where: { id: req.user.accountId },
      select: { partnerOrgId: true },
    });
    if (scopeBlocked(req, caller?.partnerOrgId)) {
      return res.status(403).json({ success: false, error: 'No operator organization is linked to your account.' });
    }

    const accountWhere: any = { status: 'active' };
    if (caller?.partnerOrgId) accountWhere.partnerOrgId = caller.partnerOrgId;
    // else: demo / super_admin → all active accounts

    const accounts = await prisma.account.findMany({
      where: accountWhere,
      select: { id: true, companyName: true, assignedRepId: true },
      orderBy: { companyName: 'asc' },
    });
    if (accounts.length === 0) {
      return res.json({ success: true, data: { reps: [], unassigned: [], summary: { repCount: 0, accountCount: 0, unassignedCount: 0 } } });
    }
    const accountIds = accounts.map((a: any) => a.id);

    // Reps referenced by these accounts (the AMs).
    const repIds = Array.from(new Set(accounts.map((a: any) => a.assignedRepId).filter(Boolean)));
    const repRows = repIds.length
      ? await prisma.user.findMany({ where: { id: { in: repIds as string[] } }, select: { id: true, name: true, email: true } })
      : [];
    const reps = new Map(repRows.map((r: any) => [r.id, r]));

    // Byproduct counts — one bulk groupBy each (mirrors fleetDashboard).
    const [openDefs, openWos, overdue, assetCounts] = await Promise.all([
      prisma.deficiency.groupBy({ by: ['accountId'], where: { accountId: { in: accountIds }, resolvedAt: null }, _count: { id: true } }),
      prisma.workOrder.groupBy({ by: ['accountId'], where: { accountId: { in: accountIds }, status: { in: ['SCHEDULED', 'IN_PROGRESS'] } }, _count: { id: true } }),
      prisma.maintenanceSchedule.groupBy({ by: ['accountId'], where: { accountId: { in: accountIds }, isActive: true, nextDueDate: { lt: new Date(), not: null }, asset: { archivedAt: null } }, _count: { id: true } }),
      prisma.asset.groupBy({ by: ['accountId'], where: { accountId: { in: accountIds }, archivedAt: null }, _count: { id: true } }),
    ]);
    const defMap = new Map(openDefs.map((r: any) => [r.accountId, r._count.id]));
    const woMap = new Map(openWos.map((r: any) => [r.accountId, r._count.id]));
    const overdueMap = new Map(overdue.map((r: any) => [r.accountId, r._count.id]));
    const assetMap = new Map(assetCounts.map((r: any) => [r.accountId, r._count.id]));
    const counts = new Map<string, any>();
    for (const id of accountIds) {
      counts.set(id, {
        openDeficiencies: defMap.get(id) ?? 0,
        openWorkOrders: woMap.get(id) ?? 0,
        overdueSchedules: overdueMap.get(id) ?? 0,
        assets: assetMap.get(id) ?? 0,
      });
    }

    // Compliance % per account (the spine). buildComplianceGap is heavier, so
    // run it for up to COMPLIANCE_CAP accounts; the rest group with null %.
    const compliance = new Map<string, number | null>();
    const forGap = accounts.slice(0, COMPLIANCE_CAP);
    const gaps = await Promise.all(forGap.map(async (a: any) => {
      try {
        const g = await buildComplianceGap(prisma, a.id, { limit: 1 });
        return [a.id, typeof g.overallRate === 'number' ? g.overallRate : null] as const;
      } catch {
        return [a.id, null] as const;
      }
    }));
    for (const [id, rate] of gaps) compliance.set(id, rate);

    const rollup = groupByAm({ accounts, reps, compliance, counts });
    return res.json({ success: true, data: rollup });
  } catch (err: any) {
    console.error('[sales/rollup]', err);
    return res.status(500).json({ success: false, error: 'Sales roll-up query failed' });
  }
});

module.exports = router;

export {};
