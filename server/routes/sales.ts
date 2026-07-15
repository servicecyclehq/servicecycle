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
const { canViewSales, groupByAm, selectAccountsToMove } = require('../lib/salesRollup');

const DEMO = () => process.env.DEMO_MODE === 'true';
// Cap how many accounts we run the (heavier) compliance gap for per request.
const COMPLIANCE_CAP = 200;

// Fail-closed cross-account scope, identical posture to fleetDashboard:
// no partnerOrgId + not super_admin + not demo → block (don't fan out to every
// account on the platform).
function scopeBlocked(req: any, partnerOrgId: string | null | undefined): boolean {
  return !partnerOrgId && req.user.role !== 'super_admin' && !DEMO();
}

// [2026-07-08 audit W1-M1 / item 3] Same fail-closed shape as scopeBlocked()
// above, but for group_admin's OWN scope dimension (enterpriseGroupId, not
// partnerOrgId) — mirrors routes/group.ts's groupFallbackBlocked().
function groupScopeBlocked(req: any, enterpriseGroupId: string | null | undefined): boolean {
  return !enterpriseGroupId && req.user.role !== 'super_admin' && !DEMO();
}

// Resolve the caller's account scope once (gate + fail-closed scope filter).
// Returns { ok, status, error, accountWhere } so every sales endpoint shares one
// security posture.
async function resolveScope(req: any): Promise<any> {
  if (!canViewSales(req.user, { demoMode: DEMO() })) {
    return { ok: false, status: 403, error: 'Sales roll-up is available to operator staff only.' };
  }

  // [2026-07-08 audit W1-M1 / item 3] group_admin is an EnterpriseGroup
  // (HoldCo-over-OpCos) role — it must be scoped by enterpriseGroupId, NOT
  // partnerOrgId. Before this fix, group_admin fell through to the
  // partnerOrgId branch below like oem_admin, and since an Account can carry
  // BOTH a partnerOrgId and an enterpriseGroupId, a group_admin whose account
  // happened to have a non-null partnerOrgId could read/reassign reps across
  // every account sharing that partnerOrgId — not just their own group.
  if (req.user.role === 'group_admin') {
    const caller = await prisma.account.findUnique({ where: { id: req.user.accountId }, select: { enterpriseGroupId: true } });
    if (groupScopeBlocked(req, caller?.enterpriseGroupId)) {
      return { ok: false, status: 403, error: 'No enterprise group is linked to your account.' };
    }
    const accountWhere: any = { status: 'active' };
    if (caller?.enterpriseGroupId) accountWhere.enterpriseGroupId = caller.enterpriseGroupId;
    return { ok: true, accountWhere };
  }

  const caller = await prisma.account.findUnique({ where: { id: req.user.accountId }, select: { partnerOrgId: true } });
  if (scopeBlocked(req, caller?.partnerOrgId)) {
    return { ok: false, status: 403, error: 'No operator organization is linked to your account.' };
  }
  const accountWhere: any = { status: 'active' };
  if (caller?.partnerOrgId) accountWhere.partnerOrgId = caller.partnerOrgId;
  return { ok: true, accountWhere };
}

