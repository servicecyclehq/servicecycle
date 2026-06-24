/**
 * lib/accountFeatures resolution-order tests.
 *   defaults (most OFF, parts_module ON) < env override < per-account AccountSetting override.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const {
  ACCOUNT_FEATURE_KEYS,
  computeAccountFeatures,
  resolveAccountFeatures,
} = require('../../lib/accountFeatures');

let prisma: any;
let manager: TestUser;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
});

afterAll(async () => {
  const acc = manager.accountId;
  try { await prisma.accountSetting.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.delete({ where: { id: manager.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

describe('computeAccountFeatures (pure)', () => {
  test('defaults: most OFF (opt-in), parts_module ON (opt-out)', () => {
    const f = computeAccountFeatures({});
    for (const k of ACCOUNT_FEATURE_KEYS) {
      if (k === 'parts_module') expect(f[k]).toBe(true);
      else expect(f[k]).toBe(false);
    }
  });

  test('parts_module can be disabled via per-account setting', () => {
    const f = computeAccountFeatures({ 'feature.parts_module': 'false' });
    expect(f.parts_module).toBe(false);
  });

  test('per-account setting flips a single flag on', () => {
    const f = computeAccountFeatures({ 'feature.dga_import': 'true' });
    expect(f.dga_import).toBe(true);
    expect(f.qemw_wallet).toBe(false);
  });

  test('env override sets the global default but a per-account false wins', () => {
    process.env.ACCOUNT_FEATURE_QEMW_WALLET = 'true';
    try {
      expect(computeAccountFeatures({}).qemw_wallet).toBe(true);
      expect(computeAccountFeatures({ 'feature.qemw_wallet': 'false' }).qemw_wallet).toBe(false);
    } finally {
      delete process.env.ACCOUNT_FEATURE_QEMW_WALLET;
    }
  });
});

describe('resolveAccountFeatures (DB)', () => {
  test('no accountId -> lean defaults', async () => {
    const f = await resolveAccountFeatures(null);
    expect(f.neta_full_battery).toBe(false);
  });

  test('reads feature.* rows for the account', async () => {
    await prisma.accountSetting.create({
      data: { accountId: manager.accountId, key: 'feature.thermography_import', value: 'true' },
    });
    const f = await resolveAccountFeatures(manager.accountId);
    expect(f.thermography_import).toBe(true);
    expect(f.dga_import).toBe(false);
    expect(f.parts_module).toBe(true); // default ON even without a DB row
  });
});

export {};
