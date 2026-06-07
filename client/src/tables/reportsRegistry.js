// ─────────────────────────────────────────────────────────────────────────────
// reportsRegistry.js — single source of truth for the ServiceCycle Reports hub.
//
// The inherited contract-renewal report suite was removed in the ServiceCycle
// conversion. The per-standard compliance suite is now live: Compliance by
// Standard (/reports/compliance, GET /api/compliance/summary) and Audit
// Evidence Snapshots (/reports/snapshots, /api/compliance/snapshots). The
// overdue-by-severity report remains planned.
//
// Set `planned: true` for "Planned" placeholders that are not navigable.
// Set `to` for active cards that navigate to an in-app report route.
// Set `exportView` for active cards that download via GET /api/export/xlsx.
// ─────────────────────────────────────────────────────────────────────────────

import { BarChart3, AlertTriangle, FileCheck2, Download } from 'lucide-react';

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
    description: 'Overdue tasks and open deficiencies grouped by severity (Immediate / Recommended / Advisory) with aging buckets, so the riskiest gaps surface first.',
    icon: AlertTriangle,
    planned: true,
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
];

export function findReportById(id) {
  return REPORTS.find(r => r.id === id);
}
