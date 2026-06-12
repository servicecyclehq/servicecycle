/**
 * Asset identity resolution (gem #3) — "is this the same breaker?"
 *
 * A SHARED matching layer used by BOTH the PDF test-report ingest and the
 * nameplate / field add-equipment scan path. Year-over-year trending — the
 * predictive feature no competitor has — is only as trustworthy as entity
 * resolution, and serials in the wild are messy (OCR confuses O/0 and I/1,
 * techs add or drop dashes and spaces). So matching here is deliberately
 * tiered and confidence-scored rather than exact-only:
 *
 *   serial_exact         raw case-insensitive equality            → high
 *   serial_fuzzy         normalized equality (O→0, I→1, separators
 *                        stripped); e.g. B36S01 ≈ B36SO1          → high / medium
 *   site_position_type   same site + position + equipment type    → medium
 *   site_type            same site + equipment type               → low
 *
 * resolveAsset returns ranked candidates carrying a `lastTestedAt` so the UI
 * can render a one-tap confirm ("Looks like SWGR-2 Main, last tested
 * 2025-03-04 — same device?") instead of silently creating a duplicate or
 * silently attaching a year of readings to the wrong asset.
 *
 * Nothing here is exact-only-replacing: callers keep their existing behaviour
 * and gain the candidate list + reasons. There is NO unique constraint on
 * (accountId, serialNumber) in the schema — duplicates are an application
 * concern, which is exactly what this resolver exists to surface.
 */

import prisma from './prisma';

export type MatchReason = 'serial_exact' | 'serial_fuzzy' | 'site_position_type' | 'site_type';
export type MatchConfidence = 'high' | 'medium' | 'low';

export interface AssetCandidate {
  id: string;
  label: string;
  serialNumber: string | null;
  equipmentType: string;
  siteName: string | null;
  positionName: string | null;
  manufacturer: string | null;
  model: string | null;
  lastTestedAt: Date | null;
  reason: MatchReason;
  confidence: MatchConfidence;
}

const CONFIDENCE_RANK: Record<MatchConfidence, number> = { high: 3, medium: 2, low: 1 };
const REASON_RANK: Record<MatchReason, number> = {
  serial_exact: 4, serial_fuzzy: 3, site_position_type: 2, site_type: 1,
};

/**
 * Canonical serial form for fuzzy comparison. Uppercases, strips every
 * non-alphanumeric character (dashes, dots, slashes, spaces), then folds the
 * two classic OCR/handwriting confusions the field actually hits: O→0 and I→1.
 * Intentionally conservative — we do NOT fold B/8, S/5, Z/2, etc., because the
 * false-positive cost (merging two real, distinct breakers) is worse than the
 * occasional missed fuzzy hit, which the site/position fallback still catches.
 *
 * Examples: "B36S01" → "B36S01"; "B36SO1" → "B36S01"; "b36-s01" → "B36S01".
 */
