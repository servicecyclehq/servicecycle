/**
 * /api/quote-requests — per-asset service quote requests.
 *
 * "The dossier is the feature, not the button."
 *
 * When a technician or manager spots an asset that needs service they tap
 * "Request Quote".  The server auto-assembles the full asset dossier
 * (nameplate, age, criticality, redundancy, open deficiencies, last test
 * results, overdue tasks, downstream impact) so the service rep gets
 * everything they need without asking.
 *
 * EMERGENCY mode: when driver='down_now' the frontend renders the rep phone
 * number in large text with "CALL NOW" — email is still dispatched as a
 * paper trail but marked [EMERGENCY].
 *
 * Status lifecycle: requested → quoted → accepted | declined
 *
 * 5 standard questions (PENDING BROTHER VALIDATION — copy finalised for
 * demo/test, brother to review before first real customer contact):
 *   1. driver          — what prompted the request
 *   2. timeline        — how urgently is service needed
 *   3. outageAvailable — can the asset be de-energised + when
 *   4. budgeted        — approved budget vs needs a number for approval
 *   5. attachmentNotes — photos, IR scans, test reports (free text for now)
 *
 * Mounted behind authenticateToken in index.ts.
 * Every query filters accountId = req.user.accountId (IDOR).
 */

const router = require('express').Router();
const { requireManager } = require('../middleware/roles');
const prisma = require('../lib/prisma').default;

// ── Helpers ────────────────────────────────────────────────────────────────

const VALID_DRIVERS   = ['down_now','suspected_failing','failed_inspection','planned_replacement','budgetary'];
const VALID_TIMELINES = ['immediately','within_1_week','within_30_days','next_budget_cycle'];
const VALID_STATUSES  = ['requested','quoted','accepted','declined'];

/** Build a display label for an asset — mirrors client/src/lib/equipment.js assetLabel(). */
function assetLabel(a: { manufacturer?: string|null, model?: string|null, serialNumber?: string|null, equipmentType?: string|null }): string {
  const base = [a.manufacturer, a.model].filter(Boolean).join(' ');
  const serial = a.serialNumber ? ` #${a.serialNumber}` : '';
  return base ? base + serial : (a.equipmentType ?? 'Asset');
}

