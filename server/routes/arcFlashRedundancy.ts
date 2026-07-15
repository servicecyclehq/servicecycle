/**
 * routes/arcFlashRedundancy.ts -- read-only redundancy-impact endpoint.
 *
 *   GET /api/arc-flash-redundancy/site/:siteId/redundancy-impact?offline=<assetId|sideA|sideB>[&offlineEdge=<feedId>]
 *
 * Loads the site's multi-source graph (AssetFeed edges + asset nodes), maps the
 * `offline` selector, and calls the pure lib/redundancyImpact engine. No mutation.
 * Falls back to the primary tree (Asset.fedFromAssetId) when AssetFeed is empty, so it
 * works before the topology table is populated. TENANCY: scopes to req.user.accountId.
 */
import { Router } from 'express';
import prisma from '../lib/prisma';
import { redundancyImpact } from '../lib/redundancyImpact';
import type { RINode, RIEdge, SourceKind, OfflineSpec } from '../lib/redundancyImpact';

const router: Router = Router();

const SOURCE_KIND_BY_TYPE: Record<string, SourceKind> = {
  UTILITY_SERVICE: 'utility',
  GENERATOR: 'generator',
  PARALLELING_SWITCHGEAR: 'generator',
  UPS_BATTERY: 'ups',
  BATTERY_SYSTEM: 'bess',
};
const LOAD_TYPES = new Set(['IT_RACK', 'MECHANICAL_LOAD', 'MOTOR']);

function claimFromRedundancyStatus(s: string | null | undefined): string | null {
  if (!s) return null;
  const m: Record<string, string> = { N: 'N', N_PLUS_1: 'N+1', TWO_N: '2N' };
  return m[s] ?? s;
}

router.get('/site/:siteId/redundancy-impact', async (req: any, res) => {
  try {
    const accountId = req.user.accountId;
    const siteId = String(req.params.siteId);
    const site = await prisma.site.findFirst({ where: { id: siteId, accountId }, select: { id: true } });
    if (!site) return res.status(404).json({ error: 'site not found' });

    const assets = await prisma.asset.findMany({
      where: { accountId, siteId, archivedAt: null },
      select: { id: true, equipmentType: true, redundancyStatus: true, fedFromAssetId: true, manufacturer: true, model: true },
    });
    const feeds = await prisma.assetFeed.findMany({
      where: { accountId, siteId },
      select: { id: true, loadAssetId: true, sourceAssetId: true, role: true, side: true, sourceKind: true, transferAssetId: true },
    });

    const nodes: RINode[] = assets.map((a) => ({
      id: a.id,
      label: [a.manufacturer, a.model].filter(Boolean).join(' ') || a.equipmentType,
      sourceKind: SOURCE_KIND_BY_TYPE[a.equipmentType],
      isLoad: LOAD_TYPES.has(a.equipmentType),
      redundancyClaim: claimFromRedundancyStatus(a.redundancyStatus),
    }));

    // Edges: prefer AssetFeed rows; fall back to the primary tree (fedFromAssetId) when the
    // topology table is empty, mirroring the migration backfill so the endpoint is useful today.
    let edges: RIEdge[] = feeds.map((f) => ({
      id: f.id,
      loadAssetId: f.loadAssetId,
      sourceAssetId: f.sourceAssetId,
      role: (f.role as RIEdge['role']) || 'normal',
      side: (f.side as RIEdge['side']) ?? null,
      sourceKind: (f.sourceKind as SourceKind) || 'derived',
      transferAssetId: f.transferAssetId ?? null,
    }));
    if (edges.length === 0) {
      edges = assets
        .filter((a) => a.fedFromAssetId)
        .map((a) => ({
          id: `tree-${a.id}`,
          loadAssetId: a.id,
          sourceAssetId: a.fedFromAssetId as string,
          role: 'normal' as const,
          side: null,
          sourceKind: 'derived' as const,
          transferAssetId: null,
        }));
    }

    // Implicit service entrance: a non-load node with no source kind and no incoming feed is
    // treated as a durable utility root, so radial single-source data still resolves sensibly.
    // (Tagging real UTILITY_SERVICE / GENERATOR / UPS assets is the human-iteration follow-on.)
    const hasIncoming = new Set(edges.map((e) => e.loadAssetId));
    for (const n of nodes) {
      if (!n.isLoad && !n.sourceKind && !hasIncoming.has(n.id)) n.sourceKind = 'utility';
    }

    const offline: OfflineSpec = {};
    const raw = req.query.offline != null ? String(req.query.offline) : '';
    if (raw) {
      const m = /^side([AB])$/i.exec(raw);
      if (m) offline.side = m[1].toUpperCase() as 'A' | 'B';
      else offline.nodeIds = raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const offlineEdge = req.query.offlineEdge != null ? String(req.query.offlineEdge) : '';
    if (offlineEdge) offline.edgeIds = offlineEdge.split(',').map((s) => s.trim()).filter(Boolean);

    const result = redundancyImpact(nodes, edges, offline);
    return res.json({
      siteId,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      edgeSource: feeds.length ? 'asset_feeds' : 'fed_from_tree_fallback',
      ...result,
      legend: {
        RETAINED: 'still powered and still redundant',
        AT_RISK: 'still powered but down to a single source (or battery ride-through only)',
        DROPPED: 'no source path remains',
      },
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'redundancy-impact failed' });
  }
});

module.exports = router;
