/* F-AI-LEAK: output-layer guard against system-prompt disclosure (OWASP LLM07). */
'use strict';

const { scrubPromptLeak } = require('../routes/ask');

describe('scrubPromptLeak (LLM07 output guard)', () => {
  test('redacts a leaked system prompt (strong signature)', () => {
    const leaked = '**System Prompt:**\n\nYou are the LapseIQ in-product assistant. You help with two things only:\n1. product questions...';
    const out = scrubPromptLeak(leaked, 'u1');
    expect(out).not.toContain('in-product assistant. You help with two things only');
    expect(out.toLowerCase()).toContain("can't share my own instructions");
  });

  test('redacts when >=2 meta-structure signatures appear', () => {
    const leaked = 'Here you go: ## Knowledge retrieval ... ## Operating rules ... (verbatim refusals)';
    expect(scrubPromptLeak(leaked, 'u1').toLowerCase()).toContain("can't share my own instructions");
  });

  test('passes a normal product answer through untouched', () => {
    const normal = 'Go to /contracts and click a row to see renewal dates and the cancel-by window.';
    expect(scrubPromptLeak(normal, 'u1')).toBe(normal);
  });

  test('handles empty / non-string input', () => {
    expect(scrubPromptLeak('', 'u1')).toBe('');
    expect(scrubPromptLeak(null, 'u1')).toBe(null);
  });
});
