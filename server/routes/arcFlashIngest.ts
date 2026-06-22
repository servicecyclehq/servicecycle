/**
 * routes/arcFlashIngest.ts — arc-flash Slice 2: ingest + gap-analysis + review.
 *
 * Upload a one-line diagram or study report → extract a structured system model
 * (BYO-AI text/vision) → run the deterministic IEEE 1584 gap engine → park a
 * DRAFT for review. Nothing touches real assets until an explicit confirm.
 *
 *   POST   /api/arc-flash/ingest                multipart upload → extract → draft
 *   GET    /api/arc-flash/ingests?siteId=       list drafts
 *   GET    /api/arc-flash/ingest/:id            full draft + auto Review Package
 *   PATCH  /api/arc-flash/ingest/:id/bus/:busId reviewer edits a bus, re-gap
 *   POST   /api/arc-flash/ingest/:id/confirm    create/match assets (+ optional study)
 *
 * Mounted in index.ts: app.use('/api/arc-flash', authenticateToken, ingestLimiter, ...).
 * Writes are manager+; reads are any authenticated role.
 */

'use strict';

const router = require('express').Router();
const multer = require('multer');
const { requireManager } = require('../middleware/roles');
import prisma from '../lib/prisma';
const { uploadFile } = require('../lib/storage');
const { extractArcFlashDocument } = require('../lib/arcFlashExtract');
const { analyzeBusGaps, summarizeIngestBands } = require('../lib/arcFlashGap');
const { buildCollectionTasks, extractDeviceFromPhoto } = require('../lib/arcFlashDevice');
const { scoreBusConfidence, pickDeviceSource } = require('../lib/arcFlashConfidence');
const { diffIngestRevisions } = require('../lib/arcFlashDrift');
const { checkSystemContradictions, checkBusContradictions } = require('../lib/arcFlashSanity');

async function logActivity(userId: string, accountId: string, action: string, details: any = null) {
  try {
    await prisma.activityLog.create({ data: { assetId: null, userId, accountId: accountId ?? null, action, details: details ?? undefined } });
  } catch (err: any) {
    console.error('logActivity error:', err.message);
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (_req: any, file: any, cb: any) => cb(null, /application\/pdf|image\/(png|jpe?g|webp)/i.test(file.mimetype || '')),
});

const ELECTRODE_CONFIGS = new Set(['VCB', 'VCBB', 'HCB', 'VOA', 'HOA']);

// Photo upload for the device photo-read (image only, 10 MB) — mirrors assetPhotoInspect.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req: any, file: any, cb: any) => cb(null, /image\/(png|jpe?g|webp)/i.test(file.mimetype || '')),
});

const DEVICE_TYPES = new Set(['breaker', 'fuse', 'relay', 'switch']);
const TRIP_UNIT_TYPES = new Set(['none', 'thermal_magnetic', 'electronic_lsi', 'electronic_lsig']);
const FUSE_CLASSES = new Set(['L', 'RK1', 'RK5', 'J', 'T', 'CC', 'G', 'CF', 'H', 'K', 'other']);

// Public projection of a ProtectiveDevice row.
function deviceOut(d: any) {
  return {
    id: d.id, siteId: d.siteId, assetId: d.assetId, ingestBusId: d.ingestBusId, label: d.label,
    deviceType: d.deviceType, manufacturer: d.manufacturer, model: d.model, partNumber: d.partNumber,
    frameRatingA: numOrNull(d.frameRatingA), sensorRatingA: numOrNull(d.sensorRatingA), settings: d.settings,
    settingsCollectedAt: d.settingsCollectedAt, collectedById: d.collectedById, photoKey: d.photoKey,
    source: d.source, supersededById: d.supersededById, status: d.status, createdAt: d.createdAt, updatedAt: d.updatedAt,
  };
}

