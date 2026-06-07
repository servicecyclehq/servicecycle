// ─────────────────────────────────────────────────────────────────────────────
// reportsRegistry.js — single source of truth for the ServiceCycle Reports hub.
//
// The inherited contract-renewal report suite was removed in the ServiceCycle
// conversion. Live reports: Compliance by Standard (/reports/compliance,
// GET /api/compliance/summary), Overdue Maintenance by Severity
// (/reports/overdue, GET /api/compliance/overdue-report), Audit Evidence
// Snapshots (/reports/snapshots, /api/compliance/snapshots), the Standards
// Library explainer (/reports/standards-library, GET /api/standards), and the
// asset-register XLSX export. Maintenance Activity Summary and Trend Analysis
// are honest "Planned" placeholders — they need accumulated work-order /
// test-value history before they're worth shipping.
//
// Set `planned: true` for "Planned" placeholders that are not navigable.
// Set `to` for active cards that navigate to an in-app report route.
// Set `exportView` for active cards that download via GET /api/export/xlsx.
// ─────────────────────────────────────────────────────────────────────────────

import {
  BarChart3, AlertTriangle, FileCheck2, Download, BookOpen,
  ClipboardList, TrendingUp,
} from 'lucide-react';

export const REPORTS = [
  {
    id: 'compliance-by-standard',
    name: 'Compliance by Standard',
    description: 'Maintenance compliance rolled up per governing standard — NFPA 70B and every other standard in your task library, with asset counts, compliance rate, and a drill-down evidence table per standard.',
    icon: BarChart3,
    planned: false,
    to: '/reports/compliance',
  },
  {
    id: 'overdue-maintenance-by-severity',
    name: 'Overdue Maintenance by Severity',
    description: 'Overdue tasks and open deficiencies grouped by severity (Immediate / Recommended / Advisory) with days-overdue aging, so the riskiest gaps surface first.',
    icon: AlertTriangle,
    planned: false,
    to: '/reports/overdue',
  },
  {
    id: 'standards-library',
    name: 'Standards Library',
    description: 'A plain-language guide to the governing standards — NFPA 70B/70E/110, NETA MTS/ATS, IEEE C57.104/43, OSHA 1910 Subpart S — what each one means for your facility, and what the platform tracks for each.',
    icon: BookOpen,
    planned: false,
    to: '/reports/standards-library',
  },
  {
    id: 'audit-evidence-snapshots',
    name: 'Audit Evidence Snapshots',
    description: 'Generate immutable point-in-time PDF compliance reports with SHA-256 integrity hashes anchored in the tamper-evident audit log — evidence for an AHJ, insurer, or auditor.',
    icon: FileCheck2,
    planned: false,
    to: '/reports/snapshots',
  },
  {
    id: 'export-asset-register',
    name: 'Export Asset Register',
    description: 'Download the full asset register as an XLSX workbook — equipment type, manufacturer, model, serial number, site, condition, and schedule status for every asset.',
    icon: Download,
    planned: false,
    exportView: 'assets',
  },
  {
    id: 'maintenance-activity-summary',
    name: 'Maintenance Activity Summary',
    description: 'Completed work orders over a period with on-time percentage, broken down by site and contractor — useful once a few months of completion history has accumulated.',
    icon: ClipboardList,
    planned: true,
  },
  {
    id: 'trend-analysis',
    name: 'Trend Analysis',
    description: 'Test-value trending across maintenance cycles — insulation resistance (megohm) decline, DGA gas rate-of-change, contact-resistance (ohmic) rise — to catch degradation before it becomes a failure.',
    icon: TrendingUp,
    planned: true,
  },
];

export function findReportById(id) {
  return REPORTS.find(r => r.id === id);
}
