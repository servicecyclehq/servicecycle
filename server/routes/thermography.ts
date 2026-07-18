/**
 * routes/thermography.ts — #29 account-scoped IR thermography reads.
 *
 * GET /api/thermography/surveys/:surveyId        — survey detail + findings + evidence URL
 * GET /api/thermography/surveys/:surveyId/report — NFPA 70B §7.4 / Annex-E report payload
 * GET /api/thermography/report                   — site-wide §7.4 roll-up
 * GET /api/thermography/findings                 — search/filter findings
 *
 * Every query is scoped by req.user.accountId. Capture/ingest lives in
 * routes/thermographyIngest.ts (mounted under /api/assets).
 *
 * Mounted at /api/thermography (authenticateToken applied at the mount point).
 */

const router = require('express').Router();
import prisma from '../lib/prisma';
const { resolveAccountFeatures } = require('../lib/accountFeatures');
const { getFileUrl } = require('../lib/storage');
const { dec, shapeSurvey, shapeFinding, NETA_TABLE_100_18 } = require('../lib/thermographyShape');
const { renderReportDocPdf } = require('../lib/reportsPdf');
const { formatTimestamp } = require('../lib/pdfStyle');

const IR_REF_LABEL: Record<string, string> = {
  AMBIENT: 'Over ambient', SIMILAR: 'Similar component', BASELINE: 'Vs. baseline',
};

function assetTitle(a: any): string {
  if (!a) return 'IR survey';
  return [a.manufacturer, a.model].filter(Boolean).join(' ') || a.equipmentType || a.id;
}

/** One §7.4 survey → the conditions stats block + findings table sections. */
function surveySections(r: any): any[] {
  const c = r.conditions || {};
  return [
    {
      title: assetTitle(r.asset),
      aux: [r.asset?.siteName, c.surveyDate ? new Date(c.surveyDate).toISOString().slice(0, 10) : null]
        .filter(Boolean).join(' · '),
      stats: [
        { label: 'Thermographer', value: c.thermographerName || '—' },
        { label: 'Qualification', value: c.thermographerQual || '—' },
        { label: 'Camera',        value: [c.cameraMake, c.cameraModel].filter(Boolean).join(' ') || '—' },
        { label: 'Ambient',       value: c.ambientTempC != null ? `${c.ambientTempC} C` : '—' },
        { label: 'Humidity',      value: c.humidityPct != null ? `${c.humidityPct} %` : '—' },
        { label: 'Emissivity',    value: c.emissivity != null ? String(c.emissivity) : '—' },
        { label: 'Reflected',     value: c.reflectedTempC != null ? `${c.reflectedTempC} C` : '—' },
        { label: 'Load at scan',  value: c.loadPercent != null ? `${c.loadPercent} %` : '—' },
      ],
    },
    {
      title: 'Findings',
      aux: `${r.summary.findingCount} finding(s) · ${r.summary.bySeverity.BELOW_THRESHOLD} below threshold`,
      table: {
        columns: [
          { key: 'component', label: 'Component', w: 2.0 },
          { key: 'deltaT',    label: 'ΔT',        w: 0.7, mono: true },
          { key: 'reference', label: 'Reference', w: 1.2 },
          { key: 'refDeltaT', label: 'Ref ΔT',    w: 0.7, mono: true },
          { key: 'load',      label: 'Load %',    w: 0.6, mono: true },
          { key: 'severity',  label: 'NETA severity', w: 1.4, bold: true },
          { key: 'action',    label: 'Corrective action', w: 2.0 },
        ],
        rows: (r.findings || []).map((f: any) => ({
          component: f.component || '—',
          deltaT:    f.deltaT == null ? '—' : `${f.deltaT} C`,
          reference: IR_REF_LABEL[f.referenceType] || f.referenceType || '—',
          refDeltaT: f.referenceDeltaT == null ? '—' : `${f.referenceDeltaT} C`,
          load:      f.loadPercent == null ? '—' : String(f.loadPercent),
          severity:  f.severity || 'Below threshold',
          action:    f.correctiveAction || '—',
        })),
        emptyText: 'No findings recorded for this survey.',
      },
    },
    {
      title: 'Evidence',
      body: r.evidence?.documentId
        ? `Source IR report on file: ${r.evidence.filename || 'IR report'} (attached to the asset's documents).`
        : 'No IR report was attached to this survey.',
    },
  ];
}

