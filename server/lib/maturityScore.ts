/**
 * maturityScore.ts — B1: NFPA 70B program-maturity score (customer-facing).
 *
 * Reframes the numbers ServiceCycle already computes (compliance % + the
 * Path-to-100 obligation model) into a single 0-100 PROGRAM MATURITY score that
 * answers one customer question: "how close is my electrical maintenance program
 * to what NFPA 70B actually requires?" — measured against the STANDARD, never
 * against other facilities (zero peer data, zero consent).
 *
 * It is a pure repackaging of lib/complianceReport.buildComplianceGap:
 *   - score === gap.overallRate, so the maturity headline can never disagree
 *     with the Path-to-100 number on the same screen.
 *   - the gap (100 - score) is decomposed EXACTLY into four NFPA 70B program
 *     dimensions by summing the per-action pointsRecovered the gap already
 *     assigns (coverage / timeliness / baselining / written EMP §4.2).
 *   - score maps to a 1-5 maturity LEVEL with a plain-English "what it takes to
 *     reach the next level".
 *
 * Reused by B2 (contractor portfolio rank) and the Maintenance Debt Ledger via
 * summarizeMaturity(gap), which derives the score from an already-computed gap
 * so callers ranking a whole portfolio don't pay for a second pass.
 *
 *   buildMaturityScore(prisma, accountId, { siteId? }) -> full payload
 *   summarizeMaturity(gap)                             -> { score, level, ... }
 */

const { buildComplianceGap } = require('./complianceReport');

// ── Maturity levels (against the 70B standard, not peers) ─────────────────────
// Five ascending bands. levelForScore picks the highest band whose `min` the
// score reaches. Thresholds are deliberately demanding at the top: "Audit-Ready"
// (95+) means the Path-to-100 to-do list is essentially empty.
const MATURITY_LEVELS = [
  {
    level: 1, key: 'reactive', label: 'Reactive', min: 0,
    blurb: 'Maintenance is largely ad-hoc or run-to-failure. Little of the equipment is on a documented NFPA 70B program yet.',
  },
  {
    level: 2, key: 'developing', label: 'Developing', min: 40,
    blurb: 'A maintenance program is forming, but coverage and on-time completion still have major gaps against 70B.',
  },
  {
    level: 3, key: 'defined', label: 'Defined', min: 60,
    blurb: 'A 70B program is established across most equipment. Specific, identified gaps remain to close.',
  },
  {
    level: 4, key: 'managed', label: 'Managed', min: 80,
    blurb: 'A strong, well-tracked program with only minor gaps left to full NFPA 70B alignment.',
  },
  {
    level: 5, key: 'audit-ready', label: 'Audit-Ready', min: 95,
    blurb: 'Full alignment with what NFPA 70B requires — coverage, on-time maintenance, and a documented program.',
  },
];

function levelForScore(score: number) {
  let chosen = MATURITY_LEVELS[0];
  for (const lvl of MATURITY_LEVELS) {
    if (score >= lvl.min) chosen = lvl;
  }
  return chosen;
}

