'use strict';

/**
 * auditFindings.ts -- Phase 1 #1 "What will fail an audit" view.
 *
 * Aggregates the signals ServiceCycle already computes into ONE ranked list of
 * the findings an NFPA 70B auditor (or an insurer risk survey) would most likely
 * write up. It does NOT recompute anything -- it reuses:
 *   - buildComplianceGap     (Path-to-100 obligation model) -> overdue /
 *                            unbaselined / uncovered / written-EMP gaps, plus the
 *                            compliance points closing each one recovers.
 *   - buildEvidenceGapSummary (#2)  -> work claimed complete with no record on file.
 *   - buildDriftDetector      (#4)  -> findings left uncorrected, conditions drifting.
 *   - summarizeMaturity       (B1)  -> the headline readiness score (from the SAME gap).
 *
 * Each category is a DISTINCT audit lens, chosen so the same root cause is not
 * counted twice: "overdue maintenance" is the Path-to-100 lens; the evidence lens
 * only surfaces UNDOCUMENTED work (claimed done, no record) that Path-to-100 reads
 * as green. The list is ranked severity-first, then by how many items it covers.
 *
 *   buildAuditFindings(prisma, accountId, { siteId? })
 *     -> { generatedAt, scope, readiness, summary, findings }
 *
 * Scoped to NFPA 70B. Account-scoped: the underlying builders throw
 * SITE_NOT_FOUND for a missing / cross-tenant siteId (mapped to 404 by the route).
 */

const { buildComplianceGap } = require('./complianceReport');
const { summarizeMaturity } = require('./maturityScore');
const { buildEvidenceGapSummary } = require('./evidenceTrace');
const { buildDriftDetector } = require('./driftDetector');

const SEVERITY_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

