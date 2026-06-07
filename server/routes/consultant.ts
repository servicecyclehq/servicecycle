/**
 * Consultant Access Routes
 *
 * GET    /api/consultant-access          — list all consultant access records for this account (admin only)
 * POST   /api/consultant-access/grant    — admin grants consultant access to an existing user by email
 * DELETE /api/consultant-access/:id      — admin revokes a consultant access grant
 */

const express  = require('express');
const router   = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin }      = require('../middleware/roles');
import prisma from '../lib/prisma';

// All routes require auth
router.use(authenticateToken);

// ─── GET /api/consultant-access ──────────────────────────────────────────────
// Returns all consultant access records for this account (active + revoked).
router.get('/', requireAdmin, async (req, res) => {
  try {
    const records = await prisma.consultantAccess.findMany({
      where: { accountId: req.user.accountId },
      include: {
        consultant: { select: { id: true, name: true, email: true } },
        grantedBy:  { select: { id: true, name: true } },
        revokedBy:  { select: { id: true, name: true } },
      },
      orderBy: { grantedAt: 'desc' },
    });
    res.json({ success: true, data: { records } });
  } catch (err) {
    console.error('List consultant access error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch consultant access records' });
  }
});

// ─── POST /api/consultant-access/grant ───────────────────────────────────────
// Admin grants consultant access to a user identified by email.
// If the user doesn't exist in this account yet, returns an error — they must
// be invited first via the standard invite flow with the 'consultant' role.
router.post('/grant', requireAdmin, async (req, res) => {
  const { email, notes } = req.body;
  if (!email) {
    return res.status(400).json({ success: false, error: 'email is required' });
  }

  try {
    // Find the consultant user in this account
    const consultant = await prisma.user.findFirst({
      where: { email: email.toLowerCase().trim(), accountId: req.user.accountId, role: 'consultant' },
    });

    if (!consultant) {
      return res.status(404).json({
        success: false,
        error: 'No consultant user found with that email. Invite them first with the Consultant role.',
      });
    }

    // Check if an active grant already exists
    const existing = await prisma.consultantAccess.findFirst({
      where: { accountId: req.user.accountId, consultantId: consultant.id, isActive: true },
    });
    if (existing) {
      return res.status(409).json({ success: false, error: 'This consultant already has active access.' });
    }

    const record = await prisma.consultantAccess.create({
      data: {
        accountId:    req.user.accountId,
        consultantId: consultant.id,
        grantedById:  req.user.id,
        notes:        notes || null,
      },
      include: {
        consultant: { select: { id: true, name: true, email: true } },
        grantedBy:  { select: { id: true, name: true } },
      },
    });

    res.json({ success: true, data: { record } });
  } catch (err) {
    console.error('Grant consultant access error:', err);
    res.status(500).json({ success: false, error: 'Failed to grant consultant access' });
  }
});

// ─── DELETE /api/consultant-access/:id ───────────────────────────────────────
// Admin revokes a consultant access grant.
// Records the revocation — does NOT delete the audit trail.
// Also deactivates the consultant's user account on this tenant.
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const record = await prisma.consultantAccess.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });

    if (!record) {
      return res.status(404).json({ success: false, error: 'Consultant access record not found' });
    }
    if (!record.isActive) {
      return res.status(400).json({ success: false, error: 'This access has already been revoked' });
    }

    // Mark revoked in ConsultantAccess + deactivate the user in one transaction
    const [updated] = await prisma.$transaction([
      prisma.consultantAccess.update({
        where: { id: record.id },
        data: {
          isActive:   false,
          revokedById: req.user.id,
          revokedAt:   new Date(),
        },
        include: {
          consultant: { select: { id: true, name: true, email: true } },
          revokedBy:  { select: { id: true, name: true } },
        },
      }),
      prisma.user.update({
        where: { id: record.consultantId },
        data: { isActive: false },
      }),
    ]);

    res.json({ success: true, data: { record: updated } });
  } catch (err) {
    console.error('Revoke consultant access error:', err);
    res.status(500).json({ success: false, error: 'Failed to revoke consultant access' });
  }
});

// ─── POST /api/consultant-access/:id/restore ─────────────────────────────────
// Admin re-activates a previously revoked consultant (creates a new grant record).
router.post('/:id/restore', requireAdmin, async (req, res) => {
  try {
    const old = await prisma.consultantAccess.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId, isActive: false },
    });
    if (!old) {
      return res.status(404).json({ success: false, error: 'Revoked access record not found' });
    }

    const [record] = await prisma.$transaction([
      prisma.consultantAccess.create({
        data: {
          accountId:    req.user.accountId,
          consultantId: old.consultantId,
          grantedById:  req.user.id,
          notes:        old.notes,
        },
        include: {
          consultant: { select: { id: true, name: true, email: true } },
          grantedBy:  { select: { id: true, name: true } },
        },
      }),
      prisma.user.update({
        where: { id: old.consultantId },
        data: { isActive: true },
      }),
    ]);

    res.json({ success: true, data: { record } });
  } catch (err) {
    console.error('Restore consultant access error:', err);
    res.status(500).json({ success: false, error: 'Failed to restore consultant access' });
  }
});

module.exports = router;

export {};
