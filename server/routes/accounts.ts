// ─────────────────────────────────────────────────────────────────────────────
// server/routes/accounts.js
// ─────────────────────────────────────────────────────────────────────────────
//
// Account-level admin settings that don't fit cleanly under /api/settings
// (which is more about app-wide config + integrations). Today this is just
// the security toggles; expand here as more account-scoped policy lands.
//
// Audit reference: persona "MFA Implementation Reviewer", High H1.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const { z } = require('zod');
const { requireAdmin } = require('../middleware/roles');
const { validateBody } = require('../lib/validate');
const { writeLog: writeActivityLog } = require('../lib/activityLog');
import prisma from '../lib/prisma';

const router = express.Router();

// ── PUT /api/accounts/me/security ────────────────────────────────────────────
//
// Admin-only. Updates account-wide security policy flags.
//
// Today: { mfaRequiredForAdmins: boolean }
//   When true, the next time an admin logs in WITHOUT 2FA already enabled the
//   /login response carries `requires2faSetup: true` — the SPA reads this and
//   pushes the admin to the 2FA setup wizard before they can use the app.
//   Existing admins who already have 2FA on are unaffected.
const SecuritySchema = z.object({
  mfaRequiredForAdmins: z.boolean().optional(),
});

router.put('/me/security', requireAdmin, async (req, res) => {
  const parsed = validateBody(req, res, SecuritySchema);
  if (!parsed) return;
  if (Object.keys(parsed).length === 0) {
    return res.status(400).json({ success: false, error: 'No fields to update' });
  }
  try {
    const updated = await prisma.account.update({
      where: { id: req.user.accountId },
      data:  parsed,
      select: { id: true, mfaRequiredForAdmins: true },
    });
    try {
      writeActivityLog({
        userId:  req.user.id,
        action:  'account_security_updated',
        details: { fields: parsed, ip: req.ip || req.headers['x-forwarded-for'] || null },
      });
    } catch (logErr) {
      console.error('activity log (account security update) error:', logErr);
    }
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('Account security update error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update account security' });
  }
});

// ── GET /api/accounts/me/security ────────────────────────────────────────────
// Admin-only. Read current security flags so the Settings UI can render the
// current state of each toggle.
router.get('/me/security', requireAdmin, async (req, res) => {
  try {
    const acct = await prisma.account.findUnique({
      where:  { id: req.user.accountId },
      select: { id: true, mfaRequiredForAdmins: true },
    });
    if (!acct) return res.status(404).json({ success: false, error: 'Account not found' });
    return res.json({ success: true, data: acct });
  } catch (err) {
    console.error('Account security read error:', err);
    return res.status(500).json({ success: false, error: 'Failed to read account security' });
  }
});

module.exports = router;

export {};