// How each category reads to an auditor + the program fix it points to.
const CATEGORY: Record<string, any> = {
  untracked_asset: {
    severity: 'critical',
    title: 'Assets with no maintenance program',
    standardRef: 'NFPA 70B - equipment inventory & maintenance program',
    recommendation: 'Apply the NFPA 70B task set to each untracked asset so it enters the program.',
  },
  overdue_maintenance: {
    severity: 'high',
    title: 'Overdue maintenance tasks',
    standardRef: 'NFPA 70B - maintenance intervals',
    recommendation: 'Complete the overdue work and record the results.',
  },
  undocumented_work: {
    severity: 'high',
    title: 'Completed tasks with no record on file',
    standardRef: 'NFPA 70B - documentation of maintenance',
    recommendation: 'Attach the test report / measurements that prove the work was performed.',
  },
  unclosed_finding: {
    severity: 'high',
    title: 'Deficiencies left uncorrected',
    standardRef: 'NFPA 70B - corrective action',
    recommendation: 'Open a corrective work order to close each outstanding finding.',
  },
  emp_program_gap: {
    severity: 'high',
    title: 'Written EMP program gaps (NFPA 70B 4.2)',
    standardRef: 'NFPA 70B 4.2 - written EMP, coordinator, periodic review',
    recommendation: 'Name an EMP coordinator and record a periodic program review (5-year max).',
  },
  unbaselined_task: {
    severity: 'medium',
    title: 'Maintenance tasks never baselined',
    standardRef: 'NFPA 70B - establish maintenance frequency',
    recommendation: 'Record a first-completion date so each task has an anchored next-due date.',
  },
  worsening_condition: {
    severity: 'medium',
    title: 'Assets drifting out of tolerance',
    standardRef: 'NFPA 70B - condition assessment',
    recommendation: 'Tighten the maintenance interval before the trend becomes a failure.',
  },
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Build the single ranked audit-failure list for one account (optionally one
 * site). Customer-facing -- same read tier as Path-to-100 / drift / evidence.
 */
async function buildAuditFindings(prisma: any, accountId: string, { siteId = null }: { siteId?: string | null } = {}) {
  // Unbounded gap so every action is present for accurate counts, examples, and
  // the points-at-risk roll-up (buildComplianceGap trims `actions` to `limit`).
  const [gap, evidence, drift] = await Promise.all([
    buildComplianceGap(prisma, accountId, { siteId, limit: Number.MAX_SAFE_INTEGER }),
    buildEvidenceGapSummary(prisma, accountId, { siteId }),
    buildDriftDetector(prisma, accountId, { siteId }),
  ]);

  const maturity = summarizeMaturity(gap, { siteId });

  const actionsByKind: Record<string, any[]> = { overdue: [], unbaselined: [], uncovered: [], emp_coordinator: [], emp_review: [] };
  const pointsByKind = { overdue: 0, unbaselined: 0, uncovered: 0, emp: 0 };
  for (const a of (gap.actions || [])) {
    if (actionsByKind[a.kind]) actionsByKind[a.kind].push(a);
    if (a.kind === 'overdue') pointsByKind.overdue += a.pointsRecovered || 0;
    else if (a.kind === 'unbaselined') pointsByKind.unbaselined += a.pointsRecovered || 0;
    else if (a.kind === 'uncovered') pointsByKind.uncovered += a.pointsRecovered || 0;
    else if (a.kind === 'emp_coordinator' || a.kind === 'emp_review') pointsByKind.emp += a.pointsRecovered || 0;
  }

  const findings: any[] = [];
  function push(kind: string, count: number, examples: any[], extra: any = {}) {
    if (!count || count <= 0) return;
    const meta = CATEGORY[kind];
    findings.push({
      kind,
      severity: meta.severity,
      title: meta.title,
      standardRef: meta.standardRef,
      recommendation: meta.recommendation,
      count,
      examples: (examples || []).slice(0, 5),
      ...extra,
    });
  }

  // ── Path-to-100 lenses (coverage / timeliness / baselining / written EMP) ──
  push('untracked_asset', gap.summary.uncoveredCount,
    actionsByKind.uncovered.map((a) => ({ assetId: a.assetId, label: a.assetName, siteName: a.siteName, detail: 'No maintenance program' })),
    { pointsAtRisk: round1(pointsByKind.uncovered) });

  push('overdue_maintenance', gap.summary.overdueCount,
    actionsByKind.overdue.map((a) => ({ assetId: a.assetId, label: a.assetName, siteName: a.siteName, detail: a.title })),
    { pointsAtRisk: round1(pointsByKind.overdue) });

  const empExamples = [...actionsByKind.emp_coordinator, ...actionsByKind.emp_review]
    .map((a) => ({ assetId: null, label: a.title, siteName: null, detail: a.standardRef }));
  push('emp_program_gap', gap.summary.empGapCount, empExamples, { pointsAtRisk: round1(pointsByKind.emp) });

  push('unbaselined_task', gap.summary.unbaselinedCount,
    actionsByKind.unbaselined.map((a) => ({ assetId: a.assetId, label: a.assetName, siteName: a.siteName, detail: a.title })),
    { pointsAtRisk: round1(pointsByKind.unbaselined) });

  // ── Evidence lens: work claimed complete but with NO record on file. ──
  // Path-to-100 reads these as green (a date is recorded), so they are the
  // documentation gaps it structurally cannot see.
  const undocumentedCount = evidence.totals ? (evidence.totals.undocumented || 0) : 0;
  const evidenceExamples = (evidence.topAssets || [])
    .map((a: any) => ({ assetId: a.assetId, label: a.assetLabel, siteName: a.siteName, detail: a.gaps + ' of ' + a.requirements + ' requirement(s) unproven' }));
  push('undocumented_work', undocumentedCount, evidenceExamples);

  // ── Drift lens: deficiencies left uncorrected; conditions drifting. ──
  const unclosed = drift.summary ? (drift.summary.unclosedCorrective || 0) : 0;
  push('unclosed_finding', unclosed,
    (drift.findings || []).filter((f: any) => f.driftType === 'unclosed_corrective')
      .map((f: any) => ({ assetId: f.assetId, label: f.assetLabel, siteName: f.siteName, detail: f.recommendationText })));

  const worsening = drift.summary ? (drift.summary.worseningTrend || 0) : 0;
  push('worsening_condition', worsening,
    (drift.findings || []).filter((f: any) => f.driftType === 'worsening_trend')
      .map((f: any) => ({ assetId: f.assetId, label: f.assetLabel, siteName: f.siteName, detail: f.recommendationText })));

  // Rank: severity first, then item count.
  findings.sort((a, b) => (SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]) || (b.count - a.count));

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  let totalFindings = 0;
  for (const f of findings) {
    bySeverity[f.severity as keyof typeof bySeverity] += f.count;
    totalFindings += f.count;
  }

  return {
    generatedAt: gap.generatedAt,
    scope: gap.scope,
    readiness: {
      score: maturity.score,
      level: maturity.level,
      levelLabel: maturity.levelLabel,
      documentedPct: typeof evidence.documentedPct === 'number' ? evidence.documentedPct : null,
    },
    summary: {
      categories: findings.length,
      totalFindings,
      bySeverity,
      clean: findings.length === 0,
      pointsToFull: gap.pointsToFull,
    },
    findings,
  };
}

module.exports = { buildAuditFindings, CATEGORY };

export {};
