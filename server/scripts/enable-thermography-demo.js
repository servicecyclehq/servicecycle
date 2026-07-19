'use strict';

/**
 * scripts/enable-thermography-demo.js
 * -----------------------------------
 * One-off: turn the demo account's `thermography_import` account-feature flag ON
 * so the per-asset IR/thermography tab + the NFPA 70B 7.4 survey surfaces are
 * visible without a full reseed. Idempotent - safe to run any number of times.
 *
 * The reseed also writes this flag (seed-demo.js sets thermography_import = true),
 * so this is only needed to flip an already-seeded demo in place.
 *
 *   docker compose -f /root/ServiceCycle/docker-compose.yml exec -T server \
 *     node scripts/enable-thermography-demo.js
 *
 * Requires only @prisma/client (compiled JS), so plain `node` runs it.
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DEMO_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const KEY = 'feature.thermography_import';

(async () => {
  const row = await prisma.accountSetting.upsert({
    where:  { accountId_key: { accountId: DEMO_ACCOUNT_ID, key: KEY } },
    update: { value: 'true' },
    create: { accountId: DEMO_ACCOUNT_ID, key: KEY, value: 'true' },
  });
  console.log('[enable-thermography-demo] ' + KEY + ' = ' + row.value);
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error('[enable-thermography-demo] failed:', (err && err.message) || err);
  try { await prisma.$disconnect(); } catch (_) {}
  process.exit(1);
});
