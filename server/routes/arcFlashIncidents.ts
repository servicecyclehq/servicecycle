/**
 * routes/arcFlashIncidents.ts
 * ────────────────────────────
 * Arc-flash incident / near-miss register.
 *
 * Endpoints:
 *
 *   GET  /api/arc-flash-incidents
 *     List incidents for the authenticated account. Optional query params:
 *       assetId  — filter to a specific asset
 *       siteId   — filter to a specific site
 *       status   — filter by status (open | reviewed | closed)
 *
 *   POST /api/arc-flash-incidents
 *     Log a new incident. Body fields: incidentType, occurredAt, description,
 *     siteId?, assetId?, busName?, injury?, injuryDetail?, ppeWorn?, workType?,
 *     oshaRecordable?, correctiveAction?, reportUrl?
 *     Optionally snapshots the current arc-flash label state if assetId is given.
 *
 *   PATCH /api/arc-flash-incidents/:id
 *     Update an existing incident. Accepts any subset of the POST fields plus
 *     status (to mark reviewed or closed) and investigationNotes (alias for
 *     correctiveAction).
 *
 * AUTH: all routes require the standard JWT token (authenticateToken is applied
 * at the mount point in index.ts). PATCH supports manager+ for status changes;
 * all roles may log an incident (field_tech included).
 *
 * TENANCY: every query scopes to req.user.accountId.
 */

import { Router } from 'express';
import prisma from '../lib/prisma';
const { requireManager, requireRole } = require('../middleware/roles');
const { writeLog: writeActivityLog } = require('../lib/activityLog');
const {
  INCIDENT_TYPES, WORK_TYPES, STATUSES, normEnum, incidentOut,
} = require('../lib/arcFlashIncident');
const { scoreBusConfidence, pickDeviceSource } = require('../lib/arcFlashConfidence');

const router: Router = Router();

// Fields whose value carries OSHA / liability weight — audited with before/after
// on every mutation so the contemporaneous injury record has an immutable trail.
const AUDITED_INCIDENT_FIELDS = [
  'incidentType', 'occurredAt', 'description', 'siteId', 'assetId', 'busName',
  'injury', 'injuryDetail', 'ppeWorn', 'workType', 'oshaRecordable',
  'correctiveAction', 'reportUrl', 'status', 'resolvedAt',
];

// JSON-safe scalar for the audit payload (Date -> ISO string).
function auditVal(v: any): any {
  return v instanceof Date ? v.toISOString() : v;
}

// ── GET /api/arc-flash-incidents ─────────────────────────────────────────────
router.get('/', async (req: any, res) => {
  try {
    const accountId = req.user.accountId;
    const { assetId, siteId, status } = req.query;

    const where: any = { accountId };
    if (assetId) where.assetId = String(assetId);
    if (siteId)  where.siteId  = String(siteId);
    if (status && STATUSES.includes(String(status))) where.status = String(status);

    const incidents = await prisma.arcFlashIncident.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });

    return res.json({ success: true, data: incidents.map(incidentOut) });
  } catch (err: any) {
    console.error('[arc-flash-incidents] GET / error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to list incidents' });
  }
});

