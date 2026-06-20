/**
 * Test auth helpers — create users and generate JWTs signed with the app's secret.
 */
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// Import prisma after env is set up by setup.ts
let _prisma: any;
function getPrisma() {
  if (!_prisma) _prisma = require('../../lib/prisma').default;
  return _prisma;
}

export type TestRole = 'admin' | 'manager' | 'viewer' | 'consultant' | 'oem_admin' | 'group_admin' | 'super_admin';

export interface TestUser {
  id: string;
  accountId: string;
  email: string;
  role: TestRole;
  token: string;
}

/** Generate a signed JWT for any userId/role — no DB required. */
export function generateTestToken(userId: string, accountId: string, role: TestRole): string {
  const secret = process.env.JWT_SECRET!;
  // authenticateToken looks up decoded.userId — must match the app's own claim key
  return jwt.sign({ userId, accountId, role }, secret, { expiresIn: '1h' });
}

/**
 * Create a real User row in the DB and return it with a signed JWT.
 * Pass accountId if the account already exists; otherwise a fresh account is created.
 */
export async function createTestUser(
  role: TestRole,
  overrides: { email?: string; accountId?: string; partnerOrgId?: string; enterpriseGroupId?: string } = {}
): Promise<TestUser> {
  const prisma = getPrisma();
  const email = overrides.email ?? `test-${role}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`;

  let accountId = overrides.accountId;
  if (!accountId) {
    const account = await prisma.account.create({
      data: {
        companyName: `Test Account ${Date.now()}`,
        planType: 'saas',
        ...(overrides.partnerOrgId ? { partnerOrgId: overrides.partnerOrgId } : {}),
        ...(overrides.enterpriseGroupId ? { enterpriseGroupId: overrides.enterpriseGroupId } : {}),
      },
    });
    accountId = account.id;
  }

  const passwordHash = await bcrypt.hash('TestPassword1!', 4); // low cost for speed
  const user = await prisma.user.create({
    data: {
      accountId,
      name: `Test ${role}`,
      email,
      passwordHash,
      role,
      isActive: true,
    },
  });

  const token = generateTestToken(user.id, accountId, role);
  return { id: user.id, accountId, email, role, token };
}

export {};
