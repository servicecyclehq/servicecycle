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
 * 5 standard questions (finalised for demo/test):
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
const { requireManager, requireRole, requireViewer } = require('../middleware/roles');
const prisma = require('../lib/prisma').default;

// Internal account users (incl. read-only viewers who legitimately raise a
// service request from an asset) may create/send a quote. EXCLUDES the external
// read-only `consultant` (the "Vendor Access — Changes are logged" banner
// promises read-only) and the cross-account roles (oem_admin/group_admin/
// super_admin), which have no write business inside a customer account.
// field_tech is already denied upstream at the auth chokepoint (fieldRoleScope).
const requireQuoteWriter = requireRole(['admin', 'manager', 'viewer']);

// ── Helpers ────────────────────────────────────────────────────────────────

const VALID_DRIVERS   = ['down_now','suspected_failing','failed_inspection','planned_replacement','budgetary'];
const VALID_TIMELINES = ['immediately','within_1_week','within_30_days','next_budget_cycle'];
// Rep lifecycle transition targets (PATCH /:id/status). 'draft' is NOT here — a
// draft is created via POST {draft:true} and promoted via POST /:id/send only.
const VALID_STATUSES  = ['requested','quoted','accepted','declined'];
// Statuses a caller may FILTER the list by (GET ?status=) — includes 'draft'.
const VALID_FILTER_STATUSES = [...VALID_STATUSES, 'draft', 'active', 'resolved'];

/**
 * Fire the contractor-facing QUOTE_REQUEST_CREATED partner event (inbox/webhook,
 * enriched with B2 talking points) for a quote that has actually been SENT.
 * Detached/fire-and-forget so it never slows the response, and account-scoped.
 * Shared by the non-draft create path and the draft /send path. `qr` must carry
 * its `asset` relation; pass the stored dossierSnapshot for the CapEx estimate.
 */
function emitQuoteCreatedEvent(accountId: string, qr: any, dossierSnapshot: any) {
  const { emitPartnerEvent } = require('../lib/partnerEvents');
  const { buildAccountTalkingPoints } = require('../lib/portfolioRank');
  const ss = dossierSnapshot ?? {};
  const basePayload = {
    quoteRequestId: qr.id,
    assetId: qr.assetId,
    assetName: qr.asset
      ? `${qr.asset.manufacturer ?? ''} ${qr.asset.model ?? ''}`.trim() || `Asset ${String(qr.assetId).slice(0, 8)}`
      : 'Asset',
    triggerType:  qr.triggerType ?? null,
    estimatedMin: ss.estimatedCapExMin ?? null,
    estimatedMax: ss.estimatedCapExMax ?? null,
  };
  (async () => {
    let contractorContext: any = null;
    try {
      const tp = await buildAccountTalkingPoints(prisma, accountId);
      if (tp) {
        contractorContext = {
          rank: tp.rank ?? null,
          rankOf: tp.rankOf ?? null,
          portfolioPercentile: tp.portfolioPercentile ?? null,
          maturityLevel: tp.detail?.maturityLevel ?? null,
          maturityLevelLabel: tp.detail?.maturityLevelLabel ?? null,
          discussionPoints: (tp.discussionPoints || []).map((p: any) => ({ severity: p.severity, text: p.text })),
        };
      }
    } catch (e: any) {
      console.error('[quoteRequests talking-points]', e?.message || e);
    }
    emitPartnerEvent(accountId, 'QUOTE_REQUEST_CREATED', { ...basePayload, contractorContext }).catch(console.error);
  })();
}

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

  // Active LOTO procedure — included so the service rep knows whether a formal
  // isolation procedure exists before quoting service work on this asset.
  const activeLoto = await prisma.lotoProc.findFirst({
    where:   { assetId, accountId, status: 'active' },
    select:  { id: true, title: true, version: true, approvedAt: true,
                _count: { select: { energySources: true, steps: true } } },
  });

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
    loto: activeLoto ? {
      id:            activeLoto.id,
      title:         activeLoto.title,
      version:       activeLoto.version,
      approvedAt:    activeLoto.approvedAt,
      energySourceCount: activeLoto._count.energySources,
      stepCount:         activeLoto._count.steps,
    } : null,
    snapshotAt: now.toISOString(),
  };
}

