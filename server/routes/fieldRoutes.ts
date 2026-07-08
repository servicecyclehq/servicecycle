/**
 * /api/field — Field Mode endpoints for technicians on a phone.
 *
 *   GET  /api/field/summary                       — the tech's "My Day"
 *   GET  /api/field/asset/:id                     — the field card a QR lands on
 *   GET  /api/field/assignments                   — the sub's "My Jobs" (assigned WOs)
 *   POST /api/field/work-orders/:id/measurements  — record a NETA reading
 *   POST /api/field/work-orders/:id/complete      — mark an assigned WO complete
 *   POST /api/field/deficiencies                  — report a finding
 *
 * FIELD-LABOR SCOPE. Any authenticated role may use these (the person holding
 * the phone next to the switchgear is exactly who should). For the field_tech
 * (subcontractor) role every read and write is CLAMPED to the user's assigned
 * work — they see only assets reachable from work orders where
 * assignedUserId = their id, and may only write against those. Non-field_tech
 * roles keep the account-wide view. The scope helper lives in lib/fieldScope;
 * the role itself is default-denied off every other route by the boundary in
 * middleware/auth (see lib/fieldRoleScope). TENANCY: every query also filters
 * accountId = req.user.accountId — the hard tenant boundary, scope on top.
 *
 * Mounted behind authenticateToken in index.ts.
 */

const router = require('express').Router();
const prisma = require('../lib/prisma').default;
const { requireRole } = require('../middleware/roles');
const { getFieldAssignmentScope } = require('../lib/fieldScope');
const { parseVoiceReading, hintTokens } = require('../lib/voiceCapture');
const { regapIngestBusAfterDevice } = require('../lib/arcFlashDevice');
const { downloadFile } = require('../lib/storage');
const { decrypt } = require('../lib/docCrypto');
const { writeLog: writeActivityLog } = require('../lib/activityLog');
const { validatePinShapes } = require('../lib/documentAnnotations');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// NETA decal / per-measurement pass-fail ratings (mirrors the WorkOrder route).
const RESULT_RATINGS = ['GREEN', 'YELLOW', 'RED'];
// Convenience aliases accepted from the field UI + voice parser.
const PASSFAIL_ALIASES: Record<string, string> = {
  pass: 'GREEN', green: 'GREEN', ok: 'GREEN', normal: 'GREEN',
  marginal: 'YELLOW', yellow: 'YELLOW',
  fail: 'RED', red: 'RED',
};
function normalizePassFail(v: any): string | null | undefined {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (RESULT_RATINGS.includes(s)) return s;
  const mapped = PASSFAIL_ALIASES[s.toLowerCase()];
  return mapped || undefined; // undefined = invalid sentinel
}

// Slim asset shape shared by every summary list item — enough to render a
// recognizable card line ("SWITCHGEAR · Square D Model 6 · S/N 123 — Plant 2")
// and deep-link to /field/asset/:id, nothing more.
const FIELD_ASSET_SELECT = {
  id: true, equipmentType: true, manufacturer: true, model: true,
  serialNumber: true,
  site: { select: { id: true, name: true } },
};

// Same status taxonomy as lib/complianceReport (active schedules only here,
// so 'inactive' can't occur): unbaselined = no nextDueDate yet; otherwise
// overdue/current by comparison against now.
function scheduleStatus(nextDueDate, now) {
  if (!nextDueDate) return 'unbaselined';
  return nextDueDate < now ? 'overdue' : 'current';
}

