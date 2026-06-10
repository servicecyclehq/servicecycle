/**
 * Public partner invite accept routes — no authentication required.
 *
 * GET  /api/invite/accept?token=...  — look up invite metadata for the accept page
 * POST /api/invite/accept            — complete acceptance after user authenticates
 */

import crypto from 'crypto';
const router = require('express').Router();
const prisma = require('../lib/prisma').default;

// GET /api/invite/accept?token=...
// Returns metadata so the frontend can render the accept page before auth.
router.get('/accept', async (req: any, res: any) => {
  try {
    const { token } = req.query;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'token is required' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const invite = await prisma.partnerInvite.findUnique({
      where: { tokenHash },
      include: {
        partnerOrg: { select: { name: true, logoUrl: true } },
        account:    { select: { id: true } },
      },
    });

    if (!invite) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    const now = new Date();
    const expired = invite.expiresAt < now;
    const alreadyUsed = !!invite.acceptedAt;

    // Check if an account with this email already exists
    const existingUser = await prisma.user.findFirst({
      where: { email: invite.inviteeEmail },
      select: { id: true, accountId: true },
    });

    res.json({
      partnerOrgName:  invite.partnerOrg.name,
      partnerOrgLogo:  invite.partnerOrg.logoUrl,
      inviteeEmail:    invite.inviteeEmail,
      existingAccount: !!existingUser,
      expired,
      alreadyUsed,
      expiresAt:       invite.expiresAt,
    });
  } catch (err: any) {
    console.error('[invite/accept GET]', err);
    res.status(500).json({ error: 'Failed to look up invite' });
  }
});

// POST /api/invite/accept
// Called after user authenticates. Links their account to the partner org.
router.post('/accept', async (req: any, res: any) => {
  try {
    const { token, userId } = req.body;
    if (!token || !userId) {
      return res.status(400).json({ error: 'token and userId are required' });
    }

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const invite = await prisma.partnerInvite.findUnique({
      where: { tokenHash },
      include: { partnerOrg: { select: { name: true } } },
    });

    if (!invite) return res.status(404).json({ error: 'Invite not found or already used' });
    if (invite.acceptedAt) return res.status(409).json({ error: 'Invite already accepted' });
    if (invite.revokedAt)  return res.status(410).json({ error: 'Invite has been revoked' });
    if (invite.expiresAt < new Date()) return res.status(410).json({ error: 'Invite has expired' });

    // Get the user and their account
    const user = await prisma.user.findUnique({
      where: { id: String(userId) },
      select: { id: true, accountId: true, email: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Atomically: link account, mark invite accepted
    await prisma.$transaction([
      prisma.account.update({
        where: { id: user.accountId },
        data: { partnerOrgId: invite.partnerOrgId },
      }),
      prisma.partnerInvite.update({
        where: { id: invite.id },
        data: {
          acceptedAt: new Date(),
          accountId:  user.accountId,
        },
      }),
    ]);

    res.json({
      success: true,
      partnerOrgName: invite.partnerOrg.name,
      accountId: user.accountId,
    });
  } catch (err: any) {
    console.error('[invite/accept POST]', err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

module.exports = router;
