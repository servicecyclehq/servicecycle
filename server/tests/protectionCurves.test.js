'use strict';

/**
 * lib/protectionCurves — pure-core unit tests (mocked prisma, no real DB).
 * Backend prep for the interactive TCC visualization (2026-07-05, §10 A3).
 */

const {
  listProtectionCurves,
  getProtectionCurve,
  seedFromTccLibrary,
  ProtectionCurveNotFoundError,
} = require('../lib/protectionCurves');

describe('listProtectionCurves', () => {
  test('scopes by accountId and optionally by assetId / protectiveDeviceId', async () => {
    const prisma = { protectionCurve: { findMany: jest.fn(async () => [{ id: 'pc1' }]) } };
    const out = await listProtectionCurves(prisma, 'acct-1', { assetId: 'a1' });
    expect(out).toEqual([{ id: 'pc1' }]);
    const args = prisma.protectionCurve.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ accountId: 'acct-1', assetId: 'a1' });
  });

  test('with no opts, only filters by accountId', async () => {
    const prisma = { protectionCurve: { findMany: jest.fn(async () => []) } };
    await listProtectionCurves(prisma, 'acct-1', {});
    expect(prisma.protectionCurve.findMany.mock.calls[0][0].where).toEqual({ accountId: 'acct-1' });
  });
});

describe('getProtectionCurve', () => {
  test('returns the row scoped to accountId', async () => {
    const prisma = { protectionCurve: { findFirst: jest.fn(async () => ({ id: 'pc1', accountId: 'acct-1' })) } };
    const out = await getProtectionCurve(prisma, 'acct-1', 'pc1');
    expect(out.id).toBe('pc1');
    expect(prisma.protectionCurve.findFirst.mock.calls[0][0].where).toEqual({ id: 'pc1', accountId: 'acct-1' });
  });

  test('throws ProtectionCurveNotFoundError when no row matches (tenant-scoped 404, not leaked cross-tenant)', async () => {
    const prisma = { protectionCurve: { findFirst: jest.fn(async () => null) } };
    await expect(getProtectionCurve(prisma, 'acct-1', 'missing')).rejects.toThrow(ProtectionCurveNotFoundError);
  });
});

describe('seedFromTccLibrary', () => {
  test('creates a placeholder curve tagged tcc_library_estimate when a library match exists', async () => {
    const created = [];
    const prisma = {
      protectionCurve: {
        create: jest.fn(async ({ data }) => { created.push(data); return { id: 'new-pc', ...data }; }),
      },
    };
    const out = await seedFromTccLibrary(prisma, 'acct-1', {
      assetId: 'a1', deviceLabel: 'Main CB 52-M1', manufacturer: 'Square D', model: 'PowerPact', deviceType: 'breaker', ratingA: 400,
    });
    expect(out).not.toBeNull();
    expect(created[0].dataSource).toBe('tcc_library_estimate');
    expect(created[0].accountId).toBe('acct-1');
    expect(created[0].curvePoints[0]).toHaveProperty('time');
    expect(created[0].settings.curveRef).toMatch(/PowerPact/i);
  });

  test('returns null (no create) when no library match exists', async () => {
    const prisma = { protectionCurve: { create: jest.fn() } };
    const out = await seedFromTccLibrary(prisma, 'acct-1', { deviceLabel: 'Totally Unknown Device XYZ' });
    expect(out).toBeNull();
    expect(prisma.protectionCurve.create).not.toHaveBeenCalled();
  });
});