const LEGEND_SECTION = {
  title: 'NETA Table 100.18 — severity bands',
  table: {
    columns: [
      { key: 'reference', label: 'Reference', w: 1.3 },
      { key: 'band',      label: 'ΔT band',   w: 1.0 },
      { key: 'action',    label: 'Action',    w: 3.2 },
      { key: 'severity',  label: 'ServiceCycle severity', w: 1.4 },
    ],
    rows: NETA_TABLE_100_18,
    emptyText: '',
  },
};

// Same server-side gate as the ingest routes — the flag is enforced, not advisory.
async function requireThermographyFeature(req: any, res: any, next: any) {
  try {
    const features = await resolveAccountFeatures(req.user.accountId);
    if (!features || !features.thermography_import) {
      return res.status(403).json({ success: false, error: 'Feature not enabled' });
    }
    return next();
  } catch (err: any) {
    console.error('[thermography] feature resolution failed:', err?.message || err);
    return res.status(403).json({ success: false, error: 'Feature not enabled' });
  }
}
router.use(requireThermographyFeature);

const SURVEY_INCLUDE = {
  findings:       { orderBy: { deltaT: 'desc' as const } },
  createdBy:      { select: { id: true, name: true } },
  sourceDocument: { select: { id: true, filename: true, filePath: true } },
  asset:          { select: { id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true, site: { select: { id: true, name: true } } } },
};

/** Presigned URL for the attached IR report, or null. Never throws — a
 *  storage hiccup must not 500 the whole survey read. */
async function evidenceUrl(accountId: string, doc: any): Promise<string | null> {
  if (!doc || !doc.filePath) return null;
  try {
    // lib/storage.ts:461 — getFileUrl(storageKey, filename, ttlSeconds, accountId).
    return await getFileUrl(doc.filePath, doc.filename || null, null, accountId);
  } catch (err: any) {
    console.error('[thermography] evidence URL failed (non-fatal):', err?.message || err);
    return null;
  }
}

function shapeAsset(a: any) {
  if (!a) return null;
  return {
    id: a.id, equipmentType: a.equipmentType, manufacturer: a.manufacturer,
    model: a.model, serialNumber: a.serialNumber,
    siteId: a.site?.id || null, siteName: a.site?.name || null,
  };
}

// ── GET /surveys/:surveyId ───────────────────────────────────────────────────
router.get('/surveys/:surveyId', async (req: any, res: any) => {
  try {
    const survey = await prisma.thermographySurvey.findFirst({
      where:   { id: req.params.surveyId, accountId: req.user.accountId },
      include: SURVEY_INCLUDE,
    });
    if (!survey) return res.status(404).json({ success: false, error: 'Survey not found' });
    return res.json({
      success: true,
      data: {
        survey:   { ...shapeSurvey(survey), asset: shapeAsset((survey as any).asset) },
        evidence: {
          documentId: survey.sourceDocumentId,
          filename:   (survey as any).sourceDocument?.filename || null,
          url:        await evidenceUrl(req.user.accountId, (survey as any).sourceDocument),
        },
      },
    });
  } catch (err: any) {
    console.error('[thermography/survey]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to load the survey' });
  }
});

