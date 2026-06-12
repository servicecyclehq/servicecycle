/**
 * #3 Asset identity resolution — normalizeSerial purity, resolveAsset ranking
 * (exact / fuzzy O↔0,I↔1 / site+type fallback / no-false-positive), and the
 * POST /api/assets/identity-check warn-before-create endpoint.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { resolveAsset, normalizeSerial } = require('../../lib/assetIdentity');

let app: any;
let prisma: any;
let manager: TestUser;
let siteId: string;
let assetId: string;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;

  manager = await createTestUser('manager');
  const site = await prisma.site.create({
    data: { accountId: manager.accountId, name: `IdentitySite ${Date.now()}` },
  });
  siteId = site.id;
  const asset = await prisma.asset.create({
    data: {
      accountId: manager.accountId, siteId,
      equipmentType: 'SWITCHGEAR',
      manufacturer: 'Square D', model: 'QED-2',
      serialNumber: 'B36S01',
    },
  });
  assetId = asset.id;
});

afterAll(async () => {
  try { await prisma.asset.deleteMany({ where: { siteId } }); } catch {}
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: manager.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: manager.accountId } }); } catch {}
  await prisma.$disconnect();
});

describe('normalizeSerial', () => {
  test('folds O→0 so B36SO1 matches B36S01', () => {
    expect(normalizeSerial('B36SO1')).toBe('B36S01');
    expect(normalizeSerial('B36S01')).toBe('B36S01');
  });
  test('strips separators and case', () => {
    expect(normalizeSerial('b36-s01')).toBe('B36S01');
    expect(normalizeSerial(' b36 s01 ')).toBe('B36S01');
  });
  test('folds I→1', () => {
    expect(normalizeSerial('I1O')).toBe('110');
  });
  test('null/undefined → empty string', () => {
    expect(normalizeSerial(null)).toBe('');
    expect(normalizeSerial(undefined)).toBe('');
  });
});

describe('resolveAsset', () => {
  test('exact serial (case-insensitive) → serial_exact, high', async () => {
    const { best } = await resolveAsset({ accountId: manager.accountId, serialNumber: 'b36s01' });
    expect(best).toBeTruthy();
    expect(best.id).toBe(assetId);
    expect(best.reason).toBe('serial_exact');
    expect(best.confidence).toBe('high');
  });

  test('OCR-confused serial (B36SO1) → serial_fuzzy match to same asset', async () => {
    const { best, candidates } = await resolveAsset({ accountId: manager.accountId, serialNumber: 'B36SO1' });
    expect(best).toBeTruthy();
    expect(best.id).toBe(assetId);
    expect(best.reason).toBe('serial_fuzzy');
    expect(candidates.length).toBeGreaterThanOrEqual(1);
  });

  test('unrelated serial with no site/type → no candidates (no false positive)', async () => {
    const { best, candidates } = await resolveAsset({ accountId: manager.accountId, serialNumber: 'ZZZ-9999-NOPE' });
    expect(best).toBeNull();
    expect(candidates.length).toBe(0);
  });

  test('missing serial but same site + type → site_type fallback', async () => {
    const { best } = await resolveAsset({
      accountId: manager.accountId, siteId, equipmentType: 'SWITCHGEAR',
    });
    expect(best).toBeTruthy();
    expect(best.id).toBe(assetId);
    expect(['site_type', 'site_position_type']).toContain(best.reason);
  });
});

describe('POST /api/assets/identity-check', () => {
  test('flags a fuzzy serial duplicate', async () => {
    const res = await request(app)
      .post('/api/assets/identity-check')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ serialNumber: 'B36SO1' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.isDuplicate).toBe(true);
    expect(res.body.data.best.id).toBe(assetId);
  });

  test('does not flag a genuinely new serial', async () => {
    const res = await request(app)
      .post('/api/assets/identity-check')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ serialNumber: 'TOTALLY-NEW-0001' });
    expect(res.status).toBe(200);
    expect(res.body.data.isDuplicate).toBe(false);
  });
});