// Public projection of an ArcFlashCollectionTask row.
function taskOut(t: any) {
  return {
    id: t.id, siteId: t.siteId, ingestId: t.ingestId, ingestBusId: t.ingestBusId, assetId: t.assetId,
    busName: t.busName, instructions: t.instructions, neededFields: t.neededFields, status: t.status,
    assignedUserId: t.assignedUserId, hazardClass: t.hazardClass, ppeNote: t.ppeNote,
    requiresOutage: t.requiresOutage, requiresQualifiedPerson: t.requiresQualifiedPerson,
    collectedDeviceId: t.collectedDeviceId, collectedById: t.collectedById, collectedAt: t.collectedAt,
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

// Build the durable-device create payload from a request body (shared by create
// + supersede + field collect). Validates device type if present.
function deviceDataFromBody(b: any): { data?: any; error?: string } {
  const data: any = {};
  data.label = b.label ? String(b.label).slice(0, 200) : null;
  if (b.deviceType != null && b.deviceType !== '') {
    const dt = String(b.deviceType).toLowerCase();
    if (!DEVICE_TYPES.has(dt)) return { error: 'deviceType must be one of breaker, fuse, relay, switch' };
    data.deviceType = dt;
  }
  for (const f of ['manufacturer', 'model', 'partNumber']) if (b[f] !== undefined) data[f] = b[f] ? String(b[f]).slice(0, 200) : null;
  for (const f of ['frameRatingA', 'sensorRatingA']) if (b[f] !== undefined) data[f] = numOrNull(b[f]);
  if (b.settings !== undefined) data.settings = (b.settings && typeof b.settings === 'object' && Object.keys(b.settings).length) ? b.settings : null;
  if (b.photoKey !== undefined) data.photoKey = b.photoKey ? String(b.photoKey).slice(0, 500) : null;
  return { data };
}

function numOrNull(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function intOrNull(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// Parse a nominal-voltage label ("480V", "13.8kV", "208") to volts (for the
// DANGER test: >40 cal/cm2 OR >600 V, per NFPA 70E labeling).
function voltsOf(raw: any): number | null {
  if (raw == null) return null;
  const m = String(raw).match(/([\d.]+)\s*(kv|v)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /kv/i.test(m[2] || '') ? n * 1000 : n;
}

// NFPA 70E DANGER header when incident energy > 40 cal/cm2 OR nominal voltage
// > 600 V; else WARNING. null when we have neither input yet.
function deriveLabelSeverity(b: any): 'danger' | 'warning' | null {
  const ie = numOrNull(b.incidentEnergyCalCm2);
  const v = voltsOf(b.nominalVoltage);
  if (ie == null && v == null) return null;
  return ((ie != null && ie > 40) || (v != null && v > 600)) ? 'danger' : 'warning';
}

// Shape a bus row/record for the gap engine (incl. 2.6 device + cable inputs).
function busForGap(b: any) {
  return {
    busName: b.busName, equipmentTypeGuess: b.equipmentTypeGuess, nominalVoltage: b.nominalVoltage,
    boltedFaultCurrentKA: numOrNull(b.boltedFaultCurrentKA), clearingTimeMs: numOrNull(b.clearingTimeMs),
    electrodeConfig: b.electrodeConfig, conductorGapMm: numOrNull(b.conductorGapMm), workingDistanceIn: numOrNull(b.workingDistanceIn),
    deviceType: b.deviceType, tripUnitType: b.tripUnitType, deviceRatingA: numOrNull(b.deviceRatingA), deviceSettings: b.deviceSettings,
    cableLengthFt: numOrNull(b.cableLengthFt), cableSize: b.cableSize,
  };
}

// Public projection of a bus row.
function busOut(b: any) {
  return {
    id: b.id, seq: b.seq, busName: b.busName, equipmentTypeGuess: b.equipmentTypeGuess, equipmentTypeRaw: b.equipmentTypeRaw,
    fedFromBusName: b.fedFromBusName, nominalVoltage: b.nominalVoltage,
    boltedFaultCurrentKA: numOrNull(b.boltedFaultCurrentKA), arcingCurrentKA: numOrNull(b.arcingCurrentKA),
    electrodeConfig: b.electrodeConfig, conductorGapMm: numOrNull(b.conductorGapMm), clearingTimeMs: numOrNull(b.clearingTimeMs),
    workingDistanceIn: numOrNull(b.workingDistanceIn), upstreamDevice: b.upstreamDevice,
    deviceType: b.deviceType, tripUnitType: b.tripUnitType, fuseClass: b.fuseClass, deviceManufacturer: b.deviceManufacturer, deviceModel: b.deviceModel,
    deviceRatingA: numOrNull(b.deviceRatingA), deviceSettings: b.deviceSettings,
    cableLengthFt: numOrNull(b.cableLengthFt), cableSize: b.cableSize, cableMaterial: b.cableMaterial,
    conductorsPerPhase: b.conductorsPerPhase, conduitType: b.conduitType,
    incidentEnergyCalCm2: numOrNull(b.incidentEnergyCalCm2), arcFlashBoundaryIn: numOrNull(b.arcFlashBoundaryIn), ppeCategory: b.ppeCategory,
    gaps: b.gaps, readiness: b.readiness, confidence: b.confidence, resolution: b.resolution, matchedAssetId: b.matchedAssetId,
  };
}

// Build the auto-generated "Review Package" — the extract → findings → gap list
// → 2-question engineer ask that replaces the hand-built demo.
function buildReviewPackage(ingest: any, buses: any[]) {
  const sm = (ingest.systemMeta || {}) as any;
  const tx = sm.mainTransformer || {};
  const findings = buses.map((b: any) => ({
    busName: b.busName,
    equipmentType: b.equipmentTypeGuess,
    nominalVoltage: b.nominalVoltage,
    fedFrom: b.fedFromBusName,
    readiness: b.readiness,
    confidence: b.confidence,
  }));
  const gapList = buses
    .map((b: any) => {
      const g = (b.gaps || {}) as any;
      const fields = Array.isArray(g.fields) ? g.fields : [];
      const obtain = fields.filter((f: any) => f.category === 'must_obtain' && f.status === 'missing').map((f: any) => f.label);
      const noDefault = fields.filter((f: any) => f.category === 'typical' && f.status === 'missing').map((f: any) => f.label);
      const defaulted = fields.filter((f: any) => f.status === 'defaulted').map((f: any) => f.label);
      return { busName: b.busName, readiness: b.readiness, mustObtain: obtain, needsType: noDefault, assumedTypical: defaulted };
    })
    .filter((x: any) => x.mustObtain.length || x.needsType.length || x.assumedTypical.length);
  return {
    title: 'Arc Flash Review Package',
    extract: {
      sourceVoltage: sm.sourceVoltage ?? null,
      mainTransformer: tx.kva ? `${tx.kva} kVA, ${tx.primaryVoltage || '?'} → ${tx.secondaryVoltage || '?'}${tx.impedancePct ? `, ${tx.impedancePct}% Z` : ''}` : null,
      serviceFaultCurrentKA: sm.serviceFaultCurrentKA ?? null,
      study: sm.studyMeta || null,
      busCount: buses.length,
    },
    findings,
    gapList,
    engineerAsk: [
      'Did SC read the system right? — confirm the equipment, voltages, and how the buses feed each other.',
      'Is the missing-data list right? — confirm what still needs to be measured or obtained per bus before the study can run.',
    ],
  };
}

// ── POST /ingest ── upload → extract → gap → park for review ──────────────────
router.post('/ingest', requireManager, (req: any, res: any) => {
  upload.single('file')(req, res, async (err: any) => {
    if (err) return res.status(400).json({ success: false, error: err.message || 'Upload failed' });
    try {
      const { siteId } = req.body;
      const sourceType = req.body.sourceType === 'study_report' ? 'study_report' : 'one_line';
      if (!siteId) return res.status(400).json({ success: false, error: 'siteId is required' });
      if (!req.file) return res.status(400).json({ success: false, error: 'Upload a PDF study report or a PNG/JPG one-line image' });

      const site = await prisma.site.findFirst({ where: { id: siteId, accountId: req.user.accountId }, select: { id: true } });
      if (!site) return res.status(404).json({ success: false, error: 'Site not found' });

      let fileKey: string | null = null;
      try {
        const up = await uploadFile(req.user.accountId, 'arc-flash', req.file.originalname || 'one-line', req.file.buffer, req.file.mimetype);
        fileKey = up.storageKey;
      } catch (e: any) {
        console.error('arc-flash ingest storage error:', e?.message);
      }

      const ingest = await prisma.arcFlashIngest.create({
        data: {
          accountId: req.user.accountId, siteId, uploadedById: req.user.id, sourceType,
          fileKey, fileName: req.file.originalname || null, mimeType: req.file.mimetype || null, status: 'extracting',
        },
      });

      let ext: any;
      try {
        ext = await extractArcFlashDocument({ buffer: req.file.buffer, mimeType: req.file.mimetype, fileName: req.file.originalname });
      } catch (e: any) {
        await prisma.arcFlashIngest.update({ where: { id: ingest.id }, data: { status: 'failed', error: String(e?.message || e).slice(0, 500) } });
        return res.status(200).json({ success: true, data: { ingestId: ingest.id, status: 'failed', error: 'Extraction failed', warnings: [String(e?.message || e)] } });
      }

      const gapResults = ext.buses.map((b: any) => analyzeBusGaps(busForGap(b)));
      const summary = summarizeIngestBands(gapResults);

      for (let i = 0; i < ext.buses.length; i++) {
        const b = ext.buses[i];
        const g = gapResults[i];
        await prisma.arcFlashIngestBus.create({
          data: {
            accountId: req.user.accountId, ingestId: ingest.id, seq: i,
            busName: b.busName, equipmentTypeGuess: b.equipmentTypeGuess, fedFromBusName: b.fedFromBusName,
            nominalVoltage: b.nominalVoltage, boltedFaultCurrentKA: b.boltedFaultCurrentKA, arcingCurrentKA: b.arcingCurrentKA,
            electrodeConfig: b.electrodeConfig, conductorGapMm: b.conductorGapMm, clearingTimeMs: b.clearingTimeMs,
            workingDistanceIn: b.workingDistanceIn, upstreamDevice: b.upstreamDevice,
            deviceType: b.deviceType, deviceManufacturer: b.deviceManufacturer, deviceModel: b.deviceModel,
            deviceRatingA: b.deviceRatingA, deviceSettings: b.deviceSettings ?? undefined,
            cableLengthFt: b.cableLengthFt, cableSize: b.cableSize, cableMaterial: b.cableMaterial,
            incidentEnergyCalCm2: b.incidentEnergyCalCm2, arcFlashBoundaryIn: b.arcFlashBoundaryIn, ppeCategory: b.ppeCategory,
            gaps: g, readiness: g.readiness, confidence: g.confidence, resolution: b.equipmentTypeGuess ? 'create' : 'pending',
          },
        });
      }

      const finalStatus = ext.buses.length ? 'needs_review' : 'failed';
      await prisma.arcFlashIngest.update({
        where: { id: ingest.id },
        data: {
          status: finalStatus, extractionMethod: ext.method, aiProvider: ext.aiProvider, promptVersion: ext.promptVersion,
          systemMeta: ext.systemMeta ?? undefined, rawExtraction: ext.rawJsonText ? { text: String(ext.rawJsonText).slice(0, 20000) } : undefined,
          overallBand: summary.overallBand, readyBusCount: summary.readyBusCount, totalBusCount: summary.totalBusCount,
          error: ext.buses.length ? null : (ext.warnings[0] || 'No buses extracted'),
        },
      });

      await logActivity(req.user.id, req.user.accountId, 'arc_flash_ingest_uploaded', { ingestId: ingest.id, method: ext.method, buses: ext.buses.length, overallBand: summary.overallBand });

      return res.status(201).json({
        success: true,
        data: { ingestId: ingest.id, status: finalStatus, method: ext.method, overallBand: summary.overallBand, readyBusCount: summary.readyBusCount, totalBusCount: summary.totalBusCount, warnings: ext.warnings },
      });
    } catch (e) {
      console.error('arc-flash ingest error:', e);
      return res.status(500).json({ success: false, error: 'Failed to ingest document' });
    }
  });
});

// ── GET /ingests?siteId= ── list drafts ───────────────────────────────────────
router.get('/ingests', async (req: any, res: any) => {
  try {
    const where: any = { accountId: req.user.accountId };
    if (req.query.siteId) where.siteId = String(req.query.siteId);
    const rows = await prisma.arcFlashIngest.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, siteId: true, sourceType: true, fileName: true, status: true, overallBand: true, readyBusCount: true, totalBusCount: true, extractionMethod: true, producedStudyId: true, createdAt: true, confirmedAt: true },
    });
    res.json({ success: true, data: { ingests: rows } });
  } catch (e) {
    console.error('arc-flash ingest list error:', e);
    res.status(500).json({ success: false, error: 'Failed to list ingests' });
  }
});

// ── GET /ingest/:id ── full draft + Review Package ────────────────────────────
router.get('/ingest/:id', async (req: any, res: any) => {
  try {
    const ingest = await prisma.arcFlashIngest.findFirst({ where: { id: req.params.id, accountId: req.user.accountId } });
    if (!ingest) return res.status(404).json({ success: false, error: 'Ingest not found' });
    const buses = await prisma.arcFlashIngestBus.findMany({ where: { ingestId: ingest.id }, orderBy: { seq: 'asc' } });
    res.json({
      success: true,
      data: {
        ingest: {
          id: ingest.id, siteId: ingest.siteId, sourceType: ingest.sourceType, fileName: ingest.fileName, status: ingest.status,
          extractionMethod: ingest.extractionMethod, aiProvider: ingest.aiProvider, overallBand: ingest.overallBand,
          readyBusCount: ingest.readyBusCount, totalBusCount: ingest.totalBusCount, systemMeta: ingest.systemMeta,
          producedStudyId: ingest.producedStudyId, error: ingest.error, createdAt: ingest.createdAt, confirmedAt: ingest.confirmedAt,
        },
        buses: buses.map(busOut),
        reviewPackage: buildReviewPackage(ingest, buses),
        contradictions: checkSystemContradictions(buses, ingest.systemMeta || {}),
      },
    });
  } catch (e) {
    console.error('arc-flash ingest get error:', e);
    res.status(500).json({ success: false, error: 'Failed to load ingest' });
  }
});

// Shape a bus row for the drift engine (Decimals -> numbers; keep the topology +
// device fields the diff compares).
function busForDrift(b: any) {
  return {
    busName: b.busName, nominalVoltage: b.nominalVoltage,
    boltedFaultCurrentKA: numOrNull(b.boltedFaultCurrentKA), clearingTimeMs: numOrNull(b.clearingTimeMs),
    deviceRatingA: numOrNull(b.deviceRatingA), deviceType: b.deviceType, tripUnitType: b.tripUnitType,
    fedFromBusName: b.fedFromBusName, deviceSettings: b.deviceSettings,
  };
}

// ── GET /ingest/:id/drift ── Slice 2.8b: material change vs the prior confirmed
// revision for this site -> re-study recommendation. Read-only, computed live.
router.get('/ingest/:id/drift', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const ingest = await prisma.arcFlashIngest.findFirst({
      where: { id: req.params.id, accountId },
      select: { id: true, siteId: true, createdAt: true, confirmedAt: true },
    });
    if (!ingest) return res.status(404).json({ success: false, error: 'Ingest not found' });

    // The prior confirmed revision = the most recent OTHER confirmed ingest for
    // this site, confirmed before this one's reference time.
    const ref = ingest.confirmedAt || ingest.createdAt;
    const prior = await prisma.arcFlashIngest.findFirst({
      where: { accountId, siteId: ingest.siteId, status: 'confirmed', id: { not: ingest.id }, confirmedAt: { lt: ref } },
      orderBy: { confirmedAt: 'desc' },
      select: { id: true, confirmedAt: true },
    });

    const curBuses = await prisma.arcFlashIngestBus.findMany({ where: { ingestId: ingest.id }, orderBy: { seq: 'asc' } });
    let priorRev: any = null;
    if (prior) {
      const pb = await prisma.arcFlashIngestBus.findMany({ where: { ingestId: prior.id }, orderBy: { seq: 'asc' } });
      priorRev = { id: prior.id, confirmedAt: prior.confirmedAt, buses: pb.map(busForDrift) };
    }
    const report = diffIngestRevisions(priorRev, { buses: curBuses.map(busForDrift) });
    res.json({ success: true, data: { drift: report } });
  } catch (e) {
    console.error('arc-flash drift error:', e);
    res.status(500).json({ success: false, error: 'Failed to compute drift' });
  }
});

