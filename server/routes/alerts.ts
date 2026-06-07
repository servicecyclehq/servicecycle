const express = require('express');
const { requireAdmin, requireManager } = require('../middleware/roles');
const { runAlertEngine } = require('../lib/alertEngine');
import prisma from '../lib/prisma';

const router = express.Router();

const ALL_ALERT_TYPES = ['cancel_by', 'review_by', 'renewal', 'billing_60', 'billing_30', 'billing_48', 'payment_due'];

const DEFAULT_DAYS: any = {
  // H2 (audit High, 2026-05-22): aligned with the engine's actual fire
  // thresholds in server/lib/alertEngine.js DEFAULT_THRESHOLDS. Before
  // this, the preferences endpoint advertised 90/60/30 for cancel/review/
  // renewal but the engine fired 60/30/7 -- users got the 90-day
  // expectation but never the 90-day alert. Engine is the source of
  // truth; keeping it at 60/30/7 (the post-v0.14 industry-standard
  // window) and bringing preferences UI defaults in line.
  cancel_by:   '60,30,7',
  review_by:   '30,14',
  renewal:     '60,30,7',
  billing_60:  '60',
  billing_30:  '30',
  billing_48:  '2',
  payment_due: '30,14,7',
};

// v0.56.0: shared sentinel between the /distinct endpoint (server) and
// ColumnFilterDropdown (client) for "rows where this column is blank/null."
const BLANK_SENTINEL = '__BLANK__';

router.get('/preferences', async (req, res) => {
  try {
    const rows = await prisma.alertPreference.findMany({
      where: { userId: req.user.id },
    });
    const prefMap: any = {};
    rows.forEach(p => { prefMap[p.alertType] = p; });
    const preferences = ALL_ALERT_TYPES.map(type => ({
      alertType:     type,
      daysBeforeList: prefMap[type]?.daysBeforeList ?? DEFAULT_DAYS[type],
      emailEnabled:  prefMap[type]?.emailEnabled   ?? true,
    }));
    return res.json({ success: true, data: { preferences } });
  } catch (err) {
    console.error('Get alert preferences error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch preferences' });
  }
});

router.put('/preferences', async (req, res) => {
  try {
    const { preferences } = req.body;
    if (!Array.isArray(preferences) || preferences.length === 0) {
      return res.status(400).json({ success: false, error: 'preferences must be a non-empty array' });
    }
    await Promise.all(
      preferences.map(pref =>
        prisma.alertPreference.upsert({
          where: {
            userId_alertType: { userId: req.user.id, alertType: pref.alertType },
          },
          update: {
            daysBeforeList: String(pref.daysBeforeList ?? DEFAULT_DAYS[pref.alertType] ?? '30'),
            emailEnabled:   Boolean(pref.emailEnabled ?? true),
          },
          create: {
            userId:         req.user.id,
            alertType:      pref.alertType,
            daysBeforeList: String(pref.daysBeforeList ?? DEFAULT_DAYS[pref.alertType] ?? '30'),
            emailEnabled:   Boolean(pref.emailEnabled ?? true),
          },
        })
      )
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('Update alert preferences error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update preferences' });
  }
});

router.get('/', async (req, res) => {
  try {
    // H1 (audit High, 2026-05-22): when caller is contractScopeRestricted,
    // filter to alerts whose contract.internalOwnerId matches. Mirrors the
    // pattern in contracts.js contractWhereForUser + loadAlertRowsForAccount
    // below. Without this, a restricted user sees + can acknowledge alerts
    // on contracts they were never assigned to.
    const contractFilter = req.user.contractScopeRestricted
      ? { contract: { internalOwnerId: req.user.id } }
      : {};
    const alerts = await prisma.alert.findMany({
      where: {
        accountId: req.user.accountId,
        status: { in: ['pending', 'sent'] },
        ...contractFilter,
      },
      include: {
        contract: {
          select: {
            id: true, product: true, endDate: true,
            cancelByDate: true, evaluationStartByDate: true,
            vendor: { select: { name: true } },
          },
        },
      },
      orderBy: { scheduledAt: 'asc' },
      take: 50,
    });
    return res.json({ success: true, data: { alerts, count: alerts.length } });
  } catch (err) {
    console.error('Get alerts error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch alerts' });
  }
});

function daysUntilSrv(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return Math.ceil((dt.getTime() - Date.now()) / 86400000);
}

function getAlertRelevantDate(a) {
  if (a.alertType === 'cancel_by') return a.contract?.cancelByDate;
  if (a.alertType === 'review_by') return a.contract?.evaluationStartByDate;
  return a.contract?.endDate;
}

