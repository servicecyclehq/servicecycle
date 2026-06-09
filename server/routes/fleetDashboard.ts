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

    const accountWhere: any = { status: 'active' };
    if (callerAccount?.partnerOrgId) {
      accountWhere.partnerOrgId = callerAccount.partnerOrgId;
    }
    // else: no partnerOrgId → all accounts (demo mode)

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
      prisma.workOrder.findMany({
        where: {
          accountId: { in: accountIds },
          status: 'COMPLETE',
        },
        select: { accountId: true, completedDate: true },
        orderBy: { completedDate: 'desc' },
        // We'll de-dup per account in JS
        take: accountIds.length * 10,
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

    // Last WO date per account
    const lastWoMap = new Map<string, Date | null>();
    for (const wo of lastWoByAccount) {
      if (!lastWoMap.has(wo.accountId) && wo.completedDate) {
        lastWoMap.set(wo.accountId, wo.completedDate);
      }
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

    // Enforce same partnerOrg scope (skip if caller has no partnerOrgId — demo mode)
    if (callerAccount?.partnerOrgId && targetAccount.partnerOrgId !== callerAccount.partnerOrgId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const [overdueSchedules, immediateDeficiencies, serviceOps, recentWorkOrders, topAssets] =
      await Promise.all([
        // Overdue schedules (top 10 most overdue)
        prisma.maintenanceSchedule.findMany({
          where: { accountId: targetAccountId, isActive: true, nextDueDate: { lt: now, not: null }, asset: { archivedAt: null } },
          select: {
            id: true, nextDueDate: true, conditionOverride: true,
            asset: { select: { id: true, name: true, serialNumber: true, equipmentType: true } },
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
            asset: { select: { id: true, name: true, serialNumber: true } },
          },
          orderBy: { createdAt: 'asc' },
          take: 20,
        }),

        // Service opportunities (escalated IMMEDIATE 30d+)
        prisma.deficiency.findMany({
          where: { accountId: targetAccountId, severity: 'IMMEDIATE', resolvedAt: null, createdAt: { lte: ago30 } },
          select: {
            id: true, description: true, createdAt: true,
            asset: { select: { id: true, name: true, serialNumber: true } },
          },
          take: 20,
        }),

        // Recent completed work orders
        prisma.workOrder.findMany({
          where: { accountId: targetAccountId, status: 'COMPLETE' },
          select: {
            id: true, title: true, completedDate: true, asLeftCondition: true,
            asset: { select: { id: true, name: true } },
          },
          orderBy: { completedDate: 'desc' },
          take: 5,
        }),

        // Top assets by open issues
        prisma.asset.findMany({
          where: { accountId: targetAccountId, archivedAt: null },
          select: {
            id: true, name: true, serialNumber: true, equipmentType: true, criticality: true,
            _count: { select: { deficiencies: { where: { resolvedAt: null } } } },
          },
          take: 10,
        }),
      ]);

    res.json({
      account: targetAccount,
      overdueSchedules,
      immediateDeficiencies,
      serviceOpportunities: serviceOps,
      recentWorkOrders,
      topAssets: topAssets.sort((a, b) => b._count.deficiencies - a._count.deficiencies),
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

module.exports = router;