// ─── GET /api/field/summary ───────────────────────────────────────────────────
// The tech's "My Day". Four capped lists, each item { asset, <specific> }:
//   overdue          — active schedules past due, most overdue first
//   dueSoon          — active schedules due within the next 30 days, soonest first
//   openWorkOrders   — SCHEDULED / IN_PROGRESS work orders, soonest scheduled first
//   openDeficiencies — unresolved findings, severity (IMMEDIATE→ADVISORY) then newest
// Optional ?siteId= narrows every list to one site (validated against the
// account). Archived assets are excluded everywhere.
router.get('/summary', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const { siteId } = req.query;
    const TAKE = 25;

    // Field-labor scope: a field_tech sees only assets reachable from their
    // assigned work orders; non-field_tech roles get the account-wide view.
    const scope = await getFieldAssignmentScope(prisma, req.user);

    if (siteId !== undefined) {
      if (!UUID_RE.test(String(siteId))) {
        return res.status(400).json({ success: false, error: 'siteId must be a uuid' });
      }
      const site = await prisma.site.findFirst({
        where: { id: String(siteId), accountId },
        select: { id: true },
      });
      if (!site) return res.status(404).json({ success: false, error: 'Site not found' });
    }

    const now = new Date();
    const soonCutoff = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // Asset-side filter applied to every list: live (non-archived) assets,
    // optionally narrowed to one site, and — for a field_tech — clamped to the
    // assets reachable from their assigned work (empty set ⇒ they see nothing).
    const assetFilter: any = { archivedAt: null };
    if (siteId) assetFilter.siteId = String(siteId);
    if (scope) assetFilter.id = { in: [...scope.assetIds] };

    const scheduleSelect = {
      id: true, nextDueDate: true,
      taskDefinition: { select: { taskName: true, requiresOutage: true } },
      asset: { select: FIELD_ASSET_SELECT },
    };

    const [overdueRows, dueSoonRows, workOrderRows, deficiencyRows] = await Promise.all([
      prisma.maintenanceSchedule.findMany({
        where: {
          accountId, isActive: true,
          nextDueDate: { lt: now },
          asset: assetFilter,
        },
        select: scheduleSelect,
        orderBy: { nextDueDate: 'asc' }, // most overdue first
        take: TAKE,
      }),
      prisma.maintenanceSchedule.findMany({
        where: {
          accountId, isActive: true,
          nextDueDate: { gte: now, lte: soonCutoff },
          asset: assetFilter,
        },
        select: scheduleSelect,
        orderBy: { nextDueDate: 'asc' }, // soonest first
        take: TAKE,
      }),
      prisma.workOrder.findMany({
        where: {
          accountId,
          status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
          asset: assetFilter,
          // field_tech: only their assigned jobs, never the whole board.
          ...(scope ? { assignedUserId: req.user.id } : {}),
        },
        select: {
          id: true, status: true, scheduledDate: true,
          schedule: { select: { taskDefinition: { select: { taskName: true } } } },
          asset: { select: FIELD_ASSET_SELECT },
        },
        // Soonest scheduled first; Postgres ASC puts unscheduled (null) last.
        orderBy: { scheduledDate: 'asc' },
        take: TAKE,
      }),
      prisma.deficiency.findMany({
        where: {
          accountId,
          resolvedAt: null,
          asset: assetFilter,
        },
        select: {
          id: true, severity: true, description: true, createdAt: true,
          asset: { select: FIELD_ASSET_SELECT },
        },
        // Severity band first (enum declaration order IMMEDIATE → ADVISORY),
        // newest within each band — same triage ordering as /api/deficiencies.
        orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
        take: TAKE,
      }),
    ]);

    res.json({
      success: true,
      data: {
        overdue: overdueRows.map((s) => ({
          asset: s.asset,
          schedule: { id: s.id, nextDueDate: s.nextDueDate, taskDefinition: s.taskDefinition },
        })),
        dueSoon: dueSoonRows.map((s) => ({
          asset: s.asset,
          schedule: { id: s.id, nextDueDate: s.nextDueDate, taskDefinition: s.taskDefinition },
        })),
        openWorkOrders: workOrderRows.map((wo) => ({
          asset: wo.asset,
          workOrder: {
            id: wo.id, status: wo.status, scheduledDate: wo.scheduledDate,
            taskName: wo.schedule?.taskDefinition?.taskName ?? null,
          },
        })),
        openDeficiencies: deficiencyRows.map((d) => ({
          asset: d.asset,
          deficiency: { id: d.id, severity: d.severity, description: d.description, createdAt: d.createdAt },
        })),
      },
    });
  } catch (err) {
    console.error('Field summary error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch field summary' });
  }
});

