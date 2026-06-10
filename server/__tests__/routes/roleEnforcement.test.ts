/**
 * Matrix test: all partner routes × wrong roles → 401/403.
 *
 * Tests that each protected partner route returns the correct error code
 * when called with the wrong role or no token.
 */

import request from 'supertest';
import '../helpers/setup';
import { createTestUser, generateTestToken, type TestUser } from '../helpers/auth';
import { createTestPartnerOrg, createTestAccount } from '../helpers/seed';
import { randomUUID } from 'crypto';

let app: any;
let prisma: any;
const toDelete: Array<{ model: string; id: string }> = [];

beforeAll(async () => {
  app    = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
});

afterAll(async () => {
  for (const { model, id } of toDelete.reverse()) {
    try { await (prisma as any)[model].delete({ where: { id } }); } catch {}
  }
  await prisma.$disconnect();
});

// Create one user per non-oem_admin role to use in matrix tests
const wrongRoles = ['admin', 'manager', 'viewer'] as const;
const roleTokens: Record<string, string> = {};

beforeAll(async () => {
  for (const role of wrongRoles) {
    const u = await createTestUser(role);
    toDelete.push({ model: 'user', id: u.id });
    toDelete.push({ model: 'account', id: u.accountId });
    roleTokens[role] = u.token;
  }
});

// Routes that require oem_admin
const oemAdminRoutes = [
  { method: 'get',    path: '/api/fleet/accounts' },
  { method: 'get',    path: '/api/fleet/inbox' },
  { method: 'get',    path: '/api/fleet/invites' },
  { method: 'get',    path: '/api/fleet/webhook-settings' },
];

describe('oem_admin routes reject wrong roles', () => {
  for (const route of oemAdminRoutes) {
    for (const role of wrongRoles) {
      test(`${route.method.toUpperCase()} ${route.path} with role=${role} → 403`, async () => {
        const res = await (request(app) as any)[route.method](route.path)
          .set('Authorization', `Bearer ${roleTokens[role]}`);
        expect(res.status).toBe(403);
      });
    }

    test(`${route.method.toUpperCase()} ${route.path} with no token → 401`, async () => {
      const res = await (request(app) as any)[route.method](route.path);
      expect(res.status).toBe(401);
    });
  }
});

// Routes that require super_admin
const superAdminRoutes = [
  { method: 'get',  path: '/api/admin/partner-orgs' },
  { method: 'post', path: '/api/admin/partner-orgs' },
];

// Create an oem_admin and regular admin to test super_admin rejection
let adminUser: TestUser;
let oemAdminUser: TestUser;

beforeAll(async () => {
  const org = await createTestPartnerOrg();
  toDelete.push({ model: 'partnerOrganization', id: org.id });
  adminUser   = await createTestUser('admin');
  oemAdminUser = await createTestUser('oem_admin', { partnerOrgId: org.id });
  toDelete.push({ model: 'user', id: adminUser.id });
  toDelete.push({ model: 'account', id: adminUser.accountId });
  toDelete.push({ model: 'user', id: oemAdminUser.id });
  toDelete.push({ model: 'account', id: oemAdminUser.accountId });
});

describe('super_admin routes reject non-super_admin roles', () => {
  const nonSuperRoles = [
    { label: 'admin',     getToken: () => adminUser.token },
    { label: 'oem_admin', getToken: () => oemAdminUser.token },
  ];

  for (const route of superAdminRoutes) {
    for (const { label, getToken } of nonSuperRoles) {
      test(`${route.method.toUpperCase()} ${route.path} with role=${label} → 403`, async () => {
        const res = await (request(app) as any)[route.method](route.path)
          .set('Authorization', `Bearer ${getToken()}`);
        expect(res.status).toBe(403);
      });
    }

    test(`${route.method.toUpperCase()} ${route.path} with no token → 401`, async () => {
      const res = await (request(app) as any)[route.method](route.path);
      expect(res.status).toBe(401);
    });
  }
});
