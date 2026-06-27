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
const { parseQuery, matchRow } = require('../lib/arcFlashSearch');
const { buildExportRows, toCsv, EXPORT_COLUMNS } = require('../lib/arcFlashExport');
const { parseResultsCsv, matchResults } = require('../lib/arcFlashResultsImport');
const QRCode = require('qrcode');
const crypto = require('crypto');
const { labelSnapshot, computeLabelMismatch } = require('../lib/arcFlashLabel');
const { searchTcc, suggestFromDevice } = require('../lib/arcFlashTccLibrary');
const { INCIDENT_TYPES, WORK_TYPES, normEnum: normIncidentEnum, buildStudyStateSnapshot, incidentOut, rollupIncidentsBySite } = require('../lib/arcFlashIncident');
const { buildAfxSpec, validateAfxCsv } = require('../lib/arcFlashAfx');
const { CROSSWALK, TOOLS, buildAliasIndex, buildToolTemplate, toolTemplateCsv } = require('../lib/afxProfiles');
const { buildMultiTable, renderForTool, parseSheetRows, validateMultiTable, planMultiTableImport, buildFillUpdates, buildMergeConflictPreview, mapEquipmentType, TABLES: MT_TABLES, TOOLS: MT_TOOLS } = require('../lib/arcFlashAfxMultiTable');
const { normalizeKey: idemNormalizeKey, findStored: idemFindStored, store: idemStore } = require('../lib/apiIdempotency');
const normBusKey = (s: any) => String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
const MAX_AFX_MULTI_ROWS = 5000; // DoS guard: cap total rows an import request may carry
const afxRowCount = (t: any) => (t?.buses?.length || 0) + (t?.cables?.length || 0) + (t?.transformers?.length || 0) + (t?.devices?.length || 0);
// Bound a device-settings cell: must be a plain object and not huge, else dropped.
function safeDeviceSettings(raw: any): any {
  if (raw == null || raw === '') return undefined;
  let s: any;
  try { s = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return undefined; }
  if (typeof s !== 'object' || Array.isArray(s)) return undefined;
  try { if (JSON.stringify(s).length > 8192) return undefined; } catch { return undefined; }
  return s;
}
const ExcelJS = require('exceljs');
const { isLoadChannel, assessLoadGrowth } = require('../lib/telemetryLoadGrowth');
const PDFDocument = require('pdfkit');
const { buildLabelModel, drawArcFlashLabel, LABEL_W, LABEL_H } = require('../lib/arcFlashLabelDoc');
const { getAccountBranding } = require('../lib/partnerBranding');
const { recommendMitigations, estimateMitigationRoi } = require('../lib/arcFlashMitigation');
const { buildEnergizedWorkPermit } = require('../lib/arcFlashPermit');
const { buildTimeline } = require('../lib/arcFlashTimeline');
const { assessRegulatoryStatus } = require('../lib/arcFlashRegulatory');
const { buildOneLine } = require('../lib/arcFlashOneLine');
const { computeRiskScore, buildBenchmark } = require('../lib/arcFlashRiskScore');

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

      const finalStatus = ext.buses.length ? 'needs_review' : 'failed';
      // Atomic: persist every extracted bus + flip the ingest status together, so
      // a crash mid-loop rolls back rather than leaving a half-written ingest.
      await prisma.$transaction(async (tx: any) => {
        for (let i = 0; i < ext.buses.length; i++) {
          const b = ext.buses[i];
          const g = gapResults[i];
          await tx.arcFlashIngestBus.create({
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

        await tx.arcFlashIngest.update({
          where: { id: ingest.id },
          data: {
            status: finalStatus, extractionMethod: ext.method, aiProvider: ext.aiProvider, promptVersion: ext.promptVersion,
            systemMeta: ext.systemMeta ?? undefined, rawExtraction: ext.rawJsonText ? { text: String(ext.rawJsonText).slice(0, 20000) } : undefined,
            overallBand: summary.overallBand, readyBusCount: summary.readyBusCount, totalBusCount: summary.totalBusCount,
            error: ext.buses.length ? null : (ext.warnings[0] || 'No buses extracted'),
          },
        });
      }, { timeout: 30000 }); // ingest can be slow with many buses

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
      // PEN-7-12: apply the same 8 KB size guard used on the create path.
      else if (typeof b.deviceSettings === 'object' && b.deviceSettings !== null) patch.deviceSettings = safeDeviceSettings(b.deviceSettings);
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

    // [LEGAL-8-5] Audit reviewer edits to the hazard inputs/outputs on this draft
    // bus with before/after. These values flow into the durable study + label on
    // confirm, so a hand-typed PPE category or incident energy must record who
    // entered it and what it replaced. Derived fields (gaps/readiness/confidence)
    // are excluded — only the human-entered hazard data is audited. Routed through
    // ActivityLog so the hash chain (LEGAL-8-6) commits to the values.
    const AUDITED_BUS_FIELDS = [
      'busName', 'nominalVoltage', 'incidentEnergyCalCm2', 'arcFlashBoundaryIn', 'ppeCategory',
      'electrodeConfig', 'clearingTimeMs', 'workingDistanceIn', 'boltedFaultCurrentKA', 'arcingCurrentKA',
      'conductorGapMm', 'deviceType', 'deviceManufacturer', 'deviceModel', 'deviceRatingA', 'deviceSettings',
      'tripUnitType', 'fuseClass', 'upstreamDevice', 'resolution', 'matchedAssetId',
    ];
    const busChanges: Record<string, { from: any; to: any }> = {};
    for (const f of AUDITED_BUS_FIELDS) {
      if (!(f in patch)) continue;
      const before = (bus as any)[f] ?? null;
      const after  = (updated as any)[f] ?? null;
      const bStr = before == null ? null : (typeof before === 'object' ? JSON.stringify(before) : before);
      const aStr = after  == null ? null : (typeof after  === 'object' ? JSON.stringify(after)  : after);
      if (bStr !== aStr) busChanges[f] = { from: before, to: after };
    }
    if (Object.keys(busChanges).length > 0) {
      await logActivity(req.user.id, req.user.accountId, 'arc_flash_ingest_bus_edited', {
        ingestId: ingest.id, busId: bus.id, editedBy: req.user.id, changes: busChanges,
      });
    }

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

    // Atomic: assets, feed links, optional study + bound buses, and the final
    // ingest status flip all commit together (or roll back as one).
    let feedsWired = 0;
    let studyId: string | null = null;
    let boundCount = 0;
    await prisma.$transaction(async (txn: any) => {
      // PEN-7-7: Re-check status inside the transaction to prevent a concurrent
      // double-confirm race from creating duplicate assets. The pre-transaction
      // check (line above) is a fast-path guard; this is the atomic safety net.
      const fresh = await txn.arcFlashIngest.findUnique({ where: { id: ingest.id }, select: { status: true } });
      if (fresh?.status === 'confirmed') throw Object.assign(new Error('ALREADY_CONFIRMED'), { _alreadyConfirmed: true });

      // Pass 1: create / match assets (no feed links yet).
    for (const b of buses) {
      if (b.resolution === 'create') {
        const asset = await txn.asset.create({
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
        const a = await txn.asset.findFirst({ where: { id: b.matchedAssetId, accountId }, select: { id: true } });
        if (a) { nameToAssetId.set(b.busName, a.id); assetsMatched++; }
      }
    }

    // Pass 2: wire feeds-downstream topology (cycle-guarded by name graph).
    const safe = safeFeeds(buses);
    for (const b of buses) {
      const selfId = nameToAssetId.get(b.busName);
      const upstreamName = safe.get(b.busName);
      if (!selfId || !upstreamName) continue;
      const upstreamId = nameToAssetId.get(upstreamName);
      if (upstreamId && upstreamId !== selfId) {
        await txn.asset.update({ where: { id: selfId }, data: { fedFromAssetId: upstreamId } });
        feedsWired++;
      }
    }

    // Optional: spin up a SystemStudy from the extracted inputs and bind buses.
    if (req.body && req.body.createStudy) {
      const studyType = req.body.studyType === 'one_line_review' ? 'one_line_review' : 'arc_flash';
      const performed = req.body.performedDate ? new Date(req.body.performedDate) : new Date();
      const sm = (ingest.systemMeta || {}) as any;
      const study = await txn.systemStudy.create({
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
        await txn.studySourceModel.create({
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
        await txn.systemStudyAsset.upsert({
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

    await txn.arcFlashIngest.update({ where: { id: ingest.id }, data: { status: 'confirmed', confirmedById: req.user.id, confirmedAt: new Date(), producedStudyId: studyId } });
    }, { timeout: 30000 }); // confirm can create many assets + study-bus rows
    // [LEGAL-8-10] When this confirm produced a durable study, record the
    // provenance of the bound hazard values: which were machine-extracted by an AI
    // (unverified) vs the PE name attached. SC has no schema column to stamp each
    // bus value's source without a migration, so the attestation lives in the
    // audit trail (and flows through the hash chain, LEGAL-8-6). studySignedOff is
    // false unless a PE name was carried onto the produced study.
    const peOnStudy = (((ingest as any).systemMeta || {}).studyMeta || {}).peName || null;
    await logActivity(req.user.id, accountId, 'arc_flash_ingest_confirmed', {
      ingestId: ingest.id, assetsCreated, assetsMatched, feedsWired, studyId, boundCount,
      confirmedBy: req.user.id,
      provenance: {
        // The bus values came from the ingest extraction pipeline.
        source: ingest.extractionMethod ? 'ai_extracted' : 'manual_entry',
        extractionMethod: ingest.extractionMethod || null,
        aiProvider: ingest.aiProvider || null,
        promptVersion: ingest.promptVersion || null,
        peName: peOnStudy,
        // A produced study is NOT PE-signed-off just because it was confirmed —
        // it carries AI-extracted numbers unless a qualified person re-verifies.
        peSignedOff: !!peOnStudy,
      },
    });

    res.json({ success: true, data: { ingestId: ingest.id, assetsCreated, assetsMatched, feedsWired, studyId, boundCount } });
  } catch (e: any) {
    // PEN-7-7: concurrent double-confirm detected inside the transaction.
    if (e?._alreadyConfirmed) return res.status(409).json({ success: false, error: 'Ingest already confirmed' });
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
    const [rows, devices, driftTests, incidents] = await Promise.all([
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
      prisma.arcFlashIncident.findMany({ where: { accountId }, select: { siteId: true, occurredAt: true, createdAt: true, status: true, injury: true }, take: 5000 }),
    ]);

    const devByAsset = new Map<string, any[]>();
    for (const d of devices) { if (!d.assetId) continue; const arr = devByAsset.get(d.assetId) || []; arr.push(d); devByAsset.set(d.assetId, arr); }
    const driftAssets = new Set(driftTests.map((t: any) => t.assetId));
    // Recent incidents per site (last 365 days) — the strongest attention signal.
    const incidentsBySite = rollupIncidentsBySite(incidents, Date.now(), 365);

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

    const siteList = Array.from(sites.values()).map((s: any) => {
      const inc = incidentsBySite.get(s.siteId) || { recent: 0, open: 0, injury: 0, lastOccurredAt: null };
      return {
        siteId: s.siteId, siteName: s.siteName, busCount: s.busCount, dangerCount: s.dangerCount,
        dangerPct: s.busCount ? Math.round((s.dangerCount / s.busCount) * 100) : 0,
        blockedCount: s.blockedCount, lowConfidenceCount: s.lowConfidenceCount,
        avgConfidence: s.busCount ? Math.round(s.confidenceSum / s.busCount) : null,
        contradictionErrors: s.errorCount, contradictionWarnings: s.warningCount,
        studyCount: s.studyIds.size, expiringStudies: s.expiringStudyIds.size,
        recentIncidents: inc.recent, openIncidents: inc.open, incidentInjuries: inc.injury,
        lastIncidentAt: inc.lastOccurredAt ? new Date(inc.lastOccurredAt).toISOString() : null,
      };
      // a recent real-world incident outranks DANGER% for attention
    }).sort((a, b) => (b.recentIncidents - a.recentIncidents) || (b.dangerCount - a.dangerCount) || (a.avgConfidence ?? 100) - (b.avgConfidence ?? 100));

    const totals = siteList.reduce((acc: any, s: any) => ({
      sites: acc.sites + 1, busCount: acc.busCount + s.busCount, dangerCount: acc.dangerCount + s.dangerCount,
      blockedCount: acc.blockedCount + s.blockedCount, lowConfidenceCount: acc.lowConfidenceCount + s.lowConfidenceCount,
      contradictionErrors: acc.contradictionErrors + s.contradictionErrors, contradictionWarnings: acc.contradictionWarnings + s.contradictionWarnings,
      expiringStudies: acc.expiringStudies + s.expiringStudies, recentIncidents: acc.recentIncidents + s.recentIncidents,
      openIncidents: acc.openIncidents + s.openIncidents, confWeighted: acc.confWeighted + (s.avgConfidence ?? 0) * s.busCount,
    }), { sites: 0, busCount: 0, dangerCount: 0, blockedCount: 0, lowConfidenceCount: 0, contradictionErrors: 0, contradictionWarnings: 0, expiringStudies: 0, recentIncidents: 0, openIncidents: 0, confWeighted: 0 });
    const avgConfidence = totals.busCount ? Math.round(totals.confWeighted / totals.busCount) : null;

    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const cols: Array<[string, string]> = [
        ['Site', 'siteName'], ['Buses', 'busCount'], ['DANGER', 'dangerCount'], ['DANGER %', 'dangerPct'],
        ['Blocked', 'blockedCount'], ['Avg confidence', 'avgConfidence'], ['Low confidence', 'lowConfidenceCount'],
        ['Sanity errors', 'contradictionErrors'], ['Sanity warnings', 'contradictionWarnings'],
        ['Studies', 'studyCount'], ['Expiring (90d)', 'expiringStudies'],
        ['Incidents (12mo)', 'recentIncidents'], ['Open incidents', 'openIncidents'],
        ['Incident injuries', 'incidentInjuries'], ['Last incident', 'lastIncidentAt'],
      ];
      const esc = (v: any) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const lines = [cols.map((c) => c[0]).join(',')];
      for (const s of siteList) lines.push(cols.map((c) => esc((s as any)[c[1]])).join(','));
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="arc-flash-fleet-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.send(lines.join('\r\n'));
    }

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

    const [studyAssetsRaw, devices, tasks, tests, customValues, incidents] = await Promise.all([
      prisma.systemStudyAsset.findMany({
        where: { assetId: asset.id, accountId },
        include: { study: { select: { id: true, studyType: true, performedDate: true, expiresAt: true, method: true, peName: true, peLicense: true, supersededById: true, sourceModel: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.protectiveDevice.findMany({ where: { assetId: asset.id, accountId, status: 'active' }, orderBy: { createdAt: 'desc' } }),
      prisma.arcFlashCollectionTask.findMany({ where: { assetId: asset.id, accountId, status: { in: ['open', 'in_progress'] } }, orderBy: { createdAt: 'desc' } }),
      prisma.deviceTestRecord.findMany({ where: { assetId: asset.id, accountId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.customFieldValue.findMany({ where: { assetId: asset.id, definition: { appliesTo: 'arc_flash', archivedAt: null } }, include: { definition: true } }),
      prisma.arcFlashIncident.findMany({ where: { assetId: asset.id, accountId }, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], take: 50 }),
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
        hasArcFlash: studyAssets.length > 0 || devices.length > 0 || tasks.length > 0 || tests.length > 0 || customValues.length > 0 || incidents.length > 0,
        current,
        confidence: current ? current.confidence : null,
        contradictions: current ? checkBusContradictions(current, { utilityMaxFaultKA: current.study?.sourceModel?.utilityMaxFaultKA ?? null }) : [],
        mitigations: current ? recommendMitigations(current) : null,
        labelSeverity: current ? (current.labelSeverity || (danger ? 'danger' : 'warning')) : null,
        studyAssets,
        devices: devices.map(deviceOut),
        collectionTasks: tasks.map(taskOut),
        deviceTests: tests.map(deviceTestOut),
        staleStudy: tests.some((t: any) => t.driftFlagged),
        customFields: customValues
          .filter((v: any) => v.definition)
          .map((v: any) => ({ definitionId: v.definitionId, name: v.definition.name, type: v.definition.type, value: v.value })),
        incidents: incidents.map(incidentOut),
      },
    });
  } catch (e) {
    console.error('arc-flash asset summary error:', e);
    res.status(500).json({ success: false, error: 'Failed to load arc-flash asset summary' });
  }
});

// ── Arc-flash incident / near-miss register (manager+ - sensitive injury/OSHA data) ─
// Manual entry; on create SC snapshots the current label/study state so the record
// self-contextualizes. SC stores the customer's record; it makes no fault/blame call.
router.post('/asset/:assetId/incidents', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const asset = await prisma.asset.findFirst({ where: { id: req.params.assetId, accountId }, select: { id: true, siteId: true } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const b = req.body || {};
    if (!b.description || typeof b.description !== 'string' || !b.description.trim()) {
      return res.status(400).json({ success: false, error: 'A description of what happened is required.' });
    }
    // Snapshot the current label/study at log time.
    const rows = await prisma.systemStudyAsset.findMany({
      where: { assetId: asset.id, accountId },
      include: { study: { select: { performedDate: true, expiresAt: true, supersededById: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const currentRaw = currentStudyAssetRow(rows);
    const current = currentRaw ? studyAssetOut(currentRaw) : null;
    const snapshot = buildStudyStateSnapshot(current);
    const occurredAt = b.occurredAt ? new Date(b.occurredAt) : null;
    const created = await prisma.arcFlashIncident.create({
      data: {
        accountId,
        siteId: asset.siteId,
        assetId: asset.id,
        systemStudyAssetId: currentRaw?.id || null,
        busName: current?.busName || null,
        incidentType: normIncidentEnum(b.incidentType, INCIDENT_TYPES, 'near_miss'),
        occurredAt: occurredAt && !isNaN(occurredAt.getTime()) ? occurredAt : null,
        description: String(b.description).slice(0, 5000),
        injury: !!b.injury,
        injuryDetail: b.injuryDetail ? String(b.injuryDetail).slice(0, 2000) : null,
        ppeWorn: b.ppeWorn ? String(b.ppeWorn).slice(0, 1000) : null,
        workType: b.workType ? normIncidentEnum(b.workType, WORK_TYPES, 'other') : null,
        oshaRecordable: typeof b.oshaRecordable === 'boolean' ? b.oshaRecordable : null,
        correctiveAction: b.correctiveAction ? String(b.correctiveAction).slice(0, 5000) : null,
        studyStateSnapshot: snapshot || undefined,
        reportUrl: b.reportUrl ? String(b.reportUrl).slice(0, 1000) : null,
        reportedById: req.user.id,
      },
    });
    res.json({ success: true, data: { incident: incidentOut(created) } });
  } catch (e) {
    console.error('arc-flash incident create error:', e);
    res.status(500).json({ success: false, error: 'Failed to log incident' });
  }
});

router.get('/asset/:assetId/incidents', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const asset = await prisma.asset.findFirst({ where: { id: req.params.assetId, accountId }, select: { id: true } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const rows = await prisma.arcFlashIncident.findMany({ where: { assetId: asset.id, accountId }, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], take: 100 });
    res.json({ success: true, data: { incidents: rows.map(incidentOut) } });
  } catch (e) {
    console.error('arc-flash incident list error:', e);
    res.status(500).json({ success: false, error: 'Failed to load incidents' });
  }
});

router.patch('/incidents/:id', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const found = await prisma.arcFlashIncident.findFirst({ where: { id: req.params.id, accountId }, select: { id: true, resolvedAt: true } });
    if (!found) return res.status(404).json({ success: false, error: 'Incident not found' });
    const b = req.body || {};
    const data: any = {};
    if (typeof b.status === 'string' && ['open', 'reviewed', 'closed'].includes(b.status)) data.status = b.status;
    // resolvedAt: stamp once when the incident reaches the terminal 'closed' state.
    if (data.status === 'closed' && !found.resolvedAt) data.resolvedAt = new Date();
    if (typeof b.correctiveAction === 'string') data.correctiveAction = b.correctiveAction.slice(0, 5000);
    if (!Object.keys(data).length) return res.status(400).json({ success: false, error: 'Nothing to update.' });
    const updated = await prisma.arcFlashIncident.update({ where: { id: found.id }, data });
    res.json({ success: true, data: { incident: incidentOut(updated) } });
  } catch (e) {
    console.error('arc-flash incident update error:', e);
    res.status(500).json({ success: false, error: 'Failed to update incident' });
  }
});

// Pick the current (latest non-superseded, else newest) study-asset row.
function currentStudyAssetRow(rows: any[]): any {
  return rows.slice().sort((a: any, b: any) => {
    const sa = a.study?.supersededById ? 0 : 1, sb = b.study?.supersededById ? 0 : 1;
    if (sa !== sb) return sb - sa;
    return new Date(b.study?.performedDate || 0).getTime() - new Date(a.study?.performedDate || 0).getTime();
  })[0] || null;
}

function sanitizeOrigin(raw: any): string {
  const s = String(raw || '').trim();
  return /^https?:\/\/[A-Za-z0-9.\-]+(:\d+)?$/.test(s) ? s : '';
}

// ── POST /asset/:assetId/issue-label ── Slice 3.5c: issue / reprint the QR label ─
// Mints (or reuses) a stable public token for the asset's current label, snapshots
// the printed values, and returns a QR encoding the public portal URL. Scanning it
// later resolves to the LIVE record + flags a printed-vs-current mismatch.
router.post('/asset/:assetId/issue-label', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const asset = await prisma.asset.findFirst({ where: { id: req.params.assetId, accountId }, select: { id: true } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const rows = await prisma.systemStudyAsset.findMany({
      where: { assetId: asset.id, accountId },
      include: { study: { select: { performedDate: true, supersededById: true } } },
    });
    if (!rows.length) return res.status(400).json({ success: false, error: 'No bound study to label for this asset yet.' });
    const current = currentStudyAssetRow(rows);
    const snapshot = labelSnapshot(current);

    const anchor = rows.find((r: any) => r.publicToken) || current;
    const token = anchor.publicToken || crypto.randomBytes(16).toString('hex');
    await prisma.systemStudyAsset.update({ where: { id: anchor.id }, data: { publicToken: token, printedSnapshot: snapshot, printedAt: new Date() } });
    await logActivity(req.user.id, accountId, 'arc_flash_label_issued', { assetId: asset.id, token });

    const origin = sanitizeOrigin(req.body && req.body.origin);
    const path = `/l/${token}`;
    const url = origin ? origin + path : path;
    let qrDataUrl: string | null = null;
    try { qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 256 }); } catch { qrDataUrl = null; }

    res.json({ success: true, data: { token, path, url, qrDataUrl, label: snapshot, printedAt: new Date().toISOString() } });
  } catch (e) {
    console.error('arc-flash issue-label error:', e);
    res.status(500).json({ success: false, error: 'Failed to issue label' });
  }
});

// ── GET /asset/:assetId/timeline ── Slice 11: time-machine of the bus history ──
// One chronological stream: study revisions, label issuances, NETA tests (drift),
// collected devices. Assembled from existing records. Any authed role.
router.get('/asset/:assetId/timeline', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const asset = await prisma.asset.findFirst({ where: { id: req.params.assetId, accountId }, select: { id: true } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const [studyAssets, deviceTests, devices] = await Promise.all([
      prisma.systemStudyAsset.findMany({ where: { assetId: asset.id, accountId }, include: { study: { select: { performedDate: true, peName: true } } } }),
      prisma.deviceTestRecord.findMany({ where: { assetId: asset.id, accountId }, take: 200 }),
      prisma.protectiveDevice.findMany({ where: { assetId: asset.id, accountId }, take: 200 }),
    ]);
    const events = buildTimeline({ studyAssets, deviceTests, devices });
    res.json({ success: true, data: { events } });
  } catch (e) {
    console.error('arc-flash timeline error:', e);
    res.status(500).json({ success: false, error: 'Failed to build the timeline' });
  }
});

// ── GET /asset/:assetId/permit ── Slice 5: energized-work-permit + issuance gate ─
// Pre-fills the NFPA 70E 130.2(B) permit from the current label and blocks
// issuance when the study is missing / expired / superseded. Any authed role can
// view (field crews need it); the site program governs who signs.
router.get('/asset/:assetId/permit', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const asset = await prisma.asset.findFirst({ where: { id: req.params.assetId, accountId }, select: { id: true, equipmentType: true, site: { select: { name: true } } } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const rows = await prisma.systemStudyAsset.findMany({
      where: { assetId: asset.id, accountId },
      include: { study: { select: { performedDate: true, expiresAt: true, peName: true, method: true, supersededById: true } } },
    });
    const current = currentStudyAssetRow(rows);
    if (!current) return res.status(400).json({ success: false, error: 'No bound study for this asset.' });
    const busShape = {
      busName: current.busName, nominalVoltage: current.nominalVoltage,
      incidentEnergyCalCm2: numOrNull(current.incidentEnergyCalCm2), arcFlashBoundaryIn: numOrNull(current.arcFlashBoundaryIn),
      workingDistanceIn: numOrNull(current.workingDistanceIn), shockLimitedApproachIn: numOrNull(current.shockLimitedApproachIn),
      shockRestrictedApproachIn: numOrNull(current.shockRestrictedApproachIn), ppeCategory: current.ppeCategory,
      requiredArcRatingCalCm2: numOrNull(current.requiredArcRatingCalCm2),
    };
    // [LEGAL-8-12] Detect an unreviewed system change since the study that
    // date/supersession can't see: a protective device on this asset whose
    // settings were collected AFTER the study was performed. Device settings drive
    // clearing time -> the IEEE 1584 incident energy, so a newer setting means the
    // posted number may be stale. When found, downgrade canIssue and explain why.
    let unreviewedDrift = false;
    let driftReason: string | undefined;
    const studyPerformed = current.study?.performedDate ? new Date(current.study.performedDate) : null;
    if (studyPerformed && !Number.isNaN(studyPerformed.getTime())) {
      const driftedDevice = await prisma.protectiveDevice.findFirst({
        where: { assetId: asset.id, accountId, status: 'active', settingsCollectedAt: { gt: studyPerformed } },
        select: { id: true, label: true, settingsCollectedAt: true },
      });
      if (driftedDevice) {
        unreviewedDrift = true;
        driftReason = `A protective-device setting (${driftedDevice.label || 'device'}) was collected after the study date — clearing time may have changed, so the incident energy needs re-verification by a qualified person before issuing.`;
      }
    }
    const permit = buildEnergizedWorkPermit({ bus: busShape, study: current.study, asset, unreviewedDrift, driftReason });
    res.json({ success: true, data: { permit } });
  } catch (e) {
    console.error('arc-flash permit error:', e);
    res.status(500).json({ success: false, error: 'Failed to build the permit' });
  }
});

// ── POST /asset/:assetId/what-if ── Slice 4.5: mitigation what-if + ROI ───────
// Models the effect of a USER/PE-supplied expected reduction % on the asset's
// current incident energy: energy-after, PPE-band change, whether it clears the
// >40 cal DANGER line, and $/cal-reduced. SC does NOT run IEEE 1584 — the
// reduction % is an input, and the result is flagged "confirm by re-study".
router.post('/asset/:assetId/what-if', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const asset = await prisma.asset.findFirst({ where: { id: req.params.assetId, accountId }, select: { id: true } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const rows = await prisma.systemStudyAsset.findMany({
      where: { assetId: asset.id, accountId },
      include: { study: { select: { performedDate: true, supersededById: true } } },
    });
    if (!rows.length) return res.status(400).json({ success: false, error: 'No bound study to model against.' });
    const current = currentStudyAssetRow(rows);
    const b = req.body || {};
    const result = estimateMitigationRoi({ currentIeCalCm2: current?.incidentEnergyCalCm2, estReductionPct: b.estReductionPct, mitigationCostUsd: b.mitigationCostUsd });
    res.json({ success: true, data: { mitigationKey: b.mitigationKey || null, busName: current?.busName || null, result } });
  } catch (e) {
    console.error('arc-flash what-if error:', e);
    res.status(500).json({ success: false, error: 'Failed to model the mitigation' });
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
    const [rows, devices, driftTests] = await Promise.all([
      prisma.systemStudyAsset.findMany({
        where: { accountId, study: { supersededById: null } },
        include: {
          study: { select: { performedDate: true, expiresAt: true, method: true, studyType: true } },
          asset: { select: { id: true, equipmentType: true, site: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 2000,
      }),
      prisma.protectiveDevice.findMany({ where: { accountId, status: 'active', assetId: { not: null } }, select: { assetId: true, source: true }, take: 5000 }),
      prisma.deviceTestRecord.findMany({ where: { accountId, driftFlagged: true, assetId: { not: null } }, select: { assetId: true }, take: 5000 }),
    ]);
    // 3b — per-row data-confidence (2.8a). Device provenance + drift are
    // asset-level; completeness + study age are per-row.
    const devByAsset = new Map<string, any[]>();
    for (const d of devices) { if (!d.assetId) continue; const arr = devByAsset.get(d.assetId) || []; arr.push(d); devByAsset.set(d.assetId, arr); }
    const driftAssets = new Set(driftTests.map((t: any) => t.assetId));
    const out = rows.map((s: any) => {
      const ie = numOrNull(s.incidentEnergyCalCm2);
      const v = voltsOf(s.nominalVoltage);
      const sev = s.labelSeverity || (((ie != null && ie > 40) || (v != null && v > 600)) ? 'danger' : (ie != null || v != null ? 'warning' : null));
      const conf = scoreBusConfidence({
        bus: busForFleet(s, s.asset?.equipmentType),
        study: { performedDate: s.study?.performedDate, expiresAt: s.study?.expiresAt, superseded: false },
        deviceSource: pickDeviceSource(devByAsset.get(s.assetId) || []), driftFlagged: driftAssets.has(s.assetId),
      });
      return {
        assetId: s.assetId, busName: s.busName, site: s.asset?.site?.name || null, equipmentType: s.asset?.equipmentType || null,
        nominalVoltage: s.nominalVoltage, incidentEnergyCalCm2: ie, arcFlashBoundaryIn: numOrNull(s.arcFlashBoundaryIn),
        ppeCategory: s.ppeCategory, requiredArcRatingCalCm2: numOrNull(s.requiredArcRatingCalCm2),
        labelSeverity: sev, performedDate: s.study?.performedDate || null, expiresAt: s.study?.expiresAt || null,
        expiringSoon: s.study?.expiresAt ? new Date(s.study.expiresAt) <= soon : false,
        confidence: { score: conf.score, band: conf.band },
      };
    });
    const confScores = out.map((r: any) => r.confidence?.score).filter((x: any) => typeof x === 'number');
    const summary = {
      total: out.length,
      danger: out.filter((r: any) => r.labelSeverity === 'danger').length,
      warning: out.filter((r: any) => r.labelSeverity === 'warning').length,
      expiringSoon: out.filter((r: any) => r.expiringSoon).length,
      avgConfidence: confScores.length ? Math.round(confScores.reduce((a: number, b: number) => a + b, 0) / confScores.length) : null,
      lowConfidence: out.filter((r: any) => r.confidence?.band === 'red').length,
    };
    res.json({ success: true, data: { rows: out, summary } });
  } catch (e) {
    console.error('arc-flash report error:', e);
    res.status(500).json({ success: false, error: 'Failed to build arc-flash report' });
  }
});

// ── GET /audit-bundle ── Slice 3c: insurer / auditor package + exec posture ────
// A single on-demand snapshot of the whole arc-flash program: a compliance
// POSTURE scorecard (coverage, DANGER, confidence, sanity errors, expiring/expired
// studies, open field tasks), a prioritized ITEMS-TO-RESOLVE punch list, the full
// label schedule, and the per-site rollup. Exposure is expressed as deterministic
// risk INDICATORS (counts) — not fabricated dollar figures. Manager/admin via the
// Reports gate. Read-only.
router.get('/audit-bundle', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const now = Date.now();
    const soon = new Date(now + 90 * 24 * 60 * 60 * 1000);
    const [account, rows, devices, driftTests, openTasks, incidents] = await Promise.all([
      prisma.account.findUnique({ where: { id: accountId }, select: { companyName: true } }),
      prisma.systemStudyAsset.findMany({
        where: { accountId, study: { supersededById: null } },
        include: {
          study: { select: { id: true, performedDate: true, expiresAt: true, method: true, peName: true, sourceModel: { select: { utilityMaxFaultKA: true } } } },
          asset: { select: { id: true, equipmentType: true, siteId: true, site: { select: { name: true } } } },
        },
        take: 3000,
      }),
      prisma.protectiveDevice.findMany({ where: { accountId, status: 'active', assetId: { not: null } }, select: { assetId: true, source: true }, take: 5000 }),
      prisma.deviceTestRecord.findMany({ where: { accountId, driftFlagged: true, assetId: { not: null } }, select: { assetId: true }, take: 5000 }),
      prisma.arcFlashCollectionTask.count({ where: { accountId, status: { in: ['open', 'in_progress'] } } }),
      prisma.arcFlashIncident.findMany({ where: { accountId }, select: { id: true, assetId: true, busName: true, incidentType: true, occurredAt: true, injury: true, status: true, description: true }, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], take: 200 }),
    ]);

    const devByAsset = new Map<string, any[]>();
    for (const d of devices) { if (!d.assetId) continue; const arr = devByAsset.get(d.assetId) || []; arr.push(d); devByAsset.set(d.assetId, arr); }
    const driftAssets = new Set(driftTests.map((t: any) => t.assetId));

    const labels: any[] = [];
    const items: any[] = [];
    const siteMap = new Map<string, any>();
    const expiredStudyIds = new Set<string>();
    const expiringStudyIds = new Set<string>();
    let dangerBuses = 0, warningBuses = 0, blockedBuses = 0, lowConfidenceBuses = 0, sanityErrors = 0, sanityWarnings = 0, confSum = 0;

    for (const r of rows) {
      const bus = busForFleet(r, r.asset?.equipmentType);
      const ie = numOrNull(r.incidentEnergyCalCm2);
      const v = voltsOf(r.nominalVoltage);
      const sev = r.labelSeverity || (((ie != null && ie > 40) || (v != null && v > 600)) ? 'danger' : (ie != null || v != null ? 'warning' : null));
      const danger = sev === 'danger';
      const g = analyzeBusGaps(busForGap(bus));
      const conf = scoreBusConfidence({ bus, study: { performedDate: r.study?.performedDate, expiresAt: r.study?.expiresAt, superseded: false }, deviceSource: pickDeviceSource(devByAsset.get(r.assetId) || []), driftFlagged: driftAssets.has(r.assetId) });
      const finds = checkBusContradictions(bus, { utilityMaxFaultKA: r.study?.sourceModel?.utilityMaxFaultKA ?? null });
      const expired = r.study?.expiresAt ? new Date(r.study.expiresAt).getTime() < now : false;
      const expiringSoon = r.study?.expiresAt ? (!expired && new Date(r.study.expiresAt) <= soon) : false;
      const siteName = r.asset?.site?.name || 'Unassigned';

      if (danger) dangerBuses++; else if (sev === 'warning') warningBuses++;
      if (g.readiness === 'blocked') blockedBuses++;
      if (conf.band === 'red') lowConfidenceBuses++;
      confSum += conf.score;
      const errs = finds.filter((f: any) => f.severity === 'error');
      sanityErrors += errs.length;
      sanityWarnings += finds.length - errs.length;
      if (r.study?.id) { if (expired) expiredStudyIds.add(r.study.id); else if (expiringSoon) expiringStudyIds.add(r.study.id); }

      labels.push({
        assetId: r.assetId, busName: r.busName, site: siteName, equipmentType: r.asset?.equipmentType || null,
        nominalVoltage: r.nominalVoltage, incidentEnergyCalCm2: ie, arcFlashBoundaryIn: numOrNull(r.arcFlashBoundaryIn),
        ppeCategory: r.ppeCategory, requiredArcRatingCalCm2: numOrNull(r.requiredArcRatingCalCm2), labelSeverity: sev,
        performedDate: r.study?.performedDate || null, expiresAt: r.study?.expiresAt || null, expired, expiringSoon,
        readiness: g.readiness, confidence: { score: conf.score, band: conf.band },
      });

      // Prioritized punch list (lower priority number = more urgent).
      for (const f of errs) items.push({ priority: 1, type: 'sanity_error', site: siteName, busName: r.busName, assetId: r.assetId, detail: f.message });
      if (expired) items.push({ priority: 2, type: 'study_expired', site: siteName, busName: r.busName, assetId: r.assetId, detail: `Study expired ${new Date(r.study.expiresAt).toLocaleDateString()}` });
      if (danger) items.push({ priority: 3, type: 'danger_bus', site: siteName, busName: r.busName, assetId: r.assetId, detail: ie != null ? `Incident energy ${ie} cal/cm^2` : 'DANGER (>600 V)' });
      if (g.readiness === 'blocked') items.push({ priority: 4, type: 'blocked_bus', site: siteName, busName: r.busName, assetId: r.assetId, detail: 'Missing required IEEE 1584 inputs' });
      if (expiringSoon) items.push({ priority: 5, type: 'study_expiring', site: siteName, busName: r.busName, assetId: r.assetId, detail: `Study expires ${new Date(r.study.expiresAt).toLocaleDateString()}` });

      const sid = r.asset?.siteId || 'unassigned';
      let site = siteMap.get(sid);
      if (!site) { site = { siteId: sid, siteName, busCount: 0, dangerCount: 0, blockedCount: 0, lowConfidenceCount: 0, confSum: 0, sanityErrors: 0, expiringStudies: new Set<string>(), expiredStudies: new Set<string>() }; siteMap.set(sid, site); }
      site.busCount++; if (danger) site.dangerCount++; if (g.readiness === 'blocked') site.blockedCount++;
      if (conf.band === 'red') site.lowConfidenceCount++; site.confSum += conf.score; site.sanityErrors += errs.length;
      if (r.study?.id) { if (expired) site.expiredStudies.add(r.study.id); else if (expiringSoon) site.expiringStudies.add(r.study.id); }
    }

    // Incident / near-miss history — a logged arc-flash event is a real
    // diligence signal. Open (unresolved) events join the punch list at the same
    // urgency as an expired study.
    const openIncidents = (incidents || []).filter((i: any) => i.status !== 'closed');
    const incidentsWithInjury = (incidents || []).filter((i: any) => i.injury).length;
    for (const inc of openIncidents) {
      items.push({ priority: 2, type: 'arc_flash_incident', site: null, busName: inc.busName || null, assetId: inc.assetId, detail: `${inc.injury ? 'Injury - ' : ''}${inc.incidentType} (unresolved): ${String(inc.description || '').slice(0, 80)}` });
    }

    items.sort((a, b) => a.priority - b.priority);
    const sites = Array.from(siteMap.values()).map((s: any) => ({
      siteId: s.siteId, siteName: s.siteName, busCount: s.busCount, dangerCount: s.dangerCount, blockedCount: s.blockedCount,
      lowConfidenceCount: s.lowConfidenceCount, avgConfidence: s.busCount ? Math.round(s.confSum / s.busCount) : null,
      sanityErrors: s.sanityErrors, expiringStudies: s.expiringStudies.size, expiredStudies: s.expiredStudies.size,
    })).sort((a, b) => b.dangerCount - a.dangerCount);

    const posture = {
      sites: sites.length, labelledBuses: labels.length, dangerBuses, warningBuses, blockedBuses,
      avgConfidence: labels.length ? Math.round(confSum / labels.length) : null, lowConfidenceBuses,
      sanityErrors, sanityWarnings, studiesExpiring90d: expiringStudyIds.size, studiesExpired: expiredStudyIds.size,
      openCollectionTasks: openTasks,
      incidentsLogged: (incidents || []).length, openIncidents: openIncidents.length, incidentsWithInjury,
      exposureNote: 'Risk is shown as deterministic indicators (DANGER buses, expired/expiring studies, unresolved sanity errors, logged incidents). ServiceCycle is the data layer; a licensed PE runs and stamps the study. Dollar exposure depends on your operations and insurer terms.',
    };

    res.json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        account: { name: account?.companyName || null },
        posture,
        itemsToResolve: items.slice(0, 250),
        itemsToResolveTotal: items.length,
        sites,
        labels,
        incidents: (incidents || []).slice(0, 50).map((i: any) => ({ id: i.id, assetId: i.assetId, busName: i.busName, incidentType: i.incidentType, occurredAt: i.occurredAt, injury: i.injury, status: i.status })),
      },
    });
  } catch (e) {
    console.error('arc-flash audit-bundle error:', e);
    res.status(500).json({ success: false, error: 'Failed to build arc-flash audit bundle' });
  }
});

// ── GET /tcc-library ── Slice 3.5d: OEM / published-TCC device lookup ──────────
// Turn a nameplate (manufacturer / model / type / rating) into a structured
// device + its published-TCC reference + a class-typical clearing time, so the
// field tech doesn't hand-look-up the curve. Deterministic seed library; every
// result is flagged "typical — verify against the published TCC". Any authed role.
router.get('/tcc-library', async (req: any, res: any) => {
  try {
    const q = req.query || {};
    const ratingA = q.ratingA != null && q.ratingA !== '' ? Number(q.ratingA) : undefined;
    const matches = searchTcc({ manufacturer: q.manufacturer, model: q.model, deviceType: q.type || q.deviceType, ratingA, q: q.q });
    const suggestion = suggestFromDevice({ manufacturer: q.manufacturer, model: q.model, deviceType: q.type || q.deviceType, ratingA });
    res.json({ success: true, data: { matches: matches.slice(0, 10), suggestion } });
  } catch (e) {
    console.error('arc-flash tcc-library error:', e);
    res.status(500).json({ success: false, error: 'Failed to search the device library' });
  }
});

// ── GET /risk-score ── Slice 10: portfolio/insurer risk score + benchmark ─────
// The account's deterministic arc-flash safety score (0-100, higher = safer) plus
// where it sits in the anonymized network. The benchmark is aggregate-only and
// withheld below the k-anonymity floor — no other account's data is ever exposed.
// Manager/admin via the Reports gate.
router.get('/risk-score', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const now = new Date();
    const [labelledBuses, dangerBuses, totalStudies, expiredStudies] = await Promise.all([
      prisma.systemStudyAsset.count({ where: { accountId, study: { supersededById: null } } }),
      prisma.systemStudyAsset.count({ where: { accountId, study: { supersededById: null }, labelSeverity: 'danger' } }),
      prisma.systemStudy.count({ where: { accountId, supersededById: null, studyType: 'arc_flash' } }),
      prisma.systemStudy.count({ where: { accountId, supersededById: null, studyType: 'arc_flash', expiresAt: { lt: now } } }),
    ]);
    // Fetch open incident counts to fold into the risk score.
    // Only open/reviewed incidents penalize - closing after corrective action clears it.
    const openIncidents = await prisma.arcFlashIncident.findMany({
      where: { accountId, status: { not: 'closed' } },
      select: { injury: true },
      take: 500,
    });
    const openWithInjury = openIncidents.filter((i: any) => i.injury).length;
    const openNoInjury   = openIncidents.filter((i: any) => !i.injury).length;
    // Recent count (last 365 days) - informational, shown in metrics panel.
    const cutoff365 = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    const recent365 = await prisma.arcFlashIncident.count({
      where: { accountId, createdAt: { gte: cutoff365 } },
    });

    const metrics = { labelledBuses, dangerBuses, totalStudies, expiredStudies };
    const risk = computeRiskScore({ ...metrics, incidents: { openWithInjury, openNoInjury, recent365 } });

    // Anonymized network benchmark: per-account DANGER ratio across all accounts,
    // ids discarded before aggregation. k-anon enforced in buildBenchmark.
    const [totals, dangers] = await Promise.all([
      prisma.systemStudyAsset.groupBy({ by: ['accountId'], where: { study: { supersededById: null } }, _count: { _all: true } }),
      prisma.systemStudyAsset.groupBy({ by: ['accountId'], where: { study: { supersededById: null }, labelSeverity: 'danger' }, _count: { _all: true } }),
    ]);
    const dangerByAcct = new Map(dangers.map((d: any) => [d.accountId, d._count._all]));
    const ratios = totals
      .filter((t: any) => t._count._all > 0)
      .map((t: any) => (dangerByAcct.get(t.accountId) || 0) / t._count._all);
    const yourRatio = labelledBuses > 0 ? dangerBuses / labelledBuses : 0;
    const benchmark = buildBenchmark(ratios, yourRatio);

    res.json({ success: true, data: { score: risk.score, band: risk.band, factors: risk.factors, metrics: { ...metrics, openWithInjury, openNoInjury, recent365 }, benchmark } });
  } catch (e) {
    console.error('arc-flash risk-score error:', e);
    res.status(500).json({ success: false, error: 'Failed to compute the risk score' });
  }
});

// ── GET /site/:siteId/one-line ── Slice 6: auto-built power-path one-line ──────
// Assembles the single-line graph forward from the site's collected assets
// (fedFromAssetId topology) + each asset's current arc-flash label. Any authed.
router.get('/site/:siteId/one-line', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const site = await prisma.site.findFirst({ where: { id: req.params.siteId, accountId }, select: { id: true, name: true } });
    if (!site) return res.status(404).json({ success: false, error: 'Site not found' });

    const assets = await prisma.asset.findMany({
      where: { accountId, siteId: site.id },
      select: { id: true, equipmentType: true, fedFromAssetId: true, nameplateData: true },
      take: 5000,
    });
    const assetIds = assets.map((a: any) => a.id);
    const labelRows = assetIds.length ? await prisma.systemStudyAsset.findMany({
      where: { accountId, assetId: { in: assetIds }, study: { supersededById: null } },
      select: { assetId: true, busName: true, nominalVoltage: true, incidentEnergyCalCm2: true, labelSeverity: true, study: { select: { performedDate: true } } },
      orderBy: { createdAt: 'desc' },
    }) : [];
    const labelByAsset = new Map<string, any>();
    for (const r of labelRows) if (!labelByAsset.has(r.assetId)) labelByAsset.set(r.assetId, r); // newest first wins

    const merged = assets.map((a: any) => {
      const l = labelByAsset.get(a.id) || {};
      return {
        id: a.id, equipmentType: a.equipmentType, fedFromAssetId: a.fedFromAssetId,
        name: (a.nameplateData && a.nameplateData.busName) || l.busName || a.equipmentType,
        nominalVoltage: l.nominalVoltage || (a.nameplateData && a.nameplateData.nominalVoltage) || null,
        incidentEnergyCalCm2: l.incidentEnergyCalCm2 != null ? numOrNull(l.incidentEnergyCalCm2) : null,
        labelSeverity: l.labelSeverity || null,
      };
    });

    const graph = buildOneLine(merged);
    res.json({ success: true, data: { site: { id: site.id, name: site.name }, ...graph } });
  } catch (e) {
    console.error('arc-flash one-line error:', e);
    res.status(500).json({ success: false, error: 'Failed to build the one-line' });
  }
});

// ── GET /regulatory-review ── Slice 12: studies on an outdated code basis ──────
// Flags current studies calculated on a superseded IEEE 1584 edition or performed
// before the current NFPA 70E edition took effect — a regulatory (not physical)
// reason a label may need review. Manager/admin via the Reports gate.
router.get('/regulatory-review', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const studies = await prisma.systemStudy.findMany({
      where: { accountId, supersededById: null, studyType: 'arc_flash' },
      select: { id: true, performedDate: true, expiresAt: true, method: true, peName: true },
      take: 2000,
    });
    const flagged: any[] = [];
    for (const s of studies) {
      const status = assessRegulatoryStatus(s);
      if (!status.outdated) continue;
      const assetCount = await prisma.systemStudyAsset.count({ where: { studyId: s.id, accountId } });
      flagged.push({
        studyId: s.id, performedDate: s.performedDate, expiresAt: s.expiresAt, method: s.method, peName: s.peName,
        ieeeEdition: status.ieeeEdition, reasons: status.reasons, assetCount,
      });
    }
    flagged.sort((a, b) => new Date(a.performedDate || 0).getTime() - new Date(b.performedDate || 0).getTime());
    res.json({ success: true, data: { totalStudies: studies.length, outdated: flagged.length, flagged } });
  } catch (e) {
    console.error('arc-flash regulatory-review error:', e);
    res.status(500).json({ success: false, error: 'Failed to run the regulatory review' });
  }
});

// ── GET /export ── Slice 3.5a: export the collected model for SKM/EasyPower ────
// CSV (default) or JSON of every current bound bus + its IEEE 1584 inputs, device,
// cable, and source model — so the PE imports the field-collected data instead of
// re-keying it. Optional ?siteId= scope. Manager/admin via the Reports gate.
router.get('/export', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const where: any = { accountId, study: { supersededById: null } };
    if (req.query.siteId) where.asset = { siteId: String(req.query.siteId) };
    const rows = await prisma.systemStudyAsset.findMany({
      where,
      include: {
        study: { select: { sourceModel: true } },
        asset: { select: { equipmentType: true, siteId: true, site: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    const records = buildExportRows(rows);

    if (String(req.query.format || 'csv').toLowerCase() === 'json') {
      return res.json({ success: true, data: { columns: EXPORT_COLUMNS.map(([key, label]: any) => ({ key, label })), records } });
    }
    const csv = toCsv(records);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="arc-flash-model-${stamp}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('arc-flash export error:', e);
    res.status(500).json({ success: false, error: 'Failed to export arc-flash model' });
  }
});

// ── GET /afx/spec ── the open Arc Flash Data Exchange (AFX) standard, versioned ─
// Any authed user can read the spec (it's an open standard). Also what powers a
// "download the spec" link + documents our default export format.
router.get('/afx/spec', (_req: any, res: any) => {
  try {
    res.json({ success: true, data: { ...buildAfxSpec(), tools: TOOLS, crosswalk: CROSSWALK } });
  } catch (e) {
    console.error('afx spec error:', e);
    res.status(500).json({ success: false, error: 'Failed to load AFX spec' });
  }
});

// ── GET /afx/template?tool=arcad|skm|easypower ── per-tool column template ──────
// Hand the PE a tool-shaped CSV (or JSON crosswalk) so the collected model
// imports without re-keying. Built from real vendor artifacts (ARCAD form +
// EasyPower's SKM import-mapping templates).
router.get('/afx/template', (req: any, res: any) => {
  try {
    const tool = String(req.query.tool || '').toLowerCase();
    const meta = buildToolTemplate(tool);
    if (!meta) return res.status(400).json({ success: false, error: `Unknown tool. Use one of: ${TOOLS.join(', ')}.` });
    if (String(req.query.format || 'csv').toLowerCase() === 'json') {
      return res.json({ success: true, data: meta });
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="afx-template-${tool}.csv"`);
    res.send(toolTemplateCsv(tool));
  } catch (e) {
    console.error('afx template error:', e);
    res.status(500).json({ success: false, error: 'Failed to build template' });
  }
});

// ── GET /afx/export-multi?tool=afx|etap|easypower&format=xlsx|json ──────────────
// Emit SC's collected model as RELATED tables (Bus / Cable / Transformer /
// Device) — the shape ETAP DataX / EasyPower / SKM actually ingest, with exact
// string-ID From/To keying. AFX columns are exact; ETAP headers are a DRAFT
// (verify against a real File>Export>ETAP DataX CSV). manager+.
router.get('/afx/export-multi', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const tool = String(req.query.tool || 'afx').toLowerCase();
    if (!MT_TOOLS.includes(tool)) return res.status(400).json({ success: false, error: `Unknown tool. Use one of: ${MT_TOOLS.join(', ')}.` });

    const where: any = { accountId, study: { supersededById: null } };
    if (req.query.siteId) where.asset = { siteId: String(req.query.siteId) };
    const rows = await prisma.systemStudyAsset.findMany({
      where,
      include: {
        study: { select: { sourceModel: true } },
        asset: { select: { id: true, equipmentType: true, fedFromAssetId: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    const assetIds = Array.from(new Set(rows.map((r: any) => r.assetId).filter(Boolean)));
    const devs = assetIds.length
      ? await prisma.protectiveDevice.findMany({ where: { accountId, status: 'active', assetId: { in: assetIds as string[] } }, select: { assetId: true, label: true, deviceType: true, manufacturer: true, model: true, frameRatingA: true, sensorRatingA: true, settings: true } })
      : [];
    const devByAsset = new Map<string, any[]>();
    for (const d of devs) { const a = devByAsset.get(d.assetId) || []; a.push(d); devByAsset.set(d.assetId, a); }

    const norm = rows.map((r: any) => ({
      busName: r.busName, assetId: r.assetId, fedFromAssetId: r.asset?.fedFromAssetId || null,
      nominalVoltage: r.nominalVoltage, equipmentType: r.asset?.equipmentType || null,
      incidentEnergyCalCm2: r.incidentEnergyCalCm2, labelSeverity: r.labelSeverity,
      cableLengthFt: r.cableLengthFt, cableSize: r.cableSize, cableMaterial: r.cableMaterial, conductorsPerPhase: r.conductorsPerPhase,
      sourceModel: r.study?.sourceModel || {},
      devices: devByAsset.get(r.assetId) || [],
    }));
    const tables = buildMultiTable(norm);
    const sheets = renderForTool(tables, tool);

    if (String(req.query.format || 'xlsx').toLowerCase() === 'json') {
      return res.json({ success: true, data: { tool, sheets } });
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ServiceCycle';
    const note = wb.addWorksheet('README');
    note.addRow(['AFX multi-table export', tool.toUpperCase()]);
    note.addRow(['Related tables keyed by exact string IDs (From/To). Match casing/whitespace exactly on import.']);
    if (tool === 'etap') note.addRow(['ETAP headers are a DRAFT - verify against a real File > Export > ETAP DataX CSV before relying on them.']);
    for (const s of sheets) {
      const ws = wb.addWorksheet(s.sheet);
      ws.addRow(s.headers);
      for (const row of s.rows) ws.addRow(row.map((v: any) => (v == null ? '' : v)));
    }
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="afx-multitable-${tool}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('afx export-multi error:', e);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to build multi-table export' });
  }
});

// ── POST /afx/validate-multi ── referential-integrity check of an AFX multi-table
// set. Accepts the exact .xlsx this endpoint's sibling exports (multipart 'file',
// tabs Buses/Cables/Transformers/Devices) OR a JSON body { buses, cables,
// transformers, devices }. Catches orphan From/To refs, duplicate IDs, and the
// whitespace/case drift that silently breaks tool imports. manager+.
const SHEET_TO_TABLE: Record<string, string> = { Buses: 'buses', Cables: 'cables', Transformers: 'transformers', Devices: 'devices' };
async function tablesFromWorkbook(buf: Buffer): Promise<any> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const out: any = { buses: [], cables: [], transformers: [], devices: [] };
  for (const [sheetName, tableKey] of Object.entries(SHEET_TO_TABLE)) {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) continue;
    const headers: any[] = [];
    const rows: any[][] = [];
    ws.eachRow((row: any, n: number) => {
      const vals = (row.values || []).slice(1).map((v: any) => (v == null ? '' : (typeof v === 'object' && v.text != null ? v.text : v)));
      if (n === 1) headers.push(...vals); else rows.push(vals);
    });
    out[tableKey] = parseSheetRows(tableKey, headers, rows);
  }
  return out;
}

router.post('/afx/validate-multi', requireManager, (req: any, res: any) => {
  upload.single('file')(req, res, async (err: any) => {
    try {
      if (err) return res.status(400).json({ success: false, error: String(err.message || err) });
      let tables: any;
      if (req.file && req.file.buffer) {
        tables = await tablesFromWorkbook(req.file.buffer);
      } else if (req.body && (req.body.buses || req.body.cables || req.body.transformers || req.body.devices)) {
        tables = {
          buses: req.body.buses || [], cables: req.body.cables || [],
          transformers: req.body.transformers || [], devices: req.body.devices || [],
        };
      } else {
        return res.status(400).json({ success: false, error: 'Provide a multi-table .xlsx (field "file") or a JSON body with buses/cables/transformers/devices arrays.' });
      }
      if (afxRowCount(tables) > MAX_AFX_MULTI_ROWS) return res.status(413).json({ success: false, error: `Too large: ${afxRowCount(tables)} rows exceeds the ${MAX_AFX_MULTI_ROWS}-row limit.` });
      const report = validateMultiTable(tables);
      res.json({ success: true, data: report });
    } catch (e) {
      console.error('afx validate-multi error:', e);
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to validate multi-table set' });
    }
  });
});

// ── POST /afx/import-multi/preview ── DRY-RUN. Parse + validate + plan a
// multi-table import against existing buses. Writes NOTHING — returns what an
// import WOULD create vs. update so the customer can review before applying.
router.post('/afx/import-multi/preview', requireManager, (req: any, res: any) => {
  upload.single('file')(req, res, async (err: any) => {
    try {
      if (err) return res.status(400).json({ success: false, error: String(err.message || err) });
      const accountId = req.user.accountId;
      let tables: any;
      if (req.file && req.file.buffer) tables = await tablesFromWorkbook(req.file.buffer);
      else if (req.body && (req.body.buses || req.body.cables || req.body.transformers || req.body.devices)) {
        tables = { buses: req.body.buses || [], cables: req.body.cables || [], transformers: req.body.transformers || [], devices: req.body.devices || [] };
      } else return res.status(400).json({ success: false, error: 'Provide a multi-table .xlsx (field "file") or a JSON tables body.' });

      if (afxRowCount(tables) > MAX_AFX_MULTI_ROWS) return res.status(413).json({ success: false, error: `Too large: ${afxRowCount(tables)} rows exceeds the ${MAX_AFX_MULTI_ROWS}-row limit.` });
      const validation = validateMultiTable(tables);
      const existing = await prisma.systemStudyAsset.findMany({ where: { accountId, study: { supersededById: null } }, select: { busName: true, nominalVoltage: true, cableLengthFt: true, cableSize: true, cableMaterial: true, conductorsPerPhase: true }, take: 5000 });
      const plan = planMultiTableImport(tables, existing.map((r: any) => r.busName));
      const previewOverwrite = req.body && (req.body.mode === 'overwrite' || req.body.overwrite === true || req.body.overwrite === 'true');
      const mergePreview = previewOverwrite ? buildMergeConflictPreview(tables, existing) : null;
      res.json({ success: true, data: { dryRun: true, validation, plan, mergePreview } });
    } catch (e) {
      console.error('afx import-multi preview error:', e);
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to preview multi-table import' });
    }
  });
});

// ── POST /afx/import-multi/apply ── WRITES. Requires confirm:true. DEFAULT is
// FILL-ONLY: updates matched buses' BLANK fields from the import (existing,
// possibly PE-stamped, values are preserved). When the caller opts in with
// mode:'overwrite' (preview it first via import-multi/preview), it ALSO replaces
// non-blank existing values that differ — and in that case every overwritten
// field is recorded to the activity log with its prior value (LEGAL-8-8), so a
// PE-stamped figure can never be silently clobbered. Imports never erase a value
// with a blank, and never create new buses unless createNew:true. Refuses if the
// set has integrity errors. Idempotent.
router.post('/afx/import-multi/apply', requireManager, (req: any, res: any) => {
  upload.single('file')(req, res, async (err: any) => {
    try {
      if (err) return res.status(400).json({ success: false, error: String(err.message || err) });
      const accountId = req.user.accountId;
      const confirm = req.body && (req.body.confirm === true || req.body.confirm === 'true');
      if (!confirm) return res.status(400).json({ success: false, error: 'Refusing to write without confirm:true. Preview first, then re-submit with confirm.' });

      const ikey = idemNormalizeKey(req);
      if (ikey) {
        const stored = await idemFindStored(prisma, accountId, ikey);
        if (stored) return res.status(stored.statusCode).json(stored.responseBody);
      }

      let tables: any;
      if (req.file && req.file.buffer) tables = await tablesFromWorkbook(req.file.buffer);
      else if (req.body && (req.body.buses || req.body.cables || req.body.transformers || req.body.devices)) {
        tables = { buses: req.body.buses || [], cables: req.body.cables || [], transformers: req.body.transformers || [], devices: req.body.devices || [] };
      } else return res.status(400).json({ success: false, error: 'Provide a multi-table .xlsx (field "file") or a JSON tables body.' });

      if (afxRowCount(tables) > MAX_AFX_MULTI_ROWS) return res.status(413).json({ success: false, error: `Import too large: ${afxRowCount(tables)} rows exceeds the ${MAX_AFX_MULTI_ROWS}-row limit. Split the file and import in batches.` });

      const validation = validateMultiTable(tables);
      if (!validation.ok) return res.status(422).json({ success: false, error: `Import has ${validation.errors.length} integrity error(s). Fix them before applying.`, data: { validation } });

      const existing = await prisma.systemStudyAsset.findMany({
        where: { accountId, study: { supersededById: null } },
        select: { id: true, assetId: true, busName: true, nominalVoltage: true, cableLengthFt: true, cableSize: true, cableMaterial: true, conductorsPerPhase: true },
        take: 5000,
      });
      const overwrite = req.body && (req.body.mode === 'overwrite' || req.body.overwrite === true || req.body.overwrite === 'true');
      const { updates, summary } = buildFillUpdates(tables, existing, { overwrite });

      // [LEGAL-8-8] In overwrite mode, build a per-bus before/after record for every
      // field whose prior value was non-blank and is being replaced — so a bulk
      // spreadsheet can't clobber PE-stamped data without a reconstructable trail.
      // (Fill-only writes touch BLANK fields, which carry no prior value, so they
      // need no before/after.) `existing` was selected with exactly these fields.
      const existingById = new Map<string, any>(existing.map((r: any) => [r.id, r]));
      const overwriteAudit: Array<{ id: string; busName: any; changes: any }> = [];
      if (overwrite) {
        const blankish = (v: any) => v == null || v === '';
        for (const u of updates) {
          const ex = existingById.get(u.id) || {};
          const changes: Record<string, { from: any; to: any }> = {};
          for (const [field, to] of Object.entries(u.set)) {
            const from = ex[field];
            if (!blankish(from) && String(from) !== String(to)) changes[field] = { from: from ?? null, to: to as any };
          }
          if (Object.keys(changes).length) overwriteAudit.push({ id: u.id, busName: ex.busName ?? null, changes });
        }
      }

      // Resolve + validate the create-target site BEFORE opening the transaction so
      // we can return a clean 4xx (can't res.json from inside the tx callback).
      const wantCreate = req.body && (req.body.createNew === true || req.body.createNew === 'true');
      const wantDevices = req.body && (req.body.importDevices === true || req.body.importDevices === 'true');
      let createSiteId: string | null = null;
      if (wantCreate) {
        createSiteId = req.body.siteId ? String(req.body.siteId) : null;
        if (!createSiteId) return res.status(400).json({ success: false, error: 'createNew requires siteId (which site the new equipment belongs to).' });
        const site = await prisma.site.findFirst({ where: { id: createSiteId, accountId }, select: { id: true } });
        if (!site) return res.status(404).json({ success: false, error: 'Site not found.' });
      }

      const existingAssetByKey = new Map<string, string>();
      for (const r of existing) { const k = normBusKey(r.busName); if (r.assetId && !existingAssetByKey.has(k)) existingAssetByKey.set(k, r.assetId); }

      // ── All writes run in ONE interactive transaction: a mid-import failure
      // rolls back cleanly (no orphan study/assets/devices). Every update is
      // accountId-scoped via updateMany so tenant isolation is enforced at the query.
      const out = await prisma.$transaction(async (tx: any) => {
        let applied = 0, created = 0, feedsWired = 0, devicesCreated = 0;
        let createdStudyId: string | null = null;
        const newAssetByKey = new Map<string, string>();

        for (const u of updates) { await tx.systemStudyAsset.updateMany({ where: { id: u.id, accountId }, data: u.set }); }
        applied = updates.length;

        if (wantCreate) {
          const plan = planMultiTableImport(tables, existing.map((r: any) => r.busName));
          const busByKey = new Map<string, any>();
          for (const b of (tables.buses || [])) { const k = normBusKey(b.busId); if (!busByKey.has(k)) busByKey.set(k, b); }
          const cableByTo = new Map<string, any>();
          for (const c of (tables.cables || [])) { const k = normBusKey(c.toBusId); if (k && !cableByTo.has(k)) cableByTo.set(k, c); }

          if (plan.createBuses.length) {
            const performed = new Date();
            const study = await tx.systemStudy.create({
              data: { accountId, siteId: createSiteId, studyType: 'one_line_review', performedDate: performed, expiresAt: new Date(performed.getFullYear() + 5, performed.getMonth(), performed.getDate()), method: 'AFX import', trigger: 'system_change', notes: 'Created from AFX multi-table import.' },
              select: { id: true },
            });
            createdStudyId = study.id;
            for (const busId of plan.createBuses) {
              const k = normBusKey(busId); const b = busByKey.get(k) || {}; const cable = cableByTo.get(k) || {};
              const voltStr = b.nominalVoltageV != null && b.nominalVoltageV !== '' ? `${b.nominalVoltageV}V` : undefined;
              const asset = await tx.asset.create({
                data: { accountId, siteId: createSiteId, equipmentType: mapEquipmentType(b.equipmentType) as any, nameplateData: { busName: busId, nominalVoltage: voltStr || null, importedFrom: 'afx_import' }, notes: `Created from AFX multi-table import (bus ${busId}).` },
                select: { id: true },
              });
              await tx.systemStudyAsset.create({
                data: { accountId, studyId: study.id, assetId: asset.id, busName: busId, nominalVoltage: voltStr, cableLengthFt: numOrNull(cable.cableLengthFt) ?? undefined, cableSize: cable.cableSize || undefined, cableMaterial: cable.cableMaterial || undefined, conductorsPerPhase: intOrNull(cable.conductorsPerPhase) ?? undefined },
              });
              newAssetByKey.set(k, asset.id); created++;
            }
            // StudySourceModel: populate from a single unambiguous transformer when kVA data present.
            // Design choice: 1 transformer with non-null kVA = unambiguous main source.
            const xfmrsWithKva = (tables.transformers || []).filter((x: any) => numOrNull(x.transformerKva) != null);
            if (xfmrsWithKva.length === 1) {
              const tx1 = xfmrsWithKva[0];
              try {
                await tx.studySourceModel.create({
                  data: { accountId, siteId: createSiteId, studyId: study.id,
                    transformerKva: numOrNull(tx1.transformerKva),
                    transformerPrimaryV: intOrNull(tx1.transformerPrimaryV),
                    transformerSecondaryV: intOrNull(tx1.transformerSecondaryV),
                    transformerImpedancePct: numOrNull(tx1.transformerImpedancePct) },
                });
              } catch (_) { /* no-op on duplicate */ }
            }

            // Transformer assets: each Transformer row becomes a real Asset (TRANSFORMER_DRY
            // or TRANSFORMER_LIQUID) wired between its from-bus and to-bus. This inserts the
            // transformer into the topology chain instead of a direct bus-to-bus link.
            // Type heuristic: primary >= 15 kV (MV distribution) -> liquid-filled; else dry-type.
            const xfmrAssetByKey = new Map<string, string>();
            for (const xfmr of (tables.transformers || [])) {
              const kX = normBusKey(xfmr.xfmrId);
              const kTo = normBusKey(xfmr.toBusId);
              const kFrom = normBusKey(xfmr.fromBusId);
              // Only create a transformer asset when at least one connected bus is newly imported.
              if (!newAssetByKey.has(kTo) && !newAssetByKey.has(kFrom)) continue;
              const primaryV = numOrNull(xfmr.transformerPrimaryV);
              const xfmrEqType: any = (primaryV != null && primaryV >= 15000) ? 'TRANSFORMER_LIQUID' : 'TRANSFORMER_DRY';
              const xfmrAsset = await tx.asset.create({
                data: {
                  accountId, siteId: createSiteId, equipmentType: xfmrEqType,
                  nameplateData: { busName: xfmr.xfmrId, importedFrom: 'afx_import',
                    kva: xfmr.transformerKva || null, primaryV: xfmr.transformerPrimaryV || null,
                    secondaryV: xfmr.transformerSecondaryV || null, impedancePct: xfmr.transformerImpedancePct || null },
                  notes: `Transformer from AFX import (${xfmrEqType === 'TRANSFORMER_LIQUID' ? 'liquid-filled' : 'dry-type'}, ${xfmr.xfmrId}).`,
                },
                select: { id: true },
              });
              xfmrAssetByKey.set(kX, xfmrAsset.id); created++;
            }
            // Cable topology: from-bus feeds to-bus directly.
            for (const c of (tables.cables || [])) {
              const toId = newAssetByKey.get(normBusKey(c.toBusId));
              const fromId = newAssetByKey.get(normBusKey(c.fromBusId)) || existingAssetByKey.get(normBusKey(c.fromBusId));
              if (toId && fromId && toId !== fromId) { await tx.asset.updateMany({ where: { id: toId, accountId }, data: { fedFromAssetId: fromId } }); feedsWired++; }
            }
            // Transformer topology: from-bus -> xfmr-asset -> to-bus.
            // When no xfmr asset was created (both buses pre-existed), fall back to direct link.
            for (const xfmr of (tables.transformers || [])) {
              const xfmrId = xfmrAssetByKey.get(normBusKey(xfmr.xfmrId));
              const toId = newAssetByKey.get(normBusKey(xfmr.toBusId));
              const fromId = newAssetByKey.get(normBusKey(xfmr.fromBusId)) || existingAssetByKey.get(normBusKey(xfmr.fromBusId));
              if (xfmrId && fromId && xfmrId !== fromId) { await tx.asset.updateMany({ where: { id: xfmrId, accountId }, data: { fedFromAssetId: fromId } }); feedsWired++; }
              if (xfmrId && toId && toId !== xfmrId) { await tx.asset.updateMany({ where: { id: toId, accountId }, data: { fedFromAssetId: xfmrId } }); feedsWired++; }
              else if (!xfmrId && toId && fromId && toId !== fromId) { await tx.asset.updateMany({ where: { id: toId, accountId }, data: { fedFromAssetId: fromId } }); feedsWired++; }
            }
          }
        }

        if (wantDevices && (tables.devices || []).length) {
          const resolve = (busRef: any) => { const k = normBusKey(busRef); return newAssetByKey.get(k) || existingAssetByKey.get(k) || null; };
          const targetIds = new Set<string>();
          for (const d of tables.devices) { const id = resolve(d.protectsBusId); if (id) targetIds.add(id); }
          if (targetIds.size) {
            const assetsMeta = await tx.asset.findMany({ where: { id: { in: Array.from(targetIds) }, accountId }, select: { id: true, siteId: true } });
            const siteByAsset = new Map(assetsMeta.map((a: any) => [a.id, a.siteId]));
            const dupRows = await tx.protectiveDevice.findMany({ where: { accountId, status: 'active', assetId: { in: Array.from(targetIds) } }, select: { assetId: true, label: true } });
            const dup = new Set(dupRows.map((r: any) => `${r.assetId}|${String(r.label).trim().toUpperCase()}`));
            for (const d of tables.devices) {
              const assetId = resolve(d.protectsBusId);
              const siteId = assetId ? siteByAsset.get(assetId) : null;
              const label = d.deviceId == null ? '' : String(d.deviceId).trim();
              if (!assetId || !siteId || !label) continue;
              if (dup.has(`${assetId}|${label.toUpperCase()}`)) continue;
              await tx.protectiveDevice.create({
                data: { accountId, siteId, assetId, label, deviceType: d.deviceType || undefined, manufacturer: d.deviceManufacturer || undefined, model: d.deviceModel || undefined, sensorRatingA: numOrNull(d.deviceRatingA) ?? undefined, settings: safeDeviceSettings(d.deviceSettings) ?? undefined, source: 'import', collectedById: req.user.id },
              });
              dup.add(`${assetId}|${label.toUpperCase()}`); devicesCreated++;
            }
          }
        }
        return { applied, created, feedsWired, devicesCreated, createdStudyId };
      }, { timeout: 30000 });

      const { applied, created, feedsWired, devicesCreated, createdStudyId } = out;
      await logActivity(req.user.id, accountId, 'arc_flash_afx_import_applied', {
        busesUpdated: applied, fieldsSet: summary.fieldsSet, overwritten: summary.overwritten,
        busesCreated: created, feedsWired, devicesCreated, createdStudyId,
        skippedNew: summary.skippedNew, skippedNoChange: summary.skippedNoChange, mode: summary.mode,
        importedBy: req.user.id,
        // [LEGAL-8-8] Per-bus old->new for every overwritten (previously non-blank)
        // field, so a bulk import that replaces PE-stamped data is reconstructable.
        overwrites: overwriteAudit.slice(0, 500),
      });
      const parts = [`updated ${applied} existing bus(es)`];
      if (created) parts.push(`created ${created} new`);
      if (devicesCreated) parts.push(`added ${devicesCreated} device(s)`);
      const note = `Import applied: ${parts.join(', ')}. SC stores collected data and a licensed PE owns the arc-flash calculation. In fill-only mode existing values are preserved; in overwrite mode each replaced value is recorded to the audit log with its prior value.`;
      const responseBody = { success: true, data: { applied, created, feedsWired, devicesCreated, createdStudyId, summary, note } };
      idemStore(prisma, { accountId, key: ikey, method: req.method, path: req.path, statusCode: 200, body: responseBody });
      res.json(responseBody);
    } catch (e) {
      console.error('afx import-multi apply error:', e);
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to apply multi-table import' });
    }
  });
});

// ── POST /afx/validate ── conformance-check a CSV against AFX (manager+) ────────
// Upload a file (or { csv }) → recognized/unknown columns, missing required
// fields, and per-row type issues. Review-only; never persists.
router.post('/afx/validate', requireManager, (req: any, res: any) => {
  csvUpload.single('file')(req, res, async (uErr: any) => {
    try {
      if (uErr) return res.status(400).json({ success: false, error: uErr.message || 'Upload failed' });
      const csv = req.file ? req.file.buffer.toString('utf8') : (req.body && req.body.csv);
      if (!csv || typeof csv !== 'string') return res.status(400).json({ success: false, error: 'Upload a CSV (file field) or provide { csv }.' });
      // Alias-aware: recognize ARCAD / SKM / EasyPower column names too.
      return res.json({ success: true, data: validateAfxCsv(csv, { aliasIndex: buildAliasIndex() }) });
    } catch (e) {
      console.error('afx validate error:', e);
      return res.status(500).json({ success: false, error: 'AFX validation failed' });
    }
  });
});

// ── Arc-flash hazard LABEL PDFs (NFPA 70E 130.5(H) / ANSI Z535.4) ──────────────
// We generate the print-ready file (4x6, prints 1:1 on the customer's own label
// stock); SC is not a printing platform. Single label + bulk (one per page).
function streamLabelPdf(res: any, filename: string, render: (doc: any) => void) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const doc = new PDFDocument({ size: [LABEL_W, LABEL_H], margin: 0, autoFirstPage: false, info: { Title: 'Arc Flash Label', Author: 'ServiceCycle' } });
  let destroyed = false;
  const kill = () => { if (destroyed) return; destroyed = true; try { doc.unpipe(res); doc.destroy(); } catch (_) { /* noop */ } };
  res.on('close', kill); res.on('error', kill);
  doc.on('error', (err: any) => { try { console.error('[arc-flash label] stream error:', err?.message || err); if (!res.headersSent) res.status(500).end(); else if (res.writable) res.end(); } catch (_) { /* noop */ } destroyed = true; });
  doc.pipe(res);
  try { render(doc); } catch (e) { console.error('[arc-flash label] render error:', e); }
  if (!destroyed) doc.end();
}

// GET /asset/:assetId/label.pdf — single current-label PDF (any authed; their data)
router.get('/asset/:assetId/label.pdf', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const asset = await prisma.asset.findFirst({ where: { id: req.params.assetId, accountId }, select: { id: true, equipmentType: true } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const rows = await prisma.systemStudyAsset.findMany({
      where: { assetId: asset.id, accountId },
      include: { study: { select: { performedDate: true, supersededById: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const current = currentStudyAssetRow(rows);
    if (!current) return res.status(404).json({ success: false, error: 'No arc-flash label for this asset.' });
    current.asset = { equipmentType: asset.equipmentType };
    const [account, branding] = await Promise.all([
      prisma.account.findUnique({ where: { id: accountId }, select: { companyName: true } }),
      getAccountBranding(accountId).catch(() => null),
    ]);
    const m = buildLabelModel(current, { facilityName: account?.companyName || null, brandName: branding?.name || null });
    streamLabelPdf(res, `arc-flash-label-${(m.busName || 'equipment').replace(/[^a-z0-9]+/gi, '-')}.pdf`, (doc: any) => {
      doc.addPage(); drawArcFlashLabel(doc, 0, 0, LABEL_W, LABEL_H, m);
    });
  } catch (e) {
    console.error('arc-flash label pdf error:', e);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to generate label' });
  }
});

// GET /labels.pdf?siteId= — bulk: every current bound label, one per page.
router.get('/labels.pdf', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const where: any = { accountId, study: { supersededById: null } };
    if (req.query.siteId) where.asset = { siteId: String(req.query.siteId) };
    const rows = await prisma.systemStudyAsset.findMany({
      where,
      include: { study: { select: { performedDate: true, supersededById: true } }, asset: { select: { equipmentType: true } } },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'No arc-flash labels to print.' });
    const [account, branding] = await Promise.all([
      prisma.account.findUnique({ where: { id: accountId }, select: { companyName: true } }),
      getAccountBranding(accountId).catch(() => null),
    ]);
    const facilityName = account?.companyName || null;
    const brandName = branding?.name || null;
    streamLabelPdf(res, `arc-flash-labels-${new Date().toISOString().slice(0, 10)}.pdf`, (doc: any) => {
      for (const r of rows) {
        const m = buildLabelModel(r, { facilityName, brandName });
        doc.addPage();
        try { drawArcFlashLabel(doc, 0, 0, LABEL_W, LABEL_H, m); } catch (e) { console.error('[arc-flash label] one label failed:', e); }
      }
    });
  } catch (e) {
    console.error('arc-flash labels pdf error:', e);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to generate labels' });
  }
});

// ── GET /load-growth ── telemetry-derived load-growth flag (manager+) ──────────
// Light arc-flash tie-in: if continuous condition-monitoring telemetry shows a
// load channel growing past the same >10% threshold the integrity cron uses,
// raise a flag that the study may need re-evaluating (NFPA 70E §130.5(G)). SC
// surfaces the signal only — it never recomputes incident energy, and it does
// NOT auto-create a re-study quote (that stays a deliberate, Dustin-gated step).
router.get('/load-growth', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const threshold = 10;
    const channels = await prisma.telemetryChannel.findMany({
      where: { accountId, enabled: true },
      select: { id: true, key: true, label: true, unit: true, assetId: true },
      take: 500,
    });
    const loadChannels = channels.filter(isLoadChannel).slice(0, 60);
    const flagged: any[] = [];
    let maxGrowthPct = 0;
    for (const ch of loadChannels) {
      const readings = await prisma.telemetryReading.findMany({
        where: { channelId: ch.id }, select: { value: true, recordedAt: true },
        orderBy: { recordedAt: 'desc' }, take: 200,
      });
      const a = assessLoadGrowth(readings.map((r: any) => ({ value: Number(r.value), recordedAt: r.recordedAt })));
      if (!a.ok) continue;
      if (a.growthPct > maxGrowthPct) maxGrowthPct = a.growthPct;
      if (a.growthPct >= threshold) {
        flagged.push({ channelId: ch.id, assetId: ch.assetId, label: ch.label || ch.key, unit: ch.unit || null, baseline: a.baseline, current: a.current, growthPct: a.growthPct });
      }
    }
    flagged.sort((x, y) => y.growthPct - x.growthPct);
    return res.json({ success: true, data: {
      threshold,
      exceedsThreshold: flagged.length > 0,
      maxGrowthPct: Math.round(maxGrowthPct * 10) / 10,
      channels: flagged,
      note: flagged.length ? 'NFPA 70E §130.5(G) recommends reviewing the arc-flash study when load changes may alter incident energy. This is a telemetry-derived flag, not a recalculation — confirm with a re-study.' : null,
    } });
  } catch (e) {
    console.error('arc-flash load-growth error:', e);
    return res.status(500).json({ success: false, error: 'Failed to compute load growth' });
  }
});

// ── POST /import-results ── Slice 3.5b: round-trip stamped study results back in ─
// Accepts the PE's results CSV (per-bus incident energy / boundary / PPE / arc
// rating / working distance), matches to bound buses by (site, bus), and updates
// the label OUTPUTS. preview:true returns the diff without persisting (review
// first); without it, applies + re-derives DANGER/WARNING. Manager/admin.
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
router.post('/import-results', requireManager, (req: any, res: any) => {
  csvUpload.single('file')(req, res, async (uErr: any) => {
  try {
    if (uErr) return res.status(400).json({ success: false, error: uErr.message || 'Upload failed' });
    const accountId = req.user.accountId;
    const csv = req.file ? req.file.buffer.toString('utf8') : (req.body && req.body.csv);
    if (!csv || typeof csv !== 'string') return res.status(400).json({ success: false, error: 'Upload the results CSV (file field) or provide { csv }.' });
    const preview = String((req.body && req.body.preview) ?? '') === 'true' || (req.body && req.body.preview === true);

    const { rows, recognized, errors } = parseResultsCsv(csv);
    if (errors.length && !rows.length) return res.status(400).json({ success: false, error: errors.join(' ') });

    const bound = await prisma.systemStudyAsset.findMany({
      where: { accountId, study: { supersededById: null } },
      select: {
        id: true, busName: true, nominalVoltage: true,
        incidentEnergyCalCm2: true, arcFlashBoundaryIn: true, ppeCategory: true, requiredArcRatingCalCm2: true, workingDistanceIn: true,
        asset: { select: { site: { select: { name: true } } } },
      },
      take: 5000,
    });
    const buses = bound.map((b: any) => ({
      id: b.id, busName: b.busName, site: b.asset?.site?.name || null, nominalVoltage: b.nominalVoltage,
      incidentEnergyCalCm2: numOrNull(b.incidentEnergyCalCm2), arcFlashBoundaryIn: numOrNull(b.arcFlashBoundaryIn),
      ppeCategory: b.ppeCategory, requiredArcRatingCalCm2: numOrNull(b.requiredArcRatingCalCm2), workingDistanceIn: numOrNull(b.workingDistanceIn),
    }));
    const voltByBus = new Map(buses.map((b: any) => [b.id, b.nominalVoltage]));
    const { updates, unmatched } = matchResults(rows, buses);

    if (preview) {
      return res.json({ success: true, data: { preview: true, recognized, errors, updates, unmatched, matched: updates.length, unmatchedCount: unmatched.length } });
    }

    let applied = 0;
    // [LEGAL-8-2] Build a per-bus, per-field before/after record so a re-import of a
    // PE results CSV is reconstructable (which bus, which field, prior value, new
    // value) — not just an aggregate count. Each entry is routed through the
    // activity log so the tamper-evident hash chain (LEGAL-8-6) commits to the
    // incident-energy / PPE / boundary values that actually change the label.
    const perBusChanges: Array<{ busId: string; busName: any; changes: any }> = [];
    for (const u of updates) {
      const data: any = {};
      for (const [field, ch] of Object.entries(u.changes)) data[field] = (ch as any).to;
      // Re-derive the NFPA 70E severity from the new incident energy + voltage.
      data.labelSeverity = deriveLabelSeverity({ incidentEnergyCalCm2: data.incidentEnergyCalCm2 ?? null, nominalVoltage: voltByBus.get(u.busId) }) ?? undefined;
      await prisma.systemStudyAsset.update({ where: { id: u.busId }, data });
      perBusChanges.push({ busId: u.busId, busName: (u as any).busName ?? null, changes: u.changes });
      applied++;
    }
    await logActivity(req.user.id, accountId, 'arc_flash_results_imported', {
      applied, unmatched: unmatched.length, recognized, importedBy: req.user.id,
      // Per-bus old->new for every applied change (cap to bound the payload).
      busChanges: perBusChanges.slice(0, 500),
    });
    res.json({ success: true, data: { preview: false, recognized, errors, applied, unmatched, unmatchedCount: unmatched.length } });
  } catch (e) {
    console.error('arc-flash import-results error:', e);
    res.status(500).json({ success: false, error: 'Failed to import results' });
  }
  });
});

// ── GET /search?q= ── Slice 3e: deterministic natural-language facility search ─
// Parse a plain-English query into structured filters and match the current label
// rows. Returns the interpretation (so it's explainable) + the matches. Read-only.
router.get('/search', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const q = String(req.query.q || '');
    const parsed = parseQuery(q);
    const now = Date.now();
    const soon = new Date(now + 90 * 24 * 60 * 60 * 1000);

    const [rows, devices, driftTests] = await Promise.all([
      prisma.systemStudyAsset.findMany({
        where: { accountId, study: { supersededById: null } },
        include: {
          study: { select: { performedDate: true, expiresAt: true, sourceModel: { select: { utilityMaxFaultKA: true } } } },
          asset: { select: { id: true, equipmentType: true, site: { select: { name: true } } } },
        },
        take: 3000,
      }),
      prisma.protectiveDevice.findMany({ where: { accountId, status: 'active', assetId: { not: null } }, select: { assetId: true, source: true }, take: 5000 }),
      prisma.deviceTestRecord.findMany({ where: { accountId, driftFlagged: true, assetId: { not: null } }, select: { assetId: true }, take: 5000 }),
    ]);
    const devByAsset = new Map<string, any[]>();
    for (const d of devices) { if (!d.assetId) continue; const arr = devByAsset.get(d.assetId) || []; arr.push(d); devByAsset.set(d.assetId, arr); }
    const driftAssets = new Set(driftTests.map((t: any) => t.assetId));

    const enriched = rows.map((r: any) => {
      const bus = busForFleet(r, r.asset?.equipmentType);
      const ie = numOrNull(r.incidentEnergyCalCm2);
      const v = voltsOf(r.nominalVoltage);
      const sev = r.labelSeverity || (((ie != null && ie > 40) || (v != null && v > 600)) ? 'danger' : (ie != null || v != null ? 'warning' : null));
      const g = analyzeBusGaps(busForGap(bus));
      const conf = scoreBusConfidence({ bus, study: { performedDate: r.study?.performedDate, expiresAt: r.study?.expiresAt, superseded: false }, deviceSource: pickDeviceSource(devByAsset.get(r.assetId) || []), driftFlagged: driftAssets.has(r.assetId) });
      const expired = r.study?.expiresAt ? new Date(r.study.expiresAt).getTime() < now : false;
      return {
        assetId: r.assetId, busName: r.busName, site: r.asset?.site?.name || null, equipmentType: r.asset?.equipmentType || null,
        nominalVoltage: r.nominalVoltage, incidentEnergyCalCm2: ie, labelSeverity: sev, readiness: g.readiness,
        confidence: { score: conf.score, band: conf.band },
        expired, expiringSoon: r.study?.expiresAt ? (!expired && new Date(r.study.expiresAt) <= soon) : false,
      };
    });

    const matched = enriched.filter((row: any) => matchRow(row, parsed.filters));
    res.json({ success: true, data: { query: q, interpreted: parsed.recognized, unrecognized: parsed.unrecognized, total: matched.length, matched: matched.slice(0, 500) } });
  } catch (e) {
    console.error('arc-flash search error:', e);
    res.status(500).json({ success: false, error: 'Failed to run arc-flash search' });
  }
});

module.exports = router;