router.get('/rollup', async (req: any, res: any) => {
  try {
    const scope = await resolveScope(req);
    if (!scope.ok) return res.status(scope.status).json({ success: false, error: scope.error });
    const accountWhere = scope.accountWhere;

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

// ── GET /api/sales/reps — assignment candidates (current AMs + operator team) ──
// Valid targets to reassign a book to: users already acting as an AM on an
// in-scope account, plus the caller's own account team (operator staff). Scoped
// + deduped so we never leak a cross-tenant user directory.
router.get('/reps', async (req: any, res: any) => {
  try {
    const scope = await resolveScope(req);
    if (!scope.ok) return res.status(scope.status).json({ success: false, error: scope.error });

    const accounts = await prisma.account.findMany({ where: scope.accountWhere, select: { id: true, assignedRepId: true } });
    const assignedIds = Array.from(new Set(accounts.map((a: any) => a.assignedRepId).filter(Boolean)));

    // Current AMs (referenced by in-scope accounts) + the operator's own team.
    const [assignedReps, teamReps] = await Promise.all([
      assignedIds.length ? prisma.user.findMany({ where: { id: { in: assignedIds as string[] } }, select: { id: true, name: true, email: true } }) : Promise.resolve([]),
      prisma.user.findMany({ where: { accountId: req.user.accountId, isActive: true }, select: { id: true, name: true, email: true } }),
    ]);
    const byId = new Map<string, any>();
    for (const r of [...assignedReps, ...teamReps]) byId.set(r.id, r);

    const bookCount = new Map<string, number>();
    for (const a of accounts) if (a.assignedRepId) bookCount.set(a.assignedRepId, (bookCount.get(a.assignedRepId) || 0) + 1);

    const reps = Array.from(byId.values())
      .map((r: any) => ({ id: r.id, name: r.name || r.email || 'Unnamed', email: r.email || null, accountCount: bookCount.get(r.id) || 0 }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return res.json({ success: true, data: { reps } });
  } catch (err: any) {
    console.error('[sales/reps]', err);
    return res.status(500).json({ success: false, error: 'Failed to list reps' });
  }
});

// ── POST /api/sales/reassign — move a book (or selected accounts) to another AM ─
// Body: { fromRepId (null = Unassigned bucket), toRepId, accountIds?, syncContact? }
// Only in-scope accounts currently owned by fromRepId move; toRepId must be a
// valid candidate (current AM or operator-team user). syncContact: when true,
// copy the new rep's name/email onto the customer-facing serviceRep contact
// (the UI only sets this after asking, so we never silently overwrite).
router.post('/reassign', async (req: any, res: any) => {
  try {
    const scope = await resolveScope(req);
    if (!scope.ok) return res.status(scope.status).json({ success: false, error: scope.error });

    const { fromRepId = null, toRepId, accountIds, syncContact } = req.body || {};
    if (!toRepId || typeof toRepId !== 'string') {
      return res.status(400).json({ success: false, error: 'toRepId is required.' });
    }

    // toRepId must be a legitimate candidate: a current AM in scope, or a user
    // in the caller's operator team. (Mirrors GET /reps eligibility.)
    const inScope = await prisma.account.findMany({ where: scope.accountWhere, select: { id: true, assignedRepId: true } });
    const candidateIds = new Set<string>(inScope.map((a: any) => a.assignedRepId).filter(Boolean) as string[]);
    const teamUser = await prisma.user.findFirst({ where: { id: toRepId, accountId: req.user.accountId, isActive: true }, select: { id: true, name: true, email: true } });
    if (!teamUser && !candidateIds.has(toRepId)) {
      return res.status(400).json({ success: false, error: 'toRepId is not a valid assignment target.' });
    }

    const moveIds = selectAccountsToMove(inScope, fromRepId, accountIds);
    if (moveIds.length === 0) {
      return res.json({ success: true, data: { moved: 0, accountIds: [] } });
    }

    const data: any = { assignedRepId: toRepId };
    if (syncContact === true) {
      const repUser = teamUser || await prisma.user.findUnique({ where: { id: toRepId }, select: { name: true, email: true } });
      if (repUser) {
        if (repUser.name) data.serviceRepName = repUser.name;
        if (repUser.email) data.serviceRepEmail = repUser.email;
      }
    }
    // updateMany is bounded to the eligible, in-scope, currently-owned set.
    await prisma.account.updateMany({ where: { id: { in: moveIds }, ...scope.accountWhere }, data });
    return res.json({ success: true, data: { moved: moveIds.length, accountIds: moveIds, contactSynced: syncContact === true } });
  } catch (err: any) {
    console.error('[sales/reassign]', err);
    return res.status(500).json({ success: false, error: 'Reassignment failed' });
  }
});

// ── GET /api/sales/opportunities ── read-only roll-up of the opportunities the
// SYSTEM identified (QuoteRequests) across the manager's in-scope accounts. This
// is a DATA LAYER, not a CRM: it shows what SC flagged — arc-flash re-studies,
// auto-surfaced service opportunities, and customer-submitted quotes — so the
// manager can talk to reps about qualifying them and entering them in their own
// CRM. No pipeline stages, no manual entry. Same fail-closed scope as /rollup.
router.get('/opportunities', async (req: any, res: any) => {
  try {
    const scope = await resolveScope(req);
    if (!scope.ok) return res.status(scope.status).json({ success: false, error: scope.error });

    const accounts = await prisma.account.findMany({
      where: scope.accountWhere,
      select: { id: true, companyName: true, assignedRepId: true },
    });
    if (accounts.length === 0) {
      return res.json({ success: true, data: { opportunities: [], summary: { total: 0, byTrigger: {}, byStatus: {} } } });
    }
    const accountIds = accounts.map((a: any) => a.id);
    const acctById = new Map(accounts.map((a: any) => [a.id, a]));

    // Resolve the assigned-rep display names (the owning reps).
    const repIds = Array.from(new Set(accounts.map((a: any) => a.assignedRepId).filter(Boolean)));
    const repRows = repIds.length
      ? await prisma.user.findMany({ where: { id: { in: repIds as string[] } }, select: { id: true, name: true, email: true } })
      : [];
    const repById = new Map(repRows.map((r: any) => [r.id, r]));

    // Every opportunity SC is tracking for these accounts. Read-only; capped.
    const quotes = await prisma.quoteRequest.findMany({
      where: { accountId: { in: accountIds } },
      select: {
        id: true, accountId: true, assetId: true, status: true, driver: true, triggerType: true,
        timeline: true, notes: true, createdAt: true,
        asset: {
          select: {
            id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true,
            site: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });

    const opportunities = quotes.map((q: any) => {
      const acct = acctById.get(q.accountId);
      const rep = acct?.assignedRepId ? repById.get(acct.assignedRepId) : null;
      const a = q.asset || {};
      const base = [a.manufacturer, a.model].filter(Boolean).join(' ');
      const assetLabel = (base ? base + (a.serialNumber ? ` #${a.serialNumber}` : '') : (a.equipmentType || 'Asset'));
      return {
        id: q.id,
        createdAt: q.createdAt,
        status: q.status,
        driver: q.driver,
        triggerType: q.triggerType || null, // null = customer-submitted (not system-generated)
        timeline: q.timeline,
        notes: q.notes || null,
        accountId: q.accountId,
        companyName: acct?.companyName || '—',
        repId: acct?.assignedRepId || null,
        repName: rep ? (rep.name || rep.email || 'Unnamed') : null,
        siteId: a.site?.id || null,
        siteName: a.site?.name || null,
        assetId: q.assetId,
        assetLabel: assetLabel.trim() || 'Asset',
      };
    });

    const byTrigger: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const o of opportunities) {
      const t = o.triggerType || 'customer_request';
      byTrigger[t] = (byTrigger[t] || 0) + 1;
      byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    }

    return res.json({ success: true, data: { opportunities, summary: { total: opportunities.length, byTrigger, byStatus } } });
  } catch (err: any) {
    console.error('[sales/opportunities]', err);
    return res.status(500).json({ success: false, error: 'Opportunities query failed' });
  }
});

module.exports = router;

export {};
