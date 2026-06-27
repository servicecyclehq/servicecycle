/**
 * /api/deficiencies — account-wide deficiency tracking.
 *
 * Deficiencies are findings from testing or inspection, classified per the
 * NETA MTS scheme:
 *   IMMEDIATE   — safety or operational risk right now; fix before re-energize
 *   RECOMMENDED — correct at the next maintenance opportunity
 *   ADVISORY    — monitor; note for trending
 *
 * Two entry paths:
 *   - inside a work order: POST /api/work-orders/:id/deficiencies (assetId
 *     derives from the job — see routes/workOrders.ts)
 *   - standalone walkthrough findings: POST here, assetId required
 *
 * Resolution is an explicit lifecycle action (POST /:id/resolve) rather than
 * a field edit so the resolver identity (resolvedById) is always the
 * authenticated caller — never spoofable from the request body. Reopen is
 * the manager+ undo for a mistaken resolve.
 *
 * Mounted behind authenticateToken in index.ts. Every query filters
 * accountId = req.user.accountId.
 */

const router = require('express').Router();
const { requireManager } = require('../middleware/roles');
const { writeLog: writeActivityLog } = require('../lib/activityLog');
const prisma = require('../lib/prisma').default;
const { notifyDeficiencyCreated } = require('../lib/assetAlertNotifier');

const SEVERITIES = ['IMMEDIATE', 'RECOMMENDED', 'ADVISORY'];

const deficiencyInclude = {
  asset: {
    select: {
      id: true, equipmentType: true, manufacturer: true, model: true,
      serialNumber: true, site: { select: { id: true, name: true } },
    },
  },
  workOrder:  { select: { id: true, status: true, scheduledDate: true, completedDate: true } },
  resolvedBy: { select: { id: true, name: true } },
};

// ─── GET /api/deficiencies ────────────────────────────────────────────────────
// Account-wide list. Filters:
//   severity        — IMMEDIATE | RECOMMENDED | ADVISORY
//   resolved        — 'true' (resolvedAt set) | 'false' (open); omit for all
//   assetId, siteId — narrow to one asset / one site (via the asset join)
// Sort: severity first (IMMEDIATE → ADVISORY, the enum's declaration order),
// then newest first within each band — the triage queue ordering.
router.get('/', async (req, res) => {
  try {
    const { severity, resolved, assetId, siteId, page = 1, limit = 50 } = req.query;

    const take = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const skip = (pageNum - 1) * take;

    const where: any = { accountId: req.user.accountId };
    if (severity) {
      if (!SEVERITIES.includes(String(severity))) {
        return res.status(400).json({ success: false, error: `severity must be one of ${SEVERITIES.join(', ')}` });
      }
      where.severity = severity;
    }
    if (resolved === 'true')  where.resolvedAt = { not: null };
    if (resolved === 'false') where.resolvedAt = null;
    if (assetId) where.assetId = String(assetId);
    if (siteId)  where.asset = { siteId: String(siteId) };

    const [deficiencies, total] = await Promise.all([
      prisma.deficiency.findMany({
        where,
        include: deficiencyInclude,
        orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
        skip,
        take,
      }),
      prisma.deficiency.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        deficiencies,
        pagination: { page: pageNum, limit: take, total, pages: Math.ceil(total / take) },
      },
    });
  } catch (err) {
    console.error('List deficiencies error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch deficiencies' });
  }
});

