// ─────────────────────────────────────────────────────────────────────────────
// reportsRegistry.js — single source of truth for the ServiceCycle Reports hub.
//
// The inherited contract-renewal report suite was removed in the ServiceCycle
// conversion. The compliance report suite is planned (server /api/reports is
// currently a stub returning an empty list). Until those land, the hub shows
// three planned report cards plus one active export action.
//
// Set `planned: true` for "Planned" placeholders that are not navigable.
// Set `exportView` for active cards that download via GET /api/export/xlsx.
// ─────────────────────────────────────────────────────────────────────────────

import { BarChart3, AlertTriangle, FileCheck2, Download } from 'lucide-react';

export const REPORTS = [
  {
    id: 'nfpa-70b-compliance-rate',
    name: 'NFPA 70B Compliance Rate by Site',
    description: 'Scheduled maintenance completed on time vs. overdue, rolled up per site and account-wide. The headline number for your compliance program.',
    icon: BarChart3,
    planned: true,
  },
  {
    id: 'overdue-maintenance-by-severity',
    name: 'Overdue Maintenance by Severity',
    description: 'Overdue tasks and open deficiencies grouped by severity (Immediate / Recommended / Advisory) with aging buckets, so the riskiest gaps surface first.',
    icon: AlertTriangle,
    planned: true,
  },
  {
    id: 'audit-evidence-pack',
    name: 'Audit Evidence Pack',
    description: 'Insurance / OSHA documentation bundle: work-order history, test measurements, and the NETA decal trail for a site and date range — exportable for an AHJ, insurer, or auditor.',
    icon: FileCheck2,
    planned: true,
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
