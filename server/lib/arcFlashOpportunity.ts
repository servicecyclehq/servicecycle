/**
 * lib/arcFlashOpportunity.ts — C-13 revenue loop.
 *
 * A confirmed arc-flash ingest whose model MATERIALLY changed vs the prior
 * confirmed revision (arcFlashDrift.reStudyRecommended) means the stamped study
 * no longer reflects the field. ServiceCycle surfaces that as a sales signal:
 *   1. a QuoteRequest{ triggerType:'ARC_FLASH_STUDY' } for a representative asset, and
 *   2. a QUOTE_REQUEST_CREATED partner event routed to the account's owning rep
 *      (the same flywheel the manual quote /send path uses — partnerDigest +
 *      the fleet-dashboard partner inbox).
 *
 * SC never validates or stamps — "system of record, not system of analysis."
 * It only flags that a re-study is REQUIRED. A licensed PE decides and re-runs.
 *
 * Dependencies are injected so the whole decision + emit flow is unit-testable
 * with fakes (no DB): see __tests__/lib/arcFlashOpportunity.test.ts.
 */

// The QuoteRequest.driver enum has no exact "compliance re-study" value
// (down_now | suspected_failing | failed_inspection | planned_replacement |
// budgetary). The true reason is carried by triggerType='ARC_FLASH_STUDY' + the
// notes; driver is a secondary category hint. 'planned_replacement' is used
// deliberately because it implies a scheduled engineering action and — unlike
// 'down_now' — never sets emergencyMode, and — unlike 'failed_inspection' —
// makes no claim that the equipment itself failed (SC asserts a re-study is
// required, not that any asset failed). Overridable if Dustin wants a dedicated
// driver value (that would be an additive enum migration).
export const RESTUDY_DRIVER = 'planned_replacement';

export interface BusChangeLike { busName: string; change: 'added' | 'removed' | 'changed'; }
export interface DriftReportLike {
  hasPrior: boolean;
  reStudyRecommended: boolean;
  busChanges?: BusChangeLike[];
  summary?: string;
}

/**
 * Pure: choose the asset the re-study opportunity attaches to.
 * Prefer an asset behind a materially CHANGED (then ADDED) bus — that is the
 * reason for the re-study. A REMOVED bus won't exist in the current asset map,
 * and a duplicate-name-only change may not map either, so fall back to any
 * confirmed asset from this ingest so a real site-level change still routes to a
 * real asset. Returns null only when there is no asset to attach to.
 */
export function pickReStudyAsset(
  report: DriftReportLike | null | undefined,
  nameToAssetId: Map<string, string> | null | undefined
): { assetId: string; busName: string } | null {
  if (!report || !nameToAssetId || nameToAssetId.size === 0) return null;
  const rank: Record<string, number> = { changed: 0, added: 1, removed: 2 };
  const changes = [...(report.busChanges || [])].sort(
    (a, b) => (rank[a.change] ?? 9) - (rank[b.change] ?? 9)
  );
  for (const c of changes) {
    const id = nameToAssetId.get(c.busName);
    if (id) return { assetId: id, busName: c.busName };
  }
  // No changed bus maps to an asset — attach to the first confirmed asset.
  const first = nameToAssetId.entries().next().value as [string, string];
  return { assetId: first[1], busName: first[0] };
}

export interface ReStudyDeps {
  prisma: any;
  emitPartnerEvent: (accountId: string, eventType: string, payload: any, opts?: any) => Promise<void>;
  diffIngestRevisions: (prior: any, current: any) => DriftReportLike;
  busForDrift: (b: any) => any;
}
export interface ReStudyCtx {
  accountId: string;
  ingest: { id: string; siteId: string };
  buses: any[];
  nameToAssetId: Map<string, string>;
  userId: string;
}
export interface ReStudyResult {
  created: boolean;
  reason?: 'baseline' | 'no_material_change' | 'no_asset' | 'already_open';
  quoteRequestId?: string;
  assetId?: string;
  summary?: string;
}

/**
 * Compute drift vs the prior confirmed revision for this site and, when a
 * material change is detected, create the routed re-study opportunity. Idempotent
 * per site: skips if an open ARC_FLASH_STUDY quote already exists for the site.
 * Safe to call after the confirm transaction has committed; callers should still
 * wrap it so a failure here can never fail the confirm.
 */
export async function createReStudyOpportunity(deps: ReStudyDeps, ctx: ReStudyCtx): Promise<ReStudyResult> {
  const { prisma, emitPartnerEvent, diffIngestRevisions, busForDrift } = deps;
  const { accountId, ingest, buses, nameToAssetId, userId } = ctx;

  // Prior confirmed revision for this site = the most recent OTHER confirmed
  // ingest (this one was just flipped to 'confirmed', so it is the newest).
  const prior = await prisma.arcFlashIngest.findFirst({
    where: { accountId, siteId: ingest.siteId, status: 'confirmed', id: { not: ingest.id } },
    orderBy: { confirmedAt: 'desc' },
    select: { id: true, confirmedAt: true },
  });
  if (!prior) return { created: false, reason: 'baseline' };

  const priorBuses = await prisma.arcFlashIngestBus.findMany({
    where: { ingestId: prior.id },
    orderBy: { seq: 'asc' },
  });
  const report = diffIngestRevisions(
    { id: prior.id, confirmedAt: prior.confirmedAt, buses: priorBuses.map(busForDrift) },
    { buses: buses.map(busForDrift) }
  );
  if (!report.reStudyRecommended) return { created: false, reason: 'no_material_change' };

  const pick = pickReStudyAsset(report, nameToAssetId);
  if (!pick) return { created: false, reason: 'no_asset' };

  // Site-scoped dedup: one open re-study opportunity per site at a time.
  const existing = await prisma.quoteRequest.findFirst({
    where: {
      accountId,
      triggerType: 'ARC_FLASH_STUDY',
      status: { in: ['requested', 'quoted'] },
      asset: { siteId: ingest.siteId },
    },
    select: { id: true },
  });
  if (existing) return { created: false, reason: 'already_open' };

  const qr = await prisma.quoteRequest.create({
    data: {
      accountId,
      assetId: pick.assetId,
      requestedById: userId,
      driver: RESTUDY_DRIVER as any,
      timeline: 'within_30_days',
      status: 'requested',
      triggerType: 'ARC_FLASH_STUDY',
      emergencyMode: false,
      notes: `Auto-triggered: arc-flash environment change detected on confirm — ${report.summary ?? 'material change vs the prior confirmed revision; new study required.'}`,
    },
    select: { id: true },
  });

  // Route to the owning rep via the partner flywheel. dedupeKey scopes the
  // digest-window dedup so this crown-jewel signal is never collapsed into an
  // unrelated same-type (generic quote) event. Fire-and-forget — an emit failure
  // must not undo the created opportunity.
  await Promise.resolve(
    emitPartnerEvent(
      accountId,
      'QUOTE_REQUEST_CREATED',
      {
        quoteRequestId: qr.id,
        assetId: pick.assetId,
        assetName: pick.busName,
        triggerType: 'ARC_FLASH_STUDY',
        dedupeKey: 'ARC_FLASH_STUDY',
        siteId: ingest.siteId,
        reStudySummary: report.summary ?? null,
      },
      { dedupeKey: 'ARC_FLASH_STUDY' }
    )
  ).catch((e: any) => console.error('[arcFlashOpportunity] emit failed (non-fatal):', e && e.message));

  return { created: true, quoteRequestId: qr.id, assetId: pick.assetId, summary: report.summary };
}
