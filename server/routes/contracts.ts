const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const multer = require('multer');                                       // v0.8.0 quote-extract
const { z } = require('zod'); // (B6)
const { requireManager } = require('../middleware/roles');
const { calculateEvaluationStartByDate, calculateCancelByDate } = require('../utils/dates');
const { encryptIfNeeded, decryptIfEncrypted } = require('../lib/crypto'); // #12: license-key encryption at rest
const { complete } = require('../lib/ai');
const { validateBody, UuidStr, emptyToUndef } = require('../lib/validate'); // (B6)
import prisma from '../lib/prisma';
const { checkAndIncrement: checkAiQuota, refundIncrement: refundAiQuota } = require('../lib/aiQuota'); // Phase 4: 'brief' + 'brief_search' actions; v0.37.3 refund-on-failure
const { ensureAiBudget } = require('../lib/aiBudgetGuard'); // v0.32.4: demo Gemini free-tier guard
const { pickTemplate } = require('../lib/aiBrief');                    // Phase 4: per-category template router
const { buildContext } = require('../lib/aiBrief/buildContext');       // Phase 4: pure context builder
const { m365OverlapForContract } = require('../lib/m365Overlap');      // #19: M365 license-overlap detection
const { runNegotiationAnalysis, getNegotiationAnalysisStatus, invalidateNegotiationAnalysis } = require('../lib/negotiationAnalysis'); // Phase 4: negotiation analysis engine
const tavilySearch     = require('../lib/aiBrief/tavilySearch');        // Phase 4: web-search enrichment (fails open)
const { ensureAiConsent } = require('../lib/aiConsent');                // Phase 4: per-session AI consent gate
const { parseBriefSections } = require('../lib/aiBrief/parseSections'); // Phase 4: 4-section structured render
// v0.36.0: admin-toggleable opt-in supplementary sections.
const { buildOptInEnvelope } = require('../lib/aiBrief/outputContract');
const {
  parseEnabledSlugs:    parseBriefSectionSlugs,
  computeSectionsHash:  computeBriefSectionsHash,
  parseOptInSections:   parseBriefOptInSections,
  getCatalog:           getBriefSectionsCatalog,
  ALL_SLUGS:            BRIEF_SECTION_ALL_SLUGS,
  DEFAULT_ENABLED_SLUGS: BRIEF_SECTION_DEFAULT_SLUGS,
  OPT_IN_SYSTEM_PROMPT: BRIEF_OPT_IN_SYSTEM_PROMPT,
} = require('../lib/aiBrief/optInSections');
const { extractText, extractVendorQuoteFields, extractPurchaseOrderFields } = require('../lib/extractor'); // v0.8.0 quote-extract; #10 PO autofill

// #28: load this account's configurable evaluation lead-time model (value-tier
// breakpoints + days-back + no-value default). Returns the parsed config object
// or null (null => the built-in defaults in utils/dates). Defensive: a missing
// row or bad JSON quietly falls back to defaults and never throws the request.
async function loadEvalLeadTimes(accountId) {
  try {
    const row = await prisma.accountSetting.findUnique({
      where: { accountId_key: { accountId, key: 'EVALUATION_LEAD_TIMES' } },
    });
    if (!row || !row.value) return null;
    return JSON.parse(row.value);
  } catch { return null; }
}

// v0.36.0: read the per-account enabled-opt-in-sections list.
// AccountSetting KV row keyed `brief_sections_enabled`, value is a
// JSON array of slugs. Falls back to defaults when row is missing or
// malformed (parseBriefSectionSlugs handles the coercion). Returns
// { slugs, hash } so callers can persist the hash on Contract for
// cache-invalidation comparisons.
async function _loadEnabledBriefSections(accountId) {
  let stored = null;
  try {
    const row = await prisma.accountSetting.findUnique({
      where: { accountId_key: { accountId, key: 'brief_sections_enabled' } },
    });
    stored = row?.value ?? null;
  } catch (err) {
    console.error('brief_sections_enabled read error (falling back to defaults):', err);
  }
  const slugs = parseBriefSectionSlugs(stored);
  const hash  = computeBriefSectionsHash(slugs);
  return { slugs, hash, stored };
}

// AI Renewal Brief generation hits Claude Haiku — every call costs real
// money and chews through Anthropic API quota. The global apiLimiter caps
// at 200/min per authenticated user, which would let a misbehaving (or
// compromised) account rack up thousands of brief calls per hour. Cap
// per-user at a number that comfortably covers a renewals manager's
// normal workflow but blocks runaway loops.
const { aiIpLimiter } = require('../middleware/aiIpLimit'); // v0.69.1: per-IP AI stack

const briefLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,                   // 1 hour
  max:      30,                               // 30 briefs / hour / user
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => `brief:${req.user?.id || 'anon'}`,
  message: { success: false, error: 'Too many AI brief requests — try again in an hour.' },
});

// ── B6 zod schemas ──────────────────────────────────────────────────────────
// Schemas reject patently bad payloads at the door. Existing per-field
// nullification, type coercion, and cross-field business rules (vendor
// ownership, owner-active-in-account, last-admin checks) continue to run
// inside the handlers — zod is the cheap first pass, not a replacement.
//
// We accept BOTH numbers and numeric strings for quantity/cost/etc because
// the existing code parseInt/parseFloats them, and changing the wire format
// would break the SPA's form serializers. Each numeric/date field is wrapped
// in z.preprocess(emptyToUndef, ...) so blank form inputs ('') from the SPA
// resolve to undefined and pass `.optional()` instead of failing the regex.
const NumLike  = z.preprocess(emptyToUndef, z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).nullable().optional());
const IntLike  = z.preprocess(emptyToUndef, z.union([z.number().int(), z.string().regex(/^-?\d+$/)]).nullable().optional());
// H5 (audit High, 2026-05-22): non-negative variants for fields that have
// no business semantic for negatives (seat counts, prices, quantities).
// Drops the leading -? from the regex AND adds a runtime .refine() so the
// numeric-form (z.number()) branch also rejects negatives.
// v0.71.4 (audit Medium "Data Integrity"): cap costPerLicense at
// 99_999_999_999.99 (12 digits + 2 decimals) so totalValue = qty * cost
// can never exceed the Decimal(14,2) precision and silently overflow.
// v0.71.5 (audit-2 CR-4): fixed Decimal(14,2) cap -- was 99B (11 digits), correct max is 999B (12 digits before decimal).
const MAX_DECIMAL_14_2 = 999999999999.99;
const NonNegNumLike = z.preprocess(emptyToUndef, z.union([
  z.number().nonnegative(),
  z.string().regex(/^\d+(\.\d+)?$/),
]).nullable().optional());
const NonNegIntLike = z.preprocess(emptyToUndef, z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/),
]).nullable().optional());
const DateLike = z.preprocess(emptyToUndef, z.union([z.string(), z.date()]).nullable().optional());
const Str      = z.string().max(2000).nullable().optional();
const ShortStr = z.string().max(500).nullable().optional();

const ContractWritableFields: any = {
  vendorId:              UuidStr.optional(),
  contractNumber:        ShortStr,
  customerNumber:        ShortStr,
  product:               z.string().max(500).optional(),
  quantity:              NonNegIntLike,                                 // H5: no negative seats
  costPerLicense:        NonNegNumLike,                                 // H5: no negative price
  startDate:             DateLike,
  endDate:               DateLike,
  autoRenewal:           z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
  autoRenewalNoticeDays: IntLike,
  poNumber:              ShortStr,
  invoiceNumber:         ShortStr,
  requestor:             ShortStr,
  deliveryEmail:         z.string().email().max(254).nullable().optional().or(z.literal('')),
  licenseKeys:           Str,
  department:            ShortStr,
  team:                  ShortStr,
  costCenter:            ShortStr,
  glCode:                ShortStr,
  endUserName:           ShortStr,
  endUserEmail:          z.string().email().max(254).nullable().optional().or(z.literal('')),
  internalOwnerId:       UuidStr.nullable().optional().or(z.literal('')),
  // v0.5.14: free-text fallback for contract owners who are NOT LapseIQ
  // users. Either internalOwnerId is set OR internalOwnerName is set
  // (handler clears the other side at write time).
  internalOwnerName:     ShortStr,
  internalOwnerEmail:    z.string().email().max(254).nullable().optional().or(z.literal('')),
  deliveryMethod:        z.enum(['user', 'device', 'shared_pool']).nullable().optional().or(z.literal('')),
  notes:                 Str,
  status:                z.enum(['active', 'under_review', 'renewed', 'cancelled', 'expired']).optional(),
  resellerName:          ShortStr,
  resellerAccountNumber: ShortStr,
  resellerContactName:   ShortStr,
  resellerContactEmail:  z.string().email().max(254).nullable().optional().or(z.literal('')),
  renewalChecklist:      z.record(z.any()).optional(),
  originalAsk:           NonNegNumLike,                                 // H5
  finalNegotiatedPrice:  NonNegNumLike,                                 // H5
  // v0.83.0: lever that drove the saving (String, not Postgres enum — see schema comment)
  savingsLever:          z.enum(['usage_reduction','term_length','benchmark_pressure','competitive_threat','seat_count_cut','legal_language','other']).nullable().optional().or(z.literal('')),
  negotiationLog:        Str,
  seatsLicensed:         NonNegIntLike,                                 // H5
  seatsActivelyInUse:    NonNegIntLike,                                 // H5
  annualUpliftPercent:   NumLike,
  coTermGroup:           z.preprocess((v) => {
    // v0.68.0 (audit Medium): normalize the coTermGroup name on write so
    // cosmetic variants (case + whitespace) don't end up as different
    // groups. "Adobe-2025-Q3" / "adobe-2025-Q3 " / "ADOBE-2025-Q3"
    // are all coTermGroup = "adobe-2025-q3" after this preprocess.
    if (v == null || v === '') return v;
    return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
  }, ShortStr),
  signatureStatus:       z.enum(['pending', 'signed', 'declined']).nullable().optional().or(z.literal('')),
  signedAt:              DateLike,
  signerName:            ShortStr,
  // 2026-05-10 Phase 1 (non-SaaS categories): optional on Create + Update so
  // legacy clients that don't know about categories still work; new SPA
  // contract-form code (Phase 2) will require it client-side. The handler
  // defaults a missing categoryId to the account's "saas" category at write
  // time so contracts.categoryId is never null for newly-created rows.
  categoryId:            UuidStr.nullable().optional().or(z.literal('')),
  // category-conditional fields (contract-section-refresh): native nullable lease
  // columns surfaced in the edit form + detail for hardware + lease_rent categories.
  leaseStart:            DateLike,
  leaseEnd:              DateLike,
  leaseType:             ShortStr,
  leaseBuyout:           NonNegNumLike,
  // SEC-A15-001: customFields is handled by applyCustomFieldValues() after zod
  // validation but must be declared here so .strict() does not reject the key.
  customFields:           z.record(z.any()).optional(),
};

// Create requires vendorId + product; everything else optional.
// H5 (audit High, 2026-05-22): reject endDate < startDate at validation
// time. The check is shared by Create + Update so the same refine runs
// in both directions. Both dates are optional on Update; the refine
// passes when either side is missing (handler enforces required-ness
// elsewhere).
const dateOrderRefine = (data, ctx) => {
  if (!data.startDate || !data.endDate) return;
  const s = new Date(data.startDate);
  const e = new Date(data.endDate);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return;
  if (e < s) {
    ctx.addIssue({
      code:    z.ZodIssueCode.custom,
      message: 'endDate must be on or after startDate',
      path:    ['endDate'],
    });
  }
};

const CreateContractSchema = z.object({
  ...ContractWritableFields,
  vendorId: UuidStr,
  product:  z.string().min(1).max(500),
}).strict().superRefine(dateOrderRefine);

// Update is fully partial — handler already gates each field by `!== undefined`.
const UpdateContractSchema = z.object(ContractWritableFields).strict().superRefine(dateOrderRefine);

// ── Scope-restriction-aware where clause ───────────────────────────────────
// Returns the standard `{ id, accountId }` clause for a single-contract lookup,
// AND-ed with `internalOwnerId = req.user.id` when the caller is a
// `contractScopeRestricted` viewer/manager. Every per-id contract query in
// this file uses it so a restricted user can never URL-poke into a contract
// outside their assignment.
function contractWhereForUser(req) {
  const w: any = { id: req.params.id, accountId: req.user.accountId };
  if (req.user.contractScopeRestricted) w.internalOwnerId = req.user.id;
  return w;
}

// ── Custom-field helper ──────────────────────────────────────────────────────
// applyCustomFieldValues — given a contract id and an admin-defined map of
// fieldKey -> raw value (from the form), validate each value through the
// definition's type rules and upsert into custom_field_values. Throws if
// any value fails validation OR a required field is missing — caller
// catches and turns into a 400.
//
// Unknown fieldKeys are silently ignored (an old form might POST a key
// the admin has since deleted; refusing the whole save would be a footgun).
async function applyCustomFieldValues(accountId, contractId, customFieldsMap) {
  if (!customFieldsMap || typeof customFieldsMap !== 'object') return;
  const { validateValueForDefinition } = require('./customFields');

  // Only consider active definitions for required-check; archived fields
  // accept whatever's already stored but no new writes.
  const definitions = await prisma.customFieldDefinition.findMany({
    where: { accountId, archivedAt: null },
  });
  const byKey = new Map(definitions.map(d => [d.fieldKey, d]));

  for (const def of definitions) {
    if (def.required) {
      const raw = customFieldsMap[def.fieldKey];
      if (raw === undefined || raw === '' || raw === null) {
        // Allow if a value already exists from a previous save (PUT path).
        const existing = await prisma.customFieldValue.findUnique({
          where: { contractId_definitionId: { contractId, definitionId: def.id } },
          select: { value: true },
        });
        if (!existing || existing.value == null) {
          throw new Error(`Required custom field "${def.name}" is missing`);
        }
      }
    }
  }

  for (const [key, raw] of Object.entries<any>(customFieldsMap)) {
    const def: any = byKey.get(key);
    if (!def) continue;
    const stored = validateValueForDefinition(def, raw);
    if (stored == null) {
      // Empty string / null clears the value (so the admin can blank a
      // non-required field).
      await prisma.customFieldValue.deleteMany({
        where: { contractId, definitionId: def.id },
      });
      continue;
    }
    await prisma.customFieldValue.upsert({
      where:  { contractId_definitionId: { contractId, definitionId: def.id } },
      update: { value: stored },
      create: { contractId, definitionId: def.id, value: stored },
    });
  }
}

// ─── Auto-expire utility ──────────────────────────────────────────────────────
// Silently flips active/under_review contracts to 'expired' when end date has
// passed. Runs on every contract fetch — no cron job needed.
// Skips contracts with no end date (open-ended agreements).
async function autoExpireContracts(accountId) {
  try {
    await prisma.contract.updateMany({
      where: {
        accountId,
        status: { in: ['active', 'under_review'] },
        endDate: { lt: new Date() },
      },
      data: { status: 'expired' },
    });
  } catch (err) {
    // Non-fatal — log and continue so a failure here never blocks the response
    console.error('autoExpireContracts error:', err.message);
  }
}

// ─── Activity logging helper ──────────────────────────────────────────────────
// Non-fatal fire-and-forget — a logging failure never blocks the response.
async function logActivity(contractId, userId, accountId, action, details = null) {
  try {
    await prisma.activityLog.create({
      data: { contractId, userId, accountId: accountId ?? null, action, details: details ?? undefined },
    });
  } catch (err) {
    console.error('logActivity error:', err.message);
  }
}

// Human-readable labels for the fields_updated action
const TRACKED_FIELDS: any = {
  vendorId:              'Vendor',
  product:               'Product',
  contractNumber:        'Contract #',
  customerNumber:        'Customer #',
  quantity:              'Quantity',
  costPerLicense:        'Cost Per License',
  startDate:             'Start Date',
  endDate:               'End Date',
  autoRenewal:           'Auto-Renewal',
  autoRenewalNoticeDays: 'Notice Period',
  poNumber:              'PO Number',
  invoiceNumber:         'Invoice #',
  requestor:             'Requestor',
  deliveryEmail:         'Delivery Email',
  licenseKeys:           'License Keys',
  department:            'Department',
  team:                  'Team',
  costCenter:            'Cost Center',
  endUserName:           'End User Name',
  endUserEmail:          'End User Email',
  deliveryMethod:        'Delivery Method',
  notes:                 'Notes',
  resellerName:          'Reseller',
  resellerAccountNumber: 'Reseller Account #',
  resellerContactName:   'Reseller Contact',
  resellerContactEmail:  'Reseller Email',
  originalAsk:           'Original Ask',
  finalNegotiatedPrice:  'Final Negotiated Price',
  savingsLever:          'Savings Lever',
  negotiationLog:        'Negotiation Log',
  seatsLicensed:         'Seats Licensed',
  seatsActivelyInUse:    'Seats In Use',
  annualUpliftPercent:   'Annual Uplift %',
  signatureStatus:       'Signature Status',
  signedAt:              'Signed Date',
  signerName:            'Signer Name',
};

