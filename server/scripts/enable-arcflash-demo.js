'use strict';

/**
 * scripts/enable-arcflash-demo.js
 * -------------------------------
 * One-off: turn the demo account's `arc_flash_studies` account-feature flag ON
 * so the per-asset Arc Flash tab + all the arc-flash surfaces are visible without
 * a full reseed. Idempotent — safe to run any number of times.
 *
 * The reseed already writes this flag (seed-demo.js sets arc_flash_studies = true
 * now), so this is only needed to flip an already-seeded demo in place.
 *
 *   docker compose -f /root/ServiceCycle/docker-compose.yml exec -T server \
 *     node scripts/enable-arcflash-demo.js
 *
 * Requires only @prisma/client (compiled JS), so plain `node` runs it.
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DEMO_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const KEY = 'feature.arc_flash_studies';

(async () => {
  const row = await prisma.accountSetting.upsert({
    where:  { accountId_key: { accountId: DEMO_ACCOUNT_ID, key: KEY } },
    update: { value: 'true' },
    create: { accountId: DEMO_ACCOUNT_ID, key: KEY, value: 'true' },
  });
  console.log('[enable-arcflash-demo] ' + KEY + ' = ' + row.value);
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error('[enable-arcflash-demo] failed:', (err && err.message) || err);
  try { await prisma.$disconnect(); } catch (_) {}
  process.exit(1);
});
