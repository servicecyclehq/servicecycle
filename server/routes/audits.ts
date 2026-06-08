'use strict';

/**
 * /api/audits — audit-visit tracker.
 *
 * First-class records of audits: insurance loss-control visits, OSHA
 * inspections, internal pre-audit walkthroughs, customer/AHJ audits — plus
 * the recommendations (RECs) they produce. RECs mirror the carrier
 * workflow: written response expected within 30–45 days, completion
 * tracked, consequences escalate.
 *
 *   GET    /                       — list audit visits (filters + pagination)
 *   GET    /recommendations        — account-wide REC list (filters + pagination)
 *   GET    /:id                    — one visit + RECs + linked snapshots
 *   POST   /                       — create a visit (manager+)
 *   PUT    /:id                    — update a visit (manager+)
 *   POST   /:id/recommendations    — add a REC to a visit (manager+)
 *   PUT    /recommendations/:rid   — edit a REC / status transitions (manager+)
 *   POST   /:id/snapshots          — generate a compliance snapshot for the
 *                                    visit's site, linked via auditVisitId (manager+)
 *
 * NOTE FOR THE MOUNTER: GET /recommendations is registered BEFORE GET /:id
 * on purpose — Express matches in registration order and '/recommendations'
 * would otherwise be swallowed by '/:id'. Keep that ordering.
 *
 * Snapshot generation reuses lib/snapshotPipeline.generateSnapshot — the
 * exact render → sha256 → store → row → audit-anchor sequence the
 * compliance routes use. No anchor logic is duplicated here.
 *
 * Mounted behind authenticateToken in index.ts. Every query filters
 * accountId = req.user.accountId.
 */

const router = require('express').Router();
const prisma = require('../lib/prisma').default;
const { requireManager } = require('../middleware/roles');
const { writeLog: writeActivityLog } = require('../lib/activityLog');
const { generateSnapshot } = require('../lib/snapshotPipeline');

// ── vocab ─────────────────────────────────────────────────────────────────────

const AUDIT_TYPES    = ['insurance', 'osha', 'internal_preaudit', 'customer', 'ahj'];
const OUTCOMES       = ['passed', 'passed_with_findings', 'failed', 'pending'];
const REC_SOURCES    = ['insurer', 'osha', 'internal', 'customer', 'ahj'];
const REC_SEVERITIES = ['mandatory', 'recommendation'];
const REC_STATUSES   = ['open', 'responded', 'completed', 'declined'];

// ── helpers ───────────────────────────────────────────────────────────────────

// Parse an optional date body field. Returns:
//   undefined — field absent (leave unchanged)
//   null      — explicit clear
//   Date      — parsed value
//   { error } — unparseable
function parseDateField(v, fieldName) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return { error: `${fieldName} must be a valid date.` };
  return d;
}

