/**
 * lib/persistMultiSourceFeeds.ts -- derive + persist AssetFeed edges from an extracted
 * one-line / arc-flash model at CONFIRM time.
 *
 * The primary radial tree still lives on Asset.fedFromAssetId (wired by the confirm
 * handler). THIS module additionally materializes the full multi-source graph -- second
 * feeders, transfer-switch alternates, A/B side, source kind -- as AssetFeed rows so the
 * redundancy engine (lib/redundancyImpact.ts) and endpoint have real edges to chew on
 * instead of falling back to the single-cord tree.
 *
 * Idempotent per site: before writing, it deletes the AssetFeed rows for exactly the load
 * assets it is about to rewrite, so a re-confirm / re-study REPLACES that load's edges
 * rather than doubling them (matches the arc-flash asset-dedupe contract).
 *
 * System of record, NOT analysis: we persist connectivity only (who feeds whom, side,
 * transfer device, source kind). No study math, no PPE, no capacity -- those stay out.
 */

'use strict';

const { deriveMultiSourceTopology } = require('./multiSourceExtract');

// Fields carrying multi-source HINTS the extractor surfaces but the editable
// ArcFlashIngestBus row does not have columns for. Stashed on the ingest at draft
// time (ArcFlashIngest.derivedTopology.busHints) and merged back onto the
// reviewer-corrected rows at confirm so a corrected fedFrom still flows through.
const HINT_FIELDS = [
  'side', 'sourceRole', 'secondFeedFromBusName',
  'alternateSourceBusName', 'transferType', 'redundancyZone',
];

// Shape an extractor bus OR an ArcFlashIngestBus row into the ExtractedBus contract
// lib/multiSourceExtract expects. Reads equipmentTypeGuess|equipmentType, whichever
// is present, so both the draft (ext.buses) and confirm (DB rows) paths work.
function buildExtractedModel(rows: any[]): any {
  const buses = (Array.isArray(rows) ? rows : []).map((b: any) => ({
    busName: b.busName,
    equipmentType: b.equipmentType ?? b.equipmentTypeGuess ?? null,
    fedFromBusName: b.fedFromBusName ?? null,
    side: b.side ?? null,
    sourceRole: b.sourceRole ?? null,
    secondFeedFromBusName: b.secondFeedFromBusName ?? null,
    alternateSourceBusName: b.alternateSourceBusName ?? null,
    transferType: b.transferType ?? null,
    redundancyZone: b.redundancyZone ?? null,
  })).filter((b: any) => b.busName);
  return { buses };
}

// Pull the per-bus hint map to persist alongside the derived topology at draft time.
function busHintsFrom(rows: any[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const b of (Array.isArray(rows) ? rows : [])) {
    if (!b || !b.busName) continue;
    const h: any = {};
    for (const f of HINT_FIELDS) if (b[f] != null) h[f] = b[f];
    if (Object.keys(h).length) out[b.busName] = h;
  }
  return out;
}

// Derive the topology for a set of bus rows (draft: ext.buses; confirm: DB rows already
// merged with stored hints). Returns the DerivedTopology plus a busHints map to stash.
function deriveForBusRows(rows: any[]): any {
  const derived = deriveMultiSourceTopology(buildExtractedModel(rows));
  return { ...derived, busHints: busHintsFrom(rows) };
}

// Merge stored draft-time hints back onto reviewer-corrected DB rows.
function mergeHints(rows: any[], busHints: Record<string, any> | null | undefined): any[] {
  const hints = busHints || {};
  return (Array.isArray(rows) ? rows : []).map((b: any) => ({ ...b, ...(hints[b.busName] || {}) }));
}

/**
 * Persist the derived multi-source feeds as AssetFeed rows inside an open transaction.
 *
 * @param txn            Prisma transaction client
 * @param accountId, siteId
 * @param derived        DerivedTopology (feeds/sides/dualCorded/sourceKinds/gaps)
 * @param nameToAssetId  Map<busName, assetId> built by the confirm handler
 * @returns { feedsPersisted, skippedUnresolved, gaps }
 */
async function persistMultiSourceFeeds(txn: any, args: {
  accountId: string; siteId: string; derived: any; nameToAssetId: Map<string, string>;
}): Promise<{ feedsPersisted: number; skippedUnresolved: number; gaps: any[] }> {
  const { accountId, siteId, derived, nameToAssetId } = args;
  const feeds = (derived && Array.isArray(derived.feeds)) ? derived.feeds : [];
  const sourceKinds = (derived && derived.sourceKinds) ? derived.sourceKinds : {};

  const rows: any[] = [];
  const seen = new Set<string>();
  let skippedUnresolved = 0;

  for (const f of feeds) {
    const loadAssetId = nameToAssetId.get(f.loadBusName);
    const sourceAssetId = nameToAssetId.get(f.sourceBusName);
    // Can only persist an edge between two real, confirmed assets. An unresolved
    // endpoint (e.g. an untraced alternate source) is left to the gap flags.
    if (!loadAssetId || !sourceAssetId) { skippedUnresolved++; continue; }
    if (loadAssetId === sourceAssetId) continue; // no self-loops
    const role = f.role || 'normal';
    const side = f.side ?? null;
    const dedupeKey = loadAssetId + '|' + sourceAssetId + '|' + role + '|' + (side || '');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const transferAssetId = f.transferBusName ? (nameToAssetId.get(f.transferBusName) || null) : null;
    const sourceKind = sourceKinds[f.sourceBusName] || f.sourceKind || 'derived';
    rows.push({ accountId, siteId, loadAssetId, sourceAssetId, role, side, sourceKind, transferAssetId, seq: rows.length });
  }

  const involvedLoadIds = [...new Set(rows.map((r) => r.loadAssetId))];
  if (involvedLoadIds.length) {
    // Idempotent replace: clear this load-set's existing feeds, then write fresh.
    await txn.assetFeed.deleteMany({ where: { accountId, siteId, loadAssetId: { in: involvedLoadIds } } });
  }
  for (const r of rows) {
    await txn.assetFeed.create({ data: r });
  }

  return { feedsPersisted: rows.length, skippedUnresolved, gaps: (derived && derived.gaps) || [] };
}

module.exports = { persistMultiSourceFeeds, deriveForBusRows, buildExtractedModel, busHintsFrom, mergeHints, HINT_FIELDS };
export {};