/** Assemble the §7.4-shaped payload for one survey. */
function buildSurveyReport(survey: any, evidence: any) {
  const findings = (survey.findings || []).map(shapeFinding);
  const bySeverity = { IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0, BELOW_THRESHOLD: 0 };
  for (const f of findings) {
    if (f.severity) (bySeverity as any)[f.severity] += 1;
    else bySeverity.BELOW_THRESHOLD += 1;
  }
  return {
    survey: { ...shapeSurvey(survey), asset: shapeAsset(survey.asset), findings: undefined },
    asset:  shapeAsset(survey.asset),
    // §7.4 header block — the conditions a survey must record to be defensible.
    conditions: {
      surveyDate:        survey.surveyDate,
      thermographerName: survey.thermographerName,
      thermographerQual: survey.thermographerQual,
      cameraMake:        survey.cameraMake,
      cameraModel:       survey.cameraModel,
      ambientTempC:      dec(survey.ambientTempC),
      humidityPct:       dec(survey.humidityPct),
      emissivity:        dec(survey.emissivity),
      reflectedTempC:    dec(survey.reflectedTempC),
      loadPercent:       dec(survey.loadPercent),
    },
    findings,
    summary: { findingCount: findings.length, bySeverity },
    legend:  NETA_TABLE_100_18,
    evidence,
    standardRef: 'NFPA 70B:2023 §7.4 · NETA MTS-2023 Table 100.18',
  };
}

// ── GET /surveys/:surveyId/report ────────────────────────────────────────────
router.get('/surveys/:surveyId/report', async (req: any, res: any) => {
  try {
    const survey = await prisma.thermographySurvey.findFirst({
      where:   { id: req.params.surveyId, accountId: req.user.accountId },
      include: SURVEY_INCLUDE,
    });
    if (!survey) return res.status(404).json({ success: false, error: 'Survey not found' });
    const evidence = {
      documentId: survey.sourceDocumentId,
      filename:   (survey as any).sourceDocument?.filename || null,
      url:        await evidenceUrl(req.user.accountId, (survey as any).sourceDocument),
    };
    const report = buildSurveyReport(survey, evidence);

    // Same dual-purpose contract as GET /api/compliance/report/:standardCode —
    // one route serves JSON and, with format=pdf, the rendered document.
    if (String(req.query.format || '').toLowerCase() === 'pdf') {
      const genAt = new Date();
      const day = new Date(survey.surveyDate).toISOString().slice(0, 10);
      return renderReportDocPdf(res, {
        title: 'IR Thermography Report',
        metaLines: ['NFPA 70B:2023 §7.4 · NETA MTS-2023 Table 100.18', assetTitle(report.asset), formatTimestamp(genAt)],
        generatedAt: genAt,
        filename: `IR_Thermography_${day}`,
        sections: [...surveySections(report), LEGEND_SECTION],
      });
    }
    return res.json({ success: true, data: { report, generatedAt: new Date() } });
  } catch (err: any) {
    console.error('[thermography/survey-report]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to build the IR report' });
  }
});

