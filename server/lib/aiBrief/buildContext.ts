/**
 * buildContext(contract) — pure function that turns a Prisma-loaded
 * contract row into the context object every per-category template
 * uses to build its user prompt.
 *
 * Lifted verbatim from the inline logic that lived in routes/
 * contracts.js prior to Phase 4 (lines ~1448-1466 of the v0.3.3
 * contracts.js). No behavior change from the inline version — same
 * formatters, same fields, same null-handling.
 *
 * The contract argument must be loaded with these relations included:
 *   - vendor (selected fields: name, cotermComplexity, cotermNotes, notes)
 *   - tags
 *   - parentContract (product, startDate, endDate, costPerLicense, quantity)
 *   - renewals (same fields as parentContract)
 *   - customFieldValues (include: { definition: { fieldKey, name, type } })
 *
 * Pure: no side effects, no DB access, no network. Easy to unit-test
 * and reuse from non-route callers (e.g. a future "preview brief"
 * worker).
 *
 * Phase 4 — v0.4.0.
 * v0.80.7 — adds customFields to ctx: key→{label, value} map of non-empty
 *   category-scoped and global custom field values for this contract.
 *   Templates use it to render a CATEGORY-SPECIFIC FIELDS block in the
 *   brief prompt so the AI can reference actual policy limits, circuit IDs,
 *   lease terms, etc. rather than guessing from generic contract metadata.
 */

// Pass-4.5 AI-P0-1 (2026-05-17) — sanitize every user-controlled string
// field that flows into the brief prompt at templates/_base.js:50-67.
// Pre-fix, vendor.name / product / notes / tags / contact name+title were
// interpolated raw, giving any user a stored prompt-injection vector
// against the next brief generation. sanitizeUntrustedText runs NFKC +
// zero-width strip + injection-pattern redaction; cheap (~us per field).
//
// Numbers, dates, booleans are NOT sanitized (Prisma column types enforce
// shape, and they don't carry instruction-grammar).
const { sanitizeUntrustedText } = require('../promptSanitize');
function sx(v) {
  if (v === null || v === undefined) return v;
  if (typeof v !== 'string') return v;
  return sanitizeUntrustedText(v).text;
}

function fmtDate(d) {
  return d
    ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'N/A';
}

function fmtVal(cost, qty) {
  if (!cost || !qty) return 'Unknown';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(parseFloat(cost) * parseInt(qty, 10));
}

/**
 * buildCustomFields(customFieldValues) — convert Prisma customFieldValues
 * rows (with included definition) into a plain { fieldKey: { label, value } }
 * map for prompt rendering.
 *
 * Filters out:
 *   - entries without a definition (shouldn't happen, defensive)
 *   - null / empty / 'null' string values
 *   - checkbox fields stored as 'false' (omit unchecked boxes to save tokens)
 *
 * Formats:
 *   - checkbox true → 'Yes'
 *   - number → raw string (already numeric)
 *   - everything else → sanitized string
 *
 * Returns {} when customFieldValues is absent or empty.
 */
function buildCustomFields(customFieldValues = []) {
  const result = {};
  for (const cfv of customFieldValues) {
    const def = cfv.definition;
    if (!def || !def.fieldKey) continue;
    const raw = cfv.value;
    if (raw === null || raw === undefined || raw === '' || raw === 'null') continue;

    let formatted;
    if (def.type === 'checkbox') {
      if (raw === 'true' || raw === true) {
        formatted = 'Yes';
      } else {
        // Suppress unchecked checkboxes — they add noise without signal
        continue;
      }
    } else if (def.type === 'number') {
      formatted = String(raw);
    } else {
      formatted = sx(String(raw));
    }

    if (!formatted || formatted === '' || formatted === 'null') continue;
    result[def.fieldKey] = { label: sx(def.name) || def.fieldKey, value: formatted };
  }
  return result;
}

// category-conditional lease terms (contract-section-refresh): only surfaced
// for hardware + lease_rent so the brief reasons against real lease data.
function buildLeaseTerms(contract) {
  const slug = contract.category && contract.category.slug;
  if (slug !== 'hardware' && slug !== 'lease_rent') return [];
  const out = [];
  if (contract.leaseStart) out.push('Lease start: ' + fmtDate(contract.leaseStart));
  if (contract.leaseEnd) out.push('Lease end: ' + fmtDate(contract.leaseEnd));
  if (contract.leaseType) out.push('Lease type: ' + sx(String(contract.leaseType)));
  if (contract.leaseBuyout !== null && contract.leaseBuyout !== undefined) {
    const amt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(parseFloat(contract.leaseBuyout));
    out.push('Buyout: ' + amt);
  }
  return out;
}

