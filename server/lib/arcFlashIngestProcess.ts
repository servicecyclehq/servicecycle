/**
 * lib/arcFlashIngestProcess.ts — the shared "run one arc-flash extraction and
 * persist its draft" step (W1 part 2).
 *
 * Extracted so the async worker (arcFlashIngestWorker) runs the SAME
 * extract -> IEEE-1584 gap-analysis -> persist-draft logic the sync route used
 * to run inline. Native-PDF extraction is 50-150s, too long to hold an HTTP
 * request open, so it moved off the request into the worker; this module is the
 * unit of work the worker executes.
 *
 * Idempotent by design: a retried job (worker crash -> stale-recovery requeue)
 * DELETEs any buses it previously wrote for this ingest before re-inserting, so
 * a retry never doubles the draft. `extractor` is injectable for tests so the
 * queue/persist mechanics can be exercised without a real Gemini call.
 */

'use strict';

const prisma = require('./prisma').default;
const { extractArcFlashDocument } = require('./arcFlashExtract');
const { analyzeBusGaps, summarizeIngestBands } = require('./arcFlashGap');

// [KEEP IN SYNC with routes/arcFlashIngest.ts numOrNull/busForGap — pure
// gap-input shaping, duplicated here so this worker path doesn't have to import
// the ~2800-line route module. If the gap-input shape changes there, mirror it.]
function numOrNull(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function busForGap(b: any) {
  return {
    busName: b.busName, equipmentTypeGuess: b.equipmentTypeGuess, nominalVoltage: b.nominalVoltage,
    boltedFaultCurrentKA: numOrNull(b.boltedFaultCurrentKA), clearingTimeMs: numOrNull(b.clearingTimeMs),
    electrodeConfig: b.electrodeConfig, conductorGapMm: numOrNull(b.conductorGapMm), workingDistanceIn: numOrNull(b.workingDistanceIn),
    deviceType: b.deviceType, tripUnitType: b.tripUnitType, deviceRatingA: numOrNull(b.deviceRatingA), deviceSettings: b.deviceSettings,
    cableLengthFt: numOrNull(b.cableLengthFt), cableSize: b.cableSize,
  };
}

async function _logActivity(userId: string | null, accountId: string, action: string, details: any = null) {
  try {
    await prisma.activityLog.create({ data: { assetId: null, userId: userId ?? null, accountId: accountId ?? null, action, details: details ?? undefined } });
  } catch (err: any) {
    console.error('arcFlashIngestProcess logActivity error:', err && err.message ? err.message : err);
  }
}

/**
 * Extract + gap-analyze + persist the draft for one ArcFlashIngest row.
 *
 * THROWS on a hard failure (extractor threw, file unreadable) so the worker can
 * retry. A soft "no buses" result is NOT thrown — it is persisted as status
 * 'failed', the same terminal outcome the sync route produced, because retrying
 * a genuinely empty extraction won't help.
 *
 * @param ingest  the ArcFlashIngest row (needs id, accountId, mimeType, fileName, uploadedById)
 * @param buffer  the source document bytes (worker downloads these from storage)
 * @param opts.extractor  injectable extractor (defaults to the real native/AI path)
 */
async function processArcFlashIngestExtraction(ingest: any, buffer: Buffer, opts: any = {}) {
  const extractor = opts.extractor || extractArcFlashDocument;
  const ext = await extractor({ buffer, mimeType: ingest.mimeType, fileName: ingest.fileName });

  const buses = Array.isArray(ext.buses) ? ext.buses : [];
  const gapResults = buses.map((b: any) => analyzeBusGaps(busForGap(b)));
  const summary = summarizeIngestBands(gapResults);
  const finalStatus = buses.length ? 'needs_review' : 'failed';

  await prisma.$transaction(async (tx: any) => {
    // Idempotent: a retry (stale-recovery requeue) must not double-write the draft.
    await tx.arcFlashIngestBus.deleteMany({ where: { ingestId: ingest.id } });
    for (let i = 0; i < buses.length; i++) {
      const b = buses[i];
      const g = gapResults[i];
      await tx.arcFlashIngestBus.create({
        data: {
          accountId: ingest.accountId, ingestId: ingest.id, seq: i,
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
        error: buses.length ? null : ((ext.warnings && ext.warnings[0]) || 'No buses extracted'),
      },
    });
  }, { timeout: 30000 }); // ingest can be slow with many buses

  await _logActivity(ingest.uploadedById || null, ingest.accountId, 'arc_flash_ingest_extracted', {
    ingestId: ingest.id, method: ext.method, buses: buses.length, overallBand: summary.overallBand,
  });

  return { status: finalStatus, method: ext.method, overallBand: summary.overallBand, readyBusCount: summary.readyBusCount, totalBusCount: summary.totalBusCount, busCount: buses.length, warnings: ext.warnings || [] };
}

module.exports = { processArcFlashIngestExtraction, busForGap, numOrNull };
export {};
