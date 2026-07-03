'use strict';

/**
 * routes/dobleImport.ts -- Doble (TestGuide / TDMS / ProTest) test-data import.
 *
 * The neutral-reader on-ramp for the OTHER major ecosystem. PowerDB (Megger)
 * data already lands via routes/testReportImport.ts + scripts/seed-powerdb-demo;
 * this route parses a Doble export, matches assets with the SAME fuzzy identity
 * resolver, and -- on commit -- writes into the SAME storage pool
 * (WorkOrder COMPLETE + TestMeasurement rows via lib/commitTestReport) so drift
 * analysis, measurement views and Installed-Base queries see one unified body
 * of readings regardless of vendor of origin. (Doble + Megger merged under ESCO
 * in April 2026; reading both neutrally is now core positioning.)
 *
 * Endpoints (both requireManager -- ingestion writes program-of-record data):
 *
 *   POST /preview  -- multipart file= (xml|csv) [+ optional siteId hint]
 *                     -> detected format, per-asset fuzzy match (confidence),
 *                     test/measurement counts, per-record issues. NO writes.
 *
 *   POST /commit   -- multipart file= + matches JSON:
 *                     [{ assetKey, assetId | createAsset:{siteId,equipmentType,...} }]
 *                     -> writes each APPROVED asset's readings into the unified
 *                     pool inside one $transaction. Cross-tenant assetId is
 *                     rejected (404). Re-importing the same (asset,date,
 *                     fingerprint) is SKIPPED (duplicate protection on a natural
 *                     key). Per-asset outcomes returned.
 *
 * Mounted at /api/doble/import (authenticateToken + ingestLimiter in index.ts).
 * Every query scoped to req.user.accountId.
 */

const router = require('express').Router();
const multer = require('multer');
const crypto = require('crypto');
const { requireManager } = require('../middleware/roles');
const prisma = require('../lib/prisma').default;
const { resolveAsset } = require('../lib/assetIdentity');
const { commitAssetReadings, inferEquipmentType } = require('../lib/commitTestReport');
const { writeLog } = require('../lib/activityLog');
const {
  parseDobleExport, toCommitMeasurements, assetTestDate, DOBLE_SCHEMA_VERSION,
} = require('../lib/dobleImport');

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ASSETS = 500; // one export = one facility's transformer fleet, bounded

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req: any, file: any, cb: any) => {
    const ok = /\.(xml|csv|txt)$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Upload a Doble export as .xml or .csv'), ok);
  },
});

function handleUpload(req: any, res: any, next: any) {
  upload.single('file')(req, res, (err: any) => {
    if (!err) return next();
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ success: false, error: err.message || 'Upload failed' });
  });
}

// CWE-1236: strip leading spreadsheet-formula triggers on any free-text echoed
// back to the client so a preview cell can't become an active formula if
// pasted into Excel/LibreOffice. Mirrors the sibling import routes.
function sanitizeFormulaPrefix(s: any): any {
  if (typeof s !== 'string' || !s) return s;
  return s.replace(/^[=+\-@\t\r\n]+/, '');
}

// Stable natural-key fingerprint for duplicate protection: a hash over the
// asset identity + every reading's (type/phase/value/unit). Re-importing the
// same Doble content for the same asset+date is a no-op rather than a second
// year of phantom history. Stored in the WorkOrder.notes marker so the guard
// needs no schema change.
function fingerprintAsset(asset: any): string {
  const parts: string[] = [
    String(asset?.identity?.serialNumber || ''),
    String(asset?.identity?.model || ''),
  ];
  for (const t of asset.tests || []) {
    for (const r of t.readings || []) {
      parts.push(`${r.measurementType}|${r.phase || ''}|${r.rawValue ?? ''}|${r.unit || ''}`);
    }
  }
  return crypto.createHash('sha256').update(parts.join('~')).digest('hex').slice(0, 16);
}

function markerFor(fp: string): string {
  return `[ingest:doble][fp:${fp}]`;
}

// Build the shared parse context from the uploaded file. Never throws for a
// recoverable parse problem -- those surface as issues in the result.
function parseCtx(req: any): { result?: any; error?: { status: number; body: any } } {
  if (!req.file?.buffer) return { error: { status: 400, body: { success: false, error: 'No file uploaded' } } };
  let result;
  try {
    result = parseDobleExport(req.file.buffer, req.file.originalname);
  } catch (e: any) {
    return { error: { status: 400, body: { success: false, error: `Could not parse the Doble file: ${e.message}` } } };
  }
  if (!result.assetCount) {
    return { error: { status: 400, body: { success: false, error: 'No assets found in the file. Expected a Doble TestGuide/TDMS export (XML or CSV table).', data: { format: result.format, issues: result.issues } } } };
  }
  if (result.assetCount > MAX_ASSETS) {
    return { error: { status: 400, body: { success: false, error: `Export has ${result.assetCount} assets; the ${MAX_ASSETS}-asset cap keeps one upload to a single facility.` } } };
  }
  return { result };
}

