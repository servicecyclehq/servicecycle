/* F-AI-LEAK: shared system-prompt leak guard applied to every AI surface. */
'use strict';

const { scrubPromptLeak } = require('../lib/aiOutputGuard');

describe('aiOutputGuard.scrubPromptLeak', () => {
  const refusal = /can't share my own instructions/i;

  test('redacts an Ask system-prompt leak', () => {
    const t = '**System Prompt:**\n\nYou are the LapseIQ in-product assistant. You help with two things only: ...';
    expect(scrubPromptLeak(t)).toMatch(refusal);
  });

  test('redacts a renewal-brief prompt leak', () => {
    const t = 'You are a software procurement advisor with 14 years of SaaS renewal-management experience helping a business renew SaaS contracts strategically...';
    expect(scrubPromptLeak(t)).toMatch(refusal);
  });

  test('redacts an extractor prompt leak', () => {
    expect(scrubPromptLeak('You are a software contract data extraction specialist with deep expertise...')).toMatch(refusal);
  });

  test('redacts an analysis-persona prompt leak', () => {
    expect(scrubPromptLeak('...a senior market intelligence analyst with deep expertise in enterprise software...')).toMatch(refusal);
  });

  test('passes a legitimate renewal brief through untouched', () => {
    const brief = 'Your Datadog contract auto-renews Jun 4. Cancel by then to avoid the 12% uplift; consider co-terming it with your other observability tools to gain leverage.';
    expect(scrubPromptLeak(brief)).toBe(brief);
  });

  test('does NOT redact a bare LOAD_SECTION tool line (Ask protocol intact)', () => {
    expect(scrubPromptLeak('LOAD_SECTION: ai_quota')).toBe('LOAD_SECTION: ai_quota');
  });

  test('handles empty / non-string input', () => {
    expect(scrubPromptLeak('')).toBe('');
    expect(scrubPromptLeak(null)).toBe(null);
    expect(scrubPromptLeak(undefined)).toBe(undefined);
  });
});