// ── POST /api/arc-flash-incidents ─────────────────────────────────────────────
router.post('/', requireRole(['admin', 'manager', 'viewer']), async (req: any, res) => {
  try {
    const accountId = req.user.accountId;
    const {
      incidentType, occurredAt, description,
      siteId, assetId, busName,
      injury, injuryDetail, ppeWorn, workType,
      oshaRecordable, correctiveAction, reportUrl,
    } = req.body;

    if (!description || typeof description !== 'string') {
      return res.status(400).json({ success: false, error: 'description is required' });
    }

    // APPSEC-2: validate reportUrl if provided
    if (reportUrl && !/^https?:\/\/.{1,2000}$/.test(reportUrl)) {
      return res.status(400).json({ error: 'reportUrl must be a valid HTTP/HTTPS URL (max 2000 chars)' });
    }

    // Validate siteId belongs to this account if provided
    if (siteId) {
      const site = await prisma.site.findFirst({ where: { id: siteId, accountId } });
      if (!site) return res.status(400).json({ success: false, error: 'siteId not found' });
    }

    // Validate assetId belongs to this account if provided
    if (assetId) {
      const asset = await prisma.asset.findFirst({ where: { id: assetId, accountId } });
      if (!asset) return res.status(400).json({ success: false, error: 'assetId not found' });
    }

    // [LEGAL-8-1] Snapshot the CURRENT arc-flash data state at incident time so the
    // record self-documents "what did the label/study say at the moment this
    // happened?". The real durable model is SystemStudyAsset (there is no
    // ArcFlashLabel model); query it the same way the public-label portal does
    // (pick the current, non-superseded binding). Snapshot is best-effort — but a
    // failure is LOGGED, not silently swallowed, so a broken snapshot path surfaces.
    let studyStateSnapshot: any = null;
    if (assetId) {
      try {
        const { buildStudyStateSnapshot } = require('../lib/arcFlashIncident');
        const rows = await prisma.systemStudyAsset.findMany({
          where: { assetId, accountId },
          include: { study: { select: { performedDate: true, expiresAt: true, supersededById: true, peName: true, method: true, studyDateSource: true } } },
        });
        // Current binding: non-superseded study wins, then newest performedDate.
        const current = rows.slice().sort((a: any, b: any) => {
          const sa = a.study?.supersededById ? 0 : 1, sb = b.study?.supersededById ? 0 : 1;
          if (sa !== sb) return sb - sa;
          return new Date(b.study?.performedDate || 0).getTime() - new Date(a.study?.performedDate || 0).getTime();
        })[0] || null;
        if (current) {
          // [F-I1] Compute the same deterministic confidence score the Arc Flash
          // tab shows (GET /asset/:assetId) — previously this snapshot always
          // wrote confidenceScore/Band as null because nothing here ever attached
          // a `.confidence` object, silently discarding the signal the incident
          // record's own shape says it should capture.
          const assetRow = await prisma.asset.findFirst({ where: { id: assetId, accountId }, select: { equipmentType: true } });
          const [devices, tests] = await Promise.all([
            prisma.protectiveDevice.findMany({ where: { assetId, accountId, status: 'active' } }),
            prisma.deviceTestRecord.findMany({ where: { assetId, accountId }, take: 50 }),
          ]);
          // [2026-07-05 review fix] `assetRow` was fetched but never used --
          // the raw `current` row has no `equipmentTypeGuess`, so
          // `analyzeBusGaps` (inside scoreBusConfidence) always scored
          // completeness under the generic 'other' equipment family here,
          // even though `routes/arcFlashIngest.ts`'s sibling snapshot path
          // (`busFromStudyAssetRow`) correctly attaches it. That let this
          // incident-time confidence snapshot diverge from what the Arc
          // Flash tab showed at the same moment -- the exact mismatch F-I1
          // was meant to close, on a record meant for insurer/OSHA bundles.
          const confidence = scoreBusConfidence({
            bus: { ...current, equipmentTypeGuess: assetRow?.equipmentType },
            study: { performedDate: current.study?.performedDate, expiresAt: current.study?.expiresAt, superseded: !!current.study?.supersededById },
            deviceSource: pickDeviceSource(devices),
            driftFlagged: tests.some((t: any) => t.driftFlagged),
          });
          // buildStudyStateSnapshot reads study.superseded; SystemStudy exposes
          // supersededById — normalize so the snapshot's studySuperseded is correct.
          studyStateSnapshot = buildStudyStateSnapshot({
            ...current,
            confidence,
            study: current.study ? { ...current.study, superseded: !!current.study.supersededById } : null,
          });
        }
      } catch (err: any) {
        // Snapshot failure must not block incident logging, but it MUST be visible
        // — a silent null here destroys the post-incident evidentiary trail.
        console.error('[arc-flash-incidents] studyStateSnapshot failed for asset', assetId, ':', err?.message);
      }
    }

    const incident = await prisma.arcFlashIncident.create({
      data: {
        accountId,
        siteId:             siteId   || null,
        assetId:            assetId  || null,
        busName:            busName  || null,
        // [F-I3] An unrecognized incidentType string must not silently downgrade
        // to 'near_miss' — the least-severe classification. 'other' is the
        // honest "we don't know the category" bucket already in INCIDENT_TYPES.
        incidentType:       normEnum(incidentType, INCIDENT_TYPES, 'other'),
        occurredAt:         occurredAt ? new Date(occurredAt) : null,
        description:        description.trim(),
        injury:             injury === true || injury === 'true',
        injuryDetail:       injuryDetail  || null,
        ppeWorn:            ppeWorn       || null,
        workType:           workType ? normEnum(workType, WORK_TYPES, 'other') : null,
        oshaRecordable:     oshaRecordable == null ? null : (oshaRecordable === true || oshaRecordable === 'true'),
        correctiveAction:   correctiveAction || null,
        reportUrl:          reportUrl || null,
        studyStateSnapshot: studyStateSnapshot,
        status:             'open',
        reportedById:       req.user.id,
      },
    });

    // [LEGAL-8-4 / LEGAL-8-9] Append-only audit of the logged incident. The
    // energization (workType) and OSHA-recordable determinations are recorded as
    // UNVERIFIED single-person entry (no second-person attestation gate exists),
    // so the audit explicitly marks them unattested and records who entered them.
    // Routed through ActivityLog so the tamper-evident hash chain commits to the
    // values (LEGAL-8-6).
    writeActivityLog({
      accountId,
      userId: req.user.id,
      assetId: incident.assetId || null,
      action: 'arc_flash_incident_logged',
      details: {
        incidentId:   incident.id,
        enteredBy:    req.user.id,
        incidentType: incident.incidentType,
        occurredAt:   auditVal(incident.occurredAt),
        injury:       incident.injury,
        oshaRecordable: incident.oshaRecordable,
        workType:     incident.workType,
        busName:      incident.busName,
        // The classification fields below were asserted by a single user with no
        // qualified-person / second-person sign-off — flagged so a reviewer (or a
        // diligence/insurer bundle) can see they are unverified.
        classificationUnverified: true,
        studyStateSnapshot: incident.studyStateSnapshot || null,
      },
    });

    return res.status(201).json({ success: true, data: incidentOut(incident) });
  } catch (err: any) {
    console.error('[arc-flash-incidents] POST / error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to log incident' });
  }
});