async function loadAlertRowsForAccount(req) {
  const accountId = req.user.accountId;
  const now       = new Date();
  const in7       = new Date(now.getTime() + 7 * 86400000);
  const startOfMonth     = new Date(now.getFullYear(), now.getMonth(),     1);
  const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const scope = req.user.contractScopeRestricted
    ? { internalOwnerId: req.user.id }
    : {};

  const contractSelect: any = {
    id: true, product: true, endDate: true,
    cancelByDate: true, evaluationStartByDate: true,
    autoRenewal: true, status: true,
    vendor: { select: { id: true, name: true } },
  };

  const [cancelUrgent, overdueReviews, expiringThisMonth, persistedAlerts] = await Promise.all([
    prisma.contract.findMany({
      where: { accountId, ...scope, status: { in: ['active', 'under_review'] },
               autoRenewal: true, cancelByDate: { gte: now, lte: in7 } },
      select: contractSelect, orderBy: { cancelByDate: 'asc' }, take: 50,
    }),
    prisma.contract.findMany({
      where: { accountId, ...scope, status: { in: ['active', 'under_review'] },
               evaluationStartByDate: { lt: now } },
      select: contractSelect, orderBy: { evaluationStartByDate: 'asc' }, take: 50,
    }),
    prisma.contract.findMany({
      where: { accountId, ...scope, status: 'active',
               endDate: { gte: startOfMonth, lt: startOfNextMonth } },
      select: contractSelect, orderBy: { endDate: 'asc' }, take: 50,
    }),
    prisma.alert.findMany({
      where: { accountId, status: { in: ['pending', 'sent'] } },
      include: {
        contract: {
          select: {
            id: true, product: true, endDate: true,
            cancelByDate: true, evaluationStartByDate: true,
            vendor: { select: { name: true } },
          },
        },
      },
      orderBy: { scheduledAt: 'asc' }, take: 100,
    }),
  ]);

  const allRows = [
    ...cancelUrgent.map(c => ({
      alertType: 'cancel_by', contract: c, relevantDate: c.cancelByDate, daysUntil: daysUntilSrv(c.cancelByDate),
    })),
    ...overdueReviews.map(c => ({
      alertType: 'review_by', contract: c, relevantDate: c.evaluationStartByDate, daysUntil: daysUntilSrv(c.evaluationStartByDate),
    })),
    ...expiringThisMonth.map(c => ({
      alertType: 'renewal', contract: c, relevantDate: c.endDate, daysUntil: daysUntilSrv(c.endDate),
    })),
    ...persistedAlerts.map(a => {
      const rd = getAlertRelevantDate(a);
      return { alertType: a.alertType, contract: a.contract, relevantDate: rd, daysUntil: daysUntilSrv(rd) };
    }),
  ];
  return allRows;
}

function parseList(raw) {
  if (raw == null) return [];
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string') arr = raw.split(',');
  else return [];
  return arr
    .map(s => (typeof s === 'string' ? s.trim() : ''))
    .filter(s => s.length > 0 && s.length <= 200)
    .slice(0, 200);
}

function applyAlertsRowFilters(rows, query, excludeColumnId) {
  const chip = String(query.chip || 'all');
  const chipMatch = (t) => {
    if (chip === 'all')      return true;
    if (chip === 'billing')  return typeof t === 'string' && t.startsWith('billing_');
    return t === chip;
  };
  let out = rows.filter(r => chipMatch(r.alertType));

  if (excludeColumnId !== 'vendor') {
    const list = parseList(query.vendorIn);
    if (list.length > 0) {
      const wantsBlank = list.includes(BLANK_SENTINEL);
      const realList   = new Set(list.filter(v => v !== BLANK_SENTINEL));
      out = out.filter(r => {
        const v = r.contract?.vendor?.name;
        if (v == null || v === '') return wantsBlank;
        return realList.has(v);
      });
    } else if (typeof query.vendor === 'string' && query.vendor) {
      const needle = query.vendor.toLowerCase();
      out = out.filter(r => {
        const v = r.contract && r.contract.vendor && r.contract.vendor.name;
        return String(v != null ? v : '').toLowerCase().includes(needle);
      });
    }
  }

  if (excludeColumnId !== 'product') {
    const list = parseList(query.productIn);
    if (list.length > 0) {
      const wantsBlank = list.includes(BLANK_SENTINEL);
      const realList   = new Set(list.filter(v => v !== BLANK_SENTINEL));
      out = out.filter(r => {
        const v = r.contract?.product;
        if (v == null || v === '') return wantsBlank;
        return realList.has(v);
      });
    } else if (typeof query.product === 'string' && query.product) {
      const needle = query.product.toLowerCase();
      out = out.filter(r => {
        const v = r.contract && r.contract.product;
        return String(v != null ? v : '').toLowerCase().includes(needle);
      });
    }
  }

  if (excludeColumnId !== 'date') {
    const { dateFrom, dateTo } = query;
    if (dateFrom || dateTo) {
      const fromT = dateFrom ? new Date(dateFrom).getTime() : null;
      const toT   = dateTo   ? new Date(dateTo).getTime() + 86399999 : null;
      out = out.filter(r => {
        if (!r.relevantDate) return false;
        const t = new Date(r.relevantDate).getTime();
        if (Number.isNaN(t)) return false;
        if (fromT != null && t < fromT) return false;
        if (toT   != null && t > toT)   return false;
        return true;
      });
    }
  }

  if (excludeColumnId !== 'daysUntil') {
    const { daysMin, daysMax } = query;
    if (daysMin != null || daysMax != null) {
      const minV = daysMin != null && daysMin !== '' ? Number(daysMin) : null;
      const maxV = daysMax != null && daysMax !== '' ? Number(daysMax) : null;
      out = out.filter(r => {
        if (r.daysUntil == null) return false;
        if (minV != null && r.daysUntil < minV) return false;
        if (maxV != null && r.daysUntil > maxV) return false;
        return true;
      });
    }
  }

  return out;
}

