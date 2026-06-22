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

function numOrNull(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Shape a bus row/record for the gap engine (incl. 2.6 device + cable inputs).
function busForGap(b: any) {
  return {
    busName: b.busName, equipmentTypeGuess: b.equipmentTypeGuess, nominalVoltage: b.nominalVoltage,
    boltedFaultCurrentKA: numOrNull(b.boltedFaultCurrentKA), clearingTimeMs: numOrNull(b.clearingTimeMs),
    electrodeConfig: b.electrodeConfig, conductorGapMm: numOrNull(b.conductorGapMm), workingDistanceIn: numOrNull(b.workingDistanceIn),
    deviceType: b.deviceType, deviceRatingA: numOrNull(b.deviceRatingA), deviceSettings: b.deviceSettings,
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
    deviceType: b.deviceType, deviceManufacturer: b.deviceManufacturer, deviceModel: b.deviceModel,
    deviceRatingA: numOrNull(b.deviceRatingA), deviceSettings: b.deviceSettings,
    cableLengthFt: numOrNull(b.cableLengthFt), cableSize: b.cableSize, cableMaterial: b.cableMaterial,
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
      },
    });
  } catch (e) {
    console.error('arc-flash ingest get error:', e);
    res.status(500).json({ success: false, error: 'Failed to load ingest' });
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
    for (const f of ['deviceType', 'deviceManufacturer', 'deviceModel', 'cableSize', 'cableMaterial']) {
      if (b[f] !== undefined) patch[f] = b[f] || null;
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

module.exports = router;
