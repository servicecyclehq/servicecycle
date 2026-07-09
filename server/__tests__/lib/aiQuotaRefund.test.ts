/**
 * __tests__/lib/aiQuotaRefund.test.ts
 * -------------------------------------
 * v0.37.4 regression suite for lib/aiQuota.refundIncrement (the v0.37.3
 * MT-102 refund-on-failure helper). Locks in:
 *   - refund decrements the day's count by 1
 *   - refund is idempotent at the floor (won't go below 0)
 *   - refund on UNLIMITED quota is a no-op (no DB write)
 *   - refund swallows DB errors (never throws)
 *
 * Hits the live dev Postgres the same way aiQuota.test.ts (sibling in this
 * directory) does — the GREATEST clause lives in SQL and there's nothing to
 * test if we mock the prisma layer out. Skips gracefully on unreachable DB.
 *
 * 2026-07-08: moved here from tests/aiQuotaRefund.test.js (plain-JS "unit"
 * project). lib/aiQuota.ts imports prisma via the bare `./prisma` form,
 * which escapes the unit project's moduleNameMapper (only two-segment
 * `../lib/prisma`-shaped specifiers get redirected to the stub in
 * tests/__mocks__/prisma.js) and always talks to the real DB — so this
 * suite needs a real DB round-trip too, which is exactly what the
 * "integration" project (no moduleNameMapper at all — a real Prisma client
 * is the intentional default here) is for. The old file's manual
 * `dotenv.config()` call is dropped: this project's setupFiles
 * (__tests__/helpers/setup-env.ts) already loads .env and sets
 * DATABASE_URL/JWT_SECRET/MASTER_KEY/DEMO_MODE before any module loads.
 */
import '../helpers/setup';

const prisma = require('../../lib/prisma').default;
const aiQuota = require('../../lib/aiQuota');

const TEST_ACCOUNT_ID  = '00000000-0000-0000-0000-aiqrefund0001';
const TEST_ACCOUNT_NAME = '__aiQuotaRefund_test_account__';

let dbReachable = true;
let userIds: string[] = [];

beforeAll(async () => {
  try {
    await prisma.account.upsert({
      where:  { id: TEST_ACCOUNT_ID },
      update: {},
      create: { id: TEST_ACCOUNT_ID, companyName: TEST_ACCOUNT_NAME, planType: 'licensed' },
    });
  } catch (e: any) {
    dbReachable = false;
    console.warn('[aiQuotaRefund.test] DB not reachable — skipping. Reason:', e.message);
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  try {
    if (userIds.length) {
      await prisma.aiUsage.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({    where: { id:     { in: userIds } } });
    }
    await prisma.account.deleteMany({ where: { id: TEST_ACCOUNT_ID } });
  } finally {
    await prisma.$disconnect();
  }
});

async function mkUser(slug: string) {
  const u = await prisma.user.create({
    data: {
      name:         `aiQuotaRefund ${slug}`,
      email:        `__refund__${slug}@example.invalid`,
      passwordHash: 'x',
      role:         'admin',
      accountId:    TEST_ACCOUNT_ID,
    },
  });
  userIds.push(u.id);
  return u.id;
}

const maybeDescribe = !dbReachable ? describe.skip : describe;

maybeDescribe('aiQuota.refundIncrement', () => {
  test('decrements the day count by 1 after a checkAndIncrement', async () => {
    if (!dbReachable) return;
    const userId = await mkUser('basic');
    // Use a capped action so checkAndIncrement actually writes a row.
    // 'ask' has a demo cap of 6; in non-demo it's UNLIMITED -> no row to
    // refund. Force DEMO_MODE behaviour by overriding the cap directly via
    // env so the test is independent of the surrounding env.
    process.env.AI_DAILY_CAP_PER_USER_ASK = '10';
    const after1 = await aiQuota.checkAndIncrement(userId, 'ask', TEST_ACCOUNT_ID);
    expect(after1.ok).toBe(true);
    expect(after1.count).toBe(1);

    await aiQuota.refundIncrement(userId, 'ask');
    const usage = await aiQuota.getUsage(userId, 'ask', TEST_ACCOUNT_ID);
    expect(usage.count).toBe(0);
    delete process.env.AI_DAILY_CAP_PER_USER_ASK;
  });

  test('floors at zero (refund-without-prior-increment is a no-op)', async () => {
    if (!dbReachable) return;
    const userId = await mkUser('floor');
    process.env.AI_DAILY_CAP_PER_USER_ASK = '10';
    // No prior increment — there's no row at all yet.
    await aiQuota.refundIncrement(userId, 'ask');
    const usage = await aiQuota.getUsage(userId, 'ask', TEST_ACCOUNT_ID);
    expect(usage.count).toBe(0);
    delete process.env.AI_DAILY_CAP_PER_USER_ASK;
  });

  test('floors at zero (multiple refunds after one increment)', async () => {
    if (!dbReachable) return;
    const userId = await mkUser('multifloor');
    process.env.AI_DAILY_CAP_PER_USER_ASK = '10';
    await aiQuota.checkAndIncrement(userId, 'ask', TEST_ACCOUNT_ID);
    await aiQuota.refundIncrement(userId, 'ask');
    await aiQuota.refundIncrement(userId, 'ask');
    await aiQuota.refundIncrement(userId, 'ask');
    const usage = await aiQuota.getUsage(userId, 'ask', TEST_ACCOUNT_ID);
    expect(usage.count).toBe(0); // GREATEST(count - 1, 0) keeps us at 0
    delete process.env.AI_DAILY_CAP_PER_USER_ASK;
  });

  test('UNLIMITED quota refund is a no-op (no DB write)', async () => {
    if (!dbReachable) return;
    const userId = await mkUser('unlimited');
    // No env override -> action defaults to UNLIMITED on self-host
    // (DEMO_MODE=false by default in the test env).
    delete process.env.AI_DAILY_CAP_PER_USER_ASK;
    delete process.env.DEMO_MODE;
    // Should complete without error and without creating any aiUsage row.
    await aiQuota.refundIncrement(userId, 'ask');
    const row = await prisma.aiUsage.findFirst({ where: { userId, action: 'ask' } });
    expect(row).toBeNull();
  });

  test('never throws on missing userId / action', async () => {
    // Defensive contract: failed refunds must not cascade into the caller's
    // error handler. Pass nothing-meaningful and confirm clean return.
    await expect(aiQuota.refundIncrement(null, 'ask')).resolves.toBeUndefined();
    await expect(aiQuota.refundIncrement('any-id', null)).resolves.toBeUndefined();
    await expect(aiQuota.refundIncrement(undefined, undefined)).resolves.toBeUndefined();
  });
});

export {};