// ─── GET /api/field/asset/:id ─────────────────────────────────────────────────
// The field card payload — what a tech sees after scanning the QR label on
// the equipment. ONE prisma query (nested includes), slim selects throughout.
//
// Returns:
//   asset            — identity + location (site, position), condition axes +
//                      governingCondition, owner name, fedFrom (upstream
//                      source, slim), downstreamCount (_count.feedsDownstream)
//   activeSchedules  — isActive only, each with status current|overdue|
//                      unbaselined, taskDefinition {taskName, requiresOutage,
//                      standardRef}, nextDueDate, lastCompletedDate
//   openDeficiencies — id, severity, description
//   openWorkOrders   — id, status, taskName (from the schedule's task def)
router.get('/asset/:id', async (req, res) => {
  try {
    // Field-labor scope: a field_tech may only open an asset that one of their
    // assigned work orders points at. Deny with 404 (not 403) so the card
    // can't be used to probe which assets exist outside their assignment.
    const scope = await getFieldAssignmentScope(prisma, req.user);
    if (scope && !scope.assetIds.has(req.params.id)) {
      return res.status(404).json({ success: false, error: 'Asset not found' });
    }

    const asset = await prisma.asset.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      select: {
        id: true, equipmentType: true, manufacturer: true, model: true,
        serialNumber: true, installDate: true,
        conditionPhysical: true, conditionCriticality: true, conditionEnvironment: true,
        governingCondition: true,
        inService: true, isEnergized: true,
        site:     { select: { id: true, name: true } },
        position: { select: { id: true, name: true, code: true } },
        owner:    { select: { id: true, name: true } },
        fedFrom:  { select: { id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true } },
        _count:   { select: { feedsDownstream: true } },
        schedules: {
          where: { isActive: true },
          select: {
            id: true, nextDueDate: true, lastCompletedDate: true,
            taskDefinition: { select: { taskName: true, requiresOutage: true, standardRef: true } },
          },
          orderBy: { nextDueDate: 'asc' },
        },
        deficiencies: {
          where: { resolvedAt: null },
          select: { id: true, severity: true, description: true },
          orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
        },
        workOrders: {
          where: { status: { in: ['SCHEDULED', 'IN_PROGRESS'] } },
          select: {
            id: true, status: true,
            schedule: { select: { taskDefinition: { select: { taskName: true } } } },
          },
          orderBy: { scheduledDate: 'asc' },
        },
      },
    });

    if (!asset) {
      return res.status(404).json({ success: false, error: 'Asset not found' });
    }

    // Documents attached to this asset — surfaced so a field tech can pull up
    // the one-line / manuals / LOTO / test reports right from the asset card or
    // a QR scan. Slim shape only; bytes are fetched via the scoped download
    // route below (the storage key is never exposed to the client).
    const siteIdForDocs = asset.site?.id || null;
    const docRows = await prisma.document.findMany({
      where:   { accountId: req.user.accountId, OR: [{ assetId: asset.id }, ...(siteIdForDocs ? [{ siteId: siteIdForDocs }] : [])] },
      select:  { id: true, filename: true, docType: true, provenance: true, fileType: true, externalUrl: true, filePath: true, uploadedAt: true, siteId: true },
      orderBy: [{ uploadedAt: 'desc' }],
    });
    const documents = docRows.map((d) => ({
      id: d.id, filename: d.filename, docType: d.docType, provenance: d.provenance, fileType: d.fileType, uploadedAt: d.uploadedAt,
      scope: d.siteId ? 'site' : 'asset',
      external: d.filePath === '__external__',
      externalUrl: d.filePath === '__external__' ? d.externalUrl : null,
    }));

    const now = new Date();
    const { schedules, deficiencies, workOrders, _count, ...assetFields } = asset;

    res.json({
      success: true,
      data: {
        asset: { ...assetFields, downstreamCount: _count?.feedsDownstream ?? 0 },
        activeSchedules: schedules.map((s) => ({
          id: s.id,
          status: scheduleStatus(s.nextDueDate, now),
          nextDueDate: s.nextDueDate,
          lastCompletedDate: s.lastCompletedDate,
          taskDefinition: s.taskDefinition,
        })),
        openDeficiencies: deficiencies,
        openWorkOrders: workOrders.map((wo) => ({
          id: wo.id,
          status: wo.status,
          taskName: wo.schedule?.taskDefinition?.taskName ?? null,
        })),
        documents,
      },
    });
  } catch (err) {
    console.error('Field asset card error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch asset' });
  }
});

// ─── GET /api/field/asset/:assetId/document/:documentId ───────────────────────
// Field-safe document download. field_tech is default-denied on /api/documents,
// so this is their ONLY path to a file — and it re-checks assignment scope:
//   field_tech → the asset MUST be in their assignment scope
//   manager+   → any asset in the account
// Streams the (decrypted) bytes for stored docs; returns the link for external
// URL-only docs. accountId is the hard tenant boundary; archived assets blocked.
router.get('/asset/:assetId/document/:documentId', async (req, res) => {
  try {
    const scope = await getFieldAssignmentScope(prisma, req.user);
    if (scope && !scope.assetIds.has(req.params.assetId)) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }
    const reqAsset = await prisma.asset.findFirst({
      where: { id: req.params.assetId, accountId: req.user.accountId, archivedAt: null },
      select: { id: true, siteId: true },
    });
    if (!reqAsset) return res.status(404).json({ success: false, error: 'Document not found' });
    const doc = await prisma.document.findFirst({
      where: {
        id:        req.params.documentId,
        accountId: req.user.accountId,
        OR: [{ assetId: reqAsset.id }, ...(reqAsset.siteId ? [{ siteId: reqAsset.siteId }] : [])],
      },
    });
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });

    // External URL-only document — hand back the link; the client opens it.
    if (doc.filePath === '__external__') {
      return res.json({ success: true, data: { external: true, externalUrl: doc.externalUrl } });
    }

    let buf = await downloadFile(doc.filePath, req.user.accountId);
    if (doc.encrypted) buf = decrypt(buf, doc.id);

    const safeAscii = (doc.filename || 'document').replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    const rfc5987   = encodeURIComponent(doc.filename || 'document');
    res.set('Content-Type',           doc.fileType || 'application/octet-stream');
    res.set('Content-Disposition',    `attachment; filename="${safeAscii}"; filename*=UTF-8''${rfc5987}`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Length',         buf.length);
    res.set('Cache-Control',          'private, no-store');

    writeActivityLog({
      assetId: doc.assetId || null,
      userId:  req.user.id,
      action:  'document_accessed',
      details: { documentId: doc.id, filename: doc.filename, method: 'field-stream' },
    });

    // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- safe: explicit Content-Type from doc.fileType (upload MIME allowlist + magic-byte check); buf is a decrypted file buffer, not user HTML.
    return res.send(buf);
  } catch (err) {
    console.error('[field document download]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to retrieve document' });
  }
});

