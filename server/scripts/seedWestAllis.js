'use strict';
/**
 * seedWestAllis.js -- a dedicated "West Allis Energy" account for the email-in (#6)
 * demo. Inbound reports forwarded to reports-westallis@servicecycle.app land here
 * and auto-create asset cards, so the whole pipeline is easy to find + verify in
 * isolation from the Meridian demo data.
 *
 * Idempotent: fixed UUIDs, reset-by-id before recreate. ASCII-only (heredoc-safe).
 */

const bcrypt = require('bcryptjs');

const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ID    = '33333333-0000-4000-8000-000000000001';
const ADMIN_EMAIL = 'admin@westallis.energy';
const ADMIN_PW    = 'WestAllis1234!';
const INBOUND_SLUG = 'westallis';

async function _reset(prisma) {
  const f = { accountId: ACCOUNT_ID };
  await prisma.testMeasurement.deleteMany({ where: f }).catch(() => {});
  await prisma.deficiency.deleteMany({ where: f }).catch(() => {});
  await prisma.maintenanceSchedule.deleteMany({ where: f }).catch(() => {});
  await prisma.workOrder.deleteMany({ where: f }).catch(() => {});
  await prisma.asset.deleteMany({ where: f }).catch(() => {});
  await prisma.accountSetting.deleteMany({ where: f }).catch(() => {});
  await prisma.ingestJob.deleteMany({ where: f }).catch(() => {});
  await prisma.site.deleteMany({ where: f }).catch(() => {});
  await prisma.refreshToken.deleteMany({ where: { user: { accountId: ACCOUNT_ID } } }).catch(() => {});
  await prisma.user.deleteMany({ where: f }).catch(() => {});
  await prisma.account.deleteMany({ where: { id: ACCOUNT_ID } }).catch(() => {});
}

async function seedWestAllis(prisma) {
  await _reset(prisma);
  const now = new Date();
  const pw = await bcrypt.hash(ADMIN_PW, 12);

  await prisma.account.create({ data: {
    id: ACCOUNT_ID, companyName: 'West Allis Energy', status: 'active', planType: 'saas', lastActiveAt: now,
  } });
  await prisma.user.create({ data: {
    accountId: ACCOUNT_ID, name: 'West Allis Admin', email: ADMIN_EMAIL, passwordHash: pw,
    role: 'admin', isActive: true,
  } });
  await prisma.site.create({ data: {
    id: SITE_ID, accountId: ACCOUNT_ID, name: 'West Allis Works', address: '1 Industrial Pkwy',
    city: 'West Allis', state: 'WI', postalCode: '53214',
  } });

  // Inbound routing: reports-westallis@servicecycle.app -> this account.
  await prisma.accountSetting.create({ data: { accountId: ACCOUNT_ID, key: 'inbound_slug', value: INBOUND_SLUG } });
  await prisma.accountSetting.create({ data: { accountId: ACCOUNT_ID, key: 'inbound_site_id', value: SITE_ID } });
  await prisma.accountSetting.create({ data: { accountId: ACCOUNT_ID, key: 'ONBOARDING_COMPLETE', value: 'true' } });

  const summary = { accountId: ACCOUNT_ID, siteId: SITE_ID, admin: ADMIN_EMAIL, inboundSlug: INBOUND_SLUG };
  console.log('[seedWestAllis] done', JSON.stringify(summary));
  return summary;
}

module.exports = { seedWestAllis, _resetWestAllis: _reset, WEST_ALLIS_ACCOUNT_ID: ACCOUNT_ID, WEST_ALLIS_SITE_ID: SITE_ID, WEST_ALLIS_SLUG: INBOUND_SLUG };

if (require.main === module) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  seedWestAllis(prisma)
    .then(() => prisma.$disconnect())
    .then(() => process.exit(0))
    .catch(e => { console.error('[seedWestAllis] FAILED', e); prisma.$disconnect().finally(() => process.exit(1)); });
}
