'use strict';

/**
 * Tenant-isolation regression (2026-07-03): resolveTargetAccount must not let
 * an oem_admin whose account has NO partnerOrgId act on an arbitrary
 * accountId. A null partnerOrgId means "no fleet": a targetAccountId is only
 * accepted when it IS the caller's own account; anything else throws the same
 * 403 TargetAccountError as a cross-fleet attempt. (Previously the membership
 * check was skipped entirely when oem.partnerOrgId was null, so any valid
 * accountId was accepted - a cross-tenant write primitive.)
 *
 * Mocks '../lib/prisma.ts' WITH the explicit .ts extension - see
 * activityLogIp.test.js for why: the unit project's moduleNameMapper
 * ('^(\.{1,2}/.*)/prisma$') matches extensionless '../lib/prisma' but NOT the
 * module's own './prisma' import, so mocking the exact .ts path registers
 * against the module oemTargetAccount.ts actually resolves.
 */

const accounts = new Map();
jest.mock('../lib/prisma.ts', () => {
  const client = {
    account: {
      findUnique: async ({ where }) => accounts.get(where.id) || null,
    },
  };
  return { __esModule: true, default: client, ...client };
});

const { resolveTargetAccount, TargetAccountError } = require('../lib/oemTargetAccount.ts');

function reqFor({ accountId, role = 'oem_admin', targetAccountId }) {
  return { user: { id: 'u1', accountId, role }, body: { targetAccountId }, query: {} };
}

beforeEach(() => { accounts.clear(); });

describe('resolveTargetAccount - null-partnerOrg callers cannot cross tenants', () => {
  test('null partnerOrgId + foreign targetAccountId -> 403', async () => {
    accounts.set('oem-acct', { id: 'oem-acct', partnerOrgId: null });
    accounts.set('victim-acct', { id: 'victim-acct', partnerOrgId: null });
    await expect(
      resolveTargetAccount(reqFor({ accountId: 'oem-acct', targetAccountId: 'victim-acct' }))
    ).rejects.toMatchObject({ httpStatus: 403 });
  });

  test('null partnerOrgId + foreign target that HAS an org -> still 403', async () => {
    accounts.set('oem-acct', { id: 'oem-acct', partnerOrgId: null });
    accounts.set('victim-acct', { id: 'victim-acct', partnerOrgId: 'org-x' });
    await expect(
      resolveTargetAccount(reqFor({ accountId: 'oem-acct', targetAccountId: 'victim-acct' }))
    ).rejects.toMatchObject({ httpStatus: 403 });
  });

  test('null partnerOrgId + own accountId as target -> allowed (self no-op)', async () => {
    accounts.set('oem-acct', { id: 'oem-acct', partnerOrgId: null });
    await expect(
      resolveTargetAccount(reqFor({ accountId: 'oem-acct', targetAccountId: 'oem-acct' }))
    ).resolves.toBe('oem-acct');
  });

  test('the rejection is a TargetAccountError (callers map httpStatus)', async () => {
    accounts.set('oem-acct', { id: 'oem-acct', partnerOrgId: null });
    accounts.set('victim-acct', { id: 'victim-acct', partnerOrgId: null });
    await expect(
      resolveTargetAccount(reqFor({ accountId: 'oem-acct', targetAccountId: 'victim-acct' }))
    ).rejects.toBeInstanceOf(TargetAccountError);
  });
});

describe('resolveTargetAccount - fleet path unchanged', () => {
  test('matching partnerOrgId -> target resolved', async () => {
    accounts.set('oem-acct', { id: 'oem-acct', partnerOrgId: 'org-1' });
    accounts.set('cust-acct', { id: 'cust-acct', partnerOrgId: 'org-1' });
    await expect(
      resolveTargetAccount(reqFor({ accountId: 'oem-acct', targetAccountId: 'cust-acct' }))
    ).resolves.toBe('cust-acct');
  });

  test('mismatched partnerOrgId -> 403', async () => {
    accounts.set('oem-acct', { id: 'oem-acct', partnerOrgId: 'org-1' });
    accounts.set('other-acct', { id: 'other-acct', partnerOrgId: 'org-2' });
    await expect(
      resolveTargetAccount(reqFor({ accountId: 'oem-acct', targetAccountId: 'other-acct' }))
    ).rejects.toMatchObject({ httpStatus: 403 });
  });

  test('target with null partnerOrgId while OEM has one -> 403', async () => {
    accounts.set('oem-acct', { id: 'oem-acct', partnerOrgId: 'org-1' });
    accounts.set('loner-acct', { id: 'loner-acct', partnerOrgId: null });
    await expect(
      resolveTargetAccount(reqFor({ accountId: 'oem-acct', targetAccountId: 'loner-acct' }))
    ).rejects.toMatchObject({ httpStatus: 403 });
  });

  test('unknown target -> 404', async () => {
    accounts.set('oem-acct', { id: 'oem-acct', partnerOrgId: 'org-1' });
    await expect(
      resolveTargetAccount(reqFor({ accountId: 'oem-acct', targetAccountId: 'nope' }))
    ).rejects.toMatchObject({ httpStatus: 404 });
  });

  test('non-oem role ignores targetAccountId -> own account', async () => {
    accounts.set('oem-acct', { id: 'oem-acct', partnerOrgId: 'org-1' });
    accounts.set('cust-acct', { id: 'cust-acct', partnerOrgId: 'org-1' });
    await expect(
      resolveTargetAccount(reqFor({ accountId: 'oem-acct', role: 'admin', targetAccountId: 'cust-acct' }))
    ).resolves.toBe('oem-acct');
  });
});