// ─── Scoped write surface ─────────────────────────────────────────────────────
// The field-labor (field_tech) role is default-denied on the global
// /api/work-orders + /api/deficiencies routes (those are manager-gated and
// would also leak the whole board). These /api/field write endpoints are the
// sub's ONLY way to record work, and every one re-checks assignment scope:
//   field_tech  → the target work order/asset MUST belong to their assignment
//   manager+    → any work order/asset in the account (Field Mode on a phone)
// accountId is the hard tenant boundary in both cases.

// RBAC (2026-07-03 acquisition scan, Scan 3): consultant is read-only-with-
// attribution by design (see middleware/roles.ts header -- the SPA banner
// promises "changes are logged", the server must enforce read-only). It used
// to pass every /api/field write account-wide: complete work orders, log
// deficiencies, create ProtectiveDevice rows. Every MUTATING field endpoint
// now carries this gate; it 403s consultant AND the cross-account read-only
// roles (oem_admin / group_admin / super_admin) exactly like every other
// write path in the app (the requireRole exclusion pattern documented in
// middleware/roles.ts). GET endpoints and POST /voice/parse (parse-only,
// persists nothing) are untouched, so consultant read flows keep working.
const requireFieldWriter = requireRole(['admin', 'manager', 'viewer', 'field_tech']);

// Resolve a work order the caller may act on, honouring field-labor scope.
// Returns the work order row (id, status, assetId) or null (404-worthy).
async function resolveScopedWorkOrder(user, workOrderId) {
  const where: any = { id: workOrderId, accountId: user.accountId };
  if (user.role === 'field_tech') where.assignedUserId = user.id;
  return prisma.workOrder.findFirst({
    where,
    select: { id: true, status: true, assetId: true },
  });
}

// ─── GET /api/field/assignments ───────────────────────────────────────────────
// The sub's "My Jobs": open work orders assigned to the caller (assignedUserId
// = me), newest-scheduled first. Same shape for every role — it always means
// "assigned to me" — so a manager who isn't assigned simply sees an empty list.
router.get('/assignments', async (req, res) => {
  try {
    const rows = await prisma.workOrder.findMany({
      where: {
        accountId:      req.user.accountId,
        assignedUserId: req.user.id,
        status:         { in: ['SCHEDULED', 'IN_PROGRESS'] },
      },
      select: {
        id: true, status: true, scheduledDate: true,
        schedule: { select: { taskDefinition: { select: { taskName: true } } } },
        asset: { select: FIELD_ASSET_SELECT },
      },
      orderBy: { scheduledDate: 'asc' },
      take: 100,
    });
    res.json({
      success: true,
      data: {
        assignments: rows.map((wo) => ({
          id: wo.id, status: wo.status, scheduledDate: wo.scheduledDate,
          taskName: wo.schedule?.taskDefinition?.taskName ?? null,
          asset: wo.asset,
        })),
      },
    });
  } catch (err) {
    console.error('Field assignments error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch assignments' });
  }
});

// Validate a single measurement payload (focused subset of the WorkOrder
// route's validator — the field form/voice submit one reading at a time).
function buildFieldMeasurement(accountId, workOrderId, raw) {
  if (!raw || typeof raw !== 'object') return { error: 'measurement must be an object' };
  const { measurementType, phase, asFoundValue, asFoundUnit, asLeftValue, asLeftUnit, passFail, notes } = raw;
  if (!measurementType || typeof measurementType !== 'string' || !measurementType.trim()) {
    return { error: 'measurementType is required' };
  }
  const pf = normalizePassFail(passFail);
  if (pf === undefined) return { error: `passFail must be one of ${RESULT_RATINGS.join(', ')} (or pass/fail)` };
  const num = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isNaN(n) ? undefined : n;
  };
  const found = num(asFoundValue);
  const left  = num(asLeftValue);
  if (found === undefined || left === undefined) return { error: 'asFoundValue/asLeftValue must be numeric' };
  return {
    data: {
      accountId, workOrderId,
      measurementType: measurementType.trim(),
      phase:        phase || null,
      asFoundValue: found,
      asFoundUnit:  asFoundUnit || null,
      asLeftValue:  left,
      asLeftUnit:   asLeftUnit || null,
      passFail:     pf || null,
      notes:        notes || null,
    },
  };
}

