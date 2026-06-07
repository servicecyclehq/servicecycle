'use strict';

/**
 * L3: Per-visitor demo account lifecycle tests.
 *
 * Hits the live dev Postgres because the prune logic is mostly SQL —
 * mocking Prisma would defeat the test's purpose. Cleans up after itself
 * even on failure so re-runs are safe. Skips gracefully if the DB isn't
 * reachable so this file doesn't red-flag pure offline lints.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const prisma = require('../lib/prisma');
const {
  pruneAccount,
  pruneInactiveDemoAccounts,
  getTtlDays,
  getMaxAccounts,
} = require('../lib/demoPrune');
const { DEMO_ACCOUNT_ID, seedAccountForUser } = require('../scripts/seed-demo');

const TEST_PREFIX = '__demoPrune_test__';
const trackedAccounts = new Set();

let dbReachable = true;

beforeAll(async () => {
  try {
    // Cheap connectivity probe so we can downgrade to skipped tests if
    // there's no Postgres.
    await prisma.$queryRaw`SELECT 1`;
  } catch (e) {
    dbReachable = false;
    console.warn('[demoPrune.test] DB not reachable — skipping. Reason:', e.message);
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  // Best-effort cleanup of any account this test file created.
  for (const id of trackedAccounts) {
    try { await pruneAccount(id); } catch (_e) { /* ignore */ }
  }
  await prisma.$disconnect();
});

async function makeDemoAccount({ daysOld, lastActiveDaysAgo, suffix }) {
  const id  = `aaaaaaaa-aaaa-4aaa-aaaa-${String(suffix).padStart(12, 'a')}`;
  const now = new Date();
  const createdAt    = new Date(now.getTime() - daysOld          * 86_400_000);
  const lastActiveAt = lastActiveDaysAgo == null
    ? null
    : new Date(now.getTime() - lastActiveDaysAgo * 86_400_000);

  // Use raw SQL for createdAt because Prisma's create() ignores it (auto @default).
  await prisma.$executeRaw`
    INSERT INTO accounts ("id", "companyName", "status", "planType", "planTier",
                          "createdAt", "updatedAt", "lastActiveAt")
    VALUES (${id}, ${TEST_PREFIX + suffix}, 'active'::"AccountStatus", 'saas'::"PlanType",
            'small'::"PlanTier", ${createdAt}, ${createdAt}, ${lastActiveAt})
  `;
  trackedAccounts.add(id);

  // One user under each account so seedAccountForUser can target them.
  await prisma.user.create({
    data: {
      accountId: id,
      name:  TEST_PREFIX + suffix,
      email: `${TEST_PREFIX}${suffix}@test.invalid`,
      passwordHash: 'x',
      role:  'admin',
    },
  });
  return id;
}

describe('demoPrune.getTtlDays / getMaxAccounts', () => {
  const ORIG_TTL = process.env.DEMO_INACTIVITY_TTL_DAYS;
  const ORIG_CAP = process.env.DEMO_MAX_ACCOUNTS;
  afterEach(() => {
    process.env.DEMO_INACTIVITY_TTL_DAYS = ORIG_TTL;
    process.env.DEMO_MAX_ACCOUNTS        = ORIG_CAP;
  });

  test('defaults: TTL=5 days, cap=1000', () => {
    delete process.env.DEMO_INACTIVITY_TTL_DAYS;
    delete process.env.DEMO_MAX_ACCOUNTS;
    expect(getTtlDays()).toBe(5);
    expect(getMaxAccounts()).toBe(1000);
  });
  test('numeric env wins', () => {
    process.env.DEMO_INACTIVITY_TTL_DAYS = '14';
    process.env.DEMO_MAX_ACCOUNTS        = '50';
    expect(getTtlDays()).toBe(14);
    expect(getMaxAccounts()).toBe(50);
  });
  test('non-numeric env falls back to default', () => {
    process.env.DEMO_INACTIVITY_TTL_DAYS = 'forever';
    process.env.DEMO_MAX_ACCOUNTS        = 'unlimited';
    expect(getTtlDays()).toBe(5);
    expect(getMaxAccounts()).toBe(1000);
  });
});