function normalizeSerial(raw: any): string {
  if (raw == null) return '';
  return String(raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0')
    .replace(/I/g, '1');
}

function assetLabel(a: any): string {
  return [a.manufacturer, a.model].filter(Boolean).join(' ') || a.equipmentType || 'Asset';
}

const CANDIDATE_SELECT = {
  id: true, serialNumber: true, equipmentType: true, manufacturer: true, model: true,
  siteId: true, positionId: true,
  site: { select: { name: true } },
  position: { select: { name: true } },
} as const;

/**
 * Resolve the most likely existing asset(s) for an incoming identity (a parsed
 * report header or a scanned nameplate). Pure-read, never writes.
 *
 * @returns { best, candidates } — `best` is the top-ranked candidate or null;
 *          `candidates` is the de-duplicated ranked list (capped). An empty
 *          list means "no plausible existing asset — safe to create new".
 */
async function resolveAsset(p: {
  accountId: string;
  serialNumber?: string | null;
  siteId?: string | null;
  equipmentType?: string | null;
  positionId?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  limit?: number;
}): Promise<{ best: AssetCandidate | null; candidates: AssetCandidate[] }> {
  const limit = p.limit ?? 5;
  const byId = new Map<string, AssetCandidate>();
  const consider = (row: any, reason: MatchReason, confidence: MatchConfidence) => {
    // Keep the strongest reason if the same asset matches multiple tiers.
    const existing = byId.get(row.id);
    if (existing && REASON_RANK[existing.reason] >= REASON_RANK[reason]) return;
    byId.set(row.id, {
      id: row.id,
      label: assetLabel(row),
      serialNumber: row.serialNumber ?? null,
      equipmentType: row.equipmentType,
      siteName: row.site?.name ?? null,
      positionName: row.position?.name ?? null,
      manufacturer: row.manufacturer ?? null,
      model: row.model ?? null,
      lastTestedAt: null, // filled below in one batched query
      reason,
      confidence,
    });
  };

  try {
    const normIn = normalizeSerial(p.serialNumber);

    // ── Tier 1+2: serial match (exact + fuzzy) ────────────────────────────────
    // Fuzzy equality can't be expressed in SQL against a non-normalized column,
    // so we pull the account's active serialed assets and compare in memory.
    // Asset counts per account are bounded (hundreds–low thousands); the select
    // is tiny and the (accountId, archivedAt) index covers the scan.
    if (normIn) {
      const serialed = await prisma.asset.findMany({
        where: { accountId: p.accountId, archivedAt: null, serialNumber: { not: null } },
        select: CANDIDATE_SELECT,
        take: 5000,
      });
      const rawIn = String(p.serialNumber).trim().toLowerCase();
      for (const a of serialed) {
        const rawA = String(a.serialNumber).trim().toLowerCase();
        if (rawA === rawIn) {
          consider(a, 'serial_exact', 'high');
        } else if (normalizeSerial(a.serialNumber) === normIn) {
          // Short serials normalize-collide too easily ("I1" ≈ "11"); require
          // a little length before trusting a fuzzy-only hit as high.
          consider(a, 'serial_fuzzy', normIn.length >= 4 ? 'high' : 'medium');
        }
      }
    }

    // ── Tier 3+4: site / position / type fallback ─────────────────────────────
    // Always computed when we have a site + type (cheap, indexed) so a scan
    // with a missing/unreadable serial — or a serial that didn't match — still
    // surfaces the plausible existing device for the confirm step.
    if (p.siteId && p.equipmentType) {
      const sameSiteType = await prisma.asset.findMany({
        where: {
          accountId: p.accountId, archivedAt: null,
          siteId: p.siteId, equipmentType: p.equipmentType as any,
        },
        select: CANDIDATE_SELECT,
        take: 200,
      });
      for (const a of sameSiteType) {
        if (p.positionId && a.positionId === p.positionId) consider(a, 'site_position_type', 'medium');
        else consider(a, 'site_type', 'low');
      }
    }

    let candidates = Array.from(byId.values());
    if (candidates.length === 0) return { best: null, candidates: [] };

    // ── Batched "last tested" enrichment ──────────────────────────────────────
    // One groupBy for every candidate rather than N per-asset queries.
    try {
      const ids = candidates.map((c) => c.id);
      const woMax = await prisma.workOrder.groupBy({
        by: ['assetId'],
        where: { assetId: { in: ids }, status: 'COMPLETE', completedDate: { not: null } },
        _max: { completedDate: true },
      });
      const lastByAsset = new Map<string, Date>();
      for (const w of woMax as any[]) {
        if (w.assetId && w._max?.completedDate) lastByAsset.set(w.assetId, w._max.completedDate);
      }
      for (const c of candidates) c.lastTestedAt = lastByAsset.get(c.id) ?? null;
    } catch (e: any) {
      // Enrichment is non-essential — the confirm step still works without it.
      console.error('[assetIdentity] lastTested enrichment failed:', e?.message || e);
    }

    // Rank: reason strength, then confidence, then most-recently-tested.
    candidates.sort((a, b) => {
      if (REASON_RANK[b.reason] !== REASON_RANK[a.reason]) return REASON_RANK[b.reason] - REASON_RANK[a.reason];
      if (CONFIDENCE_RANK[b.confidence] !== CONFIDENCE_RANK[a.confidence]) return CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
      const at = a.lastTestedAt ? a.lastTestedAt.getTime() : 0;
      const bt = b.lastTestedAt ? b.lastTestedAt.getTime() : 0;
      return bt - at;
    });
    candidates = candidates.slice(0, limit);
    return { best: candidates[0] || null, candidates };
  } catch (err: any) {
    console.error('[assetIdentity] resolveAsset failed:', err?.message || err);
    return { best: null, candidates: [] };
  }
}

module.exports = { normalizeSerial, resolveAsset };

export {};