// ─── POST /api/field/work-orders/:id/measurements ─────────────────────────────
// Record a NETA test measurement against an assigned work order.
router.post('/work-orders/:id/measurements', requireFieldWriter, async (req, res) => {
  try {
    if (!UUID_RE.test(String(req.params.id))) {
      return res.status(400).json({ success: false, error: 'id must be a uuid' });
    }
    const wo = await resolveScopedWorkOrder(req.user, req.params.id);
    if (!wo) return res.status(404).json({ success: false, error: 'Work order not found' });

    const built = buildFieldMeasurement(req.user.accountId, wo.id, req.body);
    if (built.error) return res.status(400).json({ success: false, error: built.error });

    const measurement = await prisma.testMeasurement.create({ data: built.data });
    res.status(201).json({ success: true, data: { measurement } });
  } catch (err) {
    console.error('Field measurement error:', err);
    res.status(500).json({ success: false, error: 'Failed to record measurement' });
  }
});

// ─── POST /api/field/work-orders/:id/complete ─────────────────────────────────
// Mark an assigned work order COMPLETE. Optional asLeftCondition (C1/C2/C3).
const CONDITION_RATINGS = ['C1', 'C2', 'C3'];
router.post('/work-orders/:id/complete', requireFieldWriter, async (req, res) => {
  try {
    if (!UUID_RE.test(String(req.params.id))) {
      return res.status(400).json({ success: false, error: 'id must be a uuid' });
    }
    const wo = await resolveScopedWorkOrder(req.user, req.params.id);
    if (!wo) return res.status(404).json({ success: false, error: 'Work order not found' });

    const data: any = { status: 'COMPLETE', completedDate: new Date() };
    if (req.body?.asLeftCondition != null && req.body.asLeftCondition !== '') {
      if (!CONDITION_RATINGS.includes(req.body.asLeftCondition)) {
        return res.status(400).json({ success: false, error: `asLeftCondition must be one of ${CONDITION_RATINGS.join(', ')}` });
      }
      data.asLeftCondition = req.body.asLeftCondition;
    }
    if (typeof req.body?.notes === 'string' && req.body.notes.trim()) data.notes = req.body.notes.trim();

    const updated = await prisma.workOrder.update({
      where: { id: wo.id },
      select: { id: true, status: true, completedDate: true, asLeftCondition: true },
      data,
    });
    res.json({ success: true, data: { workOrder: updated } });
  } catch (err) {
    console.error('Field work-order complete error:', err);
    res.status(500).json({ success: false, error: 'Failed to complete work order' });
  }
});

// ─── GET/POST /api/field/work-orders/:id/comments ─────────────────────────────
// A4 (2026-07-05) field-labor mirror of routes/workOrders.ts's comment feed --
// same WorkOrderComment table, scoped via resolveScopedWorkOrder so a
// field_tech only sees/posts on their own assigned work orders. Edit/delete
// are intentionally NOT mirrored here for v1 (manager-only, via the main
// /api/work-orders/comments/:cid surface) -- a tech leaving a note shouldn't
// need to revise history; moderation stays a manager action.
router.get('/work-orders/:id/comments', async (req, res) => {
  try {
    if (!UUID_RE.test(String(req.params.id))) {
      return res.status(400).json({ success: false, error: 'id must be a uuid' });
    }
    const wo = await resolveScopedWorkOrder(req.user, req.params.id);
    if (!wo) return res.status(404).json({ success: false, error: 'Work order not found' });

    const comments = await prisma.workOrderComment.findMany({
      where:   { workOrderId: wo.id, accountId: req.user.accountId, deletedAt: null },
      include: { author: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ success: true, data: { comments } });
  } catch (err) {
    console.error('Field list comments error:', err);
    res.status(500).json({ success: false, error: 'Failed to list comments' });
  }
});

router.post('/work-orders/:id/comments', requireFieldWriter, async (req, res) => {
  try {
    if (!UUID_RE.test(String(req.params.id))) {
      return res.status(400).json({ success: false, error: 'id must be a uuid' });
    }
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ success: false, error: 'body is required' });
    if (body.length > 4000) {
      return res.status(400).json({ success: false, error: 'body must be 4000 characters or fewer' });
    }

    const wo = await resolveScopedWorkOrder(req.user, req.params.id);
    if (!wo) return res.status(404).json({ success: false, error: 'Work order not found' });

    const comment = await prisma.workOrderComment.create({
      data: {
        accountId:   req.user.accountId,
        workOrderId: wo.id,
        authorId:    req.user.id,
        body,
      },
      include: { author: { select: { id: true, name: true } } },
    });

    writeActivityLog({
      accountId: req.user.accountId,
      userId:    req.user.id,
      action:    'work_order_comment_added',
      details:   { commentId: comment.id, workOrderId: wo.id },
    }).catch(() => {});

    res.status(201).json({ success: true, data: { comment } });
  } catch (err) {
    console.error('Field add comment error:', err);
    res.status(500).json({ success: false, error: 'Failed to add comment' });
  }
});

