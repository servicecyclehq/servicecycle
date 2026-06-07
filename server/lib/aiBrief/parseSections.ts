/**
 * parseSections — split the LLM output of a renewal brief into its four
 * structured sections.
 *
 * Phase 4 — v0.4.0.
 *
 * Every per-category template appends OUTPUT_CONTRACT_ENVELOPE which
 * instructs the model to emit exactly four sections, each headed by a
 * level-2 markdown header on its own line, in this order:
 *
 *   ## Situation
 *   ## Market
 *   ## Tactics
 *   ## Watch For
 *
 * The client renders one BriefSection per key, plus a BriefFeedbackWidget
 * scoped to that section. If the model doesn't follow the envelope
 * cleanly (missing one section, headers mis-spelled, etc.) we return
 * what we did find PLUS `parsed: false` so the client can fall back to
 * a plain-text render rather than showing blank cards.
 *
 * Header matching is whitespace-tolerant + case-sensitive (matches the
 * envelope's verbatim spelling). Lines before the first ## header are
 * dropped as preamble; lines after the last ## header are attached to
 * the final section.
 */

'use strict';

const HEADER_TO_KEY = Object.freeze({
  'Situation':  'situation',
  'Market':     'market',
  'Tactics':    'tactics',
  'Watch For':  'watchFor',
});

const HEADER_RE = /^##\s+(Situation|Market|Tactics|Watch For)\s*$/;

const EMPTY_SECTIONS = Object.freeze({
  situation: '',
  market:    '',
  tactics:   '',
  watchFor:  '',
});

/**
 * parseBriefSections(text) → { sections, parsed }
 *
 *   sections: { situation, market, tactics, watchFor } — strings, possibly empty
 *   parsed:   boolean — true iff all four keys are non-empty
 *
 * Never throws. Returns empty sections + parsed=false for non-string
 * input.
 */
function parseBriefSections(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { sections: { ...EMPTY_SECTIONS }, parsed: false };
  }

  const lines = text.split(/\r?\n/);
  const chunks = [];
  let current = null;

  for (const line of lines) {
    const m = line.match(HEADER_RE);
    if (m) {
      if (current) chunks.push(current);
      current = { header: m[1], body: [] };
    } else if (current) {
      current.body.push(line);
    }
    // Lines before the first matched header are preamble — discarded.
  }
  if (current) chunks.push(current);

  const sections = { ...EMPTY_SECTIONS };
  for (const c of chunks) {
    const key = HEADER_TO_KEY[c.header];
    if (!key) continue;
    sections[key] = c.body.join('\n').trim();
  }

  const parsed = Object.values(sections).every((s) => s.length > 0);
  return { sections, parsed };
}

module.exports = { parseBriefSections, HEADER_TO_KEY };

export {};
