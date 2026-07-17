/*
 * seed-cedar-northgate-drift-demo.js
 *
 * Idempotent demo seed for the matched 2022 -> 2026 drift story (two fictional sites).
 * Creates its OWN sites on the pinned demo account, each with two arc_flash SystemStudies
 * (prior superseded by current) and per-bus bindings, so the product's per-asset arc-flash
 * TREND card + drift/re-study surfaces light up with the choreographed drift:
 *   - Cedar Hollow Pump Station: NEC 110.9 surfaces (SWBD-CH available fault 22.4 -> 35.2 kA
 *     vs 25 kAIC of record) + PPE escalation (MCC-PUMP 5.4 -> 9.6 cal/cm2, CAT 2 -> 3).
 *   - Northgate Medical Center: NEC 110.9 (MSB 31.4 -> 44.0 kA vs 42 kAIC) + hazardous-panel
 *     lifecycle MITIGATED (PNL-CRIT 10.2 -> 5.8 cal/cm2, CAT 3 -> 2 after a maintenance-switch
 *     retrofit) + PPE escalation (PNL-EQ 3.1 -> 8.9 cal/cm2, into CAT 3).
 *
 * All data is fabricated; site names/addresses are placeholders. NOT part of seed-demo.js, so a
 * full demo reseed does NOT recreate these sites -- re-run this script after a reseed if needed.
 * Safe to run repeatedly: wipes and rebuilds only its own two sites (matched by name on the demo
 * account). Targets the pinned demo account only.
 *
 * Run inside the server container:
 *   docker compose exec -T server node scripts/seed-cedar-northgate-drift-demo.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');

const DEMO_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const MARKER = '[cedar-northgate-drift-demo]';

// ---- the two sites, their assets, and the per-bus drift bindings ----
// study binding fields mirror seed-arcflash-trend-demo.js / SystemStudyAsset.
const SITES = [
  {
    name: 'Cedar Hollow Pump Station',
    priorDate: new Date('2022-03-15T14:02:00Z'),
    curDate: new Date('2026-02-11T09:41:00Z'),
    priorNote: MARKER + ' Arc-flash study of record (radial 480 V pump station).',
    curNote: MARKER + ' Re-study after utility upgrade + 750->1000 kVA transformer; available '
      + 'fault current rose. SWBD-CH available fault (35.2 kA) now exceeds its 25 kAIC interrupting '
      + 'rating of record (NEC 110.9). Added GEN-1/ATS-1 + VFD-WELL-3.',
    assets: [
      { model: 'T-CH', equipmentType: 'TRANSFORMER_LIQUID', manufacturer: 'Cooper Power', nameplate: { kva: 1000, voltageClass: '12.47kV-480V' } },
      { model: 'SWBD-CH', equipmentType: 'SWITCHBOARD', manufacturer: 'Square D', nameplate: { voltageClass: '480V', aic: '25kA', busRating: '2000A' } },
      { model: 'MCC-PUMP', equipmentType: 'MCC', manufacturer: 'Square D', nameplate: { voltageClass: '480V' } },
      { model: 'GEN-1', equipmentType: 'GENERATOR', manufacturer: 'Cummins', nameplate: { kw: 250, voltageClass: '480V', addedYear: 2025 } },
      { model: 'ATS-1', equipmentType: 'TRANSFER_SWITCH', manufacturer: 'ASCO', nameplate: { rating: '400A', addedYear: 2025 } },
    ],
    bind: [
      { model: 'SWBD-CH', busName: 'SWBD-CH Main Bus', nominalVoltage: '480V', upstream: 'T-CH FS',
        prior: { ie: 8.5, afb: 62, ppe: 2, bolted: 22.4, arcing: 12.6, clearing: 620, sev: 'warning' },
        cur:   { ie: 14.2, afb: 96, ppe: 3, bolted: 35.2, arcing: 19.4, clearing: 640, sev: 'danger', reqArc: 12 } },
      { model: 'MCC-PUMP', busName: 'MCC-PUMP', nominalVoltage: '480V', upstream: 'SWBD FDR-1',
        prior: { ie: 5.4, afb: 44, ppe: 2, bolted: 18.9, arcing: 10.9, clearing: 310, sev: 'warning' },
        cur:   { ie: 9.6, afb: 66, ppe: 3, bolted: 28.6, arcing: 16.1, clearing: 320, sev: 'warning', reqArc: 8 } },
    ],
  },
  {
    name: 'Northgate Medical Center',
    priorDate: new Date('2022-09-22T16:20:00Z'),
    curDate: new Date('2026-03-31T11:08:00Z'),
    priorNote: MARKER + ' Arc-flash study of record (hospital Normal/Emergency per NEC 517/NFPA 99).',
    curNote: MARKER + ' Re-study after utility reinforcement. MSB available fault (44.0 kA) now '
      + 'exceeds its 42 kAIC rating (NEC 110.9). PNL-CRIT mitigated CAT 3->2 via a 2024 arc-reduction '
      + 'maintenance switch; PNL-EQ escalated into CAT 3. Added PDU-IMG, PNL-OR3, PNL-MECH2.',
    assets: [
      { model: 'MSB', equipmentType: 'SWITCHGEAR', manufacturer: 'Eaton', nameplate: { voltageClass: '480V', aic: '42kA', busRating: '3000A' } },
      { model: 'EMSB', equipmentType: 'SWITCHGEAR', manufacturer: 'Eaton', nameplate: { voltageClass: '480V', branch: 'essential' } },
      { model: 'PNL-CRIT', equipmentType: 'PANELBOARD', manufacturer: 'Square D', nameplate: { voltageClass: '480V', branch: 'critical' } },
      { model: 'PNL-EQ', equipmentType: 'PANELBOARD', manufacturer: 'Square D', nameplate: { voltageClass: '480V', branch: 'equipment' } },
      { model: 'GEN-1', equipmentType: 'GENERATOR', manufacturer: 'Kohler', nameplate: { kw: 500, voltageClass: '480V', role: 'emergency' } },
      { model: 'ATS-EM', equipmentType: 'TRANSFER_SWITCH', manufacturer: 'ASCO', nameplate: { rating: '1200A' } },
      { model: 'PDU-IMG', equipmentType: 'POWER_DISTRIBUTION_UNIT', manufacturer: 'Eaton', nameplate: { voltageClass: '480V', addedYear: 2025 } },
      { model: 'PNL-OR3', equipmentType: 'PANELBOARD', manufacturer: 'Square D', nameplate: { voltageClass: '480V', addedYear: 2025 } },
    ],
    bind: [
      { model: 'MSB', busName: 'MSB (Normal) Main Bus', nominalVoltage: '480V', upstream: 'T-MAIN FS',
        prior: { ie: 11.8, afb: 74, ppe: 3, bolted: 31.4, arcing: 17.6, clearing: 480, sev: 'danger' },
        cur:   { ie: 16.4, afb: 104, ppe: 3, bolted: 44.0, arcing: 23.9, clearing: 500, sev: 'danger', reqArc: 12 } },
      { model: 'PNL-CRIT', busName: 'PNL-CRIT (Critical Branch)', nominalVoltage: '480V', upstream: 'EMSB FDR-2',
        prior: { ie: 10.2, afb: 78, ppe: 3, bolted: 14.2, arcing: 8.6, clearing: 520, sev: 'danger' },
        cur:   { ie: 5.8, afb: 40, ppe: 2, bolted: 16.8, arcing: 10.0, clearing: 170, sev: 'warning', reqArc: 8 } },
      { model: 'PNL-EQ', busName: 'PNL-EQ (Equipment Branch)', nominalVoltage: '480V', upstream: 'EMSB FDR-3',
        prior: { ie: 3.1, afb: 28, ppe: 1, bolted: 12.8, arcing: 7.8, clearing: 160 },
        cur:   { ie: 8.9, afb: 68, ppe: 3, bolted: 16.1, arcing: 9.6, clearing: 440, sev: 'warning', reqArc: 8 } },
    ],
  },
];

function addMonths(date, months) { const d = new Date(date); d.setMonth(d.getMonth() + months); return d; }

async function seedSite(prisma, spec) {
  // find-or-create the site (wholly owned by this seed)
  let site = await prisma.site.findFirst({ where: { accountId: DEMO_ACCOUNT_ID, name: spec.name }, select: { id: true } });
  if (!site) site = await prisma.site.create({ data: { accountId: DEMO_ACCOUNT_ID, name: spec.name, oneLineDiagramOnFile: true }, select: { id: true } });
  const siteId = site.id;

  // idempotent wipe of ONLY this site's marked studies (+ bindings) and its assets
  const prior = await prisma.systemStudy.findMany({ where: { accountId: DEMO_ACCOUNT_ID, siteId, notes: { contains: MARKER } }, select: { id: true } });
  if (prior.length) {
    const ids = prior.map((s) => s.id);
    await prisma.systemStudy.updateMany({ where: { id: { in: ids } }, data: { supersededById: null } });
    await prisma.systemStudyAsset.deleteMany({ where: { studyId: { in: ids } } });
    await prisma.systemStudy.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.asset.deleteMany({ where: { accountId: DEMO_ACCOUNT_ID, siteId } });

  // assets
  const id = {};
  for (const a of spec.assets) {
    const row = await prisma.asset.create({ data: {
      accountId: DEMO_ACCOUNT_ID, siteId, equipmentType: a.equipmentType, model: a.model,
      manufacturer: a.manufacturer, serialNumber: 'CNDEMO-' + a.model, nameplateData: a.nameplate,
    }, select: { id: true } });
    id[a.model] = row.id;
  }

  // two studies (prior superseded by current)
  const mk = (date, note, trigger) => prisma.systemStudy.create({ data: {
    accountId: DEMO_ACCOUNT_ID, siteId, studyType: 'arc_flash', performedDate: date, expiresAt: addMonths(date, 60),
    performedBy: 'Hawthorne Power Engineering, PLLC', method: 'IEEE 1584-2018', peName: 'S. Hawthorne, PE',
    peLicense: 'MN PE 48213', trigger, notes: note,
  }, select: { id: true } });
  const priorStudy = await mk(spec.priorDate, spec.priorNote, 'scheduled');
  const curStudy = await mk(spec.curDate, spec.curNote, 'utility_change');
  await prisma.systemStudy.update({ where: { id: priorStudy.id }, data: { supersededById: curStudy.id } });

  // per-bus bindings
  const bind = (studyId, assetId, v, common) => prisma.systemStudyAsset.upsert({
    where: { studyId_assetId: { studyId, assetId } },
    update: {},
    create: {
      accountId: DEMO_ACCOUNT_ID, studyId, assetId,
      busName: common.busName, nominalVoltage: common.nominalVoltage, upstreamDevice: common.upstream,
      incidentEnergyCalCm2: v.ie, arcFlashBoundaryIn: v.afb, workingDistanceIn: 18, ppeCategory: v.ppe,
      boltedFaultCurrentKA: v.bolted, arcingCurrentKA: v.arcing, clearingTimeMs: v.clearing,
      electrodeConfig: 'VCB', conductorGapMm: 32,
      ...(v.reqArc ? { requiredArcRatingCalCm2: v.reqArc } : {}),
      ...(v.sev ? { labelSeverity: v.sev } : {}),
    },
  });
  for (const b of spec.bind) {
    await bind(priorStudy.id, id[b.model], b.prior, b);
    await bind(curStudy.id, id[b.model], b.cur, b);
  }

  const assets = await prisma.asset.count({ where: { siteId } });
  console.log('[cn-drift] ' + spec.name + ': site=' + siteId + ' assets=' + assets
    + ' studies=2 boundBuses=' + spec.bind.length + ' (prior ' + spec.priorDate.getFullYear()
    + ' -> current ' + spec.curDate.getFullYear() + ')');
  for (const b of spec.bind) console.log('    ' + b.busName + ': ' + b.prior.ie + ' -> ' + b.cur.ie + ' cal/cm2');
}

async function run(prisma) {
  const acct = await prisma.account.findFirst({ where: { id: DEMO_ACCOUNT_ID }, select: { id: true, companyName: true } });
  if (!acct) { console.log('SKIP: pinned demo account not found (' + DEMO_ACCOUNT_ID + ')'); return; }
  console.log('Seeding Cedar Hollow + Northgate drift demo into account: ' + (acct.companyName || acct.id));
  for (const spec of SITES) await seedSite(prisma, spec);
  console.log('OK: cedar-northgate drift demo seeded (2 sites, 4 studies, 5 drift buses).');
}

module.exports = { run };

// Standalone CLI (also invoked from seed-demo.js's resetAndSeedDemo via run(prisma)).
if (require.main === module) {
  const prisma = new PrismaClient();
  run(prisma).then(() => prisma.$disconnect()).catch(async (e) => { console.error('SEED ERROR', e); await prisma.$disconnect(); process.exit(1); });
}
