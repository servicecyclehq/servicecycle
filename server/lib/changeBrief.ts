'use strict';

/**
 * changeBrief.ts — "What changed since last cycle" audit brief.
 *
 * A per-site structured diff + short narrative of everything that moved since
 * the previous compliance snapshot (the "last cycle"): assets added/removed,
 * maintenance completed, newly-overdue work, deficiencies opened/resolved
 * (condition shifts), and interval/policy changes. Pairs with the immutable
 * snapshot evidence and the customer digest.
 *
 * Anchor: the most recent kind='compliance' ComplianceSnapshot.createdAt is the
 * "since" point. Everything is then derived from LIVE data (createdAt /
 * archivedAt timestamps, deficiency open/resolve dates, schedule completion
 * dates, and the activity log) — no new tables, no snapshot internals required.
 *
 *   buildChangeBrief(prisma, accountId, { siteId? }) -> brief
 */

const POLICY_ACTIONS = ['emp_settings_updated', 'schedule_baselined'];
const CONDITION_ACTION = 'condition_changed';

function scheduleRate(current: number, overdue: number): number | null {
  const denom = current + overdue;
  return denom > 0 ? Math.round((current / denom) * 1000) / 10 : null;
}

async function resolveSite(prisma: any, accountId: string, siteId: string | null) {
  if (!siteId) return null;
  const site = await prisma.site.findFirst({ where: { id: siteId, accountId }, select: { id: true, name: true } });
  if (!site) { const e: any = new Error('Site not found.'); e.code = 'SITE_NOT_FOUND'; throw e; }
  return site;
}

