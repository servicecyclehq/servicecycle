'use strict';

/**
 * lib/complianceReport.js
 * -----------------------
 * Data assembly for per-standard compliance reporting and audit snapshots.
 *
 * Pure-ish by design: `prisma` is injected as the first argument so these
 * functions stay testable and carry zero req/res awareness. EVERY query in
 * this file is scoped by accountId — that is the hard tenant boundary.
 *
 * Status taxonomy (per schedule):
 *   current      — isActive, nextDueDate >= now
 *   overdue      — isActive, nextDueDate < now
 *   unbaselined  — isActive, nextDueDate IS NULL (no first completion or
 *                  manual anchor yet — "not yet baselined"; tracked
 *                  separately and EXCLUDED from the compliance rate so an
 *                  account mid-onboarding isn't reported as non-compliant)
 *   inactive     — isActive = false (shown in the full report for
 *                  completeness, excluded from all summary math)
 *
 * complianceRate = current / (current + overdue) as a percentage, one
 * decimal. Null when there are no rated (baselined + active) schedules.
 *
 * Grouping: schedules group by their task definition's governing standard
 * CODE (e.g. "NFPA 70B"), merging editions — old task-definition rows may
 * still point at a superseded edition row while new ones point at the
 * current edition; an adjuster cares about the mandate, not our seed
 * history. The representative `standard` object prefers the non-superseded
 * edition. Task definitions with standardId = NULL (account-custom tasks)
 * collapse into one synthetic entry with code 'Account-defined'.
 */

const ACCOUNT_DEFINED_CODE = 'Account-defined';

// ── Shared helpers ────────────────────────────────────────────────────────────

function classifyStatus(schedule, now) {
  if (!schedule.isActive) return 'inactive';
  if (!schedule.nextDueDate) return 'unbaselined';
  return schedule.nextDueDate < now ? 'overdue' : 'current';
}

/**
 * Compute summary counts over a schedule list. Inactive schedules are
 * excluded from every count (callers pass active-only lists, but the guard
 * stays as belt-and-suspenders).
 */
function summarizeSchedules(schedules, now) {
  const assetIds = new Set();
  let current = 0;
  let overdue = 0;
  let unbaselined = 0;
  let nextDue = null;

  for (const s of schedules) {
    if (!s.isActive) continue;
    assetIds.add(s.assetId);
    if (!s.nextDueDate) { unbaselined += 1; continue; }
    if (s.nextDueDate < now) {
      overdue += 1;
    } else {
      current += 1;
      if (!nextDue || s.nextDueDate < nextDue) nextDue = s.nextDueDate;
    }
  }

  const rated = current + overdue;
  return {
    assetCount:       assetIds.size,
    scheduleCount:    current + overdue + unbaselined,
    currentCount:     current,
    overdueCount:     overdue,
    unbaselinedCount: unbaselined,
    complianceRate:   rated > 0 ? Math.round((current / rated) * 1000) / 10 : null,
    nextDue, // earliest upcoming due date (Date | null)
  };
}

/**
 * Pick the representative edition row for a standard code: prefer the
 * non-superseded edition, fall back to the lexically latest edition string.
 */
function pickRepresentativeStandard(rows) {
  if (!rows || rows.length === 0) return null;
  const live = rows.filter((r) => !r.supersededAt);
  const pool = live.length > 0 ? live : rows;
  return pool.slice().sort((a, b) => String(b.edition).localeCompare(String(a.edition)))[0];
}

function toStandardShape(std) {
  if (!std) {
    // Synthetic bucket for tenant-defined task definitions (standardId NULL).
    return {
      id:         null,
      code:       ACCOUNT_DEFINED_CODE,
      edition:    null,
      title:      'Account-defined maintenance tasks',
      keyMandate: null,
    };
  }
  return {
    id:         std.id,
    code:       std.code,
    edition:    std.edition,
    title:      std.title,
    keyMandate: std.keyMandate,
  };
}

/**
 * Resolve and validate an optional siteId against the account. Throws a
 * coded error (err.code = 'SITE_NOT_FOUND') when the site doesn't exist or
 * belongs to another tenant — the route maps that to a 404 so cross-account
 * probing is indistinguishable from a missing row.
 */
async function resolveSite(prisma, accountId, siteId) {
  if (!siteId) return null;
  const site = await prisma.site.findFirst({
    where:  { id: siteId, accountId },
    select: { id: true, name: true },
  });
  if (!site) {
    const err: any = new Error('Site not found.');
    err.code = 'SITE_NOT_FOUND';
    throw err;
  }
  return site;
}

// ── buildStandardsSummary ─────────────────────────────────────────────────────

