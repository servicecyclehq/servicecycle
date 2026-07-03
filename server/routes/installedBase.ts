'use strict';

/**
 * routes/installedBase.ts — Installed-Base Intelligence (IBI) read surface.
 *
 *   GET /benchmarks              fleet benchmark table (paginated)
 *   GET /benchmarks/:assetId     one asset's rows + its comparison pools
 *   GET /modernization-pipeline  Watch/Plan/Act ranking off modernizationRiskScore
 *   GET /attach-rate?days=90     identified → quoted → converted funnel
 *
 * Gating: requireManager on EVERY endpoint — these are account-wide risk /
 * revenue rollups, matching the 2026-07-03 hardening precedent on
 * routes/arcFlashIngest.ts (/report, /fleet, /audit-bundle) and routes/export.
 * Viewer/consultant get the standard 403 from middleware/roles (which also
 * writes the permission_denied activity entry). Tenancy: every query is scoped
 * by req.user.accountId inside lib/installedBaseIntel. Read-only — no
 * activity-log writes, matching the other report GETs.
 *
 * All computation lives in lib/installedBaseIntel.ts (pure + testable);
 * routes only parse params, paginate, and shape the envelope.
 *
 * Mount (server/index.ts):
 *   const installedBaseRoutes = require('./routes/installedBase');
 *   app.use('/api/installed-base', authenticateToken, installedBaseRoutes);
 */

const express = require('express');
const { requireManager } = require('../middleware/roles');
const prisma = require('../lib/prisma').default;
const {
  buildFleetBenchmarks,
  buildAssetBenchmarks,
  buildModernizationPipeline,
  buildAttachRate,
} = require('../lib/installedBaseIntel');

const router = express.Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function pageParams(req: any) {
  const page = Math.max(1, Math.trunc(Number(req.query.page) || 1));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(Number(req.query.limit) || DEFAULT_LIMIT)));
  return { page, limit };
}

// ── GET /benchmarks ── fleet benchmark table (worst percentile first) ─────────
router.get('/benchmarks', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const opts: any = {};
    if (req.query.equipmentType) opts.equipmentType = String(req.query.equipmentType);
    if (req.query.measurementType) opts.measurementType = String(req.query.measurementType);

    const data = await buildFleetBenchmarks(prisma, accountId, opts);

    const { page, limit } = pageParams(req);
    const total = data.rows.length;
    const start = (page - 1) * limit;
    const rows = data.rows.slice(start, start + limit);

    res.json({
      success: true,
      data: {
        generatedAt: data.generatedAt,
        caveat: data.caveat,
        thinPoolThreshold: data.thinPoolThreshold,
        summary: data.summary,
        pools: data.pools,
        rows,
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      },
    });
  } catch (e) {
    console.error('installed-base benchmarks error:', e);
    res.status(500).json({ success: false, error: 'Failed to build fleet benchmarks' });
  }
});

// ── GET /benchmarks/:assetId ── one asset inside its pools ───────────────────
router.get('/benchmarks/:assetId', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const data = await buildAssetBenchmarks(prisma, accountId, String(req.params.assetId));
    res.json({ success: true, data });
  } catch (e: any) {
    if (e && e.code === 'ASSET_NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Asset not found' });
    }
    console.error('installed-base asset benchmarks error:', e);
    res.status(500).json({ success: false, error: 'Failed to build asset benchmarks' });
  }
});

// ── GET /modernization-pipeline ── Watch/Plan/Act ranking ────────────────────
router.get('/modernization-pipeline', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const data = await buildModernizationPipeline(prisma, accountId);
    res.json({ success: true, data });
  } catch (e) {
    console.error('installed-base modernization pipeline error:', e);
    res.status(500).json({ success: false, error: 'Failed to build the modernization pipeline' });
  }
});

// ── GET /attach-rate?days=90 ── identified → quoted → converted funnel ───────
router.get('/attach-rate', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const data = await buildAttachRate(prisma, accountId, { days: req.query.days });
    res.json({ success: true, data });
  } catch (e) {
    console.error('installed-base attach-rate error:', e);
    res.status(500).json({ success: false, error: 'Failed to build the attach-rate funnel' });
  }
});

module.exports = router;

export {};
