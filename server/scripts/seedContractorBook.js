'use strict';
/**
 * seedContractorBook.js -- realistic "contractor with a sales team" demo data.
 *
 * Seeds the Model A partner-org path (the standalone Meridian demo stays as-is):
 *   PartnerOrganization "Apex Power Services" (the contractor)
 *     -> 1 oem_admin sales manager  (gets the manager roll-up)
 *     -> 4 reps                     (each gets a rep email for their book)
 *     -> 6 customer Accounts (partnerOrgId + assignedRepId), each with 2 sites,
 *        a handful of assets in varied condition + due buckets, and a couple
 *        "trending" deficiencies so the digest's compliance bars, dollar
 *        pipeline, and trend flags all show variety.
 *
 * Idempotent: fixed UUIDs for the org + accounts; reset-by-id wipes a prior run
 * before re-creating. Hooked into resetAndSeedDemo so it survives the nightly
 * demo reset. ASCII-only on purpose (heredoc writes mangle non-ASCII).
 */

const bcrypt = require('bcryptjs');

// ---- fixed ids (valid uuid v4 shape) ----
const ORG_ID  = '22222222-2222-4222-8222-222222222222';
const HOME_ID = '22222222-0000-4000-8000-000000000000';
const CUST_ID = n => `22222222-0000-4000-8000-00000000000${n}`; // 1..6

const SHARED_PW = 'Demo1234!';

// ---- date / condition / interval helpers (mirror seed-demo.js) ----
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function addMonths(date, months) { const d = new Date(date); d.setMonth(d.getMonth() + months); return d; }
const SEV = { C1: 1, C2: 2, C3: 3 };
function worstCondition(...rs) { let w = null; for (const r of rs) { if (!r || !SEV[r]) continue; if (w === null || SEV[r] > SEV[w]) w = r; } return w || 'C2'; }
function intervalMonthsFor(def, cond) {
  const base = def.intervalC2Months;
  if (cond === 'C1') return def.intervalC1Months != null ? def.intervalC1Months : Math.min(Math.round(base * 2.5), 60);
  if (cond === 'C3') return def.intervalC3Months != null ? def.intervalC3Months : Math.max(1, Math.min(Math.round(base * 0.25), 12));
  return base;
}
const CONDITION_SCORE = { C1: 2, C2: 3, C3: 4 };

// ---- the book: 4 reps, 6 customers ----
// asset = [equipmentType, manufacturer, model, condition, dueInDays, criticality(1-5), ageYears, rulScore, trend?]
const MANAGER = { name: 'Sam Carter', email: 'sam.carter@apexpower.demo', role: 'oem_admin' };
const REPS = [
  { key: 'lin',    name: 'Sarah Lin',   email: 'sarah.lin@apexpower.demo',   phone: '(414) 555-0118' },
  { key: 'torres', name: 'Mike Torres', email: 'mike.torres@apexpower.demo', phone: '(815) 555-0142' },
  { key: 'nair',   name: 'Priya Nair',  email: 'priya.nair@apexpower.demo',  phone: '(630) 555-0177' },
  { key: 'cole',   name: 'Dan Cole',    email: 'dan.cole@apexpower.demo',    phone: '(262) 555-0193' },
];

