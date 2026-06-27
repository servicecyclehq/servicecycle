/**
 * render-hero.ts — builds the reference "hero" workbook from lib/xlsxStyle so
 * the canonical Excel look can be reviewed and templated against. Also serves
 * as the first fixture for the xlsx audit.
 *
 *   npx tsx scripts/xlsx-audit/render-hero.ts [OUT_DIR]
 */
import * as path from 'path';
import * as os from 'os';
const ExcelJS = require('exceljs');
const { applyReportSheet, applySummarySheet, brandWorkbook } = require('../../lib/xlsxStyle');

const OUT = process.argv[2] || os.tmpdir();
const condChip = (v: any) => (v === 'C1' ? 'good' : v === 'C2' ? 'warn' : v === 'C3' ? 'bad' : null);

async function main() {
  const wb = new ExcelJS.Workbook();
  brandWorkbook(wb);

  // ── Summary dashboard ────────────────────────────────────────────────────────
  applySummarySheet(wb.addWorksheet('Summary'), {
    title: 'ServiceCycle Account Export',
    subtitle: 'Meridian Manufacturing   ·   Generated 2026-06-20',
    kpis: [
      { value: '64', label: 'Assets tracked' },
      { value: '73%', label: 'Compliance rate' },
      { value: '$1.28M', label: 'Est. remediation' },
      { value: '28', label: 'Open deficiencies' },
    ],
    lines: [
      ['Product', 'ServiceCycle account export v1'],
      ['Standard', 'NFPA 70B'],
      ['Company', 'Meridian Manufacturing'],
      ['Generated', '2026-06-20'],
      ['Sites', '3'],
      ['Work orders (24 mo)', '231'],
      [null, null],
      ['Note', 'Figures reflect the data configured in ServiceCycle on the generation date and may lag the current published standard editions.'],
    ],
  });

  // ── Asset Register ───────────────────────────────────────────────────────────
  const assetCols = [
    { header: 'Asset', key: 'asset', type: 'string' },
    { header: 'Site', key: 'site', type: 'string' },
    { header: 'Equipment Type', key: 'type', type: 'string' },
    { header: 'Manufacturer', key: 'mfr', type: 'string' },
    { header: 'Model', key: 'model', type: 'string' },
    { header: 'Serial Number', key: 'serial', type: 'string' },
    { header: 'Condition', key: 'cond', type: 'string', chip: condChip },
    { header: 'Next Due', key: 'due', type: 'date' },
    { header: 'Risk', key: 'risk', type: 'percent', bar: true },
    { header: 'Repair Estimate', key: 'cost', type: 'currency' },
  ];
  const mfrs = ['Square D', 'Eaton', 'ABB', 'GE', 'Schneider Electric', 'Siemens'];
  const types = ['Switchgear', 'Transformer', 'MCC', 'UPS Battery', 'Generator', 'Panelboard'];
  const codes = ['SWGR', 'TX', 'MCC', 'UPS', 'GEN', 'PNL'];
  const sites = ['Riverside Plant', 'North Annex', 'South Campus'];
  const conds = ['C1', 'C1', 'C2', 'C2', 'C3'];
  const assetRows = Array.from({ length: 14 }, (_, i) => ({
    asset: `${types[i % types.length]} ${codes[i % codes.length]}-${100 + i}`,
    site: sites[i % sites.length],
    type: types[i % types.length],
    mfr: mfrs[i % mfrs.length],
    model: `M-${800 + i * 7}`,
    serial: `SN-${String(i).padStart(2, '0')}-${10324 + i * 91}`,
    cond: conds[i % conds.length],
    due: new Date(2026, 6 + (i % 6), 3 + i),
    risk: Math.max(0.18, 0.94 - i * 0.05),
    cost: 8000 + i * 6500,
  }));
  const costTotal = assetRows.reduce((n, r) => n + r.cost, 0);
  applyReportSheet(wb.addWorksheet('Asset Register'), {
    title: 'Asset Register',
    subtitle: 'Meridian Manufacturing   ·   14 of 64 assets shown   ·   Generated 2026-06-20',
    columns: assetCols,
    rows: assetRows,
    totals: { asset: 'Total (sample)', cost: costTotal },
  });

  // ── Work Orders ──────────────────────────────────────────────────────────────
  const woCols = [
    { header: 'Work Order', key: 'wo', type: 'string' },
    { header: 'Asset', key: 'asset', type: 'string' },
    { header: 'Site', key: 'site', type: 'string' },
    { header: 'Contractor', key: 'contractor', type: 'string' },
    { header: 'Status', key: 'status', type: 'string', chip: (v: any) => (v === 'Completed' ? 'good' : v === 'In Progress' ? 'warn' : null) },
    { header: 'Scheduled', key: 'sched', type: 'date' },
    { header: 'Completed', key: 'done', type: 'date' },
    { header: 'Labor + Parts', key: 'spend', type: 'currency' },
  ];
  const statuses = ['Completed', 'Completed', 'In Progress', 'Scheduled'];
  const woRows = Array.from({ length: 10 }, (_, i) => ({
    wo: `WO-${2200 + i}`,
    asset: `${types[i % types.length]} ${codes[i % codes.length]}-${100 + i}`,
    site: sites[i % sites.length],
    contractor: 'Apex Electrical Testing',
    status: statuses[i % statuses.length],
    sched: new Date(2026, 5, 1 + i),
    done: i % statuses.length < 2 ? new Date(2026, 5, 3 + i) : null,
    spend: i % statuses.length < 2 ? 1200 + i * 480 : null,
  }));
  applyReportSheet(wb.addWorksheet('Work Orders'), {
    title: 'Work Orders',
    subtitle: 'Meridian Manufacturing   ·   last 24 months   ·   Generated 2026-06-20',
    columns: woCols,
    rows: woRows,
  });

  const file = path.join(OUT, 'hero-template.xlsx');
  await wb.xlsx.writeFile(file);
  console.log('WROTE', file);
}

main().catch((e) => { console.error('FAIL', e && e.message ? e.message : e); process.exit(1); });
