/**
 * __tests__/lib/aiQuota.test.ts
 * --------------------------------
 * L1: AI daily-cap regression suite.
 *
 * Hits the live dev Postgres (same shape as customFields.test.js etc.) so we
 * exercise the real ON CONFLICT upsert path — mocking that out would defeat
 * the entire point of the test, since the race-safe semantics live in the SQL.
 *
 * Cleans up after itself by deleting the test users it creates. Skips
 * gracefully if the DB isn't reachable (e.g. CI without a Postgres) so this
 * file doesn't red-flag pure offline lints.
 *
 * 2026-07-08: moved here from tests/aiQuota.test.js (plain-JS "unit"
 * project), fixing a pre-existing bug in the same move. The old file's own
 * setup did `const prisma = require('../lib/prisma');` — a two-segment
 * specifier that DOES match the unit project's moduleNameMapper regex
 * (`^(\.{1,2}/.*)/prisma$`), so this test's own Prisma client was already
 * silently the no-op stub from tests/__mocks__/prisma.js, even though
 * lib/aiQuota.ts's OWN internal `./prisma` import escaped the mapper and
 * always hit the real DB. In beforeAll, `prisma.account.upsert(...)`
 * resolved to the stub's `null` instead of throwing, so `acc.id` threw
 * `Cannot read properties of null`, which the surrounding try/catch caught
 * and mapped to `dbReachable = false` — misreporting "DB not reachable" in
 * the console.warn below even when the real DB was fine, and silently
 * no-op'ing (via the `if (!dbReachable) return;` guards) every DB-touching
 * test in the second describe block below without failing anything. Fixed
 * by switching to the shared Prisma singleton via its actual real-DB path,
 * `require('../../lib/prisma').default` (this project has no
 * moduleNameMapper at all — a real Prisma client is the intentional
 * default), matching the convention already used by sibling
 * aiQuotaRefund.test.ts and webhookDlqPersist.test.ts in this directory.
 * The old file's manual `dotenv.config()` call is also dropped: this
 * project's setupFiles (__tests__/helpers/setup-env.ts) already loads .env
 * and sets DATABASE_URL/JWT_SECRET/MASTER_KEY/DEMO_MODE before any module
 * loads.
 */
import '../helpers/setup';

const prisma = require('../../lib/prisma').default;
const aiQuota = require('../../lib/aiQuota');

const TEST_ACCOUNT_NAME = '__aiQuota_test_account__';
const TEST_USER_PREFIX  = '__aiQuota_test_user__';

let dbReachable = true;
let testAccountId: string;
let userIds: string[] = [];