// A per-asset stable key the client echoes back on commit to say "yes, import
// this asset into <assetId | createAsset>". Serial when present; else location;
// else positional. Kept in sync with the CSV grouping key intent.
function assetKeyOf(asset: any, index: number): string {
  return String(asset?.identity?.serialNumber || asset?.identity?.location || `asset_${index}`);
}

// ── POST /preview ────────────────────────────────────────────────────────────
router.post('/preview', requireManager, handleUpload, async (req: any, res: any) => {
  try {
    const ctx = parseCtx(req);
    if (ctx.error) return res.status(ctx.error.status).json(ctx.error.body);
    const result = ctx.result;
    const accountId = req.user.accountId;
    const siteHint = req.body?.siteId ? String(req.body.siteId) : null;

    const assets = [];
    for (let i = 0; i < result.assets.length; i++) {
      const a = result.assets[i];
      // Fuzzy identity: same resolver the PowerDB/PDF path uses. Read-only.
      // Map Doble's own free-text equipment label onto the SC EquipmentType enum
      // (best-effort, same keyword inferer the PDF ingest uses) so that when a
      // site hint is supplied the resolver's site+type fallback tier can fire for
      // a serial-less or serial-unmatched asset -- otherwise only serial matching
      // ever runs here. Passing the raw Doble label ("Power Transformer") would
      // never equal the enum-typed column, so we infer instead.
      const inferredType = siteHint
        ? inferEquipmentType(a.identity.equipmentType, a.identity.model, a.identity.manufacturer)
        : null;
      let match: any = { best: null, candidates: [] };
      try {
        match = await resolveAsset({
          accountId,
          serialNumber: a.identity.serialNumber,
          siteId: siteHint,
          equipmentType: inferredType,
          manufacturer: a.identity.manufacturer,
          model: a.identity.model,
          limit: 3,
        });
      } catch { /* resolver already soft-fails; keep going */ }

      const fp = fingerprintAsset(a);
      // Duplicate check against the unified pool: has a WorkOrder for the best
      // match asset already imported THIS fingerprint?
      let alreadyImported = false;
      if (match.best?.id) {
        try {
          const dup = await prisma.workOrder.findFirst({
            where: { accountId, assetId: match.best.id, notes: { contains: `[fp:${fp}]` } },
            select: { id: true },
          });
          alreadyImported = !!dup;
        } catch { /* non-fatal */ }
      }

      assets.push({
        assetKey: assetKeyOf(a, i),
        identity: {
          serialNumber: sanitizeFormulaPrefix(a.identity.serialNumber),
          manufacturer: sanitizeFormulaPrefix(a.identity.manufacturer),
          model: sanitizeFormulaPrefix(a.identity.model),
          equipmentType: sanitizeFormulaPrefix(a.identity.equipmentType),
          location: sanitizeFormulaPrefix(a.identity.location),
        },
        testCount: a.tests.length,
        measurementCount: a.measurementCount,
        tests: a.tests.map((t: any) => ({
          testType: t.testType, testDate: t.testDate,
          readingCount: t.readings.length,
        })),
        match: {
          best: match.best ? {
            id: match.best.id, label: match.best.label, serialNumber: match.best.serialNumber,
            reason: match.best.reason, confidence: match.best.confidence,
            lastTestedAt: match.best.lastTestedAt, siteName: match.best.siteName,
          } : null,
          candidates: (match.candidates || []).map((c: any) => ({
            id: c.id, label: c.label, reason: c.reason, confidence: c.confidence,
          })),
        },
        fingerprint: fp,
        alreadyImported,
        issues: a.issues,
      });
    }

    return res.json({
      success: true,
      data: {
        step: 'preview',
        format: result.format,
        schemaVersion: result.schemaVersion,
        assetCount: result.assetCount,
        testCount: result.testCount,
        measurementCount: result.measurementCount,
        fileIssues: result.issues,
        assets,
      },
    });
  } catch (err) {
    console.error('[doble/preview]', err);
    return res.status(500).json({ success: false, error: 'Failed to read the Doble file.' });
  }
});