function pagination(req) {
  const page  = Math.max(1, parseInt(String(req.query.page  || '1'),  10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
}

// Validate + collect visit fields from a request body. `partial` controls
// whether absent fields are skipped (PUT) or defaulted (POST).
// Returns { data } or { error }.
async function buildVisitData(req, { partial }) {
  const body = req.body || {};
  const data: any = {};

  if (!partial || body.auditType !== undefined) {
    if (!body.auditType || !AUDIT_TYPES.includes(String(body.auditType))) {
      return { error: `auditType must be one of ${AUDIT_TYPES.join(', ')}` };
    }
    data.auditType = String(body.auditType);
  }

  if (body.siteId !== undefined) {
    if (body.siteId === null || body.siteId === '') {
      data.siteId = null; // account-wide audit
    } else {
      const site = await prisma.site.findFirst({
        where:  { id: String(body.siteId), accountId: req.user.accountId },
        select: { id: true },
      });
      if (!site) return { error: 'Site not found', status: 404 };
      data.siteId = site.id;
    }
  }

  if (body.auditorName !== undefined) data.auditorName = body.auditorName ? String(body.auditorName).trim() : null;
  if (body.auditorOrg  !== undefined) data.auditorOrg  = body.auditorOrg  ? String(body.auditorOrg).trim()  : null;
  if (body.notes       !== undefined) data.notes       = body.notes       ? String(body.notes)              : null;

  for (const f of ['scheduledDate', 'performedDate']) {
    const parsed = parseDateField(body[f], f);
    if (parsed && (parsed as any).error) return { error: (parsed as any).error };
    if (parsed !== undefined) data[f] = parsed;
  }

  if (body.outcome !== undefined) {
    if (body.outcome === null || body.outcome === '') {
      data.outcome = null;
    } else if (!OUTCOMES.includes(String(body.outcome))) {
      return { error: `outcome must be one of ${OUTCOMES.join(', ')}` };
    } else {
      data.outcome = String(body.outcome);
    }
  }

  return { data };
}

const visitDetailInclude = {
  site: { select: { id: true, name: true } },
  recommendations: {
    orderBy: [{ dueDate: { sort: 'asc' as const, nulls: 'last' as const } }, { createdAt: 'asc' as const }],
    include: { assignedTo: { select: { id: true, name: true } } },
  },
  snapshots: {
    orderBy: { createdAt: 'desc' as const },
    select:  { id: true, filename: true, sha256: true, createdAt: true, kind: true },
  },
};

// ── GET / ─────────────────────────────────────────────────────────────────────
// List audit visits. Filters: auditType, siteId, outcome. Newest
// performedDate first, falling back to scheduledDate (nulls last on both).

router.get('/', async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req);

    const where: any = { accountId: req.user.accountId };
    if (req.query.auditType !== undefined) {
      const t = String(req.query.auditType);
      if (!AUDIT_TYPES.includes(t)) {
        return res.status(400).json({ success: false, error: `auditType must be one of ${AUDIT_TYPES.join(', ')}` });
      }
      where.auditType = t;
    }
    if (req.query.outcome !== undefined) {
      const o = String(req.query.outcome);
      if (!OUTCOMES.includes(o)) {
        return res.status(400).json({ success: false, error: `outcome must be one of ${OUTCOMES.join(', ')}` });
      }
      where.outcome = o;
    }
    if (req.query.siteId) {
      const sid = String(req.query.siteId);
      const site = await prisma.site.findFirst({ where: { id: sid, accountId: req.user.accountId } });
      if (!site) return res.status(400).json({ success: false, error: 'siteId not found' });
      where.siteId = sid;
    }

    const [rows, total] = await Promise.all([
      prisma.auditVisit.findMany({
        where,
        orderBy: [
          { performedDate: { sort: 'desc', nulls: 'last' } },
          { scheduledDate: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
        skip,
        take: limit,
        include: {
          site:            { select: { id: true, name: true } },
          recommendations: { select: { status: true } },
          _count:          { select: { snapshots: true } },
        },
      }),
      prisma.auditVisit.count({ where }),
    ]);

    const visits = rows.map((v) => {
      const recCounts = { open: 0, responded: 0, completed: 0, declined: 0, total: v.recommendations.length };
      for (const r of v.recommendations) {
        if (recCounts[r.status] !== undefined) recCounts[r.status] += 1;
      }
      return {
        id:            v.id,
        auditType:     v.auditType,
        siteId:        v.siteId,
        siteName:      v.site ? v.site.name : null, // null = account-wide
        auditorName:   v.auditorName,
        auditorOrg:    v.auditorOrg,
        scheduledDate: v.scheduledDate,
        performedDate: v.performedDate,
        outcome:       v.outcome,
        notes:         v.notes,
        recommendationCounts: recCounts,
        snapshotCount: v._count.snapshots,
        createdAt:     v.createdAt,
        updatedAt:     v.updatedAt,
      };
    });

    return res.json({
      success: true,
      data: {
        visits,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (err) {
    console.error('[audits:list]', err);
    return res.status(500).json({ success: false, error: 'Failed to list audit visits.' });
  }
});

// ── GET /recommendations ──────────────────────────────────────────────────────
// Account-wide REC list across all visits. MUST stay registered before
// GET /:id (see file header). Filters:
//   status   — open | responded | completed | declined
//   severity — mandatory | recommendation
//   overdue  — 'true': dueDate < now AND status not completed/declined
// Sort: dueDate asc, nulls last (the response-deadline queue ordering).

router.get('/recommendations', async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req);

    const where: any = { accountId: req.user.accountId };
    if (req.query.status !== undefined) {
      const s = String(req.query.status);
      if (!REC_STATUSES.includes(s)) {
        return res.status(400).json({ success: false, error: `status must be one of ${REC_STATUSES.join(', ')}` });
      }
      where.status = s;
    }
    if (req.query.severity !== undefined) {
      const s = String(req.query.severity);
      if (!REC_SEVERITIES.includes(s)) {
        return res.status(400).json({ success: false, error: `severity must be one of ${REC_SEVERITIES.join(', ')}` });
      }
      where.severity = s;
    }
    if (String(req.query.overdue || '') === 'true') {
      where.dueDate = { lt: new Date() };
      where.status  = where.status !== undefined
        ? where.status // explicit status filter wins (still ANDed with dueDate)
        : { notIn: ['completed', 'declined'] };
    }

    const [rows, total] = await Promise.all([
      prisma.auditRecommendation.findMany({
        where,
        orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        skip,
        take: limit,
        include: {
          assignedTo: { select: { id: true, name: true } },
          auditVisit: {
            select: {
              id: true, auditType: true, auditorOrg: true, performedDate: true,
              site: { select: { id: true, name: true } },
            },
          },
        },
      }),
      prisma.auditRecommendation.count({ where }),
    ]);

    const recommendations = rows.map((r) => ({
      id:            r.id,
      auditVisitId:  r.auditVisitId,
      auditVisit:    r.auditVisit
        ? {
            id:            r.auditVisit.id,
            auditType:     r.auditVisit.auditType,
            auditorOrg:    r.auditVisit.auditorOrg,
            performedDate: r.auditVisit.performedDate,
            siteName:      r.auditVisit.site ? r.auditVisit.site.name : null,
          }
        : null,
      source:         r.source,
      severity:       r.severity,
      description:    r.description,
      dueDate:        r.dueDate,
      status:         r.status,
      responseNotes:  r.responseNotes,
      respondedAt:    r.respondedAt,
      completedAt:    r.completedAt,
      assignedTo:     r.assignedTo, // { id, name } | null
      createdAt:      r.createdAt,
      updatedAt:      r.updatedAt,
    }));

    return res.json({
      success: true,
      data: {
        recommendations,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (err) {
    console.error('[audits/recommendations:list]', err);
    return res.status(500).json({ success: false, error: 'Failed to list recommendations.' });
  }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
// One visit with its recommendations (incl. assignee names) and linked
// hash-anchored snapshots.

router.get('/:id', async (req, res) => {
  try {
    const v = await prisma.auditVisit.findFirst({
      where:   { id: req.params.id, accountId: req.user.accountId },
      include: visitDetailInclude,
    });
    if (!v) return res.status(404).json({ success: false, error: 'Audit visit not found' });

    return res.json({
      success: true,
      data: {
        visit: {
          id:            v.id,
          auditType:     v.auditType,
          siteId:        v.siteId,
          siteName:      v.site ? v.site.name : null,
          auditorName:   v.auditorName,
          auditorOrg:    v.auditorOrg,
          scheduledDate: v.scheduledDate,
          performedDate: v.performedDate,
          outcome:       v.outcome,
          notes:         v.notes,
          recommendations: v.recommendations.map((r) => ({
            id:            r.id,
            source:        r.source,
            severity:      r.severity,
            description:   r.description,
            dueDate:       r.dueDate,
            status:        r.status,
            responseNotes: r.responseNotes,
            respondedAt:   r.respondedAt,
            completedAt:   r.completedAt,
            assignedTo:    r.assignedTo, // { id, name } | null
            createdAt:     r.createdAt,
            updatedAt:     r.updatedAt,
          })),
          snapshots: v.snapshots, // [{ id, filename, sha256, createdAt, kind }]
          createdAt: v.createdAt,
          updatedAt: v.updatedAt,
        },
      },
    });
  } catch (err) {
    console.error('[audits:get]', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch audit visit.' });
  }
});

// ── POST / ────────────────────────────────────────────────────────────────────
// Create a visit. auditType required; siteId optional (ownership-checked,
// null = account-wide); outcome optional.

router.post('/', requireManager, async (req, res) => {
  try {
    const built = await buildVisitData(req, { partial: false });
    if (built.error) {
      return res.status(built.status || 400).json({ success: false, error: built.error });
    }

    const visit = await prisma.auditVisit.create({
      data: {
        accountId: req.user.accountId,
        ...built.data,
      },
      include: { site: { select: { id: true, name: true } } },
    });

    writeActivityLog({
      assetId:   null,
      userId:    req.user.id,
      accountId: req.user.accountId,
      action:    'audit_visit_created',
      details: {
        auditVisitId: visit.id,
        auditType:    visit.auditType,
        siteId:       visit.siteId,
        outcome:      visit.outcome,
      },
    });

    return res.status(201).json({ success: true, data: { visit } });
  } catch (err) {
    console.error('[audits:create]', err);
    return res.status(500).json({ success: false, error: 'Failed to create audit visit.' });
  }
});

// ── PUT /:id ──────────────────────────────────────────────────────────────────
// Update the same fields; partial — absent fields are left unchanged.

router.put('/:id', requireManager, async (req, res) => {
  try {
    const existing = await prisma.auditVisit.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Audit visit not found' });

    const built = await buildVisitData(req, { partial: true });
    if (built.error) {
      return res.status(built.status || 400).json({ success: false, error: built.error });
    }
    if (Object.keys(built.data).length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update.' });
    }

    const visit = await prisma.auditVisit.update({
      where:   { id: existing.id },
      data:    built.data,
      include: { site: { select: { id: true, name: true } } },
    });

    writeActivityLog({
      assetId:   null,
      userId:    req.user.id,
      accountId: req.user.accountId,
      action:    'audit_visit_updated',
      details: {
        auditVisitId: visit.id,
        fields:       Object.keys(built.data),
        outcome:      visit.outcome,
      },
    });

    return res.json({ success: true, data: { visit } });
  } catch (err) {
    console.error('[audits:update]', err);
    return res.status(500).json({ success: false, error: 'Failed to update audit visit.' });
  }
});

// ── POST /:id/recommendations ─────────────────────────────────────────────────
// Add a REC to a visit. description required; assignedToUserId, when set,
// must be a user in the same account.

router.post('/:id/recommendations', requireManager, async (req, res) => {
  try {
    const visit = await prisma.auditVisit.findFirst({
      where:  { id: req.params.id, accountId: req.user.accountId },
      select: { id: true },
    });
    if (!visit) return res.status(404).json({ success: false, error: 'Audit visit not found' });

    const body = req.body || {};

    const source = body.source !== undefined && body.source !== null && body.source !== ''
      ? String(body.source) : 'insurer';
    if (!REC_SOURCES.includes(source)) {
      return res.status(400).json({ success: false, error: `source must be one of ${REC_SOURCES.join(', ')}` });
    }

    const severity = body.severity !== undefined && body.severity !== null && body.severity !== ''
      ? String(body.severity) : 'recommendation';
    if (!REC_SEVERITIES.includes(severity)) {
      return res.status(400).json({ success: false, error: `severity must be one of ${REC_SEVERITIES.join(', ')}` });
    }

    if (!body.description || !String(body.description).trim()) {
      return res.status(400).json({ success: false, error: 'description is required' });
    }

    const dueDate = parseDateField(body.dueDate, 'dueDate');
    if (dueDate && (dueDate as any).error) {
      return res.status(400).json({ success: false, error: (dueDate as any).error });
    }

    let assignedToUserId = null;
    if (body.assignedToUserId !== undefined && body.assignedToUserId !== null && body.assignedToUserId !== '') {
      const user = await prisma.user.findFirst({
        where:  { id: String(body.assignedToUserId), accountId: req.user.accountId },
        select: { id: true },
      });
      if (!user) return res.status(404).json({ success: false, error: 'Assignee user not found in this account.' });
      assignedToUserId = user.id;
    }

    const recommendation = await prisma.auditRecommendation.create({
      data: {
        accountId:    req.user.accountId,
        auditVisitId: visit.id,
        source,
        severity,
        description:  String(body.description).trim(),
        dueDate:      dueDate === undefined ? null : dueDate,
        assignedToUserId,
        // status defaults to 'open' at the schema layer
      },
      include: { assignedTo: { select: { id: true, name: true } } },
    });

    return res.status(201).json({ success: true, data: { recommendation } });
  } catch (err) {
    console.error('[audits/recommendations:create]', err);
    return res.status(500).json({ success: false, error: 'Failed to create recommendation.' });
  }
});

// ── PUT /recommendations/:rid ─────────────────────────────────────────────────
// Edit fields + the explicit status lifecycle. Allowed transitions:
//   open      → responded   (requires responseNotes; stamps respondedAt)
//   responded → completed   (stamps completedAt)
//   open      → completed   (stamps completedAt)
//   any       → declined    (requires responseNotes)
// Anything else is a 400 — completed/declined are terminal except for the
// any→declined path, and timestamps are stamped server-side, never from the
// body.

router.put('/recommendations/:rid', requireManager, async (req, res) => {
  try {
    const existing = await prisma.auditRecommendation.findFirst({
      where: { id: req.params.rid, accountId: req.user.accountId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Recommendation not found' });

    const body = req.body || {};
    const data: any = {};

    if (body.source !== undefined) {
      if (!REC_SOURCES.includes(String(body.source))) {
        return res.status(400).json({ success: false, error: `source must be one of ${REC_SOURCES.join(', ')}` });
      }
      data.source = String(body.source);
    }
    if (body.severity !== undefined) {
      if (!REC_SEVERITIES.includes(String(body.severity))) {
        return res.status(400).json({ success: false, error: `severity must be one of ${REC_SEVERITIES.join(', ')}` });
      }
      data.severity = String(body.severity);
    }
    if (body.description !== undefined) {
      if (!body.description || !String(body.description).trim()) {
        return res.status(400).json({ success: false, error: 'description cannot be blank' });
      }
      data.description = String(body.description).trim();
    }
    const dueDate = parseDateField(body.dueDate, 'dueDate');
    if (dueDate && (dueDate as any).error) {
      return res.status(400).json({ success: false, error: (dueDate as any).error });
    }
    if (dueDate !== undefined) data.dueDate = dueDate;

    if (body.assignedToUserId !== undefined) {
      if (body.assignedToUserId === null || body.assignedToUserId === '') {
        data.assignedToUserId = null;
      } else {
        const user = await prisma.user.findFirst({
          where:  { id: String(body.assignedToUserId), accountId: req.user.accountId },
          select: { id: true },
        });
        if (!user) return res.status(404).json({ success: false, error: 'Assignee user not found in this account.' });
        data.assignedToUserId = user.id;
      }
    }

    if (body.responseNotes !== undefined) {
      data.responseNotes = body.responseNotes ? String(body.responseNotes) : null;
    }

    // ── status transition ──
    let statusChange = null; // { from, to }
    if (body.status !== undefined && body.status !== existing.status) {
      const to = String(body.status);
      if (!REC_STATUSES.includes(to)) {
        return res.status(400).json({ success: false, error: `status must be one of ${REC_STATUSES.join(', ')}` });
      }
      const from = existing.status;

      // The responseNotes that will hold AFTER this update.
      const effectiveNotes =
        data.responseNotes !== undefined ? data.responseNotes : existing.responseNotes;

      if (from === 'open' && to === 'responded') {
        if (!effectiveNotes || !String(effectiveNotes).trim()) {
          return res.status(400).json({ success: false, error: 'responseNotes is required to mark a recommendation responded.' });
        }
        data.status      = to;
        data.respondedAt = new Date();
      } else if ((from === 'responded' || from === 'open') && to === 'completed') {
        data.status      = to;
        data.completedAt = new Date();
      } else if (to === 'declined') {
        if (!effectiveNotes || !String(effectiveNotes).trim()) {
          return res.status(400).json({ success: false, error: 'responseNotes is required to decline a recommendation.' });
        }
        data.status = to;
      } else {
        return res.status(400).json({
          success: false,
          error: `Invalid status transition ${from} → ${to}. Allowed: open→responded, open→completed, responded→completed, any→declined.`,
        });
      }
      statusChange = { from, to };
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update.' });
    }

    const recommendation = await prisma.auditRecommendation.update({
      where:   { id: existing.id },
      data,
      include: { assignedTo: { select: { id: true, name: true } } },
    });

    if (statusChange) {
      writeActivityLog({
        assetId:   null,
        userId:    req.user.id,
        accountId: req.user.accountId,
        action:    'audit_rec_status_changed',
        details: {
          recommendationId: existing.id,
          auditVisitId:     existing.auditVisitId,
          from:             statusChange.from,
          to:               statusChange.to,
        },
      });
    }

    return res.json({ success: true, data: { recommendation } });
  } catch (err) {
    console.error('[audits/recommendations:update]', err);
    return res.status(500).json({ success: false, error: 'Failed to update recommendation.' });
  }
});

// ── POST /:id/snapshots ───────────────────────────────────────────────────────
// Convenience: generate a compliance snapshot scoped to the visit's site
// (account-wide when the visit has no site), linked back via auditVisitId.
// Body: { standardCode? } — null = all standards. Runs through the shared
// pipeline, so the PDF's SHA-256 lands in the tamper-evident audit log
// exactly like POST /api/compliance/snapshots.

router.post('/:id/snapshots', requireManager, async (req, res) => {
  try {
    const visit = await prisma.auditVisit.findFirst({
      where:  { id: req.params.id, accountId: req.user.accountId },
      select: { id: true, siteId: true },
    });
    if (!visit) return res.status(404).json({ success: false, error: 'Audit visit not found' });

    const body = req.body || {};
    const standardCode = body.standardCode ? String(body.standardCode).trim() : null;

    const { snapshot, site } = await generateSnapshot(prisma, {
      accountId:    req.user.accountId,
      userId:       req.user.id,
      userName:     req.user.name || null,
      standardCode,
      siteId:       visit.siteId, // null = account-wide audit → all sites
      kind:         'compliance',
      auditVisitId: visit.id,
    });

    return res.status(201).json({
      success: true,
      data: {
        snapshot: {
          id:           snapshot.id,
          createdAt:    snapshot.createdAt,
          standardCode: snapshot.standardCode,
          siteId:       snapshot.siteId,
          siteName:     site ? site.name : null,
          kind:         snapshot.kind,
          auditVisitId: snapshot.auditVisitId,
          filename:     snapshot.filename,
          sizeBytes:    snapshot.sizeBytes,
          sha256:       snapshot.sha256,
          stats:        snapshot.stats,
        },
      },
    });
  } catch (err) {
    if (err && err.code === 'SITE_NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Site not found.' });
    }
    if (err && err.code === 'STANDARD_NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Standard not found.' });
    }
    if (err && err.code === 'NO_DATA') {
      return res.status(422).json({ success: false, error: err.message });
    }
    if (err && err.code === 'ANCHOR_FAILED') {
      return res.status(500).json({ success: false, error: err.message });
    }
    console.error('[audits:snapshot]', err);
    return res.status(500).json({ success: false, error: 'Failed to generate snapshot for audit visit.' });
  }
});

module.exports = router;

export {};
