/**
 * routes/arcFlashLabelPublic.ts — Slice 3.5c: public, unauthenticated QR/NFC
 * label portal.
 *
 * GET /api/public/arc-flash-label/:token — resolves a scanned arc-flash label to
 * the LIVE record for that bus and flags whether the physically-printed sticker
 * still matches the current study (printed-vs-current mismatch). No auth: the
 * unguessable token is the credential, and the data returned is the same NFPA 70E
 * 130.5(H) label already posted physically on the equipment. Mounted WITHOUT
 * authenticateToken in index.ts (mirrors the public share-link pattern).
 */

'use strict';

const router = require('express').Router();
import prisma from '../lib/prisma';
const { labelSnapshot, computeLabelMismatch } = require('../lib/arcFlashLabel');

function currentRow(rows: any[]): any {
  return rows.slice().sort((a: any, b: any) => {
    const sa = a.study?.supersededById ? 0 : 1, sb = b.study?.supersededById ? 0 : 1;
    if (sa !== sb) return sb - sa;
    return new Date(b.study?.performedDate || 0).getTime() - new Date(a.study?.performedDate || 0).getTime();
  })[0] || null;
}

router.get('/:token', async (req: any, res: any) => {
  try {
    const token = String(req.params.token || '');
    if (token.length < 16) return res.status(404).json({ success: false, error: 'Invalid label' });

    const anchor = await prisma.systemStudyAsset.findUnique({
      where: { publicToken: token },
      select: { assetId: true, accountId: true, printedSnapshot: true, printedAt: true },
    });
    if (!anchor) return res.status(404).json({ success: false, error: 'This label is no longer available.' });

    const [rows, asset] = await Promise.all([
      prisma.systemStudyAsset.findMany({
        where: { assetId: anchor.assetId, accountId: anchor.accountId },
        include: { study: { select: { performedDate: true, expiresAt: true, supersededById: true, peName: true, method: true } } },
      }),
      prisma.asset.findUnique({ where: { id: anchor.assetId }, select: { equipmentType: true, site: { select: { name: true } } } }),
    ]);
    const current = currentRow(rows);
    const label = labelSnapshot(current);
    const mismatch = computeLabelMismatch(anchor.printedSnapshot, current);

    // [LEGAL-8-11] A printed sticker that no longer matches the current study must
    // NOT read as a normal, valid live label — a worker scanning a stale QR could
    // otherwise trust an out-of-date incident energy / PPE. When the printed
    // snapshot differs from the current record, return an explicit superseded
    // status + a prominent warning so the portal can hard-flag "do not rely on
    // this printed label" instead of surfacing it as routine.
    const studySuperseded = !!current?.study?.supersededById;
    const printedStale = !!(mismatch && mismatch.isMismatch);
    const labelStatus = studySuperseded
      ? 'study_superseded'
      : (printedStale ? 'printed_label_outdated' : 'current');
    const warning = labelStatus === 'current'
      ? null
      : (labelStatus === 'study_superseded'
          ? 'This study has been superseded by a newer revision. Do not rely on the posted printed label — confirm the current arc-flash data with a qualified person before energized work.'
          : 'The physically-printed label no longer matches the current study (the arc-flash data has changed since it was printed). Do not rely on the posted label — a reprint is required.');

    res.json({
      success: true,
      data: {
        busName: current?.busName || null,
        equipmentType: asset?.equipmentType || null,
        site: asset?.site?.name || null,
        label,
        study: {
          performedDate: current?.study?.performedDate || null,
          expiresAt: current?.study?.expiresAt || null,
          peName: current?.study?.peName || null,
          method: current?.study?.method || null,
          superseded: studySuperseded,
        },
        printedAt: anchor.printedAt || null,
        printedSnapshot: anchor.printedSnapshot || null,
        mismatch,
        // [LEGAL-8-11] Hard status the client surfaces prominently when not 'current'.
        labelStatus,
        isCurrent: labelStatus === 'current',
        warning,
      },
    });
  } catch (e) {
    console.error('arc-flash public label error:', e);
    res.status(500).json({ success: false, error: 'Failed to resolve label' });
  }
});

module.exports = router;
