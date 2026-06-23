/**
 * Slice 9 — canonical arc-flash surface on the public v1 API ("Arc Flash OS"):
 *   GET /api/v1/arc-flash/labels          — paginated current NFPA 70E labels
 *   GET /api/v1/arc-flash/one-line?siteId= — the power-path graph for a site
 *
 * Auth: API key (req.apiKeyAccountId set by apiKeyAuth middleware). Read-only —
 * any valid key may read. This is the integration layer a CMMS / EAM / analytics
 * tool syncs the arc-flash data layer from.
 */

const router = require('express').Router();
const { z } = require('zod');
import prisma from '../../lib/prisma';
const { buildOneLine } = require('../../lib/arcFlashOneLine');
const { buildEnergizedWorkPermit } = require('../../lib/arcFlashPermit');
const { SC_DATA_LAYER_DISCLAIMER } = require('../../lib/arcFlashCopy');
const { requireScope } = require('../../middleware/apiKeyAuth');

function currentRowOf(rows: any[]): any {
  return rows.slice().sort((a: any, b: any) => {
    const sa = a.study?.supersededById ? 0 : 1, sb = b.study?.supersededById ? 0 : 1;
    if (sa !== sb) return sb - sa;
    return new Date(b.study?.performedDate || 0).getTime() - new Date(a.study?.performedDate || 0).getTime();
  })[0] || null;
}

function n(v: any): number | null {
  if (v == null || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
function voltsOf(raw: any): number | null {
  if (raw == null) return null;
  const m = String(raw).match(/([\d.]+)\s*(kv|v)?/i);
  if (!m) return null;
  const x = Number(m[1]);
  if (!Number.isFinite(x)) return null;
  return /kv/i.test(m[2] || '') ? x * 1000 : x;
}

const ListQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  siteId: z.string().regex(/^[0-9a-f-]{36}$/i).optional(),
  severity: z.enum(['danger', 'warning']).optional(),
});

