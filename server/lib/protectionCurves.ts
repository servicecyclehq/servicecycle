'use strict';

/**
 * lib/protectionCurves.ts
 * -------------------------
 * Backend query logic for the ProtectionCurve model (2026-07-05, §10 A3 TCC
 * backend prep). Pure + testable: takes a prisma client + accountId (+ opts),
 * returns plain JS objects, tenant-scoped throughout.
 *
 * IMPORTANT: read docs/scoping/audits/tcc-curve-source-availability.md before
 * assuming curvePoints is populated from AFX import — it is not. No existing
 * ServiceCycle ingestion path (AFX v1/v1.2, results-CSV round-trip, AI-vision
 * one-line extractor, SKM/EasyPower/ETAP templates) carries real curve POINT
 * data; they carry device nameplate/trip-settings and computed incident-
 * energy results. This module and its route are schema + API scaffolding for
 * Phase 2 UI work (the interactive TCC canvas), not a claim that curve data
 * is already flowing in.
 */

// ── List curves, optionally filtered by asset ────────────────────────────────
async function listProtectionCurves(prisma: any, accountId: string, opts: any = {}): Promise<any[]> {
  const where: any = { accountId };
  if (opts.assetId) where.assetId = String(opts.assetId);
  if (opts.protectiveDeviceId) where.protectiveDeviceId = String(opts.protectiveDeviceId);

  const rows = await prisma.protectionCurve.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });
  return rows;
}

// ── Single curve by id, tenant-scoped ────────────────────────────────────────
class ProtectionCurveNotFoundError extends Error {
  code = 'PROTECTION_CURVE_NOT_FOUND';
}

async function getProtectionCurve(prisma: any, accountId: string, id: string): Promise<any> {
  const row = await prisma.protectionCurve.findFirst({ where: { id, accountId } });
  if (!row) throw new ProtectionCurveNotFoundError(`ProtectionCurve ${id} not found`);
  return row;
}

// ── Seed a placeholder curve from the existing arcFlashTccLibrary.ts class-
// typical match, per the recommendation in the source-availability audit.
// Tagged dataSource: 'tcc_library_estimate' so it is never confused with a
// real manufacturer curve. Returns null (no-op) if no library match exists —
// never fabricates a device identity that wasn't matched.
async function seedFromTccLibrary(prisma: any, accountId: string, device: {
  assetId?: string; protectiveDeviceId?: string; deviceLabel: string;
  manufacturer?: string; model?: string; deviceType?: string; ratingA?: number;
}): Promise<any> {
  const { suggestFromDevice } = require('./arcFlashTccLibrary');
  const suggestion = suggestFromDevice({
    manufacturer: device.manufacturer, model: device.model,
    deviceType: device.deviceType, ratingA: device.ratingA,
  });
  if (!suggestion) return null;

  return prisma.protectionCurve.create({
    data: {
      accountId,
      assetId: device.assetId || null,
      protectiveDeviceId: device.protectiveDeviceId || null,
      source: 'manual',
      deviceLabel: device.deviceLabel,
      deviceModel: device.model || null,
      curveType: suggestion.deviceType === 'fuse' ? 'fuse' : 'breaker',
      dataSource: 'tcc_library_estimate',
      // A single representative point (class-typical clearing time at an
      // unspecified fault current) -- explicitly NOT a digitized curve. The
      // UI must render this differently from a real multi-point TCC.
      curvePoints: [{ current: null, time: suggestion.suggestedClearingTimeMs / 1000 }],
      settings: { curveRef: suggestion.curveRef, note: suggestion.note, confidence: suggestion.confidence },
    },
  });
}

module.exports = {
  listProtectionCurves,
  getProtectionCurve,
  seedFromTccLibrary,
  ProtectionCurveNotFoundError,
};

export {};
