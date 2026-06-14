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
const crypto = require('crypto');
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

    // Per-view access record into the tamper-evident audit chain so the owner
    // can later prove who viewed shared compliance data, and the view rides the
    // same hash chain + SIEM export as every other audit event. IP is hashed
    // (not stored raw) for privacy; the public token itself is never logged.
    const ipHash = crypto.createHash('sha256').update(String(req.ip || '')).digest('hex').slice(0, 16);
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    prisma.activityLog.create({
      data: {
        accountId: link.accountId,
        action:    'share_link_viewed',
        details:   { shareLinkId: link.id, label: link.label || null, ipHash, userAgent: ua },
      },
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
