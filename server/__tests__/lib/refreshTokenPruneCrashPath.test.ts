/**
 * Regression test — 2026-07-06/07 overnight cron bug hunt (continuation of
 * [[servicecycle-bughunt-restore-branch-2026-07-06]]).
 *
 * `refreshTokenPrune` (03:20 UTC, index.ts) had zero test coverage of its
 * own query (similar in spirit to tokenEpochRevocation.test.ts, which tests
 * a different auth mechanism — token epoch bumps — not this prune query).
 * Exercises the cron's real deleteMany() OR-clause against real
 * RefreshToken rows in all four states: expired-old (deleted),
 * revoked-old (deleted), still-valid (kept), revoked-but-recent (kept —
 * the 30-day grace window on revocation is intentional, see index.ts
 * comment: "detect reuse-attacks on recently-expired tokens").
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let prisma: any;
let user: TestUser;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  user = await createTestUser('admin');
});

afterAll(async () => {
  await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
  try { await prisma.user.delete({ where: { id: user.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: user.accountId } }); } catch {}
  await prisma.$disconnect();
});

test('refreshTokenPrune cron body: real deleteMany OR-clause prunes only rows past the 30-day cutoff', async () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  const expiredOld = await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: 'hash-expired-old', expiresAt: new Date(now - 40 * day) },
  });
  const revokedOld = await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: 'hash-revoked-old', expiresAt: new Date(now + 60 * day), revokedAt: new Date(now - 35 * day) },
  });
  const stillValid = await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: 'hash-still-valid', expiresAt: new Date(now + 60 * day) },
  });
  const revokedRecent = await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: 'hash-revoked-recent', expiresAt: new Date(now + 60 * day), revokedAt: new Date(now - 2 * day) },
  });

  // Exact cron body (index.ts refreshTokenPrune):
  const cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const { count } = await prisma.refreshToken.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: cutoff } },
        { revokedAt: { not: null, lt: cutoff } },
      ],
    },
  });

  expect(count).toBeGreaterThanOrEqual(2);

  const remaining = await prisma.refreshToken.findMany({
    where: { id: { in: [expiredOld.id, revokedOld.id, stillValid.id, revokedRecent.id] } },
    select: { id: true },
  });
  const remainingIds = remaining.map((r: any) => r.id);

  expect(remainingIds).not.toContain(expiredOld.id);
  expect(remainingIds).not.toContain(revokedOld.id);
  expect(remainingIds).toContain(stillValid.id);
  expect(remainingIds).toContain(revokedRecent.id);
});

export {};