// ── GET /api/quote-requests ────────────────────────────────────────────────
// Account-wide list; filter by status, assetId, or emergencyMode
// PEN-7-4: field_tech excluded — financial dossier data is not their concern.
router.get('/', requireViewer, async (req, res) => {
  try {
    const { status, assetId, emergency, page = 1, limit = 50 } = req.query;
    const take = Math.min(Math.max(parseInt(limit as string) || 50, 1), 200);
    const skip = (Math.max(parseInt(page as string) || 1, 1) - 1) * take;

    const where: any = { accountId: req.user.accountId };
    if (status) {
      const s = String(status);
      if (!VALID_FILTER_STATUSES.includes(s)) return res.status(400).json({ success: false, error: 'invalid status' });
      if (s === 'active')        where.status = { in: ['requested', 'quoted', 'draft'] };
      else if (s === 'resolved') where.status = { in: ['accepted', 'declined'] };
      else                       where.status = s;
    }
    if (assetId)   where.assetId = String(assetId);
    if (emergency === 'true') where.emergencyMode = true;

    const monthStart = new Date();
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    const [items, total, resolvedThisMonth] = await Promise.all([
      prisma.quoteRequest.findMany({
        where,
        include: {
          asset:       { select: { id: true, manufacturer: true, model: true, serialNumber: true,
                                   equipmentType: true, criticalityScore: true,
                                   site: { select: { id: true, name: true } } } },
          requestedBy: { select: { id: true, name: true } },
        },
        orderBy: [{ emergencyMode: 'desc' }, { createdAt: 'desc' }],
        skip, take,
      }),
      prisma.quoteRequest.count({ where }),
      prisma.quoteRequest.count({
        where: { accountId: req.user.accountId, status: { in: ['accepted', 'declined'] }, resolvedAt: { gte: monthStart } },
      }),
    ]);

    // Match the canonical paginated-list shape used by assets/work-orders/
    // deficiencies: the collection and pagination both live INSIDE data, and
    // pagination carries page/limit/total/pages. (Area 4 response-shape sweep.)
    return res.json({
      success: true,
      data: {
        quoteRequests: items,
        pagination: { page: parseInt(page as string) || 1, limit: take, total, pages: Math.ceil(total / take) },
        resolvedThisMonth,
      },
    });
  } catch (err) {
    console.error('[quoteRequests GET /]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── GET /api/quote-requests/:id ────────────────────────────────────────────
router.get('/:id', requireViewer, async (req, res) => {
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
router.get('/asset/:assetId', requireViewer, async (req, res) => {
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
// Write gate: internal users incl. viewer; consultant + cross-account roles 403.
router.post('/', requireQuoteWriter, async (req, res) => {
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
      draft,
    } = req.body;
    // Draft = saved by the customer but NOT sent: persisted with status 'draft',
    // no rep notification / partner event until POST /:id/send.
    const isDraft = draft === true || draft === 'true';

    if (!assetId)  return res.status(400).json({ success: false, error: 'assetId required' });
    if (!driver)   return res.status(400).json({ success: false, error: 'driver required' });
    if (!timeline) return res.status(400).json({ success: false, error: 'timeline required' });
    if (!VALID_DRIVERS.includes(driver))     return res.status(400).json({ success: false, error: 'invalid driver' });
    if (!VALID_TIMELINES.includes(timeline)) return res.status(400).json({ success: false, error: 'invalid timeline' });

    // Verify asset belongs to this account; also fetch priorityScore for DPS auto-priority
    const asset = await prisma.asset.findFirst({
      where:  { id: assetId, accountId: req.user.accountId },
      select: { id: true, priorityScore: true },
    });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const emergencyMode = driver === 'down_now';

    // Auto-derive quote priority from asset DPS (priorityScore = conditionScore × criticalityScore).
    // emergency mode always maps to 'emergency' regardless of DPS.
    function dpsToPriority(dps: number | null): string | null {
      if (dps === null) return null;
      if (dps >= 20) return 'emergency';
      if (dps >= 16) return 'high';
      if (dps >= 10) return 'normal';
      return 'low';
    }
    const priority = emergencyMode ? 'emergency' : dpsToPriority(asset.priorityScore);

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
        priority:        priority ?? undefined,
        status:          isDraft ? 'draft' : undefined,
        dossierSnapshot,
      },
      include: {
        asset:       { select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true } },
        requestedBy: { select: { id: true, name: true } },
        account:     { select: { serviceRepName: true, serviceRepEmail: true, serviceRepPhone: true } },
      },
    });

    // Fire the contractor-facing event ONLY for a sent (non-draft) request.
    // Drafts stay silent until POST /:id/send.
    if (!isDraft) emitQuoteCreatedEvent(req.user.accountId, qr, dossierSnapshot);

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
      select: { id: true, status: true, assetId: true, resolvedAt: true },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });

    const now = new Date();
    const updateData: any = { status };
    if (status === 'quoted')   { updateData.quotedAt = now; if (quoteNotes) updateData.quoteNotes = quoteNotes; }
    if (status === 'accepted' || status === 'declined') {
      updateData.respondedAt = now;
      // resolvedAt: terminal state reached — stamp once, never overwrite.
      if (!existing.resolvedAt) updateData.resolvedAt = now;
      if (status === 'declined' && declineReason) updateData.declineReason = declineReason;
    }

    const updated = await prisma.quoteRequest.update({
      where:   { id: req.params.id },
      data:    updateData,
      include: { asset: { select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true } } },
    });

    // #22 close the quote -> work -> green loop. On the first transition into
    // 'accepted', auto-create a work order bound to this quote (attribution)
    // and, when the asset has an active schedule, link the most-overdue one so
    // completing the WO rolls that schedule forward and clears compliance.
    let createdWorkOrder = null;
    if (status === 'accepted' && existing.status !== 'accepted') {
      try {
        // Idempotency (TOCTOU): two concurrent accepts both read existing.status
        // as not-accepted and would each create a work order. The find-then-create
        // below runs in a SERIALIZABLE transaction so Postgres SSI aborts the
        // loser (caught + logged), guaranteeing exactly one auto-WO per quote
        // even under double-submit. There is no DB unique constraint on
        // workOrder.quoteRequestId, so the isolation level is the guard.
        createdWorkOrder = await prisma.$transaction(async (tx: any) => {
          const already = await tx.workOrder.findFirst({
            where:  { accountId: req.user.accountId, quoteRequestId: existing.id },
            select: { id: true },
          });
          if (already) return null;
          // Prefer the most-overdue active schedule; else the soonest-due.
          const sched = await tx.maintenanceSchedule.findFirst({
            where:   { accountId: req.user.accountId, assetId: existing.assetId, isActive: true, nextDueDate: { not: null } },
            orderBy: { nextDueDate: 'asc' },
            select:  { id: true },
          });
          return tx.workOrder.create({
            data: {
              accountId:      req.user.accountId,
              assetId:        existing.assetId,
              scheduleId:     sched?.id ?? null,
              quoteRequestId: existing.id,
              status:         'SCHEDULED',
              scheduledDate:  now,
              notes:          `[quote:${existing.id}] Auto-created from accepted quote.`,
            },
            select: { id: true, status: true, scheduleId: true, scheduledDate: true },
          });
        }, { isolationLevel: 'Serializable' });
      } catch (woErr: any) {
        // Never fail the accept on the side-effect (incl. a serialization abort
        // when a concurrent request already created the WO).
        console.error('[quoteRequests accept->WO]', woErr?.message || woErr);
      }
    }

    // Tier-1 loop notify: close the pull loop — tell the team a quote moved.
    if (status === 'accepted' || status === 'declined') {
      try {
        const a: any = updated.asset;
        const assetLabel = a ? ([a.manufacturer, a.model].filter(Boolean).join(' ') || a.equipmentType || null) : null;
        const { notifyQuoteStatusChanged } = require('../lib/loopNotify');
        notifyQuoteStatusChanged(req.user.accountId, {
          status, quoteId: updated.id, assetId: existing.assetId,
          assetLabel, declineReason: (updated as any).declineReason || null,
        }).catch(() => {});
      } catch { /* never block the status response */ }
    }

    return res.json({ success: true, data: updated, workOrder: createdWorkOrder });
  } catch (err) {
    console.error('[quoteRequests PATCH /:id/status]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── POST /api/quote-requests/:id/send ────────────────────────────────────────
// Promote a saved DRAFT to a real (sent) request: status draft → requested,
// then fire the contractor-facing partner event. Same write gate as create:
// internal users incl. viewer; the external consultant + cross-account roles 403.
router.post('/:id/send', requireQuoteWriter, async (req, res) => {
  try {
    const existing = await prisma.quoteRequest.findFirst({
      where:  { id: req.params.id, accountId: req.user.accountId },
      select: { id: true, status: true },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });
    if (existing.status !== 'draft') {
      return res.status(400).json({ success: false, error: 'Only a draft can be sent' });
    }

    const qr = await prisma.quoteRequest.update({
      where:   { id: existing.id },
      data:    { status: 'requested' },
      include: {
        asset:       { select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true } },
        requestedBy: { select: { id: true, name: true } },
        account:     { select: { serviceRepName: true, serviceRepEmail: true, serviceRepPhone: true } },
      },
    });

    // Now that it's actually sent, notify the contractor pipeline.
    emitQuoteCreatedEvent(req.user.accountId, qr, (qr as any).dossierSnapshot);

    return res.json({ success: true, data: qr });
  } catch (err) {
    console.error('[quoteRequests POST /:id/send]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

export {};
