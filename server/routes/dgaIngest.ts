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
const { requireManager, requireViewer } = require('../middleware/roles');
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
function resolveGases(body: any): { gases: Record<string, number>; sampleDate: string | null; labName: string | null; reportedTdcg: number | null } {
  const structured = cleanGases(body?.gases);
  let sampleDate: string | null = typeof body?.sampleDate === 'string' ? body.sampleDate : null;
  let labName: string | null = typeof body?.labName === 'string' ? body.labName : null;
  // [Resolved 2026-07-05] Explicit structured input wins, same precedence as
  // sampleDate/labName above; falls back to whatever parseDgaText finds in
  // free-form report text.
  let reportedTdcg: number | null = Number.isFinite(Number(body?.reportedTdcg)) && body?.reportedTdcg !== '' && body?.reportedTdcg != null
    ? Number(body.reportedTdcg) : null;
  if (typeof body?.reportText === 'string' && body.reportText.trim()) {
    const parsed = parseDgaText(body.reportText);
    for (const [k, v] of Object.entries(parsed.gases)) {
      if (structured[k] === undefined) structured[k] = v as number;
    }
    if (!sampleDate) sampleDate = parsed.sampleDate;
    if (!labName) labName = parsed.labName;
    if (reportedTdcg == null) reportedTdcg = parsed.reportedTdcg;
  }
  return { gases: structured, sampleDate, labName, reportedTdcg };
}

async function ownAsset(req: any) {
  return prisma.asset.findFirst({ where: { id: req.params.id, accountId: req.user.accountId }, select: { id: true } });
}

// ── POST /:id/dga/preview — parse + evaluate, no write ───────────────────────
router.post('/:id/dga/preview', requireViewer, async (req: any, res: any) => {
  try {
    const asset = await ownAsset(req);
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const { gases, sampleDate, labName, reportedTdcg } = resolveGases(req.body || {});
    if (Object.keys(gases).length === 0) {
      return res.status(400).json({ success: false, error: 'No gas values found. Provide gas readings or report text.' });
    }
    const evaluation = evaluateDga(gases, reportedTdcg);
    return res.json({ success: true, data: { gases, sampleDate, labName, evaluation } });
  } catch (err: any) {
    console.error('[dga/preview]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to read the DGA report' });
  }
});

// ── POST /:id/dga/commit — persist a LabSample + auto-deficiency ─────────────
// INS-7-14: IEEE C57.104 condition-to-severity mapping. Condition 3 = "Action Required"
// per the standard — corrected to IMMEDIATE. Condition 2 = "Abnormal" = ADVISORY.
// Condition 4 = well above limits, always IMMEDIATE.
const SEVERITY_BY_CONDITION: Record<number, string> = { 2: 'ADVISORY', 3: 'IMMEDIATE', 4: 'IMMEDIATE' };

router.post('/:id/dga/commit', requireManager, async (req: any, res: any) => {
  try {
    const asset = await ownAsset(req);
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const { gases, sampleDate, labName, reportedTdcg } = resolveGases(req.body || {});
    if (Object.keys(gases).length === 0) {
      return res.status(400).json({ success: false, error: 'No gas values to record.' });
    }
    const when = sampleDate ? new Date(sampleDate) : new Date();
    if (Number.isNaN(when.getTime())) return res.status(400).json({ success: false, error: 'Invalid sampleDate' });

    const evaluation = evaluateDga(gases, reportedTdcg);

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
          // [W8] TDCG sums missing gases as 0 ppm (see dgaEvaluate.ts
          // missingGases) -- a partial panel must never read as an
          // unqualified, complete-panel TDCG in the record.
          // [Resolved 2026-07-05] When the report states its own TDCG, that
          // value is now authoritative (evaluation.tdcg) per Dustin's
          // "reports take precedence, we're not the engineering firm" call --
          // but a real disagreement with our recomputed sum is still
          // surfaced, never silently dropped either way.
          notes: `[ingest:dga] TDCG ${Math.round(evaluation.tdcg)} ppm${evaluation.tdcgSource === 'reported' ? ' (report-stated)' : ''}${evaluation.missingGases.length ? ` (PARTIAL PANEL -- ${evaluation.missingGases.join(', ').toUpperCase()} not reported, treated as 0 ppm)` : ''}${evaluation.tdcgDiscrepancyPct != null && evaluation.tdcgDiscrepancyPct >= 10 ? ` [NOTE: report-stated TDCG differs from the recomputed sum (${Math.round(evaluation.computedTdcg)} ppm) by ${evaluation.tdcgDiscrepancyPct}% -- verify gas list matches]` : ''}; IEEE C57.104 legacy 4-condition screen (estimate) — Condition ${evaluation.overallCondition}${evaluation.faultLabel ? `; ${evaluation.faultLabel}` : ''}.`,
        },
        select: { id: true, sampleDate: true, ieeeStatus: true, faultCode: true, resultRating: true },
      });

      let deficiencyCreated = false;
      const sev = SEVERITY_BY_CONDITION[evaluation.overallCondition];
      if (sev) {
        // INS-7-14: dedup guard — skip if an open IMMEDIATE DGA deficiency already
        // exists for this asset (same condition level) to prevent duplicate alerts
        // on rapid resubmission. A resolved/closed deficiency does not count.
        const existingImmediate = evaluation.overallCondition >= 3
          ? await tx.deficiency.findFirst({
              where: {
                accountId: req.user.accountId, assetId: asset.id,
                severity: 'IMMEDIATE',
                description: { contains: 'DGA Condition' },
                resolvedAt: null,
              },
              select: { id: true },
            })
          : null;

        if (!existingImmediate) {
          await tx.deficiency.create({
            data: {
              accountId: req.user.accountId, assetId: asset.id, severity: sev as any,
              description: `DGA Condition ${evaluation.overallCondition} (IEEE C57.104 legacy 4-condition screen, estimate) — TDCG ${Math.round(evaluation.tdcg)} ppm${evaluation.tdcgSource === 'reported' ? ' (report-stated)' : ''}${evaluation.missingGases.length ? ` (PARTIAL PANEL -- ${evaluation.missingGases.join(', ').toUpperCase()} not reported)` : ''}${evaluation.tdcgDiscrepancyPct != null && evaluation.tdcgDiscrepancyPct >= 10 ? ` [report TDCG vs. recomputed sum differ by ${evaluation.tdcgDiscrepancyPct}% -- verify gas list]` : ''}${evaluation.faultLabel ? `, ${evaluation.faultLabel} (${evaluation.faultCode})` : ''}. IEEE C57.104 Status ${evaluation.ieeeStatus} — ${evaluation.overallCondition >= 3 ? 'Action Required: immediate investigation.' : 'Increased monitoring required.'}`,
              correctiveAction: evaluation.overallCondition >= 3
                ? 'Action Required per IEEE C57.104 Status 3/4 — schedule immediate retest and electrical/internal inspection.'
                : 'Increase DGA sampling frequency and trend the key gases.',
            },
          });
          deficiencyCreated = true;
        } else {
          console.warn(`[dga/commit] Skipping duplicate IMMEDIATE deficiency for asset ${asset.id} — open deficiency ${existingImmediate.id} already exists`);
        }
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
