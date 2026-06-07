'use strict';

/**
 * server/routes/adminAuditChain.js
 * --------------------------------
 *
 * Admin endpoint for reading the ActivityLog hash-chain verification state.
 * Closes the operator-visible side of Pass-6 W4 MT-127.
 *
 * Mounted at /api/admin/audit-chain (see server/index.js). Admin-only.
 *
 * Endpoints:
 *
 *   GET  /api/admin/audit-chain/verify
 *        Run the verifier synchronously across the current account's
 *        chain. Returns { ok, total, breakAt, lastHash, verifiedAt }.
 *        Allows admins to confirm chain integrity ad-hoc; the nightly
 *        cron does the same job automatically and writes
 *        `audit_chain_break` ActivityLog events on detection.
 *
 *   GET  /api/admin/audit-chain/status
 *        Read-only: returns the last chain-break events from the
 *        ActivityLog and the current chain head + total settled rows.
 *        Cheap to call (no recompute) — suitable for a status widget.
 */

const express = require('express');
const router = express.Router();
import prisma from '../lib/prisma';
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roles');
const { verifyAccount } = require('../lib/activityLogChain');

router.use(authenticateToken);
router.use(requireAdmin);

router.get('/verify', async (req, res) => {
  try {
    const result = await verifyAccount(prisma, req.user.accountId);
    res.json({ success: true, data: { ...result, verifiedAt: new Date().toISOString() } });
  } catch (err) {
    console.error('[adminAuditChain.verify] failed:', err);
    res.status(500).json({ success: false, error: 'Chain verification failed' });
  }
});

router.get('/status', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const [lastBreak, head, totalSettled, totalPending] = await Promise.all([
      prisma.activityLog.findFirst({
        where:   { accountId, action: 'audit_chain_break' },
        orderBy: { createdAt: 'desc' },
        select:  { id: true, createdAt: true, details: true },
      }),
      prisma.activityLog.findFirst({
        where:   { accountId, rowHash: { not: null } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select:  { id: true, rowHash: true, createdAt: true },
      }),
      prisma.activityLog.count({ where: { accountId, rowHash: { not: null } } }),
      prisma.activityLog.count({ where: { accountId, rowHash: null } }),
    ]);

    res.json({
      success: true,
      data: {
        head:           head ? { id: head.id, rowHash: head.rowHash, createdAt: head.createdAt } : null,
        totalSettled,
        totalPending,
        lastChainBreak: lastBreak,
      },
    });
  } catch (err) {
    console.error('[adminAuditChain.status] failed:', err);
    res.status(500).json({ success: false, error: 'Chain status read failed' });
  }
});

module.exports = router;

export {};