// ── PATCH /ingest/:id/bus/:busId ── reviewer edits a bus, re-gap ──────────────
router.patch('/ingest/:id/bus/:busId', requireManager, async (req: any, res: any) => {
  try {
    const ingest = await prisma.arcFlashIngest.findFirst({ where: { id: req.params.id, accountId: req.user.accountId }, select: { id: true, status: true } });
    if (!ingest) return res.status(404).json({ success: false, error: 'Ingest not found' });
    if (ingest.status === 'confirmed') return res.status(409).json({ success: false, error: 'Ingest already confirmed' });
    const bus = await prisma.arcFlashIngestBus.findFirst({ where: { id: req.params.busId, ingestId: ingest.id } });
    if (!bus) return res.status(404).json({ success: false, error: 'Bus not found' });

    const b = req.body || {};
    const patch: any = {};
    if (b.busName !== undefined) patch.busName = b.busName ? String(b.busName).slice(0, 200) : bus.busName;
    if (b.equipmentTypeGuess !== undefined) patch.equipmentTypeGuess = b.equipmentTypeGuess || null;
    if (b.fedFromBusName !== undefined) patch.fedFromBusName = b.fedFromBusName || null;
    if (b.nominalVoltage !== undefined) patch.nominalVoltage = b.nominalVoltage || null;
    if (b.upstreamDevice !== undefined) patch.upstreamDevice = b.upstreamDevice || null;
    // 2.6 — protective-device + feeder-cable fields collected in review/field.
    for (const f of ['deviceType', 'deviceManufacturer', 'deviceModel', 'cableSize', 'cableMaterial', 'conduitType']) {
      if (b[f] !== undefined) patch[f] = b[f] || null;
    }
    if (b.conductorsPerPhase !== undefined) patch.conductorsPerPhase = (b.conductorsPerPhase === null || b.conductorsPerPhase === '') ? null : intOrNull(b.conductorsPerPhase);
    if (b.tripUnitType !== undefined) {
      if (b.tripUnitType === null || b.tripUnitType === '') patch.tripUnitType = null;
      else if (!TRIP_UNIT_TYPES.has(String(b.tripUnitType))) return res.status(400).json({ success: false, error: 'tripUnitType must be none|thermal_magnetic|electronic_lsi|electronic_lsig' });
      else patch.tripUnitType = b.tripUnitType;
    }
    if (b.fuseClass !== undefined) {
      if (b.fuseClass === null || b.fuseClass === '') patch.fuseClass = null;
      else if (!FUSE_CLASSES.has(String(b.fuseClass))) return res.status(400).json({ success: false, error: 'fuseClass invalid' });
      else patch.fuseClass = b.fuseClass;
    }
    if (b.deviceSettings !== undefined) {
      if (b.deviceSettings === null || b.deviceSettings === '') patch.deviceSettings = null;
      else if (typeof b.deviceSettings === 'object') patch.deviceSettings = b.deviceSettings;
    }
    for (const f of ['boltedFaultCurrentKA', 'arcingCurrentKA', 'conductorGapMm', 'clearingTimeMs', 'workingDistanceIn', 'incidentEnergyCalCm2', 'arcFlashBoundaryIn', 'deviceRatingA', 'cableLengthFt']) {
      if (b[f] !== undefined) patch[f] = b[f] === null || b[f] === '' ? null : numOrNull(b[f]);
    }
    if (b.electrodeConfig !== undefined) {
      if (b.electrodeConfig === null || b.electrodeConfig === '') patch.electrodeConfig = null;
      else {
        const e = String(b.electrodeConfig).toUpperCase();
        if (!ELECTRODE_CONFIGS.has(e)) return res.status(400).json({ success: false, error: 'electrodeConfig must be one of VCB, VCBB, HCB, VOA, HOA' });
        patch.electrodeConfig = e;
      }
    }
    if (b.ppeCategory !== undefined) {
      if (b.ppeCategory === null || b.ppeCategory === '') patch.ppeCategory = null;
      else { const p = Number(b.ppeCategory); if (!Number.isInteger(p) || p < 0 || p > 4) return res.status(400).json({ success: false, error: 'ppeCategory must be an integer 0-4' }); patch.ppeCategory = p; }
    }
    if (b.resolution !== undefined) {
      if (!['pending', 'create', 'match', 'skip'].includes(b.resolution)) return res.status(400).json({ success: false, error: 'resolution must be pending|create|match|skip' });
      patch.resolution = b.resolution;
    }
    if (b.matchedAssetId !== undefined) {
      if (b.matchedAssetId) {
        const a = await prisma.asset.findFirst({ where: { id: b.matchedAssetId, accountId: req.user.accountId }, select: { id: true } });
        if (!a) return res.status(404).json({ success: false, error: 'matchedAssetId not found' });
        patch.matchedAssetId = a.id;
      } else patch.matchedAssetId = null;
    }

    const merged = { ...bus, ...patch };
    const g = analyzeBusGaps(busForGap(merged));
    patch.gaps = g; patch.readiness = g.readiness; patch.confidence = g.confidence;
    const updated = await prisma.arcFlashIngestBus.update({ where: { id: bus.id }, data: patch });

    // Re-roll the ingest summary.
    const all = await prisma.arcFlashIngestBus.findMany({ where: { ingestId: ingest.id } });
    const summary = summarizeIngestBands(all.map((x: any) => x.gaps).filter(Boolean));
    await prisma.arcFlashIngest.update({ where: { id: ingest.id }, data: { overallBand: summary.overallBand, readyBusCount: summary.readyBusCount, totalBusCount: all.length } });

    res.json({ success: true, data: { bus: busOut(updated), overallBand: summary.overallBand, readyBusCount: summary.readyBusCount } });
  } catch (e) {
    console.error('arc-flash bus patch error:', e);
    res.status(500).json({ success: false, error: 'Failed to update bus' });
  }
});

// Walk the extracted name graph; return the safe upstream name per bus (null if
// it would form a feed cycle). Pure name-graph guard for confirm-time wiring.
function safeFeeds(buses: any[]): Map<string, string | null> {
  const fed = new Map<string, string | null>(buses.map((b: any) => [b.busName, b.fedFromBusName || null]));
  const out = new Map<string, string | null>();
  for (const b of buses) {
    let cur: string | null = b.fedFromBusName || null;
    const seen = new Set<string>([b.busName]);
    let ok = true;
    let hops = 0;
    while (cur && hops < 200) {
      if (seen.has(cur)) { ok = false; break; }
      seen.add(cur);
      if (!fed.has(cur)) break;
      cur = fed.get(cur) || null;
      hops++;
    }
    out.set(b.busName, ok ? (b.fedFromBusName || null) : null);
  }
  return out;
}

