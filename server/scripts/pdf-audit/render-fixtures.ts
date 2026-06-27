/**
 * render-fixtures.ts — PDF layout QA harness.
 *
 * Renders every pure PDF report generator with deliberately STRESSFUL mock
 * data (long names, wrapping descriptions, many rows, multi-page tables) so the
 * companion checker (audit_pdf.py) can detect layout regressions — text
 * overlap, blank pages, out-of-bounds text — before they reach a demo.
 *
 *   npx tsx scripts/pdf-audit/render-fixtures.ts [OUT_DIR]
 *   python3 scripts/pdf-audit/audit_pdf.py OUT_DIR/*.pdf --png-dir OUT_DIR
 *
 * Pure renderers covered here. Route/DB-coupled PDFs (outage planner, asset
 * labels, help-center docs) are audited against the live API — see README.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PDFDocument = require('pdfkit');
const { renderLeaveBehindPdf } = require('../../lib/leaveBehindPdf');
const { renderCfoReportPdf }   = require('../../lib/cfoReport');
const { renderSnapshotPdf }    = require('../../lib/compliancePdf');
const { renderProposalPdf }    = require('../../lib/proposalPdf');
const { renderEmpPdf }         = require('../../lib/empDocument');
const { buildLabelModel, drawArcFlashLabel, LABEL_W, LABEL_H } = require('../../lib/arcFlashLabelDoc');
const { renderHelpDocPdf }     = require('../../lib/pdfHelpDoc');
const { renderOutagePlanPdf }  = require('../../routes/outagePlanner');
const { renderAssetLabelsPdf } = require('../../routes/assetLabels');
const QRCode = require('qrcode');

const OUT = process.argv[2] || path.join(os.tmpdir(), 'sc-pdf-audit');
fs.mkdirSync(OUT, { recursive: true });

const meta = (over: any = {}) => ({ brandName: 'Apex Electrical Testing', brandColor: '#0d4f6e', generatedAtIso: new Date('2026-06-20T15:00:00Z').toISOString(), ...over });
const LONG = 'Medium-Voltage Metal-Clad Switchgear Lineup, Pinnacle Drive Systems International Holdings, Model PD-800-EXTENDED-FRAME';

async function write(name: string, p: Promise<Buffer>) {
  try {
    const buf = await p;
    fs.writeFileSync(path.join(OUT, name), buf);
    console.log('OK  ', name, buf.length, 'bytes');
  } catch (e: any) {
    console.error('FAIL', name, '-', e && e.message ? e.message : e);
  }
}

// ── CFO report ───────────────────────────────────────────────────────────────
const cfoData = {
  accountName: 'Meridian Manufacturing Holdings International', generatedAt: new Date('2026-06-20'),
  overallRate: 73, coverageRate: 61, openActions: 28,
  severity: { IMMEDIATE: 4, RECOMMENDED: 11, ADVISORY: 13 },
  quarter: { workOrdersCompleted: 142, deficienciesOpened: 39, deficienciesClosed: 22, realizedSpend: 184500 },
  spend: { estimatedRemediation: 1280000, assetsWithOpenDeficiencies: 21, assetsWithCostEstimate: 14, assetsWithoutCostEstimate: 7, coverageComplete: false },
  debtPlan: {
    year1: { min: 120000, max: 340000 }, year3: { min: 480000, max: 1100000 }, year5: { min: 900000, max: 2400000 },
    totals: { deferredMaintenance: { min: 220000, max: 560000 }, repairBacklog: { amount: 148000 }, modernization: { min: 680000, max: 1840000 } }, siteCount: 3,
  },
  trajectory: Array.from({ length: 8 }, (_, i) => ({ date: new Date(2026, i, 1), rate: 55 + i * 2.4, assets: 60 + i, overdue: 18 - i })),
};
write('cfo-report.pdf', renderCfoReportPdf(cfoData, meta()));

// ── Compliance snapshot ──────────────────────────────────────────────────────
const tasks = Array.from({ length: 22 }, (_, i) => ({
  asset: i === 0 ? LONG : `Switchgear SWGR-${i}A Main Bus`, site: 'Riverside Plant',
  task: 'Infrared thermographic survey under load per NETA MTS Table 100.18',
  lastCompleted: i % 3 ? '2026-01-15' : null, nextDue: '2026-09-01',
  status: (['overdue', 'current', 'unbaselined', 'inactive'] as const)[i % 4], evidence: i % 2 ? 'WO-2241' : null,
}));
const defs = Array.from({ length: 8 }, (_, i) => ({
  assetName: i === 0 ? LONG : `Transformer T-${i}`,
  severity: (['IMMEDIATE', 'RECOMMENDED', 'ADVISORY'] as const)[i % 3],
  description: 'Phase B bushing shows thermal discoloration and elevated infrared delta of 28C over the reference phase under full rated load, consistent with a developing high-resistance connection.',
  recommendation: i % 2 ? 'De-energize and re-terminate the line-side lugs; re-scan within 30 days.' : null,
}));
const bundle = { site: { name: 'Riverside Plant' }, overallRate: 73, coverage: { rate: 61 }, assetCount: 64, tasks, openDeficiencies: defs, summary: { totalActions: 30 } };
write('compliance-snapshot.pdf', renderSnapshotPdf([bundle], meta({ snapshotId: 'SNAP-2026-06-20-001', scopeDescription: 'All sites · full portfolio' })));

// ── Capital proposal ─────────────────────────────────────────────────────────
const proposalData = {
  accountName: 'Meridian Manufacturing Holdings International', scope: { siteName: 'Riverside Plant' },
  options: [
    { key: 'replace', label: 'Replace at end of life', count: 6, total: { min: 680000, max: 1840000 } },
    { key: 'repair', label: 'Repair and extend service life', count: 9, total: { min: 120000, max: 340000 } },
    { key: 'defer', label: 'Defer with monitoring', count: 7, total: { min: 0, max: 0 } },
  ],
  lineItems: Array.from({ length: 20 }, (_, i) => ({
    assetLabel: i === 0 ? LONG : `MCC-${i} Motor Control Center`, siteName: 'Riverside Plant',
    recommendation: (['replace', 'repair', 'defer'] as const)[i % 3], year: 2026 + (i % 5), costMin: 15000 + i * 5000, costMax: 80000 + i * 12000,
  })),
  summary: { total: { min: 800000, max: 2180000 } },
  disclaimer: 'BUDGET PLANNING ESTIMATES ONLY. Figures are probabilistic ranges derived from IEEE/NFPA/NETA equipment-life models and published service benchmarks. Actual costs vary by site, equipment configuration, and local labor. Consult a licensed electrical engineer before making capital replacement decisions.',
};
write('capital-proposal.pdf', renderProposalPdf(proposalData, meta()));

// ── EMP program document ─────────────────────────────────────────────────────
const empData = {
  accountName: 'Meridian Manufacturing Holdings International', fteCount: 240, generatedAt: new Date('2026-06-20'),
  coordinator: { id: 'u1', name: 'Carmen Rios', email: 'crios@example.com', role: 'manager' },
  equipmentSurvey: { totalAssets: 64, inService: 58, powerPathMapped: 49,
    byType: Array.from({ length: 7 }, (_, i) => ({ type: ['Switchgear', 'Transformer', 'MCC', 'UPS', 'Generator', 'Panelboard', 'ATS'][i], count: 3 + i })),
    bySite: [{ site: 'Riverside Plant', count: 40 }, { site: 'North Annex', count: 24 }], byCondition: { C1: 38, C2: 18, C3: 8 } },
  procedures: Array.from({ length: 12 }, (_, i) => ({ equipmentType: ['Switchgear', 'Transformer', 'MCC'][i % 3], taskName: 'Infrared thermographic survey under load per NETA MTS', intervalC1: 36, intervalC2: 24, intervalC3: 12, requiresOutage: i % 2 === 0, requiresNetaCertified: true, standardRef: 'NETA MTS 2023 Table 100.18', custom: i % 4 === 0 })),
  inspectionPlan: { activeSchedules: 51, unbaselined: 6, overdue: 9, dueNext30: 7, dueNext90: 14, dueNext365: 33, earliestNextDue: new Date('2026-07-05') },
  personnel: { contractors: [{ name: 'Apex Electrical Testing', isInternal: false, netaAccredited: true, techs: Array.from({ length: 4 }, (_, i) => ({ name: `Tech Number ${i + 1}`, title: 'Field Technician', netaCertLevel: 'III', qualifiedPersonDesignatedAt: new Date('2025-01-01'), trainingExpiresAt: new Date('2027-01-01'), thermographerCertLevel: 'II' })) }], contractorCount: 1, internalCrewCount: 1, techCount: 4 },
  correctiveMeasures: { open: { IMMEDIATE: 4, RECOMMENDED: 11, ADVISORY: 13 }, openTotal: 28, resolved: 22 },
  incidentFeedback: { regulatoryBreachFlags: 0, openDeficiencies: 28, resolvedDeficiencies: 22, loggedIncidents: 4, openIncidents: 1 },
  retention: { text: 'Records retained for 7 years per company policy and NFPA 70B recordkeeping guidance.', isDefault: true },
  programReview: { lastReviewedAt: new Date('2025-12-01'), nextReviewDue: new Date('2026-12-01'), reviewOverdue: false },
  conditionModelText: 'Condition ratings follow the NETA MTS C1/C2/C3 scale derived from inspection findings and test results.',
  stats: { assets: 64, schedules: 51, overdue: 9, openDeficiencies: 28, contractors: 1, internalCrews: 1, techs: 4, procedures: 12 },
};
write('emp-program.pdf', renderEmpPdf(empData, meta({ snapshotId: 'EMP-2026-06-20', accountName: 'Meridian Manufacturing Holdings International', generatedByName: 'Carmen Rios' })));

// ── Arc-flash label (single) ─────────────────────────────────────────────────
function renderArcFlashLabel(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [LABEL_W, LABEL_H], margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const row = {
      incidentEnergyCalCm2: 19.6, ppeCategory: null, ppeMethod: 'incident_energy', nominalVoltage: '13800',
      workingDistanceIn: 18, arcFlashBoundaryIn: 53, requiredArcRatingCalCm2: 19.6, shockLimitedApproachIn: 42, shockRestrictedApproachIn: 12,
      busName: 'SWGR-1A Main Bus', study: { peName: 'Dana Whitfield, PE', performedBy: 'Apex Electrical Testing', performedDate: new Date('2026-03-01'), expiresAt: new Date('2031-03-01'), expiryDate: new Date('2031-03-01') },
      asset: { name: 'SWGR-1A Main Bus', equipmentType: 'Switchgear' },
    };
    const m = buildLabelModel(row, { peName: 'Dana Whitfield, PE', firmName: 'Apex Electrical Testing', facilityName: 'Riverside Plant', brandName: 'Apex Electrical Testing' });
    drawArcFlashLabel(doc, 0, 0, LABEL_W, LABEL_H, m);
    doc.end();
  });
}
write('arc-flash-label.pdf', renderArcFlashLabel());

// ── Leave-behind (regression coverage for the renderer just fixed) ────────────
const lbMod = Array.from({ length: 24 }, (_, i) => ({ equipmentType: ['Switchgear', 'Transformer Liquid', 'MCC', 'UPS Battery'][i % 4], manufacturer: 'Kestrel Power Apparatus', model: `PD-${800 + i}`, serialNumber: `SN-${i}-${1000 + i}`, modernizationRiskScore: Math.max(0.35, 0.98 - i * 0.02), site: { name: 'Riverside Plant' }, rateMin: i % 4 ? 150000 + i * 5000 : null, rateMax: i % 4 ? 1200000 + i * 9000 : null, rateServiceType: 'replacement' }));
lbMod[0] = { ...lbMod[0], equipmentType: LONG } as any;
write('leave-behind.pdf', renderLeaveBehindPdf({
  workOrder: { id: 'f7a69fbd62582A00', scheduledDate: new Date('2026-06-14'), completedDate: new Date('2026-06-15'), asset: { equipmentType: 'Transfer Switch', manufacturer: 'Sentry', model: 'STS-800A', serialNumber: 'STS-05-1187', site: { name: 'Riverside Plant' } }, account: { companyName: 'Meridian Manufacturing', serviceRepName: 'Jordan Rivera', serviceRepPhone: '(555) 123-4567' }, contractor: { name: 'Apex Electrical Testing', netaAccredited: true }, technicianName: 'Carmen Rios', netaDecal: null, asLeftCondition: 'C1' },
  deficiencies: [{ severity: 'IMMEDIATE', description: 'Phase B bushing shows thermal discoloration and elevated infrared delta of 28C over the reference phase under full rated load, consistent with a developing high-resistance connection at the line-side termination.', correctiveAction: 'Torque-checked and re-terminated the line-side lugs to spec; scheduled a follow-up IR scan within 30 days.', resolvedAt: new Date('2026-06-15') }, { severity: 'RECOMMENDED', description: 'Breaker rack-out mechanism is stiff and the racking interlock lubrication has degraded past the service threshold.', correctiveAction: null, resolvedAt: null }],
  openQuoteRequests: [{ triggerType: 'modernization_candidate', notes: 'Legacy unit beyond NETA service life.', asset: { equipmentType: 'Panelboard', manufacturer: 'Vantage', model: 'VP-400', serialNumber: 'VP-22-3310', site: { name: 'Riverside Plant' } }, createdAt: new Date('2026-06-10') }],
  modernizationAssets: lbMod, branding: null,
}));

// ── Help Center doc (markdown -> paginated PDF with per-page header + footer) ─
write('help-doc.pdf', renderHelpDocPdf({
  slug: 'asset-condition-scoring',
  title: 'Asset Condition Scoring',
  markdown: `# Asset Condition Scoring\n\nServiceCycle assigns every tracked asset a condition score derived from inspection history, deficiency severity, and remaining useful life. This document explains how the score is computed, what each band means, and how technicians can influence it from the field. Read it end to end before relying on the number for capital-planning decisions, because the score is a directional signal, not a guarantee, and should always be interpreted alongside the underlying findings.\n\n## How the score is computed\n\nThe condition score is a weighted rollup of three inputs. Each input is normalized to a 0-100 scale, multiplied by its configured weight, and summed. When any single input is missing, its weight is redistributed proportionally across the inputs that are present, so a freshly onboarded asset still receives a usable score rather than a null. Because the inputs are normalized before weighting, an asset with no inspection history falls back to its nameplate age curve until the first field scan lands.\n\n- Observed condition: the inspector QEMW rating from the latest field scan, mapped onto the 0-100 axis.\n- Open deficiencies: each open finding subtracts points scaled by its severity.\n- Remaining useful life: the modeled years-to-replacement pulls end-of-life assets downward.\n- Recency penalty: a stale last-inspection decays confidence in the observed term.\n\n## Score bands\n\n1. GOOD (80-100): no action required; routine maintenance cadence applies.\n2. FAIR (60-79): monitor; schedule the next inspection on the standard interval.\n3. POOR (40-59): plan remediation within the current budget cycle.\n4. DANGER (0-39): escalate immediately; critical deficiency, expired arc-flash study, or remaining useful life exhausted.\n\n## Influencing the score from the field\n\nTechnicians have more leverage than they often realize. Completing an overdue inspection refreshes the observed-condition term and clears the recency penalty in one step, frequently moving an asset up a full band the moment the scan syncs. Closing a deficiency removes its severity subtraction on the next recompute. Logging a new high-severity finding pulls the score down quickly, which is intended behavior, because the score is meant to react to ground truth rather than lag it.\n\n## Frequently asked questions\n\nWhy did my asset score drop overnight without anyone touching it? The most common cause is the recency penalty crossing a threshold, or a remaining-useful-life model tick as the asset aged past a modeled inflection point. Open the asset score-history panel to see which term moved.\n\nCan I freeze a score for an asset pending decommission? Yes. Mark it decommission-pending and the nightly recompute holds its last score and suppresses alerts while keeping it visible in registers for audit purposes until the decommission is finalized.`,
}));

// ── Outage plan export ───────────────────────────────────────────────────────
write('outage-plan.pdf', renderOutagePlanPdf({
  target: { date: '2026-07-18T23:59:59.999Z', scopeLabel: 'Whole facility' },
  summary: { totalTasks: 18, totalDevices: 8, overdueCount: 5, carryOverCount: 3, opportunisticCount: 8, pulledForwardCount: 6, shutdownsAvoided: 3 },
  locations: [
    { siteName: 'North Plant - Main Substation Building (Bldg 100)', equipment: [
      { isFeeder: true, equipmentName: 'Square D QED-2 4000A Main Switchboard MSB-1', devices: [
        { assetName: 'Schneider Electric Masterpact NW40H1 4000A Drawout Air Circuit Breaker - Main Incomer, Cubicle 1A (very long asset name to force wrapping across the page width and onto subsequent lines)', condition: 'C3', tasks: [
          { taskName: 'Primary injection / overcurrent trip-unit calibration verification across all bands (long-time, short-time, instantaneous, ground-fault) per NETA acceptance', reason: 'overdue', dueDate: '2026-03-01T00:00:00.000Z', standardRef: 'NETA MTS 2023 7.6' },
          { taskName: 'Insulation resistance test (pole-to-pole, pole-to-ground)', reason: 'overdue', dueDate: '2026-04-10T00:00:00.000Z', standardRef: 'NFPA 70B' },
          { taskName: 'Infrared thermographic survey under load', reason: 'opportunistic', dueDate: null, standardRef: null },
        ] },
        { assetName: 'Eaton Type VCP-W 15kV Vacuum Circuit Breaker VB-3', condition: 'C3', tasks: [
          { taskName: 'Vacuum integrity (hi-pot) test', reason: 'overdue', dueDate: '2026-02-15T00:00:00.000Z', standardRef: 'NETA MTS 7.5' },
          { taskName: 'Contact resistance test', reason: 'carry-over', dueDate: '2025-12-01T00:00:00.000Z', standardRef: null },
        ] },
      ] },
      { isFeeder: false, equipmentName: 'GE 1500 kVA Pad-Mount Transformer T-100 (standalone unit)', devices: [
        { assetName: 'GE Prolec 1500kVA 13.8kV-480V Liquid-Filled Transformer T-100', condition: 'C2', tasks: [
          { taskName: 'Dissolved gas analysis (DGA) oil sample', reason: 'due', dueDate: '2026-07-12T00:00:00.000Z', standardRef: 'IEEE C57.104' },
          { taskName: 'Turns ratio (TTR) test, all taps', reason: 'opportunistic', dueDate: null, standardRef: 'NETA MTS 7.2.2' },
        ] },
      ] },
    ] },
    { siteName: 'South Campus - Distribution Center', equipment: [
      { isFeeder: true, equipmentName: 'Eaton Magnum DS 3200A Low-Voltage Switchgear SWGR-2', devices: [
        { assetName: 'Eaton Magnum DS 3200A Drawout Breaker DS-1', condition: 'C3', tasks: [
          { taskName: 'Trip-unit secondary injection test', reason: 'overdue', dueDate: '2026-05-01T00:00:00.000Z', standardRef: 'NETA MTS 7.6' },
          { taskName: 'Rack-in/rack-out mechanism inspection', reason: 'carry-over', dueDate: '2026-01-15T00:00:00.000Z', standardRef: null },
          { taskName: 'Bus insulation resistance test', reason: 'opportunistic', dueDate: null, standardRef: 'NETA MTS 7.1' },
        ] },
      ] },
    ] },
  ],
}));

// ── Asset QR label sheet (route helper needs pre-generated QR PNGs) ───────────
(async () => {
  const labelAssets: any[] = [
    { equipmentType: 'Switchgear', manufacturer: 'Square D', model: 'QED-2', serialNumber: 'SG-001', governingCondition: 'C1', site: { name: 'North Plant' }, position: { name: 'MCC-1', code: 'A12' }, _decal: 'GREEN', _decalDate: '2025-09-14T00:00:00.000Z' },
    { equipmentType: 'Transformer', manufacturer: 'ABB', model: 'DTE-1500', serialNumber: 'TX-204', governingCondition: 'C2', site: { name: 'South Yard' }, position: { name: 'Pad 3', code: null }, _decal: 'YELLOW', _decalDate: null },
    { equipmentType: 'Medium-Voltage Metal-Clad Drawout Circuit Breaker Assembly', manufacturer: 'Westinghouse-Cutler-Hammer-Eaton Industrial Distribution Group', model: 'DSII-840-Vacuum-Interrupter-Type-Extended-Catalog-Designation-Rev-G', serialNumber: 'SN-00000000000000000000000000000000000000-LONG', governingCondition: 'C3', site: { name: 'East Substation Complex - Bay 14 Distribution Hall' }, position: { name: 'Section 7B Vertical Bus Riser', code: 'E14-S7B-VBR-0001' }, _decal: 'RED', _decalDate: '2024-12-31T00:00:00.000Z' },
    { equipmentType: 'Panelboard', manufacturer: null, model: null, serialNumber: null, governingCondition: null, site: { name: 'West Annex' }, position: null, _decal: null, _decalDate: null },
  ];
  const qrPngs = await Promise.all(labelAssets.map((_, i) => QRCode.toBuffer(`https://example.test/field/asset/SC-ASSET-${i + 1}`, { type: 'png', errorCorrectionLevel: 'M', margin: 0, width: 240 })));
  await write('asset-labels.pdf', renderAssetLabelsPdf(labelAssets, qrPngs, 'Apex Electrical Testing'));
})();