const CUSTOMERS = [
  // Sarah Lin -- healthy book
  { id: CUST_ID(1), name: 'Lakeside Foods', rep: 'lin', sites: [
    { name: 'Lakeside Plant 1', city: 'Green Bay', state: 'WI', assets: [
      ['SWITCHGEAR', 'Square D', 'QED-2', 'C1', 150, 3, 8, 0.30, false],
      ['TRANSFORMER_DRY', 'Eaton', 'DT-115', 'C1', 210, 2, 6, 0.18, false] ] },
    { name: 'Lakeside Cold Storage', city: 'Green Bay', state: 'WI', assets: [
      ['MCC', 'Allen-Bradley', 'CENTERLINE 2100', 'C2', 95, 3, 11, 0.42, false] ] },
  ] },
  { id: CUST_ID(2), name: 'Granite Ridge Hospital', rep: 'lin', sites: [
    { name: 'Main Hospital', city: 'Madison', state: 'WI', assets: [
      ['TRANSFORMER_LIQUID', 'ABB', 'PadMount 1500', 'C2', -30, 5, 18, 0.66, false],
      ['SWITCHGEAR', 'GE', 'Powervac', 'C2', 120, 4, 14, 0.55, false] ] },
    { name: 'Medical Office Building', city: 'Madison', state: 'WI', assets: [
      ['PANELBOARD', 'Square D', 'NQ', 'C2', 60, 3, 9, 0.30, false] ] },
  ] },
  // Mike Torres -- mixed / struggling book
  { id: CUST_ID(3), name: 'Northwind Logistics', rep: 'torres', sites: [
    { name: 'Distribution Hub', city: 'Joliet', state: 'IL', assets: [
      ['SWITCHGEAR', 'Siemens', 'GM-SG', 'C3', -20, 4, 22, 0.92, true],
      ['TRANSFORMER_DRY', 'Hammond', 'C3DRY', 'C3', -60, 4, 24, 1.05, false] ] },
    { name: 'Cross-Dock 2', city: 'Joliet', state: 'IL', assets: [
      ['MCC', 'Eaton', 'Freedom 2100', 'C2', 100, 3, 13, 0.50, false],
      ['CIRCUIT_BREAKER', 'Square D', 'PowerPact', 'C3', -45, 3, 16, 0.70, true] ] },
  ] },
  { id: CUST_ID(4), name: 'Cedar Valley Utilities', rep: 'torres', sites: [
    { name: 'Substation 4', city: 'Cedar Rapids', state: 'IA', assets: [
      ['TRANSFORMER_LIQUID', 'Cooper', 'VFI', 'C2', -40, 5, 26, 0.78, false],
      ['PROTECTION_RELAY', 'SEL', '751A', 'C2', 80, 4, 10, 0.40, false] ] },
    { name: 'Control House', city: 'Cedar Rapids', state: 'IA', assets: [
      ['PANELBOARD', 'GE', 'Spectra', 'C2', 165, 2, 7, 0.22, false] ] },
  ] },
  // Priya Nair -- strong single account
  { id: CUST_ID(5), name: 'Summit Data Center', rep: 'nair', sites: [
    { name: 'DC-East', city: 'Aurora', state: 'IL', assets: [
      ['SWITCHGEAR', 'ABB', 'SafeGear', 'C1', 130, 5, 5, 0.20, false],
      ['UPS_BATTERY', 'Vertiv', 'Liebert APM', 'C2', 95, 5, 4, 0.35, false] ] },
    { name: 'DC-West', city: 'Aurora', state: 'IL', assets: [
      ['TRANSFORMER_DRY', 'Eaton', 'DT-225', 'C1', 200, 4, 6, 0.18, false],
      ['TRANSFER_SWITCH', 'ASCO', '7000', 'C2', 150, 4, 8, 0.30, false] ] },
  ] },
  // Dan Cole -- distressed single account
  { id: CUST_ID(6), name: 'Harbor Point Marina', rep: 'cole', sites: [
    { name: 'Shore Power Yard', city: 'Racine', state: 'WI', assets: [
      ['PANELBOARD', 'Square D', 'I-Line', 'C3', -15, 3, 19, 0.85, true],
      ['TRANSFORMER_DRY', 'Hammond', 'Marine', 'C3', -70, 4, 27, 1.10, false] ] },
    { name: 'Fuel Dock', city: 'Racine', state: 'WI', assets: [
      ['DISCONNECT_SWITCH', 'Eaton', 'DH', 'C2', 55, 2, 12, 0.40, false] ] },
  ] },
];

async function _resetContractorBook(prisma) {
  const ids = [HOME_ID, CUST_ID(1), CUST_ID(2), CUST_ID(3), CUST_ID(4), CUST_ID(5), CUST_ID(6)];
  const f = { accountId: { in: ids } };
  await prisma.maintenanceSchedule.deleteMany({ where: f }).catch(() => {});
  await prisma.deficiency.deleteMany({ where: f }).catch(() => {});
  await prisma.asset.deleteMany({ where: f }).catch(() => {});
  await prisma.accountSetting.deleteMany({ where: f }).catch(() => {});
  await prisma.site.deleteMany({ where: f }).catch(() => {});
  await prisma.alertPreference.deleteMany({ where: { user: { accountId: { in: ids } } } }).catch(() => {});
  await prisma.userPreference.deleteMany({ where: { user: { accountId: { in: ids } } } }).catch(() => {});
  await prisma.aiUsage.deleteMany({ where: { user: { accountId: { in: ids } } } }).catch(() => {});
  await prisma.refreshToken.deleteMany({ where: { user: { accountId: { in: ids } } } }).catch(() => {});
  // Null out assigned-rep links before deleting users/accounts (SetNull anyway).
  await prisma.account.updateMany({ where: { id: { in: ids } }, data: { assignedRepId: null, fallbackRepId: null } }).catch(() => {});
  await prisma.user.deleteMany({ where: f }).catch(() => {});
  await prisma.account.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await prisma.partnerOrganization.delete({ where: { id: ORG_ID } }).catch(() => {});
}

async function _loadDefsByType(prisma) {
  const defs = await prisma.maintenanceTaskDefinition.findMany({ where: { accountId: null, archivedAt: null } });
  const byType = {};
  for (const d of defs) (byType[d.equipmentType] = byType[d.equipmentType] || []).push(d);
  return byType;
}