/**
 * One summary entry per ComplianceStandard (by code) that has at least one
 * task definition with active schedules in this account, plus a synthetic
 * 'Account-defined' entry for tenant-custom task definitions.
 *
 * Archived assets are excluded — their schedules are historical context,
 * not live compliance posture.
 *
 * @returns Array<{ standard, assetCount, scheduleCount, currentCount,
 *                  overdueCount, unbaselinedCount, complianceRate, nextDue }>
 */
async function buildStandardsSummary(prisma, accountId, { siteId = null } = {} as any) {
  await resolveSite(prisma, accountId, siteId); // validates tenant ownership

  const schedules = await prisma.maintenanceSchedule.findMany({
    where: {
      accountId,
      isActive: true,
      asset: { archivedAt: null, ...(siteId ? { siteId } : {}) },
    },
    select: {
      id:          true,
      assetId:     true,
      isActive:    true,
      nextDueDate: true,
      taskDefinition: {
        select: {
          id: true,
          standard: {
            select: {
              id: true, code: true, edition: true, title: true,
              keyMandate: true, supersededAt: true,
            },
          },
        },
      },
    },
  });

  const now = new Date();

  // Group by standard code; merge editions under one entry.
  const groups = new Map(); // code -> { standardRows: Map<id,row>, schedules: [] }
  for (const s of schedules) {
    const std  = s.taskDefinition && s.taskDefinition.standard;
    const code = std ? std.code : ACCOUNT_DEFINED_CODE;
    let g = groups.get(code);
    if (!g) { g = { standardRows: new Map(), schedules: [] }; groups.set(code, g); }
    if (std) g.standardRows.set(std.id, std);
    g.schedules.push(s);
  }

  const out = [];
  for (const [code, g] of groups) {
    const std = code === ACCOUNT_DEFINED_CODE
      ? null
      : pickRepresentativeStandard([...g.standardRows.values()]);
    out.push({
      standard: toStandardShape(std),
      ...summarizeSchedules(g.schedules, now),
    });
  }

  // Alphabetical by code; the synthetic account-defined bucket always last.
  out.sort((a, b) => {
    if (a.standard.code === ACCOUNT_DEFINED_CODE) return 1;
    if (b.standard.code === ACCOUNT_DEFINED_CODE) return -1;
    return a.standard.code.localeCompare(b.standard.code);
  });
  return out;
}

// ── buildStandardReport ───────────────────────────────────────────────────────

const STATUS_RANK = { overdue: 0, current: 1, unbaselined: 2, inactive: 3 };

/**
 * Full evidence report for ONE standard (by code, case-insensitive) or for
 * the synthetic 'account-defined' bucket.
 *
 * Throws coded errors:
 *   err.code = 'SITE_NOT_FOUND'      — siteId missing / cross-tenant
 *   err.code = 'STANDARD_NOT_FOUND'  — no ComplianceStandard with that code
 *
 * @returns { standard, generatedAt, scope, summary, rows, openDeficiencies,
 *            openDeficienciesNote }
 */