router.get('/all', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const now       = new Date();
    const in7       = new Date(now.getTime() + 7  * 86400000);
    const startOfMonth     = new Date(now.getFullYear(), now.getMonth(),     1);
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const scope = req.user.contractScopeRestricted
      ? { internalOwnerId: req.user.id }
      : {};

    const contractSelect: any = {
      id: true, product: true, endDate: true,
      cancelByDate: true, evaluationStartByDate: true,
      autoRenewal: true, status: true,
      vendor: { select: { id: true, name: true } },
    };

    const [cancelUrgent, overdueReviews, expiringThisMonth, persistedAlerts] = await Promise.all([
      prisma.contract.findMany({
        where: { accountId, ...scope, status: { in: ['active', 'under_review'] },
                 autoRenewal: true, cancelByDate: { gte: now, lte: in7 } },
        select: contractSelect, orderBy: { cancelByDate: 'asc' }, take: 50,
      }),
      prisma.contract.findMany({
        where: { accountId, ...scope, status: { in: ['active', 'under_review'] },
                 evaluationStartByDate: { lt: now } },
        select: contractSelect, orderBy: { evaluationStartByDate: 'asc' }, take: 50,
      }),
      prisma.contract.findMany({
        where: { accountId, ...scope, status: 'active',
                 endDate: { gte: startOfMonth, lt: startOfNextMonth } },
        select: contractSelect, orderBy: { endDate: 'asc' }, take: 50,
      }),
      prisma.alert.findMany({
        where: { accountId, status: { in: ['pending', 'sent'] } },
        include: {
          contract: {
            select: {
              id: true, product: true, endDate: true,
              cancelByDate: true, evaluationStartByDate: true,
              vendor: { select: { name: true } },
            },
          },
        },
        orderBy: { scheduledAt: 'asc' }, take: 100,
      }),
    ]);

    const derivedTotal   = cancelUrgent.length + overdueReviews.length + expiringThisMonth.length;
    const persistedTotal = persistedAlerts.length;

    return res.json({
      success: true,
      data: {
        derivedStates: { cancelUrgent, overdueReviews, expiringThisMonth },
        persistedAlerts,
        totals: {
          derived:   derivedTotal,
          persisted: persistedTotal,
          all:       derivedTotal + persistedTotal,
        },
      },
    });
  } catch (err) {
    console.error('Get /api/alerts/all error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load alerts' });
  }
});

router.get('/distinct/:column', async (req, res) => {
  const VALID_COLUMNS = ['vendor', 'product'];
  const { column } = req.params;
  if (!VALID_COLUMNS.includes(column)) {
    return res.status(400).json({ error: 'invalid_column' });
  }
  try {
    const allRows = await loadAlertRowsForAccount(req);
    const excludeColumnId = column;
    const filtered = applyAlertsRowFilters(allRows, req.query, excludeColumnId);

    const set = new Set();
    let blankCount = 0;
    if (column === 'vendor') {
      for (const r of filtered) {
        const v = r.contract?.vendor?.name;
        if (v == null || v === '') blankCount++;
        else set.add(String(v));
      }
    } else if (column === 'product') {
      for (const r of filtered) {
        const v = r.contract?.product;
        if (v == null || v === '') blankCount++;
        else set.add(String(v));
      }
    }
    const values = [...set].sort().slice(0, 500);
    if (blankCount > 0) values.unshift(BLANK_SENTINEL);
    return res.json({ values });
  } catch (err) {
    console.error('[alerts/distinct] failed for column', column, ':', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.put('/:id/acknowledge', requireManager, async (req, res) => {
  try {
    const alert = await prisma.alert.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!alert) return res.status(404).json({ success: false, error: 'Alert not found' });
    await prisma.alert.update({
      where: { id: alert.id },
      data: { status: 'acknowledged', acknowledgedAt: new Date() },
    });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to acknowledge alert' });
  }
});

router.put('/acknowledge-all', requireManager, async (req, res) => {
  try {
    // H1 (audit High, 2026-05-22): same scope filter as the list route so a
    // restricted manager can't bulk-acknowledge alerts they were never
    // allowed to see.
    const contractFilter = req.user.contractScopeRestricted
      ? { contract: { internalOwnerId: req.user.id } }
      : {};
    await prisma.alert.updateMany({
      where: { accountId: req.user.accountId, status: { in: ['pending', 'sent'] }, ...contractFilter },
      data: { status: 'acknowledged', acknowledgedAt: new Date() },
    });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to acknowledge alerts' });
  }
});

router.post('/run', requireAdmin, async (req, res) => {
  try {
    const result = await runAlertEngine({ accountId: req.user.accountId });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('Run alert engine error:', err);
    return res.status(500).json({ success: false, error: 'Failed to run alert engine.' });
  }
});

module.exports = router;

export {};
