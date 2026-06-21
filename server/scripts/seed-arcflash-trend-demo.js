/*
 * seed-arcflash-trend-demo.js
 *
 * Idempotent demo polish for the arc-flash Slice 1 trend card.
 *
 * The base demo seed (seed-demo.js) creates a single arc_flash SystemStudy at
 * Riverside but binds no assets to it, so the per-asset ArcFlashTrend card
 * (which needs >=2 arc_flash studies covering ONE asset) never renders. This
 * script adds a realistic two-study revision history for the 15 kV lead
 * switchgear SWGR-1A-1 (serial NS-96-3311-1):
 *
 *   - Prior study  (~4.2 yr ago):  14.2 cal/cm2  (superseded)
 *   - Current study (~60 days ago): 19.6 cal/cm2  (re-study after the utility
 *                                                  transformer upsizing raised
 *                                                  available fault current)
 *
 * Both are DANGER class (13.8 kV > 600 V per NFPA 70E 130.5(H)); the card shows
 * a red DANGER badge plus the rising incident-energy trend -- the data-trend
 * "moat" the feature is built around.
 *
 * Safe to run repeatedly: it bails if its marked studies already exist, and it
 * only ADDS rows (no deletes). Targets the pinned demo account only.
 *
 * Run inside the server container:
 *   docker exec -T servicecycle-server node scripts/seed-arcflash-trend-demo.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DEMO_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const MARKER = '[af-trend-demo]';
const ASSET_SERIAL = 'NS-96-3311-1'; // SWGR-1A-1, the 15 kV lead switchgear

function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function addMonths(date, months) { const d = new Date(date); d.setMonth(d.getMonth() + months); return d; }

async function main() {
  const now = new Date();

  const site = await prisma.site.findFirst({
    where: { accountId: DEMO_ACCOUNT_ID, name: 'Riverside Plant' },
    select: { id: true, name: true },
  });
  if (!site) { console.log('SKIP: Riverside Plant site not found in demo account'); return; }

  const asset = await prisma.asset.findFirst({
    where: { accountId: DEMO_ACCOUNT_ID, serialNumber: ASSET_SERIAL },
    select: { id: true, equipmentType: true },
  });
  if (!asset) { console.log('SKIP: SWGR-1A-1 (serial ' + ASSET_SERIAL + ') not found'); return; }

  const existing = await prisma.systemStudy.findFirst({
    where: { accountId: DEMO_ACCOUNT_ID, siteId: site.id, notes: { contains: MARKER } },
    select: { id: true },
  });
  if (existing) { console.log('SKIP: trend-demo studies already present (' + existing.id + ')'); return; }

  // Prior study (~4.2 yr ago) -- will be superseded by the current re-study.
  const priorDate = addDays(now, -Math.round(4.2 * 365));
  const prior = await prisma.systemStudy.create({ data: {
    accountId: DEMO_ACCOUNT_ID, siteId: site.id,
    studyType: 'arc_flash', performedDate: priorDate, expiresAt: addMonths(priorDate, 60),
    performedBy: 'Hawthorne Power Engineering, PLLC', method: 'IEEE 1584-2018',
    peName: 'S. Hawthorne, PE', peLicense: 'IA PE 21487', trigger: 'scheduled',
    notes: MARKER + ' Prior incident-energy study at Substation A (SWGR-1A main bus).',
  } });

  // Current re-study (~60 days ago).
  const curDate = addDays(now, -60);
  const current = await prisma.systemStudy.create({ data: {
    accountId: DEMO_ACCOUNT_ID, siteId: site.id,
    studyType: 'arc_flash', performedDate: curDate, expiresAt: addMonths(curDate, 60),
    performedBy: 'Hawthorne Power Engineering, PLLC', method: 'IEEE 1584-2018',
    peName: 'S. Hawthorne, PE', peLicense: 'IA PE 21487', trigger: 'utility_change',
    notes: MARKER + ' Re-study after utility transformer upsizing; available fault current rose ~20->24 kA, raising incident energy at the SWGR-1A main bus.',
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
    busName: 'SWGR-1A Main Bus', nominalVoltage: '13.8kV',
    incidentEnergyCalCm2: 14.2, arcFlashBoundaryIn: 68, workingDistanceIn: 36, ppeCategory: 4,
    boltedFaultCurrentKA: 20.0, arcingCurrentKA: 19.1, electrodeConfig: 'VCB',
    conductorGapMm: 152, clearingTimeMs: 240, upstreamDevice: 'Utility 51 relay / CB-101',
  });
  await bind(current.id, {
    busName: 'SWGR-1A Main Bus', nominalVoltage: '13.8kV',
    incidentEnergyCalCm2: 19.6, arcFlashBoundaryIn: 88, workingDistanceIn: 36, ppeCategory: 4,
    boltedFaultCurrentKA: 24.0, arcingCurrentKA: 22.7, electrodeConfig: 'VCB',
    conductorGapMm: 152, clearingTimeMs: 255, upstreamDevice: 'Utility 51 relay / CB-101',
  });

  console.log('OK: seeded arc-flash trend demo.');
  console.log('  asset=' + asset.id + ' (SWGR-1A-1)');
  console.log('  prior=' + prior.id + ' (14.2 cal/cm2)  current=' + current.id + ' (19.6 cal/cm2)');
  console.log('  Trend: 14.2 -> 19.6 cal/cm2 across 2 arc_flash studies, DANGER (13.8kV).');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error('SEED ERROR', e); await prisma.$disconnect(); process.exit(1); });
