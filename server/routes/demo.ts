'use strict';

/**
 * routes/demo.ts
 * --------------
 * Demo-only session utilities. Mounted at /api/demo in server/index.ts with
 * authenticateToken at the mount site (req.user is always populated here).
 *
 * POST /api/demo/switch-role  { role }
 *   "View as" switcher for the SHARED demo tenant: issues a fresh session for
 *   one of the pinned seed logins so a sales rep can hop between the five
 *   Meridian roles and the Apex partner view without re-typing passwords
 *   mid-tour.
 *
 * SECURITY POSTURE -- this is a privilege-NEUTRAL convenience, not an
 * impersonation primitive. The shared demo logins' passwords are already
 * public (printed by seed-demo.js and listed in docs/DEMO_SCRIPT.md), so a
 * switch grants nothing a visitor couldn't get by typing the password. The
 * gates below keep it that way:
 *
 *   Gate 1  DEMO_MODE === 'true' -- the exact env signal
 *           middleware/demoGuard.js uses. 403 on self-hosted / production.
 *   Gate 2  The CALLING session must already belong to the pinned shared
 *           demo account (seed-demo.js DEMO_ACCOUNT_ID) or the Apex
 *           contractor home account (seedContractorBook.js HOME_ID -- needed
 *           so the partner view can switch back). Per-visitor sandbox
 *           accounts also run with DEMO_MODE=true but are refused: their
 *           auto-provisioned admin is not a ticket into the shared tenant.
 *   Gate 3  The target identity comes ONLY from the server-side
 *           DEMO_ROLE_TARGETS map (role keyword -> fixed email + fixed
 *           accountId). The request body cannot supply an email or account
 *           id; unknown keywords are 400. Arbitrary-target switching is
 *           impossible by construction.
 *   Gate 4  The target user must exist on the pinned account, be active,
 *           and must NOT have 2FA enabled -- we never mint a session that
 *           skips a 2FA challenge, even in demo.
 *
 * Token issuance reuses routes/auth's issueTokenPair -- the same short-lived
 * access token + rotating refresh token pair /api/auth/login returns, so
 * tokenEpoch stamping, refresh rotation, and the per-user token cap behave
 * identically to a real login. Every switch writes an activity-log row
 * (action: demo_role_switched -- labeled in routes/activity.ts).
 */

const express = require('express');
import prisma from '../lib/prisma';
const { writeLog: writeActivityLog } = require('../lib/activityLog');
// Same token-issuance path as POST /api/auth/login (see routes/auth.ts H4).
const { issueTokenPair } = require('./auth');

const router = express.Router();

// Pinned by server/scripts/seed-demo.js (shared Meridian Manufacturing demo).
const DEMO_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
// Pinned by server/scripts/seedContractorBook.js (Apex Power Services home
// account -- hosts the oem_admin partner login that can open /fleet).
const PARTNER_HOME_ACCOUNT_ID = '22222222-0000-4000-8000-000000000000';

// The ONLY reachable targets: role keyword -> fixed (email, accountId).
// Never derived from request input (Gate 3).
const DEMO_ROLE_TARGETS: any = Object.freeze({
  admin:      { email: 'admin@demo.local',          accountId: DEMO_ACCOUNT_ID },
  manager:    { email: 'manager@demo.local',        accountId: DEMO_ACCOUNT_ID },
  viewer:     { email: 'viewer@demo.local',         accountId: DEMO_ACCOUNT_ID },
  consultant: { email: 'consultant@demo.local',     accountId: DEMO_ACCOUNT_ID },
  field_tech: { email: 'tech@demo.local',           accountId: DEMO_ACCOUNT_ID },
  partner:    { email: 'sam.carter@apexpower.demo', accountId: PARTNER_HOME_ACCOUNT_ID },
});

router.post('/switch-role', async (req, res) => {
  // Gate 1 -- demo instances only (same signal demoGuard's _isDemo() reads).
  if (process.env.DEMO_MODE !== 'true') {
    return res.status(403).json({
      success: false,
      error:   'Role switching is only available on demo instances.',
    });
  }

  // Gate 2 -- caller must already be inside the shared demo tenant (or the
  // Apex partner home account, so the partner view can switch back).
  const callerAccountId = req.user && req.user.accountId;
  if (callerAccountId !== DEMO_ACCOUNT_ID && callerAccountId !== PARTNER_HOME_ACCOUNT_ID) {
    return res.status(403).json({
      success: false,
      error:   'Role switching is only available inside the shared demo tenant.',
    });
  }

  // Gate 3 -- role keyword must be a key of the fixed map. No other request
  // field is consulted for target selection.
  const role   = req.body ? req.body.role : undefined;
  const target = typeof role === 'string' ? DEMO_ROLE_TARGETS[role] : undefined;
  if (!target) {
    return res.status(400).json({
      success: false,
      error:   'Unknown demo role. Expected one of: ' + Object.keys(DEMO_ROLE_TARGETS).join(', ') + '.',
    });
  }

  try {
    // Gate 4 -- the target must be THE seeded demo user: pinned email AND
    // pinned accountId, active. findFirst with both predicates (never
    // email-only) so a same-email user on another tenant can never match.
    const user = await prisma.user.findFirst({
      where: { email: target.email, accountId: target.accountId, isActive: true },
      select: {
        id: true, accountId: true, name: true, email: true, role: true,
        featureFlags: true, hiddenFeatures: true, createdAt: true,
        twoFactorEnabled: true,
        // Nested account (same shape /api/auth/me returns) so the SPA can
        // swap the company name in the sidebar without a second round-trip.
        account: {
          select: {
            id: true, companyName: true, status: true, planType: true,
            planTier: true, aiBriefEnabled: true,
          },
        },
      },
    });
    if (!user) {
      return res.status(404).json({
        success: false,
        error:   'The demo user for that role is not seeded on this instance.',
      });
    }
    // Never mint a session that would skip a 2FA challenge. Seed users ship
    // with 2FA off; this guards the window where a visitor enables it.
    if (user.twoFactorEnabled) {
      return res.status(409).json({
        success: false,
        error:   'That demo user has two-factor auth enabled; sign in normally.',
      });
    }

    const { accessToken, refreshToken } = await issueTokenPair(user.id, user.accountId);

    // Audit trail: who hopped to which seed identity (CC7.x visibility --
    // see ACTION_LABELS / CEF_SEVERITY in routes/activity.ts).
    writeActivityLog({
      userId:    req.user.id,
      accountId: req.user.accountId,
      action:    'demo_role_switched',
      details:   {
        toRole:    role,
        toEmail:   user.email,
        toUserId:  user.id,
        fromEmail: req.user.email || null,
      },
      ipAddress: req.ip,
    });

    const { twoFactorEnabled: _tf, ...safeUser } = user;
    // Same response shape as /api/auth/login so the SPA reuses its login path.
    return res.json({ success: true, data: { token: accessToken, refreshToken, user: safeUser } });
  } catch (err) {
    console.error('[demo/switch-role] failed:', err.message);
    return res.status(500).json({ success: false, error: 'Role switch failed.' });
  }
});

module.exports = router;

export {};