/** Assemble the asset dossier snapshot that gets stored with the request. */
async function buildDossier(assetId: string, accountId: string) {
  const asset = await prisma.asset.findFirst({
    where: { id: assetId, accountId },
    include: {
      site:            { select: { id: true, name: true } },
      building:        { select: { id: true, name: true } },
      area:            { select: { id: true, name: true } },
      position:        { select: { id: true, name: true } },
      // "feedsDownstream" is the Prisma relation name for downstream assets (PowerPath)
      feedsDownstream: { select: { id: true, manufacturer: true, model: true, serialNumber: true,
                                   equipmentType: true, criticalityScore: true } },
      // "fedFrom" is the Prisma relation name for the upstream source asset
      fedFrom:         { select: { id: true, manufacturer: true, model: true, serialNumber: true,
                                   equipmentType: true } },
      deficiencies: {
        where:   { resolvedAt: null },
        select:  { id: true, severity: true, description: true, createdAt: true },
        orderBy: { severity: 'asc' },
        take:    20,
      },
      workOrders: {
        where:   { status: 'COMPLETE' },
        select: {
          id: true, completedDate: true,
          // Task name lives on schedule → taskDefinition; WorkOrder has no direct taskDefinition FK
          schedule: { select: { taskDefinition: { select: { taskName: true } } } },
        },
        orderBy: { completedDate: 'desc' },
        take: 5,
      },
      // Prisma field name on Asset is "schedules" (not "maintenanceSchedules")
      schedules: {
        select: {
          id: true, nextDueDate: true, // MaintenanceSchedule uses nextDueDate, not dueDate
          taskDefinition: { select: { taskName: true, requiresOutage: true } },
        },
        where:   { isActive: true },
        orderBy: { nextDueDate: 'asc' },
        take: 10,
      },
    },
  });

  if (!asset) return null;

  const now = new Date();
  // installDate is DateTime?, derive year from it
  const installedYear = asset.installDate ? new Date(asset.installDate).getFullYear() : null;
  const ageYears = installedYear ? now.getFullYear() - installedYear : null;
  // Nameplate is JSONB — voltage/amp may live here under various keys depending on equipmentType
  const np = (asset.nameplateData as any) ?? {};

  const overdueTasks = asset.schedules.filter((s: any) =>
    s.nextDueDate && new Date(s.nextDueDate) < now
  );

  return {
    assetId:          asset.id,
    name:             assetLabel(asset),
    equipmentType:    asset.equipmentType,
    manufacturer:     asset.manufacturer,
    model:            asset.model,
    serialNumber:     asset.serialNumber,
    voltageRating:    np.voltageRating ?? np.primaryVoltage ?? np.ratedVoltage ?? null,
    ampRating:        np.ampRating ?? np.ratedCurrent ?? np.ampacity ?? null,
    installYear:      installedYear,
    ageYears,
    criticalityScore: asset.criticalityScore,      // 1–5 infrastructure criticality
    redundancyStatus: asset.redundancyStatus,       // N | N_PLUS_1 | TWO_N | null
    location: {
      site:     asset.site?.name,
      building: asset.building?.name,
      area:     asset.area?.name,
      position: asset.position?.name,
    },
    downstreamAssets: asset.feedsDownstream.map((a: any) => ({
      id: a.id, name: assetLabel(a), type: a.equipmentType, criticalityScore: a.criticalityScore,
    })),
    fedFrom: asset.fedFrom ? {
      id: asset.fedFrom.id, name: assetLabel(asset.fedFrom), type: asset.fedFrom.equipmentType,
    } : null,
    openDeficiencies: asset.deficiencies.map((d: any) => ({
      id: d.id, severity: d.severity, description: d.description,
      age: Math.floor((now.getTime() - new Date(d.createdAt).getTime()) / 86400000) + 'd',
    })),
    recentCompletedWork: asset.workOrders.map((wo: any) => ({
      id: wo.id, completedDate: wo.completedDate,
      taskName: wo.schedule?.taskDefinition?.taskName ?? 'Maintenance',
    })),
    overdueTaskCount:  overdueTasks.length,
    overdueTasks: overdueTasks.map((s: any) => ({
      taskName:       s.taskDefinition?.taskName,
      requiresOutage: s.taskDefinition?.requiresOutage ?? false,
      nextDueDate:    s.nextDueDate,
    })),
    snapshotAt: now.toISOString(),
  };
}