async function seedContractorBook(prisma) {
  await _resetContractorBook(prisma);
  const now = new Date();
  const defsByType = await _loadDefsByType(prisma);
  const pw = await bcrypt.hash(SHARED_PW, 12);

  // Partner org + contractor "home" account that hosts the manager + reps.
  // Idempotent: a prior reseed can leave the org/account row undeletable when
  // partner-flywheel cron records (account-scoped, onDelete RESTRICT) still
  // reference it. The asset/site/user children DO delete, so upsert reuses the
  // org/account row and the rest of the book is rebuilt fresh.
  await prisma.partnerOrganization.upsert({
    where: { id: ORG_ID },
    create: { id: ORG_ID, name: 'Apex Power Services' },
    update: { name: 'Apex Power Services' },
  });
  await prisma.account.upsert({
    where: { id: HOME_ID },
    create: {
      id: HOME_ID, companyName: 'Apex Power Services', status: 'active', planType: 'saas',
      partnerOrgId: ORG_ID, lastActiveAt: now,
    },
    update: {
      companyName: 'Apex Power Services', status: 'active', planType: 'saas',
      partnerOrgId: ORG_ID, lastActiveAt: now,
    },
  });

  const manager = await prisma.user.create({ data: {
    accountId: HOME_ID, name: MANAGER.name, email: MANAGER.email, passwordHash: pw,
    role: MANAGER.role, isActive: true,
  } });
  const repByKey = {};
  for (const r of REPS) {
    repByKey[r.key] = await prisma.user.create({ data: {
      accountId: HOME_ID, name: r.name, email: r.email, passwordHash: pw,
      role: 'consultant', isActive: true,
    } });
  }

  let assetCount = 0, schedCount = 0, defCount = 0, customerAdmins = 0;

  for (const c of CUSTOMERS) {
    const rep = repByKey[c.rep];
    await prisma.account.upsert({
      where: { id: c.id },
      create: {
        id: c.id, companyName: c.name, status: 'active', planType: 'saas',
        partnerOrgId: ORG_ID, assignedRepId: rep.id, fallbackRepId: manager.id,
        serviceRepName: rep.name, serviceRepEmail: rep.email, serviceRepPhone: rep.phone, lastActiveAt: now,
      },
      update: {
        companyName: c.name, status: 'active', planType: 'saas',
        partnerOrgId: ORG_ID, assignedRepId: rep.id, fallbackRepId: manager.id,
        serviceRepName: rep.name, serviceRepEmail: rep.email, serviceRepPhone: rep.phone, lastActiveAt: now,
      },
    });
    await prisma.accountSetting.create({ data: { accountId: c.id, key: 'ONBOARDING_COMPLETE', value: 'true' } });

    // A facility admin (the customer's own person) so the value-framed customer
    // digest has a TO recipient. Their digest is CC'd to the rep above.
    const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16);
    await prisma.user.create({ data: {
      accountId: c.id, name: `${c.name} Facilities`, email: `facilities@${slug}.demo`,
      passwordHash: pw, role: 'admin', isActive: true,
    } });
    customerAdmins++;

    for (const s of c.sites) {
      const site = await prisma.site.create({ data: {
        accountId: c.id, name: s.name, city: s.city, state: s.state,
      } });
      for (const a of s.assets) {
        const [type, mfr, model, cond, dueIn, crit, ageYrs, rul, trend] = a;
        const condScore = CONDITION_SCORE[cond] || 3;
        const asset = await prisma.asset.create({ data: {
          accountId: c.id, siteId: site.id, equipmentType: type,
          manufacturer: mfr, model: model,
          serialNumber: `${mfr.slice(0, 3).toUpperCase()}-${Math.floor(100000 + Math.random() * 899999)}`,
          installDate: addDays(now, -Math.round(ageYrs * 365)),
          conditionPhysical: cond, conditionCriticality: cond, conditionEnvironment: 'C2',
          governingCondition: worstCondition(cond, cond, 'C2'),
          conditionScore: condScore, criticalityScore: crit, priorityScore: condScore * crit,
          modernizationRiskScore: rul,
        } });
        assetCount++;

        const defs = defsByType[type] || [];
        for (const def of defs) {
          const interval = intervalMonthsFor(def, asset.governingCondition);
          const nextDue = addDays(now, dueIn);
          const lastCompleted = addMonths(nextDue, -interval);
          await prisma.maintenanceSchedule.create({ data: {
            accountId: c.id, assetId: asset.id, taskDefinitionId: def.id,
            lastCompletedDate: lastCompleted, nextDueDate: nextDue,
          } });
          schedCount++;
        }

        if (trend) {
          await prisma.deficiency.create({ data: {
            accountId: c.id, assetId: asset.id, severity: 'ADVISORY',
            description: 'IR temperature delta trending up 14% over the last 3 scans - monitor and schedule service.',
          } });
          defCount++;
        }
      }
    }
  }

  const summary = { orgId: ORG_ID, customers: CUSTOMERS.length, reps: REPS.length, customerAdmins, assets: assetCount, schedules: schedCount, trends: defCount };
  console.log('[seedContractorBook] done', JSON.stringify(summary));
  return summary;
}

module.exports = { seedContractorBook, _resetContractorBook, ORG_ID, HOME_ID };

// CLI: `node scripts/seedContractorBook.js`
if (require.main === module) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  seedContractorBook(prisma)
    .then(() => prisma.$disconnect())
    .then(() => process.exit(0))
    .catch(e => { console.error('[seedContractorBook] FAILED', e); prisma.$disconnect().finally(() => process.exit(1)); });
}