describe('pruneAccount safety', () => {
  test('refuses to prune the legacy DEMO_ACCOUNT_ID', async () => {
    await expect(pruneAccount(DEMO_ACCOUNT_ID)).rejects.toThrow(/legacy/);
  });
  test('throws on missing accountId', async () => {
    await expect(pruneAccount(null)).rejects.toThrow(/accountId/);
  });
  test('returns deleted:false on already-gone accountId (idempotent)', async () => {
    if (!dbReachable) return;
    const r = await pruneAccount('00000000-0000-0000-0000-doesnotexists');
    expect(r.deleted).toBe(false);
  });
});

describe('pruneInactiveDemoAccounts (live DB)', () => {
  // Pin TTL/cap small so we don't have to fabricate hundreds of accounts.
  const ORIG_TTL = process.env.DEMO_INACTIVITY_TTL_DAYS;
  const ORIG_CAP = process.env.DEMO_MAX_ACCOUNTS;
  beforeAll(() => {
    process.env.DEMO_INACTIVITY_TTL_DAYS = '5';
    process.env.DEMO_MAX_ACCOUNTS        = '1000';
  });
  afterAll(() => {
    process.env.DEMO_INACTIVITY_TTL_DAYS = ORIG_TTL;
    process.env.DEMO_MAX_ACCOUNTS        = ORIG_CAP;
  });

  test('TTL prune deletes inactive but spares fresh + legacy', async () => {
    if (!dbReachable) return;

    // Stale (lastActiveDaysAgo=10) — should prune
    await makeDemoAccount({ daysOld: 30, lastActiveDaysAgo: 10, suffix: '0001' });
    // Fresh (lastActiveDaysAgo=1) — should survive
    await makeDemoAccount({ daysOld: 30, lastActiveDaysAgo: 1,  suffix: '0002' });
    // Never-returned-old (lastActiveAt=null, createdAt=10d ago) — should prune
    await makeDemoAccount({ daysOld: 10, lastActiveDaysAgo: null, suffix: '0003' });
    // Never-returned-fresh (lastActiveAt=null, createdAt=2d ago) — should survive
    await makeDemoAccount({ daysOld: 2,  lastActiveDaysAgo: null, suffix: '0004' });

    const r = await pruneInactiveDemoAccounts();
    expect(r.prunedTtl).toBeGreaterThanOrEqual(2);

    const stale1   = await prisma.account.findUnique({ where: { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaa0001' } });
    const fresh1   = await prisma.account.findUnique({ where: { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaa0002' } });
    const oldNull  = await prisma.account.findUnique({ where: { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaa0003' } });
    const freshNull= await prisma.account.findUnique({ where: { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaa0004' } });
    expect(stale1).toBeNull();
    expect(oldNull).toBeNull();
    expect(fresh1).not.toBeNull();
    expect(freshNull).not.toBeNull();
  });

  test('seedAccountForUser populates the visitor account with vendors + contracts', async () => {
    if (!dbReachable) return;
    const accountId = await makeDemoAccount({ daysOld: 0, lastActiveDaysAgo: 0, suffix: '0005' });
    const user = await prisma.user.findFirst({ where: { accountId } });
    const before = await prisma.contract.count({ where: { accountId } });
    expect(before).toBe(0);

    const r = await seedAccountForUser(user.id);
    expect(r.vendors).toBeGreaterThan(0);
    expect(r.contracts).toBeGreaterThan(0);

    const after = await prisma.contract.count({ where: { accountId } });
    expect(after).toBe(r.contracts);

    // Every seeded contract should have the visitor as internalOwner so their
    // dashboard renewal queue is populated on first load.
    const wrongOwner = await prisma.contract.count({
      where: { accountId, NOT: { internalOwnerId: user.id } },
    });
    expect(wrongOwner).toBe(0);
  });

  test('pruneAccount cascades through all child tables (incl. seeded data)', async () => {
    if (!dbReachable) return;
    const accountId = await makeDemoAccount({ daysOld: 0, lastActiveDaysAgo: 0, suffix: '0006' });
    const user = await prisma.user.findFirst({ where: { accountId } });
    await seedAccountForUser(user.id);

    const r = await pruneAccount(accountId);
    expect(r.deleted).toBe(true);

    expect(await prisma.account.findUnique({ where: { id: accountId } })).toBeNull();
    expect(await prisma.user.count({     where: { accountId } })).toBe(0);
    expect(await prisma.vendor.count({   where: { accountId } })).toBe(0);
    expect(await prisma.contract.count({ where: { accountId } })).toBe(0);
  });
});
