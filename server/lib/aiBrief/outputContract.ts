/**
 * outputContract.js -- the structured 4-section instruction envelope
 * every category template appends to its user prompt, PLUS the
 * opt-in supplementary-section envelope builder for the second
 * (admin-toggled-sections) LLM call.
 *
 * The exact section headers below (## Situation, ## Market, ## Tactics,
 * ## Watch For) are SERVER-PARSED in routes/contracts.js (via
 * parseSections.js) after the LLM call to split the response into the
 * structured shape the UI (BriefSection.jsx) renders. If you change a
 * header here, update both:
 *   - the splitter in parseSections.js
 *   - the section-name constants used by BriefFeedbackWidget for
 *     per-section feedback (Layer 7)
 *
 * Kept in its own module to avoid the circular import that would
 * otherwise arise between aiBrief/index.js and aiBrief/templates/*.js.
 *
 * Phase 4 -- v0.4.0.
 * v0.36.0: added buildOptInEnvelope() for admin-toggleable sections.
 */

const OUTPUT_CONTRACT_ENVELOPE = `

Structure your response as exactly four sections, each headed by a level-2 markdown header on its own line, in this exact order and with these exact spellings:

## Situation
2-3 short paragraphs, target ~180 words. Combine (a) the current state of the contract, key dates, auto-renewal traps, urgent deadlines, AND (b) your top-line recommended next steps for the procurement team before the deadline. Be specific and actionable.

## Market
2-3 short paragraphs, target ~180 words. Relevant market context: pricing trends, comparable alternatives, vendor positioning, recent industry signals. When web-search reference material is provided below, cite specific data points; when none is available, state assumptions clearly.

## Tactics
2-3 short paragraphs, target ~200 words. Negotiation angles specific to this contract: leverage points, multi-year tradeoffs, volume scaling, co-term opportunities, competitive alternatives, usage patterns. Each angle should be one the procurement team can actually use.

## Watch For
2-3 short paragraphs, target ~200 words. Contract-specific risks: auto-renewal traps, price-escalation clauses, termination terms, minimum-commit obligations, vendor-side red flags. Surface anything the team should not let slip. THIS SECTION IS WHERE BRIEFS ROUTINELY GET CUT OFF MID-SENTENCE -- keep paragraphs tight and finish every thought.

──────────────────────────────────────────────────────────────────────────
BUDGET DISCIPLINE

The total response should land between 700 and 800 words across all four sections -- never more. If you're writing the Situation section and find yourself approaching 220 words, you're being too verbose; tighten it. Reserve enough output budget for ALL FOUR sections to finish their last sentence properly -- the brief is judged by the reader on whether the final section ends mid-word or mid-thought. Do not be flowery; procurement teams want signal density, not prose. Plain paragraphs only inside each section. No nested bullet lists. No headers other than the four section headers above. Do NOT add a preamble, executive summary, or trailing notes outside the four sections.

──────────────────────────────────────────────────────────────────────────
TONE & CLAIMS DISCIPLINE (applies to every section)

1. Treat pricing rollover as POSSIBLE, not certain. Multi-year SaaS contracts almost always include annual uplift clauses (3-7% is standard); without seeing the signed agreement you do not know whether a renewal will hold the current rate. Use language like "if the contract holds at current pricing" or "verify against the signed agreement for any annual uplift clause" -- NEVER assert "the contract will roll forward at $X" as fact.

2. Negotiation is always at vendor discretion. Avoid directive phrasing like "you can negotiate X" or "stop the auto-renewal by doing Y". Use suggestive phrasing -- "you may be able to request", "the team can ask whether", "if the vendor is open to it" -- so the brief reflects the reality that vendors decide what they're willing to discuss.

3. Be specific about what the procurement team can act on, not what the vendor will do. "Document your renewal decision by [date]" is fine. "Notify the vendor to stop auto-renewal" is fine. "The vendor will offer a multi-year discount" is not -- they might, they might not.

4. Where the brief surfaces a specific dollar figure or percentage, attribute it to its source: "the contract record shows $X", "industry benchmarks (see Market section) suggest Y%", or "verify against the signed agreement". Do NOT invent numbers; do NOT restate contract figures with implied certainty about future periods.

5. RECENCY MATTERS for the Market section. Anchor every market claim to the most recent data available. When web-search reference material is provided below, prefer citations from the last 12 months; if a snippet is undated or older than 18 months, either flag it as "historical context" or drop it. Do NOT describe data from your training as "recent" or "current" -- your training cutoff is months stale, and procurement teams need today's market, not last year's. If no recent data is available, say so honestly ("recent benchmarks for this category were not retrieved; the discussion below relies on general market patterns") rather than presenting old data as current.

6. NEVER use the word "identifiers" in any output. When referring to contract record fields like contract numbers, customer numbers, or PO numbers, use phrases like "contract information", "previous order references", "contract record fields", or name them specifically ("contract number", "PO number"). The word "identifiers" reads as jargon to procurement teams.

7. DATE GROUNDING IS CRITICAL. The user prompt opens with "Today's date: <Month D, YYYY>." Every recommendation about deadlines, decision windows, or "act by" dates MUST anchor to that today value, NOT to dates from your training knowledge. If the contract's end date is July 2026 and today is May 2026, you have ~60 days to act -- not "you should have acted by mid-2025." Concretely: subtract today from the contract end date to compute days remaining; recommend internal-decision deadlines as today + N days, where N is a reasonable lead time for the action. NEVER recommend action by a date in the past. If you would recommend a date earlier than today, you have a date-grounding bug -- recompute against the "Today's date" line at the top of the user prompt.`;

// -- Opt-in supplementary-section envelope (v0.36.0) ----------------
//
// Built dynamically from the enabled-slug list because each call has a
// different selection. Pulls the section registry (slugs, headers,
// directives) from ./optInSections so the envelope text and the parser
// stay in lockstep.
//
// Returns null when no slugs are enabled so the route knows to skip
// the second LLM call entirely.
const { ALL_SLUGS, SECTIONS_BY_SLUG } = require('./optInSections');

function buildOptInEnvelope(enabledSlugs) {
  if (!Array.isArray(enabledSlugs) || enabledSlugs.length === 0) return null;
  const ordered = ALL_SLUGS.filter((s) => enabledSlugs.includes(s));
  if (ordered.length === 0) return null;

  const parts = [
    '',
    '──────────────────────────────────────────────────────────────────────────',
    'SUPPLEMENTARY SECTIONS (admin-enabled)',
    '',
    'Structure your response as exactly the following sections, in this order, each headed by a level-2 markdown header on its own line, with the exact spelling shown:',
    '',
  ];
  for (const slug of ordered) {
    const def = SECTIONS_BY_SLUG[slug];
    parts.push('## ' + def.header);
    parts.push(def.directive);
    parts.push('');
  }
  parts.push('──────────────────────────────────────────────────────────────────────────');
  parts.push('BUDGET DISCIPLINE');
  parts.push('');
  parts.push('Total response across these supplementary sections should land between 250 and 450 words depending on how many sections were requested -- never more. Reserve enough output budget for every requested section to finish its last sentence properly. No headers other than those listed above. Do NOT emit the main-brief headers (Situation / Market / Tactics / Watch For); the always-on call already produced those.');
  return parts.join('\n');
}

module.exports = { OUTPUT_CONTRACT_ENVELOPE, buildOptInEnvelope };

export {};
