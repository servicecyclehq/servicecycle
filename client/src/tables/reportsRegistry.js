// ─────────────────────────────────────────────────────────────────────────────
// reportsRegistry.js — single source of truth for the Reports hub IA (v0.58.0)
//
// Each entry describes one report (shipped, new, or stub). The hub page reads
// this registry to render the grouped sections, the search box (which filters
// by name + description), the favorites toggle, and the persona ordering.
//
// Adding a new report: append an entry here. The hub picks it up
// automatically. Set `stub: true` for "Coming soon" placeholders that should
// not be navigable.
//
// Personas:
//   renewals   — Renewals & Pipeline
//   risk       — Risk & Compliance
//   spend      — Spend & Savings
//   executive  — Executive
//
// KPI ids used by the hub-kpis endpoint:
//   autoRenewalExposure, vendorConcentration, realizedSavingsYTD, cloudCommitBurn
// ─────────────────────────────────────────────────────────────────────────────

import {
  Calendar, AlertOctagon, ShieldAlert, PieChart, FileCheck2,
  PiggyBank, TrendingDown, TrendingUp, BarChart3, Layers, DollarSign,
  Activity, Network, GitMerge, LineChart, GitFork, Calculator,
  Trash2, AlertTriangle, Scissors, Users, UserCheck, Shield,
} from 'lucide-react';

export const PERSONAS = [
  { id: 'renewals',  label: 'Renewals & Pipeline',  color: '#0d4f6e' },
  { id: 'risk',      label: 'Risk & Compliance',    color: '#dc2626' },
  { id: 'spend',     label: 'Spend & Savings',      color: 'var(--color-success)' },
  { id: 'executive', label: 'Executive',            color: '#0891b2' },
];

