'use strict';

/**
 * tests/partnerWebhookSigning.test.js
 * ------------------------------------
 * 2026-07-06 fallback-masks-capture follow-up: OEM-partner webhook delivery
 * (lib/partnerEvents.ts firePartnerWebhook + lib/partnerWebhookRetry.ts
 * runWebhookRetryCron) used to sign with a plain body-only HMAC -- no
 * timestamp, no replay window, indefinitely replayable if a signature+body
 * pair ever leaked. Both were switched to reuse lib/webhook.ts's
 * signPayload() over "<timestamp>.<body>", the same scheme the generic
 * account-level webhooks already use (X-ServiceCycle-Signature +
 * X-ServiceCycle-Timestamp + X-ServiceCycle-Delivery-Id).
 *
 * These are hermetic unit tests: prisma and the outbound HTTP call
 * (postJsonToValidatedUrl) are mocked; signPayload itself is the REAL
 * implementation from lib/webhook.ts so the assertions lock in genuine
 * signature correctness, not a re-implementation of the same logic.
 */

const { createHmac } = require('crypto');

// NOTE: '../lib/prisma' (no extension) matches jest.config.ts's
// moduleNameMapper (`^(\.{1,2}/.*)/prisma$`) and gets silently redirected to
// tests/__mocks__/prisma.js's no-op stub as a DIFFERENT module id than the
// one lib/partnerEvents.ts/lib/partnerWebhookRetry.ts resolve via their own
// bare `require('./prisma')` (which does NOT match that regex — needs an
// extra path segment before "/prisma" — and so loads the REAL client).
// Mocking with the explicit ".ts" extension sidesteps the mapper regex
// entirely so this jest.mock() targets the exact same resolved absolute
// file the lib modules under test import, instead of silently no-op'ing
// against an unrelated module id.
jest.mock('../lib/prisma.ts', () => ({
  __esModule: true,
  default: {
    partnerEventLog: {
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
  },
}));

jest.mock('../lib/email', () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/webhook', () => {
  const actual = jest.requireActual('../lib/webhook');
  return {
    ...actual,
    postJsonToValidatedUrl: jest.fn(),
  };
});

const prisma = require('../lib/prisma.ts').default;
const webhookLib = require('../lib/webhook'); // signPayload real, postJsonToValidatedUrl mocked
const { firePartnerWebhook } = require('../lib/partnerEvents');
const { runWebhookRetryCron } = require('../lib/partnerWebhookRetry');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  webhookLib.postJsonToValidatedUrl.mockReset();
  prisma.partnerEventLog.findMany.mockReset();
  prisma.partnerEventLog.update.mockReset().mockResolvedValue({});
});

// ── firePartnerWebhook (lib/partnerEvents.ts) ────────────────────────────────

