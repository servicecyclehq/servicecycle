/**
 * routes/shareLinkPublic.ts — #21 public, unauthenticated share-link view.
 *
 * GET /api/public/share/:token — returns the read-only, watermarked compliance
 * package for a valid (non-revoked, non-expired) share link. No auth: the token
 * is the credential. Increments a view counter for the owner's audit trail.
 * Mounted WITHOUT authenticateToken in index.ts.
 */

const router = require('express').Router();
import prisma from '../lib/prisma';
const { buildSharePackage } = require('./shareLinks');

router.get('/:token', async (req: any, res: any) => {
  try {
    const token = String(req.params.token || '');
    if (token.length < 16) return res.status(404).json({ success: false, error: 'Invalid link' });

    const link = await prisma.shareLink.findUnique({
      where:  { token },
      select: { id: true, accountId: true, label: true, expiresAt: true, revokedAt: true },
    });
    const now = new Date();
    if (!link || link.revokedAt || link.expiresAt <= now) {
      return res.status(404).json({ success: false, error: 'This link is no longer available.' });
    }

    const pkg = await buildSharePackage(link.accountId);

    // View telemetry for the owner — best-effort, never blocks the response.
    prisma.shareLink.update({
      where: { id: link.id },
      data:  { viewCount: { increment: 1 }, lastViewedAt: now },
    }).catch(() => {});

    return res.json({
      success: true,
      data: {
        ...pkg,
        readOnly: true,
        sharedWith: link.label || null,
        expiresAt: link.expiresAt,
        watermark: `Shared via ServiceCycle${link.label ? ` with ${link.label}` : ''} — read-only`,
      },
    });
  } catch (err: any) {
    console.error('[shareLinkPublic]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to load shared compliance package' });
  }
});

module.exports = router;
