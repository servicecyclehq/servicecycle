'use strict';

/**
 * Tests for lib/teams.js. Pure unit tests — no DB or live HTTP.
 *
 * Coverage mirrors slack.test.js:
 *   1. SSRF gate (isValidTeamsWebhookUrl) including the wildcard host
 *   2. buildAlertDigest produces a MessageCard with the expected sections
 *   3. sendTeamsMessage rejects an invalid URL without making a request
 *   4. TEAMS_MOCK short-circuit
 *   5. buildTestMessage shape
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  isValidTeamsWebhookUrl,
  buildAlertDigest,
  buildTestMessage,
  sendTeamsMessage,
} = require('../lib/teams');

describe('teams URL validation (SSRF gate)', () => {
  test('accepts a legacy outlook.office.com webhook URL', () => {
    expect(
      isValidTeamsWebhookUrl(
        'https://outlook.office.com/webhook/abc-123@def-456/IncomingWebhook/abcdef0123456789/abcdef0123456789'
      )
    ).toBe(true);
  });

  test('accepts the outlook.office365.com variant', () => {
    expect(
      isValidTeamsWebhookUrl(
        'https://outlook.office365.com/webhook/abc-123@def-456/IncomingWebhook/abcdef0123456789/abcdef0123456789'
      )
    ).toBe(true);
  });

  test('accepts a tenant-prefixed *.webhook.office.com URL', () => {
    expect(
      isValidTeamsWebhookUrl(
        'https://acme.webhook.office.com/webhookb2/abc-123@def-456/IncomingWebhook/abcdef0123456789/abcdef0123456789'
      )
    ).toBe(true);
  });

  test('rejects http (non-https) URLs', () => {
    expect(
      isValidTeamsWebhookUrl(
        'http://outlook.office.com/webhook/abc-123@def-456/IncomingWebhook/abcdef/abcdef'
      )
    ).toBe(false);
  });

  test('rejects internal IPs and arbitrary hosts (the SSRF case)', () => {
    expect(isValidTeamsWebhookUrl('https://127.0.0.1/webhook/x/IncomingWebhook/x/x')).toBe(false);
    expect(isValidTeamsWebhookUrl('https://10.0.0.5/webhook/x/IncomingWebhook/x/x')).toBe(false);
    expect(isValidTeamsWebhookUrl('https://attacker.example.com/webhook/x/IncomingWebhook/x/x')).toBe(false);
  });

  test('rejects URLs without /webhook(b2)?/ in the path', () => {
    expect(
      isValidTeamsWebhookUrl('https://outlook.office.com/api/something/else')
    ).toBe(false);
    expect(isValidTeamsWebhookUrl('https://outlook.office.com/')).toBe(false);
  });

  test('rejects embedded credentials', () => {
    expect(
      isValidTeamsWebhookUrl(
        'https://attacker:pw@outlook.office.com/webhook/x/IncomingWebhook/x/x'
      )
    ).toBe(false);
  });

  test('rejects empty / non-string input', () => {
    expect(isValidTeamsWebhookUrl('')).toBe(false);
    expect(isValidTeamsWebhookUrl(null)).toBe(false);
    expect(isValidTeamsWebhookUrl(undefined)).toBe(false);
    expect(isValidTeamsWebhookUrl(12345)).toBe(false);
  });

  test('subdomain wildcard does NOT match the bare host', () => {
    // *.webhook.office.com must require an actual prefix; a request for
    // "webhook.office.com" itself should not match the wildcard pattern.
    expect(
      isValidTeamsWebhookUrl('https://webhook.office.com/webhookb2/x/IncomingWebhook/x/x')
    ).toBe(false);
  });

  test('subdomain wildcard does not allow look-alike hosts', () => {
    expect(
      isValidTeamsWebhookUrl('https://webhook.office.com.attacker.com/webhookb2/x/IncomingWebhook/x/x')
    ).toBe(false);
  });
});

describe('Teams MessageCard digest builder', () => {
  function fakeAlertItems() {
    return [
      {
        contract: {
          id: 'c-1',
          product: 'Salesforce CRM',
          vendor: { id: 'v-1', name: 'Salesforce' },
          costPerLicense: '120',
          quantity: 50,
        },
        alertType: 'renewal',
        daysUntil: 30,
      },
      {
        contract: {
          id: 'c-1',
          product: 'Salesforce CRM',
          vendor: { id: 'v-1', name: 'Salesforce' },
          costPerLicense: '120',
          quantity: 50,
        },
        alertType: 'cancel_by',
        daysUntil: 7,
      },
      {
        contract: {
          id: 'c-2',
          product: 'Atlassian Suite',
          vendor: { id: 'v-2', name: 'Atlassian' },
          costPerLicense: '90',
          quantity: 100,
        },
        alertType: 'payment_due',
        daysUntil: 14,
        paymentAmount: '9000',
      },
    ];
  }

  test('returns a MessageCard envelope', () => {
    const card = buildAlertDigest(fakeAlertItems(), {
      accountName: 'Acme Co',
      appUrl: 'https://demo.lapseiq.com',
    });
    expect(card['@type']).toBe('MessageCard');
    expect(card['@context']).toBe('http://schema.org/extensions');
    expect(typeof card.summary).toBe('string');
    expect(card.themeColor).toMatch(/^[0-9A-Fa-f]{6}$/);
    expect(Array.isArray(card.sections)).toBe(true);
  });

  test('title reports correct contract count (groups by contract id)', () => {
    const card = buildAlertDigest(fakeAlertItems(), {
      accountName: 'Acme Co',
      appUrl: 'https://demo.lapseiq.com',
    });
    expect(card.title).toMatch(/2 contracts/);
  });

  test('contract sections deep-link to the right URLs', () => {
    const card = buildAlertDigest(fakeAlertItems(), {
      accountName: 'Acme Co',
      appUrl: 'https://demo.lapseiq.com',
    });
    const titles = card.sections.map(s => s.activityTitle).filter(Boolean).join(' ');
    expect(titles).toContain('https://demo.lapseiq.com/contracts/c-1');
    expect(titles).toContain('https://demo.lapseiq.com/contracts/c-2');
  });

  test('cancel_by alerts drive the red theme color', () => {
    const card = buildAlertDigest(fakeAlertItems(), { accountName: 'A', appUrl: 'https://x' });
    // cancel_by has highest priority in the digest — should pick its red.
    expect(card.themeColor).toBe('DC2626');
  });

  test('payment_due alerts surface the amount in the fact value', () => {
    const card = buildAlertDigest(fakeAlertItems(), { accountName: 'A', appUrl: 'https://x' });
    const allFacts = card.sections.flatMap(s => s.facts || []);
    const payment = allFacts.find(f => f.name === 'Payment due');
    expect(payment).toBeTruthy();
    expect(payment.value).toMatch(/\$9,000/);
  });

  test('truncates long alert lists with an overflow text section', () => {
    const items = [];
    for (let i = 0; i < 35; i++) {
      items.push({
        contract: { id: `c-${i}`, product: `Product ${i}`, vendor: { name: 'Vendor' } },
        alertType: 'renewal',
        daysUntil: i,
      });
    }
    const card = buildAlertDigest(items, { accountName: 'A', appUrl: 'https://x' });
    // 25 visible contract sections + 1 overflow text section = 26 total.
    const overflow = card.sections.find(s => typeof s.text === 'string' && s.text.startsWith('…and'));
    expect(overflow.text).toMatch(/and 10 more/);
  });

  test('escapes markdown special chars in contract names', () => {
    const items = [{
      contract: { id: 'c-x', product: '*Salesforce* [Pro]', vendor: { name: 'V_endor' } },
      alertType: 'renewal',
      daysUntil: 5,
    }];
    const card = buildAlertDigest(items, { accountName: 'A', appUrl: 'https://x' });
    const sec = card.sections[0];
    expect(sec.activityTitle).toContain('\\*Salesforce\\*');
    expect(sec.activityTitle).toContain('\\[Pro\\]');
    expect(sec.activitySubtitle).toContain('V\\_endor');
  });
});

describe('sendTeamsMessage', () => {
  test('rejects invalid webhook URL without making a request', async () => {
    const result = await sendTeamsMessage({
      webhookUrl: 'https://attacker.example.com/webhook/x/IncomingWebhook/x/x',
      card: { '@type': 'MessageCard' },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-webhook-url');
  });

  test('TEAMS_MOCK=true short-circuits without network', async () => {
    const previous = process.env.TEAMS_MOCK;
    process.env.TEAMS_MOCK = 'true';
    try {
      const result = await sendTeamsMessage({
        webhookUrl: 'https://acme.webhook.office.com/webhookb2/x/IncomingWebhook/x/x',
        card: { '@type': 'MessageCard', title: 'hi' },
      });
      expect(result.ok).toBe(true);
      expect(result.reason).toBe('mock');
    } finally {
      if (previous === undefined) delete process.env.TEAMS_MOCK;
      else process.env.TEAMS_MOCK = previous;
    }
  });
});

describe('buildTestMessage', () => {
  test('produces a MessageCard with title + section text', () => {
    const card = buildTestMessage({ accountName: 'Acme', byUserName: 'Dustin' });
    expect(card['@type']).toBe('MessageCard');
    expect(card.title).toMatch(/integration test/i);
    expect(card.text).toMatch(/Acme/);
    expect(card.sections.length).toBeGreaterThan(0);
  });
});