function buildContext(contract) {
  const renewalHistory = [];
  if (contract.parentContract) {
    renewalHistory.push(
      `Previous term: ${fmtDate(contract.parentContract.startDate)} – ${fmtDate(contract.parentContract.endDate)} at ${fmtVal(contract.parentContract.costPerLicense, contract.parentContract.quantity)}`
    );
  }
  if (contract.renewals?.length > 0) {
    contract.renewals.forEach((r) => {
      renewalHistory.push(
        `Subsequent term: ${fmtDate(r.startDate)} – ${fmtDate(r.endDate)} at ${fmtVal(r.costPerLicense, r.quantity)}`
      );
    });
  }

  const daysToEnd = contract.endDate
    ? Math.ceil((new Date(contract.endDate).getTime() - Date.now()) / 86_400_000)
    : null;
  const daysToCancelBy = contract.cancelByDate
    ? Math.ceil((new Date(contract.cancelByDate).getTime() - Date.now()) / 86_400_000)
    : null;

  // v0.4.1 (#7): suggested quote-request recipient — pulled from the
  // vendor's stored contacts. Most-recent-contacted with a real email
  // wins (the caller selects + orders, this just picks [0]). Null when
  // the customer hasn't stored any vendor contact yet.
  const suggestedContact = contract.vendor?.contacts?.[0] || null;

  // v0.4.2 round-3 (#6): the LLM's training cutoff is May 2025, which
  // means without an explicit "today's date" anchor, the model defaults
  // to writing recommendations referencing 2024-2025 — including
  // recommending action by dates in the PAST. We saw a brief telling
  // a user to decide by "mid-June 2025" on a contract ending July
  // 2026. Critical to ground the model in actual current date.
  const todayObj = new Date();
  const todayFmt = todayObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  // Pass-4.5 AI-P0-1: every string field below that flows into the brief
  // prompt is run through `sx()` (sanitizeUntrustedText). Fields not
  // sanitized: numbers, dates, booleans, and the formatted-currency
  // strings produced by fmtVal/fmtDate above (server-controlled).
  return {
    today:               todayFmt, // e.g. "May 12, 2026"
    product:             sx(contract.product),
    vendorName:          sx(contract.vendor?.name) || 'Unknown',
    department:          sx(contract.department) || 'Unspecified',
    quantity:            contract.quantity ?? 'Unknown',
    costPerLicense:      contract.costPerLicense ? `$${parseFloat(contract.costPerLicense).toFixed(2)}` : 'Unknown',
    totalValueFormatted: fmtVal(contract.costPerLicense, contract.quantity),
    startDateFmt:        fmtDate(contract.startDate),
    endDateFmt:          fmtDate(contract.endDate),
    daysToEnd,
    daysToCancelBy,
    autoRenewal:         !!contract.autoRenewal,
    cancelByDateFmt:     contract.cancelByDate ? fmtDate(contract.cancelByDate) : null,
    cotermComplexity:    contract.vendor?.cotermComplexity || 'none',
    cotermNotes:         sx(contract.vendor?.cotermNotes) || null,
    renewalHistory,
    internalNotes:       sx(contract.notes) || null,
    vendorNotes:         sx(contract.vendor?.notes) || null,
    tags:                (contract.tags || []).map((t) => sx(t.tag)),
    // suggestedContact comes from VendorContact rows (user-typeable name +
    // title). Email is a separate channel; sanitize the human-readable
    // fields. Email itself is a constrained-format string — Prisma + zod
    // validation upstream is the appropriate gate.
    suggestedContact:    suggestedContact
      ? { name: sx(suggestedContact.name), email: suggestedContact.email, title: sx(suggestedContact.title) }
      : null,
    // v0.80.7: category-specific + global custom field values filled for
    // this contract. Empty object when no fields are populated.
    // Templates render these under a CATEGORY-SPECIFIC FIELDS block in
    // the brief prompt so the AI has the actual policy limits, circuit
    // IDs, lease terms, etc. to reason against.
    customFields:        buildCustomFields(contract.customFieldValues || []),
    // category-conditional lease terms (empty array unless hardware/lease_rent).
    leaseTerms:          buildLeaseTerms(contract),
  };
}

module.exports = { buildContext, fmtDate, fmtVal };

export {};