// ─── Document annotations, scoped to the tech's own assigned work ───────────
// [2026-07-06] Dustin, live: field techs should be able to leave notes on
// their own job's documents. routes/documents.ts's annotation endpoints are
// manager-gated AND live under /api/documents, which field_tech is
// default-denied on entirely (lib/fieldRoleScope.ts) -- opening that whole
// path would expose every other /api/documents route to field_tech, not just
// annotations. Instead this mirrors the /work-orders/:id/comments pattern
// directly above: a field-scoped endpoint that only reaches a document tied
// to a work order the tech is actually assigned to (documentId AND
// workOrderId must both match), reusing the exact same shape validation as
// the manager-facing route (lib/documentAnnotations.ts). Edit/delete are
// intentionally NOT mirrored here for v1 -- same call as WorkOrderComment
// above: a tech leaving a note shouldn't need to revise history, moderation
// stays a manager action via the main /api/documents/annotations surface.
async function resolveScopedWorkOrderDocument(user, workOrderId, documentId) {
  const wo = await resolveScopedWorkOrder(user, workOrderId);
  if (!wo) return { wo: null, doc: null };
  const doc = await prisma.document.findFirst({
    where: { id: documentId, accountId: user.accountId, workOrderId: wo.id },
    select: { id: true },
  });
  return { wo, doc };
}

router.get('/work-orders/:id/documents/:documentId/annotations', async (req, res) => {
  try {
    if (!UUID_RE.test(String(req.params.id)) || !UUID_RE.test(String(req.params.documentId))) {
      return res.status(400).json({ success: false, error: 'id and documentId must be uuids' });
    }
    const { wo, doc } = await resolveScopedWorkOrderDocument(req.user, req.params.id, req.params.documentId);
    if (!wo) return res.status(404).json({ success: false, error: 'Work order not found' });
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });

    const annotations = await prisma.documentAnnotation.findMany({
      where:   { documentId: doc.id, accountId: req.user.accountId, deletedAt: null },
      include: { author: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ success: true, data: { annotations } });
  } catch (err) {
    console.error('Field list document annotations error:', err);
    res.status(500).json({ success: false, error: 'Failed to list annotations' });
  }
});

router.post('/work-orders/:id/documents/:documentId/annotations', requireFieldWriter, async (req, res) => {
  try {
    if (!UUID_RE.test(String(req.params.id)) || !UUID_RE.test(String(req.params.documentId))) {
      return res.status(400).json({ success: false, error: 'id and documentId must be uuids' });
    }
    const { wo, doc } = await resolveScopedWorkOrderDocument(req.user, req.params.id, req.params.documentId);
    if (!wo) return res.status(404).json({ success: false, error: 'Work order not found' });
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });

    const validated = validatePinShapes(req.body?.shapes);
    if (validated.error) return res.status(400).json({ success: false, error: validated.error });

    const annotation = await prisma.documentAnnotation.create({
      data: {
        accountId:  req.user.accountId,
        documentId: doc.id,
        authorId:   req.user.id,
        shapes:     validated.shapes,
      },
      include: { author: { select: { id: true, name: true } } },
    });

    writeActivityLog({
      accountId: req.user.accountId,
      userId:    req.user.id,
      action:    'document_annotation_added',
      details:   { annotationId: annotation.id, documentId: doc.id, workOrderId: wo.id, method: 'field' },
    }).catch(() => {});

    res.status(201).json({ success: true, data: { annotation } });
  } catch (err) {
    console.error('Field add document annotation error:', err);
    res.status(500).json({ success: false, error: 'Failed to create annotation' });
  }
});

// ─── POST /api/field/deficiencies ─────────────────────────────────────────────
// Report a finding against an in-scope asset.
const SEVERITIES = ['IMMEDIATE', 'RECOMMENDED', 'ADVISORY'];
router.post('/deficiencies', requireFieldWriter, async (req, res) => {
  try {
    const { assetId, severity, description, correctiveAction } = req.body || {};
    if (!assetId || !UUID_RE.test(String(assetId))) {
      return res.status(400).json({ success: false, error: 'assetId (uuid) is required' });
    }
    if (!SEVERITIES.includes(severity)) {
      return res.status(400).json({ success: false, error: `severity must be one of ${SEVERITIES.join(', ')}` });
    }
    if (!description || typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({ success: false, error: 'description is required' });
    }

    // Scope: field_tech may only report on an asset in their assignment set;
    // manager+ on any account asset. Always re-check account ownership.
    const scope = await getFieldAssignmentScope(prisma, req.user);
    if (scope && !scope.assetIds.has(String(assetId))) {
      return res.status(404).json({ success: false, error: 'Asset not found' });
    }
    const asset = await prisma.asset.findFirst({
      where: { id: String(assetId), accountId: req.user.accountId, archivedAt: null },
      select: { id: true },
    });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const deficiency = await prisma.deficiency.create({
      data: {
        accountId:        req.user.accountId,
        assetId:          asset.id,
        severity,
        description:      description.trim(),
        correctiveAction: typeof correctiveAction === 'string' && correctiveAction.trim() ? correctiveAction.trim() : null,
      },
      select: { id: true, severity: true, description: true, createdAt: true },
    });
    res.status(201).json({ success: true, data: { deficiency } });
  } catch (err) {
    console.error('Field deficiency error:', err);
    res.status(500).json({ success: false, error: 'Failed to report deficiency' });
  }
});

