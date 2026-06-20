/**
 * Public partner invite accept routes — no authentication required.
 *
 * GET  /api/invite/accept?token=...  — look up invite metadata for the accept page
 * POST /api/invite/accept            — complete acceptance after user authenticates
 */

import crypto from 'crypto';
const router = require('express').Router();
const prisma = require('../lib/prisma').default;
const { authenticateToken } = require('../middleware/auth');

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
// Requires authentication: the logged-in user links THEIR OWN account to the
// partner org. SECURITY: never trust a client-supplied userId — that allowed an
// attacker holding a leaked invite token to attach an arbitrary victim's account
// to their partner org. The accepting user must also be the invited email.
router.post('/accept', authenticateToken, async (req: any, res: any) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'token is required' });
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

    // The authenticated caller's own account — derived from the verified token,
    // NEVER from the request body.
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, accountId: true, email: true, account: { select: { partnerOrgId: true } } },
    });
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    // The invite is addressed to a specific email; only that person may accept.
    if (String(user.email || '').toLowerCase() !== String(invite.inviteeEmail || '').toLowerCase()) {
      return res.status(403).json({ error: 'This invite was sent to a different email address. Sign in as the invited user to accept it.' });
    }

    // F8: connecting the account to a contractor (granting fleet visibility) is
    // an account-ownership decision — only an admin/manager may accept, even
    // from the invited mailbox. Read-only viewer/consultant cannot link.
    if (!['admin', 'manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only an account admin or manager can accept a partner connection.' });
    }

    // SECURITY: don't silently transfer an account already managed by a
    // DIFFERENT partner org. Mirrors the fleet POST /accounts/:id/link 409
    // guard. Without this, an account managed by contractor A could be moved to
    // contractor B the moment any of its users accepts a B invite to their
    // mailbox, handing B full fleet visibility into A's customer. Re-accepting
    // the same org (idempotent) and linking a currently-unlinked account remain allowed.
    const currentOrgId = user.account?.partnerOrgId ?? null;
    if (currentOrgId && currentOrgId !== invite.partnerOrgId) {
      return res.status(409).json({ error: 'This account is already linked to a different partner organization. Contact support to transfer it.' });
    }

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
