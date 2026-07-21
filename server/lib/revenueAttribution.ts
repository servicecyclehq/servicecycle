'use strict';

/**
 * revenueAttribution.ts -- Phase 2 revenue-attribution dashboard.
 *
 * Quantifies the closed loop ServiceCycle already records: a platform signal
 * (Path-to-100 alert / modernization / arc-flash / QEMW trigger) -> a
 * QuoteRequest -> an accepted quote -> an auto-created WorkOrder
 * (WorkOrder.quoteRequestId) -> completed work. This is the "revenue-bearing
 * digital twin" story an acquirer pays a premium for: it ties engagement to
 * service attach-rate and pipeline.
 *
 * It does NOT introduce any new pricing model. Dollar figures are ESTIMATES
 * derived from each asset's existing repairCostEstimate (the same field the
 * Maintenance Debt Ledger uses); quotes whose asset has no estimate are counted
 * as "unpriced" rather than guessed. Everything else is exact status counts.
 *
 *   buildRevenueAttribution(prisma, accountId, { windowDays? })
 *     -> { generatedAt, windowDays, funnel, conversionRates, attribution, value, byTrigger, recent, summary }
 *
 * Account-scoped throughout.
 */

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 365;

const TRIGGER_LABELS: Record<string, string> = {
  MODERNIZATION_EOL: 'Modernization (end-of-life)',
  ARC_FLASH_STUDY: 'Arc-flash study',
  QEMW_TRAINING: 'QEMW training',
  MANUAL: 'Manual / customer-submitted',
};

function assetLabel(a: any): string {
  if (!a) return 'Asset';
  const base = [a.manufacturer, a.model].filter(Boolean).join(' ');
  const serial = a.serialNumber ? ` #${a.serialNumber}` : '';
  return base ? base + serial : (a.equipmentType || 'Asset');
}

const round = (n: number) => Math.round(n);
function pct(n: number, d: number): number | null {
  if (!d || d <= 0) return null;
  return Math.round((n / d) * 1000) / 10;
}

