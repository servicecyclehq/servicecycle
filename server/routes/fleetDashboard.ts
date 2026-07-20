// ─────────────────────────────────────────────────────────────────────────────
// routes/fleetDashboard.ts — OEM fleet-level cross-account dashboard
//
// GET /api/fleet/dashboard        → summary card per customer account
// GET /api/fleet/accounts/:id     → single-account drill-down detail
//
// Auth: oem_admin role required.
// Scope: all accounts linked to same partnerOrgId as caller's account.
//        If caller's account has no partnerOrgId → returns all accounts
//        (demo / super-admin fallback).
// ─────────────────────────────────────────────────────────────────────────────

const router = require('express').Router();
import prisma from '../lib/prisma';
const { requireOemAdmin } = require('../middleware/roles');
const { buildComplianceGap } = require('../lib/complianceReport');
const { buildPortfolioRank } = require('../lib/portfolioRank');
const { assetLabel } = require('../lib/assetLabel');
const { validateWebhookUrl, postJsonToValidatedUrl, signPayload } = require('../lib/webhook');

const DAY_MS = 86_400_000;

// ── Role guard ────────────────────────────────────────────────────────────────
// account-forecast is customer-facing (any authenticated user); all other
// /api/fleet/* endpoints require oem_admin role.
// Use canonical requireOemAdmin (with permission_denied logging) from roles.ts,
// carving out the customer-facing /account-forecast route.
router.use((req, res, next) => {
  if (req.path === '/account-forecast') return next();
  return requireOemAdmin(req, res, next);
});

// F5/F6: when an oem_admin's account has no partnerOrgId, the partner filter is
// dropped and the fleet queries would return EVERY account on the platform
// (names, metrics, compliance lists, portfolio rankings, per-asset drill-down).
// partnerOrgId can legitimately become null in prod (super_admin deletes a
// partner org → onDelete:SetNull). Fail closed in production; preserve the
// all-accounts behavior only for the demo sandbox or a super_admin.
function fleetFallbackBlocked(req: any, partnerOrgId: string | null | undefined): boolean {
  return !partnerOrgId && req.user.role !== 'super_admin' && process.env.DEMO_MODE !== 'true';
}

// ── GET /api/fleet/dashboard ──────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const { accountId } = req.user;
    const now = new Date();
    const ago30 = new Date(now.getTime() - 30 * DAY_MS);

    // Resolve which accounts this OEM user can see
    const callerAccount = await prisma.account.findUnique({
      where: { id: accountId },
      select: { partnerOrgId: true, partnerOrg: { select: { id: true, name: true, logoUrl: true, primaryColor: true } } },
    });

    if (fleetFallbackBlocked(req, callerAccount?.partnerOrgId)) {
      return res.status(403).json({ error: 'No partner organization linked to your account.' });
    }
    const accountWhere: any = { status: 'active' };
    if (callerAccount?.partnerOrgId) {
      accountWhere.partnerOrgId = callerAccount.partnerOrgId;
    }
    // else: no partnerOrgId → all accounts (demo / super_admin only)

    const accounts = await prisma.account.findMany({
      where: accountWhere,
      select: {
        id: true,
        companyName: true,
        planTier: true,
        serviceRepName: true,
        serviceRepEmail: true,
        serviceRepPhone: true,
        createdAt: true,
      },
      orderBy: { companyName: 'asc' },
    });

    if (accounts.length === 0) {
      return res.json({ partnerOrg: callerAccount?.partnerOrg ?? null, accounts: [] });
    }

    const accountIds = accounts.map((a) => a.id);

    // ── Bulk aggregate queries (one per metric, not N-per-account) ────────────
    const [
      overdueByAccount,
      immediateByAccount,
      serviceOpsByAccount,
      assetCountByAccount,
      lastWoByAccount,
      openWorkOrdersByAccount,
    ] = await Promise.all([
      // 1. Overdue maintenance schedules per account
      prisma.maintenanceSchedule.groupBy({
        by: ['accountId'],
        where: {
          accountId: { in: accountIds },
          isActive: true,
          nextDueDate: { lt: now, not: null },
          asset: { archivedAt: null },
        },
        _count: { id: true },
      }),

      // 2. Open IMMEDIATE deficiencies per account
      prisma.deficiency.groupBy({
        by: ['accountId'],
        where: {
          accountId: { in: accountIds },
          severity: 'IMMEDIATE',
          resolvedAt: null,
        },
        _count: { id: true },
      }),

      // 3. Service opportunities: IMMEDIATE deficiencies open 30+ days
      //    OR assets at C3 conditionOverride
      //    (Two queries; union in JS)
      Promise.all([
        prisma.deficiency.groupBy({
          by: ['accountId'],
          where: {
            accountId: { in: accountIds },
            severity: 'IMMEDIATE',
            resolvedAt: null,
            createdAt: { lte: ago30 },
          },
          _count: { id: true },
        }),
        prisma.maintenanceSchedule.groupBy({
          by: ['accountId'],
          where: {
            accountId: { in: accountIds },
            isActive: true,
            conditionOverride: 'C3',
            asset: { archivedAt: null },
          },
          _count: { id: true },
        }),
      ]),

      // 4. Asset counts per account
      prisma.asset.groupBy({
        by: ['accountId'],
        where: { accountId: { in: accountIds }, archivedAt: null },
        _count: { id: true },
      }),

      // 5. Last completed work order date per account
      // COMP-8-15: groupBy returns exactly ONE row per account (the max
      // completedDate), so the query is bounded by account count regardless of
      // how many completed work orders an account has -- no per-WO row scan.
      prisma.workOrder.groupBy({
        by: ['accountId'],
        where: {
          accountId: { in: accountIds },
          status: 'COMPLETE',
        },
        _max: { completedDate: true },
      }),

      // 6. Open work orders per account
      prisma.workOrder.groupBy({
        by: ['accountId'],
        where: {
          accountId: { in: accountIds },
          status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
        },
        _count: { id: true },
      }),
    ]);

    // ── Build lookup maps ─────────────────────────────────────────────────────
    const overdueMap = new Map(overdueByAccount.map((r) => [r.accountId, r._count.id]));
    const immediateMap = new Map(immediateByAccount.map((r) => [r.accountId, r._count.id]));
    const assetMap = new Map(assetCountByAccount.map((r) => [r.accountId, r._count.id]));
    const openWoMap = new Map(openWorkOrdersByAccount.map((r) => [r.accountId, r._count.id]));

    // Service opportunities: sum unique escalated-deficiency + C3 accounts
    const [escalatedDefs, c3Schedules] = serviceOpsByAccount as any[];
    const svcOpMap = new Map<string, number>();
    for (const r of escalatedDefs) {
      svcOpMap.set(r.accountId, (svcOpMap.get(r.accountId) ?? 0) + r._count.id);
    }
    for (const r of c3Schedules) {
      svcOpMap.set(r.accountId, (svcOpMap.get(r.accountId) ?? 0) + r._count.id);
    }

    // Last WO date per account (one row per account from the groupBy _max).
    const lastWoMap = new Map<string, Date | null>();
    for (const wo of lastWoByAccount) {
      const last = (wo as any)._max?.completedDate ?? null;
      if (last) lastWoMap.set(wo.accountId, last);
    }

    // ── Assemble response ─────────────────────────────────────────────────────
    const cards = accounts.map((acc) => {
      const overdue = overdueMap.get(acc.id) ?? 0;
      const immediate = immediateMap.get(acc.id) ?? 0;
      const serviceOps = svcOpMap.get(acc.id) ?? 0;
      const assets = assetMap.get(acc.id) ?? 0;
      const openWos = openWoMap.get(acc.id) ?? 0;
      const lastWo = lastWoMap.get(acc.id) ?? null;

      // Risk score: weighted sum for ordering
      const riskScore = overdue * 3 + immediate * 5 + serviceOps * 4;

      return {
        id: acc.id,
        companyName: acc.companyName,
        planTier: acc.planTier,
        serviceRep: acc.serviceRepName
          ? { name: acc.serviceRepName, email: acc.serviceRepEmail, phone: acc.serviceRepPhone }
          : null,
        metrics: {
          assets,
          overdueSchedules: overdue,
          immediateDeficiencies: immediate,
          serviceOpportunities: serviceOps,
          openWorkOrders: openWos,
          lastWorkOrderDate: lastWo,
        },
        riskScore,
        // Convenience flag for UI alert badges
        needsAttention: riskScore > 0,
      };
    });

    // Sort: most risky first
    cards.sort((a, b) => b.riskScore - a.riskScore);

    // Fleet-level totals
    const totals = cards.reduce(
      (acc, c) => {
        acc.assets += c.metrics.assets;
        acc.overdueSchedules += c.metrics.overdueSchedules;
        acc.immediateDeficiencies += c.metrics.immediateDeficiencies;
        acc.serviceOpportunities += c.metrics.serviceOpportunities;
        acc.openWorkOrders += c.metrics.openWorkOrders;
        return acc;
      },
      { assets: 0, overdueSchedules: 0, immediateDeficiencies: 0, serviceOpportunities: 0, openWorkOrders: 0 }
    );

    res.json({
      partnerOrg: callerAccount?.partnerOrg ?? null,
      totals,
      accounts: cards,
    });
  } catch (err: any) {
    console.error('[fleet/dashboard]', err);
    res.status(500).json({ error: 'Fleet dashboard query failed' });
  }
});

