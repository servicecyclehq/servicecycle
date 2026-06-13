/**
 * routes/dgaIngest.ts — #28 transformer-oil DGA lab-report ingest.
 *
 * POST /api/assets/:id/dga/preview  — parse text and/or evaluate gases (no write)
 * POST /api/assets/:id/dga/commit   — create a LabSample + auto-deficiency
 *
 * Accepts either structured gas values (the lab-portal / CSV / typed case) or
 * raw report text (a future PDF-drop flow extracts text, then posts it here);
 * dgaParse fills any gases missing from the structured input. evaluateDga turns
 * the gases into an IEEE C57.104 condition + key-gas fault hint and an auto
 * deficiency when the oil is past Condition 1.
 *
 * Mounted at /api/assets (authenticateToken applied at the mount point).
 */

const router = require('express').Router();
import prisma from '../lib/prisma';
const { requireManager } = require('../middleware/roles');
const { evaluateDga } = require('../lib/dgaEvaluate');
const { parseDgaText } = require('../lib/dgaParse');

const GAS_KEYS = ['h2', 'ch4', 'c2h2', 'c2h4', 'c2h6', 'co', 'co2', 'o2', 'n2'];

/** Coerce a {gas: value} bag to numbers, dropping blanks/NaN. */
function cleanGases(input: any): Record<string, number> {
  const out: Record<string, number> = {};
  if (input && typeof input === 'object') {
    for (const k of GAS_KEYS) {
      const v = input[k];
      if (v === '' || v == null) continue;
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

/** Merge parsed-from-text gases under explicit structured gases. */
function resolveGases(body: any): { gases: Record<string, number>; sampleDate: string | null; labName: string | null } {
  const structured = cleanGases(body?.gases);
  let sampleDate: string | null = typeof body?.sampleDate === 'string' ? body.sampleDate : null;
  let labName: string | null = typeof body?.labName === 'string' ? body.labName : null;
  if (typeof body?.reportText === 'string' && body.reportText.trim()) {
    const parsed = parseDgaText(body.reportText);
    for (const [k, v] of Object.entries(parsed.gases)) {
      if (structured[k] === undefined) structured[k] = v as number;
    }
    if (!sampleDate) sampleDate = parsed.sampleDate;
    if (!labName) labName = parsed.labName;
  }
  return { gases: structured, sampleDate, labName };
}

async function ownAsset(req: any) {
  return prisma.asset.findFirst({ where: { id: req.params.id, accountId: req.user.accountId }, select: { id: true } });
}

// ── POST /:id/dga/preview — parse + evaluate, no write ───────────────────────
router.post('/:id/dga/preview', async (req: any, res: any) => {
  try {
    const asset = await ownAsset(req);
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const { gases, sampleDate, labName } = resolveGases(req.body || {});
    if (Object.keys(gases).length === 0) {
      return res.status(400).json({ success: false, error: 'No gas values found. Provide gas readings or report text.' });
    }
    const evaluation = evaluateDga(gases);
    return res.json({ success: true, data: { gases, sampleDate, labName, evaluation } });
  } catch (err: any) {
    console.error('[dga/preview]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to read the DGA report' });
  }
});

// ── POST /:id/dga/commit — persist a LabSample + auto-deficiency ─────────────
const SEVERITY_BY_CONDITION: Record<number, string> = { 2: 'ADVISORY', 3: 'RECOMMENDED', 4: 'IMMEDIATE' };

router.post('/:id/dga/commit', requireManager, async (req: any, res: any) => {
  try {
    const asset = await ownAsset(req);
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const { gases, sampleDate, labName } = resolveGases(req.body || {});
    if (Object.keys(gases).length === 0) {
      return res.status(400).json({ success: false, error: 'No gas values to record.' });
    }
    const when = sampleDate ? new Date(sampleDate) : new Date();
    if (Number.isNaN(when.getTime())) return res.status(400).json({ success: false, error: 'Invalid sampleDate' });

    const evaluation = evaluateDga(gases);

    const result = await prisma.$transaction(async (tx: any) => {
      const sample = await tx.labSample.create({
        data: {
          accountId: req.user.accountId, assetId: asset.id,
          sampleType: 'dga', sampleDate: when, labName: labName || null,
          h2: gases.h2 ?? null, ch4: gases.ch4 ?? null, c2h2: gases.c2h2 ?? null,
          c2h4: gases.c2h4 ?? null, c2h6: gases.c2h6 ?? null, co: gases.co ?? null,
          co2: gases.co2 ?? null, o2: gases.o2 ?? null, n2: gases.n2 ?? null,
          ieeeStatus: evaluation.ieeeStatus, faultCode: evaluation.faultCode,
          resultRating: evaluation.resultRating,
          notes: `[ingest:dga] TDCG ${Math.round(evaluation.tdcg)} ppm; IEEE C57.104 Condition ${evaluation.overallCondition}${evaluation.faultLabel ? `; ${evaluation.faultLabel}` : ''}.`,
        },
        select: { id: true, sampleDate: true, ieeeStatus: true, faultCode: true, resultRating: true },
      });

      let deficiencyCreated = false;
      const sev = SEVERITY_BY_CONDITION[evaluation.overallCondition];
      if (sev) {
        await tx.deficiency.create({
          data: {
            accountId: req.user.accountId, assetId: asset.id, severity: sev as any,
            description: `DGA Condition ${evaluation.overallCondition} (IEEE C57.104) — TDCG ${Math.round(evaluation.tdcg)} ppm${evaluation.faultLabel ? `, ${evaluation.faultLabel} (${evaluation.faultCode})` : ''}.`,
            correctiveAction: evaluation.overallCondition >= 4
              ? 'Investigate immediately — schedule retest and electrical/internal inspection.'
              : 'Increase DGA sampling frequency and trend the key gases.',
          },
        });
        deficiencyCreated = true;
      }
      return { sample, deficiencyCreated };
    });

    return res.status(201).json({ success: true, data: { ...result, evaluation } });
  } catch (err: any) {
    console.error('[dga/commit]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to record the DGA result' });
  }
});

module.exports = router;