// ── POST /ingest/:id/confirm ── create/match assets (+ optional study) ────────
router.post('/ingest/:id/confirm', requireManager, async (req: any, res: any) => {
  try {
    const ingest = await prisma.arcFlashIngest.findFirst({ where: { id: req.params.id, accountId: req.user.accountId } });
    if (!ingest) return res.status(404).json({ success: false, error: 'Ingest not found' });
    if (ingest.status === 'confirmed') return res.status(409).json({ success: false, error: 'Ingest already confirmed' });
    const buses = await prisma.arcFlashIngestBus.findMany({ where: { ingestId: ingest.id }, orderBy: { seq: 'asc' } });
    if (!buses.length) return res.status(400).json({ success: false, error: 'Nothing to confirm — no buses' });

    // Guard: every 'create' bus needs an equipment type.
    const missingType = buses.filter((b: any) => b.resolution === 'create' && !b.equipmentTypeGuess);
    if (missingType.length) {
      return res.status(400).json({ success: false, error: `Set an equipment type before confirming: ${missingType.map((b: any) => b.busName).join(', ')}` });
    }

    const accountId = req.user.accountId;
    const nameToAssetId = new Map<string, string>();
    let assetsCreated = 0;
    let assetsMatched = 0;

    // Pass 1: create / match assets (no feed links yet).
    for (const b of buses) {
      if (b.resolution === 'create') {
        const asset = await prisma.asset.create({
          data: {
            accountId, siteId: ingest.siteId, equipmentType: b.equipmentTypeGuess as any,
            nameplateData: { busName: b.busName, nominalVoltage: b.nominalVoltage || null, importedFrom: 'arc_flash_ingest', ingestId: ingest.id },
            notes: `Imported from arc-flash ${ingest.sourceType === 'study_report' ? 'study' : 'one-line'} (bus ${b.busName}).`,
          },
          select: { id: true },
        });
        nameToAssetId.set(b.busName, asset.id);
        assetsCreated++;
      } else if (b.resolution === 'match' && b.matchedAssetId) {
        const a = await prisma.asset.findFirst({ where: { id: b.matchedAssetId, accountId }, select: { id: true } });
        if (a) { nameToAssetId.set(b.busName, a.id); assetsMatched++; }
      }
    }

    // Pass 2: wire feeds-downstream topology (cycle-guarded by name graph).
    const safe = safeFeeds(buses);
    let feedsWired = 0;
    for (const b of buses) {
      const selfId = nameToAssetId.get(b.busName);
      const upstreamName = safe.get(b.busName);
      if (!selfId || !upstreamName) continue;
      const upstreamId = nameToAssetId.get(upstreamName);
      if (upstreamId && upstreamId !== selfId) {
        await prisma.asset.update({ where: { id: selfId }, data: { fedFromAssetId: upstreamId } });
        feedsWired++;
      }
    }

    // Optional: spin up a SystemStudy from the extracted inputs and bind buses.
    let studyId: string | null = null;
    let boundCount = 0;
    if (req.body && req.body.createStudy) {
      const studyType = req.body.studyType === 'one_line_review' ? 'one_line_review' : 'arc_flash';
      const performed = req.body.performedDate ? new Date(req.body.performedDate) : new Date();
      const sm = (ingest.systemMeta || {}) as any;
      const study = await prisma.systemStudy.create({
        data: {
          accountId, siteId: ingest.siteId, studyType,
          performedDate: performed, expiresAt: new Date(performed.getFullYear() + 5, performed.getMonth(), performed.getDate()),
          performedBy: (sm.studyMeta && sm.studyMeta.peName) || null, method: (sm.studyMeta && sm.studyMeta.method) || 'IEEE 1584-2018',
          peName: (sm.studyMeta && sm.studyMeta.peName) || null, trigger: 'system_change',
          notes: `Created from ingested ${ingest.sourceType === 'study_report' ? 'study report' : 'one-line'} (${ingest.fileName || 'upload'}).`,
        },
        select: { id: true },
      });
      studyId = study.id;

      // Slice E: persist the extracted source/system model (utility + main
      // transformer) onto a durable StudySourceModel for the produced study.
      const u = (sm.utility || {}) as any;
      const tx = (sm.mainTransformer || {}) as any;
      const hasSource = ['maxFaultKA', 'minFaultKA', 'xr'].some((k) => u[k] != null) || tx.kva != null;
      if (hasSource) {
        await prisma.studySourceModel.create({
          data: {
            accountId, siteId: ingest.siteId, studyId: study.id,
            utilityMaxFaultKA: numOrNull(u.maxFaultKA), utilityMinFaultKA: numOrNull(u.minFaultKA), utilityXr: numOrNull(u.xr),
            transformerKva: numOrNull(tx.kva), transformerPrimaryV: intOrNull(tx.primaryVoltage), transformerSecondaryV: intOrNull(tx.secondaryVoltage),
            transformerImpedancePct: numOrNull(tx.impedancePct),
          },
        });
      }

      for (const b of buses) {
        const assetId = nameToAssetId.get(b.busName);
        if (!assetId) continue;
        await prisma.systemStudyAsset.upsert({
          where: { studyId_assetId: { studyId: study.id, assetId } },
          update: {},
          create: {
            accountId, studyId: study.id, assetId, busName: b.busName, nominalVoltage: b.nominalVoltage || null,
            boltedFaultCurrentKA: b.boltedFaultCurrentKA ?? undefined, arcingCurrentKA: b.arcingCurrentKA ?? undefined,
            electrodeConfig: b.electrodeConfig ?? undefined, conductorGapMm: b.conductorGapMm ?? undefined,
            clearingTimeMs: b.clearingTimeMs ?? undefined, workingDistanceIn: b.workingDistanceIn ?? undefined,
            upstreamDevice: b.upstreamDevice ?? undefined, incidentEnergyCalCm2: b.incidentEnergyCalCm2 ?? undefined,
            arcFlashBoundaryIn: b.arcFlashBoundaryIn ?? undefined, ppeCategory: b.ppeCategory ?? undefined,
            // Persist the field-collected protective-device + feeder-cable record
            // onto the durable per-study snapshot (was being dropped before).
            deviceType: b.deviceType ?? undefined, tripUnitType: b.tripUnitType ?? undefined, fuseClass: b.fuseClass ?? undefined,
            deviceManufacturer: b.deviceManufacturer ?? undefined,
            deviceModel: b.deviceModel ?? undefined, deviceRatingA: b.deviceRatingA ?? undefined,
            deviceSettings: b.deviceSettings ?? undefined,
            cableLengthFt: b.cableLengthFt ?? undefined, cableSize: b.cableSize ?? undefined, cableMaterial: b.cableMaterial ?? undefined,
            conductorsPerPhase: b.conductorsPerPhase ?? undefined, conduitType: b.conduitType ?? undefined,
            // Bootstrap slices B/D/F: carry outcomes/enclosure/mitigation + derive the DANGER/WARNING severity.
            requiredArcRatingCalCm2: b.requiredArcRatingCalCm2 ?? undefined, ppeMethod: b.ppeMethod ?? undefined,
            shockLimitedApproachIn: b.shockLimitedApproachIn ?? undefined, shockRestrictedApproachIn: b.shockRestrictedApproachIn ?? undefined,
            labelSeverity: deriveLabelSeverity(b) ?? undefined,
            enclosureType: b.enclosureType ?? undefined, enclosureHeightMm: b.enclosureHeightMm ?? undefined,
            enclosureWidthMm: b.enclosureWidthMm ?? undefined, enclosureDepthMm: b.enclosureDepthMm ?? undefined,
            ermsPresent: b.ermsPresent ?? undefined, zsiEnabled: b.zsiEnabled ?? undefined,
            differentialPresent: b.differentialPresent ?? undefined, arcResistant: b.arcResistant ?? undefined,
            nec24087Method: b.nec24087Method ?? undefined, calcMethod: b.calcMethod ?? undefined,
            arcingCurrentReducedKA: b.arcingCurrentReducedKA ?? undefined, governingScenario: b.governingScenario ?? undefined,
          },
        });
        boundCount++;
      }
    }

    await prisma.arcFlashIngest.update({ where: { id: ingest.id }, data: { status: 'confirmed', confirmedById: req.user.id, confirmedAt: new Date(), producedStudyId: studyId } });
    await logActivity(req.user.id, accountId, 'arc_flash_ingest_confirmed', { ingestId: ingest.id, assetsCreated, assetsMatched, feedsWired, studyId, boundCount });

    res.json({ success: true, data: { ingestId: ingest.id, assetsCreated, assetsMatched, feedsWired, studyId, boundCount } });
  } catch (e) {
    console.error('arc-flash confirm error:', e);
    res.status(500).json({ success: false, error: 'Failed to confirm ingest' });
  }
});