async function buildStandardReport(prisma, accountId, { standardCode, siteId = null } = {} as any) {
  const site = await resolveSite(prisma, accountId, siteId);
  const now  = new Date();

  const isAccountDefined =
    String(standardCode || '').trim().toLowerCase() === ACCOUNT_DEFINED_CODE.toLowerCase();

  let standardShape;
  let taskDefinitionFilter;
  if (isAccountDefined) {
    standardShape        = toStandardShape(null);
    taskDefinitionFilter = { standardId: null };
  } else {
    // ComplianceStandard is global (no accountId) — match all editions of
    // the code, case-insensitively, so 'nfpa 70b' resolves too.
    const standardRows = await prisma.complianceStandard.findMany({
      where: { code: { equals: String(standardCode || '').trim(), mode: 'insensitive' } },
      select: {
        id: true, code: true, edition: true, title: true,
        keyMandate: true, supersededAt: true,
      },
    });
    if (standardRows.length === 0) {
      const err: any = new Error('Standard not found.');
      err.code = 'STANDARD_NOT_FOUND';
      throw err;
    }
    standardShape        = toStandardShape(pickRepresentativeStandard(standardRows));
    taskDefinitionFilter = { standardId: { in: standardRows.map((r) => r.id) } };
  }

  // All schedules under this standard — including inactive ones (shown in
  // the report rows for completeness; summary math excludes them).
  const schedules = await prisma.maintenanceSchedule.findMany({
    where: {
      accountId,
      taskDefinition: taskDefinitionFilter,
      asset: { archivedAt: null, ...(siteId ? { siteId } : {}) },
    },
    select: {
      id:                true,
      assetId:           true,
      isActive:          true,
      lastCompletedDate: true,
      nextDueDate:       true,
      taskDefinition: {
        select: { taskName: true, taskCode: true, standardRef: true, requiresOutage: true },
      },
      asset: {
        select: {
          id: true, equipmentType: true, manufacturer: true, model: true,
          serialNumber: true, governingCondition: true,
          site: { select: { name: true } },
        },
      },
      // Latest completed work order = the most recent evidence for this
      // (asset, task) pairing.
      workOrders: {
        where:   { status: 'COMPLETE' },
        orderBy: { completedDate: 'desc' },
        take:    1,
        select:  { id: true, completedDate: true, netaDecal: true, asLeftCondition: true },
      },
    },
  });

  const rows = schedules.map((s) => {
    const status = classifyStatus(s, now);
    const wo     = s.workOrders && s.workOrders.length > 0 ? s.workOrders[0] : null;
    return {
      asset: {
        id:                 s.asset.id,
        equipmentType:      s.asset.equipmentType,
        manufacturer:       s.asset.manufacturer,
        model:              s.asset.model,
        serialNumber:       s.asset.serialNumber,
        siteName:           s.asset.site ? s.asset.site.name : null,
        governingCondition: s.asset.governingCondition,
      },
      task: {
        taskName:       s.taskDefinition.taskName,
        taskCode:       s.taskDefinition.taskCode,
        standardRef:    s.taskDefinition.standardRef,
        requiresOutage: s.taskDefinition.requiresOutage,
      },
      schedule: {
        id:                s.id,
        lastCompletedDate: s.lastCompletedDate,
        nextDueDate:       s.nextDueDate,
        status,
      },
      latestWorkOrder: wo
        ? {
            id:              wo.id,
            completedDate:   wo.completedDate,
            netaDecal:       wo.netaDecal,
            asLeftCondition: wo.asLeftCondition,
          }
        : null,
    };
  });

  // Sort: overdue first, then by nextDueDate ascending (nulls last within
  // each status group), unbaselined and inactive trailing.
  rows.sort((a, b) => {
    const rank = STATUS_RANK[a.schedule.status] - STATUS_RANK[b.schedule.status];
    if (rank !== 0) return rank;
    const ad = a.schedule.nextDueDate ? a.schedule.nextDueDate.getTime() : Infinity;
    const bd = b.schedule.nextDueDate ? b.schedule.nextDueDate.getTime() : Infinity;
    return ad - bd;
  });

  // Open deficiencies on the ASSETS that carry schedules under this
  // standard. Deficiencies are asset-level findings — they are NOT
  // attributed to the standard itself (a deficiency found during an IR scan
  // says nothing about which mandate it violates); the `attribution` field
  // and the note below make that explicit for the reader.
  const assetIds = [...new Set(schedules.map((s) => s.assetId))];
  const openDeficiencies = assetIds.length === 0 ? [] : (await prisma.deficiency.findMany({
    where: { accountId, resolvedAt: null, assetId: { in: assetIds } },
    // Enum order is IMMEDIATE, RECOMMENDED, ADVISORY — asc puts the
    // safety-critical findings first.
    orderBy: [{ severity: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true, severity: true, description: true, correctiveAction: true,
      createdAt: true, workOrderId: true,
      asset: {
        select: {
          id: true, equipmentType: true, manufacturer: true, model: true,
          serialNumber: true, site: { select: { name: true } },
        },
      },
    },
  })).map((d) => ({
    id:               d.id,
    severity:         d.severity,
    description:      d.description,
    correctiveAction: d.correctiveAction,
    createdAt:        d.createdAt,
    workOrderId:      d.workOrderId,
    attribution:      'asset-level', // finding on the asset, not the standard
    asset: {
      id:            d.asset.id,
      equipmentType: d.asset.equipmentType,
      manufacturer:  d.asset.manufacturer,
      model:         d.asset.model,
      serialNumber:  d.asset.serialNumber,
      siteName:      d.asset.site ? d.asset.site.name : null,
    },
  }));

  return {
    standard:    standardShape,
    generatedAt: now,
    scope: {
      siteId:   site ? site.id : null,
      siteName: site ? site.name : null,
    },
    summary: summarizeSchedules(schedules.filter((s) => s.isActive), now),
    rows,
    openDeficiencies,
    openDeficienciesNote:
      'Open deficiencies listed here are asset-level findings on equipment ' +
      'that carries maintenance schedules under this standard. They are not ' +
      'attributed to the standard itself.',
  };
}

module.exports = {
  buildStandardsSummary,
  buildStandardReport,
  ACCOUNT_DEFINED_CODE,
};

export {};
