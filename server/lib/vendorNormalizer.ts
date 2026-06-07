/**
 * vendorNormalizer.js
 *
 * Shared vendor resolution utility.  Called by every contract creation path —
 * manual form, document ingest, CSV import, cloud connector — so that vendor
 * matching logic lives in exactly one place.
 *
 * Exports
 * ───────
 *   normalizeVendorName(name)              → normalized string (lowercase, no punctuation/suffixes)
 *   resolveViaAliasMap(inputName)          → canonical name string | null
 *   findSimilarVendors(inputName, vendors) → array of { vendor, matchType, score }
 *
 * Match types (in priority order)
 * ────────────────────────────────
 *   'exact'        — normalized input === normalized existing vendor name
 *   'alias'        — input resolves to a canonical name that matches an existing vendor
 *   'stored_alias' — input matches a custom alias stored on the existing vendor record
 *   'partial'      — input is contained in (or contains) the existing vendor name after normalization
 */

const VENDOR_ALIASES = require('./vendorAliases');

// ── Purely legal/corporate entity suffixes stripped during normalization ──────
// We deliberately exclude industry-descriptive words like "technologies",
// "software", "cloud", "services", "systems" — these are often CORE to a brand
// name (e.g. "Amazon Web Services", "Google Cloud", "Palo Alto Networks").
// Only strip suffixes that carry zero brand signal: Inc, LLC, Corp, Ltd, etc.
const SUFFIX_PATTERN = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|group|holdings|pty|plc|gmbh|ag|sro|bv|nv|sa|spa|sas|aps)\b/g;

// Common top-level domains and "www." that may appear in vendor names
const TLD_PATTERN = /\b(www|com|net|org|io|co|us|uk|de|fr|au)\b/g;

/**
 * Reduce a vendor name to a comparable token:
 *   - Lowercase
 *   - Strip common TLDs (handles "Salesforce.com" → "salesforce")
 *   - Remove punctuation
 *   - Strip purely legal entity suffixes (Inc, LLC, Corp, Ltd…)
 *   - Collapse whitespace
 *
 * Examples:
 *   "TechSmith, Inc."     → "techsmith"
 *   "Tech Smith"          → "techsmith"
 *   "Amazon Web Services" → "amazonwebservices"
 *   "Salesforce.com"      → "salesforce"
 *   "AWS"                 → "aws"
 */