function nextLevelInfo(score: number) {
  const current = levelForScore(score);
  const next = MATURITY_LEVELS.find((l) => l.level === current.level + 1);
  if (!next) return null;
  return {
    level: next.level,
    label: next.label,
    scoreNeeded: next.min,
    pointsToNext: Math.round((next.min - score) * 10) / 10,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// Each maturity dimension maps to one Path-to-100 action `kind` (or kinds) and
// to the NFPA 70B requirement it expresses. subScore is an intuitive 0-100 read
// of that dimension on its own; pointsLost is the exact contribution to the
// (100 - score) gap, summed from the gap's own per-action point weights.
const DIMENSION_DEFS = [
  {
    key: 'coverage', label: 'Equipment coverage', kinds: ['uncovered'],
    standardRef: 'NFPA 70B — equipment inventory & maintenance program',
    blurb: 'Every in-service asset is enrolled in a maintenance program. Untracked equipment is invisible to compliance.',
  },
  {
    key: 'timeliness', label: 'On-time maintenance', kinds: ['overdue'],
    standardRef: 'NFPA 70B — maintenance intervals',
    blurb: 'Scheduled maintenance is performed on its required interval rather than running overdue.',
  },
  {
    key: 'baselining', label: 'Program baselining', kinds: ['unbaselined'],
    standardRef: 'NFPA 70B — establish maintenance frequency',
    blurb: 'Each task has a real last-service date so its next-due date is anchored, not unknown.',
  },
  {
    key: 'program_docs', label: 'Written EMP (§4.2)', kinds: ['emp_coordinator', 'emp_review'],
    standardRef: 'NFPA 70B §4.2 — written EMP, coordinator, periodic review',
    blurb: 'A named program coordinator and a periodic (5-year max) program review are on record.',
  },
];

/**
 * Derive the maturity score + dimension breakdown from an ALREADY-COMPUTED
 * Path-to-100 gap. Kept separate from the prisma fetch so a portfolio ranker
 * (B2) or the debt ledger can reuse one gap per account without a second query.
 *
 * IMPORTANT: the caller must have built the gap with a limit large enough to
 * include every action (buildComplianceGap trims `actions` to `limit`). The
 * exact-decomposition relies on seeing all actions; buildMaturityScore below
 * passes an unbounded limit.
 */
function summarizeMaturity(gap: any, { siteId = null }: { siteId?: string | null } = {}) {
  const score = round1(typeof gap.overallRate === 'number' ? gap.overallRate : 0);
  const level = levelForScore(score);

  // Exact points lost per action kind (sums to 100 - score).
  const lostByKind = new Map<string, number>();
  for (const a of (gap.actions || [])) {
    lostByKind.set(a.kind, (lostByKind.get(a.kind) || 0) + (a.pointsRecovered || 0));
  }

  const c = gap.compliance || {};
  const cov = gap.coverage || {};
  const sum = gap.summary || {};

  // Intuitive per-dimension sub-scores (independent of the obligation weighting).
  const ratedSchedules = (c.current || 0) + (c.overdue || 0);
  const existingSchedules = ratedSchedules + (c.unbaselined || 0);
  const subScoreByKey: Record<string, number | null> = {
    coverage: typeof cov.rate === 'number' ? round1(cov.rate) : null,
    timeliness: typeof c.rate === 'number' && c.rate !== null ? round1(c.rate) : (ratedSchedules === 0 ? null : 100),
    baselining: existingSchedules === 0 ? null : round1((ratedSchedules / existingSchedules) * 100),
    // EMP program requirements are account-level; meaningless under a site filter.
    program_docs: siteId ? null : round1(((2 - (sum.empGapCount || 0)) / 2) * 100),
  };
  const countByKey: Record<string, number> = {
    coverage: sum.uncoveredCount || 0,
    timeliness: sum.overdueCount || 0,
    baselining: sum.unbaselinedCount || 0,
    program_docs: siteId ? 0 : (sum.empGapCount || 0),
  };

  const dimensions = DIMENSION_DEFS.map((d) => {
    const pointsLost = round1(d.kinds.reduce((acc, k) => acc + (lostByKind.get(k) || 0), 0));
    return {
      key: d.key,
      label: d.label,
      standardRef: d.standardRef,
      blurb: d.blurb,
      subScore: subScoreByKey[d.key],
      pointsLost,
      count: countByKey[d.key],
    };
  });

  // The single dimension costing the most points = the customer's best lever.
  let biggestLever: { key: string; label: string; pointsLost: number } | null = null;
  for (const dim of dimensions) {
    if (dim.pointsLost <= 0) continue;
    if (!biggestLever || dim.pointsLost > biggestLever.pointsLost) {
      biggestLever = { key: dim.key, label: dim.label, pointsLost: dim.pointsLost };
    }
  }

  return {
    score,
    level: level.level,
    levelKey: level.key,
    levelLabel: level.label,
    levelBlurb: level.blurb,
    nextLevel: nextLevelInfo(score),
    dimensions,
    biggestLever,
    basis: {
      complianceRate: c.rate ?? null,
      coverageRate: cov.rate ?? null,
      coveredAssets: cov.coveredAssets ?? 0,
      totalAssets: cov.totalAssets ?? 0,
      overdueCount: sum.overdueCount || 0,
      unbaselinedCount: sum.unbaselinedCount || 0,
      uncoveredCount: sum.uncoveredCount || 0,
      empGapCount: sum.empGapCount || 0,
      totalActions: sum.totalActions || 0,
      fullyCompliant: !!sum.fullyCompliant,
    },
  };
}

const MATURITY_DISCLAIMER =
  'Program-maturity score is an estimate of alignment with NFPA 70B based on the ' +
  'data in ServiceCycle and the standard editions configured here. It is not a ' +
  'legal certification or a guarantee of audit outcome; verify against the current ' +
  'published edition of NFPA 70B.';

/**
 * Full maturity payload for one account (optionally one site). Customer-facing —
 * any authenticated role may read it (same tier as Path-to-100).
 */
async function buildMaturityScore(
  prisma: any,
  accountId: string,
  { siteId = null }: { siteId?: string | null } = {},
) {
  // Unbounded limit so every action is present for the exact decomposition.
  const gap = await buildComplianceGap(prisma, accountId, { siteId, limit: Number.MAX_SAFE_INTEGER });
  const summary = summarizeMaturity(gap, { siteId });

  return {
    generatedAt: gap.generatedAt,
    scope: gap.scope,
    ...summary,
    disclaimer: MATURITY_DISCLAIMER,
  };
}

module.exports = {
  buildMaturityScore,
  summarizeMaturity,
  levelForScore,
  MATURITY_LEVELS,
  MATURITY_DISCLAIMER,
};

export {};
