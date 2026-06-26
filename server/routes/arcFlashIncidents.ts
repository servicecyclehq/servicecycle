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
const {
  INCIDENT_TYPES, WORK_TYPES, STATUSES, normEnum, incidentOut,
} = require('../lib/arcFlashIncident');

const router: Router = Router();

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

    // Attempt to snapshot current arc-flash label state for the asset/bus
    let studyStateSnapshot: any = null;
    if (assetId) {
      try {
        const { buildStudyStateSnapshot } = require('../lib/arcFlashIncident');
        const label = await (prisma as any).arcFlashLabel?.findFirst({
          where: { assetId, accountId, superseded: false },
          orderBy: { createdAt: 'desc' },
          include: { study: true },
        });
        if (label) studyStateSnapshot = buildStudyStateSnapshot(label);
      } catch (_) {
        // Snapshot is best-effort — failure must not block incident logging
      }
    }

    const incident = await prisma.arcFlashIncident.create({
      data: {
        accountId,
        siteId:             siteId   || null,
        assetId:            assetId  || null,
        busName:            busName  || null,
        incidentType:       normEnum(incidentType, INCIDENT_TYPES, 'near_miss'),
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

    const updated = await prisma.arcFlashIncident.update({ where: { id }, data });
    return res.json({ success: true, data: incidentOut(updated) });
  } catch (err: any) {
    console.error('[arc-flash-incidents] PATCH /:id error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to update incident' });
  }
});

module.exports = router;
export {};