// ─── POST /api/field/voice/parse ──────────────────────────────────────────────
// Frictionless voice capture. The phone transcribes speech with the browser's
// Web Speech API and POSTs the TEXT here; we parse it into a structured
// measurement PROPOSAL and (best-effort) match the spoken asset within the
// caller's scope. The client pre-fills the measurement form from the proposal
// and the tech CONFIRMS before saving — we never auto-write from a voice guess.
//
// Body: { transcript: string, assetId?: uuid }
//   - assetId given (e.g. the tech is already on the QR-scanned card): we attach
//     that asset's open, in-scope work orders so the reading has a target.
//   - no assetId: we match proposal.assetHint against the caller's SCOPED
//     inventory and return candidate assets to choose from.
const VOICE_FIELD_ASSET_SELECT = {
  id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true,
  site:     { select: { id: true, name: true } },
  position: { select: { name: true, code: true } },
};
router.post('/voice/parse', async (req, res) => {
  try {
    const { transcript, assetId } = req.body || {};
    if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
      return res.status(400).json({ success: false, error: 'transcript is required' });
    }
    if (transcript.length > 2000) {
      return res.status(400).json({ success: false, error: 'transcript too long' });
    }

    const proposal = parseVoiceReading(transcript);
    const scope = await getFieldAssignmentScope(prisma, req.user);

    // Open work orders on `assetId` the caller may write to (scope-aware).
    async function openWorkOrdersFor(aid) {
      const where: any = { accountId: req.user.accountId, assetId: aid, status: { in: ['SCHEDULED', 'IN_PROGRESS'] } };
      if (scope) where.assignedUserId = req.user.id;
      const wos = await prisma.workOrder.findMany({
        where,
        select: { id: true, status: true, schedule: { select: { taskDefinition: { select: { taskName: true } } } } },
        orderBy: { scheduledDate: 'asc' },
        take: 10,
      });
      return wos.map((w) => ({ id: w.id, status: w.status, taskName: w.schedule?.taskDefinition?.taskName ?? null }));
    }

    let asset: any = null;
    let candidates: any[] = [];

    if (assetId !== undefined && assetId !== null && assetId !== '') {
      if (!UUID_RE.test(String(assetId))) {
        return res.status(400).json({ success: false, error: 'assetId must be a uuid' });
      }
      if (scope && !scope.assetIds.has(String(assetId))) {
        return res.status(404).json({ success: false, error: 'Asset not found' });
      }
      asset = await prisma.asset.findFirst({
        where:  { id: String(assetId), accountId: req.user.accountId, archivedAt: null },
        select: VOICE_FIELD_ASSET_SELECT,
      });
      if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
      asset.openWorkOrders = await openWorkOrdersFor(asset.id);
    } else if (proposal.assetHint) {
      const toks = hintTokens(proposal.assetHint);
      if (toks.length) {
        const orConds: any[] = [];
        for (const t of toks) {
          orConds.push({ serialNumber: { contains: t, mode: 'insensitive' } });
          orConds.push({ model:        { contains: t, mode: 'insensitive' } });
          orConds.push({ manufacturer: { contains: t, mode: 'insensitive' } });
          orConds.push({ position: { name: { contains: t, mode: 'insensitive' } } });
          orConds.push({ position: { code: { contains: t, mode: 'insensitive' } } });
        }
        const where: any = { accountId: req.user.accountId, archivedAt: null, OR: orConds };
        if (scope) where.id = { in: [...scope.assetIds] };
        candidates = await prisma.asset.findMany({ where, select: VOICE_FIELD_ASSET_SELECT, take: 5 });
        // Exactly one match → resolve it directly so the client can save in one tap.
        if (candidates.length === 1) {
          asset = candidates[0];
          asset.openWorkOrders = await openWorkOrdersFor(asset.id);
          candidates = [];
        }
      }
    }

    res.json({ success: true, data: { proposal, asset, candidates } });
  } catch (err) {
    console.error('Field voice parse error:', err);
    res.status(500).json({ success: false, error: 'Failed to parse voice reading' });
  }
});