// ── POST /ingest/:id/collection-tasks ── generate field tasks from blocked buses ─
router.post('/ingest/:id/collection-tasks', requireManager, async (req: any, res: any) => {
  try {
    const ingest = await prisma.arcFlashIngest.findFirst({ where: { id: req.params.id, accountId: req.user.accountId }, select: { id: true, siteId: true } });
    if (!ingest) return res.status(404).json({ success: false, error: 'Ingest not found' });
    const buses = await prisma.arcFlashIngestBus.findMany({ where: { ingestId: ingest.id }, orderBy: { seq: 'asc' } });
    const drafts = buildCollectionTasks(buses);
    if (!drafts.length) return res.json({ success: true, data: { created: 0, skipped: 0, tasks: [] } });

    // Dedup: skip a bus that already has a live (non-cancelled) task for this ingest.
    const existing = await prisma.arcFlashCollectionTask.findMany({
      where: { ingestId: ingest.id, status: { not: 'cancelled' } }, select: { ingestBusId: true },
    });
    const have = new Set(existing.map((t: any) => t.ingestBusId).filter(Boolean));

    const created: any[] = [];
    let skipped = 0;
    for (const d of drafts) {
      if (d.ingestBusId && have.has(d.ingestBusId)) { skipped++; continue; }
      const t = await prisma.arcFlashCollectionTask.create({
        data: {
          accountId: req.user.accountId, siteId: ingest.siteId, ingestId: ingest.id, ingestBusId: d.ingestBusId,
          busName: d.busName, instructions: d.instructions, neededFields: d.neededFields ?? undefined,
          hazardClass: d.hazardClass, ppeNote: d.ppeNote, requiresOutage: d.requiresOutage,
          requiresQualifiedPerson: d.requiresQualifiedPerson, createdById: req.user.id,
        },
      });
      created.push(taskOut(t));
    }
    await logActivity(req.user.id, req.user.accountId, 'arc_flash_collection_tasks_generated', { ingestId: ingest.id, created: created.length, skipped });
    res.status(201).json({ success: true, data: { created: created.length, skipped, tasks: created } });
  } catch (e) {
    console.error('arc-flash collection-tasks generate error:', e);
    res.status(500).json({ success: false, error: 'Failed to generate collection tasks' });
  }
});

// ── GET /collection-tasks?siteId=&status= ── list collection tasks ────────────
router.get('/collection-tasks', async (req: any, res: any) => {
  try {
    const where: any = { accountId: req.user.accountId };
    if (req.query.siteId) where.siteId = String(req.query.siteId);
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.ingestId) where.ingestId = String(req.query.ingestId);
    const rows = await prisma.arcFlashCollectionTask.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json({ success: true, data: { tasks: rows.map(taskOut) } });
  } catch (e) {
    console.error('arc-flash collection-tasks list error:', e);
    res.status(500).json({ success: false, error: 'Failed to list collection tasks' });
  }
});

// ── PATCH /collection-tasks/:id ── assign / status / cancel ───────────────────
router.patch('/collection-tasks/:id', requireManager, async (req: any, res: any) => {
  try {
    const task = await prisma.arcFlashCollectionTask.findFirst({ where: { id: req.params.id, accountId: req.user.accountId } });
    if (!task) return res.status(404).json({ success: false, error: 'Task not found' });
    const b = req.body || {};
    const patch: any = {};
    if (b.status !== undefined) {
      if (!['open', 'in_progress', 'collected', 'cancelled'].includes(b.status)) return res.status(400).json({ success: false, error: 'status must be open|in_progress|collected|cancelled' });
      patch.status = b.status;
    }
    if (b.assignedUserId !== undefined) {
      if (b.assignedUserId) {
        const u = await prisma.user.findFirst({ where: { id: b.assignedUserId, accountId: req.user.accountId }, select: { id: true } });
        if (!u) return res.status(404).json({ success: false, error: 'assignedUserId not found in this account' });
        patch.assignedUserId = u.id;
      } else patch.assignedUserId = null;
    }
    if (b.instructions !== undefined) patch.instructions = b.instructions ? String(b.instructions).slice(0, 2000) : task.instructions;
    const updated = await prisma.arcFlashCollectionTask.update({ where: { id: task.id }, data: patch });
    res.json({ success: true, data: { task: taskOut(updated) } });
  } catch (e) {
    console.error('arc-flash collection-task patch error:', e);
    res.status(500).json({ success: false, error: 'Failed to update task' });
  }
});

// ── POST /devices ── create a durable ProtectiveDevice ────────────────────────
router.post('/devices', requireManager, async (req: any, res: any) => {
  try {
    const b = req.body || {};
    if (!b.siteId) return res.status(400).json({ success: false, error: 'siteId is required' });
    if (!b.label) return res.status(400).json({ success: false, error: 'label is required' });
    const site = await prisma.site.findFirst({ where: { id: b.siteId, accountId: req.user.accountId }, select: { id: true } });
    if (!site) return res.status(404).json({ success: false, error: 'Site not found' });
    if (b.assetId) {
      const a = await prisma.asset.findFirst({ where: { id: b.assetId, accountId: req.user.accountId }, select: { id: true } });
      if (!a) return res.status(404).json({ success: false, error: 'assetId not found' });
    }
    const { data, error } = deviceDataFromBody(b);
    if (error) return res.status(400).json({ success: false, error });
    const device = await prisma.protectiveDevice.create({
      data: {
        accountId: req.user.accountId, siteId: b.siteId, assetId: b.assetId || null, ingestBusId: b.ingestBusId || null,
        label: data.label, deviceType: data.deviceType ?? null, manufacturer: data.manufacturer ?? null,
        model: data.model ?? null, partNumber: data.partNumber ?? null, frameRatingA: data.frameRatingA ?? null,
        sensorRatingA: data.sensorRatingA ?? null, settings: data.settings ?? undefined, photoKey: data.photoKey ?? null,
        source: b.source === 'photo' || b.source === 'import' || b.source === 'manual' ? b.source : 'manual',
        collectedById: req.user.id, settingsCollectedAt: data.settings ? new Date() : null,
      },
    });
    await logActivity(req.user.id, req.user.accountId, 'arc_flash_device_created', { deviceId: device.id, siteId: b.siteId, assetId: b.assetId || null });
    res.status(201).json({ success: true, data: { device: deviceOut(device) } });
  } catch (e) {
    console.error('arc-flash device create error:', e);
    res.status(500).json({ success: false, error: 'Failed to create device' });
  }
});

// ── GET /devices?siteId=&assetId=&ingestBusId=&status= ── list devices ────────
router.get('/devices', async (req: any, res: any) => {
  try {
    const where: any = { accountId: req.user.accountId };
    if (req.query.siteId) where.siteId = String(req.query.siteId);
    if (req.query.assetId) where.assetId = String(req.query.assetId);
    if (req.query.ingestBusId) where.ingestBusId = String(req.query.ingestBusId);
    where.status = req.query.status ? String(req.query.status) : 'active';
    const rows = await prisma.protectiveDevice.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json({ success: true, data: { devices: rows.map(deviceOut) } });
  } catch (e) {
    console.error('arc-flash device list error:', e);
    res.status(500).json({ success: false, error: 'Failed to list devices' });
  }
});

// ── POST /devices/:id/supersede ── version a device (settings changed) ────────
router.post('/devices/:id/supersede', requireManager, async (req: any, res: any) => {
  try {
    const old = await prisma.protectiveDevice.findFirst({ where: { id: req.params.id, accountId: req.user.accountId } });
    if (!old) return res.status(404).json({ success: false, error: 'Device not found' });
    if (old.status === 'superseded') return res.status(409).json({ success: false, error: 'Device already superseded' });
    const b = req.body || {};
    const { data, error } = deviceDataFromBody({ ...old, ...b, label: b.label ?? old.label });
    if (error) return res.status(400).json({ success: false, error });
    const next = await prisma.protectiveDevice.create({
      data: {
        accountId: old.accountId, siteId: old.siteId, assetId: old.assetId, ingestBusId: old.ingestBusId,
        label: data.label || old.label, deviceType: data.deviceType ?? old.deviceType, manufacturer: data.manufacturer ?? old.manufacturer,
        model: data.model ?? old.model, partNumber: data.partNumber ?? old.partNumber,
        frameRatingA: data.frameRatingA ?? old.frameRatingA, sensorRatingA: data.sensorRatingA ?? old.sensorRatingA,
        settings: data.settings ?? (old.settings ?? undefined), photoKey: data.photoKey ?? old.photoKey,
        source: b.source || 'manual', collectedById: req.user.id, settingsCollectedAt: new Date(),
      },
    });
    await prisma.protectiveDevice.update({ where: { id: old.id }, data: { status: 'superseded', supersededById: next.id } });
    await logActivity(req.user.id, req.user.accountId, 'arc_flash_device_superseded', { oldId: old.id, newId: next.id });
    res.status(201).json({ success: true, data: { device: deviceOut(next), supersededId: old.id } });
  } catch (e) {
    console.error('arc-flash device supersede error:', e);
    res.status(500).json({ success: false, error: 'Failed to supersede device' });
  }
});

// ── POST /photo-read ── read a breaker/fuse/relay photo into a device draft ───
// Review-first: returns a parsed draft; nothing is persisted until the reviewer
// saves it (POST /devices) or a field collect submits it.
router.post('/photo-read', requireManager, (req: any, res: any) => {
  if (String(process.env.AI_ENABLED || '').toLowerCase() === 'false') {
    return res.status(503).json({ success: false, error: 'ai_disabled', message: 'AI features are turned off for this deployment.' });
  }
  photoUpload.single('photo')(req, res, async (err: any) => {
    if (err) return res.status(400).json({ success: false, error: err.message || 'Upload failed' });
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'Upload a JPG/PNG/WebP photo of the device' });
      const result = await extractDeviceFromPhoto({ buffer: req.file.buffer, mimeType: req.file.mimetype });
      await logActivity(req.user.id, req.user.accountId, 'arc_flash_device_photo_read', { hasDevice: !!(result && result.device), warnings: (result && result.warnings) || [] });
      res.json({ success: true, data: { device: result.device, warnings: result.warnings || [], promptVersion: result.promptVersion } });
    } catch (e) {
      console.error('arc-flash photo-read error:', e);
      res.status(500).json({ success: false, error: 'Failed to read device photo' });
    }
  });
});

