/**
 * contractLineItem.cascade.test.js — T2-N3 Pass-6
 *
 * Verifies that ContractLineItem rows are cascade-deleted when their parent
 * Contract is deleted. This is guaranteed by the Prisma schema relation:
 *   contract Contract @relation(fields: [contractId], references: [id], onDelete: Cascade)
 *
 * Uses a real Prisma client against the test database (same pattern as
 * demoPrune.test.js and auth.test.js). Requires DATABASE_URL to be set to
 * a test-safe database — CI runs these in an isolated postgres container.
 *
 * If DATABASE_URL is not set, the test suite is skipped (safe to run locally
 * without a database attached).
 */

'use strict';

const skip = !process.env.DATABASE_URL;
const maybe = skip ? describe.skip : describe;

maybe('ContractLineItem cascade-delete', () => {
  let prisma;
  let testAccount;
  let testUser;
  let testContract;

  beforeAll(async () => {
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();

    // Create a minimal account + user for FK satisfaction.
    testAccount = await prisma.account.create({
      data: { name: 'cascade-test-account-' + Date.now() },
    });
    testUser = await prisma.user.create({
      data: {
        accountId: testAccount.id,
        name:      'Cascade Test User',
        email:     `cascade-test-${Date.now()}@test.local`,
        password:  'hashed-placeholder',
        role:      'admin',
      },
    });
  });

  afterAll(async () => {
    // Clean up test data (cascade from account delete removes user + contract + line items).
    if (testAccount) {
      await prisma.account.delete({ where: { id: testAccount.id } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    testContract = await prisma.contract.create({
      data: {
        accountId:  testAccount.id,
        createdById: testUser.id,
        product:    'Cascade Test Product',
        status:     'active',
      },
    });
  });

  afterEach(async () => {
    // Clean up contract if test didn't delete it.
    if (testContract) {
      await prisma.contract.delete({ where: { id: testContract.id } }).catch(() => {});
    }
  });

  test('deleting a contract cascade-deletes all its line items', async () => {
    // Arrange — create 3 line items on the contract.
    await Promise.all(
      [1, 2, 3].map((n) =>
        prisma.contractLineItem.create({
          data: {
            contractId:  testContract.id,
            description: `Line item ${n}`,
            quantity:    n,
            unitPrice:   100 * n,
          },
        })
      )
    );

    // Confirm line items exist before delete.
    const before = await prisma.contractLineItem.findMany({
      where: { contractId: testContract.id },
    });
    expect(before).toHaveLength(3);

    // Act — delete the parent contract.
    await prisma.contract.delete({ where: { id: testContract.id } });
    testContract = null; // mark as already deleted so afterEach skips cleanup.

    // Assert — no orphan line items should remain.
    const after = await prisma.contractLineItem.findMany({
      where: { contractId: testContract?.id ?? before[0]?.contractId },
    });
    expect(after).toHaveLength(0);
  });

  test('line items on OTHER contracts are unaffected by deleting one contract', async () => {
    // Arrange — a second contract with its own line item.
    const otherContract = await prisma.contract.create({
      data: {
        accountId:   testAccount.id,
        createdById: testUser.id,
        product:     'Other Contract',
        status:      'active',
      },
    });
    const otherItem = await prisma.contractLineItem.create({
      data: {
        contractId:  otherContract.id,
        description: 'Other line item',
        quantity:    1,
        unitPrice:   50,
      },
    });

    // Act — delete only the first (testContract).
    await prisma.contract.delete({ where: { id: testContract.id } });
    testContract = null;

    // Assert — the other contract's line item still exists.
    const stillThere = await prisma.contractLineItem.findUnique({
      where: { id: otherItem.id },
    });
    expect(stillThere).not.toBeNull();

    // Cleanup.
    await prisma.contract.delete({ where: { id: otherContract.id } }).catch(() => {});
  });
});
