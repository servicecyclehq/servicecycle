'use strict';

/**
 * routes/backup.js
 * ----------------
 * GET  /api/backup/logs          — list recent backup logs (admin only)
 * POST /api/backup/run           — trigger a manual backup (admin only)
 * GET  /api/backup/status        — quick health check: configured? last backup?
 */

const express    = require('express');
const rateLimit  = require('express-rate-limit');
// lib/prisma exports the client directly — destructuring yields undefined.
import prisma from '../lib/prisma';
const { runBackup, isConfigured, getBackupConfig } = require('../lib/backup');

const router = express.Router();

// Only admins may access backup endpoints
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required.' });
  }
  next();
}

// Manual trigger: max 5 per hour to avoid accidental hammering
const manualLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      5,
  message:  { success: false, error: 'Too many manual backup requests — try again later.' },
});

// ── GET /api/backup/status ────────────────────────────────────────────────────
router.get('/status', requireAdmin, async (req, res) => {
  try {
    const config = getBackupConfig();

    const last = await prisma.backupLog.findFirst({
      where:   { accountId: req.user.accountId, status: 'success' },
      orderBy: { createdAt: 'desc' },
    });

    const lastFailure = await prisma.backupLog.findFirst({
      where:   { accountId: req.user.accountId, status: 'failure' },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      success: true,
      data: {
        configured:     isConfigured(),
        config,
        lastBackup:     last        ? { at: last.createdAt, sizeBytes: last.sizeBytes, filename: last.filename } : null,
        lastFailure:    lastFailure ? { at: lastFailure.createdAt, error: lastFailure.error } : null,
      },
    });
  } catch (err) {
    console.error('[backup/status]', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch backup status.' });
  }
});

// ── GET /api/backup/logs ──────────────────────────────────────────────────────
router.get('/logs', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);

    const logs = await prisma.backupLog.findMany({
      where:   { accountId: req.user.accountId },
      orderBy: { createdAt: 'desc' },
      take:    limit,
    });

    return res.json({ success: true, data: { logs } });
  } catch (err) {
    console.error('[backup/logs]', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch backup logs.' });
  }
});

// ── POST /api/backup/run ──────────────────────────────────────────────────────
router.post('/run', requireAdmin, manualLimiter, async (req, res) => {
  if (!isConfigured()) {
    return res.status(400).json({
      success: false,
      error:   'Backup storage is not configured. Set BACKUP_S3_BUCKET, BACKUP_S3_KEY_ID, and BACKUP_S3_SECRET.',
    });
  }

  // Respond immediately — backup runs async (can take 10-60s for large DBs)
  res.json({ success: true, data: { message: 'Backup started. Check logs for result.' } });

  // Fire-and-forget (result is written to BackupLog by runBackup)
  runBackup(req.user.accountId, 'manual').catch(e => {
    console.error('[backup/run] Unhandled error:', e.message);
  });
});

module.exports = router;

export {};