// ── GET /api/fleet/path-to-100 — ranked compliance gap across the book ───────
// #23: runs the per-account buildComplianceGap (the honest rate + the exact
// action list) for every customer in the OEM's book and ranks them worst-first.
// For the contractor this is a sales pipeline that IS the customer's compliance
// need. oem_admin only (the customer-vs-channel wall). No dollar estimate yet —
// the gap engine is action-based; cost modeling lives in /forecast.
router.get('/path-to-100', async (req, res) => {
  try {
    const { accountId } = req.user;
    const callerAccount = await prisma.account.findUnique({
      where: { id: accountId },
      select: { partnerOrgId: true, partnerOrg: { select: { id: true, name: true } } },
    });
    if (fleetFallbackBlocked(req, callerAccount?.partnerOrgId)) {
      return res.status(403).json({ error: 'No partner organization linked to your account.' });
    }
    const accountWhere: any = { status: 'active' };
    if (callerAccount?.partnerOrgId) accountWhere.partnerOrgId = callerAccount.partnerOrgId;

    const accounts = await prisma.account.findMany({
      where: accountWhere,
      select: { id: true, companyName: true, serviceRepName: true },
      orderBy: { companyName: 'asc' },
    });
    if (accounts.length === 0) {
      return res.json({ partnerOrg: callerAccount?.partnerOrg ?? null, customers: [] });
    }

    // Per-account gap. limit:3 keeps each payload to its top actions; the
    // summary numbers (rate, total actions, breakdown) are always complete.
    const rows = await Promise.all(accounts.map(async (a: any) => {
      try {
        const gap = await buildComplianceGap(prisma, a.id, { limit: 3 });
        return {
          accountId: a.id,
          companyName: a.companyName,
          serviceRepName: a.serviceRepName || null,
          overallRate: gap.overallRate,
          pointsToFull: gap.pointsToFull,
          totalActions: gap.summary.totalActions,
          overdueCount: gap.summary.overdueCount,
          unbaselinedCount: gap.summary.unbaselinedCount,
          uncoveredCount: gap.summary.uncoveredCount,
          empGapCount: gap.summary.empGapCount,
          fullyCompliant: gap.summary.fullyCompliant,
          topActions: gap.actions.map((x: any) => ({ kind: x.kind, title: x.title })),
        };
      } catch (e: any) {
        console.error('[fleet/path-to-100] gap failed for', a.id, e?.message || e);
        return { accountId: a.id, companyName: a.companyName, error: true, overallRate: null, totalActions: null };
      }
    }));

    // Rank: worst compliance first (most to gain), then most actions.
    rows.sort((x: any, y: any) => {
      const rx = x.overallRate == null ? 999 : x.overallRate;
      const ry = y.overallRate == null ? 999 : y.overallRate;
      if (rx !== ry) return rx - ry;
      return (y.totalActions || 0) - (x.totalActions || 0);
    });

    const totalActions = rows.reduce((n: number, r: any) => n + (r.totalActions || 0), 0);
    return res.json({
      partnerOrg: callerAccount?.partnerOrg ?? null,
      customers: rows,
      summary: { customerCount: rows.length, totalActions },
    });
  } catch (err) {
    console.error('[fleet/path-to-100]', err);
    return res.status(500).json({ error: 'Fleet path-to-100 query failed' });
  }
});