async function buildChangeBrief(prisma: any, accountId: string, { siteId = null }: { siteId?: string | null } = {}) {
  const now = new Date();
  const site = await resolveSite(prisma, accountId, siteId);
  const assetScope: any = { archivedAt: null, inService: true, ...(siteId ? { siteId } : {}) };

  // Anchor = the two most recent compliance snapshots (latest = "since" point;
  // its stats give the prior compliance rate for the narrative).
  const snaps = await prisma.complianceSnapshot.findMany({
    where: { accountId, kind: 'compliance', ...(siteId ? { siteId } : {}) },
    orderBy: { createdAt: 'desc' }, take: 1,
    select: { id: true, createdAt: true, stats: true },
  });
  const prior = snaps[0] || null;
  const since: Date | null = prior ? prior.createdAt : null;

  // Current schedule-compliance rate (for the then/now delta).
  const [curCount, ovdCount] = await Promise.all([
    prisma.maintenanceSchedule.count({ where: { accountId, isActive: true, nextDueDate: { gte: now }, asset: assetScope } }),
    prisma.maintenanceSchedule.count({ where: { accountId, isActive: true, nextDueDate: { lt: now }, asset: assetScope } }),
  ]);
  const complianceNow = scheduleRate(curCount, ovdCount);
  const complianceThen = prior?.stats
    ? scheduleRate(Number(prior.stats.current ?? 0), Number(prior.stats.overdue ?? 0))
    : null;

  // With no prior snapshot there is nothing to diff against.
  if (!since) {
    return {
      generatedAt: now,
      scope: { siteId: site?.id ?? null, siteName: site?.name ?? null },
      hasPrior: false,
      since: null,
      sinceSnapshotId: null,
      complianceThen: null,
      complianceNow,
      totals: { assetsAdded: 0, assetsRemoved: 0, maintenanceCompleted: 0, newlyOverdue: 0, deficienciesOpened: 0, deficienciesResolved: 0, conditionChanges: 0, policyChanges: 0 },
      bySite: [],
      programChanges: 0,
      narrative: 'No prior compliance snapshot to compare against yet. Generate a snapshot to start tracking change-over-cycle.',
    };
  }

  // Pull the raw change signals since the anchor, each carrying its site.
  const siteSel = { asset: { select: { siteId: true, site: { select: { name: true } } } } };
  const [added, removed, completed, newlyOverdue, defsOpened, defsResolved, condLogs, policyLogs] = await Promise.all([
    prisma.asset.findMany({ where: { accountId, createdAt: { gte: since }, ...(siteId ? { siteId } : {}) }, select: { id: true, siteId: true, site: { select: { name: true } }, manufacturer: true, model: true, equipmentType: true, serialNumber: true } }),
    prisma.asset.findMany({ where: { accountId, archivedAt: { gte: since }, ...(siteId ? { siteId } : {}) }, select: { id: true, siteId: true, site: { select: { name: true } }, manufacturer: true, model: true, equipmentType: true, serialNumber: true } }),
    prisma.maintenanceSchedule.findMany({ where: { accountId, isActive: true, lastCompletedDate: { gte: since }, asset: assetScope }, select: siteSel }),
    prisma.maintenanceSchedule.findMany({ where: { accountId, isActive: true, nextDueDate: { gte: since, lt: now }, asset: assetScope }, select: siteSel }),
    prisma.deficiency.findMany({ where: { accountId, createdAt: { gte: since }, asset: assetScope }, select: { severity: true, ...siteSel } }),
    prisma.deficiency.findMany({ where: { accountId, resolvedAt: { gte: since }, asset: assetScope }, select: siteSel }),
    prisma.activityLog.findMany({ where: { accountId, action: CONDITION_ACTION, createdAt: { gte: since }, ...(siteId ? { asset: { siteId } } : {}) }, select: { asset: { select: { siteId: true, site: { select: { name: true } } } } } }),
    prisma.activityLog.findMany({ where: { accountId, action: { in: POLICY_ACTIONS }, createdAt: { gte: since } }, select: { action: true } }),
  ]);

  // Per-site accumulator.
  type SiteRow = { siteId: string | null; siteName: string; assetsAdded: number; assetsRemoved: number; maintenanceCompleted: number; newlyOverdue: number; deficienciesOpened: number; deficienciesResolved: number; conditionChanges: number };
  const bySite = new Map<string, SiteRow>();
  const key = (id: string | null) => id || '__unassigned__';
  const row = (id: string | null, name: string | null): SiteRow => {
    const k = key(id);
    let r = bySite.get(k);
    if (!r) { r = { siteId: id, siteName: name || 'Unassigned', assetsAdded: 0, assetsRemoved: 0, maintenanceCompleted: 0, newlyOverdue: 0, deficienciesOpened: 0, deficienciesResolved: 0, conditionChanges: 0 }; bySite.set(k, r); }
    return r;
  };

  for (const a of added) row(a.siteId, a.site?.name).assetsAdded += 1;
  for (const a of removed) row(a.siteId, a.site?.name).assetsRemoved += 1;
  for (const s of completed) { const a = s.asset; row(a?.siteId ?? null, a?.site?.name).maintenanceCompleted += 1; }
  for (const s of newlyOverdue) { const a = s.asset; row(a?.siteId ?? null, a?.site?.name).newlyOverdue += 1; }
  for (const d of defsOpened) { const a = d.asset; row(a?.siteId ?? null, a?.site?.name).deficienciesOpened += 1; }
  for (const d of defsResolved) { const a = d.asset; row(a?.siteId ?? null, a?.site?.name).deficienciesResolved += 1; }
  for (const l of condLogs) { const a = l.asset; if (a) row(a.siteId, a.site?.name).conditionChanges += 1; }

  // Per-site narrative line.
  function siteNarrative(r: SiteRow): string {
    const parts: string[] = [];
    if (r.assetsAdded) parts.push(`${r.assetsAdded} asset${r.assetsAdded === 1 ? '' : 's'} added`);
    if (r.assetsRemoved) parts.push(`${r.assetsRemoved} removed`);
    if (r.maintenanceCompleted) parts.push(`${r.maintenanceCompleted} task${r.maintenanceCompleted === 1 ? '' : 's'} serviced`);
    if (r.newlyOverdue) parts.push(`${r.newlyOverdue} went overdue`);
    if (r.deficienciesResolved) parts.push(`${r.deficienciesResolved} deficienc${r.deficienciesResolved === 1 ? 'y' : 'ies'} cleared`);
    if (r.deficienciesOpened) parts.push(`${r.deficienciesOpened} new deficienc${r.deficienciesOpened === 1 ? 'y' : 'ies'}`);
    if (r.conditionChanges) parts.push(`${r.conditionChanges} condition change${r.conditionChanges === 1 ? '' : 's'}`);
    return parts.length ? `${r.siteName}: ${parts.join(', ')}.` : `${r.siteName}: no changes.`;
  }

  const bySiteRows = [...bySite.values()]
    .map((r) => ({ ...r, narrative: siteNarrative(r) }))
    .sort((a, b) => {
      const score = (x: SiteRow) => x.assetsAdded + x.assetsRemoved + x.maintenanceCompleted + x.newlyOverdue + x.deficienciesOpened + x.deficienciesResolved + x.conditionChanges;
      return score(b) - score(a);
    });

  const totals = {
    assetsAdded: added.length,
    assetsRemoved: removed.length,
    maintenanceCompleted: completed.length,
    newlyOverdue: newlyOverdue.length,
    deficienciesOpened: defsOpened.length,
    deficienciesResolved: defsResolved.length,
    conditionChanges: condLogs.length,
    policyChanges: policyLogs.length,
  };

  // Account-level narrative.
  const sinceStr = since.toISOString().slice(0, 10);
  const trend = (complianceThen != null && complianceNow != null)
    ? (complianceNow > complianceThen ? `up from ${complianceThen}% to ${complianceNow}%`
      : complianceNow < complianceThen ? `down from ${complianceThen}% to ${complianceNow}%`
      : `holding at ${complianceNow}%`)
    : (complianceNow != null ? `${complianceNow}%` : 'n/a');
  const headline: string[] = [];
  if (totals.maintenanceCompleted) headline.push(`${totals.maintenanceCompleted} task${totals.maintenanceCompleted === 1 ? '' : 's'} serviced`);
  if (totals.deficienciesResolved) headline.push(`${totals.deficienciesResolved} deficienc${totals.deficienciesResolved === 1 ? 'y' : 'ies'} cleared`);
  if (totals.assetsAdded) headline.push(`${totals.assetsAdded} asset${totals.assetsAdded === 1 ? '' : 's'} added`);
  if (totals.newlyOverdue) headline.push(`${totals.newlyOverdue} went overdue`);
  if (totals.deficienciesOpened) headline.push(`${totals.deficienciesOpened} new deficienc${totals.deficienciesOpened === 1 ? 'y' : 'ies'}`);
  if (totals.policyChanges) headline.push(`${totals.policyChanges} program/interval change${totals.policyChanges === 1 ? '' : 's'}`);
  const narrative = `Since the last cycle (${sinceStr}), schedule compliance is ${trend}. `
    + (headline.length ? `${headline.join(', ')}.` : 'No material changes recorded.');

  return {
    generatedAt: now,
    scope: { siteId: site?.id ?? null, siteName: site?.name ?? null },
    hasPrior: true,
    since: since.toISOString(),
    sinceSnapshotId: prior.id,
    complianceThen,
    complianceNow,
    totals,
    bySite: bySiteRows,
    programChanges: totals.policyChanges,
    narrative,
  };
}

module.exports = { buildChangeBrief };

export {};