function normalizeVendorName(name) {
  if (!name || typeof name !== 'string') return '';

  return name
    .toLowerCase()
    // Remove apostrophes
    .replace(/'/g, '')
    // Strip TLD suffixes attached via dot (e.g. ".com", ".io") before removing punctuation
    .replace(/\.(com|net|org|io|co|us|uk|de|fr|au)\b/g, '')
    // Collapse dotted abbreviations like "s.r.o." → "sro", "b.v." → "bv" so the
    // suffix pattern can still match them after punctuation is removed.
    .replace(/\b([a-z])\.([a-z])\.([a-z])\.?\b/g, '$1$2$3')
    .replace(/\b([a-z])\.([a-z])\.?\b/g, '$1$2')
    // Replace any remaining non-alphanumeric (except spaces and hyphens) with space
    .replace(/[^a-z0-9 -]/g, ' ')
    // Remove legal entity suffixes (whole-word match, safe to strip anywhere)
    .replace(SUFFIX_PATTERN, ' ')
    // Collapse hyphens and spaces
    .replace(/[-\s]+/g, '')
    .trim();
}

// ── Build fast lookup maps from the alias list ────────────────────────────────

// Map: normalizedAlias → canonical name
const aliasToCanonical = new Map();
// Map: normalizedCanonical → canonical name (for direct canonical lookups)
const canonicalNormMap = new Map();

for (const { canonical, aliases } of VENDOR_ALIASES) {
  const normCanonical = normalizeVendorName(canonical);
  canonicalNormMap.set(normCanonical, canonical);

  for (const alias of aliases) {
    aliasToCanonical.set(normalizeVendorName(alias), canonical);
  }
}

/**
 * Check whether the input name matches any entry in the curated alias map.
 * Returns the canonical display name if matched, otherwise null.
 *
 * Examples:
 *   resolveViaAliasMap('AWS')    → 'Amazon Web Services'
 *   resolveViaAliasMap('SFDC')   → 'Salesforce'
 *   resolveViaAliasMap('Splunk') → null  (Splunk is a canonical, handled by normalization)
 */
function resolveViaAliasMap(inputName) {
  if (!inputName) return null;
  const norm = normalizeVendorName(inputName);

  // Direct alias hit
  if (aliasToCanonical.has(norm)) {
    return aliasToCanonical.get(norm);
  }

  // Input happens to exactly match a canonical (e.g. "Amazon Web Services")
  if (canonicalNormMap.has(norm)) {
    return canonicalNormMap.get(norm);
  }

  return null;
}

/**
 * Given a vendor name string and an array of existing vendor records (from DB),
 * return all potential duplicates with a matchType and a numeric score (higher = stronger).
 *
 * @param {string}   inputName         - Raw vendor name as entered / parsed
 * @param {Array}    existingVendors   - Array of vendor objects, each with at minimum { id, name, aliases? }
 * @returns {Array}  Sorted array of { vendor, matchType, score }
 *
 * The caller decides what to do with the results:
 *   - score 100 = definitive match (block or auto-link)
 *   - score 70-99 = strong suggestion (warn user, offer to link)
 *   - score 40-69 = weak suggestion (surface as "did you mean?")
 */
function findSimilarVendors(inputName, existingVendors) {
  if (!inputName || !Array.isArray(existingVendors) || existingVendors.length === 0) {
    return [];
  }

  const normInput      = normalizeVendorName(inputName);
  const canonicalInput = resolveViaAliasMap(inputName); // may be null
  const normCanonical  = canonicalInput ? normalizeVendorName(canonicalInput) : null;

  const results = [];

  for (const vendor of existingVendors) {
    const normExisting = normalizeVendorName(vendor.name);

    // ── 1. Exact normalized match ─────────────────────────────────────────────
    if (normInput === normExisting) {
      results.push({ vendor, matchType: 'exact', score: 100 });
      continue;
    }

    // ── 2. Alias map canonical match ──────────────────────────────────────────
    // Input resolves to a canonical, and the existing vendor's name normalizes
    // to that same canonical — or vice versa (existing vendor name is an alias
    // of something that also matches the input's canonical).
    if (normCanonical) {
      if (normCanonical === normExisting) {
        results.push({ vendor, matchType: 'alias', score: 95 });
        continue;
      }
      // Check if existing vendor name also resolves to the same canonical
      const existingCanonical = resolveViaAliasMap(vendor.name);
      if (existingCanonical && normalizeVendorName(existingCanonical) === normCanonical) {
        results.push({ vendor, matchType: 'alias', score: 90 });
        continue;
      }
    }

    // ── 3. Stored custom aliases on the existing vendor record ────────────────
    // Vendors can have a JSON `aliases` array for org-specific alternate names
    // (e.g. internal procurement codes like "MSFT-EA", "Zoom-Video").
    const storedAliases = Array.isArray(vendor.aliases) ? vendor.aliases : [];
    if (storedAliases.length > 0) {
      const normStored = storedAliases.map(a => normalizeVendorName(a));
      if (normStored.includes(normInput)) {
        results.push({ vendor, matchType: 'stored_alias', score: 88 });
        continue;
      }
      // Also check if the input's canonical matches any stored alias
      if (normCanonical && normStored.some(a => a === normCanonical)) {
        results.push({ vendor, matchType: 'stored_alias', score: 82 });
        continue;
      }
    }

    // ── 4. Partial / substring match ─────────────────────────────────────────
    // Only surface partials that are meaningful — at least 4 characters to avoid
    // noise from short tokens like "co" or "inc" (already stripped, but be safe).
    if (normInput.length >= 4 && normExisting.length >= 4) {
      if (normExisting.includes(normInput) || normInput.includes(normExisting)) {
        // Score based on how much of the longer string is covered
        const shorter = Math.min(normInput.length, normExisting.length);
        const longer  = Math.max(normInput.length, normExisting.length);
        const coverage = shorter / longer;
        // Only include if coverage is reasonable (>= 60%)
        if (coverage >= 0.6) {
          const score = Math.round(40 + coverage * 30); // 58–70 range
          results.push({ vendor, matchType: 'partial', score });
        }
      }
    }
  }

  // Sort strongest match first
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Convenience: given an input name and existing vendors, return the single best
 * match if it clears the "definitive" threshold (score >= 88), otherwise null.
 * Used by ingest pipelines that want auto-linking without surfacing UI warnings.
 */
function findDefinitiveMatch(inputName, existingVendors) {
  const matches = findSimilarVendors(inputName, existingVendors);
  if (matches.length > 0 && matches[0].score >= 88) {
    return matches[0];
  }
  return null;
}

module.exports = {
  normalizeVendorName,
  resolveViaAliasMap,
  findSimilarVendors,
  findDefinitiveMatch,
};

export {};