// ─── POST /api/deficiencies ───────────────────────────────────────────────────
// Standalone walkthrough finding — no work order context, so assetId is
// required and ownership-checked.
router.post('/', requireManager, async (req, res) => {
  try {
    const { assetId, severity, description, correctiveAction } = req.body;

    if (!assetId) {
      return res.status(400).json({ success: false, error: 'assetId is required' });
    }
    if (!severity || !SEVERITIES.includes(severity)) {
      return res.status(400).json({ success: false, error: `severity must be one of ${SEVERITIES.join(', ')}` });
    }
    if (!description || !String(description).trim()) {
      return res.status(400).json({ success: false, error: 'description is required' });
    }

    const asset = await prisma.asset.findFirst({
      where: { id: assetId, accountId: req.user.accountId },
      select: { id: true, manufacturer: true, model: true, site: { select: { name: true } } },
    });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const deficiency = await prisma.deficiency.create({
      data: {
        accountId:        req.user.accountId,
        assetId:          asset.id,
        severity,
        description:      String(description).trim(),
        correctiveAction: correctiveAction || null,
        // workOrderId intentionally null — this is the walkthrough path
      },
      include: deficiencyInclude,
    });

    // Partner Flywheel: emit IMMEDIATE_DEFICIENCY event (fire-and-forget)
    if (severity === 'IMMEDIATE') {
      const { emitPartnerEvent } = require('../lib/partnerEvents');
      emitPartnerEvent(req.user.accountId, 'IMMEDIATE_DEFICIENCY', {
        assetId:          asset.id,
        assetName:        deficiency.asset?.name ?? (`${asset.manufacturer ?? ''} ${asset.model ?? ''}`.trim() || 'Asset'),
        assetSite:        asset.site?.name ?? null,
        severity,
        description:      deficiency.description,
        correctiveAction: deficiency.correctiveAction ?? null,
        estimatedCapExMin: null,
        estimatedCapExMax: null,
      }).catch(console.error);
    }

    // Deficiency alert notification — fire-and-forget
    notifyDeficiencyCreated({
      accountId: req.user.accountId,
      assetId: asset.id,
      assetName: deficiency.asset?.name ?? (`${asset.manufacturer ?? ''} ${asset.model ?? ''}`.trim() || 'Asset'),
      deficiencyId: deficiency.id,
      severity,
      description: deficiency.description || '',
      reportedBy: req.user.name || req.user.email,
    }).catch(() => {});

    res.status(201).json({ success: true, data: { deficiency } });
  } catch (err) {
    console.error('Create deficiency error:', err);
    res.status(500).json({ success: false, error: 'Failed to create deficiency' });
  }
});

// ─── PUT /api/deficiencies/:id ────────────────────────────────────────────────
// Edit the finding itself. Resolution state changes go through /resolve and
// /reopen — never through this generic edit, so resolvedAt/resolvedById can't
// be forged via the body.
router.put('/:id', requireManager, async (req, res) => {
  try {
    const existing = await prisma.deficiency.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Deficiency not found' });

    const { severity, description, correctiveAction } = req.body;

    const updateData: any = {};
    if (severity !== undefined) {
      if (!SEVERITIES.includes(severity)) {
        return res.status(400).json({ success: false, error: `severity must be one of ${SEVERITIES.join(', ')}` });
      }
      updateData.severity = severity;
    }
    if (description !== undefined) {
      if (!description || !String(description).trim()) {
        return res.status(400).json({ success: false, error: 'description cannot be blank' });
      }
      updateData.description = String(description).trim();
    }
    if (correctiveAction !== undefined) updateData.correctiveAction = correctiveAction || null;

    const deficiency = await prisma.deficiency.update({
      where: { id: existing.id },
      data: updateData,
      include: deficiencyInclude,
    });

    res.json({ success: true, data: { deficiency } });
  } catch (err) {
    console.error('Update deficiency error:', err);
    res.status(500).json({ success: false, error: 'Failed to update deficiency' });
  }
});

// ─── POST /api/deficiencies/:id/resolve ───────────────────────────────────────
// Marks the finding corrected: resolvedAt = now, resolvedById = the caller.
// An optional `resolution` note is appended to correctiveAction so the
// "what was actually done" narrative lives with the finding.
router.post('/:id/resolve', requireManager, async (req, res) => {
  try {
    const existing = await prisma.deficiency.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Deficiency not found' });

    if (existing.resolvedAt) {
      return res.status(400).json({ success: false, error: 'Deficiency is already resolved' });
    }

    // ESO-4: IMMEDIATE deficiency resolution requires a meaningful corrective note.
    if (existing.severity === 'IMMEDIATE') {
      const note = (req.body?.resolution ?? '').trim();
      if (note.length < 20) {
        return res.status(400).json({
          success: false,
          error: 'IMMEDIATE deficiency resolution requires a detailed corrective action description (minimum 20 characters)',
        });
      }
    }
    const { resolution } = req.body || {};
    const updateData: any = {
      resolvedAt:   new Date(),
      resolvedById: req.user.id, // always the authenticated caller
    };
    if (resolution && String(resolution).trim()) {
      const note = `[Resolved] ${String(resolution).trim()}`;
      updateData.correctiveAction = existing.correctiveAction
        ? `${existing.correctiveAction}\n${note}`
        : note;
    }

    const deficiency = await prisma.deficiency.update({
      where: { id: existing.id },
      data: updateData,
      include: deficiencyInclude,
    });

    writeActivityLog({
      assetId:   existing.assetId,
      userId:    req.user.id,
      accountId: req.user.accountId,
      action:    'deficiency_resolved',
      details:   { deficiencyId: existing.id, severity: existing.severity, workOrderId: existing.workOrderId },
    });

    res.json({ success: true, data: { deficiency } });
  } catch (err) {
    console.error('Resolve deficiency error:', err);
    res.status(500).json({ success: false, error: 'Failed to resolve deficiency' });
  }
});

