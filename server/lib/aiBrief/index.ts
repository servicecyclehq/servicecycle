/**
 * aiBrief -- per-category renewal-brief template router + opt-in
 * section orchestration entry-point.
 *
 * Routes a contract to the right per-category template based on
 * `contract.category.slug`. Each template module exports:
 *   - slug: string                           // matches Category.slug
 *   - version: string                        // template version (persisted on Contract.renewalBriefTemplateVersion)
 *   - systemPrompt: string                   // category-specific system prompt
 *   - buildUserPrompt(ctx, searchResults)    // returns the full user prompt
 *   - searchDomains: string[]                // Tavily allowlist (Layer 5)
 *   - searchTimeRange: 'year' | '2_years'    // Tavily time_range param
 *   - searchResultCap: number                // max results to feed in
 *
 * Unknown / null / missing slugs route to the `other` fallback so the
 * brief endpoint never fails on a category typo or a contract created
 * before the categories migration.
 *
 * This module re-exports OUTPUT_CONTRACT_ENVELOPE + the opt-in
 * supplementary-section helpers so callers (routes/contracts.js,
 * server/scripts/*) get a single import path.
 *
 * Phase 4 -- v0.4.0.
 * v0.36.0: re-exports buildOptInEnvelope + the optInSections registry.
 */

const { OUTPUT_CONTRACT_ENVELOPE, buildOptInEnvelope } = require('./outputContract');
const optIn = require('./optInSections');

const saas       = require('./templates/saas');
const other      = require('./templates/other');
const telecom    = require('./templates/telecom');
const insurance  = require('./templates/insurance');
const lease_rent = require('./templates/lease_rent');
const hardware   = require('./templates/hardware');
const services   = require('./templates/services');
const utilities  = require('./templates/utilities');
const supplies   = require('./templates/supplies');

// Slug strings must match the 9 system-default categories seeded by
// server/scripts/seed-categories.js. Adding a new category here without
// also seeding it (or vice-versa) leaves the new category routing to
// `other` -- which is safe but suboptimal. The 'other' slug is BOTH the
// generic-fallback template AND the seeded "Other" category for
// uncategorised contracts; that mapping is intentional.
const SLUG_REGISTRY = Object.freeze({
  saas,
  telecom,
  insurance,
  lease_rent,
  hardware,
  services,
  utilities,
  supplies,
  other,
});

/**
 * pickTemplate(slug) -- returns the template module for the given
 * category slug. Falls through to `other` if slug is null, undefined,
 * empty string, or not in the registry. Never throws.
 *
 * Examples:
 *   pickTemplate('saas')          // -> saas
 *   pickTemplate('telecom')       // -> telecom
 *   pickTemplate(null)            // -> other
 *   pickTemplate(undefined)       // -> other
 *   pickTemplate('')              // -> other
 *   pickTemplate('made_up_slug')  // -> other
 */
function pickTemplate(slug) {
  if (!slug || typeof slug !== 'string') return other;
  return SLUG_REGISTRY[slug] || other;
}

module.exports = {
  pickTemplate,
  OUTPUT_CONTRACT_ENVELOPE,
  buildOptInEnvelope,
  // optInSections registry + helpers, surfaced here so the route file
  // can pull everything from a single require path.
  optInSections: optIn,
  SLUG_REGISTRY,
};

export {};
