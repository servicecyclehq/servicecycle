'use strict';

/**
 * lib/assetLabel.ts -- shared "what do we call this asset" display-label helper.
 *
 * Asset (server/prisma/schema.prisma) has NO `name` column. Several call sites
 * read `asset.name` anyway -- a residual instance of the e26354c crash-class
 * (2026-07-08 acquisition audit, W1-L4 / item 9): `asset.name` is always
 * `undefined`, so `asset.name ?? fallback` silently always takes the fallback
 * (a raw UUID or a generic "Asset"/"Equipment" string) instead of a real
 * manufacturer/model/serial label.
 *
 * This mirrors several near-identical local copies already in the codebase
 * (routes/outagePlan.ts, routes/outagePlanner.ts, routes/quoteRequests.ts,
 * lib/complianceReport.ts's gapAssetLabel) and client/src/lib/equipment.js's
 * assetLabel() -- kept here as the one canonical SERVER-side copy so new call
 * sites don't have to re-invent (or re-break) it. Existing local copies are
 * left as-is (out of scope for this pass) since they already do the right
 * thing; only the four confirmed asset.name ghost-field call sites were
 * pointed at this helper.
 */
function assetLabel(
  a: { manufacturer?: string | null; model?: string | null; serialNumber?: string | null; equipmentType?: string | null } | null | undefined,
  fallback: string = 'Asset',
): string {
  if (!a) return fallback;
  const base = [a.manufacturer, a.model].filter(Boolean).join(' ');
  const serial = a.serialNumber ? ` #${a.serialNumber}` : '';
  return base ? base + serial : (a.equipmentType || fallback);
}

module.exports = { assetLabel };
export {};
