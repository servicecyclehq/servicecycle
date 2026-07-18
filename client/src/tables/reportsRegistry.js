// ─────────────────────────────────────────────────────────────────────────────
// reportsRegistry.js — single source of truth for the ServiceCycle Reports hub.
//
// The inherited contract-renewal report suite was removed in the ServiceCycle
// conversion. All entries below are fully live — no "Planned" placeholders remain.
// Live: Compliance by Standard, Overdue Maintenance, Arc Flash suite (label /
// fleet / heatmap / search), EMP Document, Audit Evidence Snapshots, Standards
// Library, Revenue Attribution, Export Everything, Export Asset Register.
//
// Set `to` for active cards that navigate to an in-app report route.
// Set `exportView` for active cards that download via GET /api/export/xlsx.
// Set `empDownload: true` for cards that POST-generate and download an EMP PDF.
// Set `accountExport: true` for cards that trigger the full account-backup export.
// ─────────────────────────────────────────────────────────────────────────────

import {
  BarChart3, AlertTriangle, FileCheck2, Download, BookOpen,
  ShieldCheck, LineChart, Archive, Zap, CalendarClock,
} from 'lucide-react';

export const REPORTS = [
  {
    id: 'revenue-attribution',
    name: 'Revenue Attribution',
    description: 'The closed loop from platform signal to paid work: how Path-to-100 / modernization / arc-flash / QEMW alerts become quote requests, accepted quotes, and completed work orders — with estimated dollar value and conversion at each stage.',
    icon: LineChart,
    to: '/reports/revenue',
  },
  {
    id: 'installed-base',
    name: 'Installed-Base Intelligence',
    description: 'Fleet benchmarks from normalized test readings — each asset\'s latest values placed in percentile context against comparable units, with trend direction — plus the Watch/Plan/Act modernization pipeline built on age, condition, and end-of-support, and the identified → quoted → converted attach-rate funnel. Fleet context for planning conversations; condition decisions stay with qualified engineers.',
    icon: BarChart3,
    to: '/installed-base',
  },
  {
    id: 'arc-flash-labels',
    name: 'Arc Flash Label Report',
    description: 'Every current NFPA 70E 130.5(H) arc-flash label across your sites — nominal voltage, incident energy, arc-flash boundary, PPE / minimum arc rating, and DANGER/WARNING severity — with study dates and which studies are expiring within 90 days. The label schedule auditors and insurers ask for.',
    icon: Zap,
    to: '/reports/arc-flash',
  },
  {
    id: 'arc-flash-fleet',
    name: 'Arc Flash Fleet Dashboard',
    description: 'Arc-flash risk rolled up across every site: DANGER coverage and percentage, blocked buses still needing data, average data-confidence, open sanity-check findings, and studies expiring within 90 days. The portfolio view for where to act first. Generate an on-demand audit / insurer bundle from here.',
    icon: Zap,
    to: '/reports/arc-flash-fleet',
  },
  {
    id: 'arc-flash-heatmap',
    name: 'Arc Flash Heat-Map',
    description: 'A color-coded grid of every labelled bus, grouped by site and shaded by incident energy (the NFPA 70E hazard) with a data-confidence outline. The at-a-glance view of where the arc-flash heat concentrates across your plants.',
    icon: Zap,
    to: '/reports/arc-flash-heatmap',
  },
  {
    id: 'arc-flash-search',
    name: 'Arc Flash Search',
    description: 'Ask in plain English — "480V MCC over 8 cal that are blocked", "DANGER buses with low confidence", "switchgear with expired studies" — and get the matching buses, with the interpretation shown so results are explainable.',
    icon: Zap,
    to: '/reports/arc-flash-search',
  },
  {
    id: 'emp-document',
    name: 'EMP Document',
    description: 'Download your formal Electrical Maintenance Program (NFPA 70B §4.2) as a PDF — asset inventory, maintenance intervals, 24-month work-order history, condition ratings, open deficiencies, and personnel qualifications. Required by insurance carriers at policy renewal.',
    icon: ShieldCheck,
    to: '/reports/emp',
  },
  {
    id: 'compliance-by-standard',
    name: 'Compliance by Standard',
    description: 'Maintenance compliance rolled up per governing standard — NFPA 70B and every other standard in your task library, with asset counts, compliance rate, and a drill-down evidence table per standard.',
    icon: BarChart3,
    to: '/reports/compliance',
  },
  {
    id: 'multi-year-plan',
    name: '1 / 3 / 5-Year Maintenance Plan',
    description: 'The forward maintenance plan at the heart of an NFPA 70B program: active schedules projected over a 5-year horizon from each task\'s interval and the asset\'s governing condition — maintenance load by year (Year 1 through Year 5) with outage-required and NETA-certified counts and the assets and sites touched. The multi-year view for budgeting and scoping the work.',
    icon: CalendarClock,
    to: '/reports/multi-year-plan',
  },
  {
    id: 'overdue-maintenance-by-severity',
    name: 'Overdue Maintenance by Severity',
    description: 'Overdue tasks and open deficiencies grouped by severity (Immediate / Recommended / Advisory) with days-overdue aging, so the riskiest gaps surface first.',
    icon: AlertTriangle,
    to: '/reports/overdue',
  },
  {
    id: 'standards-library',
    name: 'Standards Library',
    description: 'A plain-language guide to the governing standards — NFPA 70B/70E/110, NETA MTS/ATS, IEEE C57.104/43, OSHA 1910 Subpart S — what each one means for your facility, and what the platform tracks for each.',
    icon: BookOpen,
    to: '/reports/standards-library',
  },
  {
    id: 'audit-evidence-snapshots',
    name: 'Audit Evidence Snapshots',
    description: 'Generate immutable point-in-time PDF compliance reports with SHA-256 integrity hashes anchored in the tamper-evident audit log — evidence for an AHJ, insurer, or auditor.',
    icon: FileCheck2,
    to: '/reports/snapshots',
  },
  {
    id: 'export-asset-register',
    name: 'Asset Register',
    description: 'Download the full asset register as an XLSX workbook — equipment type, manufacturer, model, serial number, site, condition, and schedule status for every asset.',
    icon: Download,
    to: '/reports/asset-register',
  },
  // 2026-07-13 fix: moved from first to last per Dustin's live review -- this
  // is the "nuclear option" full-account dump, not something most people open
  // day-to-day; the report cards people actually use belong up top.
  {
    id: 'export-everything',
    name: 'Account Backup',
    description: 'Download a complete, portable copy of your account as an Excel workbook — every site, asset, schedule, work order, deficiency, quote request, arc-flash study and label, LOTO procedure, parts catalog, spare inventory record, and asset part requirement, plus document and compliance-snapshot metadata with integrity hashes and retrieval paths, one sheet per record type. No lock-in: opens directly in Excel/Sheets, yours to keep or re-import anywhere.',
    icon: Archive,
    to: '/reports/account-backup',
  },
];

export function findReportById(id) {
  return REPORTS.find(r => r.id === id);
}