// ─── Arc-flash field collection (Slice 2.7) ───────────────────────────────────
// The invasive part of an arc-flash study — opening equipment to read the
// upstream device + trip settings + feeder cable — done on the phone by the
// assigned tech. Same scope rule as the rest of /api/field: field_tech sees/acts
// on only their assigned tasks; manager+ gets the account-wide view.
const FIELD_DEVICE_TYPES = new Set(['breaker', 'fuse', 'relay', 'switch']);
const afClean = (v: any) => { if (v == null) return null; const s = String(v).trim(); return s ? s.slice(0, 200) : null; };
const afNum = (v: any) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
function fieldTaskOut(t: any) {
  return {
    id: t.id, siteId: t.siteId, ingestId: t.ingestId, ingestBusId: t.ingestBusId, busName: t.busName,
    instructions: t.instructions, neededFields: t.neededFields, status: t.status, hazardClass: t.hazardClass,
    ppeNote: t.ppeNote, requiresOutage: t.requiresOutage, requiresQualifiedPerson: t.requiresQualifiedPerson,
    assignedUserId: t.assignedUserId, collectedDeviceId: t.collectedDeviceId, collectedAt: t.collectedAt, createdAt: t.createdAt,
  };
}

// ─── GET /api/field/arc-flash/tasks ──────────────────────────────────────────
// The tech's open collection tasks. field_tech → only tasks assigned to them.
router.get('/arc-flash/tasks', async (req, res) => {
  try {
    const where: any = { accountId: req.user.accountId };
    if (req.user.role === 'field_tech') where.assignedUserId = req.user.id;
    where.status = req.query.status ? String(req.query.status) : { not: 'cancelled' };
    if (req.query.siteId) where.siteId = String(req.query.siteId);
    const rows = await prisma.arcFlashCollectionTask.findMany({ where, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 200 });
    res.json({ success: true, data: { tasks: rows.map(fieldTaskOut) } });
  } catch (err) {
    console.error('Field arc-flash tasks error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch collection tasks' });
  }
});

// ─── POST /api/field/arc-flash/tasks/:id/collect ─────────────────────────────
// Record the collected device (+ optional feeder cable). Creates a durable
// ProtectiveDevice, marks the task collected, and re-gaps the linked ingest bus
// so a blocked bus moves toward ready. field_tech clamped to assigned tasks.
router.post('/arc-flash/tasks/:id/collect', requireFieldWriter, async (req, res) => {
  try {
    const where: any = { id: req.params.id, accountId: req.user.accountId };
    if (req.user.role === 'field_tech') where.assignedUserId = req.user.id;
    const task = await prisma.arcFlashCollectionTask.findFirst({ where });
    if (!task) return res.status(404).json({ success: false, error: 'Task not found' });
    if (task.status === 'collected') return res.status(409).json({ success: false, error: 'Task already collected' });

    const b = req.body || {};
    const dev = (b.device && typeof b.device === 'object') ? b.device : {};
    let deviceType: string | null = null;
    if (dev.deviceType != null && dev.deviceType !== '') {
      const dt = String(dev.deviceType).toLowerCase();
      if (!FIELD_DEVICE_TYPES.has(dt)) return res.status(400).json({ success: false, error: 'device.deviceType must be one of breaker, fuse, relay, switch' });
      deviceType = dt;
    }
    const hasSettings = dev.settings && typeof dev.settings === 'object' && Object.keys(dev.settings).length > 0;

    const device = await prisma.protectiveDevice.create({
      data: {
        accountId: req.user.accountId, siteId: task.siteId, assetId: task.assetId || null, ingestBusId: task.ingestBusId || null,
        label: afClean(dev.label) || `${task.busName} upstream device`,
        deviceType, manufacturer: afClean(dev.manufacturer), model: afClean(dev.model), partNumber: afClean(dev.partNumber),
        frameRatingA: afNum(dev.frameRatingA), sensorRatingA: afNum(dev.sensorRatingA),
        settings: hasSettings ? dev.settings : undefined, photoKey: afClean(dev.photoKey),
        source: 'field', collectedById: req.user.id, settingsCollectedAt: hasSettings ? new Date() : null,
      },
    });

    await prisma.arcFlashCollectionTask.update({
      where: { id: task.id },
      data: { status: 'collected', collectedDeviceId: device.id, collectedById: req.user.id, collectedAt: new Date() },
    });

    let regap: any = null;
    if (task.ingestBusId) {
      try { regap = await regapIngestBusAfterDevice(prisma, task.ingestBusId, { device, cable: b.cable || {} }); }
      catch (e: any) { console.error('field collect re-gap error:', e?.message); }
    }

    res.json({
      success: true,
      data: { deviceId: device.id, taskId: task.id, status: 'collected', readiness: regap ? regap.readiness : null, confidence: regap ? regap.confidence : null },
    });
  } catch (err) {
    console.error('Field arc-flash collect error:', err);
    res.status(500).json({ success: false, error: 'Failed to record collection' });
  }
});

module.exports = router;

export {};
