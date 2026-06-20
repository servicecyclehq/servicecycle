'use strict';

/**
 * underwritingPackage.ts -- Phase 1 #3 insurer underwriting package.
 *
 * Assembles, in one pass, the read-only packet an insurer underwriter / risk
 * surveyor wants for a property or equipment-breakdown account: the NFPA 70B
 * compliance posture, the program-maturity readiness score, the risk posture
 * (ranked audit findings + off-radar equipment), the capital-plan dollar ranges
 * from the Maintenance Debt Ledger, and tamper-evident evidence integrity (the
 * latest hash-chained snapshot + count). It does NOT recompute anything -- it
 * reuses:
 *   - buildComplianceGap      -> overall / schedule / coverage rates
 *   - buildAuditFindings (#1)  -> readiness score + ranked risk posture
 *   - buildForgottenAssets (#2)-> untracked / not-serviced counts
 *   - buildMaintenanceDebtData -> $ debt + 1/3/5-year capital plan
 *   - the immutable complianceSnapshot chain -> evidence integrity proof
 *
 * This is the data behind both the authenticated one-click packet and the
 * time-boxed "break-glass" insurer share link. Account-scoped throughout.
 *
 *   buildUnderwritingPackage(prisma, accountId) -> { ...packet }
 */

const { buildComplianceGap } = require('./complianceReport');
const { buildAuditFindings } = require('./auditFindings');
const { buildForgottenAssets } = require('./forgottenAssets');
const { buildMaintenanceDebtData } = require('./maintenanceDebt');

const UNDERWRITING_DISCLAIMER =
  'Read-only underwriting summary shared by the facility. Figures reflect live NFPA 70B ' +
  'program data in ServiceCycle at the generation time shown, plus published service-rate ' +
  'benchmarks for the dollar ranges. It is an estimate for risk-survey purposes, not an ' +
  'engineering assessment, a guarantee of audit outcome, or a binding quote.';

async function buildUnderwritingPackage(prisma: any, accountId: string) {
  const now = new Date();

  const [account, gap, audit, forgotten, debt, latestSnapshot, snapshotCount] = await Promise.all([
    prisma.account.findUnique({ where: { id: accountId }, select: { companyName: true } }),
    buildComplianceGap(prisma, accountId, { limit: 10 }),
    buildAuditFindings(prisma, accountId, {}),
    buildForgottenAssets(prisma, accountId, {}),
    buildMaintenanceDebtData(prisma, accountId),
    prisma.complianceSnapshot.findFirst({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      select: { kind: true, createdAt: true, sha256: true },
    }),
    prisma.complianceSnapshot.count({ where: { accountId } }),
  ]);

  const t = debt.totals || {};

  return {
    companyName: account?.companyName || 'Facility',
    generatedAt: now,
    standard: 'NFPA 70B',

    readiness: {
      score: audit.readiness?.score ?? null,
      level: audit.readiness?.level ?? null,
      levelLabel: audit.readiness?.levelLabel ?? null,
      documentedPct: audit.readiness?.documentedPct ?? null,
      overallRate: gap.overallRate,
      complianceRate: gap.compliance?.rate ?? null,
      coverageRate: gap.coverage?.rate ?? null,
      coveredAssets: gap.coverage?.coveredAssets ?? 0,
      totalAssets: gap.coverage?.totalAssets ?? 0,
    },

    riskPosture: {
      totalFindings: audit.summary?.totalFindings ?? 0,
      categories: audit.summary?.categories ?? 0,
      bySeverity: audit.summary?.bySeverity ?? { critical: 0, high: 0, medium: 0, low: 0 },
      topFindings: (audit.findings || []).slice(0, 5).map((f: any) => ({
        title: f.title, severity: f.severity, count: f.count,
      })),
      untrackedAssets: forgotten.summary?.untracked ?? 0,
      forgottenAssets: forgotten.summary?.forgotten ?? 0,
      neverServiced: forgotten.summary?.neverServiced ?? 0,
    },

    financial: {
      currency: debt.currency || 'USD',
      debtTotal: t.debtTotal || { min: 0, max: 0 },
      plan: debt.plan || null, // cumulative 1/3/5-yr funding {min,max}
      deferredMaintenance: t.deferredMaintenance || { min: 0, max: 0, count: 0 },
      repairBacklog: t.repairBacklog || { amount: 0, assets: 0 },
      modernization: t.modernization || { min: 0, max: 0 },
    },

    evidenceIntegrity: {
      immutable: true,
      snapshotCount,
      latestSnapshot: latestSnapshot
        ? { kind: latestSnapshot.kind, date: latestSnapshot.createdAt, sha256: latestSnapshot.sha256 }
        : null,
    },

    disclaimer: UNDERWRITING_DISCLAIMER,
  };
}

module.exports = { buildUnderwritingPackage, UNDERWRITING_DISCLAIMER };

export {};
