/**
 * Public partner invite accept routes — no authentication required.
 *
 * GET  /api/invite/accept?token=...  — look up invite metadata for the accept page
 * POST /api/invite/accept            — complete acceptance after user authenticates
 */

import crypto from 'crypto';
const router      = require('express').Router();
const prisma      = require('../lib/prisma').default;
const rateLimit   = require('express-rate-limit');
const { authenticateToken } = require('../middleware/auth');

// SEC3: rate-limit the public token-lookup endpoint to prevent bulk token
// enumeration. 10 requests per IP per hour is generous for legitimate use
// (one browser tab opening an invite link) but blocks automated scanning.
const inviteAcceptLimiter = rateLimit({
  windowMs:       60 * 60 * 1000, // 1-hour sliding window
  max:            10,
  standardHeaders: true,
  legacyHeaders:  false,
  message: { error: 'Too many invite lookup attempts. Please try again later.' },
});

// GET /api/invite/accept?token=...
// Returns metadata so the frontend can render the accept page before auth.
// SEC3: inviteeEmail is NOT returned here — it is revealed only after the
// user authenticates and completes the POST /accept flow. Returning the
// full email address in an unauthenticated GET response allows anyone with
// an invite token (e.g. from a forwarded link) to harvest the invitee's
// email without ever logging in.
router.get('/accept', inviteAcceptLimiter, async (req: any, res: any) => {
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

    // SEC3: do NOT return inviteeEmail — revealing it in an unauthenticated
    // GET response allows anyone holding a forwarded/leaked invite token to
    // harvest the invitee's address without logging in. The email is available
    // to the authenticated caller after POST /accept succeeds (error message
    // already references it for the email-mismatch 403 case, which only fires
    // after authentication). existingAccount is still returned so the frontend
    // can choose to show "sign in" vs "create account" UI.
    res.json({
      partnerOrgName:  invite.partnerOrg.name,
      partnerOrgLogo:  invite.partnerOrg.logoUrl,
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

    // 2026-07-12 race-siblings sweep: the array-form $transaction below did
    // TWO unconditional updates with no re-check of either row's state at
    // write time -- the same missing-atomic-guard shape as workOrders.ts
    // /approve and deficiencies.ts /resolve, but the actual exploitable race
    // here has a DIFFERENT shape than "the same invite accepted twice": it's
    // a race between TWO DIFFERENT invites (from two different partner orgs)
    // both targeting the SAME account.
    //
    // Same-invite-twice (single-record double-apply, same shape as the rest
    // of this sweep): guarded via the partnerInvite claim below
    // (acceptedAt: null at write time).
    //
    // Two-different-invites (the real distinct race, per task instructions):
    // if inviteeEmail has two pending invites from org A and org B and the
    // user accepts both nearly simultaneously, BOTH requests can read
    // `currentOrgId` as null (or as some third already-linked org) BEFORE
    // either transaction commits, both pass the `currentOrgId !==
    // invite.partnerOrgId` check above, then both unconditionally overwrite
    // account.partnerOrgId. Whichever transaction commits last silently wins
    // the account row -- but BOTH invites still get marked acceptedAt and
    // both responses report success, so the LOSING org's caller sees "linked"
    // while the account is actually linked to the other org. Guarded via the
    // account claim below (partnerOrgId must still be null or already this
    // same org, re-checked at write time, not just at the read above).
    try {
      await prisma.$transaction(async (tx: any) => {
        const inviteClaim = await tx.partnerInvite.updateMany({
          where: { id: invite.id, acceptedAt: null },
          data: {
            acceptedAt: new Date(),
            accountId:  user.accountId,
          },
        });
        if (inviteClaim.count === 0) {
          const e: any = new Error('INVITE_ALREADY_ACCEPTED');
          e.code = 'INVITE_ALREADY_ACCEPTED';
          throw e;
        }

        const acctClaim = await tx.account.updateMany({
          where: {
            id: user.accountId,
            OR: [{ partnerOrgId: null }, { partnerOrgId: invite.partnerOrgId }],
          },
          data: { partnerOrgId: invite.partnerOrgId },
        });
        if (acctClaim.count === 0) {
          const e: any = new Error('ACCOUNT_LINKED_ELSEWHERE');
          e.code = 'ACCOUNT_LINKED_ELSEWHERE';
          throw e;
        }
      });
    } catch (e: any) {
      if (e?.code === 'INVITE_ALREADY_ACCEPTED') {
        return res.status(409).json({ error: 'Invite already accepted' });
      }
      if (e?.code === 'ACCOUNT_LINKED_ELSEWHERE') {
        return res.status(409).json({ error: 'This account is already linked to a different partner organization. Contact support to transfer it.' });
      }
      throw e;
    }

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