beforeAll(async () => {
  try {
    // Single shared test account; per-test users so each test runs against a
    // fresh count=0 baseline without needing to truncate ai_usage.
    const acc = await prisma.account.upsert({
      where:  { id: '00000000-0000-0000-0000-aiquota00test' },
      update: {},
      create: {
        id:          '00000000-0000-0000-0000-aiquota00test',
        companyName: TEST_ACCOUNT_NAME,
        planType:    'licensed',
      },
    });
    testAccountId = acc.id;
  } catch (e: any) {
    dbReachable = false;
    console.warn('[aiQuota.test] DB not reachable — skipping. Reason:', e.message);
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  try {
    if (userIds.length) {
      await prisma.aiUsage.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({    where: { id:     { in: userIds } } });
    }
    await prisma.account.deleteMany({ where: { id: testAccountId } });
  } catch (e: any) {
    console.warn('[aiQuota.test] cleanup failed:', e.message);
  } finally {
    await prisma.$disconnect();
  }
});

async function makeUser(suffix: number | string) {
  const id = `00000000-0000-0000-0000-aiq${String(suffix).padStart(9, '0')}`;
  const u = await prisma.user.create({
    data: {
      id,
      accountId:    testAccountId,
      name:         `${TEST_USER_PREFIX}${suffix}`,
      email:        `${TEST_USER_PREFIX}${suffix}@test.invalid`,
      passwordHash: 'x',
      role:         'manager',
    },
  });
  userIds.push(u.id);
  return u;
}

describe('aiQuota.getDailyCap', () => {
  const ORIG = process.env.AI_DAILY_CAP_PER_USER;
  const ORIG_DEMO = process.env.DEMO_MODE;

  afterEach(() => {
    process.env.AI_DAILY_CAP_PER_USER = ORIG;
    process.env.DEMO_MODE             = ORIG_DEMO;
  });

  test('unset env, demo off → unlimited', () => {
    delete process.env.AI_DAILY_CAP_PER_USER;
    process.env.DEMO_MODE = 'false';
    expect(aiQuota.getDailyCap()).toBe(Number.POSITIVE_INFINITY);
  });

  test('unset env, demo on, no action → min of DEMO_DEFAULT_CAPS', () => {
    // Floor of catalogue values. With brief=2, brief_search=2, extract=2,
    // ask=6, the floor is 2.
    delete process.env.AI_DAILY_CAP_PER_USER;
    process.env.DEMO_MODE = 'true';
    expect(aiQuota.getDailyCap()).toBe(2);
  });

  test('unset env, demo on, action=extract → 2', () => {
    delete process.env.AI_DAILY_CAP_PER_USER;
    process.env.DEMO_MODE = 'true';
    expect(aiQuota.getDailyCap('extract')).toBe(2);
  });

  test('unset env, demo on, action=brief → 2 (v0.5.10 lowered from 3)', () => {
    delete process.env.AI_DAILY_CAP_PER_USER;
    process.env.DEMO_MODE = 'true';
    expect(aiQuota.getDailyCap('brief')).toBe(2);
  });

  test('unset env, demo on, action=brief_search → 2 (v0.5.10 lowered from 3)', () => {
    delete process.env.AI_DAILY_CAP_PER_USER;
    process.env.DEMO_MODE = 'true';
    expect(aiQuota.getDailyCap('brief_search')).toBe(2);
  });

  test('explicit numeric env wins regardless of demo mode', () => {
    process.env.AI_DAILY_CAP_PER_USER = '7';
    process.env.DEMO_MODE = 'true';
    expect(aiQuota.getDailyCap()).toBe(7);
    process.env.DEMO_MODE = 'false';
    expect(aiQuota.getDailyCap()).toBe(7);
  });

  test('non-numeric env → unlimited (operator-friendly fallback)', () => {
    process.env.AI_DAILY_CAP_PER_USER = 'inf';
    expect(aiQuota.getDailyCap()).toBe(Number.POSITIVE_INFINITY);
  });

  test('negative env → unlimited (operator-friendly fallback)', () => {
    process.env.AI_DAILY_CAP_PER_USER = '-1';
    expect(aiQuota.getDailyCap()).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('aiQuota.checkAndIncrement (live DB)', () => {
  const ORIG = process.env.AI_DAILY_CAP_PER_USER;

  beforeAll(() => { if (!dbReachable) return; });
  afterEach(() => { process.env.AI_DAILY_CAP_PER_USER = ORIG; });

  test('throws on missing arguments', async () => {
    await expect(aiQuota.checkAndIncrement(null, 'x')).rejects.toThrow(/userId/);
    await expect(aiQuota.checkAndIncrement('u',  null)).rejects.toThrow(/action/);
  });

  test('cap=2: 200 / 200 / 402 sequence', async () => {
    if (!dbReachable) return;
    process.env.AI_DAILY_CAP_PER_USER = '2';
    const u = await makeUser(101);

    const a = await aiQuota.checkAndIncrement(u.id, 'ingest_extract');
    const b = await aiQuota.checkAndIncrement(u.id, 'ingest_extract');
    const c = await aiQuota.checkAndIncrement(u.id, 'ingest_extract');

    expect(a.ok).toBe(true);  expect(a.count).toBe(1); expect(a.cap).toBe(2);
    expect(b.ok).toBe(true);  expect(b.count).toBe(2); expect(b.cap).toBe(2);
    expect(c.ok).toBe(false); expect(c.count).toBe(2); expect(c.cap).toBe(2);

    // resetAt is a parseable ISO string in the future
    expect(typeof c.resetAt).toBe('string');
    expect(new Date(c.resetAt).getTime()).toBeGreaterThan(Date.now());
  });

  test('rollback prevents over-cap pin (3rd call cannot push count to 3)', async () => {
    if (!dbReachable) return;
    process.env.AI_DAILY_CAP_PER_USER = '2';
    const u = await makeUser(102);

    await aiQuota.checkAndIncrement(u.id, 'sig');
    await aiQuota.checkAndIncrement(u.id, 'sig');
    await aiQuota.checkAndIncrement(u.id, 'sig'); // should bump+rollback
    await aiQuota.checkAndIncrement(u.id, 'sig');

    const usage = await aiQuota.getUsage(u.id, 'sig');
    expect(usage.count).toBe(2); // never permanently pinned over the cap
  });

  test('different actions are independent buckets', async () => {
    if (!dbReachable) return;
    process.env.AI_DAILY_CAP_PER_USER = '1';
    const u = await makeUser(103);

    const a = await aiQuota.checkAndIncrement(u.id, 'ingest_extract');
    const b = await aiQuota.checkAndIncrement(u.id, 'signature_extract');
    const c = await aiQuota.checkAndIncrement(u.id, 'renewal_brief');

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(true);
  });

  test('on-prem (env unset, demo off) → unlimited, no DB writes', async () => {
    if (!dbReachable) return;
    delete process.env.AI_DAILY_CAP_PER_USER;
    process.env.DEMO_MODE = 'false';
    const u = await makeUser(104);

    for (let i = 0; i < 50; i++) {
      const r = await aiQuota.checkAndIncrement(u.id, 'ingest_extract');
      expect(r.ok).toBe(true);
    }
    // No DB row should exist — unlimited path skips the upsert entirely.
    const row = await prisma.aiUsage.findUnique({
      where: { userId_action_day: {
        userId: u.id, action: 'ingest_extract',
        day: new Date().toISOString().slice(0, 10),
      } },
    });
    expect(row).toBeNull();
  });
});

export {};
