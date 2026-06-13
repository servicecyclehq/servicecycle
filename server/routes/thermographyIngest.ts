/**
 * routes/thermographyIngest.ts — #29 IR thermography report ingest.
 *
 * POST /api/assets/:id/thermography/preview — parse + grade hot-spots (no write)
 * POST /api/assets/:id/thermography/commit  — create one deficiency per hot-spot
 *
 * Accepts structured hotspots [{ location, deltaT, note? }] and/or raw report
 * text (parsed by thermographyParse). Each hot-spot above the NETA Table 100.18
 * threshold becomes a deficiency on the asset (logged as a walkthrough finding,
 * workOrderId null). Thermography is a 70B 12-month required task, so every
 * compliant facility generates these annually.
 *
 * Mounted at /api/assets (authenticateToken applied at the mount point).
 */

const router = require('express').Router();
import prisma from '../lib/prisma';
const { requireManager } = require('../middleware/roles');
const { severityForDeltaT } = require('../lib/thermographyEvaluate');
const { parseThermographyText } = require('../lib/thermographyParse');

async function ownAsset(req: any) {
  return prisma.asset.findFirst({ where: { id: req.params.id, accountId: req.user.accountId }, select: { id: true } });
}

/** Merge structured hotspots with any parsed from report text. */
function resolveHotspots(body: any): { hotspots: Array<{ location: string; deltaT: number; note?: string }>; surveyDate: string | null } {
  const out: Array<{ location: string; deltaT: number; note?: string }> = [];
  if (Array.isArray(body?.hotspots)) {
    for (const h of body.hotspots) {
      const dt = Number(h?.deltaT);
      if (!Number.isFinite(dt)) continue;
      out.push({ location: String(h?.location || 'Unspecified location').slice(0, 160), deltaT: dt, note: h?.note ? String(h.note).slice(0, 300) : undefined });
    }
  }
  let surveyDate: string | null = typeof body?.surveyDate === 'string' ? body.surveyDate : null;
  if (typeof body?.reportText === 'string' && body.reportText.trim()) {
    const parsed = parseThermographyText(body.reportText);
    for (const h of parsed.hotspots) out.push(h);
    if (!surveyDate) surveyDate = parsed.surveyDate;
  }
  return { hotspots: out, surveyDate };
}

function grade(hotspots: any[], reference: string) {
  return hotspots.map((h) => {
    const s = severityForDeltaT(h.deltaT, reference === 'ambient' ? 'ambient' : 'similar');
    return { ...h, priority: s.priority, severity: s.severity, label: s.label };
  });
}

// ── POST /:id/thermography/preview ───────────────────────────────────────────
router.post('/:id/thermography/preview', async (req: any, res: any) => {
  try {
    const asset = await ownAsset(req);
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const { hotspots, surveyDate } = resolveHotspots(req.body || {});
    if (hotspots.length === 0) return res.status(400).json({ success: false, error: 'No hot-spots found. Provide rows or report text.' });
    const graded = grade(hotspots, req.body?.reference);
    const deficient = graded.filter((g) => g.severity).length;
    return res.json({ success: true, data: { surveyDate, hotspots: graded, deficienciesToCreate: deficient } });
  } catch (err: any) {
    console.error('[thermography/preview]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to read the IR report' });
  }
});

// ── POST /:id/thermography/commit ────────────────────────────────────────────
router.post('/:id/thermography/commit', requireManager, async (req: any, res: any) => {
  try {
    const asset = await ownAsset(req);
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const { hotspots, surveyDate } = resolveHotspots(req.body || {});
    if (hotspots.length === 0) return res.status(400).json({ success: false, error: 'No hot-spots to record.' });
    const graded = grade(hotspots, req.body?.reference);
    const dateStr = surveyDate ? new Date(surveyDate) : new Date();
    const stamp = Number.isNaN(dateStr.getTime()) ? '' : ` (${dateStr.toISOString().slice(0, 10)})`;

    const bySeverity: any = { IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0 };
    const toCreate = graded.filter((g) => g.severity);
    await prisma.$transaction(
      toCreate.map((g) => {
        bySeverity[g.severity] += 1;
        return prisma.deficiency.create({
          data: {
            accountId: req.user.accountId, assetId: asset.id, severity: g.severity,
            description: `IR hot-spot${stamp}: ${g.location} — ΔT ${g.deltaT}°C (${g.label})${g.note ? `. ${g.note}` : ''}`,
            correctiveAction: g.priority === 1
              ? 'Repair immediately — investigate the connection/component and re-scan after correction.'
              : 'Plan corrective work and re-scan to confirm the rise has cleared.',
          },
        });
      }),
    );

    return res.status(201).json({
      success: true,
      data: { hotspotsLogged: hotspots.length, deficienciesCreated: toCreate.length, bySeverity, hotspots: graded },
    });
  } catch (err: any) {
    console.error('[thermography/commit]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to record the IR survey' });
  }
});

module.exports = router;
