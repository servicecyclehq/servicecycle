/**
 * Tests for emitPartnerEvent (unit/integration):
 *   - consent gate
 *   - dedup within digest window
 *   - IMMEDIATE_DEFICIENCY immediate email
 *   - webhook fires with HMAC signature
 *   - webhook failure increments webhookAttempts, does not throw
 *
 * [2026-07-06] lib/webhook's postJsonToValidatedUrl (SSRF-hardened: HTTPS-only
 * + private/metadata-IP block + DNS-rebind-safe IP pinning) replaced firePartnerWebhook's
 * raw fetch() call. Mocking global.fetch no longer intercepts delivery -- these
 * tests now mock lib/webhook itself, same as the SSRF check would in real
 * delivery (real DNS resolution against a *.invalid fixture host would
 * otherwise fail closed before ever reaching the "server").
 *
 * [2026-07-06, later same day] The mock factory below used to replace the
 * ENTIRE lib/webhook module with just `{ postJsonToValidatedUrl }`. That was
 * fine until firePartnerWebhook was switched (same-day signing-unification
 * work, see servicecycle-batchF-sso-webhook-2026-07-06 memory) to also
 * import `signPayload` from the same module -- the mock factory silently
 * dropped it, so every test here started throwing `signPayload is not a
 * function`. Fixed by spreading jest.requireActual() so signPayload (and
 * anything else firePartnerWebhook needs from this module) stays real; only
 * postJsonToValidatedUrl is overridden.
 */

import '../helpers/setup';

import { createTestUser } from '../helpers/auth';
import { createTestPartnerOrg, createTestAccount } from '../helpers/seed';

jest.mock('../../lib/webhook', () => {
  const actual = jest.requireActual('../../lib/webhook');
  return { ...actual, postJsonToValidatedUrl: jest.fn() };
});
const { postJsonToValidatedUrl } = require('../../lib/webhook');

let prisma: any;
let emitPartnerEvent: any;
let sendEmail: any;

const toDelete: Array<{ model: string; id: string }> = [];

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  // Re-require after mocks are set up
  const mod = require('../../lib/partnerEvents');
  emitPartnerEvent = mod.emitPartnerEvent;
  sendEmail = require('../../lib/email').sendEmail;
});