// ─── POST /api/deficiencies/bulk-resolve ──────────────────────────────────────
// CUST-8-7: resolve many findings in one action (select → resolve). Body:
//   { ids: string[] (1..200), resolution?: string }
// Only OPEN, in-account deficiencies are touched. If ANY selected finding is
// IMMEDIATE, a meaningful corrective note (≥20 chars) is required for the whole
// batch — same rule as the single /resolve path, so bulk can't bypass it.
// Already-resolved or cross-tenant ids are skipped (reported in `skipped`), so
// a partial selection still succeeds for the rest. NOTE: registered before
// /:id/reopen but after /:id/resolve; '/bulk-resolve' is a literal path that
// would otherwise be captured by '/:id' — keep it ahead of any '/:id' route.
router.post('/bulk-resolve', requireManager, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === 'string' && x) : [];
    if (ids.length === 0) {
      return res.status(400).json({ success: false, error: 'ids must be a non-empty array of deficiency ids' });
    }
    if (ids.length > 200) {
      return res.status(400).json({ success: false, error: 'Cannot resolve more than 200 deficiencies at once' });
    }
    const uniqueIds = [...new Set(ids)];

    // Pull the in-account, currently-open targets only. Resolved/cross-tenant
    // ids simply don't come back and are reported as skipped.
    const open = await prisma.deficiency.findMany({
      where: { id: { in: uniqueIds }, accountId: req.user.accountId, resolvedAt: null },
      select: { id: true, assetId: true, severity: true, correctiveAction: true, workOrderId: true },
    });

    const note = (req.body?.resolution ?? '').trim();
    const hasImmediate = open.some((d) => d.severity === 'IMMEDIATE');
    if (hasImmediate && note.length < 20) {
      return res.status(400).json({
        success: false,
        error: 'One or more selected findings are IMMEDIATE — a detailed corrective action description (minimum 20 characters) is required to resolve them.',
      });
    }

    const now = new Date();
    const resolvedNote = note ? `[Resolved] ${note}` : null;

    // Per-row update so the appended note preserves each finding's existing
    // correctiveAction (a single updateMany can't concatenate per-row).
    let resolvedCount = 0;
    for (const d of open) {
      const data: any = { resolvedAt: now, resolvedById: req.user.id };
      if (resolvedNote) {
        data.correctiveAction = d.correctiveAction ? `${d.correctiveAction}\n${resolvedNote}` : resolvedNote;
      }
      await prisma.deficiency.update({ where: { id: d.id }, data });
      writeActivityLog({
        assetId:   d.assetId,
        userId:    req.user.id,
        accountId: req.user.accountId,
        action:    'deficiency_resolved',
        details:   { deficiencyId: d.id, severity: d.severity, workOrderId: d.workOrderId, bulk: true },
      });
      resolvedCount++;
    }

    const resolvedIds = open.map((d) => d.id);
    const skipped = uniqueIds.filter((id) => !resolvedIds.includes(id));
    return res.json({
      success: true,
      data: { resolved: resolvedCount, skipped: skipped.length, skippedIds: skipped },
    });
  } catch (err) {
    console.error('Bulk resolve deficiencies error:', err);
    return res.status(500).json({ success: false, error: 'Failed to bulk-resolve deficiencies' });
  }
});

// ─── POST /api/deficiencies/:id/reopen ────────────────────────────────────────
// Manager+ undo for a mistaken resolve. Clears the resolution stamp; the
// appended resolution note (if any) stays in correctiveAction as history.
router.post('/:id/reopen', requireManager, async (req, res) => {
  try {
    const existing = await prisma.deficiency.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Deficiency not found' });

    if (!existing.resolvedAt) {
      return res.status(400).json({ success: false, error: 'Deficiency is not resolved' });
    }

    const deficiency = await prisma.deficiency.update({
      where: { id: existing.id },
      data: { resolvedAt: null, resolvedById: null },
      include: deficiencyInclude,
    });

    writeActivityLog({
      assetId:   existing.assetId,
      userId:    req.user.id,
      accountId: req.user.accountId,
      action:    'deficiency_reopened',
      details:   { deficiencyId: existing.id, severity: existing.severity },
    });

    res.json({ success: true, data: { deficiency } });
  } catch (err) {
    console.error('Reopen deficiency error:', err);
    res.status(500).json({ success: false, error: 'Failed to reopen deficiency' });
  }
});

module.exports = router;

export {};
