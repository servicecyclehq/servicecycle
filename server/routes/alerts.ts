// ─────────────────────────────────────────────────────────────────────────────
// routes/alerts.ts — in-app alert feed + per-user preferences, retargeted to
// the ServiceCycle maintenance model.
//
//   GET  /api/alerts               → open alerts (drives the bell + AlertsPage)
//   POST /api/alerts/:id/acknowledge
//   POST /api/alerts/run           → manual engine trigger (admin)
//   GET  /api/alerts/preferences   → per-user email preferences
//   PUT  /api/alerts/preferences
//
// Alert rows are produced exclusively by lib/alertEngine.ts. leadDays encodes
// the tier (180/120/90/60/30/7 lead; -1/-7/-30/-90 overdue/escalation/breach).
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const { requireAdmin } = require('../middleware/roles');
const { runAlertEngine } = require('../lib/alertEngine');
import prisma from '../lib/prisma';

const router = express.Router();

const ALL_ALERT_TYPES = ['maintenance_due', 'overdue', 'escalation', 'regulatory_breach'];

// Engine TIERS are the source of truth for fire points; these defaults are
// what the preferences UI advertises. Only maintenance_due lead days are
// user-configurable — overdue/escalation/breach always deliver (suppressing
// an overdue compliance signal via preference would defeat the product).
const DEFAULT_DAYS: any = {
  maintenance_due:   '180,120,90,60,30,7',
  overdue:           '',
  escalation:        '',
  regulatory_breach: '',
};

router.get('/preferences', async (req, res) => {
  try {
    const rows = await prisma.alertPreference.findMany({
      where: { userId: req.user.id },
    });
    const prefMap: any = {};
    rows.forEach(p => { prefMap[p.alertType] = p; });
    const preferences = ALL_ALERT_TYPES.map(type => ({
      alertType:      type,
      daysBeforeList: prefMap[type]?.daysBeforeList ?? DEFAULT_DAYS[type],
      emailEnabled:   prefMap[type]?.emailEnabled   ?? true,
      configurable:   type === 'maintenance_due',
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
    const valid = preferences.filter(p => ALL_ALERT_TYPES.includes(p.alertType));
    await Promise.all(
      valid.map(pref =>
        prisma.alertPreference.upsert({
          where: {
            userId_alertType: { userId: req.user.id, alertType: pref.alertType },
          },
          update: {
            daysBeforeList: String(pref.daysBeforeList ?? DEFAULT_DAYS[pref.alertType] ?? ''),
            emailEnabled:   Boolean(pref.emailEnabled ?? true),
          },
          create: {
            userId:         req.user.id,
            alertType:      pref.alertType,
            daysBeforeList: String(pref.daysBeforeList ?? DEFAULT_DAYS[pref.alertType] ?? ''),
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

// ── GET /api/alerts ──────────────────────────────────────────────────────────
// Open (pending|sent) alerts with enough joined context for the AlertsPage
// table and the sidebar bell count. Filters: alertType, siteId, assetId.
router.get('/', async (req, res) => {
  try {
    const where: any = {
      accountId: req.user.accountId,
      status:    { in: ['pending', 'sent'] },
    };
    if (req.query.alertType && ALL_ALERT_TYPES.includes(String(req.query.alertType))) {
      where.alertType = req.query.alertType;
    }
    if (req.query.assetId) where.assetId = String(req.query.assetId);
    if (req.query.siteId)  where.asset = { siteId: String(req.query.siteId) };

    const alerts = await prisma.alert.findMany({
      where,
      include: {
        asset: {
          select: {
            id: true, equipmentType: true, manufacturer: true, model: true,
            serialNumber: true, governingCondition: true,
            site: { select: { id: true, name: true } },
          },
        },
        schedule: {
          select: {
            id: true, nextDueDate: true, lastCompletedDate: true,
            taskDefinition: { select: { taskName: true, taskCode: true, standardRef: true, requiresOutage: true } },
          },
        },
      },
      // Most urgent first: overdue tiers (negative leadDays) before lead
      // tiers, then by due date.
      orderBy: [{ leadDays: 'asc' }, { scheduledAt: 'asc' }],
      take: 100,
    });

    return res.json({ success: true, data: { alerts, count: alerts.length } });
  } catch (err) {
    console.error('Get alerts error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch alerts' });
  }
});

// ── POST /api/alerts/:id/acknowledge ─────────────────────────────────────────
router.post('/:id/acknowledge', async (req, res) => {
  try {
    const alert = await prisma.alert.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!alert) return res.status(404).json({ success: false, error: 'Alert not found' });
    if (alert.status === 'acknowledged') {
      return res.json({ success: true, data: { alert } });
    }
    const updated = await prisma.alert.update({
      where: { id: alert.id },
      data:  { status: 'acknowledged', acknowledgedAt: new Date() },
    });
    return res.json({ success: true, data: { alert: updated } });
  } catch (err) {
    console.error('Acknowledge alert error:', err);
    return res.status(500).json({ success: false, error: 'Failed to acknowledge alert' });
  }
});

// ── POST /api/alerts/run ─────────────────────────────────────────────────────
// Manual engine trigger, scoped to the caller's account (admin only).
router.post('/run', requireAdmin, async (req, res) => {
  try {
    const result = await runAlertEngine({ accountId: req.user.accountId });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('Manual alert engine run error:', err);
    return res.status(500).json({ success: false, error: 'Alert engine run failed' });
  }
});

module.exports = router;

export {};
