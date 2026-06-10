/**
 * Seed helpers — create common test fixtures.
 */
import { createHash, randomBytes } from 'crypto';

let _prisma: any;
function getPrisma() {
  if (!_prisma) _prisma = require('../../lib/prisma').default;
  return _prisma;
}

export async function createTestPartnerOrg(overrides: Record<string, any> = {}) {
  const prisma = getPrisma();
  return prisma.partnerOrganization.create({
    data: {
      name: `Test Partner Org ${Date.now()}`,
      webhookUrl:    overrides.webhookUrl    ?? null,
      webhookSecret: overrides.webhookSecret ?? null,
      digestIntervalDays: 1,
      ...overrides,
    },
  });
}

export async function createTestAccount(partnerOrgId?: string, overrides: Record<string, any> = {}) {
  const prisma = getPrisma();
  return prisma.account.create({
    data: {
      companyName: `Test Account ${Date.now()}`,
      planType: 'saas',
      ...(partnerOrgId ? { partnerOrgId } : {}),
      ...overrides,
    },
  });
}

export async function createTestInvite(
  partnerOrgId: string,
  invitedById: string,
  overrides: Record<string, any> = {}
) {
  const prisma = getPrisma();
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const invite = await prisma.partnerInvite.create({
    data: {
      partnerOrgId,
      inviteeEmail: `invitee-${Date.now()}@test.invalid`,
      invitedById,
      tokenHash,
      expiresAt,
      ...overrides,
    },
  });

  return { invite, rawToken };
}

/** Clean up all rows created during a test suite by deleting them by ID. */
export async function cleanup(
  items: Array<{ model: string; id: string }>
) {
  const prisma = getPrisma();
  // Delete in reverse order to respect FK constraints.
  for (const { model, id } of items.reverse()) {
    try {
      await (prisma as any)[model].delete({ where: { id } });
    } catch {
      // Row may already be gone — ignore.
    }
  }
}

export {};
