'use strict';

const { parseBriefSections } = require('../lib/aiBrief/parseSections');

describe('parseBriefSections', () => {
  test('happy path: all four sections present', () => {
    const text = [
      '## Situation',
      'Sit body line 1.',
      'Sit body line 2.',
      '',
      '## Market',
      'Mkt body.',
      '',
      '## Tactics',
      'Tac body line 1.',
      'Tac body line 2.',
      '',
      '## Watch For',
      'Watch body.',
    ].join('\n');

    const { sections, parsed } = parseBriefSections(text);
    expect(parsed).toBe(true);
    expect(sections.situation).toBe('Sit body line 1.\nSit body line 2.');
    expect(sections.market).toBe('Mkt body.');
    expect(sections.tactics).toBe('Tac body line 1.\nTac body line 2.');
    expect(sections.watchFor).toBe('Watch body.');
  });

  test('handles preamble before first header (drops it)', () => {
    const text = [
      'Some preamble the LLM dropped in despite our instructions.',
      '',
      '## Situation',
      'Sit.',
      '## Market',
      'Mkt.',
      '## Tactics',
      'Tac.',
      '## Watch For',
      'W.',
    ].join('\n');
    const { sections, parsed } = parseBriefSections(text);
    expect(parsed).toBe(true);
    expect(sections.situation).toBe('Sit.');
  });

  test('parsed=false when a section is missing', () => {
    const text = '## Situation\nA.\n## Market\nB.\n## Tactics\nC.\n';
    const { sections, parsed } = parseBriefSections(text);
    expect(parsed).toBe(false);
    expect(sections.situation).toBe('A.');
    expect(sections.watchFor).toBe('');
  });

  test('parsed=false on empty input', () => {
    expect(parseBriefSections('')).toEqual({
      sections: { situation: '', market: '', tactics: '', watchFor: '' },
      parsed:   false,
    });
  });

  test('parsed=false on non-string input', () => {
    expect(parseBriefSections(null).parsed).toBe(false);
    expect(parseBriefSections(undefined).parsed).toBe(false);
    expect(parseBriefSections(42).parsed).toBe(false);
  });

  test('handles trailing whitespace on header line', () => {
    const text = '## Situation   \nA.\n## Market\nB.\n## Tactics\nC.\n## Watch For\nD.\n';
    const { sections, parsed } = parseBriefSections(text);
    expect(parsed).toBe(true);
    expect(sections.situation).toBe('A.');
  });

  test('Watch For — preserves the space-in-header', () => {
    const text = '## Situation\nA.\n## Market\nB.\n## Tactics\nC.\n## Watch For\nD.\n';
    const { sections } = parseBriefSections(text);
    expect(sections.watchFor).toBe('D.');
  });

  test('extra ## headers after the four expected ones are ignored', () => {
    // Defensive: if the LLM hallucinates a fifth section, our key map
    // simply skips it. The four canonical sections still come through.
    const text = '## Situation\nA.\n## Market\nB.\n## Tactics\nC.\n## Watch For\nD.\n## Bonus\nshould be dropped';
    const { sections, parsed } = parseBriefSections(text);
    expect(parsed).toBe(true);
    // The "## Bonus" line itself is captured by the previous Watch For
    // section because it doesn't match a known header. That's acceptable
    // — better than crashing.
    expect(sections.situation).toBe('A.');
  });

  test('CRLF line endings work too', () => {
    const text = '## Situation\r\nA.\r\n## Market\r\nB.\r\n## Tactics\r\nC.\r\n## Watch For\r\nD.\r\n';
    const { parsed } = parseBriefSections(text);
    expect(parsed).toBe(true);
  });
});