// ── GET /api/fleet/portfolio-rank — B2 contractor-only portfolio ranking ─────
// Ranks every customer account across the contractor's book on five owned
// signals (completion rate, overdue %, avg condition, deficiency-clearance
// velocity, NFPA 70B maturity), as portfolio percentiles + a composite rank, and
// auto-generates each account's rep discussion points.
//
// HARD WALL: oem_admin ONLY (the top-of-file middleware enforces this). The
// ranking is contractor competitive intel and must never reach a customer
// surface — the customer only ever sees their own B1 maturity score.
router.get('/portfolio-rank', async (req, res) => {
  try {
    const { accountId } = req.user;
    const callerAccount = await prisma.account.findUnique({
      where: { id: accountId },
      select: { partnerOrgId: true, partnerOrg: { select: { id: true, name: true } } },
    });
    if (fleetFallbackBlocked(req, callerAccount?.partnerOrgId)) {
      return res.status(403).json({ error: 'No partner organization linked to your account.' });
    }
    const accountWhere: any = { status: 'active' };
    if (callerAccount?.partnerOrgId) accountWhere.partnerOrgId = callerAccount.partnerOrgId;

    const accounts = await prisma.account.findMany({
      where: accountWhere,
      select: { id: true, companyName: true, serviceRepName: true, assignedRepId: true },
      orderBy: { companyName: 'asc' },
    });
    if (accounts.length === 0) {
      return res.json({ partnerOrg: callerAccount?.partnerOrg ?? null, accounts: [] });
    }

    const meta = new Map(accounts.map((a: any) => [a.id, a]));
    const ranked = await buildPortfolioRank(prisma, accounts.map((a: any) => a.id), { meta });

    return res.json({
      partnerOrg: callerAccount?.partnerOrg ?? null,
      accounts: ranked,
      summary: { customerCount: ranked.length },
    });
  } catch (err) {
    console.error('[fleet/portfolio-rank]', err);
    return res.status(500).json({ error: 'Portfolio rank query failed' });
  }
});

// ── GET /api/fleet/accounts/:id — single account drill-down ──────────────────
router.get('/accounts/:id', async (req, res) => {
  try {
    const { id: targetAccountId } = req.params;
    const { accountId } = req.user;
    const now = new Date();
    const ago30 = new Date(now.getTime() - 30 * DAY_MS);

    // Validate caller can see this account
    const callerAccount = await prisma.account.findUnique({
      where: { id: accountId },
      select: { partnerOrgId: true },
    });

    const targetAccount = await prisma.account.findUnique({
      where: { id: targetAccountId },
      select: { id: true, companyName: true, planTier: true, partnerOrgId: true,
                serviceRepName: true, serviceRepEmail: true, serviceRepPhone: true },
    });

    if (!targetAccount) return res.status(404).json({ error: 'Account not found' });

    // F6: a null-partnerOrgId caller would otherwise skip the scope check below
    // and read ANY tenant's per-asset drill-down. Fail closed in production
    // (demo / super_admin keep the cross-account view).
    if (fleetFallbackBlocked(req, callerAccount?.partnerOrgId)) {
      return res.status(404).json({ error: 'Account not found' });
    }
    // Enforce same partnerOrg scope. Fail closed: a null partnerOrgId on the
    // caller is NOT a pass — it means the account has no OEM affiliation and
    // should not be able to drill into any tenant. (super_admin + DEMO_MODE
    // are exempted by fleetFallbackBlocked above.)
    if (!callerAccount?.partnerOrgId || targetAccount.partnerOrgId !== callerAccount.partnerOrgId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const [overdueSchedules, immediateDeficiencies, serviceOps, recentWorkOrders, topAssets] =
      await Promise.all([
        // Overdue schedules (top 10 most overdue)
        prisma.maintenanceSchedule.findMany({
          where: { accountId: targetAccountId, isActive: true, nextDueDate: { lt: now, not: null }, asset: { archivedAt: null } },
          select: {
            id: true, nextDueDate: true, conditionOverride: true,
            asset: { select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true } },
            taskDefinition: { select: { taskCode: true, taskName: true } },
          },
          orderBy: { nextDueDate: 'asc' },
          take: 10,
        }),

        // Open IMMEDIATE deficiencies
        prisma.deficiency.findMany({
          where: { accountId: targetAccountId, severity: 'IMMEDIATE', resolvedAt: null },
          select: {
            id: true, description: true, createdAt: true, correctiveAction: true,
            asset: { select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true } },
          },
          orderBy: { createdAt: 'asc' },
          take: 20,
        }),

        // Service opportunities (escalated IMMEDIATE 30d+)
        prisma.deficiency.findMany({
          where: { accountId: targetAccountId, severity: 'IMMEDIATE', resolvedAt: null, createdAt: { lte: ago30 } },
          select: {
            id: true, description: true, createdAt: true,
            asset: { select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true } },
          },
          take: 20,
        }),

        // Recent completed work orders
        prisma.workOrder.findMany({
          where: { accountId: targetAccountId, status: 'COMPLETE' },
          select: {
            id: true, title: true, completedDate: true, asLeftCondition: true,
            asset: { select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true } },
          },
          orderBy: { completedDate: 'desc' },
          take: 5,
        }),

        // Top assets by open issues
        prisma.asset.findMany({
          where: { accountId: targetAccountId, archivedAt: null },
          select: {
            id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true, criticalityScore: true,
            _count: { select: { deficiencies: { where: { resolvedAt: null } } } },
          },
          take: 10,
        }),
      ]);

    const withAssetName = (rows: any[]) =>
      rows.map((r: any) => (r && r.asset ? { ...r, asset: { ...r.asset, name: assetLabel(r.asset, r.asset.id) } } : r));

    res.json({
      account: targetAccount,
      overdueSchedules: withAssetName(overdueSchedules),
      immediateDeficiencies: withAssetName(immediateDeficiencies),
      serviceOpportunities: withAssetName(serviceOps),
      recentWorkOrders: withAssetName(recentWorkOrders),
      topAssets: topAssets.sort((a: any, b: any) => b._count.deficiencies - a._count.deficiencies).map((a: any) => ({ ...a, name: assetLabel(a, a.id) })),
    });
  } catch (err: any) {
    console.error('[fleet/accounts/:id]', err);
    res.status(500).json({ error: 'Account detail query failed' });
  }
});