// ── GET /dashboard ── account-level arc-flash health card (surfacing) ─────────
// The four numbers that answer "where's my arc-flash risk + what's outstanding":
// DANGER buses (incident energy > 40 cal/cm2), studies expiring soon, blocked
// buses still needing data, and open field-collection tasks. Read-only.
router.get('/dashboard', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const soon = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const liveIngests = await prisma.arcFlashIngest.findMany({ where: { accountId, status: { not: 'confirmed' } }, select: { id: true }, take: 1000 });
    const liveIds = liveIngests.map((i: any) => i.id);

    const [studyAssets, studiesExpiringSoon, blockedBuses, openCollectionTasks] = await Promise.all([
      prisma.systemStudyAsset.findMany({ where: { accountId }, select: { busName: true, incidentEnergyCalCm2: true, nominalVoltage: true, assetId: true, studyId: true }, take: 2000 }),
      prisma.systemStudy.count({ where: { accountId, expiresAt: { lte: soon } } }),
      liveIds.length ? prisma.arcFlashIngestBus.count({ where: { ingestId: { in: liveIds }, readiness: 'blocked' } }) : Promise.resolve(0),
      prisma.arcFlashCollectionTask.count({ where: { accountId, status: { in: ['open', 'in_progress'] } } }),
    ]);

    // DANGER = incident energy > 40 cal/cm2 OR system voltage > 600 V (NFPA 70E).
    const danger = studyAssets.filter((s: any) => { const ie = numOrNull(s.incidentEnergyCalCm2); const v = voltsOf(s.nominalVoltage); return (ie != null && ie > 40) || (v != null && v > 600); });
    const topDanger = danger
      .sort((a: any, b: any) => (numOrNull(b.incidentEnergyCalCm2) || 0) - (numOrNull(a.incidentEnergyCalCm2) || 0))
      .slice(0, 5)
      .map((t: any) => ({ busName: t.busName, incidentEnergyCalCm2: numOrNull(t.incidentEnergyCalCm2), nominalVoltage: t.nominalVoltage, assetId: t.assetId, studyId: t.studyId }));

    res.json({
      success: true,
      data: { dangerBuses: danger.length, studiesExpiringSoon, blockedBuses, openCollectionTasks, topDanger },
    });
  } catch (e) {
    console.error('arc-flash dashboard error:', e);
    res.status(500).json({ success: false, error: 'Failed to load arc-flash dashboard' });
  }
});

// Shape a raw SystemStudyAsset row (+ its asset's equipment type) for the gap /
// confidence / contradiction engines.
function busForFleet(r: any, equipmentType: any) {
  return {
    busName: r.busName, equipmentTypeGuess: equipmentType, nominalVoltage: r.nominalVoltage,
    boltedFaultCurrentKA: numOrNull(r.boltedFaultCurrentKA), arcingCurrentKA: numOrNull(r.arcingCurrentKA),
    arcingCurrentReducedKA: numOrNull(r.arcingCurrentReducedKA), clearingTimeMs: numOrNull(r.clearingTimeMs),
    electrodeConfig: r.electrodeConfig, conductorGapMm: numOrNull(r.conductorGapMm), workingDistanceIn: numOrNull(r.workingDistanceIn),
    deviceType: r.deviceType, tripUnitType: r.tripUnitType, deviceRatingA: numOrNull(r.deviceRatingA), deviceSettings: r.deviceSettings,
    cableLengthFt: numOrNull(r.cableLengthFt), cableSize: r.cableSize,
    incidentEnergyCalCm2: numOrNull(r.incidentEnergyCalCm2), requiredArcRatingCalCm2: numOrNull(r.requiredArcRatingCalCm2), ppeCategory: r.ppeCategory,
  };
}

