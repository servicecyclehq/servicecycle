'use strict';

/**
 * L4: feedback subject bypasses EMAIL_MOCK.
 *
 * Mocks global.fetch so we can assert exactly when the network call
 * happens (and when it doesn't). Pure unit; runs offline.
 */

const path = require('path');

// Track every fetch the email helper makes. Reset in beforeEach.
globalThis.__mockFetchState = { calls: 0, lastUrl: null, lastBody: null };

const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  globalThis.__mockFetchState.calls++;
  globalThis.__mockFetchState.lastUrl = url;
  try {
    globalThis.__mockFetchState.lastBody = init && init.body ? JSON.parse(init.body) : null;
  } catch { globalThis.__mockFetchState.lastBody = null; }
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => '',
    json: async () => ({ messageId: 'mock-msg-id' }),
  };
};

const { sendEmail } = require('../lib/email');

const ORIG_ENV = {
  EMAIL_MOCK:     process.env.EMAIL_MOCK,
  BREVO_API_KEY:  process.env.BREVO_API_KEY,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM:     process.env.EMAIL_FROM,
};

beforeEach(() => {
  globalThis.__mockFetchState.calls = 0;
  globalThis.__mockFetchState.lastUrl = null;
  globalThis.__mockFetchState.lastBody = null;
  process.env.EMAIL_MOCK     = 'true';
  process.env.BREVO_API_KEY  = 'xkeysib-test-fake';
  process.env.EMAIL_FROM     = 'ServiceCycle <noreply@example.test>';
  delete process.env.RESEND_API_KEY;
});

const fetchCalls = () => globalThis.__mockFetchState.calls;
const lastBody   = () => globalThis.__mockFetchState.lastBody;
const lastUrl    = () => globalThis.__mockFetchState.lastUrl;

afterAll(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  globalThis.fetch = origFetch;
});

describe('L4: lib/email sendEmail() - feedback subject bypasses EMAIL_MOCK', () => {

  test('non-feedback email is mocked when EMAIL_MOCK=true (no network call)', async () => {
    await sendEmail({ to: 'a@x.test', subject: 'Welcome to ServiceCycle', html: '<p>hi</p>' });
    expect(fetchCalls()).toBe(0);
  });

  test('feedback email bypasses the mock - actually fires the HTTP call', async () => {
    await sendEmail({
      to:      'demofeedback@servicecycle.com',
      subject: '[ServiceCycle Feedback] bug - Demo Admin (admin)',
      html:    '<p>thing is broken</p>',
    });
    expect(fetchCalls()).toBe(1);
    expect(lastUrl()).toBe('https://api.brevo.com/v3/smtp/email');
    expect(lastBody().to[0].email).toBe('demofeedback@servicecycle.com');
    expect(lastBody().subject).toMatch(/^\[ServiceCycle Feedback\]/);
    expect(lastBody().sender.email).toBe('noreply@example.test');
  });

  test('feedback bypass still respects EMAIL_MOCK=false (already a real send)', async () => {
    process.env.EMAIL_MOCK = 'false';
    await sendEmail({
      to:      'demofeedback@servicecycle.com',
      subject: '[ServiceCycle Feedback] feature request',
      html:    '<p>idea</p>',
    });
    expect(fetchCalls()).toBe(1);
  });

  test('feedback bypass without BREVO_API_KEY surfaces a loud warning + drops the email', async () => {
    delete process.env.BREVO_API_KEY;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await sendEmail({
      to:      'demofeedback@servicecycle.com',
      subject: '[ServiceCycle Feedback] bug',
      html:    '<p>hi</p>',
    });
    expect(fetchCalls()).toBe(0);
    expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/feedback.*DROPPED/i);
    warnSpy.mockRestore();
  });

  test('case-sensitivity: only the exact "[ServiceCycle Feedback]" prefix bypasses', async () => {
    await sendEmail({ to: 'a@x.test', subject: '[servicecycle feedback] lowercase', html: '<p>hi</p>' });
    await sendEmail({ to: 'a@x.test', subject: 'Re: [ServiceCycle Feedback] thread reply', html: '<p>hi</p>' });
    expect(fetchCalls()).toBe(0); // both should mock - only true prefix bypasses
  });

  test('legacy RESEND_API_KEY without BREVO_API_KEY logs deprecation and skips send', async () => {
    delete process.env.BREVO_API_KEY;
    process.env.RESEND_API_KEY = 're_legacy_xxxx';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await sendEmail({
      to:      'demofeedback@servicecycle.com',
      subject: '[ServiceCycle Feedback] still here',
      html:    '<p>hi</p>',
    });
    expect(fetchCalls()).toBe(0);
    const allWarn = warnSpy.mock.calls.flat().join(' ');
    expect(allWarn).toMatch(/RESEND_API_KEY is set but BREVO_API_KEY is not/);
    warnSpy.mockRestore();
  });
});
