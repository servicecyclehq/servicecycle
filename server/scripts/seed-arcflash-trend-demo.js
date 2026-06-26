/*
 * seed-arcflash-trend-demo.js
 *
 * Idempotent demo polish for the arc-flash Slice 1 trend card.
 *
 * The base demo seed (seed-demo.js) creates a single arc_flash SystemStudy at
 * Riverside but binds no assets to it, so the per-asset ArcFlashTrend card
 * (which needs >=2 arc_flash studies covering ONE asset) never renders. This
 * script adds a realistic two-study revision history for a Riverside switchgear
 * bus so the trend card lights up.
 *
 * It auto-picks the subject asset (prefers a medium-voltage switchgear so the
 * label is DANGER class per NFPA 70E 130.5(H); falls back to any switchgear,
 * then any asset) and tailors the incident-energy story to the bus voltage:
 *   - MV bus: 14.2 -> 19.6 cal/cm2, DANGER (13.8 kV > 600 V)
 *   - LV bus:  8.4 -> 12.1 cal/cm2, WARNING, rising trend
 * Either way the re-study (after a utility transformer upsizing raised the
 * available fault current) shows incident energy climbing across revisions --
 * the data-trend "moat" the feature is built around.
 *
 * Safe to run repeatedly: bails if its marked studies already exist; only ADDS
 * rows. Targets the pinned demo account only.
 *
 * Run inside the server container:
 *   docker exec servicecycle-server node scripts/seed-arcflash-trend-demo.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DEMO_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const MARKER = '[af-trend-demo]';

function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function addMonths(date, months) { const d = new Date(date); d.setMonth(d.getMonth() + months); return d; }

// Heuristic: is this nameplate a medium-voltage (>600 V) bus? Scans the JSON
// blob for a "<num> kV" hint or an explicit high voltageClass.
function isMediumVoltage(nameplateData) {
  if (!nameplateData) return false;
  const blob = JSON.stringify(nameplateData).toLowerCase();
  const m = blob.match(/(\d+(?:\.\d+)?)\s*kv/);
  if (m) {
    const kv = parseFloat(m[1]);
    if (isFinite(kv) && kv >= 1) return true;
  }
  return false;
}

function describe(a) {
  return [a.equipmentType, a.manufacturer, a.model, a.serialNumber].filter(Boolean).join(' / ');
}

// Consumer/appliance brands that have leaked into the demo as mis-typed
// "switchgear" via test ingestion -- never a credible arc-flash subject.
const JUNK_MFR = /electrolux|frigidaire|whirlpool|samsung|lg electronics|ge appliances|home products|kenmore|maytag|bosch home/i;

// Rank real electrical-distribution equipment so we attach the trend to a
// believable bus, not a random asset.
const TYPE_RANK = { SWITCHGEAR: 5, SWITCHBOARD: 4, MCC: 4, PANELBOARD: 3, BUSWAY: 2, TRANSFORMER_LIQUID: 2, TRANSFORMER_DRY: 2 };

// Higher = better arc-flash demo subject.
function score(a) {
  let s = TYPE_RANK[a.equipmentType] || 0;
  if (s === 0) return -100; // not distribution equipment
  if (JUNK_MFR.test(a.manufacturer || '') || JUNK_MFR.test(a.model || '')) return -100;
  const blob = JSON.stringify(a.nameplateData || {}).toLowerCase();
  if (/voltageclass|busrating|"aic"|kaic/.test(blob)) s += 3; // real switchgear nameplate
  if (isMediumVoltage(a.nameplateData)) s += 5;               // MV -> DANGER story
  return s;
}

async function main() {
  const now = new Date();

  const site = await prisma.site.findFirst({
    where: { accountId: DEMO_ACCOUNT_ID, name: 'Riverside Plant' },
    select: { id: true, name: true },
  });
  if (!site) { console.log('SKIP: Riverside Plant site not found in demo account'); return; }

  // Re-runnable: clear any prior trend-demo studies (cascade drops their
  // bindings) so we can always re-target the best available asset.
  const priorMarked = await prisma.systemStudy.findMany({
    where: { accountId: DEMO_ACCOUNT_ID, siteId: site.id, notes: { contains: MARKER } },
    select: { id: true },
  });
  if (priorMarked.length) {
    const ids = priorMarked.map((s) => s.id);
    await prisma.systemStudy.updateMany({ where: { id: { in: ids } }, data: { supersededById: null } });
    await prisma.systemStudy.deleteMany({ where: { id: { in: ids } } });
    console.log('Reset: removed ' + ids.length + ' prior trend-demo studies.');
  }

  // Inventory all Riverside assets, then pick the most credible distribution
  // bus (scored: type rank + real switchgear nameplate + MV; junk excluded).
  const all = await prisma.asset.findMany({
    where: { accountId: DEMO_ACCOUNT_ID, siteId: site.id, archivedAt: null },
    select: { id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true, nameplateData: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log('Riverside assets (' + all.length + '):');
  for (const a of all) console.log('  [score ' + score(a) + '] ' + describe(a));

  const ranked = all.filter((a) => score(a) > 0).sort((x, y) => score(y) - score(x));
  const asset = ranked[0] || null;
  if (!asset) { console.log('SKIP: no credible distribution asset at Riverside to attach a study to'); return; }

  const mv = isMediumVoltage(asset.nameplateData);
  const nominalVoltage = mv ? '13.8kV' : '480V';
  const priorIE = mv ? 14.2 : 8.4;
  const curIE = mv ? 19.6 : 12.1;
  const priorAFB = mv ? 68 : 38;
  const curAFB = mv ? 88 : 54;
  const wd = mv ? 36 : 18;
  const gap = mv ? 152 : 32;
  const priorBolted = mv ? 20.0 : 22.0;
  const curBolted = mv ? 24.0 : 28.0;
  const priorArc = mv ? 19.1 : 12.4;
  const curArc = mv ? 22.7 : 15.6;

  console.log('Subject asset: ' + asset.id + '  [' + describe(asset) + ']  voltage=' + (mv ? 'MV' : 'LV'));

  // Prior study (~4.2 yr ago) -- will be superseded by the current re-study.
  const priorDate = addDays(now, -Math.round(4.2 * 365));
  const prior = await prisma.systemStudy.create({ data: {
    accountId: DEMO_ACCOUNT_ID, siteId: site.id,
    studyType: 'arc_flash', performedDate: priorDate, expiresAt: addMonths(priorDate, 60),
    performedBy: 'Hawthorne Power Engineering, PLLC', method: 'IEEE 1584-2018',
    peName: 'S. Hawthorne, PE', peLicense: 'IA PE 21487', trigger: 'scheduled',
    notes: MARKER + ' Prior incident-energy study at Substation A.',
  } });

  // Current re-study (~60 days ago).
  const curDate = addDays(now, -60);
  const current = await prisma.systemStudy.create({ data: {
    accountId: DEMO_ACCOUNT_ID, siteId: site.id,
    studyType: 'arc_flash', performedDate: curDate, expiresAt: addMonths(curDate, 60),
    performedBy: 'Hawthorne Power Engineering, PLLC', method: 'IEEE 1584-2018',
    peName: 'S. Hawthorne, PE', peLicense: 'IA PE 21487', trigger: 'utility_change',
    notes: MARKER + ' Re-study after utility transformer upsizing; available fault current rose, raising incident energy at the bus.',
  } });

  // Prior is superseded BY current (so isCurrent flags resolve correctly).
  await prisma.systemStudy.update({ where: { id: prior.id }, data: { supersededById: current.id } });

  async function bind(studyId, d) {
    await prisma.systemStudyAsset.upsert({
      where:  { studyId_assetId: { studyId, assetId: asset.id } },
      update: d,
      create: { ...d, accountId: DEMO_ACCOUNT_ID, studyId, assetId: asset.id },
    });
  }

  await bind(prior.id, {
    busName: 'SWGR-1A Main Bus', nominalVoltage,
    incidentEnergyCalCm2: priorIE, arcFlashBoundaryIn: priorAFB, workingDistanceIn: wd, ppeCategory: 3,
    boltedFaultCurrentKA: priorBolted, arcingCurrentKA: priorArc, electrodeConfig: 'VCB',
    conductorGapMm: gap, clearingTimeMs: 240, upstreamDevice: 'Utility 51 relay / CB-101',
  });
  await bind(current.id, {
    busName: 'SWGR-1A Main Bus', nominalVoltage,
    incidentEnergyCalCm2: curIE, arcFlashBoundaryIn: curAFB, workingDistanceIn: wd, ppeCategory: 3,
    boltedFaultCurrentKA: curBolted, arcingCurrentKA: curArc, electrodeConfig: 'VCB',
    conductorGapMm: gap, clearingTimeMs: 255, upstreamDevice: 'Utility 51 relay / CB-101',
  });

  console.log('OK: seeded arc-flash trend demo.');
  console.log('  prior=' + prior.id + ' (' + priorIE + ' cal/cm2)  current=' + current.id + ' (' + curIE + ' cal/cm2)');
  console.log('  Trend: ' + priorIE + ' -> ' + curIE + ' cal/cm2 across 2 arc_flash studies, ' + (mv ? 'DANGER (13.8kV)' : 'WARNING (480V)') + '.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error('SEED ERROR', e); await prisma.$disconnect(); process.exit(1); });