// ── GET /api/fleet/forecast ────────────────────────────────────────────────────
// Fleet Modernization Forecast (Task 24).
// Per-account CapEx exposure by year — rolling 3 years — based on assets with
// modernizationRiskScore >= 0.50 joined against the platform-default rate card.
// Read-only aggregation. No pipeline/win-loss tracking (CRM territory).
//
// Response: { partnerOrg, forecast: [{ year, accounts: [{ accountId, companyName, minCents, maxCents, assetCount }] }] }
router.get('/forecast', async (req, res) => {
  try {
    const { accountId } = req.user;
    const now = new Date();
    const callerAccount = await prisma.account.findUnique({
      where: { id: accountId },
      select: { partnerOrgId: true },
    });

    if (fleetFallbackBlocked(req, callerAccount?.partnerOrgId)) {
      return res.status(403).json({ error: 'No partner organization linked to your account.' });
    }
    const accountWhere: any = { status: 'active' };
    if (callerAccount?.partnerOrgId) {
      accountWhere.partnerOrgId = callerAccount.partnerOrgId;
    }

    const accounts = await prisma.account.findMany({
      where: accountWhere,
      select: { id: true, companyName: true },
      orderBy: { companyName: 'asc' },
    });

    const accountIds = accounts.map((a) => a.id);

    // Load global rate card (no partnerOrgId, no accountId)
    const rateCards = await prisma.serviceRateCard.findMany({
      where: { partnerOrgId: null, accountId: null },
    });
    const rateMap = new Map<string, { minCents: number; maxCents: number }>();
    for (const r of rateCards) rateMap.set(r.serviceType, r);

    // Map EquipmentType → service type for rate lookup
    const equipToService: Record<string, string> = {
      TRANSFORMER_LIQUID: 'TRANSFORMER_REPLACEMENT',
      TRANSFORMER_DRY:    'TRANSFORMER_REPLACEMENT',
      SWITCHGEAR:         'SWITCHGEAR_MODERNIZATION',
      SWITCHBOARD:        'SWITCHGEAR_MODERNIZATION',
      CIRCUIT_BREAKER:    'BREAKER_RETROFIT',
      PROTECTION_RELAY:   'RELAY_UPGRADE',
      MCC:                'SWITCHGEAR_MODERNIZATION',
      UPS_BATTERY:        'INSPECTION',
      BATTERY_SYSTEM:     'INSPECTION',
      TRANSFER_SWITCH:    'INSPECTION',
    };

    // Load at-risk assets across all accounts
    const atRiskAssets = await prisma.asset.findMany({
      where: {
        accountId:              { in: accountIds },
        archivedAt:             null,
        installDate:            { not: null },
        modernizationRiskScore: { gte: 0.50 },
      },
      select: {
        id: true, accountId: true, equipmentType: true,
        installDate: true, modernizationRiskScore: true,
        endOfSupport: true,
      },
      take: 10000,
    });

    // Bucket each asset into year 1, 2, or 3 based on risk score
    // Score 0.85+ → year 1; 0.70–0.84 → year 2; 0.50–0.69 → year 3
    // (watch-list tier — surface but don't alert customer directly)
    const years = [now.getFullYear(), now.getFullYear() + 1, now.getFullYear() + 2];

    function scoreToYear(score: number): number {
      if (score >= 0.85) return years[0];
      if (score >= 0.70) return years[1];
      return years[2];
    }

    // Aggregate per account per year
    type YearBucket = { minCents: number; maxCents: number; assetCount: number };
    const byAccountYear = new Map<string, Map<number, YearBucket>>();

    for (const asset of atRiskAssets) {
      const score       = asset.modernizationRiskScore ?? 0;
      const targetYear  = scoreToYear(score);
      const svcType     = equipToService[asset.equipmentType] ?? 'INSPECTION';
      const rate        = rateMap.get(svcType);
      if (!rate) continue;

      if (!byAccountYear.has(asset.accountId)) byAccountYear.set(asset.accountId, new Map());
      const yearMap = byAccountYear.get(asset.accountId)!;
      if (!yearMap.has(targetYear)) yearMap.set(targetYear, { minCents: 0, maxCents: 0, assetCount: 0 });
      const bucket = yearMap.get(targetYear)!;
      bucket.minCents   += rate.minCents;
      bucket.maxCents   += rate.maxCents;
      bucket.assetCount += 1;
    }

    // Shape response
    const forecast = years.map((year) => ({
      year,
      accounts: accounts
        .map((acct) => {
          const bucket = byAccountYear.get(acct.id)?.get(year);
          return {
            accountId:   acct.id,
            companyName: acct.companyName,
            minCents:    bucket?.minCents    ?? 0,
            maxCents:    bucket?.maxCents    ?? 0,
            assetCount:  bucket?.assetCount  ?? 0,
          };
        })
        .filter((r) => r.assetCount > 0),
    }));

    res.json({ forecast });
  } catch (err: any) {
    console.error('[fleet/forecast]', err);
    res.status(500).json({ error: 'Forecast query failed' });
  }
});