afterAll(async () => {
  for (const { model, id } of toDelete.reverse()) {
    try { await (prisma as any)[model].delete({ where: { id } }); } catch {}
  }
  await prisma.$disconnect();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function enableConsent(accountId: string, key: string) {
  await prisma.accountSetting.upsert({
    where:  { accountId_key: { accountId, key } },
    update: { value: 'true' },
    create: { accountId, key, value: 'true' },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('consent=false → no PartnerEventLog record created', async () => {
  const org = await createTestPartnerOrg();
  toDelete.push({ model: 'partnerOrganization', id: org.id });
  const account = await createTestAccount(org.id);
  toDelete.push({ model: 'account', id: account.id });

  // Consent NOT enabled
  const before = await prisma.partnerEventLog.count({ where: { accountId: account.id } });
  await emitPartnerEvent(account.id, 'INSPECTION_COMPLETED', { assetName: 'Test' });
  const after = await prisma.partnerEventLog.count({ where: { accountId: account.id } });
  expect(after).toBe(before);
});

test('consent=true, no partnerOrg → no record created', async () => {
  const account = await createTestAccount(); // no partnerOrgId
  toDelete.push({ model: 'account', id: account.id });
  await enableConsent(account.id, 'partner_share_inspections');

  const before = await prisma.partnerEventLog.count({ where: { accountId: account.id } });
  await emitPartnerEvent(account.id, 'INSPECTION_COMPLETED', { assetName: 'Test' });
  const after = await prisma.partnerEventLog.count({ where: { accountId: account.id } });
  expect(after).toBe(before);
});

test('consent=true, partnerOrg exists → record created with assignedRepId', async () => {
  const org = await createTestPartnerOrg();
  toDelete.push({ model: 'partnerOrganization', id: org.id });
  const rep = await createTestUser('oem_admin', { partnerOrgId: org.id });
  toDelete.push({ model: 'user', id: rep.id });
  toDelete.push({ model: 'account', id: rep.accountId });

  const account = await createTestAccount(org.id, { assignedRepId: rep.id });
  toDelete.push({ model: 'account', id: account.id });
  await enableConsent(account.id, 'partner_share_inspections');

  await emitPartnerEvent(account.id, 'INSPECTION_COMPLETED', { assetName: 'Transformer A' });

  const log = await prisma.partnerEventLog.findFirst({
    where: { accountId: account.id, eventType: 'INSPECTION_COMPLETED' },
  });
  expect(log).not.toBeNull();
  expect(log.assignedRepId).toBe(rep.id);
  if (log) toDelete.push({ model: 'partnerEventLog', id: log.id });
});

test('dedup: calling emitPartnerEvent twice → only one record', async () => {
  const org = await createTestPartnerOrg();
  toDelete.push({ model: 'partnerOrganization', id: org.id });
  const account = await createTestAccount(org.id);
  toDelete.push({ model: 'account', id: account.id });
  await enableConsent(account.id, 'partner_share_inspections');

  await emitPartnerEvent(account.id, 'INSPECTION_COMPLETED', { assetName: 'A' });
  await emitPartnerEvent(account.id, 'INSPECTION_COMPLETED', { assetName: 'A' });

  const count = await prisma.partnerEventLog.count({
    where: { accountId: account.id, eventType: 'INSPECTION_COMPLETED', digestSentAt: null },
  });
  expect(count).toBe(1);
});

test('IMMEDIATE_DEFICIENCY → immediateEmailSentAt set after mock email send', async () => {
  const org = await createTestPartnerOrg();
  toDelete.push({ model: 'partnerOrganization', id: org.id });
  const rep = await createTestUser('oem_admin', { partnerOrgId: org.id });
  toDelete.push({ model: 'user', id: rep.id });
  toDelete.push({ model: 'account', id: rep.accountId });

  const account = await createTestAccount(org.id, { assignedRepId: rep.id });
  toDelete.push({ model: 'account', id: account.id });
  await enableConsent(account.id, 'partner_share_deficiencies');

  (sendEmail as jest.Mock).mockClear();
  await emitPartnerEvent(account.id, 'IMMEDIATE_DEFICIENCY', {
    assetName: 'Switchgear',
    description: 'Bus bar damaged',
  });

  // Allow async side-effects to settle
  await new Promise(r => setTimeout(r, 200));

  const log = await prisma.partnerEventLog.findFirst({
    where: { accountId: account.id, eventType: 'IMMEDIATE_DEFICIENCY' },
  });
  expect(log).not.toBeNull();
  expect(log.immediateEmailSentAt).not.toBeNull();
  expect(sendEmail).toHaveBeenCalled();
  if (log) toDelete.push({ model: 'partnerEventLog', id: log.id });
});

test('webhook fires when webhookUrl is set — HMAC signature header present', async () => {
  const webhookSecret = 'test-webhook-secret-32chars-exactly!!';
  const org = await createTestPartnerOrg({ webhookUrl: 'https://example.invalid/hook', webhookSecret });
  toDelete.push({ model: 'partnerOrganization', id: org.id });
  const account = await createTestAccount(org.id);
  toDelete.push({ model: 'account', id: account.id });
  await enableConsent(account.id, 'partner_share_inspections');

  (postJsonToValidatedUrl as jest.Mock).mockReset().mockResolvedValue({ ok: true, status: 200 });

  await emitPartnerEvent(account.id, 'INSPECTION_COMPLETED', { assetName: 'Relay' });
  await new Promise(r => setTimeout(r, 200));

  expect(postJsonToValidatedUrl).toHaveBeenCalled();
  const [callArgs] = (postJsonToValidatedUrl as jest.Mock).mock.calls[0];
  expect(callArgs.url).toBe('https://example.invalid/hook');
  expect(callArgs.headers['X-ServiceCycle-Signature']).toMatch(/^sha256=/);
});

test('webhook failure → webhookAttempts incremented, webhookLastFailedAt set, no throw', async () => {
  const org = await createTestPartnerOrg({
    webhookUrl: 'https://fail.invalid/hook',
    webhookSecret: 'test-secret-32-chars-long-exactly!!',
  });
  toDelete.push({ model: 'partnerOrganization', id: org.id });
  const account = await createTestAccount(org.id);
  toDelete.push({ model: 'account', id: account.id });
  await enableConsent(account.id, 'partner_share_inspections');

  // Simulate a network failure (or an SSRF block -- same { ok: false } shape).
  (postJsonToValidatedUrl as jest.Mock).mockReset().mockResolvedValue({ ok: false, reason: 'network-error' });

  // Should NOT throw
  await expect(
    emitPartnerEvent(account.id, 'INSPECTION_COMPLETED', { assetName: 'Panel' })
  ).resolves.not.toThrow();

  await new Promise(r => setTimeout(r, 300));

  const log = await prisma.partnerEventLog.findFirst({
    where: { accountId: account.id, eventType: 'INSPECTION_COMPLETED' },
  });
  expect(log).not.toBeNull();
  expect(log.webhookAttempts).toBeGreaterThan(0);
  expect(log.webhookLastFailedAt).not.toBeNull();
  if (log) toDelete.push({ model: 'partnerEventLog', id: log.id });
});
