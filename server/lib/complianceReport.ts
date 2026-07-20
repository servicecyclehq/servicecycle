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
  // CFO-8-10: `complianceRate` is the SCHEDULE-compliance basis — current /
  // (current + overdue) — which by design EXCLUDES unbaselined schedules (active
  // schedules with no nextDueDate yet) from the denominator. That flatters an
  // account mid-onboarding (200 schedules applied, 2 baselined-and-current reads
  // 100%). We keep that field (many consumers + the in-app dashboard rely on it)
  // but now also expose, with an explicit basis label, the rate that folds
  // unbaselined INTO the denominator so an insurer/board can read the honest
  // version. `complianceBasis` documents exactly what `complianceRate` measures.
  const ratedWithUnbaselined = current + overdue + unbaselined;
  return {
    assetCount:       assetIds.size,
    scheduleCount:    current + overdue + unbaselined,
    currentCount:     current,
    overdueCount:     overdue,
    unbaselinedCount: unbaselined,
    complianceRate:   rated > 0 ? Math.round((current / rated) * 1000) / 10 : null,
    complianceBasis:  'schedule-compliance (current / current+overdue); excludes unbaselined',
    // Honest blended schedule rate: unbaselined counted as not-yet-compliant.
    complianceRateInclUnbaselined: ratedWithUnbaselined > 0 ? Math.round((current / ratedWithUnbaselined) * 1000) / 10 : null,
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
/**
 * [as-of | Forensics P2] Latest captured compliance state per schedule at or before
 * asOf, from schedule_state_history. Returns Map<scheduleId, {nextDueDate, isActive}>.
 * A schedule absent from the map did not exist as of asOf. DISTINCT ON uses the
 * (accountId, scheduleId, changedAt) index.
 */
async function asOfScheduleState(prisma, accountId, asOf) {
  const rows: any[] = await prisma.$queryRawUnsafe('SELECT DISTINCT ON ("scheduleId") "scheduleId", "nextDueDate", "isActive" FROM "schedule_state_history" WHERE "accountId" = $1 AND "changedAt" <= $2 ORDER BY "scheduleId", "changedAt" DESC', accountId, asOf);
  const m = new Map();
  for (const r of rows) m.set(r.scheduleId, { nextDueDate: r.nextDueDate, isActive: r.isActive });
  return m;
}
async function buildStandardsSummary(prisma, accountId, { siteId = null, asOf = null } = {} as any) {
  await resolveSite(prisma, accountId, siteId); // validates tenant ownership

  let schedules = await prisma.maintenanceSchedule.findMany({
    where: {
      accountId,
      // as-of: don't filter on CURRENT isActive; the as-of value is applied after load.
      ...(asOf ? {} : { isActive: true }),
      asset: { archivedAt: null, inService: true, ...(siteId ? { siteId } : {}) },
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

  const now = asOf || new Date();

  // [as-of reconstruction | Forensics P2] Override each schedule's mutable compliance
  // state (nextDueDate / isActive) with its value as of asOf, and drop schedules that did
  // not exist at asOf. Relations (standard) come from the live row; asset-archive state is
  // not reconstructed (documented MVP bound). The default (no asOf) path is unchanged.
  if (asOf) {
    const stateMap = await asOfScheduleState(prisma, accountId, asOf);
    schedules = schedules
      .filter((s) => stateMap.has(s.id))
      .map((s) => { const st = stateMap.get(s.id); return { ...s, nextDueDate: st.nextDueDate, isActive: st.isActive }; });
  }

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
      asset: { archivedAt: null, inService: true, ...(siteId ? { siteId } : {}) },
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

  // #29 §7.4: IR thermography drill-down. Only 70B mandates IR, so this costs
  // nothing on other standards — buildIrThermographySection returns null.
  const irThermography = await buildIrThermographySection(prisma, accountId, assetIds, standardShape, now);

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
    irThermography,
  };
}

/**
 * #29 §7.4 — the IR thermography drill-down for NFPA 70B.
 *
 * Before this existed, the compliance-by-standard report could say an asset's
 * IR task was "current" while showing nothing about the scan itself: no scan
 * date, no ΔT, no findings. This adds, per asset carrying a 70B schedule, the
 * most recent survey (last-scan date + the conditions it was taken under) and
 * its open findings.
 *
 * Above-threshold findings ALSO appear in `openDeficiencies` (they generate a
 * Deficiency). `deficiencyId` is carried here so the client can cross-link the
 * two rather than double-count them. The genuinely new information is the
 * below-threshold findings (severity null), which the old free-text ingest
 * discarded entirely.
 *
 * Returns null for any standard other than 70B.
 */
async function buildIrThermographySection(prisma, accountId, assetIds, standardShape, now) {
  const code = String((standardShape && standardShape.code) || '').trim().toLowerCase();
  if (code !== 'nfpa 70b') return null;
  if (!assetIds || assetIds.length === 0) {
    return { assets: [], findings: [], summary: { scanned: 0, neverScanned: 0, openFindings: 0 } };
  }

  const [surveys, findings] = await Promise.all([
    // Newest-first; we keep the first survey seen per asset.
    prisma.thermographySurvey.findMany({
      where:   { accountId, assetId: { in: assetIds } },
      orderBy: { surveyDate: 'desc' },
      select: {
        id: true, assetId: true, surveyDate: true, thermographerName: true,
        thermographerQual: true, cameraMake: true, cameraModel: true,
        ambientTempC: true, humidityPct: true, emissivity: true,
        reflectedTempC: true, loadPercent: true, sourceDocumentId: true,
      },
    }),
    prisma.thermographyFinding.findMany({
      where:   { accountId, resolvedAt: null, assetId: { in: assetIds } },
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true, assetId: true, surveyId: true, component: true, deltaT: true,
        referenceType: true, referenceDeltaT: true, loadPercent: true,
        severity: true, severityLabel: true, correctiveAction: true,
        deficiencyId: true, createdAt: true,
      },
    }),
  ]);

  const latestByAsset = new Map();
  for (const s of surveys) if (!latestByAsset.has(s.assetId)) latestByAsset.set(s.assetId, s);

  const openByAsset = new Map();
  for (const f of findings) openByAsset.set(f.assetId, (openByAsset.get(f.assetId) || 0) + 1);

  const assetRows = assetIds.map((id) => {
    const s = latestByAsset.get(id) || null;
    return {
      assetId:        id,
      lastScanDate:   s ? s.surveyDate : null,
      lastSurveyId:   s ? s.id : null,
      hasEvidence:    Boolean(s && s.sourceDocumentId),
      openFindings:   openByAsset.get(id) || 0,
      conditions: s ? {
        thermographerName: s.thermographerName,
        thermographerQual: s.thermographerQual,
        cameraMake:        s.cameraMake,
        cameraModel:       s.cameraModel,
        ambientTempC:      decNum(s.ambientTempC),
        humidityPct:       decNum(s.humidityPct),
        emissivity:        decNum(s.emissivity),
        reflectedTempC:    decNum(s.reflectedTempC),
        loadPercent:       decNum(s.loadPercent),
      } : null,
    };
  });

  return {
    assets: assetRows,
    findings: findings.map((f) => ({
      id:               f.id,
      assetId:          f.assetId,
      surveyId:         f.surveyId,
      component:        f.component,
      deltaT:           decNum(f.deltaT),
      referenceType:    f.referenceType,
      referenceDeltaT:  decNum(f.referenceDeltaT),
      loadPercent:      decNum(f.loadPercent),
      severity:         f.severity,          // null = below NETA threshold
      severityLabel:    f.severityLabel,
      correctiveAction: f.correctiveAction,
      // Set when this finding also produced a Deficiency listed above — the
      // client cross-links instead of showing the same hot spot twice.
      deficiencyId:     f.deficiencyId,
      createdAt:        f.createdAt,
    })),
    summary: {
      scanned:      assetRows.filter((a) => a.lastScanDate).length,
      neverScanned: assetRows.filter((a) => !a.lastScanDate).length,
      openFindings: findings.length,
    },
    note:
      'IR findings above the NETA Table 100.18 threshold also appear as open ' +
      'deficiencies above; they are cross-linked, not duplicated. Findings with ' +
      'no severity are below threshold and are retained for trending.',
  };
}

/** Prisma Decimal → number (JSON would otherwise render it as a string). */
function decNum(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── buildOverdueReport ────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const SEVERITY_ORDER = ['IMMEDIATE', 'RECOMMENDED', 'ADVISORY'];

/**
 * Cross-standard "what is overdue right now" report — the punch list an
 * adjuster or maintenance supervisor works through, account-wide or one site.
 *
 * Archived assets are excluded (historical context, not live posture), and
 * only ACTIVE schedules count — same posture rules as the summary above.
 *
 * Throws err.code = 'SITE_NOT_FOUND' for a missing / cross-tenant siteId.
 *
 * @returns {
 *   generatedAt, scope: { siteId, siteName },
 *   overdueSchedules: [{ asset { id, equipmentType, manufacturer, model,
 *                                serialNumber, site, governingCondition },
 *                        task { taskName, standardRef },
 *                        nextDueDate, daysOverdue }],   // most-overdue first
 *   openDeficiencies: [{ severity, items: [{ id, asset, description,
 *                                            ageDays, workOrderId }] }],
 *   summary: { overdueScheduleCount, openDeficiencyCount,
 *              deficiencyBySeverity: { IMMEDIATE, RECOMMENDED, ADVISORY } }
 * }
 */
async function buildOverdueReport(prisma, accountId, { siteId = null } = {} as any) {
  const site = await resolveSite(prisma, accountId, siteId);
  const now  = new Date();

  const assetScope = { archivedAt: null, inService: true, ...(siteId ? { siteId } : {}) };

  const [schedules, deficiencies] = await Promise.all([
    prisma.maintenanceSchedule.findMany({
      where: {
        accountId,
        isActive:    true,
        nextDueDate: { lt: now },
        asset:       assetScope,
      },
      // nextDueDate ascending = most-overdue first.
      orderBy: { nextDueDate: 'asc' },
      select: {
        nextDueDate: true,
        taskDefinition: { select: { taskName: true, standardRef: true } },
        asset: {
          select: {
            id: true, equipmentType: true, manufacturer: true, model: true,
            serialNumber: true, governingCondition: true,
            site: { select: { id: true, name: true } },
          },
        },
      },
    }),
    prisma.deficiency.findMany({
      where: { accountId, resolvedAt: null, asset: assetScope },
      // Enum order IMMEDIATE → ADVISORY; oldest findings first within a tier.
      orderBy: [{ severity: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true, severity: true, description: true, createdAt: true,
        workOrderId: true,
        asset: {
          select: {
            id: true, equipmentType: true, manufacturer: true, model: true,
            serialNumber: true,
            site: { select: { id: true, name: true } },
          },
        },
      },
    }),
  ]);

  const assetShape = (a) => ({
    id:            a.id,
    equipmentType: a.equipmentType,
    manufacturer:  a.manufacturer,
    model:         a.model,
    serialNumber:  a.serialNumber,
    site:          a.site ? { id: a.site.id, name: a.site.name } : null,
  });

  const overdueSchedules = schedules.map((s) => ({
    asset: {
      ...assetShape(s.asset),
      governingCondition: s.asset.governingCondition,
    },
    task: {
      taskName:    s.taskDefinition.taskName,
      standardRef: s.taskDefinition.standardRef,
    },
    nextDueDate: s.nextDueDate,
    daysOverdue: Math.floor((now.getTime() - s.nextDueDate.getTime()) / DAY_MS),
  }));

  // Group open deficiencies by severity. All three tiers always present (in
  // fixed IMMEDIATE → ADVISORY order, empty items arrays included) so the
  // client renders a stable section list without existence checks.
  const itemsBySeverity = new Map(SEVERITY_ORDER.map((sev) => [sev, []]));
  for (const d of deficiencies) {
    const bucket: any = itemsBySeverity.get(d.severity);
    if (!bucket) continue; // unreachable — enum is closed
    bucket.push({
      id:          d.id,
      asset:       assetShape(d.asset),
      description: d.description,
      ageDays:     Math.floor((now.getTime() - d.createdAt.getTime()) / DAY_MS),
      workOrderId: d.workOrderId,
    });
  }
  const openDeficiencies = SEVERITY_ORDER.map((severity) => ({
    severity,
    items: itemsBySeverity.get(severity),
  }));

  const deficiencyBySeverity: any = {};
  for (const { severity, items } of openDeficiencies) {
    deficiencyBySeverity[severity] = (items as any[]).length;
  }

  return {
    generatedAt: now,
    scope: {
      siteId:   site ? site.id : null,
      siteName: site ? site.name : null,
    },
    overdueSchedules,
    openDeficiencies,
    summary: {
      overdueScheduleCount: overdueSchedules.length,
      openDeficiencyCount:  deficiencies.length,
      deficiencyBySeverity,
    },
  };
}

// ── buildComplianceGap (gem N2 — "Path to 100%") ──────────────────────────────

/** Minimal asset display label (mirrors client assetLabel). */
function gapAssetLabel(a) {
  const base = [a.manufacturer, a.model].filter(Boolean).join(' ');
  const serial = a.serialNumber ? ` #${a.serialNumber}` : '';
  return base ? base + serial : (a.equipmentType || 'Asset');
}

/**
 * The honest compliance picture + the ranked to-do list that closes it.
 *
 * The headline complianceRate (current / (current + overdue)) flatters: it
 * ignores schedules that were never baselined AND assets that carry no
 * schedule at all (so a facility with one current schedule reads 100% while
 * 40 transformers sit untracked). This function exposes BOTH the schedule
 * compliance rate and an asset coverage rate, blends them into a single
 * honest `overallRate`, and returns the exact actions — each tagged with the
 * points it recovers — that walk the account to 100%.
 *
 * Obligation model: D = current + overdue + unbaselined + uncoveredAssets.
 *   overallRate = current / D.   Each unmet obligation is worth 100/D points;
 *   fixing it (complete overdue work / baseline a schedule / apply a template
 *   to an uncovered asset) recovers exactly that many points, so clearing the
 *   whole list lands on 100%.
 *
 * @returns { generatedAt, scope, compliance, coverage, overallRate,
 *            pointsToFull, actions[], summary }
 */
async function buildComplianceGap(prisma, accountId, { siteId = null, limit = 50 } = {} as any) {
  const site = await resolveSite(prisma, accountId, siteId);
  const now  = new Date();
  const assetScope = { archivedAt: null, inService: true, ...(siteId ? { siteId } : {}) };

  const [schedules, uncoveredAssets, totalAssets, empSettingRows] = await Promise.all([
    // Active schedules (current / overdue / unbaselined) on live assets.
    prisma.maintenanceSchedule.findMany({
      where: { accountId, isActive: true, asset: assetScope },
      select: {
        id: true, nextDueDate: true, assetId: true,
        taskDefinition: { select: { taskName: true, standardRef: true } },
        asset: {
          select: {
            id: true, equipmentType: true, manufacturer: true, model: true,
            serialNumber: true, criticalityScore: true, governingCondition: true,
            site: { select: { id: true, name: true } },
          },
        },
      },
    }),
    // In-service, non-archived assets with ZERO active schedules — invisible
    // to the per-standard math entirely. The credibility hole.
    prisma.asset.findMany({
      where: { accountId, ...assetScope, schedules: { none: { isActive: true } } },
      select: {
        id: true, equipmentType: true, manufacturer: true, model: true,
        serialNumber: true, criticalityScore: true,
        site: { select: { id: true, name: true } },
      },
    }),
    prisma.asset.count({ where: { accountId, ...assetScope } }),
    // EMP §4.2 program-level settings (account-wide; only surfaced on the
    // whole-account view, not a single-site filter — the EMP is one per account).
    siteId ? Promise.resolve([]) : prisma.accountSetting.findMany({
      where: { accountId, key: { in: ['EMP_COORDINATOR_USER_ID', 'EMP_LAST_REVIEWED_AT'] } },
      select: { key: true, value: true },
    }),
  ]);

  // ── EMP §4.2 program gaps (NFPA 70B) ──────────────────────────────────────
  // Two literal §4.2 requirements that live at the program level rather than on
  // any one asset: a named EMP coordinator, and a periodic program review whose
  // interval cannot exceed five years. Surfaced as one-click gap items on the
  // whole-account Path-to-100 (skipped for a single-site filter). Folded into
  // the obligation denominator below so "clear the list → 100%" still holds.
  const empSettings: any = {};
  for (const r of (empSettingRows || [])) empSettings[r.key] = r.value;

  const empGaps = [];
  if (!siteId) {
    // Coordinator: missing, blank, or pointing at a user no longer on the account.
    let coordinatorOk = false;
    if (empSettings.EMP_COORDINATOR_USER_ID) {
      const coord = await prisma.user.findFirst({
        where:  { id: empSettings.EMP_COORDINATOR_USER_ID, accountId },
        select: { id: true },
      });
      coordinatorOk = !!coord;
    }
    if (!coordinatorOk) {
      empGaps.push({
        kind: 'emp_coordinator',
        title: 'No EMP coordinator named — required by NFPA 70B §4.2',
        standardRef: 'NFPA 70B §4.2',
        action: { type: 'emp_settings', field: 'coordinator' },
        sortKey: [-1, 0, 0],
      });
    }

    // Program review: never reviewed, overdue, or due within 180 days (5-yr max).
    let lastReviewedAt = null;
    if (empSettings.EMP_LAST_REVIEWED_AT) {
      const d = new Date(empSettings.EMP_LAST_REVIEWED_AT);
      if (!Number.isNaN(d.getTime())) lastReviewedAt = d;
    }
    if (!lastReviewedAt) {
      empGaps.push({
        kind: 'emp_review',
        title: 'No EMP program review on record — NFPA 70B §4.2 requires periodic review (5-year max)',
        standardRef: 'NFPA 70B §4.2',
        action: { type: 'emp_settings', field: 'lastReviewedAt' },
        sortKey: [-1, 0, 1],
      });
    } else {
      const nextReviewDue = new Date(lastReviewedAt);
      nextReviewDue.setUTCFullYear(nextReviewDue.getUTCFullYear() + 5);
      const daysToReview = Math.round((nextReviewDue.getTime() - now.getTime()) / DAY_MS);
      if (daysToReview < 0) {
        empGaps.push({
          kind: 'emp_review',
          title: `EMP program review overdue by ${-daysToReview}d — NFPA 70B §4.2 (5-year max)`,
          standardRef: 'NFPA 70B §4.2',
          action: { type: 'emp_settings', field: 'lastReviewedAt' },
          sortKey: [-1, 0, 1],
        });
      } else if (daysToReview <= 180) {
        empGaps.push({
          kind: 'emp_review',
          title: `EMP review due in ${daysToReview}d (5-year max, NFPA 70B §4.2)`,
          standardRef: 'NFPA 70B §4.2',
          action: { type: 'emp_settings', field: 'lastReviewedAt' },
          sortKey: [-1, 0, 1],
        });
      }
    }
  }

  let current = 0, overdue = 0, unbaselined = 0;
  const coveredAssetIds = new Set();
  const overdueRows = [];
  const unbaselinedRows = [];

  for (const s of schedules) {
    coveredAssetIds.add(s.assetId);
    if (!s.nextDueDate) {
      unbaselined += 1;
      unbaselinedRows.push(s);
    } else if (s.nextDueDate < now) {
      overdue += 1;
      overdueRows.push(s);
    } else {
      current += 1;
    }
  }

  const uncoveredCount = uncoveredAssets.length;
  const empGapCount = empGaps.length;

  // Weight each uncovered asset by the number of tasks its 70B template would
  // create (global + account task definitions for its equipmentType). Without
  // this, an uncovered asset counts as ONE gap but applying its template turns
  // it into N unbaselined gaps — so a good action (apply template) would
  // paradoxically DROP the overall rate. Weighting it N up front makes that
  // step score-neutral; baselining each task is what then earns the points.
  const uncoveredWeightByAsset = new Map();
  let uncoveredWeight = uncoveredCount;
  if (uncoveredCount > 0) {
    const types = [...new Set(uncoveredAssets.map((a) => a.equipmentType).filter(Boolean))];
    const tdGroups = types.length > 0 ? await prisma.maintenanceTaskDefinition.groupBy({
      by: ['equipmentType'],
      where: { equipmentType: { in: types }, OR: [{ accountId: null }, { accountId }] },
      _count: { _all: true },
    }) : [];
    const sizeByType = new Map<string, number>(tdGroups.map((g: any) => [g.equipmentType, Number(g._count?._all) || 0]));
    uncoveredWeight = 0;
    for (const a of uncoveredAssets) {
      const w = Math.max(1, sizeByType.get(a.equipmentType) || 1);
      uncoveredWeightByAsset.set(a.id, w);
      uncoveredWeight += w;
    }
  }

  const denom = current + overdue + unbaselined + uncoveredWeight + empGapCount;
  const overallRate = denom > 0 ? Math.round((current / denom) * 1000) / 10 : 100;
  // CFO-8-4: each unmet obligation unit is worth EXACTLY 100/denom points. The
  // old code rounded this to one decimal (pointPerUnit) and stamped the rounded
  // constant on every action, so e.g. denom=7 → 14.3, and 7×14.3 = 100.1 ≠ 100 —
  // clearing the whole list overshot/undershot 100%. We keep the exact per-unit
  // value for the cumulative-residual rounding pass below (after all actions are
  // built) so the displayed per-action points sum to exactly pointsToFull.
  const exactPointPerUnit = denom > 0 ? 100 / denom : 0;
  const pointPerUnit = denom > 0 ? Math.round(exactPointPerUnit * 10) / 10 : 0;

  const rated = current + overdue;
  const complianceRate = rated > 0 ? Math.round((current / rated) * 1000) / 10 : null;
  const coveredAssets  = coveredAssetIds.size;
  const coverageDenom  = totalAssets;
  const coverageRate   = coverageDenom > 0 ? Math.round((coveredAssets / coverageDenom) * 1000) / 10 : 100;

  // Build the ranked action list. Precedence: overdue (most-overdue first) →
  // unbaselined → uncovered (highest criticality first).
  const actions = [];

  // Program-level EMP gaps sort to the very top (sortKey[0] === -1) and each
  // recovers one obligation unit, same as a covered asset or current schedule.
  for (const g of empGaps) {
    actions.push({
      ...g,
      assetId: null,
      assetName: null,
      equipmentType: null,
      siteName: null,
      criticalityScore: null,
      pointsRecovered: pointPerUnit,
      _units: 1, // CFO-8-4: obligation units this action clears (for exact rounding)
    });
  }

  overdueRows.sort((a, b) => a.nextDueDate.getTime() - b.nextDueDate.getTime());
  for (const s of overdueRows) {
    const days = Math.floor((now.getTime() - s.nextDueDate.getTime()) / DAY_MS);
    actions.push({
      kind: 'overdue',
      scheduleId: s.id,
      assetId: s.asset.id,
      assetName: gapAssetLabel(s.asset),
      equipmentType: s.asset.equipmentType,
      siteName: s.asset.site ? s.asset.site.name : null,
      criticalityScore: s.asset.criticalityScore,
      title: `${s.taskDefinition.taskName} — ${days}d overdue on ${gapAssetLabel(s.asset)}`,
      standardRef: s.taskDefinition.standardRef,
      pointsRecovered: pointPerUnit,
      _units: 1,
      action: { type: 'create_wo', assetId: s.asset.id, scheduleId: s.id },
      sortKey: [0, -days, -(s.asset.criticalityScore || 0)],
    });
  }
  for (const s of unbaselinedRows) {
    actions.push({
      kind: 'unbaselined',
      scheduleId: s.id,
      assetId: s.asset.id,
      assetName: gapAssetLabel(s.asset),
      equipmentType: s.asset.equipmentType,
      siteName: s.asset.site ? s.asset.site.name : null,
      criticalityScore: s.asset.criticalityScore,
      title: `Baseline ${s.taskDefinition.taskName} on ${gapAssetLabel(s.asset)} (no first completion yet)`,
      standardRef: s.taskDefinition.standardRef,
      pointsRecovered: pointPerUnit,
      _units: 1,
      action: { type: 'baseline', scheduleId: s.id },
      sortKey: [1, 0, -(s.asset.criticalityScore || 0)],
    });
  }
  uncoveredAssets.sort((a, b) => (b.criticalityScore || 0) - (a.criticalityScore || 0));
  for (const a of uncoveredAssets) {
    actions.push({
      kind: 'uncovered',
      assetId: a.id,
      assetName: gapAssetLabel(a),
      equipmentType: a.equipmentType,
      siteName: a.site ? a.site.name : null,
      criticalityScore: a.criticalityScore,
      title: `${gapAssetLabel(a)} has no maintenance program — apply its NFPA 70B task set`,
      standardRef: null,
      pointsRecovered: Math.round(pointPerUnit * (uncoveredWeightByAsset.get(a.id) || 1) * 10) / 10,
      _units: (uncoveredWeightByAsset.get(a.id) || 1),
      action: { type: 'apply_template', assetId: a.id },
      sortKey: [2, 0, -(a.criticalityScore || 0)],
    });
  }

  actions.sort((x, y) => {
    for (let i = 0; i < 3; i++) { const d = x.sortKey[i] - y.sortKey[i]; if (d !== 0) return d; }
    return 0;
  });

  // CFO-8-4: assign per-action points via CUMULATIVE-residual rounding ANCHORED
  // to pointsToFull, so the displayed per-action values sum to EXACTLY
  // pointsToFull (= 100 - overallRate). Each action clears `_units` obligation
  // units; we walk the cumulative fraction of total units, scale it to
  // pointsToFull, round the running total at each step, and take per-action
  // deltas. The final action is forced onto pointsToFull, so "clear every action
  // → 100%" holds to the tenth instead of drifting by ±0.x from constant-rounding.
  const pointsToFull = Math.round((100 - overallRate) * 10) / 10;
  const totalUnits = actions.reduce((n, a) => n + (a._units || 1), 0);
  let cumUnits = 0;
  let prevCumPoints = 0;
  for (let i = 0; i < actions.length; i++) {
    const act = actions[i];
    cumUnits += (act._units || 1);
    const isLast = i === actions.length - 1;
    const cumPoints = isLast || totalUnits <= 0
      ? pointsToFull // force the final cumulative onto the exact headline gap
      : Math.round((pointsToFull * cumUnits / totalUnits) * 10) / 10;
    act.pointsRecovered = Math.round((cumPoints - prevCumPoints) * 10) / 10;
    prevCumPoints = cumPoints;
  }

  const totalActions = actions.length;
  const trimmed = actions.slice(0, limit).map(({ sortKey, _units, ...rest }) => rest);

  return {
    generatedAt: now,
    scope: { siteId: site ? site.id : null, siteName: site ? site.name : null },
    compliance: { rate: complianceRate, current, overdue, unbaselined },
    coverage:   { rate: coverageRate, coveredAssets, totalAssets: coverageDenom, uncoveredAssets: uncoveredCount },
    overallRate,
    pointsToFull,
    actions: trimmed,
    summary: {
      totalActions,
      shown: trimmed.length,
      overdueCount: overdue,
      unbaselinedCount: unbaselined,
      uncoveredCount,
      empGapCount,
      fullyCompliant: totalActions === 0,
    },
  };
}

// ── buildComplianceByCustomer / buildComplianceBySite (monthly digest) ────────
//
// Roll-ups for the two-email monthly digest. The manager roll-up charts
// compliance BY CUSTOMER (Account), not by the 120 individual sites; the rep
// email and the standalone-account fallback chart BY SITE within one account.
// Both reuse the same active-schedule taxonomy + summarizeSchedules math as the
// per-standard report above, so the digest rate and the in-app rate agree.

/**
 * One compliance summary per account in `accountIds`. Single query across all
 * accounts (grouped in-process) so a partner org's whole book costs one read.
 * Archived / out-of-service assets excluded — live posture only.
 *
 * @returns Array<{ accountId, companyName, ...summarizeSchedules }> sorted
 *          worst-compliance-first (nulls — nothing rated — sort last).
 */
async function buildComplianceByCustomer(prisma, accountIds, { now = new Date() } = {} as any) {
  const ids = [...new Set((accountIds || []).filter(Boolean))];
  if (ids.length === 0) return [];

  const [schedules, accounts] = await Promise.all([
    prisma.maintenanceSchedule.findMany({
      where: {
        accountId: { in: ids },
        isActive: true,
        asset: { archivedAt: null, inService: true },
      },
      select: { accountId: true, assetId: true, isActive: true, nextDueDate: true },
    }),
    prisma.account.findMany({
      where: { id: { in: ids } },
      select: { id: true, companyName: true },
    }),
  ]);

  const nameById = new Map(accounts.map((a) => [a.id, a.companyName]));
  const byAccount = new Map();
  for (const s of schedules) {
    let g = byAccount.get(s.accountId);
    if (!g) { g = []; byAccount.set(s.accountId, g); }
    g.push(s);
  }

  const out = ids.map((id) => ({
    accountId: id,
    companyName: nameById.get(id) || 'Account',
    ...summarizeSchedules(byAccount.get(id) || [], now),
  }));

  // Worst first; accounts with no rated schedules (rate === null) trail.
  out.sort((a, b) => {
    if (a.complianceRate === null && b.complianceRate === null) return 0;
    if (a.complianceRate === null) return 1;
    if (b.complianceRate === null) return -1;
    return a.complianceRate - b.complianceRate;
  });
  return out;
}

/**
 * One compliance summary per SITE within a single account (the standalone /
 * fallback path charts this). Sites with zero active schedules are omitted.
 *
 * @returns Array<{ siteId, siteName, ...summarizeSchedules }> worst-first.
 */
async function buildComplianceBySite(prisma, accountId, { now = new Date() } = {} as any) {
  const schedules = await prisma.maintenanceSchedule.findMany({
    where: {
      accountId,
      isActive: true,
      asset: { archivedAt: null, inService: true },
    },
    select: {
      assetId: true,
      isActive: true,
      nextDueDate: true,
      asset: { select: { site: { select: { id: true, name: true } } } },
    },
  });

  const bySite = new Map();
  for (const s of schedules) {
    const site = s.asset?.site;
    const key = site?.id || '__none__';
    let g = bySite.get(key);
    if (!g) { g = { siteId: site?.id || null, siteName: site?.name || 'Unassigned', schedules: [] }; bySite.set(key, g); }
    g.schedules.push(s);
  }

  const out = [...bySite.values()].map((g) => ({
    siteId: g.siteId,
    siteName: g.siteName,
    ...summarizeSchedules(g.schedules, now),
  }));

  out.sort((a, b) => {
    if (a.complianceRate === null && b.complianceRate === null) return 0;
    if (a.complianceRate === null) return 1;
    if (b.complianceRate === null) return -1;
    return a.complianceRate - b.complianceRate;
  });
  return out;
}

module.exports = {
  buildStandardsSummary,
  buildStandardReport,
  buildOverdueReport,
  buildComplianceGap,
  buildComplianceByCustomer,
  buildComplianceBySite,
  ACCOUNT_DEFINED_CODE,
};

export {};
