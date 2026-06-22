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

module.exports = router;
