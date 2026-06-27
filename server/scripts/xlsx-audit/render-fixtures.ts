/**
 * render-fixtures.ts — renders one sample of every Excel export style path so
 * the xlsx audit can verify the canonical look is applied uniformly:
 *   account-export.xlsx  — applySummarySheet + applyReportSheet (report style)
 *   monthly-digest.xlsx  — buildDigestXlsxBuffer (internal digest)
 *   customer-digest.xlsx — buildCustomerXlsxBuffer (customer digest)
 *   afx-template.xlsx    — applyTemplateHeader (round-trip template style)
 *
 *   npx tsx scripts/xlsx-audit/render-fixtures.ts [OUT_DIR]
 *   python3 scripts/xlsx-audit/audit_xlsx.py OUT_DIR/*.xlsx
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
const ExcelJS = require('exceljs');
const { applyReportSheet, applySummarySheet, applyTemplateHeader, brandWorkbook } = require('../../lib/xlsxStyle');
const { buildDigestXlsxBuffer, buildCustomerXlsxBuffer } = require('../../lib/digestExcel');

const OUT = process.argv[2] || path.join(os.tmpdir(), 'sc-xlsx-audit');
fs.mkdirSync(OUT, { recursive: true });
const condChip = (v: any) => (v === 'C1' ? 'good' : v === 'C2' ? 'warn' : v === 'C3' ? 'bad' : null);

const types = ['Switchgear', 'Transformer', 'MCC', 'UPS Battery', 'Generator', 'Panelboard'];
const codes = ['SWGR', 'TX', 'MCC', 'UPS', 'GEN', 'PNL'];
const sites = ['Riverside Plant', 'North Annex', 'South Campus'];
const conds = ['C1', 'C1', 'C2', 'C2', 'C3'];

async function main() {
  // 1. Account export — summary + report sheet (report style).
  const wb = new ExcelJS.Workbook();
  brandWorkbook(wb);
  applySummarySheet(wb.addWorksheet('Read Me'), {
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
    ],
  });
  const assetCols = [
    { header: 'Asset', key: 'asset', type: 'string' },
    { header: 'Site', key: 'site', type: 'string' },
    { header: 'Manufacturer', key: 'mfr', type: 'string' },
    { header: 'Condition', key: 'cond', type: 'string', chip: condChip },
    { header: 'Next Due', key: 'due', type: 'date' },
    { header: 'Risk', key: 'risk', type: 'percent', bar: true },
    { header: 'Repair Estimate', key: 'cost', type: 'currency' },
  ];
  const assetRows = Array.from({ length: 14 }, (_, i) => ({
    asset: `${types[i % types.length]} ${codes[i % codes.length]}-${100 + i}`,
    site: sites[i % sites.length],
    mfr: ['Square D', 'Eaton', 'ABB', 'GE'][i % 4],
    cond: conds[i % conds.length],
    due: new Date(2026, 6 + (i % 6), 3 + i),
    risk: Math.max(0.18, 0.94 - i * 0.05),
    cost: 8000 + i * 6500,
  }));
  applyReportSheet(wb.addWorksheet('Assets'), {
    title: 'Asset Register',
    subtitle: 'Meridian Manufacturing   ·   14 assets   ·   Generated 2026-06-20',
    columns: assetCols,
    rows: assetRows,
    totals: { asset: 'Total', cost: assetRows.reduce((n, r) => n + r.cost, 0) },
    autoFilter: true,
  });
  await wb.xlsx.writeFile(path.join(OUT, 'account-export.xlsx'));
  console.log('OK   account-export.xlsx');

  // 2 + 3. Monthly digest + customer digest (real builders, mock rows).
  const digestRows = Array.from({ length: 12 }, (_, i) => ({
    rep: ['Sarah Kim', 'Jordan Rivera'][i % 2],
    company: 'Meridian Manufacturing',
    site: sites[i % sites.length],
    equipment: `${types[i % types.length]} — ${['Square D', 'Eaton', 'ABB'][i % 3]} / M-${800 + i}`,
    serviceNeeded: 'Infrared thermographic survey under load per NETA MTS',
    dueDate: i % 4 === 0 ? null : new Date(2026, 6, 5 + i),
    status: i % 3 === 0 ? `${10 + i}d overdue` : 'due in 30d',
    condition: conds[i % conds.length],
    priorityScore: 25 - i,
    trend: i % 3 === 0 ? 'worsening' : '',
    estMinDollars: i % 5 === 0 ? null : 1500 + i * 800,
    estMaxDollars: i % 5 === 0 ? null : 12000 + i * 2400,
    rulPct: Math.round(Math.max(18, 94 - i * 5)),
    ageYears: 8 + i,
    autoC3: i % 4 === 0,
  }));
  fs.writeFileSync(path.join(OUT, 'monthly-digest.xlsx'), await buildDigestXlsxBuffer(digestRows, { title: 'Monthly Service Digest' }));
  console.log('OK   monthly-digest.xlsx');
  fs.writeFileSync(path.join(OUT, 'customer-digest.xlsx'), await buildCustomerXlsxBuffer(digestRows, { title: 'Maintenance Summary' }));
  console.log('OK   customer-digest.xlsx');

  // 4. Round-trip template (header-only brand, headers stay in row 1).
  const twb = new ExcelJS.Workbook();
  brandWorkbook(twb);
  const ws = twb.addWorksheet('Buses');
  ws.addRow(['Bus ID', 'Name', 'Nominal Voltage (V)', 'Bus Type', 'Fed From']);
  for (let i = 0; i < 8; i++) ws.addRow([`B${i + 1}`, `${types[i % types.length]} Bus ${i + 1}`, '13800', 'SWGR', i === 0 ? '' : `B${i}`]);
  applyTemplateHeader(ws);
  await twb.xlsx.writeFile(path.join(OUT, 'afx-template.xlsx'));
  console.log('OK   afx-template.xlsx');
}

main().catch((e) => { console.error('FAIL', e && e.message ? e.message : e); process.exit(1); });
