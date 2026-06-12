'use strict';

/**
 * Tests for lib/slack.js. Pure unit tests — no DB or live HTTP, just URL
 * validation and Block Kit shape.
 *
 * Coverage:
 *   1. SSRF gate (isValidSlackWebhookUrl)
 *   2. buildAlertDigest produces the expected block sequence
 *   3. sendSlackMessage rejects an invalid URL without making a request
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  isValidSlackWebhookUrl,
  buildAlertDigest,
  buildTestMessage,
  sendSlackMessage,
} = require('../lib/slack');

describe('slack URL validation (SSRF gate)', () => {
  test('accepts a real-shape Slack webhook URL', () => {
    expect(
      isValidSlackWebhookUrl('https://hooks.slack.com/services/T012345/B098765/abcdEFGH1234ijklMNOP5678')
    ).toBe(true);
  });

  test('rejects http (non-https) URLs', () => {
    expect(
      isValidSlackWebhookUrl('http://hooks.slack.com/services/T012345/B098765/abcd1234')
    ).toBe(false);
  });

  test('rejects URLs on other slack subdomains', () => {
    expect(
      isValidSlackWebhookUrl('https://api.slack.com/services/T012345/B098765/abcd1234')
    ).toBe(false);
    expect(
      isValidSlackWebhookUrl('https://slack.com/services/T012345/B098765/abcd1234')
    ).toBe(false);
  });

  test('rejects internal IP addresses (the SSRF case)', () => {
    expect(isValidSlackWebhookUrl('https://127.0.0.1/services/T/B/x')).toBe(false);
    expect(isValidSlackWebhookUrl('https://10.0.0.5/services/T/B/x')).toBe(false);
    expect(isValidSlackWebhookUrl('https://169.254.169.254/services/T/B/x')).toBe(false);
  });

  test('rejects URLs with too few path components', () => {
    expect(isValidSlackWebhookUrl('https://hooks.slack.com/services/T012345')).toBe(false);
    expect(isValidSlackWebhookUrl('https://hooks.slack.com/services/T012345/B098765')).toBe(false);
    expect(isValidSlackWebhookUrl('https://hooks.slack.com/')).toBe(false);
  });

  test('rejects empty / non-string input', () => {
    expect(isValidSlackWebhookUrl('')).toBe(false);
    expect(isValidSlackWebhookUrl(null)).toBe(false);
    expect(isValidSlackWebhookUrl(undefined)).toBe(false);
    expect(isValidSlackWebhookUrl(12345)).toBe(false);
  });

  test('rejects URLs with embedded credentials', () => {
    expect(
      isValidSlackWebhookUrl('https://attacker:pw@hooks.slack.com/services/T/B/x')
    ).toBe(false);
  });
});

describe('Block Kit digest builder', () => {
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

  test('returns text fallback + block kit array', () => {
    const out = buildAlertDigest(fakeAlertItems(), {
      accountName: 'Acme Co',
      appUrl: 'https://servicecycle.app',
    });
    expect(typeof out.text).toBe('string');
    expect(Array.isArray(out.blocks)).toBe(true);
    expect(out.blocks.length).toBeGreaterThan(0);
  });

  test('header reports correct asset count (groups by asset id)', () => {
    const out = buildAlertDigest(fakeAlertItems(), {
      accountName: 'Acme Co',
      appUrl: 'https://servicecycle.app',
    });
    const header = out.blocks.find(b => b.type === 'header');
    expect(header.text.text).toMatch(/2 assets/);
  });

  test('asset block links use the /assets/:id deep-link URL', () => {
    const out = buildAlertDigest(fakeAlertItems(), {
      accountName: 'Acme Co',
      appUrl: 'https://servicecycle.app',
    });
    const sectionBlocks = out.blocks.filter(b => b.type === 'section');
    expect(sectionBlocks.some(b => b.text.text.includes('https://servicecycle.app/assets/a-1'))).toBe(true);
    expect(sectionBlocks.some(b => b.text.text.includes('https://servicecycle.app/assets/a-2'))).toBe(true);
  });

  test('section lines include the task name and alert-type label', () => {
    const out = buildAlertDigest(fakeAlertItems(), {
      accountName: 'Acme Co',
      appUrl: 'https://servicecycle.app',
    });
    const allText = out.blocks.filter(b => b.type === 'section').map(b => b.text.text).join('\n');
    expect(allText).toContain('Annual oil analysis');
    expect(allText).toContain('Breaker trip test');
    expect(allText).toMatch(/Escalation/);
    expect(allText).toMatch(/Overdue/);
  });

  test('truncates long alert lists with a "…and N more" footer', () => {
    const items = [];
    for (let i = 0; i < 30; i++) {
      items.push({
        schedule: { id: `s-${i}`, taskDefinition: { taskName: `Task ${i}` } },
        asset: { id: `a-${i}`, equipmentType: 'transformer', manufacturer: 'M', model: `Model ${i}`, site: { name: 'Site' } },
        alertType: 'maintenance_due',
        daysUntil: i,
      });
    }
    const out = buildAlertDigest(items, { accountName: 'A', appUrl: 'https://x' });
    const ctx = out.blocks.filter(b => b.type === 'context').map(b => b.elements[0].text).join(' ');
    expect(ctx).toMatch(/and 10 more/);
  });

  test('mrkdwn-escapes asset names with angle brackets', () => {
    const items = [{
      schedule: { id: 's-x', taskDefinition: { taskName: 'Check' } },
      asset: { id: 'a-x', manufacturer: '<script>alert(1)</script>', model: 'M1', site: { name: 'S' } },
      alertType: 'maintenance_due',
      daysUntil: 5,
    }];
    const out = buildAlertDigest(items, { accountName: 'A', appUrl: 'https://x' });
    const sec = out.blocks.find(b => b.type === 'section');
    expect(sec.text.text).toContain('&lt;script&gt;');
    expect(sec.text.text).not.toContain('<script>');
  });
});

describe('sendSlackMessage', () => {
  test('rejects invalid webhook URL without making a request', async () => {
    // No mocking needed — the function returns before any fetch call.
    const result = await sendSlackMessage({
      webhookUrl: 'https://attacker.example.com/services/T/B/x',
      text: 'should never send',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-webhook-url');
  });

  test('SLACK_MOCK=true short-circuits without network', async () => {
    const previous = process.env.SLACK_MOCK;
    process.env.SLACK_MOCK = 'true';
    try {
      const result = await sendSlackMessage({
        webhookUrl: 'https://hooks.slack.com/services/T/B/x',
        text: 'hi',
      });
      expect(result.ok).toBe(true);
      expect(result.reason).toBe('mock');
    } finally {
      if (previous === undefined) delete process.env.SLACK_MOCK;
      else process.env.SLACK_MOCK = previous;
    }
  });
});

describe('buildTestMessage', () => {
  test('produces a header + section + context', () => {
    const out = buildTestMessage({ accountName: 'Acme', byUserName: 'Dustin' });
    expect(out.text).toMatch(/Acme/);
    const types = out.blocks.map(b => b.type);
    expect(types).toEqual(expect.arrayContaining(['header', 'section', 'context']));
  });
});