async function buildRevenueAttribution(
  prisma: any,
  accountId: string,
  { windowDays = DEFAULT_WINDOW_DAYS }: { windowDays?: number } = {},
) {
  const now = new Date();
  const win = Math.min(1825, Math.max(30, Math.round(Number(windowDays) || DEFAULT_WINDOW_DAYS)));
  const windowStart = new Date(now.getTime() - win * DAY_MS);

  const quotes = await prisma.quoteRequest.findMany({
    where: { accountId, createdAt: { gte: windowStart } },
    select: {
      id: true, status: true, triggerType: true, createdAt: true, quotedAt: true,
      assetId: true,
      asset: { select: { manufacturer: true, model: true, serialNumber: true, equipmentType: true, repairCostEstimate: true } },
      workOrders: { select: { status: true, completedDate: true } },
    },
  });

  const funnel = { submitted: 0, quoted: 0, accepted: 0, converted: 0, completed: 0 };
  const attribution = { systemTriggered: 0, manual: 0, platformDrivenPct: null as number | null, completedFromAlert: 0, alertConversionShare: null as number | null };
  // CFO-8-14: the $ totals (realized/pipeline) only sum quotes whose asset has a
  // repairCostEstimate, while the funnel counts EVERY non-draft quote. To stop a
  // reader pairing "$X realized" with a funnel count drawn from a larger
  // population, we track the priced-vs-unpriced split with equal prominence:
  // pricedCompleted + unpricedCompleted === funnel.completed, and
  // pricedOpen + unpricedOpen === the open population behind `pipeline`.
  const value = { currency: 'USD', pipeline: 0, realized: 0, total: 0,
    pricedOpen: 0, unpricedOpen: 0, pricedCompleted: 0, unpricedCompleted: 0 };
  const byTrigger = new Map<string, any>();
  const completedRows: any[] = [];
  // SC-23: dedupe the priced opportunity $ by asset. A single asset's
  // repairCostEstimate is a fixed property, so summing it across multiple
  // quotes on the same asset would inflate the pipeline/realized opportunity $.
  // Only the $ sums are de-duplicated per asset; the funnel/priced COUNTS stay
  // per-quote (preserving pricedCompleted + unpricedCompleted === funnel.completed).
  const seenPipelineAsset = new Set();
  const seenRealizedAsset = new Set();

  for (const q of quotes) {
    const isDraft = q.status === 'draft';
    if (isDraft) continue; // drafts were never sent -- not part of the pipeline.

    const wos = q.workOrders || [];
    const hasWo = wos.length > 0;
    const hasCompleteWo = wos.some((w: any) => w.status === 'COMPLETE');
    const wasQuoted = !!q.quotedAt || ['quoted', 'accepted', 'declined'].includes(q.status);
    const isAccepted = q.status === 'accepted' || hasWo;
    const est = q.asset && q.asset.repairCostEstimate != null ? Number(q.asset.repairCostEstimate) : null;
    const isOpen = ['requested', 'quoted', 'accepted'].includes(q.status) && !hasCompleteWo;

    funnel.submitted += 1;
    if (wasQuoted) funnel.quoted += 1;
    if (isAccepted) funnel.accepted += 1;
    if (hasWo) funnel.converted += 1;
    if (hasCompleteWo) funnel.completed += 1;

    const triggered = !!q.triggerType;
    if (triggered) attribution.systemTriggered += 1; else attribution.manual += 1;
    if (hasCompleteWo && triggered) attribution.completedFromAlert += 1;

    if (hasCompleteWo) {
      if (est != null) value.pricedCompleted += 1; else value.unpricedCompleted += 1;
    } else if (isOpen) {
      if (est != null) {
        value.pricedOpen += 1;
        if (!(q.assetId && seenPipelineAsset.has(q.assetId))) { if (q.assetId) seenPipelineAsset.add(q.assetId); value.pipeline += est; }
      } else value.unpricedOpen += 1;
    }

    const key = q.triggerType || 'MANUAL';
    let t = byTrigger.get(key);
    if (!t) { t = { trigger: key, label: TRIGGER_LABELS[key] || key, count: 0, accepted: 0, completed: 0, realizedValue: 0 }; byTrigger.set(key, t); }
    t.count += 1;
    if (isAccepted) t.accepted += 1;
    if (hasCompleteWo) {
      t.completed += 1;
      if (est != null && !(q.assetId && seenRealizedAsset.has(q.assetId))) {
        if (q.assetId) seenRealizedAsset.add(q.assetId);
        value.realized += est;
        t.realizedValue += est;
      }
    }

    if (hasCompleteWo) {
      const completedDate = wos
        .filter((w: any) => w.status === 'COMPLETE' && w.completedDate)
        .map((w: any) => new Date(w.completedDate))
        .sort((a: Date, b: Date) => b.getTime() - a.getTime())[0] || null;
      completedRows.push({
        quoteId: q.id,
        assetId: q.assetId,
        assetLabel: assetLabel(q.asset),
        trigger: key,
        triggerLabel: TRIGGER_LABELS[key] || key,
        completedDate,
        value: est,
      });
    }
  }

  value.pipeline = round(value.pipeline);
  value.realized = round(value.realized);
  value.total = value.pipeline + value.realized;

  attribution.platformDrivenPct = pct(attribution.systemTriggered, funnel.submitted);
  attribution.alertConversionShare = pct(attribution.completedFromAlert, funnel.completed);

  const conversionRates = {
    quoteRate: pct(funnel.quoted, funnel.submitted),
    acceptRate: pct(funnel.accepted, funnel.quoted),
    completionRate: pct(funnel.completed, funnel.accepted),
    overallConversion: pct(funnel.completed, funnel.submitted),
  };

  const byTriggerArr = [...byTrigger.values()].map((t) => ({ ...t, realizedValue: round(t.realizedValue) }))
    .sort((a, b) => (b.completed - a.completed) || (b.count - a.count));

  completedRows.sort((a, b) => {
    const ad = a.completedDate ? a.completedDate.getTime() : 0;
    const bd = b.completedDate ? b.completedDate.getTime() : 0;
    return bd - ad;
  });

  return {
    generatedAt: now,
    windowDays: win,
    funnel,
    conversionRates,
    attribution,
    value,
    byTrigger: byTriggerArr,
    recent: completedRows.slice(0, 10),
    summary: {
      totalQuotes: funnel.submitted,
      clean: funnel.submitted === 0,
      // CFO-8-14: true when some completed/open quotes have NO priced asset, so
      // the realized/pipeline $ describe a SMALLER population than the funnel
      // counts. Consumers should show the priced-vs-unpriced split when set.
      hasUnpricedQuotes: (value.unpricedCompleted + value.unpricedOpen) > 0,
      pricedCompleted: value.pricedCompleted,
      unpricedCompleted: value.unpricedCompleted,
    },
  };
}

module.exports = { buildRevenueAttribution, TRIGGER_LABELS };

export {};