// ── POST /commit ─────────────────────────────────────────────────────────────
router.post('/commit', requireManager, handleUpload, async (req: any, res: any) => {
  try {
    const ctx = parseCtx(req);
    if (ctx.error) return res.status(ctx.error.status).json(ctx.error.body);
    const result = ctx.result;
    const accountId = req.user.accountId;

    // matches: [{ assetKey, assetId? , createAsset?:{siteId,equipmentType,manufacturer?,model?,serialNumber?} }]
    let matches: any[];
    try {
      matches = JSON.parse(req.body?.matches || '[]');
    } catch {
      return res.status(400).json({ success: false, error: 'matches must be valid JSON' });
    }
    if (!Array.isArray(matches) || matches.length === 0) {
      return res.status(400).json({ success: false, error: 'Select at least one asset match to import.' });
    }
    const matchByKey = new Map<string, any>();
    for (const m of matches) if (m && m.assetKey) matchByKey.set(String(m.assetKey), m);

    // Pre-validate targets OUTSIDE the transaction (cross-tenant / missing site).
    const parsedByKey = new Map<string, any>();
    result.assets.forEach((a: any, i: number) => parsedByKey.set(assetKeyOf(a, i), a));

    const outcomes: any[] = [];
    let committed = 0, skippedDup = 0, createdAssets = 0, measurementsCreated = 0, deficienciesCreated = 0;

    await prisma.$transaction(async (tx: any) => {
      for (const [assetKey, asset] of parsedByKey.entries()) {
        const m = matchByKey.get(assetKey);
        if (!m) continue; // not selected for import

        // Resolve / create the target asset (tenancy enforced on BOTH paths).
        let targetId: string | null = null;
        let created = false;
        if (m.assetId) {
          const a = await tx.asset.findFirst({ where: { id: String(m.assetId), accountId, archivedAt: null }, select: { id: true } });
          if (!a) {
            // Cross-tenant or unknown assetId -> record and skip this asset.
            outcomes.push({ assetKey, status: 'error', error: 'Asset not found in this account' });
            continue;
          }
          targetId = a.id;
        } else if (m.createAsset && m.createAsset.siteId && m.createAsset.equipmentType) {
          const site = await tx.site.findFirst({ where: { id: String(m.createAsset.siteId), accountId, archivedAt: null }, select: { id: true } });
          if (!site) {
            outcomes.push({ assetKey, status: 'error', error: 'Target site not found in this account' });
            continue;
          }
          const na = await tx.asset.create({
            data: {
              accountId, siteId: String(m.createAsset.siteId), equipmentType: m.createAsset.equipmentType,
              manufacturer: m.createAsset.manufacturer ?? asset.identity.manufacturer ?? null,
              model: m.createAsset.model ?? asset.identity.model ?? null,
              serialNumber: m.createAsset.serialNumber ?? asset.identity.serialNumber ?? null,
            },
            select: { id: true },
          });
          targetId = na.id; created = true;
        } else {
          outcomes.push({ assetKey, status: 'error', error: 'Provide assetId or createAsset{siteId,equipmentType}' });
          continue;
        }

        // Duplicate protection on the natural key (asset + reading fingerprint).
        const fp = fingerprintAsset(asset);
        const dup = await tx.workOrder.findFirst({
          where: { accountId, assetId: targetId, notes: { contains: `[fp:${fp}]` } },
          select: { id: true },
        });
        if (dup) {
          skippedDup++;
          outcomes.push({ assetKey, assetId: targetId, status: 'skipped', reason: 'Already imported (duplicate fingerprint)' });
          continue;
        }

        const measurements = toCommitMeasurements(asset);
        if (!measurements.length) {
          outcomes.push({ assetKey, assetId: targetId, status: 'skipped', reason: 'No readings to import' });
          continue;
        }

        const isoDate = assetTestDate(asset);
        const when = isoDate ? new Date(isoDate + 'T00:00:00Z') : new Date();

        // Same writer the PowerDB/PDF path uses -> unified pool. We tag the WO
        // notes with the Doble marker + fingerprint for provenance + de-dupe.
        const r = await commitAssetReadings(tx, {
          accountId, assetId: targetId, when,
          vendor: 'Doble import', techName: asset.tests[0]?.technician || undefined,
          measurements,
        });
        // Stamp the provenance/fingerprint marker onto the just-created WO.
        await tx.workOrder.update({
          where: { id: r.workOrderId },
          data: { notes: `${markerFor(fp)} Doble ${result.format.toUpperCase()} import (${DOBLE_SCHEMA_VERSION}) -- ${asset.identity.serialNumber || assetKey}` },
        });

        committed++;
        if (created) createdAssets++;
        measurementsCreated += r.measurementsCreated;
        deficienciesCreated += r.deficienciesCreated;
        outcomes.push({
          assetKey, assetId: targetId, status: 'committed', created,
          workOrderId: r.workOrderId,
          measurementsCreated: r.measurementsCreated,
          deficienciesCreated: r.deficienciesCreated,
        });
      }
    }, { timeout: 60000 });

    // Activity log (fire-and-forget). ACTION: 'doble_import_committed'.
    writeLog({
      accountId, userId: req.user.id, action: 'doble_import_committed',
      ipAddress: req.ip,
      details: {
        format: result.format, schemaVersion: result.schemaVersion,
        assetsCommitted: committed, assetsCreated: createdAssets,
        measurementsCreated, deficienciesCreated, skippedDuplicates: skippedDup,
      },
    });

    return res.status(201).json({
      success: true,
      data: {
        step: 'commit',
        format: result.format,
        committed, createdAssets, skippedDuplicates: skippedDup,
        measurementsCreated, deficienciesCreated,
        outcomes,
      },
    });
  } catch (err) {
    console.error('[doble/commit]', err);
    return res.status(500).json({ success: false, error: 'Failed to import the Doble file.' });
  }
});

module.exports = router;
export {};