// kpi: which KPI tile (if any) sources its headline number from this report.
// Used by the hub's KPI strip so the tile click navigates to its source.
export const REPORTS = [
  // ── Renewals & Pipeline ──────────────────────────────────────────────────
  {
    id: 'renewal-horizon',
    name: 'Renewal Horizon',
    description: 'Contracts renewing within the next 30, 60, 90, or 180 days — sorted by urgency. Flags auto-renewal exposures, windows closing within 14 days, and upcoming co-term groups.',
    persona: 'renewals',
    icon: Calendar,
    route: '/reports/renewal-horizon',
    hasAiNarrative: true,
  },
  {
    id: 'auto-renewal-exposure',
    name: 'Auto-Renewal Exposure',
    description: 'Capital at risk from auto-renewing contracts whose cancel window is approaching. Flags contracts where the window closes within 30 days (amber) or 7 days (red).',
    persona: 'renewals',
    icon: AlertOctagon,
    route: '/reports/auto-renewal-exposure',
    hasAiNarrative: true,
    kpi: 'autoRenewalExposure',
    newInVersion: 'v0.58',
  },
  {
    id: 'co-term-opportunity',
    name: 'Co-Termination Opportunity',
    description: 'Contracts whose end dates cluster within a quarter — candidates to be co-termed into a single negotiation event for vendor leverage.',
    persona: 'renewals',
    icon: GitMerge,
    route: '/reports/co-term-opportunity',
    hasAiNarrative: true,
    newInVersion: 'v0.59',
  },

  // ── Risk & Compliance ────────────────────────────────────────────────────
  {
    id: 'risk-radar',
    name: 'Risk Radar',
    description: 'Three risk buckets: auto-renewal exposures (cancel window passed), contracts expired but active, and co-term groups whose end dates have drifted apart.',
    persona: 'risk',
    icon: ShieldAlert,
    route: '/reports/risk-radar',
    hasAiNarrative: true,
  },
  {
    id: 'vendor-concentration',
    name: 'Vendor Concentration',
    description: 'Pareto distribution of spend by vendor. Shows top-5 / top-10 share and the 80% cutoff so you can see how concentrated (or diversified) the portfolio is.',
    persona: 'risk',
    icon: PieChart,
    route: '/reports/vendor-concentration',
    hasAiNarrative: true,
    kpi: 'vendorConcentration',
    newInVersion: 'v0.58',
  },
  {
    id: 'audit-evidence-pack',
    name: 'Audit Evidence Pack',
    description: 'SOX / SOC2 audit pack: signed contracts, approval chain, change history, and the supporting documents auditors typically request.',
    persona: 'risk',
    icon: FileCheck2,
    route: '/reports/audit-evidence-pack',
    hasAiNarrative: true,
    newInVersion: 'v0.59',
  },

  // ── Spend & Savings ──────────────────────────────────────────────────────
  {
    id: 'spend-ledger',
    name: 'Spend Ledger',
    description: 'Portfolio spend by vendor, category, and department with year-over-year. Two modes: Commitments (contract values) and Actuals (purchase order totals).',
    persona: 'spend',
    icon: BarChart3,
    route: '/reports/spend-ledger',
    hasAiNarrative: true,
  },
  {
    id: 'savings-ledger',
    name: 'Savings Ledger',
    description: 'Every contract where a negotiated price was recorded against the original ask. Shows savings per contract, blended rate, and breakdown by category.',
    persona: 'spend',
    icon: PiggyBank,
    route: '/reports/savings-ledger',
    hasAiNarrative: true,
    kpi: 'realizedSavingsYTD',
  },
  {
    id: 'license-wastage',
    name: 'License Wastage',
    description: 'Contracts with seat utilization data — shows utilization %, estimated annual waste in dollars, and which tools have the highest unused-seat cost.',
    persona: 'spend',
    icon: TrendingDown,
    route: '/reports/license-wastage',
    hasAiNarrative: true,
  },
  {
    id: 'application-overlap',
    name: 'Application Portfolio Overlap',
    description: 'Vendors and products that overlap in function. Surfaces consolidation candidates using category + (for SaaS) product-name keyword stems (comms / crm / storage / security / analytics / etc.).',
    persona: 'spend',
    icon: GitFork,
    route: '/reports/application-overlap',
    hasAiNarrative: true,
    newInVersion: 'v0.60',
  },
  {
    id: 'm365-overlap',
    name: 'Microsoft 365 Overlap',
    description: 'Tools whose core function is already bundled in the Microsoft 365 license you hold - Teams, Entra ID, Intune, Exchange Online, and at E5 Sentinel/Defender, Power BI, and Purview. Surfaces displaceable spend to cut at renewal.',
    persona: 'spend',
    icon: GitMerge,
    route: '/reports/m365-overlap',
    hasAiNarrative: true,
    conditional: 'm365Overlap',
    newInVersion: 'v0.91',
  },
  {
    id: 'non-saas-categories',
    name: 'Non-SaaS Category Breakdown',
    description: 'Breakdown of telecom, lease, insurance, hardware, services, utilities, supplies, and other categories. Vendor count, contract count, total spend, and expiring-soon counts per category.',
    persona: 'spend',
    icon: Layers,
    route: '/reports/non-saas-categories',
    hasAiNarrative: true,
    newInVersion: 'v0.58',
  },

  // ── Executive ────────────────────────────────────────────────────────────
  {
    id: 'executive-spend',
    name: 'Executive Spend',
    description: 'Board-ready backward-looking actuals: total spend by vendor, department, and category with FY YoY comparison and a top-10 contracts table.',
    persona: 'executive',
    icon: DollarSign,
    route: '/reports/executive-spend',
    hasAiNarrative: true,
  },
  {
    id: 'vendor-heat-map',
    name: 'Vendor Portfolio Heat Map',
    description: 'Two-axis heat map of vendor spend × criticality tier. Surfaces the strategic-vs-spend skew across the portfolio.',
    persona: 'executive',
    icon: Network,
    route: '/reports/vendor-heat-map',
    hasAiNarrative: true,
    newInVersion: 'v0.59',
  },
  {
    id: 'renewal-commitment-forecast',
    name: 'Renewal Commitment Forecast',
    description: '12-month and 24-month forward cash outflow forecast based on the current portfolio.',
    persona: 'executive',
    icon: LineChart,
    route: '/reports/renewal-commitment-forecast',
    hasAiNarrative: true,
    newInVersion: 'v0.59',
  },
  {
    id: 'budget-shock-simulator',
    name: 'Budget Shock Simulator',
    description: 'Three-scenario renewal P&L: list price vs. last year flat vs. category benchmark. Shows the 24-month cash-flow impact and department-level burden for each scenario.',
    persona: 'executive',
    icon: Calculator,
    route: '/reports/budget-shock-simulator',
    hasAiNarrative: false,
    newInVersion: 'v0.84',
  },

  // ── Renewals (new) ──────────────────────────────────────────────────────
  {
    id: 'price-escalation-radar',
    name: 'Price Escalation Radar',
    description: 'Contracts where per-unit price increased beyond a configurable threshold vs. the prior term. Identifies which vendors are growing their take rate fastest renewal over renewal.',
    persona: 'renewals',
    icon: TrendingDown,
    route: '/reports/price-escalation-radar',
    hasAiNarrative: true,
    newInVersion: 'v0.80',
  },
  {
    id: 'multi-year-commitment-risk',
    name: 'Multi-Year Commitment Risk',
    description: 'Active contracts with terms of 24 months or longer. Shows total capital committed beyond the current fiscal year, lock-in risk, and early-termination exposure by vendor.',
    persona: 'renewals',
    icon: Calendar,
    route: '/reports/multi-year-commitment-risk',
    hasAiNarrative: true,
    newInVersion: 'v0.80',
  },

  // ── Risk (new) ────────────────────────────────────────────────────────────
  {
    id: 'contract-health-score',
    name: 'Contract Health Score',
    description: 'Per-contract completeness and hygiene score (0–100) across five dimensions: required fields, documents attached, owner assigned, renewal plan started, and alerts acknowledged within SLA.',
    persona: 'risk',
    icon: ShieldAlert,
    route: '/reports/contract-health-score',
    hasAiNarrative: true,
    newInVersion: 'v0.80',
  },

  // ── Spend (new) ───────────────────────────────────────────────────────────
  {
    id: 'department-budget-allocation',
    name: 'Department Budget Allocation',
    description: 'Contract spend by owning department with per-owner accountability, upcoming renewals within 90 days, and contracts with no department assigned.',
    persona: 'spend',
    icon: PieChart,
    route: '/reports/department-budget-allocation',
    hasAiNarrative: true,
    newInVersion: 'v0.80',
  },
  {
    id: 'price-per-seat-benchmark',
    name: 'Price Per Seat Benchmark',
    description: 'Compares per-seat costs across all quantity-based contracts. Ranks vendors by cost per seat within each category — arm negotiators with internal benchmark data before renewal conversations.',
    persona: 'spend',
    icon: BarChart3,
    route: '/reports/price-per-seat-benchmark',
    hasAiNarrative: true,
    newInVersion: 'v0.80',
  },
  {
    id: 'gl-code-spend',
    name: 'GL Code Spend Breakdown',
    description: 'Contract spend organized by general ledger code — the native language of finance. Built for chargeback, quarterly close reconciliation, and AP alignment.',
    persona: 'spend',
    icon: DollarSign,
    route: '/reports/gl-code-spend',
    hasAiNarrative: true,
    newInVersion: 'v0.80',
  },
  {
    id: 'walkaway-calculator',
    name: 'Walkaway Calculator',
    description: 'At what price does switching beat renewing? Compares renewal cost vs. estimated migration cost using category-standard switching cost defaults you can override. Generates the CFO-ready one-pager automatically.',
    persona: 'spend',
    icon: TrendingDown,
    route: '/reports/walkaway-calculator',
    hasAiNarrative: false,
    newInVersion: 'v0.80',
  },

  // ── Executive (new) ───────────────────────────────────────────────────────
  {
    id: 'portfolio-decision-dashboard',
    name: 'Portfolio Decision Dashboard',
    description: 'All active contracts with their AI negotiation verdict (RENEW / RENEGOTIATE / REDUCE / REPLACE / RETIRE), confidence score, and days-to-renewal. The complete portfolio decision view in one screen.',
    persona: 'executive',
    icon: Activity,
    route: '/reports/portfolio-decision-dashboard',
    hasAiNarrative: false,
    newInVersion: 'v0.80',
  },
  {
    id: 'renewal-win-rate',
    name: 'Renewal Win Rate',
    description: 'Historical tracking of vendor ask vs. final negotiated price across all completed renewals. Shows average savings rate, best and worst negotiation outcomes, and trend over time.',
    persona: 'executive',
    icon: TrendingUp,
    route: '/reports/renewal-win-rate',
    hasAiNarrative: true,
    newInVersion: 'v0.80',
  },
  {
    id: 'contract-ownership',
    name: 'Contract Ownership Report',
    description: 'All active contracts organized by assigned owner. Surfaces contracts with no owner, no department, and owners managing more renewals than is sustainable — the accountability gap report.',
    persona: 'executive',
    icon: Network,
    route: '/reports/contract-ownership',
    hasAiNarrative: true,
    newInVersion: 'v0.80',
  },

  // ── Phase 3 Tier A (v0.85.0) ────────────────────────────────────────────────
  {
    id: 'total-addressable-waste',
    name: 'Total Addressable Waste',
    description: 'Sum of dollars locked in unused licensed seats across the portfolio. Ranks contracts by annual waste and breaks down by category and department.',
    persona: 'spend',
    icon: Trash2,
    route: '/reports/total-addressable-waste',
    hasAiNarrative: false,
    newInVersion: 'v0.85',
  },
  {
    id: 'termination-window-violations',
    name: 'Termination Window Violations',
    description: 'Auto-renewing contracts whose cancel window has already passed (missed) or is closing within 14 / 30 days. Shows capital at risk by bucket.',
    persona: 'risk',
    icon: AlertTriangle,
    route: '/reports/termination-window-violations',
    hasAiNarrative: false,
    newInVersion: 'v0.85',
  },
  {
    id: 'license-reclamation-roi',
    name: 'License Reclamation ROI',
    description: 'Per-contract value recoverable by cutting unused seats — cost per wasted seat × count. Tier-ranked (High / Medium / Low) to prioritise effort.',
    persona: 'spend',
    icon: Scissors,
    route: '/reports/license-reclamation-roi',
    hasAiNarrative: false,
    newInVersion: 'v0.85',
  },
  {
    id: 'cost-per-active-user',
    name: 'Cost-per-Active-User',
    description: 'Annual contract value divided by actively used seats, benchmarked against the internal category average. Surfaces overpriced outliers at a glance.',
    persona: 'spend',
    icon: Users,
    route: '/reports/cost-per-active-user',
    hasAiNarrative: false,
    newInVersion: 'v0.85',
  },
  {
    id: 'negotiation-effectiveness-by-owner',
    name: 'Negotiation Effectiveness by Owner',
    description: 'Average savings rate per contract owner across all deals with a recorded ask and final price. Shows who beats the ask most consistently.',
    persona: 'executive',
    icon: UserCheck,
    route: '/reports/negotiation-effectiveness-by-owner',
    hasAiNarrative: false,
    newInVersion: 'v0.85',
  },
  {
    id: 'vendor-negotiation-difficulty',
    name: 'Vendor Negotiation Difficulty',
    description: 'Vendors ranked by how rarely they concede. Difficulty score 0–100 derived from historical savings rate per vendor — arm your team before renewal talks.',
    persona: 'executive',
    icon: Shield,
    route: '/reports/vendor-negotiation-difficulty',
    hasAiNarrative: false,
    newInVersion: 'v0.85',
  },

];

export function reportsByPersona() {
  const grouped = {};
  for (const p of PERSONAS) grouped[p.id] = [];
  for (const r of REPORTS) {
    if (grouped[r.persona]) grouped[r.persona].push(r);
  }
  return grouped;
}

export function findReportById(id) {
  return REPORTS.find(r => r.id === id);
}

// KPI tiles in display order — left-to-right on the hub strip.
export const KPI_TILES = [
  { id: 'autoRenewalExposure', label: 'Auto-Renewal Exposure', icon: AlertOctagon, format: 'currency', linkTo: '/reports/auto-renewal-exposure', color: '#dc2626' },
  { id: 'vendorConcentration', label: 'Top-5 Vendor Concentration', icon: PieChart, format: 'percent', linkTo: '/reports/vendor-concentration', color: '#0d4f6e' },
  { id: 'realizedSavingsYTD',  label: 'Realized Savings YTD', icon: PiggyBank, format: 'currency', linkTo: '/reports/savings-ledger', color: 'var(--color-success)' },
  { id: 'cloudCommitBurn',     label: 'Cloud Commit Burn', icon: Activity, format: 'percent', linkTo: '/reports/spend-ledger', color: '#0891b2' },
];