// ── GET /api/quote-requests ────────────────────────────────────────────────
// Account-wide list; filter by status, assetId, or emergencyMode
router.get('/', async (req, res) => {
  try {
    const { status, assetId, emergency, page = 1, limit = 50 } = req.query;
    const take = Math.min(Math.max(parseInt(limit as string) || 50, 1), 200);
    const skip = (Math.max(parseInt(page as string) || 1, 1) - 1) * take;

    const where: any = { accountId: req.user.accountId };
    if (status)    { if (!VALID_STATUSES.includes(String(status))) return res.status(400).json({ success: false, error: 'invalid status' }); where.status = status; }
    if (assetId)   where.assetId = String(assetId);
    if (emergency === 'true') where.emergencyMode = true;

    const [items, total] = await Promise.all([
      prisma.quoteRequest.findMany({
        where,
        include: {
          asset:       { select: { id: true, manufacturer: true, model: true, serialNumber: true,
                                   equipmentType: true, criticalityScore: true } },
          requestedBy: { select: { id: true, name: true } },
        },
        orderBy: [{ emergencyMode: 'desc' }, { createdAt: 'desc' }],
        skip, take,
      }),
      prisma.quoteRequest.count({ where }),
    ]);

    return res.json({ success: true, data: items, pagination: { total, page: parseInt(page as string) || 1, limit: take } });
  } catch (err) {
    console.error('[quoteRequests GET /]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── GET /api/quote-requests/:id ────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const qr = await prisma.quoteRequest.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      include: {
        asset:       { select: { id: true, manufacturer: true, model: true, serialNumber: true,
                                 equipmentType: true, site: { select: { id: true, name: true } } } },
        requestedBy: { select: { id: true, name: true } },
        account:     { select: { serviceRepName: true, serviceRepEmail: true, serviceRepPhone: true } },
      },
    });
    if (!qr) return res.status(404).json({ success: false, error: 'Not found' });
    return res.json({ success: true, data: qr });
  } catch (err) {
    console.error('[quoteRequests GET /:id]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── GET /api/quote-requests/asset/:assetId ─────────────────────────────────
// Per-asset history; mounted as /api/quote-requests/asset/:assetId
router.get('/asset/:assetId', async (req, res) => {
  try {
    const { assetId } = req.params;
    const qrs = await prisma.quoteRequest.findMany({
      where: { assetId, accountId: req.user.accountId },
      include: { requestedBy: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return res.json({ success: true, data: qrs });
  } catch (err) {
    console.error('[quoteRequests GET /asset/:assetId]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── POST /api/quote-requests ───────────────────────────────────────────────
// PENDING BROTHER VALIDATION: question set, driver labels, timeline labels,
// and emergency-mode copy are our best guess for the workflow.
// Flag for brother review before first real customer demo using this feature.
router.post('/', async (req, res) => {
  try {
    const {
      assetId,
      driver,
      timeline,
      outageAvailable,
      outageWindow,
      budgeted,
      budgetNotes,
      attachmentNotes,
      notes,
    } = req.body;

    if (!assetId)  return res.status(400).json({ success: false, error: 'assetId required' });
    if (!driver)   return res.status(400).json({ success: false, error: 'driver required' });
    if (!timeline) return res.status(400).json({ success: false, error: 'timeline required' });
    if (!VALID_DRIVERS.includes(driver))     return res.status(400).json({ success: false, error: 'invalid driver' });
    if (!VALID_TIMELINES.includes(timeline)) return res.status(400).json({ success: false, error: 'invalid timeline' });

    // Verify asset belongs to this account
    const asset = await prisma.asset.findFirst({
      where:  { id: assetId, accountId: req.user.accountId },
      select: { id: true },
    });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const emergencyMode = driver === 'down_now';

    // Assemble full dossier snapshot
    const dossierSnapshot = await buildDossier(assetId, req.user.accountId);

    const qr = await prisma.quoteRequest.create({
      data: {
        accountId:       req.user.accountId,
        assetId,
        requestedById:   req.user.id,
        driver,
        timeline,
        outageAvailable: outageAvailable != null ? Boolean(outageAvailable) : null,
        outageWindow:    outageWindow    ? String(outageWindow)    : null,
        budgeted:        budgeted        != null ? Boolean(budgeted) : null,
        budgetNotes:     budgetNotes     ? String(budgetNotes)     : null,
        attachmentNotes: attachmentNotes ? String(attachmentNotes) : null,
        notes:           notes           ? String(notes)           : null,
        emergencyMode,
        dossierSnapshot,
      },
      include: {
        asset:       { select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true } },
        requestedBy: { select: { id: true, name: true } },
        account:     { select: { serviceRepName: true, serviceRepEmail: true, serviceRepPhone: true } },
      },
    });

    return res.status(201).json({ success: true, data: qr });
  } catch (err) {
    console.error('[quoteRequests POST /]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── PATCH /api/quote-requests/:id/status ─────────────────────────────────
// Advance the lifecycle: quoted, accepted, declined (manager+ only)
router.patch('/:id/status', requireManager, async (req, res) => {
  try {
    const { status, quoteNotes, declineReason } = req.body;
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: `status must be one of ${VALID_STATUSES.join(', ')}` });
    }

    // Verify ownership
    const existing = await prisma.quoteRequest.findFirst({
      where:  { id: req.params.id, accountId: req.user.accountId },
      select: { id: true, status: true },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });

    const now = new Date();
    const updateData: any = { status };
    if (status === 'quoted')   { updateData.quotedAt = now; if (quoteNotes) updateData.quoteNotes = quoteNotes; }
    if (status === 'accepted' || status === 'declined') {
      updateData.respondedAt = now;
      if (status === 'declined' && declineReason) updateData.declineReason = declineReason;
    }

    const updated = await prisma.quoteRequest.update({
      where:   { id: req.params.id },
      data:    updateData,
      include: { asset: { select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true } } },
    });

    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[quoteRequests PATCH /:id/status]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

export {};