describe('firePartnerWebhook — unified timestamped signature', () => {
  const partnerOrg = {
    id: 'partner-org-1',
    webhookUrl: 'https://partner.example.com/hook',
    webhookSecret: 'super-secret-hex-key',
  };
  const log = {
    id: 'log-1',
    eventType: 'IMMEDIATE_DEFICIENCY',
    accountId: 'account-1',
    assignedRepId: 'rep-1',
    assignedRep: { email: 'rep@example.com' },
    createdAt: new Date('2026-07-06T12:00:00.000Z'),
    payload: { assetName: 'Transformer T-12', description: 'Oil leak' },
  };

  test('sends X-ServiceCycle-Signature/Timestamp/Delivery-Id and the signature verifies against signPayload(body, timestamp, secret)', async () => {
    webhookLib.postJsonToValidatedUrl.mockResolvedValue({ ok: true, status: 200 });

    await firePartnerWebhook(log, partnerOrg);

    expect(webhookLib.postJsonToValidatedUrl).toHaveBeenCalledTimes(1);
    const call = webhookLib.postJsonToValidatedUrl.mock.calls[0][0];
    const { headers, body, url } = call;

    expect(url).toBe(partnerOrg.webhookUrl);
    expect(headers['X-ServiceCycle-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers['X-ServiceCycle-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-ServiceCycle-Delivery-Id']).toMatch(UUID_RE);

    // Timestamp is "now", within a few seconds.
    const ts = Number(headers['X-ServiceCycle-Timestamp']);
    expect(Math.abs(Date.now() / 1000 - ts)).toBeLessThan(10);

    // Recompute with the REAL signPayload and confirm it matches exactly.
    const expected = webhookLib.signPayload(body, headers['X-ServiceCycle-Timestamp'], partnerOrg.webhookSecret);
    expect(headers['X-ServiceCycle-Signature']).toBe(expected);

    // Regression lock: must NOT be the old body-only HMAC (no timestamp
    // prefix) -- that scheme is what let a captured signature+payload be
    // replayed indefinitely.
    const oldStyleSig = 'sha256=' + createHmac('sha256', partnerOrg.webhookSecret).update(body).digest('hex');
    expect(headers['X-ServiceCycle-Signature']).not.toBe(oldStyleSig);
  });

  test('body still carries the same partner-event envelope shape (payload shape unchanged, only signing changed)', async () => {
    webhookLib.postJsonToValidatedUrl.mockResolvedValue({ ok: true, status: 200 });
    await firePartnerWebhook(log, partnerOrg);

    const { body } = webhookLib.postJsonToValidatedUrl.mock.calls[0][0];
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({
      partnerId: partnerOrg.id,
      eventType: log.eventType,
      accountId: log.accountId,
      assignedRepEmail: log.assignedRep.email,
      data: log.payload,
    });
  });

  test('does nothing if webhookUrl or webhookSecret is missing', async () => {
    await firePartnerWebhook(log, { id: 'x', webhookUrl: null, webhookSecret: null });
    expect(webhookLib.postJsonToValidatedUrl).not.toHaveBeenCalled();
  });

  test('records webhookSentAt on success', async () => {
    webhookLib.postJsonToValidatedUrl.mockResolvedValue({ ok: true, status: 200 });
    await firePartnerWebhook(log, partnerOrg);
    expect(prisma.partnerEventLog.update).toHaveBeenCalledWith({
      where: { id: log.id },
      data: { webhookSentAt: expect.any(Date) },
    });
  });

  test('records failure bookkeeping without throwing when delivery fails', async () => {
    webhookLib.postJsonToValidatedUrl.mockResolvedValue({ ok: false, status: 500, reason: 'HTTP 500' });
    await expect(firePartnerWebhook(log, partnerOrg)).resolves.toBeUndefined();
    expect(prisma.partnerEventLog.update).toHaveBeenCalledWith({
      where: { id: log.id },
      data: { webhookAttempts: { increment: 1 }, webhookLastFailedAt: expect.any(Date) },
    });
  });
});

// ── runWebhookRetryCron (lib/partnerWebhookRetry.ts) ─────────────────────────

describe('runWebhookRetryCron — unified timestamped signature', () => {
  function mkCandidate(overrides = {}) {
    return {
      id: 'log-retry-1',
      eventType: 'TASK_OVERDUE',
      accountId: 'account-9',
      createdAt: new Date('2026-07-05T00:00:00.000Z'),
      payload: { taskName: 'IR scan' },
      webhookAttempts: 0,
      webhookLastFailedAt: null,
      assignedRep: { email: 'rep2@example.com' },
      partnerOrg: {
        id: 'partner-org-9',
        webhookUrl: 'https://partner9.example.com/hook',
        webhookSecret: 'retry-secret-key',
      },
      ...overrides,
    };
  }

  test('signs retried deliveries with signPayload(body, timestamp, secret) + the timestamp/delivery-id headers', async () => {
    const candidate = mkCandidate();
    prisma.partnerEventLog.findMany.mockResolvedValue([candidate]);
    webhookLib.postJsonToValidatedUrl.mockResolvedValue({ ok: true, status: 200 });

    const result = await runWebhookRetryCron();

    expect(webhookLib.postJsonToValidatedUrl).toHaveBeenCalledTimes(1);
    const { headers, body, url } = webhookLib.postJsonToValidatedUrl.mock.calls[0][0];
    expect(url).toBe(candidate.partnerOrg.webhookUrl);
    expect(headers['X-ServiceCycle-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers['X-ServiceCycle-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-ServiceCycle-Delivery-Id']).toMatch(UUID_RE);

    const expected = webhookLib.signPayload(body, headers['X-ServiceCycle-Timestamp'], candidate.partnerOrg.webhookSecret);
    expect(headers['X-ServiceCycle-Signature']).toBe(expected);

    const oldStyleSig = 'sha256=' + createHmac('sha256', candidate.partnerOrg.webhookSecret).update(body).digest('hex');
    expect(headers['X-ServiceCycle-Signature']).not.toBe(oldStyleSig);

    expect(result).toEqual({ checked: 1, succeeded: 1, failed: 0, exhausted: 0 });
  });

  test('skips (does not sign or send) when the partner org has no webhookSecret configured', async () => {
    const candidate = mkCandidate({
      partnerOrg: { id: 'partner-org-nosecret', webhookUrl: 'https://x.example.com/hook', webhookSecret: null },
    });
    prisma.partnerEventLog.findMany.mockResolvedValue([candidate]);

    const result = await runWebhookRetryCron();

    expect(webhookLib.postJsonToValidatedUrl).not.toHaveBeenCalled();
    expect(result.checked).toBe(1);
    expect(result.failed + result.exhausted).toBe(1);
  });
});