// ── GET /report ──────────────────────────────────────────────────────────────
// Site-wide §7.4 roll-up: every survey in scope, newest first. `siteId` and a
// `from`/`to` window narrow it; the client renders one section per survey.
router.get('/report', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const { siteId, from, to } = req.query;
    const where: any = { accountId };
    if (siteId) where.asset = { siteId: String(siteId) };
    const range = dateRange(from, to);
    if (range) where.surveyDate = range;

    const surveys = await prisma.thermographySurvey.findMany({
      where,
      orderBy: { surveyDate: 'desc' },
      take:    200, // bounded: a §7.4 roll-up is a document, not a data export
      include: SURVEY_INCLUDE,
    });

    const reports = surveys.map((s: any) => buildSurveyReport(s, {
      documentId: s.sourceDocumentId,
      filename:   s.sourceDocument?.filename || null,
      url:        null, // presigning 200 URLs per page load is not worth it; detail view presigns
    }));

    let siteName: string | null = null;
    if (siteId) {
      const site = await prisma.site.findFirst({ where: { id: String(siteId), accountId }, select: { name: true } });
      siteName = site?.name || null;
    }

    const totals = { surveys: reports.length, findings: 0, IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0, BELOW_THRESHOLD: 0 };
    for (const r of reports) {
      totals.findings += r.summary.findingCount;
      for (const k of ['IMMEDIATE', 'RECOMMENDED', 'ADVISORY', 'BELOW_THRESHOLD'] as const) {
        (totals as any)[k] += (r.summary.bySeverity as any)[k];
      }
    }

    if (String(req.query.format || '').toLowerCase() === 'pdf') {
      const genAt = new Date();
      return renderReportDocPdf(res, {
        title: 'IR Thermography Report',
        metaLines: [
          'NFPA 70B:2023 §7.4 · NETA MTS-2023 Table 100.18',
          siteName ? `Site: ${siteName}` : 'All sites',
          formatTimestamp(genAt),
        ],
        generatedAt: genAt,
        filename: `IR_Thermography_${genAt.toISOString().slice(0, 10)}`,
        sections: [
          {
            title: 'Summary',
            aux: `${totals.surveys} survey(s)`,
            stats: [
              { label: 'Surveys',         value: String(totals.surveys) },
              { label: 'Findings',        value: String(totals.findings) },
              { label: 'Immediate',       value: String(totals.IMMEDIATE) },
              { label: 'Recommended',     value: String(totals.RECOMMENDED) },
              { label: 'Advisory',        value: String(totals.ADVISORY) },
              { label: 'Below threshold', value: String(totals.BELOW_THRESHOLD) },
            ],
          },
          ...reports.flatMap(surveySections),
          LEGEND_SECTION,
        ],
      });
    }

    return res.json({
      success: true,
      data: {
        scope: { siteId: siteId || null, siteName, from: from || null, to: to || null },
        totals,
        reports,
        legend: NETA_TABLE_100_18,
        standardRef: 'NFPA 70B:2023 §7.4 · NETA MTS-2023 Table 100.18',
        generatedAt: new Date(),
        truncated: surveys.length === 200,
      },
    });
  } catch (err: any) {
    console.error('[thermography/report]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to build the IR report' });
  }
});

/** Inclusive from / to on surveyDate. Returns null when neither is usable. */
function dateRange(from: any, to: any): any | null {
  const out: any = {};
  const f = from ? new Date(String(from)) : null;
  const t = to ? new Date(String(to)) : null;
  if (f && !Number.isNaN(f.getTime())) out.gte = f;
  if (t && !Number.isNaN(t.getTime())) {
    // `to` is a day; include the whole day.
    t.setHours(23, 59, 59, 999);
    out.lte = t;
  }
  return Object.keys(out).length ? out : null;
}

// ── GET /findings ────────────────────────────────────────────────────────────
// Findings are findable by component text and filterable by severity, asset and
// date range. `severity=none` selects the below-threshold rows the old
// free-text path used to discard.
router.get('/findings', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const { search, severity, assetId, from, to } = req.query;
    const page  = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));

    const where: any = { accountId };
    if (search && String(search).trim()) {
      where.component = { contains: String(search).trim(), mode: 'insensitive' };
    }
    if (severity) {
      const s = String(severity).toUpperCase();
      if (s === 'NONE') where.severity = null;
      else if (['IMMEDIATE', 'RECOMMENDED', 'ADVISORY'].includes(s)) where.severity = s;
    }
    if (assetId) where.assetId = String(assetId);
    const range = dateRange(from, to);
    if (range) where.survey = { surveyDate: range };

    const [total, rows] = await Promise.all([
      prisma.thermographyFinding.count({ where }),
      prisma.thermographyFinding.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip:    (page - 1) * limit,
        take:    limit,
        include: {
          survey: { select: { id: true, surveyDate: true } },
          asset:  { select: { id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true, site: { select: { id: true, name: true } } } },
        },
      }),
    ]);

    return res.json({
      success: true,
      data: {
        findings: rows.map((f: any) => ({
          ...shapeFinding(f),
          surveyDate: f.survey?.surveyDate || null,
          asset:      shapeAsset(f.asset),
        })),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (err: any) {
    console.error('[thermography/findings]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to search IR findings' });
  }
});

module.exports = router;