// ── GET /api/v1/arc-flash/labels ──────────────────────────────────────────────
router.get('/labels', async (req: any, res: any) => {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
  const { page, limit, siteId, severity } = parsed.data;
  const accountId = req.apiKeyAccountId;

  const where: any = { accountId, study: { supersededById: null } };
  if (siteId) where.asset = { siteId };
  if (severity) where.labelSeverity = severity;

  const [total, rows] = await Promise.all([
    prisma.systemStudyAsset.count({ where }),
    prisma.systemStudyAsset.findMany({
      where,
      include: {
        study: { select: { performedDate: true, expiresAt: true, method: true } },
        asset: { select: { id: true, equipmentType: true, site: { select: { id: true, name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  const data = rows.map((s: any) => {
    const ie = n(s.incidentEnergyCalCm2);
    const v = voltsOf(s.nominalVoltage);
    const sev = s.labelSeverity || (((ie != null && ie > 40) || (v != null && v > 600)) ? 'danger' : (ie != null || v != null ? 'warning' : null));
    return {
      assetId: s.assetId, busName: s.busName, equipmentType: s.asset?.equipmentType || null,
      siteId: s.asset?.site?.id || null, site: s.asset?.site?.name || null,
      nominalVoltage: s.nominalVoltage, incidentEnergyCalCm2: ie, arcFlashBoundaryIn: n(s.arcFlashBoundaryIn),
      workingDistanceIn: n(s.workingDistanceIn), ppeCategory: s.ppeCategory, requiredArcRatingCalCm2: n(s.requiredArcRatingCalCm2),
      labelSeverity: sev, studyPerformedDate: s.study?.performedDate || null, studyExpiresAt: s.study?.expiresAt || null,
      studyMethod: s.study?.method || null,
    };
  });

  res.json({ data, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
});

// ── GET /api/v1/arc-flash/one-line?siteId= ────────────────────────────────────
router.get('/one-line', async (req: any, res: any) => {
  const accountId = req.apiKeyAccountId;
  const siteId = req.query.siteId ? String(req.query.siteId) : null;
  if (!siteId || !/^[0-9a-f-]{36}$/i.test(siteId)) return res.status(400).json({ error: 'siteId (uuid) is required' });
  const site = await prisma.site.findFirst({ where: { id: siteId, accountId }, select: { id: true, name: true } });
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const assets = await prisma.asset.findMany({
    where: { accountId, siteId: site.id },
    select: { id: true, equipmentType: true, fedFromAssetId: true, nameplateData: true },
    take: 5000,
  });
  const ids = assets.map((a: any) => a.id);
  const labels = ids.length ? await prisma.systemStudyAsset.findMany({
    where: { accountId, assetId: { in: ids }, study: { supersededById: null } },
    select: { assetId: true, busName: true, nominalVoltage: true, incidentEnergyCalCm2: true, labelSeverity: true },
    orderBy: { createdAt: 'desc' },
  }) : [];
  const byAsset = new Map<string, any>();
  for (const l of labels) if (!byAsset.has(l.assetId)) byAsset.set(l.assetId, l);

  const merged = assets.map((a: any) => {
    const l = byAsset.get(a.id) || {};
    return {
      id: a.id, equipmentType: a.equipmentType, fedFromAssetId: a.fedFromAssetId,
      name: (a.nameplateData && a.nameplateData.busName) || l.busName || a.equipmentType,
      nominalVoltage: l.nominalVoltage || (a.nameplateData && a.nameplateData.nominalVoltage) || null,
      incidentEnergyCalCm2: n(l.incidentEnergyCalCm2), labelSeverity: l.labelSeverity || null,
    };
  });

  res.json({ site: { id: site.id, name: site.name }, ...buildOneLine(merged) });
});

// ── GET /api/v1/arc-flash/work-order-precheck?assetId= ── Slice 8 (CMMS loop) ──
// A CMMS/EAM calls this before issuing a work order on energized equipment: it
// returns whether the arc-flash study is valid (canIssue) + the hazard data to
// stamp on the permit. Block the WO when canIssue is false. Read scope.
router.get('/work-order-precheck', async (req: any, res: any) => {
  const accountId = req.apiKeyAccountId;
  const assetId = req.query.assetId ? String(req.query.assetId) : null;
  if (!assetId || !/^[0-9a-f-]{36}$/i.test(assetId)) return res.status(400).json({ error: 'assetId (uuid) is required' });
  const asset = await prisma.asset.findFirst({ where: { id: assetId, accountId }, select: { id: true, equipmentType: true, site: { select: { name: true } } } });
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const rows = await prisma.systemStudyAsset.findMany({
    where: { assetId: asset.id, accountId },
    include: { study: { select: { performedDate: true, expiresAt: true, peName: true, method: true, supersededById: true } } },
  });
  const current = currentRowOf(rows);
  const permit = buildEnergizedWorkPermit({ bus: current || { busName: null }, study: current?.study || null, asset });
  res.json({ assetId: asset.id, canIssue: permit.validation.canIssue, reasons: permit.validation.reasons, hazard: permit.hazard, study: permit.study, disclaimer: SC_DATA_LAYER_DISCLAIMER });
});

// ── POST /api/v1/arc-flash/devices ── Slice 8: write verified settings back ────
// A CMMS/EAM (or a PE tool) pushes a verified protective-device record back into
// SC's data layer. Creates a durable ProtectiveDevice (source=import). Write scope.
const DeviceBody = z.object({
  assetId: z.string().regex(/^[0-9a-f-]{36}$/i),
  label: z.string().max(200).optional(),
  deviceType: z.enum(['breaker', 'fuse', 'relay', 'switch']).optional(),
  manufacturer: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  partNumber: z.string().max(200).optional(),
  frameRatingA: z.coerce.number().nonnegative().optional(),
  sensorRatingA: z.coerce.number().nonnegative().optional(),
  settings: z.record(z.any()).optional(),
});
router.post('/devices', requireScope('write'), async (req: any, res: any) => {
  const accountId = req.apiKeyAccountId;
  const parsed = DeviceBody.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
  const b = parsed.data;
  const asset = await prisma.asset.findFirst({ where: { id: b.assetId, accountId }, select: { id: true, siteId: true } });
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  const device = await prisma.protectiveDevice.create({
    data: {
      accountId, siteId: asset.siteId, assetId: asset.id,
      label: b.label || [b.manufacturer, b.model].filter(Boolean).join(' ') || 'Imported device',
      deviceType: b.deviceType || null, manufacturer: b.manufacturer || null,
      model: b.model || null, partNumber: b.partNumber || null,
      frameRatingA: b.frameRatingA ?? null, sensorRatingA: b.sensorRatingA ?? null,
      settings: b.settings && Object.keys(b.settings).length ? b.settings : null,
      source: 'import', settingsCollectedAt: new Date(),
    },
    select: { id: true, assetId: true, deviceType: true, manufacturer: true, model: true, frameRatingA: true, sensorRatingA: true, settings: true, source: true, status: true, createdAt: true },
  });
  res.status(201).json({ device });
});

module.exports = router;