// ── PATCH /api/arc-flash-incidents/:id ───────────────────────────────────────
// Status changes (reviewed/closed) require manager+.
router.patch('/:id', requireManager, async (req: any, res) => {
  try {
    const accountId = req.user.accountId;
    const { id }    = req.params;

    const existing = await prisma.arcFlashIncident.findFirst({ where: { id, accountId } });
    if (!existing) return res.status(404).json({ success: false, error: 'Incident not found' });

    const {
      incidentType, occurredAt, description,
      siteId, assetId, busName,
      injury, injuryDetail, ppeWorn, workType,
      oshaRecordable, correctiveAction, reportUrl,
      status,
      investigationNotes, // alias for correctiveAction
    } = req.body;

    // APPSEC-2: validate reportUrl if provided
    if (reportUrl && !/^https?:\/\/.{1,2000}$/.test(reportUrl)) {
      return res.status(400).json({ error: 'reportUrl must be a valid HTTP/HTTPS URL (max 2000 chars)' });
    }

    // Ownership (2026-07-03 acquisition scan, Scan 3): a supplied siteId/assetId
    // must belong to this account -- mirrors the POST checks above. PATCH
    // previously wrote these FKs unchecked (cross-tenant FK write). Clearing a
    // field (null / '') intentionally skips the lookup, same truthy semantics
    // as POST.
    if (siteId) {
      const site = await prisma.site.findFirst({ where: { id: siteId, accountId } });
      if (!site) return res.status(400).json({ success: false, error: 'siteId not found' });
    }
    if (assetId) {
      const asset = await prisma.asset.findFirst({ where: { id: assetId, accountId } });
      if (!asset) return res.status(400).json({ success: false, error: 'assetId not found' });
    }

    const data: any = {};
    if (incidentType  !== undefined) data.incidentType  = normEnum(incidentType, INCIDENT_TYPES, existing.incidentType as string);
    if (occurredAt    !== undefined) data.occurredAt    = occurredAt ? new Date(occurredAt) : null;
    if (description   !== undefined) data.description   = String(description).trim();
    if (siteId        !== undefined) data.siteId        = siteId || null;
    if (assetId       !== undefined) data.assetId       = assetId || null;
    if (busName       !== undefined) data.busName       = busName || null;
    if (injury        !== undefined) data.injury        = injury === true || injury === 'true';
    if (injuryDetail  !== undefined) data.injuryDetail  = injuryDetail || null;
    if (ppeWorn       !== undefined) data.ppeWorn       = ppeWorn || null;
    if (workType      !== undefined) data.workType      = workType ? normEnum(workType, WORK_TYPES, 'other') : null;
    if (oshaRecordable !== undefined) data.oshaRecordable = oshaRecordable == null ? null : (oshaRecordable === true || oshaRecordable === 'true');
    // investigationNotes is a UI alias for correctiveAction
    const notes = investigationNotes !== undefined ? investigationNotes : correctiveAction;
    if (notes         !== undefined) data.correctiveAction = notes || null;
    if (reportUrl     !== undefined) data.reportUrl     = reportUrl || null;
    if (status        !== undefined) {
      data.status = normEnum(status, STATUSES, existing.status as string);
      if (data.status === 'closed' && !existing.resolvedAt) {
        data.resolvedAt = new Date();
      }
    }

    const updated = await prisma.arcFlashIncident.update({ where: { id, accountId }, data });

    // [LEGAL-8-4] Immutable before/after audit of EVERY changed field. A logged
    // incident is the contemporaneous injury record OSHA/a jury treat as
    // authoritative; without this, a manager could flip injury true→false, clear
    // oshaRecordable, or back-date occurredAt with no trace. Routed through
    // ActivityLog so the hash chain (LEGAL-8-6) commits to the old→new values.
    const changes: Record<string, { from: any; to: any }> = {};
    for (const f of AUDITED_INCIDENT_FIELDS) {
      if (data[f] === undefined) continue;
      const before = auditVal((existing as any)[f]);
      const after  = auditVal((updated  as any)[f]);
      if (before !== after) changes[f] = { from: before, to: after };
    }
    if (Object.keys(changes).length > 0) {
      writeActivityLog({
        accountId,
        userId: req.user.id,
        assetId: (updated.assetId || existing.assetId) || null,
        action: 'arc_flash_incident_amended',
        details: { incidentId: id, amendedBy: req.user.id, changes },
      });
    }

    return res.json({ success: true, data: incidentOut(updated) });
  } catch (err: any) {
    console.error('[arc-flash-incidents] PATCH /:id error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to update incident' });
  }
});

module.exports = router;
export {};