// ─── GET /api/contracts/export ───────────────────────────────────────────────
// Stream a CSV of contracts matching the same filters as GET /
// Must be declared BEFORE the /:id route so "export" isn't treated as an id.
//
// New optional `?ids=a,b,c` query (max 500) lets the bulk-action toolbar
// export just the selected rows. When `ids` is set, the other filters are
// honored as ALSO clauses (so a scoped viewer who passes ids they can't
// see gets back zero rows, never an IDOR window). Empty `ids` after
// splitting is rejected as a malformed bulk-export request.
router.get('/export', async (req, res) => {
  try {
    await autoExpireContracts(req.user.accountId);

    const { status, vendorId, search, ids } = req.query;
    const where: any = { accountId: req.user.accountId };

    // When `ids` is set we DON'T silently exclude archived contracts —
    // a bulk-selected archived row should still export. Without `ids`
    // the default list excludes archive (parity with GET /).
    if (!ids) where.archivedAt = null;

    // Scoped viewers export only their assigned contracts (always).
    if (req.user.contractScopeRestricted) where.internalOwnerId = req.user.id;
    if (status) where.status = status;
    if (vendorId) where.vendorId = vendorId;
    if (ids) {
      const idArr = String(ids).split(',').map(s => s.trim()).filter(Boolean);
      if (idArr.length === 0) {
        return res.status(400).json({ success: false, error: 'ids query is empty' });
      }
      if (idArr.length > 500) {
        return res.status(400).json({ success: false, error: 'ids query exceeds 500 contract limit' });
      }
      where.id = { in: idArr };
    }
    if (search) {
      where.OR = [
        { product:        { contains: search, mode: 'insensitive' } },
        { contractNumber: { contains: search, mode: 'insensitive' } },
        { poNumber:       { contains: search, mode: 'insensitive' } },
        { department:     { contains: search, mode: 'insensitive' } },
        { vendor: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    // Pass-5 / Agent 3: defensive take(1000) cap on CSV export. When
    // `ids` is passed the upstream check already restricts to ≤500, so
    // this cap only bites unbounded full-tenant exports (no ids, no
    // narrowing filters). 1000 rows of contract+vendor+customFields
    // streams a few hundred KB of CSV — safe for browser download.
    // Larger tenants needing a full export can page via /api/v1.
    const contracts = await prisma.contract.findMany({
      where,
      include: {
        vendor: { select: { name: true } },
        customFieldValues: { include: { definition: true } },
      },
      orderBy: { endDate: 'asc' },
      take: 1000,
    });

    // Custom field columns — list every active+archived definition so a
    // CSV consumer sees consistent columns even if a row hasn't filled
    // a particular field. Sorted by displayOrder so the export shape
    // mirrors the contract form.
    const customDefs = await prisma.customFieldDefinition.findMany({
      where:   { accountId: req.user.accountId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const headers = [
      'Vendor','Product','Contract #','Customer #','Status',
      'Start Date','End Date','Evaluate By','Cancel By',
      'Quantity','Cost Per License','Total Value',
      'Auto Renewal','Notice Days','PO Number','Invoice Number',
      'Department','Team','Cost Center','Requestor',
      'Reseller','Reseller Account #','Reseller Contact','Reseller Email',
      'Notes',
      ...customDefs.map(d => d.name),
    ];

    function csvVal(v) {
      if (v == null) return '';
      let s = String(v);
      // H6: prefix formula-injection characters so spreadsheets don't evaluate them.
      // /^\s*/ catches values with leading whitespace before a trigger char (e.g. '  =cmd'). (H6)
      if (/^\s*[=+\-@\t\r]/.test(s)) s = "'" + s;
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    }

    function fmtDate(d) {
      if (!d) return '';
      return new Date(d).toISOString().split('T')[0];
    }

    const rows = contracts.map(c => {
      // Custom field values keyed by definitionId for O(1) lookup
      const cfvByDef = new Map((c.customFieldValues || []).map(v => [v.definitionId, v.value]));
      return [
        c.vendor?.name,
        c.product,
        c.contractNumber,
        c.customerNumber,
        c.status,
        fmtDate(c.startDate),
        fmtDate(c.endDate),
        fmtDate(c.evaluationStartByDate),
        fmtDate(c.cancelByDate),
        c.quantity,
        c.costPerLicense,
        c.quantity && c.costPerLicense ? (parseFloat(String(c.costPerLicense)) * c.quantity).toFixed(2) : '',
        c.autoRenewal ? 'Yes' : 'No',
        c.autoRenewalNoticeDays,
        c.poNumber,
        c.invoiceNumber,
        c.department,
        c.team,
        c.costCenter,
        c.requestor,
        c.resellerName,
        c.resellerAccountNumber,
        c.resellerContactName,
        c.resellerContactEmail,
        c.notes,
        ...customDefs.map(d => cfvByDef.get(d.id) ?? ''),
      ].map(csvVal).join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    const filename = `lapseiq-contracts-${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (err) {
    console.error('Export error:', err);
    return res.status(500).json({ success: false, error: 'Export failed' });
  }
});

// ─── PATCH /api/contracts/bulk ───────────────────────────────────────────────
// Bulk-update fields across multiple contracts in one round-trip.
// Manager+ only (matches POST/PUT/PATCH conventions for write paths).
//
// Body: {
//   ids:               string[]            // 1..500 contract ids
//   status?:           ContractStatus      // active|under_review|renewed|cancelled|expired
//   internalOwnerId?:  string | null       // null = unassign
//   archive?:          boolean             // true = archive, false = unarchive
// }
//
// Scope-restriction is the load-bearing security property here. Without
// the input filter, a manager flagged contractScopeRestricted (rare but
// possible per the Sprint 3 viewer-invite flow) could mutate every
// contract in the account by passing the full id list. The filter
// happens via contract.findMany — we resolve the input ids against
// the same scope clause used by single-contract endpoints, then run
// updateMany on the resolved subset only.
//
// Returns: { requested, matched, updated, ids: [...resolved ids] }
router.patch('/bulk', requireManager, async (req, res) => {
  try {
    const { ids, status, internalOwnerId, archive } = req.body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
    }
    if (ids.length > 500) {
      return res.status(400).json({ success: false, error: 'ids exceeds 500 contract limit' });
    }
    if (!ids.every(id => typeof id === 'string' && id.length > 0)) {
      return res.status(400).json({ success: false, error: 'ids must be strings' });
    }

    // Build the data patch.
    const data: any = {};
    if (status !== undefined) {
      const allowed = ['active', 'under_review', 'renewed', 'cancelled', 'expired'];
      if (!allowed.includes(status)) {
        return res.status(400).json({ success: false, error: `status must be one of ${allowed.join(', ')}` });
      }
      data.status = status;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'internalOwnerId')) {
      if (internalOwnerId !== null && typeof internalOwnerId !== 'string') {
        return res.status(400).json({ success: false, error: 'internalOwnerId must be a string or null' });
      }
      if (internalOwnerId !== null) {
        // Verify the owner is a member of this account (404 leak guard +
        // FK consistency — Prisma would throw P2003 otherwise).
        const owner = await prisma.user.findFirst({
          where:  { id: internalOwnerId, accountId: req.user.accountId },
          select: { id: true },
        });
        if (!owner) {
          return res.status(400).json({ success: false, error: 'internalOwnerId is not a member of this account' });
        }
      }
      data.internalOwnerId = internalOwnerId;
    }
    if (archive === true) {
      data.archivedAt   = new Date();
      data.archivedById = req.user.id;
    } else if (archive === false) {
      data.archivedAt   = null;
      data.archivedById = null;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, error: 'no mutation field provided' });
    }

    // Resolve the input ids against the caller's scope.
    const allowedWhere: any = {
      id: { in: ids },
      accountId: req.user.accountId,
    };
    if (req.user.contractScopeRestricted) {
      allowedWhere.internalOwnerId = req.user.id;
    }

    const matched = await prisma.contract.findMany({
      where:  allowedWhere,
      select: { id: true },
    });
    const matchedIds = matched.map(m => m.id);

    if (matchedIds.length === 0) {
      return res.json({
        success: true,
        data: { requested: ids.length, updated: 0, ids: [] },
      });
    }

    const result = await prisma.contract.updateMany({
      where: { id: { in: matchedIds } },
      data,
    });

    // Activity log: one entry per affected contract via createMany so the
    // log scales linearly without 500 round-trips. Action label depends on
    // the dominant mutation — status > archive > owner — so a mixed
    // payload still produces a single readable entry per contract.
    let action = 'fields_updated';
    if (status !== undefined)               action = 'status_changed';
    else if (archive === true)              action = 'contract_archived';
    else if (archive === false)             action = 'contract_unarchived';
    else if ('internalOwnerId' in req.body) action = 'owner_changed';

    try {
      await prisma.activityLog.createMany({
        data: matchedIds.map(id => ({
          contractId: id,
          userId:     req.user.id,
          accountId:  req.user.accountId,
          action,
          details:    { bulk: true, count: matchedIds.length, ...data },
        })),
        skipDuplicates: true,
      });
    } catch (logErr) {
      console.warn('bulk activity log write failed:', logErr.message);
    }

    return res.json({
      success: true,
      data: {
        requested: ids.length,
        updated:   result.count,
        ids:       matchedIds,
      },
    });
  } catch (err) {
    console.error('PATCH /contracts/bulk:', err);
    return res.status(500).json({ success: false, error: 'Bulk update failed' });
  }
});

// ─── GET /api/contracts ───────────────────────────────────────────────────────
// List all contracts for the account with pagination and optional filters.
// v0.44 column-filter helpers + /distinct/:column endpoint
// Multi-select array params: comma-separated OR repeated. Cap each at 200
// entries to bound query size. Whitespace trimmed; empty entries dropped.
function parseList(raw) {
  if (raw == null) return [];
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string') arr = raw.split(',');
  else return [];
  return arr
    .map(s => (typeof s === 'string' ? s.trim() : ''))
    .filter(s => s.length > 0 && s.length <= 200)
    .slice(0, 200);
}

function parseDateStartUtc(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00.000Z');
  return isNaN(d.getTime()) ? null : d;
}
function parseDateEndUtc(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T23:59:59.999Z');
  return isNaN(d.getTime()) ? null : d;
}
function dateRangeClauseV044(field, fromRaw, toRaw) {
  const from = parseDateStartUtc(fromRaw);
  const to   = parseDateEndUtc(toRaw);
  if (!from && !to) return null;
  const clause: any = {};
  if (from) clause.gte = from;
  if (to)   clause.lte = to;
  return { [field]: clause };
}
function parseNumV044(s) {
  if (s === undefined || s === null || s === '') return null;
  const n = typeof s === 'number' ? s : parseFloat(s);
  return isNaN(n) ? null : n;
}

// Apply v0.44 column-header filters to a Prisma where object. If
// excludeColumn is set, that column's filter is NOT applied - used by the
// /distinct/:column endpoint so the dropdown for column X reflects the
// dataset narrowed by OTHER active filters (Excel-style).
function applyV044ColumnFilters(where, params, excludeColumn) {
  if (excludeColumn !== 'vendor') {
    const list = parseList(params.vendorIn);
    if (list.length > 0) {
      where.vendor = { ...(where.vendor || {}), name: { in: list } };
    }
  }
  if (excludeColumn !== 'product') {
    const list = parseList(params.productIn);
    if (list.length > 0) {
      where.AND = [...(where.AND || []), { product: { in: list } }];
    }
  }
  if (excludeColumn !== 'po') {
    const list = parseList(params.poIn);
    if (list.length > 0) {
      // v0.45: split __BLANK__ sentinel from real PO numbers.
      const wantsBlank = list.includes('__BLANK__');
      const realList   = list.filter(v => v !== '__BLANK__');
      const ors = [];
      if (realList.length > 0) {
        ors.push({ poNumber: { in: realList } });
        ors.push({ purchaseOrders: { some: { archivedAt: null, poNumber: { in: realList } } } });
      }
      if (wantsBlank) {
        // Blank = no contract.poNumber AND no non-archived child PO records.
        ors.push({ AND: [
          { poNumber: null },
          { purchaseOrders: { none: { archivedAt: null } } },
        ]});
      }
      if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
    }
  }
  if (excludeColumn !== 'owner') {
    const list = parseList(params.ownerIn);
    if (list.length > 0) {
      const wantsBlank = list.includes('__BLANK__');
      const realList   = list.filter(v => v !== '__BLANK__');
      const ors = [];
      if (realList.length > 0) {
        ors.push({ internalOwner: { name: { in: realList } } });
        ors.push({ internalOwnerName: { in: realList } });
      }
      if (wantsBlank) {
        // True unassigned: both joined-user-id AND free-text-name are null.
        ors.push({ AND: [
          { internalOwnerId: null },
          { internalOwnerName: null },
        ]});
      }
      if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
    }
  }
  if (excludeColumn !== 'status') {
    const list = parseList(params.statusIn);
    if (list.length > 0) {
      where.status = { in: list };
    }
  }
  // v0.45: category multi-select column filter. Matches category.name from
  // the Category relation. __BLANK__ means contracts with no categoryId.
  if (excludeColumn !== 'category') {
    const list = parseList(params.categoryIn);
    if (list.length > 0) {
      const wantsBlank = list.includes('__BLANK__');
      const realList   = list.filter(v => v !== '__BLANK__');
      const ors = [];
      if (realList.length > 0) {
        ors.push({ category: { name: { in: realList } } });
      }
      if (wantsBlank) {
        ors.push({ categoryId: null });
      }
      if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
    }
  }
  // ── v0.57: 5 new multi-select column filters ─────────────────────────────
  // Auto-Renewal: discrete Yes/No. Both selected = no narrowing (matches all).
  if (excludeColumn !== 'autoRenewal') {
    const list = parseList(params.autoRenewalIn);
    if (list.length > 0) {
      const wantsYes = list.includes('Yes');
      const wantsNo  = list.includes('No');
      if (wantsYes && !wantsNo)      where.autoRenewal = true;
      else if (wantsNo && !wantsYes) where.autoRenewal = false;
      // both => no-op
    }
  }
  // Department: free-text scalar with __BLANK__ sentinel (null OR empty string).
  if (excludeColumn !== 'department') {
    const list = parseList(params.departmentIn);
    if (list.length > 0) {
      const wantsBlank = list.includes('__BLANK__');
      const realList   = list.filter(v => v !== '__BLANK__');
      const ors = [];
      if (realList.length > 0) ors.push({ department: { in: realList } });
      if (wantsBlank)          ors.push({ OR: [{ department: null }, { department: '' }] });
      if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
    }
  }
  // Contract # — Contract.contractNumber with __BLANK__ sentinel.
  if (excludeColumn !== 'contractNumber') {
    const list = parseList(params.contractNumberIn);
    if (list.length > 0) {
      const wantsBlank = list.includes('__BLANK__');
      const realList   = list.filter(v => v !== '__BLANK__');
      const ors = [];
      if (realList.length > 0) ors.push({ contractNumber: { in: realList } });
      if (wantsBlank)          ors.push({ OR: [{ contractNumber: null }, { contractNumber: '' }] });
      if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
    }
  }
  // Customer # — Contract.customerNumber with __BLANK__ sentinel.
  if (excludeColumn !== 'customerNumber') {
    const list = parseList(params.customerNumberIn);
    if (list.length > 0) {
      const wantsBlank = list.includes('__BLANK__');
      const realList   = list.filter(v => v !== '__BLANK__');
      const ors = [];
      if (realList.length > 0) ors.push({ customerNumber: { in: realList } });
      if (wantsBlank)          ors.push({ OR: [{ customerNumber: null }, { customerNumber: '' }] });
      if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
    }
  }
  // Reseller — Contract.resellerName with __BLANK__ sentinel.
  if (excludeColumn !== 'reseller') {
    const list = parseList(params.resellerIn);
    if (list.length > 0) {
      const wantsBlank = list.includes('__BLANK__');
      const realList   = list.filter(v => v !== '__BLANK__');
      const ors = [];
      if (realList.length > 0) ors.push({ resellerName: { in: realList } });
      if (wantsBlank)          ors.push({ OR: [{ resellerName: null }, { resellerName: '' }] });
      if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
    }
  }
  const endDateClause   = dateRangeClauseV044('endDate', params.endDateFrom, params.endDateTo);
  const evalStartClause = dateRangeClauseV044('evaluationStartByDate', params.evalStartFrom, params.evalStartTo);
  const cancelByClause  = dateRangeClauseV044('cancelByDate', params.cancelByFrom, params.cancelByTo);
  if (endDateClause)   where.AND = [...(where.AND || []), endDateClause];
  if (evalStartClause) where.AND = [...(where.AND || []), evalStartClause];
  if (cancelByClause)  where.AND = [...(where.AND || []), cancelByClause];
  // v0.57: start-date range filter.
  const startDateClause = dateRangeClauseV044('startDate', params.startDateFrom, params.startDateTo);
  if (startDateClause) where.AND = [...(where.AND || []), startDateClause];
  const valueMinNum = parseNumV044(params.valueMin);
  const valueMaxNum = parseNumV044(params.valueMax);
  if (valueMinNum !== null || valueMaxNum !== null) {
    const clause: any = {};
    if (valueMinNum !== null) clause.gte = valueMinNum;
    if (valueMaxNum !== null) clause.lte = valueMaxNum;
    where.AND = [...(where.AND || []), { totalValue: clause }];
  }
  return where;
}

const STATUS_ENUM_VALUES = ['active', 'under_review', 'renewed', 'cancelled', 'expired'];

// GET /api/contracts/distinct/:column - returns distinct values for a given
// column, narrowed by all OTHER active filters. Used by the column-header
// dropdown to populate the checkbox list. Capped at 500 distinct values.
router.get('/distinct/:column', async (req, res) => {
  const VALID_COLUMNS = ['vendor', 'product', 'po', 'owner', 'status', 'category', 'autoRenewal', 'department', 'contractNumber', 'customerNumber', 'reseller'];
  const { column } = req.params;
  if (!VALID_COLUMNS.includes(column)) {
    return res.status(400).json({ error: 'invalid_column' });
  }
  if (column === 'status') {
    return res.json({ values: STATUS_ENUM_VALUES });
  }
  // v0.57: autoRenewal is a static enum-like set (Yes/No). No contract
  // scan needed — return the two values directly.
  if (column === 'autoRenewal') {
    return res.json({ values: ['Yes', 'No'] });
  }
  try {
    // v0.46: background-fire (same rationale as the GET / handler above).
    autoExpireContracts(req.user.accountId).catch(err =>
      console.error('[contracts/distinct] background autoExpire failed:', err?.message || err)
    );
    const where: any = { accountId: req.user.accountId, archivedAt: null };
    if (req.user.contractScopeRestricted) where.internalOwnerId = req.user.id;
    applyV044ColumnFilters(where, req.query, column);
    const { status, excludeExpired, vendorId, categoryId, hasPO, ownerId } = req.query;
    if (status) where.status = status;
    else if (excludeExpired === 'true') where.status = { not: 'expired' };
    if (vendorId)   where.vendorId   = vendorId;
    if (categoryId) where.categoryId = categoryId;
    if (hasPO === 'true')      where.purchaseOrders = { some: { archivedAt: null } };
    else if (hasPO === 'false') where.purchaseOrders = { none: {} };
    if (ownerId === 'unassigned') where.internalOwnerId = null;
    else if (ownerId)             where.internalOwnerId = ownerId;

    let values = [];
    if (column === 'vendor') {
      const rows = await prisma.contract.findMany({
        where,
        distinct: ['vendorId'],
        select: { vendor: { select: { name: true } } },
        take: 500,
      });
      values = [...new Set(rows.map(r => r.vendor?.name).filter(Boolean))].sort();
    } else if (column === 'product') {
      const rows = await prisma.contract.findMany({
        where,
        distinct: ['product'],
        select: { product: true },
        orderBy: { product: 'asc' },
        take: 500,
      });
      values = rows.map(r => r.product).filter(Boolean);
    } else if (column === 'owner') {
      const [rows1, rows2, blankCount] = await Promise.all([
        prisma.contract.findMany({
          where: { ...where, internalOwnerId: { not: null } },
          distinct: ['internalOwnerId'],
          select: { internalOwner: { select: { name: true } } },
          take: 250,
        }),
        prisma.contract.findMany({
          where: { ...where, internalOwnerName: { not: null } },
          distinct: ['internalOwnerName'],
          select: { internalOwnerName: true },
          take: 250,
        }),
        // v0.45: true unassigned = both internalOwnerId AND internalOwnerName null.
        prisma.contract.count({
          where: { ...where, internalOwnerId: null, internalOwnerName: null },
        }),
      ]);
      const set = new Set();
      for (const r of rows1) if (r.internalOwner?.name) set.add(r.internalOwner.name);
      for (const r of rows2) if (r.internalOwnerName) set.add(r.internalOwnerName);
      values = [...set].sort();
      if (blankCount > 0) values.unshift('__BLANK__');
    } else if (column === 'po') {
      const [rows1, pos, blankCount] = await Promise.all([
        prisma.contract.findMany({
          where: { ...where, poNumber: { not: null } },
          distinct: ['poNumber'],
          select: { poNumber: true },
          take: 250,
        }),
        prisma.purchaseOrder.findMany({
          where: {
            archivedAt: null,
            contract: where,
          },
          distinct: ['poNumber'],
          select: { poNumber: true },
          take: 250,
        }),
        // v0.45: count blank-PO rows so we know whether to surface __BLANK__.
        prisma.contract.count({
          where: { ...where, poNumber: null, purchaseOrders: { none: { archivedAt: null } } },
        }),
      ]);
      const set = new Set();
      for (const r of rows1) if (r.poNumber) set.add(r.poNumber);
      for (const p of pos)   if (p.poNumber) set.add(p.poNumber);
      values = [...set].sort();
      if (blankCount > 0) values.unshift('__BLANK__');
    } else if (column === 'category') {
      // v0.45: distinct category names from the Category relation, narrowed
      // by other active filters. Also includes __BLANK__ if any contracts
      // have no categoryId in the filtered set.
      const [rows, blankCount] = await Promise.all([
        prisma.contract.findMany({
          where: { ...where, categoryId: { not: null } },
          distinct: ['categoryId'],
          select: { category: { select: { name: true } } },
          take: 500,
        }),
        prisma.contract.count({ where: { ...where, categoryId: null } }),
      ]);
      values = [...new Set(rows.map(r => r.category?.name).filter(Boolean))].sort();
      if (blankCount > 0) values.unshift('__BLANK__');
    } else if (column === 'department') {
      // v0.57: distinct department names + __BLANK__ for null/empty rows.
      const [rows, blankCount] = await Promise.all([
        prisma.contract.findMany({
          where: { ...where, department: { not: null, notIn: [''] } },
          distinct: ['department'],
          select:   { department: true },
          orderBy:  { department: 'asc' },
          take: 500,
        }),
        prisma.contract.count({
          where: { ...where, OR: [{ department: null }, { department: '' }] },
        }),
      ]);
      values = rows.map(r => r.department).filter(Boolean);
      if (blankCount > 0) values.unshift('__BLANK__');
    } else if (column === 'contractNumber') {
      const [rows, blankCount] = await Promise.all([
        prisma.contract.findMany({
          where: { ...where, contractNumber: { not: null, notIn: [''] } },
          distinct: ['contractNumber'],
          select:   { contractNumber: true },
          orderBy:  { contractNumber: 'asc' },
          take: 500,
        }),
        prisma.contract.count({
          where: { ...where, OR: [{ contractNumber: null }, { contractNumber: '' }] },
        }),
      ]);
      values = rows.map(r => r.contractNumber).filter(Boolean);
      if (blankCount > 0) values.unshift('__BLANK__');
    } else if (column === 'customerNumber') {
      const [rows, blankCount] = await Promise.all([
        prisma.contract.findMany({
          where: { ...where, customerNumber: { not: null, notIn: [''] } },
          distinct: ['customerNumber'],
          select:   { customerNumber: true },
          orderBy:  { customerNumber: 'asc' },
          take: 500,
        }),
        prisma.contract.count({
          where: { ...where, OR: [{ customerNumber: null }, { customerNumber: '' }] },
        }),
      ]);
      values = rows.map(r => r.customerNumber).filter(Boolean);
      if (blankCount > 0) values.unshift('__BLANK__');
    } else if (column === 'reseller') {
      const [rows, blankCount] = await Promise.all([
        prisma.contract.findMany({
          where: { ...where, resellerName: { not: null, notIn: [''] } },
          distinct: ['resellerName'],
          select:   { resellerName: true },
          orderBy:  { resellerName: 'asc' },
          take: 500,
        }),
        prisma.contract.count({
          where: { ...where, OR: [{ resellerName: null }, { resellerName: '' }] },
        }),
      ]);
      values = rows.map(r => r.resellerName).filter(Boolean);
      if (blankCount > 0) values.unshift('__BLANK__');
    }
    return res.json({ values });
  } catch (err) {
    console.error('[contracts/distinct] failed for column', column, ':', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/', async (req, res) => {
  try {
    // v0.46: background-fire instead of await — the auto-expire is a
    // housekeeping update (transitions contracts past endDate to
    // status='expired'). It's idempotent and doesn't affect the current
    // request's results (the next request will see the transitioned rows).
    // Awaiting added ~100-300ms to every list-page load. Errors logged
    // but don't fail the request.
    autoExpireContracts(req.user.accountId).catch(err =>
      console.error('[contracts] background autoExpire failed:', err?.message || err)
    );

    const {
      page = 1, limit = 25,
      status, vendorId, search,
      sort = 'endDate', sortDir = 'asc',
      renewal,                              // renewing30 | renewing60 | renewing90 | cancel30 | overdue | expiringMonth
      endMonth,                             // YYYY-MM — contracts expiring within that calendar month
      ownerId,                              // filter by internalOwnerId (UUID or 'unassigned')
      payment,                              // payment30 | payment60 | payment90
      excludeExpired,                       // 'true' — hide expired contracts (default in List view)
      categoryId,                           // (Phase 2) filter by Category.id
      hasPO,                                // 'true' | 'false' — filter by presence of purchase orders
      evaluateBy,
      // v0.43 per-column header filters. Each is independent + additively
      // combined (AND) with the existing toolbar filters above.
      // v0.44 column header filters - multi-select (text/enum) + ranges.
      vendorIn,
      productIn,
      poIn,
      ownerIn,
      statusIn,
      endDateFrom, endDateTo,
      evalStartFrom, evalStartTo,
      cancelByFrom, cancelByTo,
      valueMin, valueMax,                             // '30'|'60'|'90' — eval window opens within N days
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where: any = { accountId: req.user.accountId, archivedAt: null };

    // Scoped viewers only see contracts assigned to them
    if (req.user.contractScopeRestricted) {
      where.internalOwnerId = req.user.id;
    } else {
      if (ownerId === 'unassigned') {
        where.internalOwnerId = null;
      } else if (ownerId) {
        where.internalOwnerId = ownerId;
      }
    }

    if (status) where.status = status;
    else if (excludeExpired === 'true') where.status = { not: 'expired' };
    if (vendorId) where.vendorId = vendorId;
    if (categoryId) where.categoryId = categoryId; // (Phase 2)

    // Search across product, contract #, PO #, department, vendor name, AND
    // child purchase_orders.poNumber (v0.10.0). The PO-some clause causes
    // Prisma to emit an EXISTS subquery against purchase_orders, which the
    // (poNumber) index makes cheap. Non-archived POs only — archived POs
    // shouldn't surface their parent contract in search results.
    if (search) {
      where.OR = [
        { product:        { contains: search, mode: 'insensitive' } },
        { contractNumber: { contains: search, mode: 'insensitive' } },
        { poNumber:       { contains: search, mode: 'insensitive' } },
        { department:     { contains: search, mode: 'insensitive' } },
        { vendor: { name: { contains: search, mode: 'insensitive' } } },
        {
          purchaseOrders: {
            some: {
              archivedAt: null,
              poNumber:   { contains: search, mode: 'insensitive' },
            },
          },
        },
      ];
    }

    // Renewal window quick-filter
    const now = new Date();

    // Calendar month filter — endDate falls within the given YYYY-MM month
    if (endMonth && /^\d{4}-\d{2}$/.test(endMonth)) {
      const [yr, mo] = endMonth.split('-').map(Number);
      const start = new Date(yr, mo - 1, 1);
      const end   = new Date(yr, mo, 1);   // first day of NEXT month (exclusive)
      where.endDate = { gte: start, lt: end };
    }

    if (renewal) {
      if (renewal === 'cancel30') {
        // Auto-renewals where the cancel window closes within 30 days.
        // Include under_review — a contract being reviewed can still auto-renew
        // if the cancel date is missed. Match the dashboard trap query exactly.
        where.status = { in: ['active', 'under_review'] };
        where.autoRenewal = true;
        where.cancelByDate = { gte: now, lte: new Date(now.getTime() + 30 * 86_400_000) };
      } else if (renewal === 'overdue') {
        // Contracts whose end date has already passed but are still active/under_review
        // (the status hasn't auto-updated yet or is being manually tracked).
        where.endDate = { lt: now };
        where.status = { in: ['active', 'under_review'] };
      } else if (renewal === 'expiringMonth') {
        // Contracts ending within the current calendar month.
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth   = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        where.endDate = { gte: startOfMonth, lt: endOfMonth };
      } else {
        const days = parseInt(renewal.replace('renewing', ''));
        if (!isNaN(days)) {
          where.endDate = { gte: now, lte: new Date(now.getTime() + days * 86_400_000) };
        }
      }
    }

    // PO presence filter — 'true' = only contracts with purchase orders
    if (hasPO === 'true') {
      where.purchaseOrders = { some: { archivedAt: null } };
    } else if (hasPO === 'false') {
      where.purchaseOrders = { none: {} };
    }

    // Upcoming payment filter — contracts with an installment due within N days
    if (payment) {
      const days = parseInt(payment.replace('payment', ''));
      if (!isNaN(days)) {
        where.paymentSchedule = {
          installments: {
            some: {
              dueDate: { gte: now, lte: new Date(now.getTime() + days * 86_400_000) },
            },
          },
        };
      }
    }

    // Evaluate By — contracts whose evaluation window opens within N days
    if (evaluateBy) {
      const days = parseInt(evaluateBy);
      if (!isNaN(days)) {
        const cutoff = new Date(now.getTime() + days * 86_400_000);
        where.evaluationStartByDate = { gte: now, lte: cutoff };
      }
    }

    // Column sort — default endDate asc (soonest renewal first)
    // ── v0.43 per-column filters ──────────────────────────────────────────
    // Each filter is additive on top of the toolbar filters above. AND
    // semantics across columns. Defensive parsing: malformed dates/numbers
    // are silently ignored (no 400) since the frontend bounds these via
    // ColumnFilterInput.
    // v0.44 column-filter helper applies multi-select + range params to where.
    applyV044ColumnFilters(where, req.query, null);

    const dir = sortDir === 'desc' ? 'desc' : 'asc';
    const sortMap: any = {
      endDate:      { endDate: dir },
      evaluationStartByDate: { evaluationStartByDate: dir },
      cancelByDate: { cancelByDate: dir },
      vendor:       { vendor: { name: dir } },
      product:      { product: dir },
      // v0.9.5: sort by internal owner's name. nulls: 'last' so unassigned
      // contracts don't dominate the top of an ascending sort. Joined sort
      // through the User relation, same shape as the vendor sort above.
      owner:        { internalOwner: { name: { sort: dir, nulls: 'last' } } },
      // (A3 5/02) Sort by denormalized total value. nulls: 'last' so contracts
      // missing cost or qty don't dominate the top of an ascending sort.
      value:        { totalValue: { sort: dir, nulls: 'last' } },
    };
    const orderBy = sortMap[sort] || { endDate: 'asc' };

    const [contracts, total] = await Promise.all([
      prisma.contract.findMany({
        where,
        skip,
        take,
        orderBy,
        include: {
          vendor: { select: { id: true, name: true } },
          internalOwner: { select: { id: true, name: true, email: true } },
          // Phase 1 (non-SaaS categories): include category for list-view
          // badge + filter. Cheap join — Category is a tiny table.
          category: { select: { id: true, name: true, slug: true, icon: true, color: true } },
          // v0.10.0: PO count + the single most-recent PO# for the list-view
          // column. We don't load all PO rows here — that's a per-detail-page
          // concern. `take: 1, orderBy: orderDate desc` keeps the payload
          // small while still letting the list column render the latest
          // PO number alongside the count.
          purchaseOrders: {
            where: { archivedAt: null },
            select: { id: true, poNumber: true, orderDate: true },
            orderBy: [{ orderDate: 'desc' }, { createdAt: 'desc' }],
            take: 1,
          },
          _count: { select: { flags: true, purchaseOrders: { where: { archivedAt: null } } } },
        },
      }),
      prisma.contract.count({ where }),
    ]);

    // #12: license keys are encrypted at rest and must never ship in the
    // default list payload (the dedicated reveal endpoint is the only egress).
    for (const c of contracts) { if (c && c.licenseKeys !== undefined) delete c.licenseKeys; }

    res.json({
      success: true,
      data: {
        contracts,
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          pages: Math.ceil(total / take),
        },
        scopeRestricted: req.user.contractScopeRestricted || false,
      },
    });
  } catch (err) {
    console.error('List contracts error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch contracts' });
  }
});

// ─── GET /api/contracts/archived ─────────────────────────────────────────────
// Returns archived contracts for the account (paginated).
// Must be declared before /:id so "archived" isn't treated as an id.
router.get('/archived', async (req, res) => {
  try {
    const { page = 1, limit = 25, search, vendorId } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where: any = {
      accountId: req.user.accountId,
      NOT: { archivedAt: null },
    };
    if (req.user.contractScopeRestricted) where.internalOwnerId = req.user.id;
    if (vendorId) where.vendorId = vendorId;
    if (search) {
      where.OR = [
        { product:        { contains: search, mode: 'insensitive' } },
        { contractNumber: { contains: search, mode: 'insensitive' } },
        { vendor: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [contracts, total] = await Promise.all([
      prisma.contract.findMany({
        where,
        skip,
        take,
        orderBy: { archivedAt: 'desc' },
        include: {
          vendor: { select: { id: true, name: true } },
          internalOwner: { select: { id: true, name: true } },
        },
      }),
      prisma.contract.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        contracts,
        pagination: { page: parseInt(page), limit: take, total, pages: Math.ceil(total / take) },
      },
    });
  } catch (err) {
    console.error('Archived contracts error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch archived contracts' });
  }
});

// ─── GET /api/contracts/coterm-summary ────────────────────────────────────────
// Returns one row per co-term group in the account: group name, contract
// count, combined annual spend (costPerLicense × quantity), and the list of
// member contracts. Powers the Co-Term view on the Contracts list and the
// dashboard summary card.
//
// Scoped viewers see only their assigned contracts inside each group; an
// owner-scoped user with zero contracts in a group will not see the group.
// Archived contracts are excluded.
//
// MUST be declared before /:id so "coterm-summary" isn't matched as a
// contract id. (2026-05-10 review B2 — route was previously placed after
// /:id and was unreachable.)
router.get('/coterm-summary', async (req, res) => {
  try {
    const where: any = {
      accountId:  req.user.accountId,
      archivedAt: null,
      coTermGroup: { not: null },
    };
    if (req.user.contractScopeRestricted) {
      where.internalOwnerId = req.user.id;
    }

    const contracts = await prisma.contract.findMany({
      where,
      select: {
        id: true,
        product: true,
        endDate: true,
        status: true,
        quantity: true,
        costPerLicense: true,
        coTermGroup: true,
        vendor: { select: { id: true, name: true } },
      },
      orderBy: [{ coTermGroup: 'asc' }, { endDate: 'asc' }],
    });

    const groups: any = {};
    for (const c of contracts) {
      const key = c.coTermGroup;
      if (!groups[key]) {
        groups[key] = { name: key, count: 0, annualSpend: 0, earliestEndDate: null, latestEndDate: null, endDateSpread: 0, warning: null, contracts: [] };
      }
      const g = groups[key];
      g.count += 1;
      const qty  = c.quantity ?? 0;
      const cost = c.costPerLicense != null ? parseFloat(String(c.costPerLicense)) : 0;
      g.annualSpend += qty * cost;
      if (c.endDate && (!g.earliestEndDate || c.endDate < g.earliestEndDate)) {
        g.earliestEndDate = c.endDate;
      }
      // v0.68.5 (audit M-tier "Co-term Group Accountant"): track the
      // latest end date too; the spread between earliest and latest
      // tells the UI whether this group is actually co-terming or
      // has drifted apart.
      if (c.endDate && (!g.latestEndDate || c.endDate > g.latestEndDate)) {
        g.latestEndDate = c.endDate;
      }
      g.contracts.push({
        id: c.id,
        product: c.product,
        endDate: c.endDate,
        status:  c.status,
        annualValue: qty * cost,
        vendor: c.vendor,
      });
    }

    // Sort groups by earliest end date (soonest co-term event first), then name
    // v0.68.5 (audit M-tier): compute spread + drift warning per group.
    for (const g of Object.values<any>(groups)) {
      if (g.earliestEndDate && g.latestEndDate) {
        const ms = new Date(g.latestEndDate).getTime() - new Date(g.earliestEndDate).getTime();
        g.endDateSpread = Math.floor(ms / 86_400_000); // days
        if (g.endDateSpread > 7) {
          g.warning = 'drift'; // UI surfaces a "joint renewal" warning badge
        }
      }
    }

    const list = Object.values<any>(groups).sort((a, b) => {
      if (!a.earliestEndDate && !b.earliestEndDate) return a.name.localeCompare(b.name);
      if (!a.earliestEndDate) return 1;
      if (!b.earliestEndDate) return -1;
      const diff = a.earliestEndDate - b.earliestEndDate;
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });

    res.json({ success: true, data: { groups: list } });
  } catch (err) {
    console.error('Coterm summary error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch co-term summary' });
  }
});

// ─── GET /api/contracts/:id ───────────────────────────────────────────────────
// ─── GET /api/contracts/match (v0.10.0 ingestion intelligence) ───────────────
// Given a vendor name + contract number (typically from an AI extraction),
// return active contracts that look like the existing master agreement so
// the ingestion review UI can surface "found a match — add this as a PO
// instead of creating a new contract?"
//
// MUST be declared before `GET /:id` — otherwise Express matches with
// id='match' and 404s.
//
// Normalisation:
//   - both fields: strip surrounding whitespace, lowercase.
//   - contract number: also strip non-alphanumeric so "MPSA-12345" matches
//     "MPSA 12345" and "mpsa12345".
// Match logic:
//   - vendor: case-insensitive containment either direction so "Microsoft"
//     matches "Microsoft Corporation" and vice versa.
//   - contract number: equality on the normalised form.
// Returns up to 5 candidates ordered by most-recent end date.
router.get('/match', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const vendorRaw = String(req.query.vendor || '').trim();
    const cnRaw     = String(req.query.contractNumber || '').trim();
    if (!vendorRaw && !cnRaw) {
      return res.json({ success: true, data: { candidates: [] } });
    }

    // Fetch a coarse candidate set scoped to the account, then filter in JS
    // for the normalisation rules. Contracts-per-account is small enough
    // (a few hundred at the high end of beta) that this is fine for now; a
    // future "millions of contracts" path could push the normalisation
    // into a generated column + index.
    const rows = await prisma.contract.findMany({
      where: {
        accountId,
        archivedAt: null,
        status: { in: ['active', 'under_review'] },
        // Cheap pre-filter: at minimum the vendor name should overlap on
        // some substring of the first token. Postgres ILIKE via Prisma
        // contains-insensitive is index-light but cuts the result set
        // dramatically for big accounts.
        ...(vendorRaw ? { vendor: { name: { contains: vendorRaw.split(/\s+/)[0], mode: 'insensitive' } } } : {}),
      },
      include: {
        vendor: { select: { id: true, name: true } },
        purchaseOrders: {
          where:   { archivedAt: null },
          select:  { id: true, poNumber: true },
          orderBy: { orderDate: 'desc' },
          take:    3,
        },
      },
      orderBy: { endDate: 'desc' },
      take:    50,
    });

    const norm    = (s) => String(s || '').trim().toLowerCase();
    const normCN  = (s) => norm(s).replace(/[^a-z0-9]/g, '');
    const vN      = norm(vendorRaw);
    const cnN     = normCN(cnRaw);

    const candidates = rows.filter((c) => {
      const vendorN  = norm(c.vendor?.name);
      const vendorOK = vN === '' || vendorN.includes(vN) || vN.includes(vendorN);
      const cnOK     = cnN === '' || normCN(c.contractNumber) === cnN;
      // Both sides must match (or be wildcard) to count as a candidate.
      return vendorOK && cnOK && (vN !== '' || cnN !== '');
    }).slice(0, 5);

    return res.json({ success: true, data: { candidates } });
  } catch (err) {
    console.error('Match contracts error:', err);
    return res.status(500).json({ success: false, error: 'Failed to match contracts' });
  }
});

// ─── GET /api/contracts/brief-sections ──────────────────────────────────────
// v0.36.0 -- returns the catalog of admin-toggleable opt-in sections plus
// the per-account enabled-slug list. Settings > AI > Renewal Brief Sections
// consumes this. Read access is intentionally broader than admin: a manager
// viewing Settings should be able to see which sections are currently
// enabled even if they can't change them. Admin-only enforcement lives on
// the PUT handler below.
//
// Response shape:
//   { success: true, data: {
//       catalog: [{ slug, label, defaultOn, description }, ...],
//       enabled: ['slug1', 'slug2', ...],   // current account selection
//       defaults: ['slug1', 'slug2', ...],  // factory defaults
//       hash: '12-hex',
//   } }
router.get('/brief-sections', async (req, res) => {
  try {
    const { slugs, hash } = await _loadEnabledBriefSections(req.user.accountId);
    return res.json({
      success: true,
      data: {
        catalog:  getBriefSectionsCatalog(),
        enabled:  slugs,
        defaults: [...BRIEF_SECTION_DEFAULT_SLUGS],
        hash,
      },
    });
  } catch (err) {
    console.error('GET /brief-sections error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load brief section settings' });
  }
});

// ─── PUT /api/contracts/brief-sections ──────────────────────────────────────
// v0.36.0 -- admin-only. Body: { enabled: ['slug', ...] }. Unknown slugs are
// silently filtered. Empty array is allowed (admin opts out of every supp
// section). DEMO_MODE is rejected here at the route level so the demo's
// admin user can't permanently mutate the seed account's preferences and
// drift the demo from its documented baseline.
//
// Persists as AccountSetting row key='brief_sections_enabled', value=JSON.
// Updating the row does NOT touch any Contract row -- existing cached
// briefs invalidate naturally on the next brief view (their
// renewalBriefSectionsHash no longer matches the new account-level hash).
router.put('/brief-sections', async (req, res) => {
  // Admin-only: matches the existing aiBriefEnabled toggle gate.
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin role required to change brief section settings.' });
  }
  if (process.env.DEMO_MODE === 'true') {
    return res.status(403).json({
      success:  false,
      error:    'Action disabled in demo mode.',
      reason:   'brief_sections_demo_locked',
      demoMode: true,
    });
  }
  // v0.37.2 W6 MT-105: zod-validate the body shape + cap the array length
  // BEFORE any further processing. The previous accept-any-array check let a
  // hostile (or buggy) caller post a million-element array; even though
  // parseBriefSectionSlugs filters unknown slugs, the JSON.stringify +
  // walk-the-set cost is linear in the input size. 20 is generous (the
  // catalog ships 5 sections; the cap leaves 4x headroom for future
  // sections) and bounds the work to constant time.
  const BodySchema = z.object({
    enabled: z.array(z.string().max(64)).max(20),
  });
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error:   'Body must include `enabled` as an array of slug strings (max 20 items, slug max 64 chars).',
      details: parsed.error.flatten().fieldErrors,
    });
  }
  const incoming = parsed.data.enabled;

  try {
    // Reuse parseBriefSectionSlugs to (1) drop unknown slugs and (2)
    // normalise to registry order so the hash stays stable for the same
    // logical selection regardless of how the SPA serialised the array.
    const normalised = parseBriefSectionSlugs(JSON.stringify(incoming));
    const accountId  = req.user.accountId;
    const valueJson  = JSON.stringify(normalised);
    await prisma.accountSetting.upsert({
      where:  { accountId_key: { accountId, key: 'brief_sections_enabled' } },
      update: { value: valueJson },
      create: { accountId, key: 'brief_sections_enabled', value: valueJson },
    });
    return res.json({
      success: true,
      data: {
        enabled: normalised,
        hash:    computeBriefSectionsHash(normalised),
      },
    });
  } catch (err) {
    console.error('PUT /brief-sections error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update brief section settings' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    await autoExpireContracts(req.user.accountId);

    const contract = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
      include: {
        // v0.6.x: include vendor contacts so the Quote Request Checklist
        // on the client can auto-populate the To: line from the most-
        // recently-contacted vendor rep (falling back to vendor.supportEmail).
        vendor: {
          include: {
            contacts: {
              orderBy: [{ lastContactedAt: 'desc' }, { createdAt: 'desc' }],
            },
          },
        },
        flags: { orderBy: { createdAt: 'asc' } },
        internalOwner: { select: { id: true, name: true, email: true } },
        evaluationStartedByUser: { select: { id: true, name: true } },
        documents: {
          orderBy: { uploadedAt: 'desc' },
          include: { uploader: { select: { id: true, name: true } } },
        },
        tags: { orderBy: { createdAt: 'asc' } },
        communications: {
          include: { createdByUser: { select: { id: true, name: true } } },
          orderBy: { occurredAt: 'desc' },
          take: 20,
        },
        parentContract: {
          // poNumber is needed by the Quote Request Checklist on the client
          // ("Last term PO"); the rest powers the renewal-history strip.
          select: { id: true, product: true, endDate: true, startDate: true, costPerLicense: true, quantity: true, status: true, poNumber: true },
        },
        renewals: {
          select: { id: true, product: true, startDate: true, endDate: true, costPerLicense: true, quantity: true, status: true },
          orderBy: { createdAt: 'asc' },
        },
        customFieldValues: {
          include: { definition: true },
        },
        // Phase 1 (non-SaaS categories): contract detail needs category for
        // header badge + (Phase 4) per-category renewal-brief routing.
        category: { select: { id: true, name: true, slug: true, icon: true, color: true, defaultNoticeDays: true, defaultAutoRenewal: true } },
        // v0.10.0: multi-PO under master agreement. Show non-archived POs
        // ordered by orderDate desc (newest order first) on the detail page.
        // Archived POs are accessible via a separate filter on the dedicated
        // endpoint; the detail-page render hides them by default.
        purchaseOrders: {
          where:   { archivedAt: null },
          orderBy: [{ orderDate: 'desc' }, { createdAt: 'desc' }],
          include: {
            documents: {
              orderBy: { uploadedAt: 'desc' },
              select:  { id: true, filename: true, fileType: true, encrypted: true, uploadedAt: true },
            },
          },
        },
      },
    });

    if (!contract) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    // #12: strip encrypted license keys from the default payload; expose only a
    // boolean so the card can render a masked state. Plaintext is available only
    // via the role-gated reveal endpoint below.
    const _hasLicenseKeys = !!contract.licenseKeys;
    delete contract.licenseKeys;
    contract.hasLicenseKeys = _hasLicenseKeys;

    res.json({ success: true, data: { contract } });
  } catch (err) {
    console.error('Get contract error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch contract' });
  }
});

// GET /api/contracts/:id/m365-overlap (#19) -- Microsoft 365 license-overlap
// callout payload for THIS contract, or { overlap: null } when it is not
// displaceable / is itself the M365 anchor / the account holds no M365 anchor.
// Advisory; computed by lib/m365Overlap from the account active + under-review
// contracts (respects contract-scope restriction).
router.get('/:id/m365-overlap', async (req, res) => {
  try {
    const visible = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
      select: { id: true },
    });
    if (!visible) return res.status(404).json({ success: false, error: 'Contract not found' });
    const scopeWhere: any = {};
    if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;
    const overlap = await m365OverlapForContract(prisma, {
      accountId: req.user.accountId,
      contractId: req.params.id,
      scopeWhere,
    });
    res.json({ success: true, data: { overlap } });
  } catch (err) {
    console.error('GET /contracts/:id/m365-overlap:', err);
    res.status(500).json({ success: false, error: 'Failed to compute overlap' });
  }
});

// ─── POST /api/contracts ──────────────────────────────────────────────────────
router.post('/', requireManager, async (req, res) => {
  // (B6) zod validation. Required fields (vendorId, product) and basic types
  // are enforced here; cross-tenant ownership and active-user checks remain
  // inside the handler below.
  const parsed = validateBody(req, res, CreateContractSchema);
  if (!parsed) return;

  try {
    const {
      vendorId,
      contractNumber,
      customerNumber,
      product,
      quantity,
      costPerLicense,
      startDate,
      endDate,
      autoRenewal,
      autoRenewalNoticeDays,
      poNumber,
      invoiceNumber,
      requestor,
      deliveryEmail,
      licenseKeys,
      department,
      team,
      costCenter,
      glCode,
      endUserName,
      endUserEmail,
      internalOwnerName,
      internalOwnerEmail,
      internalOwnerId,
      deliveryMethod,
      notes,
      status,
      resellerName,
      resellerAccountNumber,
      resellerContactName,
      resellerContactEmail,
      seatsLicensed,
      seatsActivelyInUse,
      annualUpliftPercent,
      coTermGroup,
      categoryId,
      leaseStart,
      leaseEnd,
      leaseType,
      leaseBuyout,
    } = parsed;

    // Verify the vendor belongs to this account
    const vendor = await prisma.vendor.findFirst({
      where: { id: vendorId, accountId: req.user.accountId },
    });
    if (!vendor) {
      return res.status(400).json({ success: false, error: 'Vendor not found' });
    }

    // M4: verify internalOwnerId belongs to the same account and is active.
    // The DB FK prevents cross-tenant writes, but an explicit check gives a clear 400
    // instead of a silent null on mismatched UUID and blocks assigning deactivated users.
    if (internalOwnerId) {
      const owner = await prisma.user.findFirst({
        where: { id: internalOwnerId, accountId: req.user.accountId, isActive: true },
      });
      if (!owner) {
        return res.status(400).json({ success: false, error: 'Owner not found or not active in your account' });
      }
    }

    // 2026-05-10 Phase 1 (non-SaaS categories): resolve categoryId. If the
    // request specified one, verify it belongs to this account and isn't
    // archived. If none was specified, default to the account's "saas"
    // category so contracts.categoryId is never null on new rows. Falls back
    // to null only if the account somehow has no "saas" category (shouldn't
    // happen since seedCategoriesForAccount runs on account creation, but
    // be defensive — Phase 2's NOT NULL migration is the canonical guard).
    let resolvedCategoryId = null;
    if (categoryId) {
      const cat = await prisma.category.findFirst({
        where: { id: categoryId, accountId: req.user.accountId, archivedAt: null },
      });
      if (!cat) {
        return res.status(400).json({ success: false, error: 'Category not found or archived' });
      }
      resolvedCategoryId = cat.id;
    } else {
      const saasDefault = await prisma.category.findUnique({
        where: { accountId_slug: { accountId: req.user.accountId, slug: 'saas' } },
      });
      resolvedCategoryId = saasDefault?.id ?? null;
    }

    const _eltCfg = await loadEvalLeadTimes(req.user.accountId); // #28 configurable lead times
    const evaluationStartByDate = calculateEvaluationStartByDate(endDate, costPerLicense, quantity, _eltCfg);
    const cancelByDate = calculateCancelByDate(endDate, autoRenewal, autoRenewalNoticeDays);
    // #8 contract-section-refresh: quantity is canonical; seatsLicensed mirrors it
    // (one linked value). Adopt seatsLicensed when only it was supplied.
    const _mergedQty = quantity != null ? parseInt(quantity) : (seatsLicensed != null ? parseInt(seatsLicensed) : null);

    const contract = await prisma.contract.create({
      data: {
        accountId: req.user.accountId,
        vendorId,
        contractNumber: contractNumber || null,
        customerNumber: customerNumber || null,
        product,
        quantity: _mergedQty,
        costPerLicense: costPerLicense != null ? parseFloat(costPerLicense) : null,
        // (A3 5/02) Denormalized total value -- recomputed on every write.
        // v0.71.4: cap to Decimal(14,2) max so overflow can't corrupt the row.
        totalValue: (_mergedQty != null && costPerLicense != null)
          ? Math.min(parseFloat(costPerLicense) * _mergedQty, MAX_DECIMAL_14_2)
          : null,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        evaluationStartByDate,
        autoRenewal: autoRenewal === true || autoRenewal === 'true',
        autoRenewalNoticeDays: autoRenewalNoticeDays != null ? parseInt(autoRenewalNoticeDays) : null,
        cancelByDate,
        poNumber: poNumber || null,
        invoiceNumber: invoiceNumber || null,
        requestor: requestor || null,
        deliveryEmail: deliveryEmail || null,
        licenseKeys: licenseKeys ? encryptIfNeeded(licenseKeys) : null, // #12: encrypt at rest
        department: department || null,
        team: team || null,
        costCenter: costCenter || null,
        glCode: glCode || null,
        endUserName: endUserName || null,
        endUserEmail: endUserEmail || null,
        // v0.5.14: enforce mutual exclusivity at write time. If the
        // client sent BOTH internalOwnerId and internalOwnerName, the
        // User-id wins (a real LapseIQ user is more useful than free
        // text). The form UI is supposed to prevent this state, but
        // the server is the source of truth.
        internalOwnerId:    internalOwnerId || null,
        internalOwnerName:  internalOwnerId ? null : (internalOwnerName || null),
        internalOwnerEmail: internalOwnerId ? null : (internalOwnerEmail || null),
        deliveryMethod: deliveryMethod || null,
        notes: notes || null,
        status: status || 'active',
        resellerName: resellerName || null,
        resellerAccountNumber: resellerAccountNumber || null,
        resellerContactName: resellerContactName || null,
        resellerContactEmail: resellerContactEmail || null,
        seatsLicensed: _mergedQty, // #8: mirror of quantity (one linked value)
        seatsActivelyInUse: seatsActivelyInUse != null ? parseInt(seatsActivelyInUse) : null,
        annualUpliftPercent: annualUpliftPercent != null ? parseFloat(annualUpliftPercent) : null,
        coTermGroup: coTermGroup ? coTermGroup.trim() : null,
        categoryId: resolvedCategoryId,
        // category-conditional lease fields (stored for all; shown for hardware + lease_rent)
        leaseStart: leaseStart ? new Date(leaseStart) : null,
        leaseEnd: leaseEnd ? new Date(leaseEnd) : null,
        leaseType: leaseType || null,
        leaseBuyout: leaseBuyout != null ? parseFloat(leaseBuyout) : null,
      },
      include: {
        vendor: { select: { id: true, name: true } },
        internalOwner: { select: { id: true, name: true, email: true } },
        category: { select: { id: true, name: true, slug: true, icon: true, color: true } },
        flags: true,
      },
    });

    // Custom fields (admin-defined). Pulled from req.body — NOT the zod-
    // parsed payload — because the schema set is dynamic and would defeat
    // the strict-shape contract for the standard fields.
    if (req.body.customFields && typeof req.body.customFields === 'object') {
      try {
        await applyCustomFieldValues(req.user.accountId, contract.id, req.body.customFields);
      } catch (e) {
        // Roll back the just-created contract so the form can be re-submitted
        // without leaving a partial row behind. The schema's onDelete cascade
        // handles the (zero) custom field rows automatically.
        await prisma.contract.delete({ where: { id: contract.id } }).catch(() => {});
        return res.status(400).json({ success: false, error: e.message });
      }
    }

    // Log contract creation
    await logActivity(contract.id, req.user.id, req.user.accountId, 'contract_created', {
      product: contract.product,
      vendorName: vendor.name,
    });

    res.status(201).json({ success: true, data: { contract } });
  } catch (err) {
    console.error('Create contract error:', err);
    res.status(500).json({ success: false, error: 'Failed to create contract' });
  }
});

// ─── PUT /api/contracts/:id ───────────────────────────────────────────────────
router.put('/:id', requireManager, async (req, res) => {
  // (B6) zod validation. Update is partial — handler still gates each field
  // by `!== undefined` to support sparse updates from the SPA.
  const parsed = validateBody(req, res, UpdateContractSchema);
  if (!parsed) return;

  try {
    // Verify the contract belongs to this account
    const existing = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    const {
      vendorId,
      contractNumber,
      customerNumber,
      product,
      quantity,
      costPerLicense,
      startDate,
      endDate,
      autoRenewal,
      autoRenewalNoticeDays,
      poNumber,
      invoiceNumber,
      requestor,
      deliveryEmail,
      licenseKeys,
      department,
      team,
      costCenter,
      glCode,
      endUserName,
      endUserEmail,
      internalOwnerId,
      internalOwnerName,
      internalOwnerEmail,
      deliveryMethod,
      notes,
      status,
      resellerName,
      resellerAccountNumber,
      resellerContactName,
      resellerContactEmail,
      renewalChecklist,
      originalAsk,
      finalNegotiatedPrice,
      savingsLever,
      negotiationLog,
      seatsLicensed,
      seatsActivelyInUse,
      annualUpliftPercent,
      signatureStatus,
      signedAt,
      signerName,
      coTermGroup,
      categoryId,
      leaseStart,
      leaseEnd,
      leaseType,
      leaseBuyout,
    } = parsed;

    // Resolve values that affect calculated dates: use incoming if provided, existing otherwise
    const resolvedEndDate = endDate !== undefined ? endDate : existing.endDate;
    const resolvedCost = costPerLicense !== undefined ? costPerLicense : existing.costPerLicense;
    const resolvedQty = quantity !== undefined ? quantity : (seatsLicensed !== undefined ? seatsLicensed : existing.quantity);
    const resolvedAutoRenewal =
      autoRenewal !== undefined ? autoRenewal === true || autoRenewal === 'true' : existing.autoRenewal;
    const resolvedNoticeDays =
      autoRenewalNoticeDays !== undefined ? autoRenewalNoticeDays : existing.autoRenewalNoticeDays;

    const _eltCfg = await loadEvalLeadTimes(req.user.accountId); // #28 configurable lead times
    const evaluationStartByDate = calculateEvaluationStartByDate(resolvedEndDate, resolvedCost, resolvedQty, _eltCfg);
    const cancelByDate = calculateCancelByDate(resolvedEndDate, resolvedAutoRenewal, resolvedNoticeDays);

    // Build update object — only include fields that were sent in the request
    const updateData: any = { evaluationStartByDate, cancelByDate };

    // (A3 5/02) Recompute denormalized total value when either factor is in
    // the update payload. Uses *resolved* values so an update that only
    // changes one of the two still gets a correct product.
    if (quantity !== undefined || costPerLicense !== undefined || seatsLicensed !== undefined) {
      const q = resolvedQty != null  ? parseInt(resolvedQty)    : null;
      const c = resolvedCost != null ? parseFloat(resolvedCost) : null;
      // v0.71.4: cap to Decimal(14,2) max so overflow can't corrupt the row.
      updateData.totalValue = (q != null && c != null) ? Math.min(c * q, MAX_DECIMAL_14_2) : null;
    }

    if (vendorId !== undefined) {
      // Verify new vendor belongs to account
      const vendor = await prisma.vendor.findFirst({
        where: { id: vendorId, accountId: req.user.accountId },
      });
      if (!vendor) {
        return res.status(400).json({ success: false, error: 'Vendor not found' });
      }
      updateData.vendorId = vendorId;
    }
    if (contractNumber !== undefined) updateData.contractNumber = contractNumber || null;
    if (customerNumber !== undefined) updateData.customerNumber = customerNumber || null;
    if (product !== undefined) updateData.product = product;
    // #8 permission-flag: quantity (canonical seats value) is manager-editable, matching the manager-editable Utilization seats edit (one source of truth).
    if (quantity !== undefined) { updateData.quantity = quantity != null ? parseInt(quantity) : null; updateData.seatsLicensed = updateData.quantity; } // #8: mirror
    // Financial cost/price fields -- admin only
    if (req.user.role === 'admin') {
      if (costPerLicense !== undefined)
        updateData.costPerLicense = costPerLicense != null ? parseFloat(costPerLicense) : null;
    }
    if (startDate !== undefined) updateData.startDate = startDate ? new Date(startDate) : null;
    if (endDate !== undefined) updateData.endDate = endDate ? new Date(endDate) : null;
    if (autoRenewal !== undefined) updateData.autoRenewal = autoRenewal === true || autoRenewal === 'true';
    if (autoRenewalNoticeDays !== undefined)
      updateData.autoRenewalNoticeDays = autoRenewalNoticeDays != null ? parseInt(autoRenewalNoticeDays) : null;
    if (poNumber !== undefined) updateData.poNumber = poNumber || null;
    if (invoiceNumber !== undefined) updateData.invoiceNumber = invoiceNumber || null;
    if (requestor !== undefined) updateData.requestor = requestor || null;
    if (deliveryEmail !== undefined) updateData.deliveryEmail = deliveryEmail || null;
    if (licenseKeys !== undefined) updateData.licenseKeys = licenseKeys ? encryptIfNeeded(licenseKeys) : null; // #12: encrypt at rest
    if (department !== undefined) updateData.department = department || null;
    if (team !== undefined) updateData.team = team || null;
    if (costCenter !== undefined) updateData.costCenter = costCenter || null;
    if (glCode !== undefined) updateData.glCode = glCode || null;
    if (endUserName !== undefined) updateData.endUserName = endUserName || null;
    if (endUserEmail !== undefined) updateData.endUserEmail = endUserEmail || null;
    if (internalOwnerId !== undefined) {
      // M4: verify the new owner is in this account and active before accepting the assignment
      if (internalOwnerId) {
        const owner = await prisma.user.findFirst({
          where: { id: internalOwnerId, accountId: req.user.accountId, isActive: true },
        });
        if (!owner) {
          return res.status(400).json({ success: false, error: 'Owner not found or not active in your account' });
        }
      }
      updateData.internalOwnerId = internalOwnerId || null;
      // v0.5.14: when assigning a real LapseIQ user, clear any
      // previously-stored free-text owner. Mutual exclusivity at the
      // write layer — UI is supposed to enforce this too but server
      // is source of truth.
      if (internalOwnerId) {
        updateData.internalOwnerName  = null;
        updateData.internalOwnerEmail = null;
      }
    }
    // v0.5.14: free-text owner fields. Apply only if internalOwnerId
    // wasn't set in this same request (above block already handles
    // mutual exclusivity). For an existing contract where
    // internalOwnerId is null and the user wants to set free-text,
    // these flow through.
    if (internalOwnerName !== undefined && !internalOwnerId) {
      updateData.internalOwnerName  = internalOwnerName || null;
      // Clearing the name clears the email too, since they're paired.
      if (!internalOwnerName) updateData.internalOwnerEmail = null;
    }
    if (internalOwnerEmail !== undefined && !internalOwnerId) {
      updateData.internalOwnerEmail = internalOwnerEmail || null;
    }
    if (deliveryMethod !== undefined) updateData.deliveryMethod = deliveryMethod || null;
    if (notes !== undefined) updateData.notes = notes || null;
    if (status !== undefined) {
      updateData.status = status;
      // Auto-record who started the review and when
      if (status === 'under_review' && existing.status !== 'under_review') {
        updateData.evaluationStartedById = req.user.id;
        updateData.evaluationStartedAt   = new Date();
      } else if (status !== 'under_review' && existing.status === 'under_review') {
        // Leaving review state — clear the reviewer fields
        updateData.evaluationStartedById = null;
        updateData.evaluationStartedAt   = null;
      }
    }
    if (resellerName !== undefined) updateData.resellerName = resellerName || null;
    if (resellerAccountNumber !== undefined) updateData.resellerAccountNumber = resellerAccountNumber || null;
    if (resellerContactName !== undefined) updateData.resellerContactName = resellerContactName || null;
    if (resellerContactEmail !== undefined) updateData.resellerContactEmail = resellerContactEmail || null;
    if (originalAsk !== undefined) updateData.originalAsk = originalAsk != null ? parseFloat(originalAsk) : null;
    if (finalNegotiatedPrice !== undefined) updateData.finalNegotiatedPrice = finalNegotiatedPrice != null ? parseFloat(finalNegotiatedPrice) : null;
    if (savingsLever !== undefined) updateData.savingsLever = savingsLever || null;
    if (negotiationLog !== undefined) updateData.negotiationLog = negotiationLog || null;
    if (seatsLicensed !== undefined && quantity === undefined) { const _sv = seatsLicensed != null ? parseInt(seatsLicensed) : null; updateData.seatsLicensed = _sv; updateData.quantity = _sv; } // #8: seats edit drives canonical quantity
    if (seatsActivelyInUse !== undefined) updateData.seatsActivelyInUse = seatsActivelyInUse != null ? parseInt(seatsActivelyInUse) : null;
    if (annualUpliftPercent !== undefined) updateData.annualUpliftPercent = annualUpliftPercent != null ? parseFloat(annualUpliftPercent) : null;
    if (signatureStatus !== undefined) updateData.signatureStatus = signatureStatus || null;
    if (signedAt !== undefined) updateData.signedAt = signedAt ? new Date(signedAt) : null;
    if (signerName !== undefined) updateData.signerName = signerName || null;
    if (coTermGroup !== undefined) {
      // Trim and treat empty as null so the DB doesn't accumulate ' ' rows
      const trimmed = (coTermGroup || '').trim();
      updateData.coTermGroup = trimmed || null;
    }
    // 2026-05-10 Phase 1 (non-SaaS categories): accept categoryId on PUT.
    // Verifies the target category exists in this account and is active
    // (not archived). Pass null/empty to unset.
    if (categoryId !== undefined) {
      if (categoryId) {
        const cat = await prisma.category.findFirst({
          where: { id: categoryId, accountId: req.user.accountId, archivedAt: null },
        });
        if (!cat) {
          return res.status(400).json({ success: false, error: 'Category not found or archived' });
        }
        updateData.categoryId = cat.id;
      } else {
        updateData.categoryId = null;
      }
    }

    if (leaseStart !== undefined) updateData.leaseStart = leaseStart ? new Date(leaseStart) : null;
    if (leaseEnd !== undefined) updateData.leaseEnd = leaseEnd ? new Date(leaseEnd) : null;
    if (leaseType !== undefined) updateData.leaseType = leaseType || null;
    if (leaseBuyout !== undefined) updateData.leaseBuyout = leaseBuyout != null ? parseFloat(leaseBuyout) : null;

    if (renewalChecklist !== undefined) {
      // Enrich newly-checked items with who checked them and when.
      // Existing checked items retain their original user/timestamp.
      // Unchecked items are stored as { checked: false } to clear metadata.
      const prev = existing.renewalChecklist || {};
      const enriched: any = {};
      for (const [key, val] of Object.entries<any>(renewalChecklist)) {
        const newChecked  = val === true || val?.checked === true;
        const prevChecked = prev[key] === true || prev[key]?.checked === true;
        if (newChecked && !prevChecked) {
          enriched[key] = {
            checked: true,
            userId:    req.user.id,
            userName:  req.user.name || req.user.email,
            checkedAt: new Date().toISOString(),
          };
        } else if (!newChecked) {
          enriched[key] = { checked: false };
        } else {
          // Already checked — preserve original attribution
          enriched[key] = prev[key];
        }
      }
      updateData.renewalChecklist = enriched;
    }

    // ── Detect what changed (for activity log) ────────────────────────────────
    const statusChanged = 'status' in updateData && updateData.status !== existing.status;
    const ownerChanged  = 'internalOwnerId' in updateData && updateData.internalOwnerId !== existing.internalOwnerId;
    const changedFields = [];
    for (const [key, label] of Object.entries<any>(TRACKED_FIELDS)) {
      if (key in updateData) {
        if (String(existing[key] ?? '') !== String(updateData[key] ?? '')) {
          changedFields.push(label);
        }
      }
    }

    // S1-FN-01 (v0.75.x): alert dedup reset on significant endDate change.
    // The Alert unique dedup key (contractId, alertType, daysBeforeEnd) has no
    // fireDate/cycle component. When a customer renews a contract in-place by
    // pushing endDate forward (vs. using /renew to clone) the old Alert rows
    // are never re-generated, so the renewed contract gets zero alerts.
    // Fast fix: if endDate shifts by >30 days, delete the prior pending/sent
    // Alert rows for this contract so the engine regenerates them tonight.
    if (endDate !== undefined && existing.endDate) {
      const oldEnd  = existing.endDate instanceof Date ? existing.endDate : new Date(existing.endDate);
      const newEnd  = new Date(endDate);
      const shiftMs = newEnd.getTime() - oldEnd.getTime();
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      if (Math.abs(shiftMs) > THIRTY_DAYS_MS) {
        // Hard-delete prior alerts — the engine will regenerate them on next
        // cron run. We only clear pending/sent; acknowledged/cancelled rows
        // are historical records the operator may want to retain.
        const deleted = await prisma.alert.deleteMany({
          where: {
            contractId: req.params.id,
            status: { in: ['pending', 'sent'] },
          },
        });
        if (deleted.count > 0) {
          console.log(
            ['[contracts] S1-FN-01 reset', deleted.count, 'alert(s) for contract',
             req.params.id.slice(0,8), '(endDate shifted', Math.round(shiftMs/86400000), 'days)'].join(' ')
          );
        }
      }
    }

    const contract = await prisma.contract.update({
      where: { id: req.params.id },
      data: updateData,
      include: {
        vendor: { select: { id: true, name: true } },
        category: { select: { id: true, name: true, slug: true, icon: true, color: true } },
        flags: { orderBy: { createdAt: 'asc' } },
        internalOwner: { select: { id: true, name: true, email: true } },
      },
    });

    // ── Log activity (non-fatal, after successful update) ─────────────────────
    if (statusChanged) {
      await logActivity(req.params.id, req.user.id, req.user.accountId, 'status_changed', {
        from: existing.status,
        to: updateData.status,
      });
    }
    if (ownerChanged) {
      await logActivity(req.params.id, req.user.id, req.user.accountId, 'owner_assigned', {
        toUserId: updateData.internalOwnerId || null,
      });
    }
    if (changedFields.length > 0) {
      await logActivity(req.params.id, req.user.id, req.user.accountId, 'fields_updated', {
        fields: changedFields,
      });
    }
    if (renewalChecklist !== undefined) {
      // Detect which items changed so the log is descriptive
      const prev = existing.renewalChecklist || {};
      const next = renewalChecklist || {};
      const CHECKLIST_LABELS: any = {
        noticesSent:        'Renewal notice sent to vendor',
        usageReviewed:      'Usage reviewed / quote requested',
        proposalReceived:   'Proposal received',
        underNegotiation:   'Under negotiation',
        awaitingSignature:  'Approved & awaiting signature',
        signed:             'Signed / renewed',
      };
      const toggled = Object.keys(CHECKLIST_LABELS).filter(k => !!prev[k] !== !!next[k]);
      if (toggled.length > 0) {
        await logActivity(req.params.id, req.user.id, req.user.accountId, 'checklist_updated', {
          items: toggled.map(k => ({ key: k, label: CHECKLIST_LABELS[k], checked: !!next[k] })),
        });
      }
    }

    // Custom fields — same shape as POST. Failure here is a 400 because
    // the standard fields already saved successfully; the user just needs
    // to fix the bad custom value and resubmit.
    if (req.body.customFields && typeof req.body.customFields === 'object') {
      try {
        await applyCustomFieldValues(req.user.accountId, req.params.id, req.body.customFields);
      } catch (e) {
        return res.status(400).json({ success: false, error: e.message });
      }
    }

    res.json({ success: true, data: { contract } });
  } catch (err) {
    console.error('Update contract error:', err);
    res.status(500).json({ success: false, error: 'Failed to update contract' });
  }
});

// ─── PATCH /api/contracts/:id/archive ────────────────────────────────────────
// Toggle archive state. Body: { archived: true | false }
router.patch('/:id/archive', requireManager, async (req, res) => {
  try {
    const existing = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    const archive = req.body.archived === true || req.body.archived === 'true';
    const contract = await prisma.contract.update({
      where: { id: req.params.id },
      data: {
        archivedAt:   archive ? new Date() : null,
        archivedById: archive ? req.user.id : null,
      },
    });

    await logActivity(req.params.id, req.user.id, req.user.accountId, archive ? 'contract_archived' : 'contract_unarchived', null);

    res.json({ success: true, data: { contract } });
  } catch (err) {
    console.error('Archive contract error:', err);
    res.status(500).json({ success: false, error: 'Failed to archive contract' });
  }
});

// ─── POST /api/contracts/:id/renew ───────────────────────────────────────────
// Clone this contract into a new "renewal" record, mark the original as renewed,
// and link them via parentContractId. Returns the new contract id.
router.post('/:id/renew', requireManager, async (req, res) => {
  try {
    // T2-N7 (audit-2 CR-4): validate renew body -- costPerLicense passed as 'abc' or > Decimal(14,2) gave 500 with no useful error
    const RenewBodySchema = z.object({
      startDate:             z.string().optional().nullable(),
      endDate:               z.string().optional().nullable(),
      quantity:              z.preprocess(v => v == null ? undefined : parseInt(v), z.number().int().nonnegative().max(999999).optional()),
      costPerLicense:        z.preprocess(v => v == null ? undefined : parseFloat(v), z.number().nonnegative().max(MAX_DECIMAL_14_2).optional()),
      autoRenewal:           z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
      autoRenewalNoticeDays: z.preprocess(v => v == null ? undefined : parseInt(v), z.number().int().nonnegative().max(365).optional()),
    });
    const parsedRenew = RenewBodySchema.safeParse(req.body);
    if (!parsedRenew.success) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: parsedRenew.error.flatten().fieldErrors });
    }
    const original = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
    });
    if (!original) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }
    if (original.status === 'renewed') {
      return res.status(400).json({ success: false, error: 'This contract has already been renewed' });
    }

    const { calculateEvaluationStartByDate, calculateCancelByDate } = require('../utils/dates');

    // Build the new contract from the original, clearing date-specific and financial state
    const {
      id, createdAt, updatedAt, status, parentContractId,
      startDate, endDate, evaluationStartByDate, cancelByDate,
      ...copyFields
    } = original;

    // Allow overrides from the request body (new dates, updated cost etc.)
    const newStartDate = req.body.startDate ? new Date(req.body.startDate) : null;
    const newEndDate   = req.body.endDate   ? new Date(req.body.endDate)   : null;
    const newQty       = req.body.quantity  != null ? parseInt(req.body.quantity)       : original.quantity;
    const newCost      = req.body.costPerLicense != null ? parseFloat(req.body.costPerLicense) : original.costPerLicense;
    const newAutoRen   = req.body.autoRenewal != null
      ? (req.body.autoRenewal === true || req.body.autoRenewal === 'true')
      : original.autoRenewal;
    const newNoticeDays = req.body.autoRenewalNoticeDays != null
      ? parseInt(req.body.autoRenewalNoticeDays)
      : original.autoRenewalNoticeDays;

    const _eltCfg = await loadEvalLeadTimes(req.user.accountId); // #28 configurable lead times
    const newReviewByDate = calculateEvaluationStartByDate(newEndDate, newCost, newQty, _eltCfg);
    const newCancelByDate = calculateCancelByDate(newEndDate, newAutoRen, newNoticeDays);

    const [newContract] = await prisma.$transaction([
      // 1. Create the renewal contract
      prisma.contract.create({
        data: {
          ...copyFields,
          quantity: newQty,
          seatsLicensed: newQty, // #8: mirror of quantity
          costPerLicense: newCost,
          // (A3 5/02) recompute denormalized total value for the renewal term
          // v0.71.4: cap to Decimal(14,2) max so overflow can't corrupt the row.
          totalValue: (newQty != null && newCost != null) ? Math.min(parseFloat(String(newCost)) * parseInt(String(newQty)), MAX_DECIMAL_14_2) : null,
          autoRenewal: newAutoRen,
          autoRenewalNoticeDays: newNoticeDays,
          startDate: newStartDate,
          endDate: newEndDate,
          evaluationStartByDate: newReviewByDate,
          cancelByDate: newCancelByDate,
          status: 'active',
          parentContractId: original.id,
          budgetNeededQty: null, // reset planning qty for new term
        },
      }),
      // 2. Mark the original as renewed
      prisma.contract.update({
        where: { id: original.id },
        data: { status: 'renewed' },
      }),
    ]);

    // Log renewal on the original contract and creation on the new one
    await logActivity(original.id, req.user.id, req.user.accountId, 'contract_renewed', {
      newContractId: newContract.id,
    });
    await logActivity(newContract.id, req.user.id, req.user.accountId, 'contract_created', {
      product: newContract.product,
      clonedFrom: original.id,
    });

    res.status(201).json({ success: true, data: { contractId: newContract.id } });
  } catch (err) {
    console.error('Renew contract error:', err);
    res.status(500).json({ success: false, error: 'Failed to create renewal contract' });
  }
});

// ─── DELETE /api/contracts/:id ────────────────────────────────────────────────
// Soft delete — sets status to "cancelled". Data is preserved.
router.delete('/:id', requireManager, async (req, res) => {
  try {
    const existing = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    await prisma.contract.update({
      where: { id: req.params.id },
      data: { status: 'cancelled' },
    });

    await logActivity(req.params.id, req.user.id, req.user.accountId, 'contract_cancelled', {
      from: existing.status,
    });

    res.json({ success: true, data: { message: 'Contract cancelled' } });
  } catch (err) {
    console.error('Cancel contract error:', err);
    res.status(500).json({ success: false, error: 'Failed to cancel contract' });
  }
});

// ─── POST /api/contracts/:id/brief ───────────────────────────────────────────
// Generate (or regenerate) an AI renewal brief.
//
// Phase 4 (v0.4.0): routes through ../lib/aiBrief.pickTemplate(slug) — the
// per-category template owns its system prompt, user-prompt builder, and
// Tavily search config. Generic context construction lives in
// ../lib/aiBrief/buildContext. The structural 4-section instruction
// envelope (## Situation / ## Market / ## Tactics / ## Watch For) lives in
// ../lib/aiBrief/outputContract.
//
// Quota model: briefLimiter (30/hr burst) remains in place; on top of
// that, aiQuota's 'brief' action gates daily cost on demo (1/day per
// user, UNLIMITED on self-host). Tavily 'brief_search' is enrolled too
// but isn't called yet — Layer 5 wires the actual search.
//
// Cached in the DB — returns existing brief unless ?refresh=1 is passed.
// On miss/refresh, persists renewalBriefCategorySlug + renewalBriefTemplateVersion
// so the UI can detect drift when the user later re-categorises the
// contract.
// Pass-2 audit P0 (2026-05-17): added requireManager. Pre-fix the route
// was reachable by viewer + consultant tokens, both of whom can burn
// real Anthropic + Tavily credits per call (the route writes renewalBrief
// + renewalBriefSources to the contract row and pays per request). The
// pass-1 rationale for keeping consultant.renewal_brief=true assumed
// regen still hit requireManager — that gate didn't exist. It does now.
router.post('/:id/brief', requireManager, aiIpLimiter, briefLimiter, async (req, res) => { // v0.69.1: per-IP stack
  if (process.env.AI_ENABLED === 'false') {
    return res.status(403).json({ success: false, error: 'AI features are disabled on this instance' });
  }
  // Pass-6 T7-N1: GPC opt-out blocks AI processing.
  if (req.gpc) {
    return res.status(403).json({ success: false, error: 'AI features are disabled because your browser sent a Global Privacy Control (Sec-GPC: 1) signal.', code: 'GPC_AI_BLOCKED' });
  }
  try {
    const contract = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
      include: {
        vendor: {
          select: {
            name: true, cotermComplexity: true, cotermNotes: true, notes: true,
            // v0.4.1 (#7): surface a quote-request recipient suggestion in
            // the Watch For section when the account has stored vendor
            // contacts. Take the most-recently-contacted entry that has
            // a real email; the brief mentions it as a suggested To: line.
            contacts: {
              where: { email: { not: null } },
              orderBy: [{ lastContactedAt: 'desc' }, { updatedAt: 'desc' }],
              take:    1,
              select:  { name: true, email: true, title: true },
            },
          },
        },
        tags:           { select: { tag: true } },
        parentContract: { select: { product: true, startDate: true, endDate: true, costPerLicense: true, quantity: true } },
        renewals:       { select: { product: true, startDate: true, endDate: true, costPerLicense: true, quantity: true }, orderBy: { createdAt: 'asc' } },
        // Phase 4: category drives template routing; account drives the per-feature toggle
        category:       { select: { slug: true, name: true } },
        account:        { select: { aiBriefEnabled: true } },
        customFieldValues: {
          where:   { value: { not: null } },
          include: { definition: { select: { fieldKey: true, name: true, type: true } } },
        },
      },
    });
    if (!contract) return res.status(404).json({ success: false, error: 'Contract not found' });

    // ── Phase 4: per-account aiBriefEnabled gate ─────────────────────
    // Server-side enforcement — does NOT depend on the UI hiding the
    // "Generate brief" button. A user (or a script) hitting this
    // endpoint directly while the account toggle is off gets 403,
    // regardless of role or any other check. Default OFF on self-host
    // (schema default false); demo seed flips this to true.
    if (!contract.account?.aiBriefEnabled) {
      return res.status(403).json({
        success: false,
        error:   'ai_brief_disabled_for_account',
        message: 'AI renewal brief is disabled for this account. An admin can enable it in Settings > AI & Extraction.',
      });
    }

    // #9: a renewed / cancelled / expired contract never needs a renewal brief.
    // Reject server-side (defense in depth -- the UI also hides the brief section)
    // so a direct API call can't burn an AI call on a terminal-status contract.
    if (['renewed', 'cancelled', 'expired'].includes(contract.status)) {
      return res.status(409).json({
        success: false,
        error:   'brief_not_applicable_terminal_status',
        message: 'A renewal brief is only available for active or under-review contracts.',
      });
    }

    // Return cached brief unless refresh is explicitly requested. The
    // cached response surfaces categorySlug + templateVersion so the UI
    // can warn when they've drifted from the contract's current category.
    //
    // Cached view sits BEFORE the consent gate: viewing an already-
    // generated brief is read-only and doesn't incur a new AI call.
    // Consent is enforced below on the new-generation path.
    // v0.36.0: load the per-account enabled-section list once -- the
    // cache-return path needs it for drift comparison, and the
    // generation path uses the same slugs for the call-2 envelope.
    const briefSections = await _loadEnabledBriefSections(req.user.accountId);

    if (contract.renewalBrief && req.query.refresh !== '1') {
      // Treat the cache as stale when the enabled-section list has
      // changed since the cached brief was generated. The route falls
      // through to the regenerate path so the new section selection
      // takes effect on the next user visit without requiring them
      // to click "refresh".
      const cachedSectionsHash = contract.renewalBriefSectionsHash || null;
      const sectionsHashChanged = cachedSectionsHash !== briefSections.hash;
      if (!sectionsHashChanged) {
        const { sections, parsed } = parseBriefSections(contract.renewalBrief);
        const optInSections = briefSections.slugs.length > 0
          ? parseBriefOptInSections(contract.renewalBrief, briefSections.slugs).sections
          : {};
        // v0.4.1: sourcesUsed persisted on the row; safe to surface on
        // cached return so users see citations on page reload. Empty
        // array when an older brief was generated before sources column
        // existed.
        const sourcesUsed = Array.isArray(contract.renewalBriefSources)
          ? contract.renewalBriefSources
          : [];
        return res.json({
          success: true,
          data: {
            brief:                   contract.renewalBrief,
            sections,
            sectionsParsed:          parsed,
            optInSections,
            enabledOptInSlugs:       briefSections.slugs,
            sectionsHash:            cachedSectionsHash,
            generatedAt:             contract.renewalBriefGeneratedAt,
            categorySlug:            contract.renewalBriefCategorySlug,
            templateVersion:         contract.renewalBriefTemplateVersion,
            currentCategorySlug:     contract.category?.slug || null,
            sourcesUsed,
            searchEnrichment:        sourcesUsed.length,
            cached:                  true,
          },
        });
      }
      // Otherwise fall through and regenerate -- the section list
      // changed, so the cached body no longer matches the admin's
      // current preference.
    }

    // ── Phase 4: per-session AI consent gate ─────────────────────────
    // 403 with error 'ai_consent_required' the first time a user hits
    // an AI-generating endpoint. Client renders the modal, POSTs to
    // /api/auth/ai-consent on acknowledgment, then retries. Once
    // recorded, the server is permanently happy for this user.
    if (!(await ensureAiConsent(req, res))) return;

    // v0.32.4 — global-day Gemini free-tier budget guard (DEMO_MODE only).
    if (!ensureAiBudget(req, res)) return;

    // ── aiQuota gate ('brief' action) ────────────────────────────────
    // Demo (v0.32.4): 2/day per user (was 1 in v0.32.3). Self-host:
    // UNLIMITED short-circuit inside checkAndIncrement. Fail-open on
    // infra errors so a momentary Postgres hiccup doesn't lock paying
    // customers out.
    try {
      const userId = req.user?.id;
      const quota = await checkAiQuota(userId, 'brief', req.user?.accountId, req.user?.role);
      if (!quota.ok) {
        return res.status(402).json({
          success: false,
          error:   'ai_daily_cap_reached',
          data:    { count: quota.count, cap: quota.cap, resetAt: quota.resetAt },
        });
      }
    } catch (err) {
      console.error('AI quota check error (failing open):', err);
    }

    // ── Pick template + build context ────────────────────────────────
    const categorySlug = contract.category?.slug || null;
    const template     = pickTemplate(categorySlug);
    const ctx          = buildContext(contract);

    // #19 M365 license-overlap leverage: when this contract function is
    // already bundled in an M365 license the account holds, surface that fact
    // in the brief context so the model can cite it as displacement leverage.
    // Fails open (advisory only).
    try {
      const _scopeWhere: any = {};
      if (req.user.contractScopeRestricted) _scopeWhere.internalOwnerId = req.user.id;
      const _m365 = await m365OverlapForContract(prisma, {
        accountId: req.user.accountId,
        contractId: contract.id,
        scopeWhere: _scopeWhere,
      });
      if (_m365) ctx.m365Overlap = _m365;
    } catch (e) {
      console.error('m365 overlap (brief) failed open:', e);
    }

    // ── Tavily web-search enrichment (fails open) ────────────────────
    // Gated by:
    //   1. template has a non-empty searchDomains allowlist + searchQuery
    //   2. aiQuota.checkAndIncrement('brief_search') passes (separate from
    //      the 'brief' bucket — Tavily call costs separately from LLM call)
    //   3. TAVILY_API_KEY is set (tavilySearch returns [] otherwise)
    //
    // Query construction (2026-05-13, was vendor-free pre-v0.6.0;
    // suffix -> prefix swap 2026-05-13 v0.9.3):
    // Tighten the query with the contract's vendor + product name so
    // Tavily ranks product-specific pages above competitor marketplace
    // top-pages. Vendor + product appear at the START of the query
    // because retrieval rankers weight earlier tokens more heavily —
    // the "Notion Business" in `Notion Business SaaS renewal pricing`
    // dominates ranking better than `... renewal pricing Notion Business`.
    //
    // Each value is sanitized:
    //   - control chars (\r \n \t and the rest of 0x00-0x1F + 0x7F) -> space
    //   - Tavily/Google operator chars (": ( ) " ' \) stripped
    //   - clamped to 60 chars each
    //
    // Vendor + product are operator-controlled (manager+ to write); the
    // sanitizer is defence-in-depth, not the only barrier. The wrapper
    // applies its own 400-char clamp on the final concatenated string.
    function _sanitizeForQuery(s, maxLen = 60) {
      if (s == null) return '';
      return String(s)
        .replace(/[\r\n\t\x00-\x1F\x7F]/g, ' ')
        .replace(/[:"'()\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLen);
    }
    const _vendorTerm  = _sanitizeForQuery(contract.vendor?.name);
    const _productTerm = _sanitizeForQuery(contract.product);
    const _prefix = [_vendorTerm, _productTerm].filter(Boolean).join(' ');
    const _enrichedQuery = _prefix
      ? `${_prefix} ${template.searchQuery}`
      : template.searchQuery;

    let searchResults = [];
    if (Array.isArray(template.searchDomains) && template.searchDomains.length > 0
        && typeof template.searchQuery === 'string' && template.searchQuery.length > 0) {
      try {
        const userId = req.user?.id;
        const searchQuota = await checkAiQuota(userId, 'brief_search', req.user?.accountId, req.user?.role);
        if (searchQuota.ok) {
          searchResults = await tavilySearch.search({
            query:              _enrichedQuery,
            domains:            template.searchDomains,
            timeRange:          template.searchTimeRange,
            maxResults:         template.searchResultCap,
            // Pass the vendor name (not the product) as the relevance probe —
            // product names are sometimes generic ("Standard plan"), vendor
            // names are reliably distinctive. tavilySearch emits a one-line
            // warn when top-3 results don't substring-match this term.
            relevanceMatchTerm: _vendorTerm || undefined,
          });
        }
        // If !searchQuota.ok we silently fall through to searchResults=[].
        // The brief still generates; the template's no-reference fallback
        // fires; the user gets a brief without market enrichment. Quota
        // overflow is NOT a hard error on a feature that's strictly
        // additive to brief quality.
      } catch (err) {
        console.error('brief search wrapper threw (failing open):', err);
        // H3 (audit High, 2026-05-22): refund the brief_search slot since
        // the user got no enriched references for it.
        await refundAiQuota(req.user?.id, 'brief_search', req.user?.accountId);
      }
    }

    const userPrompt = template.buildUserPrompt(ctx, searchResults);

    // ── LLM call ─────────────────────────────────────────────────────
    // maxTokens defaults:
    //   - demo:      1800 (cost-protected on shared API key; envelope's
    //                       BUDGET DISCIPLINE asks model to target
    //                       ~700-800 words total, so this is safety
    //                       margin, not a target)
    //   - self-host: 2250 (customer using their own API key has more
    //                       headroom for complex contracts; cost
    //                       differential is ~$0.002 per call on Haiku)
    //   - explicit:  AI_BRIEF_MAX_TOKENS env override beats both
    //                defaults for operators who want to tune further.
    // cacheSystem: true so the per-category system prompt hits
    // Anthropic's prompt cache — collapses per-call cost on the
    // repeat path (user regenerates the brief).
    const envOverride = parseInt(process.env.AI_BRIEF_MAX_TOKENS, 10);
    const briefMaxTokens = Number.isFinite(envOverride) && envOverride > 0
      ? envOverride
      : (process.env.DEMO_MODE === 'true' ? 1800 : 2250);

    // v0.36.0 two-call pattern. Call 1 generates the always-on 4
    // (Situation / Market / Tactics / Watch For) using the
    // OUTPUT_CONTRACT_ENVELOPE the per-category template already
    // appended via buildUserPrompt. Call 2 -- ONLY when the admin
    // has any opt-ins enabled -- generates the supplementary
    // sections from buildOptInEnvelope(). Both fire in parallel via
    // Promise.all; failure on call 2 fails open (the brief still
    // ships with the 4 always-on sections, the supplementary block
    // is just omitted).
    const optInEnvelope = buildOptInEnvelope(briefSections.slugs);

    // v0.36.7 (Pass-6 W2 MT-016): wrap each parallel LLM call in a
    // 45s timeout. Pre-fix, a hung CF call (Workers AI tail latency
    // has been observed up to 90s in practice during edge incidents)
    // could block the brief response indefinitely; the axios timeout
    // inside the provider is 10s for chat-completions but the cascade
    // adds retry hops + breaker delays so the cumulative wall-clock
    // could exceed a reasonable user-wait threshold. The 45s ceiling
    // matches the brief route's expected SLA (briefs are async-feeling
    // from the user POV — a long-but-finite wait is OK; an indefinite
    // hang is not).
    const PARALLEL_LLM_TIMEOUT_MS = 45_000;
    function _withLlmTimeout(promise, label) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`[brief] ${label} timed out after ${PARALLEL_LLM_TIMEOUT_MS}ms`)),
          PARALLEL_LLM_TIMEOUT_MS,
        );
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    const call1 = _withLlmTimeout(complete({
      system:      template.systemPrompt,
      user:        userPrompt,
      maxTokens:   briefMaxTokens,
      cacheSystem: true,
      task:        'brief',
    }), 'call1 (main brief)');
    // Supplementary call budget scales with how many sections were
    // enabled (250-450-word target per the opt-in envelope) but we
    // cap at 900 tokens so a misbehaving call can't dominate the
    // total request budget. Falls back gracefully if AI_BRIEF_OPT_IN_MAX_TOKENS
    // is set explicitly for operators who want to retune.
    const optInEnvOverride = parseInt(process.env.AI_BRIEF_OPT_IN_MAX_TOKENS, 10);
    const optInMaxTokens = Number.isFinite(optInEnvOverride) && optInEnvOverride > 0
      ? optInEnvOverride
      : 900;
    const call2 = optInEnvelope
      ? _withLlmTimeout(complete({
          system:      BRIEF_OPT_IN_SYSTEM_PROMPT,
          // Reuse the per-category user prompt's context body, but
          // swap the always-on envelope for the opt-in one. The
          // template's userPrompt already includes the contract
          // details + reference material + always-on envelope; we
          // append the opt-in envelope after a clear separator so
          // the model knows which directives to follow.
          user:        userPrompt + '\n\n' + optInEnvelope,
          maxTokens:   optInMaxTokens,
          cacheSystem: true,
          task:        'brief',
        }), 'call2 (opt-in)').catch((err) => {
          // call2 is the supplementary section pass — fail open on
          // both timeout AND any other error so the brief still ships
          // with the 4 always-on sections.
          console.error('brief opt-in call failed (failing open):', err);
          return { text: '' };
        })
      : Promise.resolve({ text: '' });
    const [{ text: briefMain }, { text: briefOptIn }] = await Promise.all([call1, call2]);
    const optInTextTrimmed = (briefOptIn || '').trim();
    const brief = optInTextTrimmed
      ? briefMain + '\n\n' + optInTextTrimmed
      : briefMain;
    const generatedAt = new Date();

    // v0.4.1: persist Tavily sources with their retrieval timestamp.
    // The retrievedAt isn't used to invalidate cache (sources persist
    // for the life of the brief) — it's surfaced to the user as a
    // "Sources retrieved on <date>; market conditions may have shifted"
    // caveat. Protects against link-rot and shifted-market liability.
    const retrievedAtIso = generatedAt.toISOString();
    const persistedSources = (searchResults || [])
      .map((r) => ({
        title:       r.title || '',
        url:         r.url   || '',
        retrievedAt: retrievedAtIso,
      }))
      .filter((s) => s.url);

    // Pass-4.5 AI-safety wave (Agent 4 P1) — `renewalBrief` is a TEXT
    // column with no length bound at the schema level; only Anthropic's
    // max_tokens setting on the call bounded its size in practice. Clamp
    // to a defensive 32 KB before write so a manipulated AI response
    // can't balloon the row and degrade subsequent reads. 32 KB
    // comfortably exceeds the longest realistic brief (templates produce
    // ~3-8 KB typically).
    const BRIEF_MAX_BYTES = 32 * 1024;
    const briefForStorage = typeof brief === 'string' && Buffer.byteLength(brief, 'utf8') > BRIEF_MAX_BYTES
      ? Buffer.from(brief, 'utf8').slice(0, BRIEF_MAX_BYTES).toString('utf8') + '\n\n[Brief truncated at 32 KB by server-side length cap.]'
      : brief;
    await prisma.contract.update({
      where: { id: contract.id },
      data:  {
        renewalBrief:                briefForStorage,
        renewalBriefGeneratedAt:     generatedAt,
        renewalBriefCategorySlug:    template.slug,
        renewalBriefTemplateVersion: template.version,
        renewalBriefSources:         persistedSources,
        // v0.36.0: persist the enabled-section hash so the cache-
        // return path can detect drift on the next view.
        renewalBriefSectionsHash:    briefSections.hash,
      },
    });

    await logActivity(contract.id, req.user.id, req.user.accountId, 'brief_generated', {
      refresh:           req.query.refresh === '1',
      categorySlug:      template.slug,
      templateVersion:   template.version,
      searchEnrichment:  searchResults.length,
    });

    const { sections, parsed: sectionsParsed } = parseBriefSections(brief);
    const { sections: optInSections } = briefSections.slugs.length > 0
      ? parseBriefOptInSections(brief, briefSections.slugs)
      : { sections: {} };

    return res.json({
      success: true,
      data: {
        brief,
        sections,
        sectionsParsed,
        optInSections,
        enabledOptInSlugs:   briefSections.slugs,
        sectionsHash:        briefSections.hash,
        generatedAt,
        categorySlug:        template.slug,
        templateVersion:     template.version,
        currentCategorySlug: categorySlug,
        searchEnrichment:    persistedSources.length,
        sourcesUsed:         persistedSources,
        cached:              false,
      },
    });
  } catch (err) {
    console.error('Brief generation error:', err);
    // v0.37.3 W6 followup MT-102: refund the 'brief' quota slot we consumed
    // at line ~1904 before the LLM call. The 'brief_search' (Tavily) slot
    // stays consumed -- Tavily was billed regardless of whether the brief
    // succeeded downstream.
    if (req.user?.id) {
      void refundAiQuota(req.user.id, 'brief');
    }
    return res.status(500).json({ success: false, error: 'Failed to generate renewal brief' });
  }
});

// ─── POST /api/contracts/:id/quote-extract ──────────────────────────────────
// v0.8.0 — Drop a vendor quote PDF on this endpoint, get back a structured
// proposal of what's in the quote. Does NOT persist to the contract — the
// client renders a review screen and lets the user accept / edit before
// PATCHing the contract's originalAsk field.
//
// Reuses the same auth + AI quota machinery as /api/ingest (manager+, AI
// consent, 'extract' daily-cap bucket shared with PDF ingest and signature
// reading). 'extract' is the right bucket because the cost profile matches:
// one PDF -> text -> Claude call.
//
// Returns:
//   { success: true, data: { proposed: {...}, contract: { id, vendor: {...},
//     product, quantity, costPerLicense, totalValue, originalAsk } } }
// The `contract` block echoes the current values so the client can render
// a side-by-side "current vs quoted" diff without a separate fetch.

const quoteExtractUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024, files: 1 },  // 10 MB - quotes are small
  fileFilter: (req, file, cb) => {
    // PDF + Word + plain text; images deferred (quotes are almost always PDFs).
    const allowed = new Set([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ]);
    if (allowed.has(file.mimetype)) return cb(null, true);
    const err = new Error('Vendor quotes must be PDF, Word (.doc/.docx), or plain text');
    (err as any).status = 415;
    return cb(err);
  },
});

router.post('/:id/quote-extract', requireManager, (req, res, next) => {
  // Run multer with manual error catch so we return a clean 415/413 instead
  // of a generic 500. Mirrors the wrapper pattern in contractsImport.js.
  quoteExtractUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, error: 'Quote PDF exceeds 10 MB' });
      }
      return res.status(err.status || 400).json({ success: false, error: err.message || 'Upload failed' });
    }
    return next();
  });
}, async (req, res) => {
  if (process.env.AI_ENABLED === 'false') {
    return res.status(403).json({ success: false, error: 'AI features are disabled on this instance' });
  }
  // Pass-6 T7-N1: GPC opt-out blocks AI processing.
  if (req.gpc) {
    return res.status(403).json({ success: false, error: 'AI features are disabled because your browser sent a Global Privacy Control (Sec-GPC: 1) signal.', code: 'GPC_AI_BLOCKED' });
  }
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  try {
    // ── 1. Verify the contract exists in the caller's account ──────────────
    const contract = await prisma.contract.findFirst({
      where:  contractWhereForUser(req),
      select: {
        id: true,
        product: true,
        quantity: true,
        costPerLicense: true,
        totalValue: true,
        originalAsk: true,
        vendor: { select: { id: true, name: true } },
      },
    });
    if (!contract) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    // ── 2. AI consent + daily-cap gates (same as /api/ingest) ──────────────
    if (!(await ensureAiConsent(req, res))) return;
    // v0.32.4 — global-day Gemini free-tier budget guard (DEMO_MODE only).
    if (!ensureAiBudget(req, res)) return;
    try {
      const quota = await checkAiQuota(req.user.id, 'extract', req.user.accountId, req.user.role);
      if (!quota.ok) {
        return res.status(402).json({
          success: false,
          error: 'ai_daily_cap_reached',
          data: { count: quota.count, cap: quota.cap, resetAt: quota.resetAt },
        });
      }
    } catch (err) {
      console.error('[quote-extract] AI quota check error (failing open):', err);
    }

    // ── 3. Extract text + run AI ──────────────────────────────────────────
    let rawText;
    try {
      rawText = await extractText(req.file.buffer, req.file.mimetype, req.file.originalname);
    } catch (err) {
      console.error('[quote-extract] text extraction error:', err);
      // H3 (audit High, 2026-05-22): refund the 'extract' slot.
      await refundAiQuota(req.user.id, 'extract', req.user.accountId);
      return res.status(422).json({ success: false, error: 'Could not extract text from this file' });
    }
    if (!rawText || rawText.trim().length < 20) {
      return res.status(422).json({ success: false, error: 'No meaningful text found in this file' });
    }

    let proposed;
    try {
      proposed = await extractVendorQuoteFields(rawText);
    } catch (err) {
      console.error('[quote-extract] AI extraction error:', err);
      // H3 (audit High, 2026-05-22): refund the 'extract' slot.
      await refundAiQuota(req.user.id, 'extract', req.user.accountId);
      return res.status(502).json({ success: false, error: 'AI extraction failed — try again' });
    }

    // ── 4. Decorate with vendor / product match signals so the UI can
    //      surface them without re-running its own comparison logic. Both
    //      checks are forgiving — vendor names vary in capitalisation,
    //      legal-entity-suffix, etc.; the UI shows a soft warning, not a hard
    //      block, when these flip false.
    function normaliseVendor(s) {
      return String(s || '')
        .toLowerCase()
        .replace(/\b(inc|llc|ltd|corp|corporation|company|co)\.?\b/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    }
    const vendorMatch =
      proposed.vendorName && contract.vendor?.name
        ? normaliseVendor(proposed.vendorName) === normaliseVendor(contract.vendor.name)
          || normaliseVendor(proposed.vendorName).includes(normaliseVendor(contract.vendor.name))
          || normaliseVendor(contract.vendor.name).includes(normaliseVendor(proposed.vendorName))
        : null;
    const productMatch =
      proposed.productName && contract.product
        ? String(proposed.productName).toLowerCase().includes(String(contract.product).toLowerCase().slice(0, 12))
          || String(contract.product).toLowerCase().includes(String(proposed.productName).toLowerCase().slice(0, 12))
        : null;

    // ── 5. Log activity (proposed only — no contract mutation yet) ─────────
    await logActivity(contract.id, req.user.id, req.user.accountId, 'quote_extracted', {
      vendorName: proposed.vendorName,
      productName: proposed.productName,
      quotedPrice: proposed.quotedPrice,
      computedTotalPrice: proposed.computedTotalPrice,
      validUntil: proposed.validUntil,
    });

    return res.json({
      success: true,
      data: {
        proposed,
        match: { vendor: vendorMatch, product: productMatch },
        contract: {
          id: contract.id,
          product: contract.product,
          quantity: contract.quantity,
          costPerLicense: contract.costPerLicense,
          totalValue: contract.totalValue,
          originalAsk: contract.originalAsk,
          vendor: contract.vendor,
        },
      },
    });
  } catch (err) {
    console.error('[quote-extract] unhandled error:', err);
    return res.status(500).json({ success: false, error: 'Quote extraction failed' });
  }
});

// ─── GET /api/contracts/:id/activity ─────────────────────────────────────────
// Returns the activity log for a contract, newest first, with user info.
router.get('/:id/activity', async (req, res) => {
  try {
    const contract = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
      select: { id: true },
    });
    if (!contract) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    const logs = await prisma.activityLog.findMany({
      where: { contractId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });

    res.json({ success: true, data: { logs } });
  } catch (err) {
    console.error('Activity log error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch activity log' });
  }
});

// ─── POST /api/contracts/:id/tags ────────────────────────────────────────────
// Add a tag to a contract (upsert — no-op if already exists)
router.post('/:id/tags', requireManager, async (req, res) => {
  const { tag } = req.body;
  if (!tag?.trim()) return res.status(400).json({ success: false, error: 'tag is required' });

  const contract = await prisma.contract.findFirst({
    where: contractWhereForUser(req),
  });
  if (!contract) return res.status(404).json({ success: false, error: 'Contract not found' });

  try {
    await prisma.contractTag.upsert({
      where: { contractId_tag: { contractId: contract.id, tag: tag.trim().toLowerCase() } },
      create: { contractId: contract.id, tag: tag.trim().toLowerCase() },
      update: {},
    });
    const tags = await prisma.contractTag.findMany({ where: { contractId: contract.id }, orderBy: { tag: 'asc' } });
    return res.json({ success: true, data: { tags } });
  } catch (err) {
    console.error('Add tag error:', err);
    return res.status(500).json({ success: false, error: 'Failed to add tag' });
  }
});

// ─── DELETE /api/contracts/:id/tags/:tag ─────────────────────────────────────
router.delete('/:id/tags/:tag', requireManager, async (req, res) => {
  const contract = await prisma.contract.findFirst({
    where: contractWhereForUser(req),
  });
  if (!contract) return res.status(404).json({ success: false, error: 'Contract not found' });

  await prisma.contractTag.deleteMany({
    where: { contractId: contract.id, tag: req.params.tag },
  });
  const tags = await prisma.contractTag.findMany({ where: { contractId: contract.id }, orderBy: { tag: 'asc' } });
  return res.json({ success: true, data: { tags } });
});

// ─── GET /api/contracts/:id/payment-schedule ─────────────────────────────────
// Returns the payment schedule + installments for a contract, or null if none set.
// --- #12 License Keys & Access ------------------------------------------------
// License keys are encrypted at rest (lib/crypto AES-256-GCM) and never shipped
// in the default contract payload. Plaintext egress happens ONLY here, gated to
// the roles configured in AccountSetting LICENSE_REVEAL_ROLES (default
// admin+manager, adjustable in Security Settings); every reveal is audited.
const LICENSE_REVEAL_VALID_ROLES = ['admin', 'manager', 'viewer', 'consultant'];
async function _loadLicenseRevealRoles(accountId) {
  try {
    const row = await prisma.accountSetting.findUnique({
      where: { accountId_key: { accountId, key: 'LICENSE_REVEAL_ROLES' } },
    });
    if (row && row.value) {
      const arr = JSON.parse(row.value);
      if (Array.isArray(arr)) {
        const clean = arr.filter((r) => LICENSE_REVEAL_VALID_ROLES.includes(r));
        if (!clean.includes('admin')) clean.push('admin'); // admin can never be locked out
        if (clean.length) return clean;
      }
    }
  } catch (err) {
    console.error('LICENSE_REVEAL_ROLES read error (falling back to default):', err.message);
  }
  return ['admin', 'manager'];
}

// POST /api/contracts/:id/license-keys/reveal -- role-gated, audited plaintext egress.
router.post('/:id/license-keys/reveal', async (req, res) => {
  try {
    const contract = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
      select: { id: true, licenseKeys: true },
    });
    if (!contract) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    const allowedRoles = await _loadLicenseRevealRoles(req.user.accountId);
    if (!allowedRoles.includes(req.user.role)) {
      await logActivity(contract.id, req.user.id, req.user.accountId, 'permission_denied', {
        action: 'license_keys_reveal',
        role: req.user.role,
        allowedRoles,
      });
      return res.status(403).json({ success: false, error: 'You do not have permission to reveal license keys.' });
    }

    const plaintext = contract.licenseKeys ? decryptIfEncrypted(contract.licenseKeys) : '';

    await logActivity(contract.id, req.user.id, req.user.accountId, 'license_keys_revealed', {
      role: req.user.role,
    });

    return res.json({ success: true, data: { licenseKeys: plaintext } });
  } catch (err) {
    console.error('Reveal license keys error:', err);
    return res.status(500).json({ success: false, error: 'Failed to reveal license keys' });
  }
});

// PUT /api/contracts/:id/vendor-portal -- set the access/login portal URL on the
// contract's vendor (applies to all of that vendor's contracts). Manager+ only.
router.put('/:id/vendor-portal', requireManager, async (req, res) => {
  try {
    const contract = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
      select: { id: true, vendorId: true },
    });
    if (!contract) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    let portalUrl = req.body ? req.body.portalUrl : undefined;
    if (portalUrl == null || String(portalUrl).trim() === '') {
      portalUrl = null;
    } else {
      portalUrl = String(portalUrl).trim();
      if (portalUrl.length > 2000) {
        return res.status(400).json({ success: false, error: 'Portal URL is too long.' });
      }
      if (!/^https?:\/\//i.test(portalUrl)) {
        return res.status(400).json({ success: false, error: 'Portal URL must start with http:// or https://' });
      }
    }

    const vendor = await prisma.vendor.update({
      where: { id: contract.vendorId },
      data: { portalUrl },
      select: { id: true, name: true, portalUrl: true },
    });

    await logActivity(contract.id, req.user.id, req.user.accountId, 'fields_updated', {
      scope: 'vendor_portal',
      vendorId: vendor.id,
    });

    return res.json({ success: true, data: { vendor } });
  } catch (err) {
    console.error('Update vendor portal error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update vendor portal link' });
  }
});

router.get('/:id/payment-schedule', async (req, res) => {
  try {
    const contract = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
      select: { id: true },
    });
    if (!contract) return res.status(404).json({ success: false, error: 'Contract not found' });

    const schedule = await prisma.paymentSchedule.findUnique({
      where: { contractId: req.params.id },
      include: {
        installments: { orderBy: { yearNumber: 'asc' } },
      },
    });

    return res.json({ success: true, data: { schedule } });
  } catch (err) {
    console.error('Get payment schedule error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch payment schedule' });
  }
});

// ─── PUT /api/contracts/:id/payment-schedule ─────────────────────────────────
// Upserts the payment schedule. For installment type, replaces all installments.
// Body: { scheduleType, notes?, installments?: [{ yearNumber, amount, dueDate?, notes? }] }
router.put('/:id/payment-schedule', requireManager, async (req, res) => {
  try {
    const contract = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
      select: { id: true },
    });
    if (!contract) return res.status(404).json({ success: false, error: 'Contract not found' });

    const { scheduleType, notes, installments = [] } = req.body;

    if (!['installment', 'monthly', 'paid_upfront', 'dismissed'].includes(scheduleType)) {
      return res.status(400).json({ success: false, error: 'Invalid scheduleType' });
    }

    // Upsert the schedule record
    const schedule = await prisma.paymentSchedule.upsert({
      where:  { contractId: req.params.id },
      create: { contractId: req.params.id, scheduleType, notes: notes || null },
      update: { scheduleType, notes: notes || null },
    });

    // For installment type: replace all installments with the new set
    if ((scheduleType === 'installment' || scheduleType === 'monthly') && Array.isArray(installments)) {
      // Delete existing then recreate — simplest safe approach for a small dataset
      await prisma.paymentInstallment.deleteMany({
        where: { paymentScheduleId: schedule.id },
      });
      if (installments.length > 0) {
        await prisma.paymentInstallment.createMany({
          data: installments.map(inst => ({
            paymentScheduleId: schedule.id,
            yearNumber:        parseInt(inst.yearNumber, 10),
            amount:            parseFloat(inst.amount),
            dueDate:           inst.dueDate ? new Date(inst.dueDate) : null,
            notes:             inst.notes || null,
          })),
        });
      }
    } else {
      // For paid_upfront / dismissed: clear any stale installment rows
      await prisma.paymentInstallment.deleteMany({
        where: { paymentScheduleId: schedule.id },
      });
    }

    await logActivity(req.params.id, req.user.id, req.user.accountId, 'fields_updated', { fields: ['paymentSchedule'] });

    const updated = await prisma.paymentSchedule.findUnique({
      where: { contractId: req.params.id },
      include: { installments: { orderBy: { yearNumber: 'asc' } } },
    });

    return res.json({ success: true, data: { schedule: updated } });
  } catch (err) {
    console.error('Update payment schedule error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update payment schedule' });
  }
});

// ─── Purchase Orders (v0.10.0) ───────────────────────────────────────────────
// Multi-PO support for the Microsoft MPSA / Adobe VIP pattern. Contract
// holds the master agreement (contractNumber); PurchaseOrder rows hold the
// individual deliverable POs underneath. All four endpoints scope the
// contract lookup through contractWhereForUser() so scope-restricted
// viewers can't touch POs on contracts they don't own.

// Parse a value to Decimal-friendly string or null. Accepts numbers,
// numeric strings, or null/undefined/'' — anything else returns null
// rather than letting Prisma reject the whole request.
function _parseAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function _parseInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function _parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function _trimOrNull(v, maxLen = 200) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

// ── GET /api/contracts/:id/purchase-orders ──────────────────────────────────
// List non-archived POs under a contract. Newest order first.
router.get('/:id/purchase-orders', async (req, res) => {
  try {
    const contract = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
      select: { id: true },
    });
    if (!contract) return res.status(404).json({ success: false, error: 'Contract not found' });

    const pos = await prisma.purchaseOrder.findMany({
      where:   { contractId: contract.id, archivedAt: null },
      orderBy: [{ orderDate: 'desc' }, { createdAt: 'desc' }],
      include: {
        documents: {
          orderBy: { uploadedAt: 'desc' },
          select:  { id: true, filename: true, fileType: true, encrypted: true, uploadedAt: true },
        },
      },
    });
    return res.json({ success: true, data: { purchaseOrders: pos } });
  } catch (err) {
    console.error('List purchase orders error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list purchase orders' });
  }
});

// ── POST /api/contracts/:id/purchase-orders ─────────────────────────────────
// Create a PO under a contract. manager+ only. poNumber required.
router.post('/:id/purchase-orders', requireManager, async (req, res) => {
  try {
    const contract = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
      select: { id: true },
    });
    if (!contract) return res.status(404).json({ success: false, error: 'Contract not found' });

    const poNumber = _trimOrNull(req.body.poNumber, 100);
    if (!poNumber) {
      return res.status(400).json({ success: false, error: 'poNumber is required' });
    }

    const po = await prisma.purchaseOrder.create({
      data: {
        contractId:        contract.id,
        poNumber,
        description:       _trimOrNull(req.body.description, 500),
        amount:            _parseAmount(req.body.amount),
        quantity:          _parseInt(req.body.quantity),
        orderDate:         _parseDate(req.body.orderDate),
        coverageStartDate: _parseDate(req.body.coverageStartDate),
        coverageEndDate:   _parseDate(req.body.coverageEndDate),
        notes:             _trimOrNull(req.body.notes, 2000),
      },
    });

    // Activity log: po_added. Keeps an audit trail for renewal handoffs.
    try {
      await prisma.activityLog.create({
        data: {
          contractId: contract.id,
          userId:     req.user.id,
          accountId:  req.user.accountId,
          action:     'po_added',
          details:    { poNumber, poId: po.id, amount: po.amount?.toString() || null },
        },
      });
    } catch (e) { /* non-fatal */ }

    return res.status(201).json({ success: true, data: { purchaseOrder: po } });
  } catch (err) {
    console.error('Create purchase order error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create purchase order' });
  }
});

// ── PATCH /api/contracts/:id/purchase-orders/:poId ──────────────────────────
// Edit an existing PO. Only fields present in the body are touched; any field
// omitted is left unchanged (vs PUT which would null missing fields).
router.patch('/:id/purchase-orders/:poId', requireManager, async (req, res) => {
  try {
    const contract = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
      select: { id: true },
    });
    if (!contract) return res.status(404).json({ success: false, error: 'Contract not found' });

    // PO must belong to this contract (defence in depth — caller could pass
    // any poId).
    const existing = await prisma.purchaseOrder.findFirst({
      where: { id: req.params.poId, contractId: contract.id },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Purchase order not found' });

    const data: any = {};
    if ('poNumber'          in req.body) {
      const v = _trimOrNull(req.body.poNumber, 100);
      if (!v) return res.status(400).json({ success: false, error: 'poNumber cannot be empty' });
      data.poNumber = v;
    }
    if ('description'       in req.body) data.description       = _trimOrNull(req.body.description, 500);
    if ('amount'            in req.body) data.amount            = _parseAmount(req.body.amount);
    if ('quantity'          in req.body) data.quantity          = _parseInt(req.body.quantity);
    if ('orderDate'         in req.body) data.orderDate         = _parseDate(req.body.orderDate);
    if ('coverageStartDate' in req.body) data.coverageStartDate = _parseDate(req.body.coverageStartDate);
    if ('coverageEndDate'   in req.body) data.coverageEndDate   = _parseDate(req.body.coverageEndDate);
    if ('notes'             in req.body) data.notes             = _trimOrNull(req.body.notes, 2000);

    const updated = await prisma.purchaseOrder.update({
      where: { id: existing.id },
      data,
    });

    try {
      await prisma.activityLog.create({
        data: {
          contractId: contract.id,
          userId:     req.user.id,
          accountId:  req.user.accountId,
          action:     'po_updated',
          details:    { poNumber: updated.poNumber, poId: updated.id, changed: Object.keys(data) },
        },
      });
    } catch (e) { /* non-fatal */ }

    return res.json({ success: true, data: { purchaseOrder: updated } });
  } catch (err) {
    console.error('Update purchase order error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update purchase order' });
  }
});

// ── DELETE /api/contracts/:id/purchase-orders/:poId ─────────────────────────
// Soft-archive a PO (sets archivedAt). Hard-delete is intentionally not
// exposed — archived POs disappear from the detail page + search but the
// row survives so audit-log references stay resolvable.
router.delete('/:id/purchase-orders/:poId', requireManager, async (req, res) => {
  try {
    const contract = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
      select: { id: true },
    });
    if (!contract) return res.status(404).json({ success: false, error: 'Contract not found' });

    const existing = await prisma.purchaseOrder.findFirst({
      where: { id: req.params.poId, contractId: contract.id },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Purchase order not found' });

    const archived = await prisma.purchaseOrder.update({
      where: { id: existing.id },
      data:  { archivedAt: new Date() },
    });

    try {
      await prisma.activityLog.create({
        data: {
          contractId: contract.id,
          userId:     req.user.id,
          action:     'po_archived',
          details:    { poNumber: archived.poNumber, poId: archived.id },
        },
      });
    } catch (e) { /* non-fatal */ }

    return res.json({ success: true, data: { purchaseOrder: archived } });
  } catch (err) {
    console.error('Archive purchase order error:', err);
    return res.status(500).json({ success: false, error: 'Failed to archive purchase order' });
  }
});


// -- POST /api/contracts/:id/purchase-orders/extract (item #10) ----------------
// AI autofill for the PO form. Accepts a PO / order document, extracts the PO
// fields via Claude (adapting the contract /ingest extractor) and returns the
// proposed values for the client to pre-fill PurchaseOrderForm. Click-to-run;
// no DB write here. Respects AI consent + the demo budget guard + the per-user
// daily 'extract' quota (shared with /ingest + quote-extract).
const poExtractUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = new Set([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ]);
    if (allowed.has(file.mimetype)) return cb(null, true);
    const err = new Error('PO files for AI autofill must be PDF, Word (.doc/.docx), or plain text');
    (err as any).status = 415;
    return cb(err);
  },
});

router.post('/:id/purchase-orders/extract', requireManager, (req, res, next) => {
  poExtractUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, error: 'PO file exceeds 10 MB' });
      }
      return res.status(err.status || 400).json({ success: false, error: err.message || 'Upload failed' });
    }
    return next();
  });
}, async (req, res) => {
  if (process.env.AI_ENABLED === 'false') {
    return res.status(403).json({ success: false, error: 'AI features are disabled on this instance' });
  }
  if (req.gpc) {
    return res.status(403).json({ success: false, error: 'AI features are disabled because your browser sent a Global Privacy Control (Sec-GPC: 1) signal.', code: 'GPC_AI_BLOCKED' });
  }
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  try {
    const contract = await prisma.contract.findFirst({
      where:  contractWhereForUser(req),
      select: { id: true },
    });
    if (!contract) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    if (!(await ensureAiConsent(req, res))) return;
    if (!ensureAiBudget(req, res)) return;
    try {
      const quota = await checkAiQuota(req.user.id, 'extract', req.user.accountId, req.user.role);
      if (!quota.ok) {
        return res.status(402).json({
          success: false,
          error: 'ai_daily_cap_reached',
          data: { count: quota.count, cap: quota.cap, resetAt: quota.resetAt },
        });
      }
    } catch (err) {
      console.error('[po-extract] AI quota check error (failing open):', err);
    }

    let rawText;
    try {
      rawText = await extractText(req.file.buffer, req.file.mimetype, req.file.originalname);
    } catch (err) {
      console.error('[po-extract] text extraction error:', err);
      await refundAiQuota(req.user.id, 'extract', req.user.accountId);
      return res.status(422).json({ success: false, error: 'Could not extract text from this file' });
    }
    if (!rawText || rawText.trim().length < 20) {
      await refundAiQuota(req.user.id, 'extract', req.user.accountId);
      return res.status(422).json({ success: false, error: 'No meaningful text found in this file' });
    }

    let proposed;
    try {
      proposed = await extractPurchaseOrderFields(rawText);
    } catch (err) {
      console.error('[po-extract] AI extraction error:', err);
      await refundAiQuota(req.user.id, 'extract', req.user.accountId);
      return res.status(502).json({ success: false, error: 'AI extraction failed -- try again' });
    }

    await logActivity(contract.id, req.user.id, req.user.accountId, 'po_extracted', {
      poNumber: proposed.poNumber,
      amount:   proposed.amount,
      quantity: proposed.quantity,
    });

    return res.json({ success: true, data: { proposed } });
  } catch (err) {
    console.error('[po-extract] unhandled error:', err);
    return res.status(500).json({ success: false, error: 'PO extraction failed' });
  }
});


// -- POST /api/contracts/:id/negotiate -----------------------------------------
// v0.78.0 — Negotiation Recommendation Engine.
//
// Analyzes a contract's data (context, brief, negotiation log) and returns
// a structured JSON recommendation object:
//   {
//     priority:         'high' | 'medium' | 'low',
//     leverage_points:  string[],    // 2-4 concrete buyer leverage reasons
//     risk_flags:       string[],    // 1-3 specific risks to this renewal
//     suggested_tactics: { tactic: string, rationale: string }[]  // 2-4 items
//   }
//
// Uses the same guards as the brief route:
//   - requireManager (only managers/admins can trigger)
//   - aiIpLimiter + briefLimiter (shared burst cap)
//   - aiBriefEnabled account gate
//   - ensureAiConsent + ensureAiBudget
//   - aiQuota 'negotiate' action (demo cap: 2/day)
//
// JSON extraction: we ask the model to respond with ONLY a JSON object, then
// run three extraction passes (direct parse → markdown code block → raw {}
// grab) before giving up with a 502. No partial data is returned.
router.post('/:id/negotiate', requireManager, aiIpLimiter, briefLimiter, async (req, res) => {
  if (process.env.AI_ENABLED === 'false') {
    return res.status(403).json({ success: false, error: 'AI features are disabled on this instance' });
  }
  if (req.gpc) {
    return res.status(403).json({ success: false, error: 'AI features are disabled because your browser sent a Global Privacy Control (Sec-GPC: 1) signal.', code: 'GPC_AI_BLOCKED' });
  }

  try {
    const contract = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
      include: {
        vendor: {
          select: {
            name: true, cotermComplexity: true, cotermNotes: true, notes: true,
            contacts: {
              where: { email: { not: null } },
              orderBy: [{ lastContactedAt: 'desc' }, { updatedAt: 'desc' }],
              take: 1,
              select: { name: true, email: true, title: true },
            },
          },
        },
        tags:           { select: { tag: true } },
        parentContract: { select: { product: true, startDate: true, endDate: true, costPerLicense: true, quantity: true } },
        renewals:       { select: { product: true, startDate: true, endDate: true, costPerLicense: true, quantity: true }, orderBy: { createdAt: 'asc' } },
        category:       { select: { slug: true, name: true } },
        account:        { select: { aiBriefEnabled: true } },
        customFieldValues: {
          where:   { value: { not: null } },
          include: { definition: { select: { fieldKey: true, name: true, type: true } } },
        },
      },
    });

    if (!contract) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    if (!contract.account?.aiBriefEnabled) {
      return res.status(403).json({
        success: false,
        error:   'ai_brief_disabled_for_account',
        message: 'AI features are disabled for this account. An admin can enable them in Settings > AI & Extraction.',
      });
    }

    if (!(await ensureAiConsent(req, res))) return;
    if (!ensureAiBudget(req, res)) return;

    const { checkAndIncrement: checkAiQuotaNeg, refundIncrement: refundAiQuotaNeg } = require('../lib/aiQuota');
    const userId = req.user?.id;
    try {
      const quota = await checkAiQuotaNeg(userId, 'negotiate', req.user?.accountId, req.user?.role);
      if (!quota.ok) {
        return res.status(402).json({
          success: false,
          error:   'ai_daily_cap_reached',
          data:    { count: quota.count, cap: quota.cap, resetAt: quota.resetAt },
        });
      }
    } catch (qErr) {
      console.error('[negotiate] quota check error (failing open):', qErr.message);
    }

    // Build context using the shared pure function (same as brief route)
    const ctx = buildContext(contract);
    const categoryName = contract.category?.name || 'Software';

    // Include the existing brief text as additional context if available
    const briefText = contract.renewalBrief
      ? contract.renewalBrief.slice(0, 4000) // cap at 4K chars for token budget
      : null;

    // Include negotiation log if present
    const { sanitizeUntrustedText } = require('../lib/promptSanitize');
    const negotiationLog = contract.negotiationLog
      ? sanitizeUntrustedText(contract.negotiationLog).text.slice(0, 2000)
      : null;

    // Derive priority signal from dates (deterministic hint to the model)
    let priorityHint = 'low';
    if (ctx.daysToEnd != null && ctx.daysToEnd < 60) priorityHint = 'high';
    else if (ctx.autoRenewal && ctx.daysToCancelBy != null && ctx.daysToCancelBy < 45) priorityHint = 'high';
    else if (ctx.daysToEnd != null && ctx.daysToEnd < 120) priorityHint = 'medium';

    const renewalHistoryStr = ctx.renewalHistory.length > 0
      ? ctx.renewalHistory.join('\n')
      : 'No renewal history recorded.';

    const systemPrompt = `You are an expert software contract negotiation advisor with 15 years of enterprise procurement experience. Your job is to analyze contracts and produce concise, actionable negotiation recommendations grounded in the specific data provided.

You respond ONLY with a JSON object — no markdown fences, no preamble, no explanation outside the JSON.

The JSON must match this exact shape:
{
  "priority": "high" | "medium" | "low",
  "leverage_points": ["string", "string"],
  "risk_flags": ["string"],
  "suggested_tactics": [
    { "tactic": "string", "rationale": "string" }
  ]
}

Field rules:
- priority: "high" if contract needs action within 60 days or auto-renewal is live with < 45 days to cancel-by, "medium" if 61-120 days, "low" otherwise
- leverage_points: 2-4 concrete reasons the buyer has negotiating power for THIS specific contract (volume, multi-year history, renewal timing, budget cycle, competitive alternatives, etc.)
- risk_flags: 1-3 specific risks threatening this renewal (auto-renewal trap, shrinking cancel-by window, escalation clauses, single-vendor dependency, etc.)
- suggested_tactics: 2-4 specific, actionable negotiation moves with a brief rationale for each — grounded in this contract's actual data, not generic advice
- Every string must be specific to this contract. No generic filler.`;

    const userPrompt = `Analyze this contract and generate negotiation recommendations.

CONTRACT: ${ctx.product} (${ctx.vendorName})
Category: ${categoryName}
Department: ${ctx.department}
Today: ${ctx.today}
Contract End: ${ctx.endDateFmt} (${ctx.daysToEnd != null ? ctx.daysToEnd + ' days' : 'unknown'})
Cancel-By Date: ${ctx.cancelByDateFmt || 'not recorded'} (${ctx.daysToCancelBy != null ? ctx.daysToCancelBy + ' days' : 'n/a'})
Auto-Renewal: ${ctx.autoRenewal ? 'YES — will auto-renew unless cancelled' : 'NO'}
Total Value: ${ctx.totalValueFormatted}
Per-Unit Cost: ${ctx.costPerLicense}
Quantity: ${ctx.quantity}
Co-term Complexity: ${ctx.cotermComplexity}
Tags: ${ctx.tags.length > 0 ? ctx.tags.join(', ') : 'none'}
Priority Signal: ${priorityHint}

Renewal History:
${renewalHistoryStr}
${ctx.internalNotes ? '\nInternal Notes: ' + ctx.internalNotes : ''}
${ctx.vendorNotes ? '\nVendor Notes: ' + ctx.vendorNotes : ''}
${negotiationLog ? '\nPrior Negotiation Activity:\n' + negotiationLog : ''}
${briefText ? '\nAI Renewal Brief (excerpt):\n' + briefText : ''}

Respond with ONLY the JSON object. No other text.`;

    let rawText;
    try {
      const result = await complete({
        system:     systemPrompt,
        user:       userPrompt,
        maxTokens:  800,
        cacheSystem: false,
        task:        'brief', // reuse brief provider config (prefers Anthropic Haiku)
      });
      rawText = result.text || '';
    } catch (aiErr) {
      console.error('[negotiate] AI provider error:', aiErr.message);
      if (userId) { void refundAiQuotaNeg(userId, 'negotiate'); }
      return res.status(502).json({ success: false, error: 'Negotiation analysis temporarily unavailable. Please try again in a moment.' });
    }

    // -- JSON extraction (3-pass) --------------------------------------------
    function extractJson(text) {
      if (!text) return null;
      const trimmed = text.trim();
      // Pass 1: direct parse
      try { return JSON.parse(trimmed); } catch {}
      // Pass 2: markdown code block
      const mdMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (mdMatch) { try { return JSON.parse(mdMatch[1].trim()); } catch {} }
      // Pass 3: first { ... } block
      const objMatch = trimmed.match(/\{[\s\S]*\}/);
      if (objMatch) { try { return JSON.parse(objMatch[0]); } catch {} }
      return null;
    }

    function validateRecs(obj) {
      if (!obj || typeof obj !== 'object') return false;
      if (!['high', 'medium', 'low'].includes(obj.priority)) return false;
      if (!Array.isArray(obj.leverage_points) || obj.leverage_points.length < 1) return false;
      if (!Array.isArray(obj.risk_flags) || obj.risk_flags.length < 1) return false;
      if (!Array.isArray(obj.suggested_tactics) || obj.suggested_tactics.length < 1) return false;
      if (!obj.suggested_tactics.every(t => t && typeof t.tactic === 'string')) return false;
      return true;
    }

    const recs = extractJson(rawText);

    if (!validateRecs(recs)) {
      console.warn(`[negotiate] contract=${contract.id} JSON extraction failed. rawText-start: ${rawText.slice(0, 200)}`);
      if (userId) { void refundAiQuotaNeg(userId, 'negotiate'); }
      return res.status(502).json({ success: false, error: 'Negotiation analysis could not be structured. Please try again.' });
    }

    // Normalize: clamp arrays to reasonable sizes to avoid token-stuffed responses
    recs.leverage_points  = recs.leverage_points.slice(0, 5).map(s => String(s).slice(0, 300));
    recs.risk_flags       = recs.risk_flags.slice(0, 4).map(s => String(s).slice(0, 300));
    recs.suggested_tactics = recs.suggested_tactics.slice(0, 5).map(t => ({
      tactic:    String(t.tactic || '').slice(0, 300),
      rationale: String(t.rationale || '').slice(0, 400),
    }));

    console.log(`[negotiate] contract=${contract.id} user=${userId} priority=${recs.priority} levers=${recs.leverage_points.length} flags=${recs.risk_flags.length} tactics=${recs.suggested_tactics.length}`);

    return res.json({
      success: true,
      data:    recs,
    });

  } catch (err) {
    console.error('[negotiate] unhandled error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to generate negotiation recommendations.' });
  }
});

// -- GET /api/contracts/:id/negotiation-analysis/status -------------------------------------
// Returns cache state so the UI can show "View Analysis" vs "Run Analysis".
// No AI call. Returns { cached, verdict, generatedAt, validUntil } or { cached: false }.
router.get('/:id/negotiation-analysis/status', requireManager, async (req, res) => {
  try {
    const contract = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
      include: {
        vendor: { select: { name: true, cotermComplexity: true, cotermNotes: true, notes: true } },
      },
    });
    if (!contract) return res.status(404).json({ success: false, error: 'Contract not found' });
    const status = await getNegotiationAnalysisStatus(contract.id, contract);
    return res.json({ success: true, data: status });
  } catch (err) {
    console.error('[negotiation-analysis/status] error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to get analysis status.' });
  }
});

// -- POST /api/contracts/:id/negotiation-analysis -------------------------------------------
// v0.79.0 — Full adversarial analysis engine (5 AI personas, deterministic verdict).
//
// Same guards as /negotiate: requireManager, aiIpLimiter, briefLimiter,
// aiBriefEnabled, ensureAiConsent, ensureAiBudget, aiQuota 'negotiation-analysis' action.
//
// Body: { forceRefresh?: boolean }  — forceRefresh bypasses result cache.
//
// Response:
//   {
//     advocate, analyst, assessor, vendor,  // raw persona JSON
//     verdictResult,                          // { verdict, score, tier, ... }
//     confidenceFlags,                        // string[]
//     synthesis,                              // SynthesisDirector board output
//     generatedAt,                            // ISO string
//     fromCache,                              // boolean
//   }
router.post('/:id/negotiation-analysis', requireManager, aiIpLimiter, briefLimiter, async (req, res) => {
  if (process.env.AI_ENABLED === 'false') {
    return res.status(403).json({ success: false, error: 'AI features are disabled on this instance' });
  }
  if (req.gpc) {
    return res.status(403).json({ success: false, error: 'AI features are disabled because your browser sent a Global Privacy Control (Sec-GPC: 1) signal.', code: 'GPC_AI_BLOCKED' });
  }

  const forceRefresh = req.body?.forceRefresh === true;

  try {
    const contract = await prisma.contract.findFirst({
      where: contractWhereForUser(req),
      include: {
        vendor: {
          select: {
            name: true, cotermComplexity: true, cotermNotes: true, notes: true,
            contacts: {
              where: { email: { not: null } },
              orderBy: [{ lastContactedAt: 'desc' }, { updatedAt: 'desc' }],
              take: 1,
              select: { name: true, email: true, title: true },
            },
          },
        },
        tags:           { select: { tag: true } },
        parentContract: { select: { product: true, startDate: true, endDate: true, costPerLicense: true, quantity: true } },
        renewals:       { select: { product: true, startDate: true, endDate: true, costPerLicense: true, quantity: true }, orderBy: { createdAt: 'asc' } },
        account:        { select: { aiBriefEnabled: true } },
      },
    });

    if (!contract) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    if (!contract.account?.aiBriefEnabled) {
      return res.status(403).json({
        success: false,
        error:   'ai_brief_disabled_for_account',
        message: 'AI features are disabled for this account. An admin can enable them in Settings > AI & Extraction.',
      });
    }

    if (!(await ensureAiConsent(req, res))) return;
    if (!ensureAiBudget(req, res)) return;

    // Skip quota check on cache hit (no AI call will be made)
    const { checkAndIncrement: checkAiQuota, refundIncrement: refundAiQuota } = require('../lib/aiQuota');
    const userId = req.user?.id;
    let quotaChecked = false;

    if (forceRefresh || !(await getNegotiationAnalysisStatus(contract.id, contract)).cached) {
      try {
        const quota = await checkAiQuota(userId, 'negotiation-analysis', req.user?.accountId, req.user?.role);
        if (!quota.ok) {
          return res.status(402).json({
            success: false,
            error:   'ai_daily_cap_reached',
            data:    { count: quota.count, cap: quota.cap, resetAt: quota.resetAt },
          });
        }
        quotaChecked = true;
      } catch (qErr) {
        console.error('[negotiation-analysis] quota check error (failing open):', qErr.message);
      }
    }

    let result;
    try {
      result = await runNegotiationAnalysis(contract, complete, req.aiSettings || {}, { forceRefresh });
    } catch (aiErr) {
      console.error('[negotiation-analysis] engine error:', aiErr.message);
      if (quotaChecked && userId) { void refundAiQuota(userId, 'negotiation-analysis'); }
      return res.status(502).json({ success: false, error: 'Analysis engine temporarily unavailable. Please try again in a moment.' });
    }

    console.log(`[negotiation-analysis] contract=${contract.id} user=${userId} verdict=${result.verdictResult?.verdict} tier=${result.verdictResult?.tier} fromCache=${result.fromCache}`);

    return res.json({ success: true, data: result });

  } catch (err) {
    console.error('[negotiation-analysis] unhandled error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to run negotiation analysis.' });
  }
});
module.exports = router;
module.exports.autoExpireContracts = autoExpireContracts;  // v0.68.0: exposed for the cron

export {};