// ── GET /api/fleet/account-forecast ───────────────────────────────────────────
// Customer-facing CapEx forecast for the account dashboard (Task 24).
// Auth: any authenticated user — shows THEIR account only.
// Returns: { forecast: [{ year, minCents, maxCents, assetCount }] }
router.get('/account-forecast', async (req, res) => {
  // Override the oem_admin-only guard for this endpoint
  (router as any).accountForecast = true; // flag so middleware can pass
  try {
    const { accountId } = req.user;
    const now = new Date();
    const years = [now.getFullYear(), now.getFullYear() + 1, now.getFullYear() + 2];

    const rateCards = await prisma.serviceRateCard.findMany({
      where: { partnerOrgId: null, accountId: null },
    });
    const rateMap = new Map<string, { minCents: number; maxCents: number }>();
    for (const r of rateCards) rateMap.set(r.serviceType, r);

    const equipToService: Record<string, string> = {
      TRANSFORMER_LIQUID: 'TRANSFORMER_REPLACEMENT',
      TRANSFORMER_DRY:    'TRANSFORMER_REPLACEMENT',
      SWITCHGEAR:         'SWITCHGEAR_MODERNIZATION',
      SWITCHBOARD:        'SWITCHGEAR_MODERNIZATION',
      CIRCUIT_BREAKER:    'BREAKER_RETROFIT',
      PROTECTION_RELAY:   'RELAY_UPGRADE',
      MCC:                'SWITCHGEAR_MODERNIZATION',
      UPS_BATTERY:        'INSPECTION',
      BATTERY_SYSTEM:     'INSPECTION',
      TRANSFER_SWITCH:    'INSPECTION',
    };

    const atRiskAssets = await prisma.asset.findMany({
      where: {
        accountId,
        archivedAt:             null,
        // CFO-8-2: the OEM /api/fleet/forecast filters installDate: { not: null }.
        // This customer-facing forecast omitted it, so the same account showed a
        // LARGER CapEx total here than the contractor saw in the fleet view
        // (assets with a null install date but a risk score were priced here and
        // not there). Apply the identical filter so both forecasts reconcile.
        installDate:            { not: null },
        modernizationRiskScore: { gte: 0.50 },
      },
      select: { equipmentType: true, modernizationRiskScore: true },
      take: 5000,
    });

    function scoreToYear(score: number): number {
      if (score >= 0.85) return years[0];
      if (score >= 0.70) return years[1];
      return years[2];
    }

    const buckets = new Map<number, { minCents: number; maxCents: number; assetCount: number }>();
    for (const y of years) buckets.set(y, { minCents: 0, maxCents: 0, assetCount: 0 });

    for (const asset of atRiskAssets) {
      const score      = asset.modernizationRiskScore ?? 0;
      const targetYear = scoreToYear(score);
      const svcType    = equipToService[asset.equipmentType] ?? 'INSPECTION';
      const rate       = rateMap.get(svcType);
      if (!rate) continue;
      const bucket = buckets.get(targetYear)!;
      bucket.minCents   += rate.minCents;
      bucket.maxCents   += rate.maxCents;
      bucket.assetCount += 1;
    }

    const forecast = years.map((y) => ({ year: y, ...buckets.get(y)! }));
    res.json({ forecast });
  } catch (err: any) {
    console.error('[fleet/account-forecast]', err);
    res.status(500).json({ error: 'Forecast query failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PARTNER FLYWHEEL ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
const { sendEmail } = require('../lib/email');

// ── Helper: resolve caller's partnerOrgId (required for all flywheel routes) ──
async function getCallerPartnerOrgId(accountId: string): Promise<string | null> {
  const acct = await prisma.account.findUnique({
    where: { id: accountId },
    select: { partnerOrgId: true },
  });
  return acct?.partnerOrgId ?? null;
}

// ─── Invite routes ─────────────────────────────────────────────────────────────

// POST /api/fleet/invites
router.post('/invites', async (req: any, res: any) => {
  try {
    const partnerOrgId = await getCallerPartnerOrgId(req.user.accountId);
    if (!partnerOrgId) return res.status(400).json({ error: 'No partner org linked to your account' });

    const { email } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const invite = await prisma.partnerInvite.create({
      data: {
        partnerOrgId,
        inviteeEmail: email.toLowerCase().trim(),
        invitedById:  req.user.id,
        tokenHash,
        expiresAt,
      },
      include: { partnerOrg: { select: { name: true, logoUrl: true } } },
    });

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const acceptUrl = `${clientUrl}/invite/accept?token=${rawToken}`;
    const orgName = invite.partnerOrg.name;
    // Semgrep raw-html-format (2026-07-08): partnerOrg.name is user-editable
    // (any user who can create/edit a partner org profile controls it) and
    // was being interpolated straight into HTML sent to the INVITEE's inbox
    // -- unlike the sibling esc() pattern already used in disasterEvents.ts
    // and proposals.ts, this handler had no escaping at all. HTML-inject a
    // fake button/link here and you have a phishing vector wearing a
    // legitimate ServiceCycle "from" address.
    const esc = (v: any) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeOrgName = esc(orgName);

    await sendEmail({
      to: email,
      subject: `${orgName} has invited you to connect on ServiceCycle`,
      html: `
        <h2>You've been invited to connect</h2>
        <p><strong>${safeOrgName}</strong> manages your electrical compliance program and has invited you to link your facility account.</p>
        <p>Accepting gives <strong>${safeOrgName}</strong> visibility into your maintenance activity so they can support you proactively.</p>
        <p>This invitation expires in 7 days.</p>
        <p><a href="${acceptUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:bold;">Accept Invitation</a></p>
        <p style="color:#888;font-size:12px;">Or copy this link: ${acceptUrl}</p>
      `,
    });

    res.status(201).json({
      id: invite.id,
      email: invite.inviteeEmail,
      expiresAt: invite.expiresAt,
      status: 'PENDING',
    });
  } catch (err: any) {
    console.error('[fleet/invites POST]', err);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// GET /api/fleet/invites
router.get('/invites', async (req: any, res: any) => {
  try {
    const partnerOrgId = await getCallerPartnerOrgId(req.user.accountId);
    if (!partnerOrgId) return res.status(400).json({ error: 'No partner org' });

    const invites = await prisma.partnerInvite.findMany({
      where: { partnerOrgId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, inviteeEmail: true, expiresAt: true,
        acceptedAt: true, revokedAt: true, createdAt: true,
        account: { select: { id: true, companyName: true } },
      },
    });

    const now = new Date();
    const withStatus = invites.map((i: any) => ({
      ...i,
      status: i.revokedAt ? 'REVOKED'
        : i.acceptedAt ? 'ACCEPTED'
        : i.expiresAt < now ? 'EXPIRED'
        : 'PENDING',
    }));

    res.json({ invites: withStatus });
  } catch (err: any) {
    console.error('[fleet/invites GET]', err);
    res.status(500).json({ error: 'Failed to list invites' });
  }
});

// DELETE /api/fleet/invites/:id  (revoke)
router.delete('/invites/:id', async (req: any, res: any) => {
  try {
    const partnerOrgId = await getCallerPartnerOrgId(req.user.accountId);
    if (!partnerOrgId) return res.status(400).json({ error: 'No partner org' });

    const invite = await prisma.partnerInvite.findFirst({
      where: { id: req.params.id, partnerOrgId },
    });
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    if (invite.revokedAt) return res.status(409).json({ error: 'Already revoked' });

    // Atomic claim (same guarded-updateMany pattern as workOrders.ts /approve
    // and deficiencies.ts /resolve, 2026-07-12 race-siblings sweep): the where
    // clause re-checks revokedAt===null at write time, not just at the
    // findFirst read above. A losing concurrent revoke gets count 0 -> 409
    // instead of silently re-revoking a second time.
    const claim = await prisma.partnerInvite.updateMany({
      where: { id: invite.id, partnerOrgId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claim.count === 0) {
      return res.status(409).json({ error: 'Invite was already revoked by another request.' });
    }
    res.json({ success: true });
  } catch (err: any) {
    console.error('[fleet/invites DELETE]', err);
    res.status(500).json({ error: 'Failed to revoke invite' });
  }
});

// POST /api/fleet/invites/:id/resend
router.post('/invites/:id/resend', async (req: any, res: any) => {
  try {
    const partnerOrgId = await getCallerPartnerOrgId(req.user.accountId);
    if (!partnerOrgId) return res.status(400).json({ error: 'No partner org' });

    const invite = await prisma.partnerInvite.findFirst({
      where: { id: req.params.id, partnerOrgId },
      include: { partnerOrg: { select: { name: true } } },
    });
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    if (invite.acceptedAt) return res.status(409).json({ error: 'Already accepted' });

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.partnerInvite.update({
      where: { id: invite.id },
      data: { tokenHash, expiresAt, revokedAt: null },
    });

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const acceptUrl = `${clientUrl}/invite/accept?token=${rawToken}`;
    const orgName = invite.partnerOrg.name;
    // Same fix as the POST /invites handler above -- see that comment.
    const esc = (v: any) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeOrgName = esc(orgName);

    await sendEmail({
      to: invite.inviteeEmail,
      subject: `${orgName} has invited you to connect on ServiceCycle`,
      html: `
        <h2>You've been invited to connect (resent)</h2>
        <p><strong>${safeOrgName}</strong> has re-sent your invitation to link your facility account on ServiceCycle.</p>
        <p>This invitation expires in 7 days.</p>
        <p><a href="${acceptUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:bold;">Accept Invitation</a></p>
        <p style="color:#888;font-size:12px;">Or copy this link: ${acceptUrl}</p>
      `,
    });

    res.json({ success: true, expiresAt });
  } catch (err: any) {
    console.error('[fleet/invites/:id/resend]', err);
    res.status(500).json({ error: 'Failed to resend invite' });
  }
});

// POST /api/fleet/accounts/:accountId/link
// Re-affirm a link for an account that has CONSENTED via an accepted invite.
// Consent-first: there is no longer a no-invite "absorb any unlinked account"
// path — a contractor can only connect a customer who accepted an invitation.
router.post('/accounts/:accountId/link', async (req: any, res: any) => {
  try {
    const partnerOrgId = await getCallerPartnerOrgId(req.user.accountId);
    if (!partnerOrgId) return res.status(400).json({ error: 'No partner org' });

    const { accountId } = req.params;
    const target = await prisma.account.findUnique({ where: { id: accountId }, select: { id: true, partnerOrgId: true } });
    if (!target) return res.status(404).json({ error: 'Account not found' });
    // SECURITY: never let one partner org claim an account already linked to a
    // DIFFERENT partner org (that would pull another contractor's customer — and
    // all their asset/deficiency data — into this fleet).
    if (target.partnerOrgId && target.partnerOrgId !== partnerOrgId) {
      return res.status(409).json({ error: 'Account is already linked to another partner organization.' });
    }

    // CONSENT GATE: require an accepted (non-revoked) invitation from this org
    // for this account. Removes the silent no-consent absorption of an unlinked
    // account — connecting a customer requires their explicit acceptance.
    const acceptedInvite = await prisma.partnerInvite.findFirst({
      where: { partnerOrgId, accountId: target.id, acceptedAt: { not: null }, revokedAt: null },
      select: { id: true },
    });
    if (!acceptedInvite) {
      return res.status(403).json({ error: 'This account has not accepted an invitation from your organization. Send an invite for them to accept.' });
    }

    await prisma.account.update({
      where: { id: accountId },
      data: { partnerOrgId },
    });
    res.json({ success: true });
  } catch (err: any) {
    console.error('[fleet/accounts/:id/link]', err);
    res.status(500).json({ error: 'Failed to link account' });
  }
});

// ─── Rep assignment ───────────────────────────────────────────────────────────

// GET /api/fleet/reps
router.get('/reps', async (req: any, res: any) => {
  try {
    const partnerOrgId = await getCallerPartnerOrgId(req.user.accountId);
    if (!partnerOrgId) return res.status(400).json({ error: 'No partner org' });

    const reps = await prisma.user.findMany({
      where: {
        role: 'oem_admin',
        isActive: true,
        account: { partnerOrgId },
      },
      select: { id: true, name: true, email: true, accountId: true },
      orderBy: { name: 'asc' },
    });
    res.json({ reps });
  } catch (err: any) {
    console.error('[fleet/reps]', err);
    res.status(500).json({ error: 'Failed to list reps' });
  }
});

// PATCH /api/fleet/accounts/:accountId/assign-rep
router.patch('/accounts/:accountId/assign-rep', async (req: any, res: any) => {
  try {
    const partnerOrgId = await getCallerPartnerOrgId(req.user.accountId);
    if (!partnerOrgId) return res.status(400).json({ error: 'No partner org' });

    const { accountId } = req.params;
    const { repId, fallbackRepId } = req.body;

    // SECURITY: the target account must belong to the caller's partner org —
    // otherwise an oem_admin could reassign reps (and notification routing) on
    // another partner's / any account.
    const targetAccount = await prisma.account.findFirst({ where: { id: accountId, partnerOrgId }, select: { id: true } });
    if (!targetAccount) return res.status(404).json({ error: 'Account not found in your partner organization.' });

    // Validate users are oem_admin in the same partner org
    async function validateRep(id: string | null) {
      if (!id) return true;
      const u = await prisma.user.findFirst({
        where: { id, role: 'oem_admin', account: { partnerOrgId } },
      });
      return !!u;
    }

    if (!(await validateRep(repId ?? null))) {
      return res.status(400).json({ error: 'repId is not an oem_admin in your partner org' });
    }
    if (!(await validateRep(fallbackRepId ?? null))) {
      return res.status(400).json({ error: 'fallbackRepId is not an oem_admin in your partner org' });
    }

    const account = await prisma.account.update({
      where: { id: accountId },
      data: {
        assignedRepId:  repId  ?? null,
        fallbackRepId: fallbackRepId ?? null,
      },
      select: { id: true, companyName: true, assignedRepId: true, fallbackRepId: true },
    });
    res.json({ account });
  } catch (err: any) {
    console.error('[fleet/accounts/:id/assign-rep]', err);
    res.status(500).json({ error: 'Failed to assign rep' });
  }
});

// ─── Partner inbox ────────────────────────────────────────────────────────────

// GET /api/fleet/inbox
router.get('/inbox', async (req: any, res: any) => {
  try {
    const partnerOrgId = await getCallerPartnerOrgId(req.user.accountId);
    if (!partnerOrgId) return res.status(400).json({ error: 'No partner org' });

    const { repId, eventType, accountId: filterAccountId, unseenOnly, limit = '50', cursor } = req.query;
    const take = Math.min(parseInt(String(limit), 10) || 50, 200);

    const where: any = {
      partnerOrgId,
      archived: false,
    };
    if (repId) where.assignedRepId = String(repId);
    if (eventType) where.eventType = String(eventType);
    if (filterAccountId) where.accountId = String(filterAccountId);
    if (unseenOnly === 'true') where.seenAt = null;
    if (cursor) where.id = { lt: String(cursor) };

    const logs = await prisma.partnerEventLog.findMany({
      where,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        account: { select: { id: true, companyName: true } },
        assignedRep: { select: { id: true, name: true, email: true } },
      },
    });

    const unseenCount = await prisma.partnerEventLog.count({
      where: { partnerOrgId, archived: false, seenAt: null },
    });

    res.json({
      logs,
      nextCursor: logs.length === take ? logs[logs.length - 1].id : null,
      unseenCount,
    });
  } catch (err: any) {
    console.error('[fleet/inbox GET]', err);
    res.status(500).json({ error: 'Failed to load inbox' });
  }
});

// PATCH /api/fleet/inbox/:id/seen
router.patch('/inbox/:id/seen', async (req: any, res: any) => {
  try {
    const partnerOrgId = await getCallerPartnerOrgId(req.user.accountId);
    if (!partnerOrgId) return res.status(400).json({ error: 'No partner org' });
    const log = await prisma.partnerEventLog.findFirst({
      where: { id: req.params.id, partnerOrgId },
    });
    if (!log) return res.status(404).json({ error: 'Log entry not found' });
    await prisma.partnerEventLog.update({ where: { id: log.id }, data: { seenAt: new Date() } });
    res.json({ success: true });
  } catch (err: any) {
    console.error('[fleet/inbox/:id/seen]', err);
    res.status(500).json({ error: 'Failed to mark seen' });
  }
});

// PATCH /api/fleet/inbox/:id/actioned
router.patch('/inbox/:id/actioned', async (req: any, res: any) => {
  try {
    const partnerOrgId = await getCallerPartnerOrgId(req.user.accountId);
    if (!partnerOrgId) return res.status(400).json({ error: 'No partner org' });
    const log = await prisma.partnerEventLog.findFirst({
      where: { id: req.params.id, partnerOrgId },
    });
    if (!log) return res.status(404).json({ error: 'Log entry not found' });
    await prisma.partnerEventLog.update({ where: { id: log.id }, data: { actionedAt: new Date() } });
    res.json({ success: true });
  } catch (err: any) {
    console.error('[fleet/inbox/:id/actioned]', err);
    res.status(500).json({ error: 'Failed to mark actioned' });
  }
});

// ─── Partner settings ─────────────────────────────────────────────────────────

// GET /api/fleet/settings
router.get('/settings', async (req: any, res: any) => {
  try {
    const partnerOrgId = await getCallerPartnerOrgId(req.user.accountId);
    if (!partnerOrgId) return res.status(400).json({ error: 'No partner org' });

    const org = await prisma.partnerOrganization.findUnique({
      where: { id: partnerOrgId },
      select: {
        id: true, name: true, logoUrl: true, website: true,
        webhookUrl: true, // secret never returned
        digestIntervalDays: true,
      },
    });
    res.json({ settings: org });
  } catch (err: any) {
    console.error('[fleet/settings GET]', err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// PATCH /api/fleet/settings
router.patch('/settings', async (req: any, res: any) => {
  try {
    const partnerOrgId = await getCallerPartnerOrgId(req.user.accountId);
    if (!partnerOrgId) return res.status(400).json({ error: 'No partner org' });

    const { webhookUrl, digestIntervalDays } = req.body;
    const data: any = {};
    let newSecret: string | null = null;

    if (webhookUrl !== undefined) {
      if (webhookUrl) {
        // PEN-1: full SSRF validation — blocks private IPs, metadata endpoints,
        // credentials in URL, non-HTTPS, and cloud-metadata hostnames.
        const check = await validateWebhookUrl(webhookUrl);
        if (!check.valid) {
          return res.status(400).json({ error: check.reason ?? 'Invalid webhook URL' });
        }
        // Rotate secret whenever webhookUrl is set or changed
        newSecret = crypto.randomBytes(32).toString('hex');
        data.webhookSecret = newSecret;
      }
      data.webhookUrl = webhookUrl || null;
    }
    if (digestIntervalDays !== undefined) {
      const d = parseInt(String(digestIntervalDays), 10);
      if (!Number.isFinite(d) || d < 1 || d > 7) {
        return res.status(400).json({ error: 'digestIntervalDays must be 1–7' });
      }
      data.digestIntervalDays = d;
    }

    const org = await prisma.partnerOrganization.update({
      where: { id: partnerOrgId },
      data,
      select: { id: true, name: true, webhookUrl: true, digestIntervalDays: true },
    });

    res.json({
      settings: org,
      ...(newSecret ? { webhookSecret: newSecret } : {}), // shown ONCE
    });
  } catch (err: any) {
    console.error('[fleet/settings PATCH]', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// POST /api/fleet/settings/webhook-test
router.post('/settings/webhook-test', async (req: any, res: any) => {
  try {
    const partnerOrgId = await getCallerPartnerOrgId(req.user.accountId);
    if (!partnerOrgId) return res.status(400).json({ error: 'No partner org' });

    const org = await prisma.partnerOrganization.findUnique({
      where: { id: partnerOrgId },
      select: { webhookUrl: true, webhookSecret: true },
    });
    if (!org?.webhookUrl || !org?.webhookSecret) {
      return res.status(400).json({ error: 'No webhook configured' });
    }

    const body = JSON.stringify({
      eventType: 'TEST',
      timestamp: new Date().toISOString(),
      partnerId: partnerOrgId,
    });
    // [2026-07-06 signing-unification fix] Was a body-only HMAC with no
    // timestamp/replay protection -- switched to lib/webhook.ts's
    // signPayload() so a test-send signs exactly the way a real delivery
    // now does (see lib/partnerEvents.ts firePartnerWebhook +
    // lib/partnerWebhookRetry.ts for the matching change). No live partner
    // integrators exist today, so there's no wire-format compat to preserve.
    const timestamp  = String(Math.floor(Date.now() / 1000));
    const deliveryId = crypto.randomUUID();
    const signature  = signPayload(body, timestamp, org.webhookSecret);

    // [2026-07-06 SSRF fix] PATCH /settings already validates webhookUrl at
    // save time (PEN-1 above), but that's a write-time check -- a low-TTL
    // DNS record can rebind between then and this test-send (or any later
    // delivery). Re-validate now and pin the connection to the freshly
    // vetted IPs, same as the alert-engine webhook path and the partner
    // event/retry delivery paths.
    const result = await postJsonToValidatedUrl({
      url: org.webhookUrl,
      body,
      headers: {
        'Content-Type': 'application/json',
        'X-ServiceCycle-Signature':   signature,
        'X-ServiceCycle-Timestamp':   timestamp,
        'X-ServiceCycle-Delivery-Id': deliveryId,
      },
      timeoutMs: 5000,
    });

    res.json({ success: result.ok, statusCode: result.status, reason: result.ok ? undefined : result.reason });
  } catch (err: any) {
    // [2026-07-08 audit item 11] err.message previously leaked internal detail
    // (stack-adjacent text, sometimes hostnames/paths) straight to the caller.
    // Full detail stays server-side in the log; the response is generic.
    console.error('[fleet/settings/webhook-test]', err);
    res.status(500).json({ success: false, error: 'Webhook test failed' });
  }
});

// ─── Public invite accept routes (no auth guard — mounted on fleet router
//     but carve-outs from the requireOemAdmin middleware above) ─────────────

// The top-level requireOemAdmin carve-out only handles /account-forecast.
// Add carve-out for /invite/* at the top — but since middleware is applied at
// definition time we use a different approach: these routes are mounted in
// index.ts under /api/invite (public) separately. See publicInviteRouter export.

module.exports = router;
