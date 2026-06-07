const router = require('express').Router();
import prisma from '../lib/prisma';

async function autoExpireContracts(accountId) {
  try {
    await prisma.contract.updateMany({
      where: {
        accountId,
        status: { in: ['active', 'under_review'] },
        endDate: { lt: new Date() },
      },
      data: { status: 'expired' },
    });
  } catch (err) {
    console.error('autoExpireContracts error:', err.message);
  }
}

// ─── GET /api/dashboard ───────────────────────────────────────────────────────
// Single endpoint that returns everything the dashboard page needs.
router.get('/', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    // S2-FN-08 (v0.74.0): fire-and-forget; dashboard render must not block on expiry sweep.
    autoExpireContracts(accountId).catch(e => console.error('[dashboard] autoExpireContracts:', e.message));

    // Scope-restricted viewers see only contracts they own. The IDOR audit
    // (2026-05-02) flagged that without this, a restricted viewer's
    // dashboard counts/lists/aggregates were computed across the full
    // account, leaking everything except the per-contract detail page.
    // Spread `scope` into every contract query below.
    const scope = req.user.contractScopeRestricted
      ? { internalOwnerId: req.user.id }
      : {};

    const now = new Date();
    const in14  = new Date(now.getTime() + 14  * 86_400_000);
    const in30  = new Date(now.getTime() + 30  * 86_400_000);
    const in60  = new Date(now.getTime() + 60  * 86_400_000);
    const in90  = new Date(now.getTime() + 90  * 86_400_000);

    const contractSelect: any = {
      id: true,
      product: true,
      endDate: true,
      evaluationStartByDate: true,
      cancelByDate: true,
      autoRenewal: true,
      autoRenewalNoticeDays: true,
      costPerLicense: true,
      quantity: true,
      status: true,
      department: true,
      vendor: { select: { id: true, name: true } },
    };

    const in7 = new Date(now.getTime() + 7 * 86_400_000);

    const [
      totalActive,
      expiringIn90,
      allActiveContracts,
      needsReviewNow,
      autoRenewalTraps,
      upcomingRenewals,
      cancelUrgent,
      overdueReviews,
      expiringThisMonth,
      savingsAgg,
      openAlertsCount,
    ] = await Promise.all([

      // Count of active contracts
      prisma.contract.count({
        where: { accountId, ...scope, status: 'active' },
      }),

      // Contracts expiring within 90 days
      prisma.contract.count({
        where: {
          accountId, ...scope,
          status: 'active',
          endDate: { gte: now, lte: in90 },
        },
      }),

      // All active contracts — for spend charts + aggregations.
      // Pass-5 / Agent 3: defensive take(1000). The chart-aggregation paths
      // below (spend-by-vendor, spend-by-department, renewals-by-month) do
      // a full in-process reduce over this array. Without a cap an account
      // with 50k active contracts blocks the event loop for seconds per
      // dashboard load. 1000 is well above any realistic real-world count
      // (largest observed customer: ~600 active rows); if anyone legitimately
      // exceeds it they'll hit it before they hit pathological perf.
      prisma.contract.findMany({
        where: { accountId, ...scope, status: 'active' },
        select: {
          costPerLicense: true, quantity: true,
          department: true, endDate: true,
          vendor: { select: { id: true, name: true } },
        },
        take: 1000,
      }),

      // Needs review NOW — evaluationStartByDate within 14 days
      prisma.contract.findMany({
        where: {
          accountId, ...scope,
          status: 'active',
          evaluationStartByDate: { gte: now, lte: in14 },
        },
        select: contractSelect,
        orderBy: { evaluationStartByDate: 'asc' },
        take: 10,
      }),

      // Auto-renewal traps — cancel window closing within 30 days
      // Includes under_review as well as active — a contract under review can
      // still silently auto-renew if the cancel window is missed.
      prisma.contract.findMany({
        where: {
          accountId, ...scope,
          status: { in: ['active', 'under_review'] },
          autoRenewal: true,
          cancelByDate: { gte: now, lte: in30 },
        },
        select: contractSelect,
        orderBy: { cancelByDate: 'asc' },
        take: 50,
      }),

      // Upcoming renewals — next 8 active contracts by end date within 90 days
      prisma.contract.findMany({
        where: {
          accountId, ...scope,
          status: 'active',
          endDate: { gte: now, lte: in90 },
        },
        select: contractSelect,
        orderBy: { endDate: 'asc' },
        take: 8,
      }),

      // Cancel urgent — auto-renewal cancel window ≤7 days
      prisma.contract.findMany({
        where: {
          accountId, ...scope,
          status: { in: ['active', 'under_review'] },
          autoRenewal: true,
          cancelByDate: { gte: now, lte: in7 },
        },
        select: contractSelect,
        orderBy: { cancelByDate: 'asc' },
        take: 20,
      }),

      // Overdue reviews — evaluationStartByDate has passed, contract still actionable
      prisma.contract.findMany({
        where: {
          accountId, ...scope,
          status: { in: ['active', 'under_review'] },
          evaluationStartByDate: { lt: now },
        },
        select: contractSelect,
        orderBy: { evaluationStartByDate: 'asc' },
        take: 20,
      }),

      // Expiring within the next 30 days (rolling)
      prisma.contract.findMany({
        where: {
          accountId, ...scope,
          status: 'active',
          endDate: { gte: now, lte: in30 },
        },
        select: contractSelect,
        orderBy: { endDate: 'asc' },
        take: 20,
      }),

      // Savings aggregate — sum of (originalAsk - finalNegotiatedPrice) for contracts
      // where both values are set. Gives a "total savings negotiated" dashboard figure.
      prisma.contract.aggregate({
        where: {
          accountId, ...scope,
          originalAsk: { not: null },
          finalNegotiatedPrice: { not: null },
        },
        _sum: { originalAsk: true, finalNegotiatedPrice: true },
      }),

      // Open (unacknowledged) alerts for this account.
      // v0.68.0 (audit Medium): when caller is contractScopeRestricted,
      // count only alerts on contracts they own (mirrors the alert list
      // scope from H1 v0.67.0). Without this, the dashboard counter
      // side-channels the tenant-wide alert volume to restricted users.
      prisma.alert.count({
        where: {
          accountId,
          acknowledgedAt: null,
          ...(req.user.contractScopeRestricted
            ? { contract: { internalOwnerId: req.user.id } }
            : {}),
        },
      }),
    ]);

    // ── Aggregate spend figures ───────────────────────────────────────────────
    function contractVal(c) {
      if (c.costPerLicense && c.quantity) {
        return parseFloat(c.costPerLicense) * parseInt(c.quantity);
      }
      return 0;
    }

    const totalAnnualSpend = allActiveContracts.reduce((s, c) => s + contractVal(c), 0);

    // Total savings negotiated = sum(originalAsk) - sum(finalNegotiatedPrice)
    const totalSavingsNegotiated = Math.max(0,
      parseFloat(savingsAgg._sum.originalAsk?.toString() || '0') -
      parseFloat(savingsAgg._sum.finalNegotiatedPrice?.toString() || '0')
    );

    // Spend at risk = spend from contracts expiring in 90 days
    const spendAtRisk = upcomingRenewals.reduce((sum: number, c: any) => {
      if (c.costPerLicense && c.quantity) {
        return sum + parseFloat(c.costPerLicense) * parseInt(c.quantity);
      }
      return sum;
    }, 0);

    // ── Spend by vendor (top 8) ───────────────────────────────────────────────
    const vendorMap: any = {};
    for (const c of allActiveContracts) {
      const name = c.vendor?.name || 'Unknown';
      if (!vendorMap[name]) vendorMap[name] = { spend: 0, vendorId: c.vendor?.id || null };
      vendorMap[name].spend += contractVal(c);
    }
    const spendByVendor = Object.entries<any>(vendorMap)
      .map(([name, { spend, vendorId }]) => ({ name, spend, vendorId }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 8);

    // ── Spend by department (top 8) ───────────────────────────────────────────
    const deptMap: any = {};
    for (const c of allActiveContracts) {
      const dept = c.department?.trim() || 'Unassigned';
      deptMap[dept] = (deptMap[dept] || 0) + contractVal(c);
    }
    const spendByDepartment = Object.entries<any>(deptMap)
      .map(([name, spend]) => ({ name, spend }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 8);

    // ── Renewals by month (next 12 months) ───────────────────────────────────
    const monthBuckets: any = {};
    const in365 = new Date(now.getTime() + 365 * 86_400_000);
    for (const c of allActiveContracts) {
      if (!c.endDate) continue;
      const d = new Date(c.endDate);
      if (d < now || d > in365) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!monthBuckets[key]) monthBuckets[key] = { count: 0, value: 0 };
      monthBuckets[key].count++;
      monthBuckets[key].value += contractVal(c);
    }
    // Build a full 12-month array starting from current month
    const renewalsByMonth = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      renewalsByMonth.push({
        month: key,
        // 4-digit year to match the rest of the product's date formatting
        // (UX review 2026-05-01: "May 26" was ambiguous — could be misread as
        // May 26th instead of May 2026).
        label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        count: monthBuckets[key]?.count || 0,
        value: monthBuckets[key]?.value || 0,
      });
    }

    // H3-2 (v0.76.2): "Data as of" — proxy via most-recently-updated contract
    const _lastSyncRow = await prisma.contract.findFirst({
      where: { accountId, ...scope },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    });
    const lastSyncAt = _lastSyncRow?.updatedAt || null;

    res.json({
      success: true,
      data: {
        summary: {
          totalActive,
          totalAnnualSpend,
          expiringIn90Days: expiringIn90,
          autoRenewalTraps: autoRenewalTraps.length,  // accurate — take: 50, same filter as /contracts?renewal=cancel30
          spendAtRisk,
          totalSavingsNegotiated,
          openAlerts: openAlertsCount,
        },
        needsAttentionToday: { cancelUrgent, overdueReviews, expiringThisMonth },
        needsReviewNow,
        autoRenewalTraps,
        upcomingRenewals,
        spendByVendor,
        spendByDepartment,
        renewalsByMonth,
        lastSyncAt,
      },
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ success: false, error: 'Failed to load dashboard' });
  }
});

module.exports = router;

export {};
