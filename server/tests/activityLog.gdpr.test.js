/**
 * activityLog.gdpr.test.js — Pass-6 T7-N3
 *
 * Verifies that deleting a User via the GDPR Art. 17 erase flow sets
 * ActivityLog.userId = NULL (via onDelete: SetNull) rather than
 * cascade-deleting the log rows. The audit trail must be preserved;
 * only the personal identifier is scrubbed.
 *
 * Migration: 20260522200000_activitylog_user_setnull
 * Schema anchor: ActivityLog.user @relation(onDelete: SetNull)
 *
 * Requires DATABASE_URL pointing at a test-safe Postgres instance.
 * Skipped automatically when DATABASE_URL is absent (safe for local
 * runs without a database attached).
 */

'use strict';

const skip  = !process.env.DATABASE_URL;
const maybe = skip ? describe.skip : describe;

maybe('ActivityLog GDPR anonymize-on-erase', () => {
  let prisma;
  let testAccount;
  let testUser;

  beforeAll(async () => {
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();

    testAccount = await prisma.account.create({
      data: { name: 'gdpr-test-account-' + Date.now() },
    });
    testUser = await prisma.user.create({
      data: {
        accountId: testAccount.id,
        name:      'GDPR Test User',
        email:     `gdpr-test-${Date.now()}@test.local`,
        password:  'hashed-placeholder',
        role:      'admin',
      },
    });
  });

  afterAll(async () => {
    // Cascade from account delete removes the account + any surviving rows.
    if (testAccount) {
      await prisma.account.delete({ where: { id: testAccount.id } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  test('deleting a user sets activityLog.userId = null (SetNull cascade)', async () => {
    // Arrange — create an activity-log entry referencing the user.
    const log = await prisma.activityLog.create({
      data: {
        accountId: testAccount.id,
        userId:    testUser.id,
        action:    'test_event',
        details:   { note: 'gdpr-erase-test' },
      },
    });

    // Confirm it's linked before delete.
    const before = await prisma.activityLog.findUnique({ where: { id: log.id } });
    expect(before.userId).toBe(testUser.id);

    // Act — delete the user (simulates the Art. 17 erase transaction).
    await prisma.user.delete({ where: { id: testUser.id } });
    testUser = null; // Mark deleted so afterAll skips.

    // Assert — the log row still exists, but userId is now NULL.
    const after = await prisma.activityLog.findUnique({ where: { id: log.id } });
    expect(after).not.toBeNull();
    expect(after.userId).toBeNull();

    // Cleanup log row.
    await prisma.activityLog.delete({ where: { id: log.id } }).catch(() => {});
  });

  test('log rows for other users are unaffected', async () => {
    // Create a second user and a log row for them.
    const otherUser = await prisma.user.create({
      data: {
        accountId: testAccount.id,
        name:      'Other User',
        email:     `gdpr-other-${Date.now()}@test.local`,
        password:  'hashed-placeholder',
        role:      'member',
      },
    });
    const otherLog = await prisma.activityLog.create({
      data: {
        accountId: testAccount.id,
        userId:    otherUser.id,
        action:    'other_event',
      },
    });

    // Create a third user and delete them — other's log should be unchanged.
    const deleteMe = await prisma.user.create({
      data: {
        accountId: testAccount.id,
        name:      'Delete Me',
        email:     `gdpr-deleteme-${Date.now()}@test.local`,
        password:  'hashed-placeholder',
        role:      'member',
      },
    });
    await prisma.user.delete({ where: { id: deleteMe.id } });

    const otherStill = await prisma.activityLog.findUnique({ where: { id: otherLog.id } });
    expect(otherStill.userId).toBe(otherUser.id);

    // Cleanup.
    await prisma.activityLog.delete({ where: { id: otherLog.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: otherUser.id } }).catch(() => {});
  });
});