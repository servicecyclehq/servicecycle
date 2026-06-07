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
        schedule: { id: 's-1', nextDueDate: '2026-07-07', taskDefinition: { taskName: 'Annual oil analysis' } },
        asset: {
          id: 'a-1',
          equipmentType: 'transformer',
          manufacturer: 'Siemens',
          model: 'TX-500',
          serialNumber: 'SN-001',
          site: { name: 'North Plant' },
        },
        alertType: 'maintenance_due',
        daysUntil: 30,
        leadDays: 30,
      },
      {
        schedule: { id: 's-2', nextDueDate: '2026-05-31', taskDefinition: { taskName: 'Infrared scan' } },
        asset: {
          id: 'a-1',
          equipmentType: 'transformer',
          manufacturer: 'Siemens',
          model: 'TX-500',
          serialNumber: 'SN-001',
          site: { name: 'North Plant' },
        },
        alertType: 'escalation',
        daysUntil: -7,
      },
      {
        schedule: { id: 's-3', nextDueDate: '2026-06-05', taskDefinition: { taskName: 'Breaker trip test' } },
        asset: {
          id: 'a-2',
          equipmentType: 'circuit_breaker',
          manufacturer: 'ABB',
          model: 'CB-200',
          serialNumber: 'SN-002',
          site: { name: 'South Plant' },
        },
        alertType: 'overdue',
        daysUntil: -2,
      },
    ];
  }

  test('returns a MessageCard envelope', () => {
    const card = buildAlertDigest(fakeAlertItems(), {
      accountName: 'Acme Co',
      appUrl: 'https://demo.servicecycle.com',
    });
    expect(card['@type']).toBe('MessageCard');
    expect(card['@context']).toBe('http://schema.org/extensions');
    expect(typeof card.summary).toBe('string');
    expect(card.themeColor).toMatch(/^[0-9A-Fa-f]{6}$/);
    expect(Array.isArray(card.sections)).toBe(true);
  });

  test('title reports correct asset count (groups by asset id)', () => {
    const card = buildAlertDigest(fakeAlertItems(), {
      accountName: 'Acme Co',
      appUrl: 'https://demo.servicecycle.com',
    });
    expect(card.title).toMatch(/2 assets/);
  });

  test('asset sections deep-link to the right /assets/:id URLs', () => {
    const card = buildAlertDigest(fakeAlertItems(), {
      accountName: 'Acme Co',
      appUrl: 'https://demo.servicecycle.com',
    });
    const titles = card.sections.map(s => s.activityTitle).filter(Boolean).join(' ');
    expect(titles).toContain('https://demo.servicecycle.com/assets/a-1');
    expect(titles).toContain('https://demo.servicecycle.com/assets/a-2');
  });

  test('escalation alerts drive the red theme color', () => {
    const card = buildAlertDigest(fakeAlertItems(), { accountName: 'A', appUrl: 'https://x' });
    // escalation is the highest-priority type in the fixture — red-600.
    expect(card.themeColor).toBe('DC2626');
  });

  test('regulatory_breach outranks escalation for the theme color', () => {
    const items = fakeAlertItems();
    items.push({
      schedule: { id: 's-4', taskDefinition: { taskName: 'Statutory inspection' } },
      asset: { id: 'a-3', equipmentType: 'switchgear', manufacturer: 'Eaton', model: 'SG-1', site: { name: 'East Plant' } },
      alertType: 'regulatory_breach',
      daysUntil: -30,
    });
    const card = buildAlertDigest(items, { accountName: 'A', appUrl: 'https://x' });
    expect(card.themeColor).toBe('7F1D1D');
  });

  test('facts surface the task name and due-in days', () => {
    const card = buildAlertDigest(fakeAlertItems(), { accountName: 'A', appUrl: 'https://x' });
    const allFacts = card.sections.flatMap(s => s.facts || []);
    const due = allFacts.find(f => f.name === 'Maintenance due');
    expect(due).toBeTruthy();
    expect(due.value).toContain('Annual oil analysis');
    expect(due.value).toMatch(/in 30d/);
    const overdue = allFacts.find(f => f.name === 'Overdue');
    expect(overdue.value).toMatch(/2d overdue/);
  });

  test('truncates long alert lists with an overflow text section', () => {
    const items = [];
    for (let i = 0; i < 35; i++) {
      items.push({
        schedule: { id: `s-${i}`, taskDefinition: { taskName: `Task ${i}` } },
        asset: { id: `a-${i}`, equipmentType: 'transformer', manufacturer: 'M', model: `Model ${i}`, site: { name: 'Site' } },
        alertType: 'maintenance_due',
        daysUntil: i,
      });
    }
    const card = buildAlertDigest(items, { accountName: 'A', appUrl: 'https://x' });
    // 25 visible asset sections + 1 overflow text section = 26 total.
    const overflow = card.sections.find(s => typeof s.text === 'string' && s.text.startsWith('…and'));
    expect(overflow.text).toMatch(/and 10 more/);
  });

  test('escapes markdown special chars in asset names', () => {
    const items = [{
      schedule: { id: 's-x', taskDefinition: { taskName: 'Check' } },
      asset: { id: 'a-x', manufacturer: '*Siemens*', model: '[Pro]', site: { name: 'North_Plant' } },
      alertType: 'maintenance_due',
      daysUntil: 5,
    }];
    const card = buildAlertDigest(items, { accountName: 'A', appUrl: 'https://x' });
    const sec = card.sections[0];
    expect(sec.activityTitle).toContain('\\*Siemens\\*');
    expect(sec.activityTitle).toContain('\\[Pro\\]');
    expect(sec.activitySubtitle).toContain('North\\_Plant');
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
