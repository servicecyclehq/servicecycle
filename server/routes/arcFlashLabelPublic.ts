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
          superseded: !!current?.study?.supersededById,
        },
        printedAt: anchor.printedAt || null,
        printedSnapshot: anchor.printedSnapshot || null,
        mismatch,
      },
    });
  } catch (e) {
    console.error('arc-flash public label error:', e);
    res.status(500).json({ success: false, error: 'Failed to resolve label' });
  }
});

module.exports = router;