// ── GET /fleet ── Slice 3a: cross-site arc-flash rollup ───────────────────────
// Per-site DANGER %, label readiness, average confidence (2.8a), open
// contradictions (2.8c), and expiring studies — the "where is my arc-flash risk
// across the whole portfolio" view. Read-only; manager/admin via the Reports gate.
router.get('/fleet', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const soon = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const [rows, devices, driftTests] = await Promise.all([
      prisma.systemStudyAsset.findMany({
        where: { accountId, study: { supersededById: null } },
        include: {
          study: { select: { id: true, performedDate: true, expiresAt: true, supersededById: true, method: true, sourceModel: { select: { utilityMaxFaultKA: true } } } },
          asset: { select: { id: true, equipmentType: true, siteId: true, site: { select: { name: true } } } },
        },
        take: 3000,
      }),
      prisma.protectiveDevice.findMany({ where: { accountId, status: 'active', assetId: { not: null } }, select: { assetId: true, source: true }, take: 5000 }),
      prisma.deviceTestRecord.findMany({ where: { accountId, driftFlagged: true, assetId: { not: null } }, select: { assetId: true }, take: 5000 }),
    ]);

    const devByAsset = new Map<string, any[]>();
    for (const d of devices) { if (!d.assetId) continue; const arr = devByAsset.get(d.assetId) || []; arr.push(d); devByAsset.set(d.assetId, arr); }
    const driftAssets = new Set(driftTests.map((t: any) => t.assetId));

    const sites = new Map<string, any>();
    for (const r of rows) {
      const siteId = r.asset?.siteId || 'unassigned';
      const siteName = r.asset?.site?.name || 'Unassigned';
      let site = sites.get(siteId);
      if (!site) { site = { siteId, siteName, busCount: 0, dangerCount: 0, blockedCount: 0, lowConfidenceCount: 0, confidenceSum: 0, errorCount: 0, warningCount: 0, studyIds: new Set<string>(), expiringStudyIds: new Set<string>() }; sites.set(siteId, site); }

      const bus = busForFleet(r, r.asset?.equipmentType);
      const ie = numOrNull(r.incidentEnergyCalCm2);
      const v = voltsOf(r.nominalVoltage);
      const danger = (ie != null && ie > 40) || (v != null && v > 600);
      const g = analyzeBusGaps(busForGap(bus));
      const deviceSource = pickDeviceSource(devByAsset.get(r.assetId) || []);
      const drift = driftAssets.has(r.assetId);
      const conf = scoreBusConfidence({ bus, study: { performedDate: r.study?.performedDate, expiresAt: r.study?.expiresAt, superseded: !!r.study?.supersededById }, deviceSource, driftFlagged: drift });
      const finds = checkBusContradictions(bus, { utilityMaxFaultKA: r.study?.sourceModel?.utilityMaxFaultKA ?? null });

      site.busCount++;
      if (danger) site.dangerCount++;
      if (g.readiness === 'blocked') site.blockedCount++;
      site.confidenceSum += conf.score;
      if (conf.band === 'red') site.lowConfidenceCount++;
      site.errorCount += finds.filter((f: any) => f.severity === 'error').length;
      site.warningCount += finds.filter((f: any) => f.severity === 'warning').length;
      if (r.study?.id) {
        site.studyIds.add(r.study.id);
        if (r.study.expiresAt && new Date(r.study.expiresAt) <= soon) site.expiringStudyIds.add(r.study.id);
      }
    }

    const siteList = Array.from(sites.values()).map((s: any) => ({
      siteId: s.siteId, siteName: s.siteName, busCount: s.busCount, dangerCount: s.dangerCount,
      dangerPct: s.busCount ? Math.round((s.dangerCount / s.busCount) * 100) : 0,
      blockedCount: s.blockedCount, lowConfidenceCount: s.lowConfidenceCount,
      avgConfidence: s.busCount ? Math.round(s.confidenceSum / s.busCount) : null,
      contradictionErrors: s.errorCount, contradictionWarnings: s.warningCount,
      studyCount: s.studyIds.size, expiringStudies: s.expiringStudyIds.size,
    })).sort((a, b) => (b.dangerCount - a.dangerCount) || (a.avgConfidence ?? 100) - (b.avgConfidence ?? 100));

    const totals = siteList.reduce((acc: any, s: any) => ({
      sites: acc.sites + 1, busCount: acc.busCount + s.busCount, dangerCount: acc.dangerCount + s.dangerCount,
      blockedCount: acc.blockedCount + s.blockedCount, lowConfidenceCount: acc.lowConfidenceCount + s.lowConfidenceCount,
      contradictionErrors: acc.contradictionErrors + s.contradictionErrors, contradictionWarnings: acc.contradictionWarnings + s.contradictionWarnings,
      expiringStudies: acc.expiringStudies + s.expiringStudies, confWeighted: acc.confWeighted + (s.avgConfidence ?? 0) * s.busCount,
    }), { sites: 0, busCount: 0, dangerCount: 0, blockedCount: 0, lowConfidenceCount: 0, contradictionErrors: 0, contradictionWarnings: 0, expiringStudies: 0, confWeighted: 0 });
    const avgConfidence = totals.busCount ? Math.round(totals.confWeighted / totals.busCount) : null;

    res.json({ success: true, data: { sites: siteList, totals: { ...totals, confWeighted: undefined, avgConfidence } } });
  } catch (e) {
    console.error('arc-flash fleet error:', e);
    res.status(500).json({ success: false, error: 'Failed to load arc-flash fleet rollup' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Slice E — source / system model (per study)
// ═══════════════════════════════════════════════════════════════════════════

function sourceModelOut(s: any) {
  return {
    id: s.id, studyId: s.studyId, siteId: s.siteId,
    utilityMaxFaultKA: numOrNull(s.utilityMaxFaultKA), utilityMinFaultKA: numOrNull(s.utilityMinFaultKA), utilityXr: numOrNull(s.utilityXr),
    transformerKva: numOrNull(s.transformerKva), transformerPrimaryV: s.transformerPrimaryV, transformerSecondaryV: s.transformerSecondaryV,
    transformerImpedancePct: numOrNull(s.transformerImpedancePct), transformerXr: numOrNull(s.transformerXr), transformerConnection: s.transformerConnection,
    motorContributionHp: s.motorContributionHp, motorContributionCount: s.motorContributionCount,
    generatorKva: numOrNull(s.generatorKva), generatorVoltageV: s.generatorVoltageV, generatorSubtransientXdPct: numOrNull(s.generatorSubtransientXdPct),
    below125kvaFlag: s.below125kvaFlag, notes: s.notes, updatedAt: s.updatedAt,
  };
}

function sourceModelFromBody(b: any) {
  const data: any = {};
  for (const f of ['utilityMaxFaultKA', 'utilityMinFaultKA', 'utilityXr', 'transformerKva', 'transformerImpedancePct', 'transformerXr', 'generatorKva', 'generatorSubtransientXdPct']) {
    if (b[f] !== undefined) data[f] = numOrNull(b[f]);
  }
  for (const f of ['transformerPrimaryV', 'transformerSecondaryV', 'motorContributionHp', 'motorContributionCount', 'generatorVoltageV']) {
    if (b[f] !== undefined) data[f] = intOrNull(b[f]);
  }
  if (b.transformerConnection !== undefined) data.transformerConnection = b.transformerConnection ? String(b.transformerConnection).slice(0, 80) : null;
  if (b.notes !== undefined) data.notes = b.notes ? String(b.notes).slice(0, 2000) : null;
  if (b.below125kvaFlag !== undefined) data.below125kvaFlag = (b.below125kvaFlag === null || b.below125kvaFlag === '') ? null : !!b.below125kvaFlag;
  return data;
}

// ── GET /studies/:studyId/source-model ────────────────────────────────────────
router.get('/studies/:studyId/source-model', async (req: any, res: any) => {
  try {
    const study = await prisma.systemStudy.findFirst({ where: { id: req.params.studyId, accountId: req.user.accountId }, select: { id: true } });
    if (!study) return res.status(404).json({ success: false, error: 'Study not found' });
    const sm = await prisma.studySourceModel.findUnique({ where: { studyId: study.id } });
    res.json({ success: true, data: { sourceModel: sm ? sourceModelOut(sm) : null } });
  } catch (e) {
    console.error('arc-flash source-model get error:', e);
    res.status(500).json({ success: false, error: 'Failed to load source model' });
  }
});

// ── PUT /studies/:studyId/source-model ── upsert the source/system model ──────
router.put('/studies/:studyId/source-model', requireManager, async (req: any, res: any) => {
  try {
    const study = await prisma.systemStudy.findFirst({ where: { id: req.params.studyId, accountId: req.user.accountId }, select: { id: true, siteId: true } });
    if (!study) return res.status(404).json({ success: false, error: 'Study not found' });
    const data = sourceModelFromBody(req.body || {});
    const sm = await prisma.studySourceModel.upsert({
      where: { studyId: study.id },
      update: data,
      create: { accountId: req.user.accountId, siteId: study.siteId, studyId: study.id, ...data },
    });
    await logActivity(req.user.id, req.user.accountId, 'arc_flash_source_model_saved', { studyId: study.id });
    res.json({ success: true, data: { sourceModel: sourceModelOut(sm) } });
  } catch (e) {
    console.error('arc-flash source-model put error:', e);
    res.status(500).json({ success: false, error: 'Failed to save source model' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Slice G — NETA as-found / as-left device-test linkage
// ═══════════════════════════════════════════════════════════════════════════

const TEST_TYPES = new Set(['relay_calibration', 'breaker_trip_test', 'primary_injection', 'as_found_as_left', 'other']);

function settingsObj(v: any): any {
  return (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) ? v : null;
}

function deviceTestOut(t: any) {
  return {
    id: t.id, siteId: t.siteId, assetId: t.assetId, protectiveDeviceId: t.protectiveDeviceId, systemStudyAssetId: t.systemStudyAssetId, ingestBusId: t.ingestBusId,
    testType: t.testType, testDate: t.testDate, performedBy: t.performedBy, asFoundSettings: t.asFoundSettings, asLeftSettings: t.asLeftSettings,
    matchesStudy: t.matchesStudy, driftFlagged: t.driftFlagged, result: t.result, notes: t.notes, reportUrl: t.reportUrl, createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

// Drift = recorded settings changed (as-found != as-left) OR they no longer match
// the study's assumed settings → the incident-energy result may be stale (NETA).
function computeDrift(asFound: any, asLeft: any, matchesStudy: boolean | null | undefined): boolean {
  if (matchesStudy === false) return true;
  if (asFound && asLeft) { try { return JSON.stringify(asFound) !== JSON.stringify(asLeft); } catch { return false; } }
  return false;
}

// ── POST /device-tests ── record a NETA test (relay cal / trip test / as-found) ─
router.post('/device-tests', requireManager, async (req: any, res: any) => {
  try {
    const b = req.body || {};
    const accountId = req.user.accountId;
    if (!b.siteId) return res.status(400).json({ success: false, error: 'siteId is required' });
    const site = await prisma.site.findFirst({ where: { id: b.siteId, accountId }, select: { id: true } });
    if (!site) return res.status(404).json({ success: false, error: 'Site not found' });
    if (b.assetId) { const a = await prisma.asset.findFirst({ where: { id: b.assetId, accountId }, select: { id: true } }); if (!a) return res.status(404).json({ success: false, error: 'assetId not found' }); }
    if (b.protectiveDeviceId) { const d = await prisma.protectiveDevice.findFirst({ where: { id: b.protectiveDeviceId, accountId }, select: { id: true } }); if (!d) return res.status(404).json({ success: false, error: 'protectiveDeviceId not found' }); }

    const testType = TEST_TYPES.has(String(b.testType)) ? String(b.testType) : 'other';
    const asFound = settingsObj(b.asFoundSettings);
    const asLeft = settingsObj(b.asLeftSettings);
    const matchesStudy = (b.matchesStudy === undefined || b.matchesStudy === null || b.matchesStudy === '') ? null : !!b.matchesStudy;
    const drift = computeDrift(asFound, asLeft, matchesStudy) || b.driftFlagged === true;

    const rec = await prisma.deviceTestRecord.create({
      data: {
        accountId, siteId: b.siteId, assetId: b.assetId || null, protectiveDeviceId: b.protectiveDeviceId || null,
        systemStudyAssetId: b.systemStudyAssetId || null, ingestBusId: b.ingestBusId || null,
        testType, testDate: b.testDate ? new Date(b.testDate) : null, performedBy: b.performedBy ? String(b.performedBy).slice(0, 200) : null,
        asFoundSettings: asFound ?? undefined, asLeftSettings: asLeft ?? undefined, matchesStudy,
        driftFlagged: drift, result: b.result ? String(b.result).slice(0, 40) : null, notes: b.notes ? String(b.notes).slice(0, 2000) : null,
        reportUrl: b.reportUrl ? String(b.reportUrl).slice(0, 1000) : null, recordedById: req.user.id,
      },
    });
    await logActivity(req.user.id, accountId, 'arc_flash_device_test_recorded', { testId: rec.id, testType, driftFlagged: drift, assetId: b.assetId || null });
    res.status(201).json({ success: true, data: { test: deviceTestOut(rec), driftFlagged: drift } });
  } catch (e) {
    console.error('arc-flash device-test create error:', e);
    res.status(500).json({ success: false, error: 'Failed to record device test' });
  }
});

// ── GET /device-tests?assetId=&siteId=&protectiveDeviceId= ── list test records ─
router.get('/device-tests', async (req: any, res: any) => {
  try {
    const where: any = { accountId: req.user.accountId };
    if (req.query.assetId) where.assetId = String(req.query.assetId);
    if (req.query.siteId) where.siteId = String(req.query.siteId);
    if (req.query.protectiveDeviceId) where.protectiveDeviceId = String(req.query.protectiveDeviceId);
    if (req.query.systemStudyAssetId) where.systemStudyAssetId = String(req.query.systemStudyAssetId);
    const rows = await prisma.deviceTestRecord.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json({ success: true, data: { tests: rows.map(deviceTestOut), anyStale: rows.some((r: any) => r.driftFlagged) } });
  } catch (e) {
    console.error('arc-flash device-test list error:', e);
    res.status(500).json({ success: false, error: 'Failed to list device tests' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Surfacing — consolidated per-asset Arc Flash payload
// ═══════════════════════════════════════════════════════════════════════════

// Flatten + coerce a SystemStudyAsset row (with its study) for the per-asset tab.
function studyAssetOut(s: any) {
  const st = s.study || {};
  return {
    id: s.id, busName: s.busName, nominalVoltage: s.nominalVoltage,
    incidentEnergyCalCm2: numOrNull(s.incidentEnergyCalCm2), arcFlashBoundaryIn: numOrNull(s.arcFlashBoundaryIn),
    workingDistanceIn: numOrNull(s.workingDistanceIn), ppeCategory: s.ppeCategory,
    boltedFaultCurrentKA: numOrNull(s.boltedFaultCurrentKA), arcingCurrentKA: numOrNull(s.arcingCurrentKA),
    arcingCurrentReducedKA: numOrNull(s.arcingCurrentReducedKA), governingScenario: s.governingScenario,
    electrodeConfig: s.electrodeConfig, conductorGapMm: numOrNull(s.conductorGapMm), clearingTimeMs: numOrNull(s.clearingTimeMs),
    upstreamDevice: s.upstreamDevice, deviceType: s.deviceType, tripUnitType: s.tripUnitType, fuseClass: s.fuseClass,
    deviceManufacturer: s.deviceManufacturer, deviceModel: s.deviceModel, deviceRatingA: numOrNull(s.deviceRatingA), deviceSettings: s.deviceSettings,
    cableLengthFt: numOrNull(s.cableLengthFt), cableSize: s.cableSize, cableMaterial: s.cableMaterial, conductorsPerPhase: s.conductorsPerPhase, conduitType: s.conduitType,
    requiredArcRatingCalCm2: numOrNull(s.requiredArcRatingCalCm2), ppeMethod: s.ppeMethod,
    shockLimitedApproachIn: numOrNull(s.shockLimitedApproachIn), shockRestrictedApproachIn: numOrNull(s.shockRestrictedApproachIn),
    labelSeverity: s.labelSeverity, enclosureType: s.enclosureType,
    enclosureHeightMm: numOrNull(s.enclosureHeightMm), enclosureWidthMm: numOrNull(s.enclosureWidthMm), enclosureDepthMm: numOrNull(s.enclosureDepthMm),
    ermsPresent: s.ermsPresent, zsiEnabled: s.zsiEnabled, differentialPresent: s.differentialPresent, arcResistant: s.arcResistant, nec24087Method: s.nec24087Method,
    calcMethod: s.calcMethod,
    study: {
      id: st.id, studyType: st.studyType, performedDate: st.performedDate, expiresAt: st.expiresAt,
      method: st.method, peName: st.peName, peLicense: st.peLicense, superseded: !!st.supersededById,
      sourceModel: st.sourceModel ? sourceModelOut(st.sourceModel) : null,
    },
  };
}

// Map a flattened studyAssetOut row + the asset's equipment type into the shape
// the gap engine / confidence scorer read.
function busFromStudyAssetRow(s: any, equipmentType: any) {
  return {
    busName: s.busName, equipmentTypeGuess: equipmentType, nominalVoltage: s.nominalVoltage,
    boltedFaultCurrentKA: s.boltedFaultCurrentKA, clearingTimeMs: s.clearingTimeMs,
    electrodeConfig: s.electrodeConfig, conductorGapMm: s.conductorGapMm, workingDistanceIn: s.workingDistanceIn,
    deviceType: s.deviceType, tripUnitType: s.tripUnitType, deviceRatingA: s.deviceRatingA, deviceSettings: s.deviceSettings,
    cableLengthFt: s.cableLengthFt, cableSize: s.cableSize,
  };
}

// ── GET /asset/:assetId ── everything arc-flash about one asset (the tab data) ─
router.get('/asset/:assetId', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const asset = await prisma.asset.findFirst({ where: { id: req.params.assetId, accountId }, select: { id: true, equipmentType: true, siteId: true } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const [studyAssetsRaw, devices, tasks, tests, customValues] = await Promise.all([
      prisma.systemStudyAsset.findMany({
        where: { assetId: asset.id, accountId },
        include: { study: { select: { id: true, studyType: true, performedDate: true, expiresAt: true, method: true, peName: true, peLicense: true, supersededById: true, sourceModel: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.protectiveDevice.findMany({ where: { assetId: asset.id, accountId, status: 'active' }, orderBy: { createdAt: 'desc' } }),
      prisma.arcFlashCollectionTask.findMany({ where: { assetId: asset.id, accountId, status: { in: ['open', 'in_progress'] } }, orderBy: { createdAt: 'desc' } }),
      prisma.deviceTestRecord.findMany({ where: { assetId: asset.id, accountId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.customFieldValue.findMany({ where: { assetId: asset.id, definition: { appliesTo: 'arc_flash', archivedAt: null } }, include: { definition: true } }),
    ]);

    const studyAssets: any[] = studyAssetsRaw.map(studyAssetOut);
    // Slice 2.8a — deterministic per-bus confidence/trust score. Field-verified
    // device provenance + drift are asset-level signals; completeness + study age
    // are per-row.
    const deviceSource = pickDeviceSource(devices);
    const driftFlagged = tests.some((t: any) => t.driftFlagged);
    for (const s of studyAssets) {
      s.confidence = scoreBusConfidence({
        bus: busFromStudyAssetRow(s, asset.equipmentType),
        study: { performedDate: s.study?.performedDate, expiresAt: s.study?.expiresAt, superseded: s.study?.superseded },
        deviceSource, driftFlagged,
      });
    }
    // Current label = the row from the latest non-superseded study (fallback: newest performedDate).
    const sorted = studyAssets.slice().sort((a: any, b: any) => {
      const sa = a.study.superseded ? 0 : 1, sb = b.study.superseded ? 0 : 1;
      if (sa !== sb) return sb - sa;
      return new Date(b.study.performedDate || 0).getTime() - new Date(a.study.performedDate || 0).getTime();
    });
    const current = sorted[0] || null;
    const danger = current ? (((current.incidentEnergyCalCm2 != null && current.incidentEnergyCalCm2 > 40) || (voltsOf(current.nominalVoltage) || 0) > 600)) : false;

    res.json({
      success: true,
      data: {
        assetId: asset.id,
        siteId: asset.siteId,
        hasArcFlash: studyAssets.length > 0 || devices.length > 0 || tasks.length > 0 || tests.length > 0 || customValues.length > 0,
        current,
        confidence: current ? current.confidence : null,
        contradictions: current ? checkBusContradictions(current, { utilityMaxFaultKA: current.study?.sourceModel?.utilityMaxFaultKA ?? null }) : [],
        labelSeverity: current ? (current.labelSeverity || (danger ? 'danger' : 'warning')) : null,
        studyAssets,
        devices: devices.map(deviceOut),
        collectionTasks: tasks.map(taskOut),
        deviceTests: tests.map(deviceTestOut),
        staleStudy: tests.some((t: any) => t.driftFlagged),
        customFields: customValues
          .filter((v: any) => v.definition)
          .map((v: any) => ({ definitionId: v.definitionId, name: v.definition.name, type: v.definition.type, value: v.value })),
      },
    });
  } catch (e) {
    console.error('arc-flash asset summary error:', e);
    res.status(500).json({ success: false, error: 'Failed to load arc-flash asset summary' });
  }
});

// ── GET /report ── account-wide arc-flash label report (Reports hub) ──────────
// Every current (non-superseded) per-bus label across the account: the NFPA 70E
// 130.5(H) fields + DANGER/WARNING severity + study expiry. Printable from the
// Reports section. Manager/admin only (mounted under the manager-gated hub use).
router.get('/report', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const soon = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const rows = await prisma.systemStudyAsset.findMany({
      where: { accountId, study: { supersededById: null } },
      include: {
        study: { select: { performedDate: true, expiresAt: true, method: true, studyType: true } },
        asset: { select: { id: true, equipmentType: true, site: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });
    const out = rows.map((s: any) => {
      const ie = numOrNull(s.incidentEnergyCalCm2);
      const v = voltsOf(s.nominalVoltage);
      const sev = s.labelSeverity || (((ie != null && ie > 40) || (v != null && v > 600)) ? 'danger' : (ie != null || v != null ? 'warning' : null));
      return {
        assetId: s.assetId, busName: s.busName, site: s.asset?.site?.name || null, equipmentType: s.asset?.equipmentType || null,
        nominalVoltage: s.nominalVoltage, incidentEnergyCalCm2: ie, arcFlashBoundaryIn: numOrNull(s.arcFlashBoundaryIn),
        ppeCategory: s.ppeCategory, requiredArcRatingCalCm2: numOrNull(s.requiredArcRatingCalCm2),
        labelSeverity: sev, performedDate: s.study?.performedDate || null, expiresAt: s.study?.expiresAt || null,
        expiringSoon: s.study?.expiresAt ? new Date(s.study.expiresAt) <= soon : false,
      };
    });
    const summary = {
      total: out.length,
      danger: out.filter((r: any) => r.labelSeverity === 'danger').length,
      warning: out.filter((r: any) => r.labelSeverity === 'warning').length,
      expiringSoon: out.filter((r: any) => r.expiringSoon).length,
    };
    res.json({ success: true, data: { rows: out, summary } });
  } catch (e) {
    console.error('arc-flash report error:', e);
    res.status(500).json({ success: false, error: 'Failed to build arc-flash report' });
  }
});

module.exports = router;
