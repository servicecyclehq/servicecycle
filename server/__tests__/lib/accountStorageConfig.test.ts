/**
 * Regression tests — 2026-07-08 overnight session, per-tenant "bring your
 * own storage" (Dustin: "that's a requirement not a nice to have").
 *
 * Covers lib/storage.ts's `resolveAccountStorageConfig()` (the per-tenant
 * lookup + decrypt) against a real Postgres DB: the fallback-to-global case,
 * the configured case (encrypted round-trip), the fail-safe-to-global case
 * for a misconfigured account, and cross-tenant isolation. Does not hit a
 * real S3 endpoint -- that's what POST /api/settings/storage/test is for in
 * production; this suite verifies the resolution/encryption logic only.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let prisma: any;
let storage: any;
let accountA: TestUser;
let accountB: TestUser;

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  storage = require('../../lib/storage');
  accountA = await createTestUser('admin');
  accountB = await createTestUser('admin');
});

afterAll(async () => {
  for (const acc of [accountA, accountB]) {
    try { await prisma.user.delete({ where: { id: acc.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc.accountId } }); } catch {}
  }
  await prisma.$disconnect();
});

test('an account with no storageProvider set resolves to null (falls back to global default)', async () => {
  const cfg = await storage.resolveAccountStorageConfig(accountA.accountId);
  expect(cfg).toBeNull();
});

test('resolveAccountStorageConfig() with no accountId at all also returns null', async () => {
  const cfg = await storage.resolveAccountStorageConfig(null);
  expect(cfg).toBeNull();
});

test('a fully configured account resolves its own bucket with decrypted credentials', async () => {
  await prisma.account.update({
    where: { id: accountA.accountId },
    data: {
      storageProvider:   's3',
      storageS3Bucket:   'account-a-own-bucket',
      storageS3Region:   'us-west-2',
      storageS3Endpoint: 'https://s3.us-west-2.example.com',
      storageS3KeyId:    require('../../lib/crypto').encrypt('AKIA_TEST_KEY_A'),
      storageS3Secret:   require('../../lib/crypto').encrypt('test-secret-value-a'),
    },
  });

  const cfg = await storage.resolveAccountStorageConfig(accountA.accountId);
  expect(cfg).not.toBeNull();
  expect(cfg.dest).toBe('s3');
  expect(cfg.bucket).toBe('account-a-own-bucket');
  expect(cfg.region).toBe('us-west-2');
  expect(cfg.endpoint).toBe('https://s3.us-west-2.example.com');
  // Decrypted, not the raw enc.v1: sentinel value.
  expect(cfg.keyId).toBe('AKIA_TEST_KEY_A');
  expect(cfg.secret).toBe('test-secret-value-a');
});

test('cross-tenant isolation: account B never sees account A\'s bucket/credentials', async () => {
  // accountA was configured in the previous test; accountB has never been touched.
  const cfgB = await storage.resolveAccountStorageConfig(accountB.accountId);
  expect(cfgB).toBeNull(); // B has no config of its own -> falls back to global, not A's

  const cfgA = await storage.resolveAccountStorageConfig(accountA.accountId);
  expect(cfgA.bucket).toBe('account-a-own-bucket');
  expect(cfgA.bucket).not.toBe(await getBucketFor(accountB.accountId));
});

async function getBucketFor(accountId: string) {
  const cfg = await storage.resolveAccountStorageConfig(accountId);
  return cfg?.bucket ?? null;
}

test('a misconfigured account (provider set but bucket missing) fails safe to the global default', async () => {
  const misconfigured = await createTestUser('admin');
  try {
    await prisma.account.update({
      where: { id: misconfigured.accountId },
      data: {
        storageProvider: 's3',
        storageS3Bucket: null, // provider set, but required field missing
        storageS3KeyId:  require('../../lib/crypto').encrypt('AKIA_ORPHANED'),
        storageS3Secret: require('../../lib/crypto').encrypt('orphaned-secret'),
      },
    });
    const cfg = await storage.resolveAccountStorageConfig(misconfigured.accountId);
    expect(cfg).toBeNull(); // fails safe, does not throw mid-upload
  } finally {
    try { await prisma.user.delete({ where: { id: misconfigured.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: misconfigured.accountId } }); } catch {}
  }
});

test('clearing storageProvider (provider: null) reverts the account to the global default', async () => {
  // accountA is still configured from an earlier test in this file.
  let cfg = await storage.resolveAccountStorageConfig(accountA.accountId);
  expect(cfg).not.toBeNull();

  await prisma.account.update({
    where: { id: accountA.accountId },
    data: { storageProvider: null, storageS3Bucket: null, storageS3Region: null, storageS3Endpoint: null, storageS3KeyId: null, storageS3Secret: null },
  });

  cfg = await storage.resolveAccountStorageConfig(accountA.accountId);
  expect(cfg).toBeNull();
});

export {};
