'use strict';

/**
 * scripts/seed-demo.js
 * --------------------
 * Demo data generator for LapseIQ. Two entry points:
 *
 *   node server/scripts/seed-demo.js              — one-shot seed (CLI)
 *   const { resetAndSeedDemo } = require(...);    — programmatic, used by the
 *                                                    nightly DEMO_MODE cron
 *
 * What it produces:
 *   - 1 demo Account (id pinned to DEMO_ACCOUNT_ID for idempotent reset)
 *   - 3 users: admin (Admin1234!), manager (Manager1234!), viewer (Viewer1234!),
 *              consultant (Consultant1234!)
 *   - 12 vendors spanning common SaaS categories
 *   - ~65 contracts: a mix of past-renewed, upcoming-soon (within 30 days),
 *     upcoming-mid (30–180 days), upcoming-far (>180 days), current-FY anchors,
 *     lapsed, auto-renewal traps, negotiated savings, and co-term misalignment
 *   - A handful of Documents and Communications attached to recent contracts
 *
 * Reset behaviour: when called via resetAndSeedDemo(), all rows linked to the
 * demo account are deleted via cascade by deleting the Account row (the schema
 * has onDelete: Cascade on most child tables). InstanceConfig is left alone.
 *
 * Idempotency: the demo account ID is constant. Re-running the seed deletes
 * the existing demo account first, then recreates it. Other tenant accounts
 * (real ones) are untouched.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
// 2026-05-10 v0.2.30 (role-tier walk H5 follow-up): seeded users skip the
// registration flow that writes the account_created row, so a fresh demo
// account showed an empty Activity Log until the first contract write. Emit
// the rows here so H5 is end-to-end demonstrable on every fresh demo.
const { writeLog: writeActivityLog } = require('../lib/activityLog');
// 2026-05-10 Phase 1 (non-SaaS categories): seed the 9 default categories
// for the demo account, then backfill the seeded contracts to the "saas"
// category. The contract populator currently creates SaaS contracts only;
// once the populator is taught about non-SaaS categories, backfill can be
// pushed to a per-contract assignment in _seedDemoData itself.
const { seedAndBackfill: seedCategoriesAndBackfill } = require('./seed-categories');
// 2026-05-13 v0.8.1: pre-baked AI renewal briefs for the NON_SAAS_SHOWCASE
// anchors. Generating live during demo costs ~30s per click; pre-seeding
// means the 4-section structured brief renders instantly. Sources panel
// populates the same way it would after a live Tavily-backed run.
const { briefFieldsForSpec } = require('./seed-demo-briefs');

const prisma = new PrismaClient();

// Pinned ID so the reset path can target this account precisely without
// scanning by name. UUID v4 in the dummy "demo-…" prefix is illegal per
// spec, so we use a real-looking v4 with a recognisable suffix.
const DEMO_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr)      { return arr[rand(0, arr.length - 1)]; }

// ── Vendor catalog ───────────────────────────────────────────────────────────
const VENDOR_SPECS = [
  { name: 'Microsoft',   coterm: 'complex',  type: 'SaaS',
    cotermNotes: 'Multi-product. Q3 anniversary. EA true-up annually.',
    intel: 'FY ends June 30; Q4 (Apr-Jun) is highest-leverage window. 33% M365 price increase staged for Jul 2026 -- cumulative 15-23% uplift risk. Negotiate multi-year terms with pre-July price lock, right-size via usage data, and threaten Azure competitive migration for real concessions. Reject auto-renewal defaults; cap future price increases in the current ELA. Start engagement 6+ months out.' },
  { name: 'Salesforce',  coterm: 'moderate', type: 'SaaS',
    cotermNotes: 'Q1 renewal. 7% YoY uplift clause.',
    intel: 'FY ends Jan 31; quarter-ends (Apr 30, Jul 31, Oct 31, Jan 31) are peak negotiation windows. Standard renewal uplift 7-10% annually; target 0% on first renewal using HubSpot or Microsoft Dynamics as competitive pressure. Push for 3-year fixed-price terms. Reject then-current list price language -- it resets all negotiated discounts at renewal. 60-day opt-out window for auto-renewal; missing it locks another year.' },
  { name: 'CrowdStrike', coterm: 'none',     type: 'SaaS',
    cotermNotes: 'Per-endpoint. Includes MDR/IR retainer. Multi-year discount available.',
    intel: 'FY ends Jan 31; quarter-ends are quota pressure points. Negotiated discount range 10-20% off list. SentinelOne quotes drive 35-50% cost reduction threat -- get one before every renewal. Volume breakpoints at 500, 1000, and 2500 endpoints unlock better pricing. Multi-year prepay adds additional savings. Annual prepayment often required for discounted pricing.' },
  { name: 'AWS',         coterm: 'complex',  type: 'Cloud / Hosting',
    cotermNotes: 'EDP commit + on-demand. Renegotiate annually.',
    intel: 'EDP discount tiers: 5-8% at $500K-$2M annual commit; 8-12% at $2M-$5M; 12-18% at $5M-$10M. Annual commits cannot decrease YoY under standard terms -- negotiate ratchet-down provisions upfront. FY ends Jan 31; Q4 (Nov-Jan) is most urgent. Overcommitment triggers shortfall penalties at full list rate. Azure and GCP competitive proposals are the strongest levers.' },
  { name: 'GitHub',      coterm: 'none',     type: 'SaaS',
    cotermNotes: 'Per-seat Enterprise. 30-day cancel notice.',
    intel: 'FY ends Jun 30; Q3 (Jan-Mar) is the best negotiation window under Microsoft ownership. Bundled in M365 E5 licenses -- model whether consolidation makes sense. Copilot Business adds ~25% to per-seat cost; negotiate as a bundle. 30-day cancel notice on annual plans.' },
  { name: 'Zoom',        coterm: 'none',     type: 'Telecom',
    cotermNotes: 'UCaaS. Per-seat annual commit; auto-renew unless cancelled 30 days out.',
    intel: 'FY ends Jan 31; Q4 (Nov-Jan) is peak discount window. Reps authorized to offer 10-15% incremental concessions plus free months for Q4 close. Slowing growth (3-7% YoY since 2023) makes reps flexible. Microsoft Teams overlap (bundled in M365 E3/E5) is a credible displacement threat. 30-day written notice required to non-renew.' },
  { name: 'Slack',       coterm: 'moderate', type: 'SaaS',
    cotermNotes: 'Acquired by Salesforce; coterm with SF AE for combined discount.',
    intel: 'Acquired by Salesforce (2021) -- negotiate jointly with SF AE for combined discount. FY ends Jan 31; same quarter-end pressure as Salesforce. Salesforce bundling at contract review can add 10-20% vs. standalone; demand line-item pricing. Enterprise Grid pricing is seat-tiered; audit active users before renewal.' },
  { name: 'Atlassian',   coterm: 'moderate', type: 'SaaS',
    cotermNotes: 'Cloud + DC. Tier-based pricing.',
    intel: 'FY ends Jul 31; tier-based cloud pricing post-Server migration. Jira and Confluence can be co-termed on anniversary date for a unified negotiation. Premium tier adds advanced roadmaps and admin insights. Cloud migration incentive period has ended; negotiate on volume and multi-year terms. Standard 30-day cancel notice on annual plans.' },
  { name: 'Datadog',     coterm: 'complex',  type: 'SaaS',
    cotermNotes: 'Per-host + per-feature. Negotiate commit tiers.',
    intel: 'Per-host plus per-feature pricing creates billing complexity; audit active hosts and disabled features before renewal. Commit tier pricing unlocks 20-35% savings vs. on-demand. Container and serverless pricing changes frequently -- lock rates in the MSA. Dynatrace and New Relic are credible competitive alternatives. Year-end (Dec) is best negotiation window.' },
  { name: 'Notion',      coterm: 'none',     type: 'SaaS',
    cotermNotes: 'Per-seat. Education tier negotiable.',
    intel: 'FY ends Jan 31; most leverage at initial Enterprise deal. Per-seat Business vs. Enterprise negotiated flat pricing. AI add-on often negotiated into Enterprise deals at discount. Audit active users before renewal -- Notion seat counts can creep. 30-day cancel notice; no strong multi-year discount incentive on small teams.' },
  { name: 'Cloudflare',  coterm: 'none',     type: 'Cloud / Hosting',
    cotermNotes: 'Enterprise plan + add-ons.',
    intel: 'FY ends Dec 31; Q4 (Oct-Dec) best window. Enterprise plan pricing is negotiated; list price rarely applies at scale. Zero Trust bundle (ZTNA plus SWG plus CASB plus DLP) offers 30-40% vs. point products. DDoS, CDN, and Workers usage tracked separately -- negotiate unified commit with overage protection. 30-day notice for annual plan non-renewal.' },
  { name: 'Okta',        coterm: 'moderate', type: 'SaaS',
    cotermNotes: 'SSO + MFA + Lifecycle. Per-user feature bundles.',
    intel: 'FY ends Jan 31; Nov-Jan window is highest-leverage. Average negotiated savings 14% off list; multi-year unlocks 15-30%. Audit inactive users before renewal -- typically reclaims 8-15% of seats. Microsoft Entra ID (included in M365 E3/E5) is a credible displacement threat driving 20-30% reductions. Customer Identity Cloud uses MAU-based pricing with overage billing -- negotiate MAU bands with rollover provisions.' },
  { name: 'IBM',              coterm: 'complex',  type: 'SaaS',
    cotermNotes: 'Multiple product lines (Watsonx, Cognos, S&S). ELA consolidates fragmented contracts. ILMT sub-capacity non-compliance triggers full-physical-capacity billing.',
    intel: 'FY ends Dec 31; Q4 (Oct-Dec) is peak quota pressure -- best window for concessions. Standard 10-20% off list; 25-40% on 3-5yr ELAs. IBM often drops initial discounts at renewal (the price rollback trap) -- contractualize price holds at year 1 signing. S&S auto-renews by default with no opt-out reminder. LMS audit risk escalates when procurement challenges renewal terms aggressively. Engage SAM tooling and external IBM licensing counsel before any audit notice arrives.' },
  { name: 'Oracle',           coterm: 'complex',  type: 'SaaS',
    cotermNotes: 'Database (UCE/NUP) and application licenses on separate schedules. 4% annual support escalator embedded contractually. 90+ day written notice required to cancel.',
    intel: 'FY ends May 31; Q4 (Mar-May) strongest window -- engage 6-12 months out, never wait for Oracle first offer. Standard 4% support increase embedded contractually; 2026 list price increases 12-18% on database and application licenses. LMS audit notices follow renewal pushback within 60-90 days. Third-party support (Rimini Street, Support Revolution) at 50% cost are the strongest leverage points. Auto-renewal defaults to invoice at increased price without new signature.' },
  { name: 'VMware / Broadcom', coterm: 'complex', type: 'SaaS',
    cotermNotes: 'Post-Broadcom (Nov 2023): subscription-only, minimum 72 cores/product. All SKUs consolidated into VCF or VVF bundles. 20% late-renewal surcharge if anniversary date is missed.',
    intel: 'Post-Broadcom acquisition (Nov 2023): perpetual licensing eliminated, ~8,000 SKUs consolidated into VCF and VVF bundles. Price increases 150-1,500% vs. prior rates. Minimum 72 cores per product line enforced; 20% late-renewal surcharge if anniversary date is missed -- set calendar alerts 120 days out. Nutanix AHV migration promo (valid through Jul 2026) is the most credible displacement threat. Smaller customers have almost no reseller channel leverage post-acquisition.' },
  { name: 'Arctic Wolf',      coterm: 'none',     type: 'SaaS',
    cotermNotes: 'Asset-based pricing; all services (MDR, Managed Risk, SAT) on same annual anniversary. 60-day non-renewal notice required -- double the industry standard.',
    intel: 'Asset-based pricing per endpoint per month; 1,000+ endpoint deployments negotiate best rates. 60-day non-renewal notice window (vs. industry-standard 30 days) -- calendar alert is critical. Physical sensor hardware billed separately from subscription and often missed in TCO. Bundle MDR + Managed Risk + Security Awareness Training for 15-30% discount. CrowdStrike Falcon Complete and Huntress are credible competitive alternatives.' },
  { name: 'Palo Alto Networks', coterm: 'moderate', type: 'SaaS',
    cotermNotes: 'NGFW, Prisma Cloud, and Cortex XDR on separate SKUs. Platformization bundle simplifies but deepens lock-in. 30-day cancellation window on annual subscriptions.',
    intel: 'FY ends Jul 31; June-July is the peak discount window. 3-year terms save ~32% vs. annual -- multi-year is the single strongest lever. Platformization push (NGFW + Prisma Cloud + Cortex XDR bundle) creates deep lock-in at renewal; model per-product cost before accepting bundle pricing. Enterprise buyers with competitive pressure (CrowdStrike, Fortinet, Check Point) can reach 35-50% off quote. Support contracts escalate 8-12% annually if uplift not capped.' },
  { name: 'Splunk',           coterm: 'moderate', type: 'SaaS',
    cotermNotes: 'GB/day ingest-based pricing. 9% annual uplift is published policy. Cisco acquisition (Mar 2024) -- upsell to adjacent Cisco products expected at every renewal.',
    intel: 'Published 9% annual price increase on all licenses -- documented policy, not a negotiating tactic. Under Cisco ownership (acquired Mar 2024), upsell to Observability, ITSI, and adjacent Cisco products is baked into every renewal. FY aligns with Cisco Jul 31; Oct/Jan/Apr/Jul quarter-ends are best windows. Engage 90-120 days out with Microsoft Sentinel or Elastic Security alternatives to achieve 20-35% reduction vs. the 9% path. Lock in GB/day ingest rates before Cisco transitions to outcome-based billing.' },
];
const PRODUCTS_BY_VENDOR = {
  Microsoft:   ['M365 E3', 'M365 E5', 'Azure EA Commit', 'Power BI Pro'],
  Salesforce:  ['Sales Cloud Enterprise', 'Service Cloud Unlimited', 'Slack Business+'],
  CrowdStrike: ['Falcon Pro', 'Falcon Enterprise'],
  AWS:         ['EDP Commit', 'Reserved Instances'],
  GitHub:      ['Enterprise Cloud', 'Copilot Business'],
  Zoom:        ['Zoom One Business', 'Zoom Phone Pro'],
  Slack:       ['Business+', 'Enterprise Grid'],
  Atlassian:   ['Jira Premium', 'Confluence Premium', 'Compass Standard'],
  Datadog:     ['APM', 'Logs', 'Synthetics', 'RUM'],
  Notion:      ['Business', 'Enterprise'],
  Cloudflare:  ['Enterprise', 'Workers Paid'],
  Okta:        ['SSO', 'MFA', 'Lifecycle Management'],
  IBM:              ['Watsonx AI Studio', 'IBM Cognos Analytics', 'IBM Security QRadar SIEM', 'IBM MaaS360 UEM', 'IBM Cloud Pak for Data'],
  Oracle:           ['Oracle Database EE', 'Oracle E-Business Suite', 'Oracle Analytics Cloud', 'Oracle Cloud Infrastructure', 'Oracle APEX'],
  'VMware / Broadcom': ['VMware Cloud Foundation (VCF)', 'vSphere Enterprise Plus', 'VMware NSX Data Center', 'VMware vSAN Enterprise'],
  'Arctic Wolf':    ['Arctic Wolf MDR', 'Arctic Wolf Managed Risk', 'Arctic Wolf Security Awareness Training', 'Incident Response Retainer'],
  'Palo Alto Networks': ['Prisma Access (SASE)', 'Cortex XDR Pro', 'NGFW PA-Series', 'Prisma Cloud CSPM', 'Cortex XSOAR'],
  Splunk:           ['Splunk Enterprise Security', 'Splunk ITSI', 'Splunk Observability Cloud', 'Splunk SOAR', 'Splunk Edge Processor'],
};

const DEPARTMENTS = ['Engineering', 'Sales', 'Marketing', 'IT', 'Finance', 'HR', 'Customer Success'];

// ── Reset ────────────────────────────────────────────────────────────────────
async function _resetDemoAccount() {
  // Most child→Account FKs default to RESTRICT in the LapseIQ schema, so we
  // can't just delete the Account and rely on cascade. Delete children
  // explicitly in dependency order. Each deleteMany is a no-op when nothing
  // exists, so this is safe on first run.
  //
  // v0.7.3 sandbox-isolation audit: expanded to cover every account-scoped
  // table identified across 31 Prisma models. Kept in sync with
  // lib/demoPrune.js::pruneAccount() — if you add a new owned model, update
  // both. Audit notes: docs/sessions/2026-05-13/sandbox-isolation-audit.md.
  const filter = { accountId: DEMO_ACCOUNT_ID };

  // ── Activity / audit (nullable contractId rows don't cascade) ───────────
  await prisma.activityLog.deleteMany({
    where: {
      OR: [
        { contract: { accountId: DEMO_ACCOUNT_ID } },
        { user: { accountId: DEMO_ACCOUNT_ID } },
      ],
    },
  }).catch(() => {});

  // ── User-scoped leaves ──────────────────────────────────────────────────
  await prisma.refreshToken.deleteMany({ where: { user: { accountId: DEMO_ACCOUNT_ID } } });
  await prisma.aiUsage.deleteMany({ where: { user: { accountId: DEMO_ACCOUNT_ID } } }).catch(() => {});
  await prisma.alertPreference.deleteMany({ where: { user: { accountId: DEMO_ACCOUNT_ID } } }).catch(() => {});
  await prisma.userNewsWatch.deleteMany({ where: { user: { accountId: DEMO_ACCOUNT_ID } } }).catch(() => {});
  await prisma.userNewsRead.deleteMany({ where: { user: { accountId: DEMO_ACCOUNT_ID } } }).catch(() => {});

  // ── Contract-scoped leaves ──────────────────────────────────────────────
  await prisma.customFieldValue.deleteMany({ where: { contract: { accountId: DEMO_ACCOUNT_ID } } }).catch(() => {});
  await prisma.paymentInstallment.deleteMany({ where: { paymentSchedule: { contract: { accountId: DEMO_ACCOUNT_ID } } } }).catch(() => {});
  await prisma.paymentSchedule.deleteMany({ where: { contract: { accountId: DEMO_ACCOUNT_ID } } }).catch(() => {});
  await prisma.contractFlag.deleteMany({ where: { contract: { accountId: DEMO_ACCOUNT_ID } } }).catch(() => {});
  await prisma.contractTag.deleteMany({ where: { contract: { accountId: DEMO_ACCOUNT_ID } } }).catch(() => {});

  // ── Vendor-scoped leaves ────────────────────────────────────────────────
  await prisma.vendorContact.deleteMany({ where: { vendor: { accountId: DEMO_ACCOUNT_ID } } }).catch(() => {});

  // ── Account-scoped lookups (some cascade; redundant explicit ok) ────────
  await prisma.customFieldDefinition.deleteMany({ where: filter }).catch(() => {});
  await prisma.templateFeedback.deleteMany({ where: filter }).catch(() => {});
  await prisma.category.deleteMany({ where: filter }).catch(() => {});

  // ── Original account-scoped rows ────────────────────────────────────────
  await prisma.alert.deleteMany({ where: filter }).catch(() => {});
  await prisma.communication.deleteMany({ where: filter }).catch(() => {});
  await prisma.document.deleteMany({ where: filter }).catch(() => {});
  await prisma.ingestionSession.deleteMany({ where: filter }).catch(() => {});
  await prisma.contract.deleteMany({ where: filter });
  await prisma.consultantAccess.deleteMany({ where: filter }).catch(() => {});
  await prisma.userInvite.deleteMany({ where: filter }).catch(() => {});
  await prisma.vendorNews.deleteMany({ where: filter }).catch(() => {});
  await prisma.accountSetting.deleteMany({ where: filter }).catch(() => {});
  await prisma.cloudConnector.deleteMany({ where: filter }).catch(() => {});
  await prisma.backupLog.deleteMany({ where: filter }).catch(() => {});
  await prisma.vendor.deleteMany({ where: filter });
  await prisma.user.deleteMany({ where: filter });
  try {
    await prisma.account.delete({ where: { id: DEMO_ACCOUNT_ID } });
  } catch (err) {
    if (err.code !== 'P2025') throw err; // P2025 = "record not found"
  }
}

// ── Vendors + contracts populator ────────────────────────────────────────────
// L3: extracted from the legacy 4-user seed so per-visitor demo registrations
// can populate a fresh account with the same vendor/contract data set, scoped
// to whatever user(s) the caller designates as internalOwner.
//
// `accountId` is the target account; `ownerUserIds` is a non-empty array of
// User ids in that account that may be assigned as internalOwner on contracts
// (each contract picks one at random). Returns { vendors: N, contracts: N }.
async function _seedDemoData(accountId, ownerUserIds, prismaClient = prisma) {
  if (!Array.isArray(ownerUserIds) || ownerUserIds.length === 0) {
    throw new Error('_seedDemoData: ownerUserIds must be a non-empty array');
  }

  // ── Vendors ──────────────────────────────────────────────────────────────
  const vendors = [];
  for (const spec of VENDOR_SPECS) {
    const v = await prismaClient.vendor.create({
      data: {
        accountId,
        name: spec.name,
        vendorType: spec.type || null,
        cotermComplexity: spec.coterm,
        cotermNotes: spec.cotermNotes || null,
        notes: spec.intel || null,
      },
    });
    vendors.push(v);
  }

  // ── Contracts ────────────────────────────────────────────────────────────
  // Spread over four time windows so the dashboard "upcoming renewals" view
  // has visible content without being all-red.
  const today = new Date();
  const buckets = [
    { count: 5,  endOffsetMin: -180, endOffsetMax:  -30, status: 'renewed', label: 'past-renewed'  },
    { count: 6,  endOffsetMin:    1, endOffsetMax:   30, status: 'active',  label: 'upcoming-soon' },
    { count: 9,  endOffsetMin:   31, endOffsetMax:  180, status: 'active',  label: 'upcoming-mid'  },
    { count: 8,  endOffsetMin:  181, endOffsetMax:  720, status: 'active',  label: 'upcoming-far'  },
    { count: 2,  endOffsetMin: -365, endOffsetMax: -181, status: 'expired', label: 'expired'        },
    // Current-FY anchors: startDate = endDate-365 spans Jan–Dec 2026 (full FY2026)
    // so the Executive Spend / Spend Ledger YoY comparison has data on both sides.
    // endOffset 232–596 → endDate Jan 2027–Dec 2027 → startDate Jan 2026–Dec 2026.
    // Increased from 6→22 to close the FY2026 vs FY2025 spend gap (v0.14.0).
    { count: 22, endOffsetMin:  232, endOffsetMax:  596, status: 'active',  label: 'current-fy'    },
    // Auto-renewal traps: active contracts whose cancelByDate already passed — they appear
    // in the Risk Radar "Trap" bucket so that section isn't empty on the demo.
    { count: 7,  endOffsetMin:   50, endOffsetMax:  130, status: 'active',  label: 'trap'           },
  ];

  // v0.4.2 round-3 (#seed-vary): notes were previously identical
  // boilerplate within each bucket ("[Demo] upcoming-soon — generated
  // 2026-05-11" × N). Now pulls from a pool of realistic procurement
  // notes per bucket so the contracts list reads as varied, plausible
  // commentary rather than templated demo filler.
  const NOTE_POOL = {
    'past-renewed': [
      'Renewed last cycle at +6% uplift. Pushed back via competitive-bid email; vendor came back with 3% instead. Document for next year.',
      'Last renewal we missed the 30-day notice window — auto-renewed at the higher rate. Setting an earlier alert this round.',
      'Multi-year commit signed last time for an 8% discount. End of co-term in late 2026; revisit consolidation then.',
      'Migrated from monthly to annual billing at last renewal — saved ~12% on list. Document for finance.',
      'Renewed despite low usage signal — promised an internal usage review next quarter. Owner: department head.',
    ],
    'upcoming-soon': [
      'Quote requested from reseller 2 weeks ago — waiting on response. Escalated to account manager today.',
      'Active negotiation. Vendor opened with 9% increase; countered with flat. Decision needed before next paycheck cycle.',
      'Auto-renewal date approaching — need explicit yes/no from finance before cutoff to avoid silent rollover.',
      'Replaced by another tool but contract still has months left. Confirming we don\'t owe a termination fee.',
      'Headcount dropped 15% — re-pricing for actual seats. Vendor aware; verbal commit to drop the unused tier.',
      'Open question: do we co-term with the larger MSA expiring in Q4? Asked the rep last week.',
    ],
    'upcoming-mid': [
      'Vendor announced a new tier; our current SKU may be EOL at renewal. Need clarity from the rep on migration path.',
      'Co-terming with the broader MSA. Treat as one renewal event rather than negotiating in isolation.',
      'Usage trending down 20% YoY — strong case for a 15% reduction at renewal. Pulling utilization report.',
      'Vendor PE-acquired last quarter; pricing posture has hardened across the customer base per industry chatter.',
      'Reseller margin negotiable up to 4% per our procurement contact at the partner — leverage at renewal.',
      'Watch for new mandatory-SKU bundling at renewal (typical post-acquisition pattern).',
      'Internal champion left the company; reassess actual fit before committing to another full term.',
      'Considering a competitive RFP this cycle — three alternatives shortlisted, evaluation kickoff TBD.',
      'Tier downgrade on the table once we confirm we don\'t need the enterprise-only feature flags.',
    ],
    'upcoming-far': [
      'No immediate action — flagged for early Q3 review so we don\'t lose the multi-year-rate-cap option.',
      'Multi-year deal still has 14+ months left. Reviewed once for compliance with the new data-residency policy; cleared.',
      'Watching usage telemetry — if we trend below 70% by mid-year, drop a tier rather than renewing flat.',
      'New product launch from this vendor announced. May change the renewal posture; track quarterly updates.',
      'Coterming target — align with the master agreement expiring 2027.',
      'Awaiting a budget reorg before deciding whether to expand or hold this footprint flat.',
      'Vendor competitor entered the market with aggressive intro pricing. Track and revisit at the 6-month mark.',
      'No issues; auto-pilot until 90 days out from renewal.',
    ],
    'expired': [
      'Lapsed. Procurement was mid-evaluation and the timeline slipped past the term-end. Reactivation quote pending.',
      'Allowed to expire intentionally — replaced by an in-house solution. Keeping the record for cost-comparison reporting.',
    ],
    'current-fy': [
      'New contract signed Q1 this year. Favorable pricing locked in before the announced list-price increase.',
      'Expanded footprint after a successful POC. Billing went live January 1 — first full fiscal-year term.',
      'Migrated from legacy vendor. Volume discount activated at the tier we\'re landing in year one.',
      'Renewed early at flat pricing to get ahead of the rumored mid-year uplift. Term starts this FY.',
      'New platform adoption — procurement closed in February; current annual term.',
      'Expanded add-on modules signed Q1. Rolled into the master agreement at a negotiated bundle rate.',
      'Budget allocated in the annual planning cycle — signed in Q1 after a competitive RFP.',
      'Consolidated two separate SKUs into one enterprise tier at renewal. Net cost down 12%.',
      'Co-term aligned with our fiscal year start by negotiating a short bridge period at no charge.',
      'Seat expansion signed early in the year to capture volume-tier pricing before headcount grew.',
      'New tool replacing a deprecated in-house solution. Procurement signed at FY start.',
      'Signed in Q2 after a successful pilot in Q4 prior year. Includes a 3-year price-lock option.',
    ],
    'trap': [
      'Auto-renewal window already passed — missed the 60-day cancellation deadline. Working with vendor on an amendment. ~$47k committed for another year we didn\'t plan for.',
      'Silently renewed last month before the internal review was complete. Stuck for another year unless we negotiate out. Opened a mutual termination discussion with the AE.',
      'Cancel-by date slipped through without a calendar alert. Escalated to procurement to explore early-termination options. Vendor quoting 3-month penalty to exit early.',
      'Renewed automatically at a 9% uplift per the MSA escalation clause. No one caught the 90-day window. Finance flagged the invoice; now locked in at the higher rate for 12 months.',
      'The opt-out window was 45 days prior to term end — we submitted cancellation on day 42. Vendor rejected it as late by their clock. Escalated to legal.',
      'Evergreen clause triggered: contract had no fixed end date, just an annual billing cycle. Missed the 30-day rolling notice window. Vendor refused to prorate.',
      'Missed the 60-day cancel notice by 8 days. Vendor offered to prorate a 6-month exit for 40% of the remaining TCV. Finance reviewing whether the settlement beats riding it out.',
    ],
  };

  // PO counter — incremented across all contracts so PO numbers are unique.
  let poCounter = 0;

  // How many POs to create per contract. upcoming-soon/mid get a richer mix
  // to showcase the multi-PO feature; other buckets mostly get 1.
  function poCountForBucket(label) {
    const r = Math.random();
    if (label === 'upcoming-soon' || label === 'upcoming-mid') {
      if (r < 0.15) return rand(4, 5);  // 15% get 4–5 POs (multi-PO showcase)
      if (r < 0.45) return rand(2, 3);  // 30% get 2–3 POs
      return 1;
    }
    return r < 0.25 ? 2 : 1;
  }

  let contractsCreated = 0;
  for (const bucket of buckets) {
    for (let i = 0; i < bucket.count; i++) {
      const vendor   = pick(vendors);
      const product  = pick(PRODUCTS_BY_VENDOR[vendor.name] || ['Standard']);
      const endDate  = addDays(today, rand(bucket.endOffsetMin, bucket.endOffsetMax));
      const startDate = addDays(endDate, -365);
      const qty       = rand(5, 250);
      const cost      = (rand(1500, 25000) / 100).toFixed(2);

      // Pre-compute fields that other fields depend on so they can be
      // referenced in multiple places without repeating the random call.
      const autoRenewal   = bucket.label === 'trap' ? true : Math.random() < 0.4;
      // autoRenewalNoticeDays: how many days' notice the vendor requires to cancel.
      // trap -> 60 days so the Risk Radar 'missed by X days' figure is meaningful.
      // normal auto-renewal -> random from common contract notice periods.
      const autoRenewalNoticeDays = autoRenewal
        ? (bucket.label === 'trap' ? 60 : pick([30, 45, 60, 90]))
        : null;
      // cancelByDate: only set on auto-renewal contracts.
      // trap bucket -> date already in the past (missed the window).
      // normal auto-renewal -> noticeDays before end.
      const cancelByDate  = autoRenewal
        ? (bucket.label === 'trap'
            ? addDays(today, -rand(5, 25))
            : addDays(endDate, -autoRenewalNoticeDays))
        : null;
      // Seat utilization for active contracts (~45% probability).
      // License Wastage report needs seatsLicensed + seatsActivelyInUse.
      const addSeats         = bucket.status === 'active' && Math.random() < 0.45;
      const seatsLicensed    = addSeats ? qty : null;
      const seatsActivelyInUse = addSeats
        ? Math.floor(qty * (0.50 + Math.random() * 0.35))  // 50–85% utilisation
        : null;

      const contract = await prismaClient.contract.create({
        data: {
          accountId,
          vendorId:            vendor.id,
          contractNumber:      `DEMO-${1000 + contractsCreated}`,
          product,
          quantity:            qty,
          costPerLicense:      cost,
          // (A3 5/02) denormalized total value, demo data should sort correctly
          totalValue:          qty * parseFloat(cost),
          startDate,
          endDate,
          evaluationStartByDate:    addDays(endDate, -45),
          autoRenewal,
          autoRenewalNoticeDays,
          cancelByDate,
          seatsLicensed,
          seatsActivelyInUse,
          department:          pick(DEPARTMENTS),
          internalOwnerId:     pick(ownerUserIds),
          status:              bucket.status,
          notes:               pick(NOTE_POOL[bucket.label] || ['[Demo] No notes recorded.']),
        },
      });
      contractsCreated++;

      // ── PO seed ────────────────────────────────────────────────────────────
      // Create 1–5 POs per contract so the multi-PO feature is demonstrated
      // on every fresh demo. First PO covers the bulk of the contract value;
      // subsequent POs are add-on seats / supplemental orders.
      const nPOs = poCountForBucket(bucket.label);
      const unitCost = parseFloat(cost);
      for (let p = 0; p < nPOs; p++) {
        poCounter++;
        const poYear    = p === 0 ? 2024 : 2025;
        const poQty     = p === 0 ? qty : rand(1, Math.max(1, Math.floor(qty * 0.25)));
        const poAmount  = (poQty * unitCost).toFixed(2);
        const orderDate = addDays(startDate, p === 0 ? rand(0, 14) : rand(30, 180));
        await prismaClient.purchaseOrder.create({
          data: {
            contractId:         contract.id,
            poNumber:           `PO-${poYear}-${String(poCounter).padStart(4, '0')}`,
            description:        p === 0
              ? `${product} — initial order`
              : `${product} — add-on seats`,
            amount:             poAmount,
            quantity:           poQty,
            orderDate,
            coverageStartDate:  startDate,
            coverageEndDate:    endDate,
          },
        });
      }
    }
  }

  // ── Archived contracts (per-visitor demo) ────────────────────────────
  // Without these, /contracts/archived is empty for every fresh tenant
  // and the wizard "Archive" sidebar item looks broken. Three archived
  // rows with cancelled status give the section credible content for
  // demo + tour purposes. Notes call out a believable consolidation /
  // upgrade reason so prospects see the archive's actual use case.
  // (Added 2026-05-08 in response to "no seed data in the archive".)
  // 2026-05-10 review H6 fix: pin each archived spec to its real-world
  // vendor instead of picking randomly. Random-pick produced nonsense rows
  // like "Okta — AWS Reserved Instances" and "Cloudflare — Slack Pro" which
  // undermines demo credibility. `vendorName` is the exact spec.name from
  // VENDOR_SPECS below.
  const archivedSpecs = [
    {
      product: 'Slack Pro (consolidated into Teams)',
      vendorName: 'Slack',
      contractNumberSuffix: 'SLACK',
      qty: 220, cost: 8.75, daysAgoEnd: 60, daysAgoArchived: 50,
      notes: '[Demo] Consolidated into Microsoft Teams (E5 already includes Teams Premium). Net savings ~$23k/yr. Kept archived for headcount-vs-spend reporting.',
    },
    {
      product: 'Zoom Pro (predecessor)',
      vendorName: 'Zoom',
      contractNumberSuffix: 'ZOOM',
      qty: 75, cost: 14.99, daysAgoEnd: 45, daysAgoArchived: 30,
      notes: '[Demo] Upgraded to Zoom Business+ for whiteboarding and breakout rooms. Predecessor archived so the renewal chain stays linked for cost-trend reporting.',
    },
    {
      product: 'AWS Reserved Instances 3yr (rolled into EDP)',
      vendorName: 'AWS',
      contractNumberSuffix: 'AWSRI',
      qty: 1, cost: 0, totalValueOverride: 138400,
      daysAgoEnd: 200, daysAgoArchived: 180,
      notes: '[Demo] Rolled into the AWS EDP commitment. Better discount tier and Savings Plans flexibility. Kept for FinOps cost-comparison reporting.',
    },
  ];

  let archivedCreated = 0;
  for (const a of archivedSpecs) {
    // Prefer the pinned vendorName; fall back to a random pick only if the
    // vendor isn't found (defence against a renamed VENDOR_SPECS entry).
    const vendor = (a.vendorName && vendors.find(v => v.name === a.vendorName)) || pick(vendors);
    const endDate  = addDays(today, -a.daysAgoEnd);
    const startDate = addDays(endDate, -365);
    const totalValue = a.totalValueOverride ?? (a.qty * a.cost);
    await prismaClient.contract.create({
      data: {
        accountId,
        vendorId:        vendor.id,
        contractNumber:  `DEMO-ARCH-${a.contractNumberSuffix}`,
        product:         a.product,
        quantity:        a.qty,
        costPerLicense:  a.cost.toFixed ? a.cost.toFixed(2) : String(a.cost),
        totalValue,
        startDate,
        endDate,
        autoRenewal:     false,
        department:      pick(DEPARTMENTS),
        internalOwnerId: pick(ownerUserIds),
        status:          'cancelled',
        archivedAt:      addDays(today, -a.daysAgoArchived),
        archivedById:    ownerUserIds[0],
        notes:           a.notes,
      },
    });
    archivedCreated++;
  }

  // ── Vendor News ───────────────────────────────────────────────────────────
  // Realistic demo articles so the News tab isn't blank on first login.
  // One-to-two items per major vendor, spread over the past 30 days.
  const vendorMap = Object.fromEntries(vendors.map(v => [v.name, v]));
  // News seeding removed at v0.89.3 - real RSS scanner now populates vendor_news.
  // See server/lib/newsScanner.js + NEWS_SCANNER_ENABLED in .env.
  // vendorMap above is preserved for NEGOTIATION_SHOWCASE and other contract specials below.

  // ── Negotiation Showcase (Savings Ledger) ────────────────────────────────
  // These contracts have qty=1 so both originalAsk and finalNegotiatedPrice
  // are total-contract values, which satisfies both the savings-ledger formula
  // (ask - negotiated = savings) and the contractSpend helper (1 × price = total).
  // startMonthsAgo is spread across FY2025 and FY2026 for the YoY exec-spend view.
  const NEGOTIATION_SHOWCASE = [
    // ── FY2025 anchors (startMonthsAgo 5–8 → startDate Sep–Dec 2025) ──────────
    { vendorName: 'Salesforce',  product: 'Sales Cloud Enterprise (negotiated)',      dept: 'Sales',            originalAsk: 285000, finalPrice: 228000, startMonthsAgo: 8 },
    { vendorName: 'Datadog',     product: 'APM Enterprise (negotiated)',               dept: 'Engineering',      originalAsk: 144000, finalPrice: 108000, startMonthsAgo: 6 },
    { vendorName: 'Okta',        product: 'SSO + Lifecycle Bundle (negotiated)',       dept: 'IT',               originalAsk:  72000, finalPrice:  61000, startMonthsAgo: 5 },
    // ── FY2026 anchors (startMonthsAgo 1–4 → startDate Jan–Apr 2026) ──────────
    { vendorName: 'Microsoft',   product: 'Azure EA Commit (negotiated)',              dept: 'Engineering',      originalAsk: 520000, finalPrice: 416000, startMonthsAgo: 3 },
    { vendorName: 'CrowdStrike', product: 'Falcon Enterprise (negotiated)',            dept: 'IT',               originalAsk:  96000, finalPrice:  76800, startMonthsAgo: 4 },
    { vendorName: 'GitHub',      product: 'Copilot Business Enterprise (negotiated)',  dept: 'Engineering',      originalAsk:  54000, finalPrice:  45900, startMonthsAgo: 2 },
    // v0.14.0: additional FY2026 high-value contracts to balance YoY comparison
    { vendorName: 'AWS',         product: 'EDP Commit (renegotiated)',                 dept: 'Engineering',      originalAsk: 920000, finalPrice: 736000, startMonthsAgo: 1 },
    { vendorName: 'Microsoft',   product: 'M365 E5 Expansion (negotiated)',            dept: 'IT',               originalAsk: 340000, finalPrice: 272000, startMonthsAgo: 1 },
    { vendorName: 'Salesforce',  product: 'Service Cloud Unlimited (negotiated)',      dept: 'Customer Success', originalAsk: 195000, finalPrice: 156000, startMonthsAgo: 2 },
    { vendorName: 'Datadog',     product: 'Logs + RUM Bundle (negotiated)',            dept: 'Engineering',      originalAsk: 168000, finalPrice: 134400, startMonthsAgo: 3 },
    { vendorName: 'Atlassian',   product: 'Jira + Confluence Premium (negotiated)',    dept: 'Engineering',      originalAsk:  98000, finalPrice:  78400, startMonthsAgo: 3 },
    { vendorName: 'Slack',       product: 'Enterprise Grid (negotiated)',              dept: 'Sales',            originalAsk:  88000, finalPrice:  70400, startMonthsAgo: 4 },
    { vendorName: 'Zoom',        product: 'Zoom One Business (negotiated)',            dept: 'Sales',            originalAsk:  62000, finalPrice:  49600, startMonthsAgo: 2 },
    { vendorName: 'Cloudflare',  product: 'Enterprise Plan (negotiated)',              dept: 'Engineering',      originalAsk:  76000, finalPrice:  60800, startMonthsAgo: 2 },
  ];
  let negotiationCreated = 0;
  for (const spec of NEGOTIATION_SHOWCASE) {
    const vendor = vendorMap[spec.vendorName];
    if (!vendor) continue;
    const startDate = addDays(today, -30 * spec.startMonthsAgo);
    const endDate   = addDays(startDate, 365);
    const savingsPct = Math.round((1 - spec.finalPrice / spec.originalAsk) * 100);
    await prismaClient.contract.create({
      data: {
        accountId,
        vendorId:            vendor.id,
        contractNumber:      `DEMO-NEG-${1100 + negotiationCreated}`,
        product:             spec.product,
        quantity:            1,
        costPerLicense:      String(spec.finalPrice),
        totalValue:          spec.finalPrice,
        originalAsk:         spec.originalAsk,
        finalNegotiatedPrice: spec.finalPrice,
        startDate,
        endDate,
        evaluationStartByDate: addDays(endDate, -45),
        autoRenewal:         false,
        department:          spec.dept,
        internalOwnerId:     pick(ownerUserIds),
        status:              'active',
        notes: `Negotiated down from $${spec.originalAsk.toLocaleString()} to $${spec.finalPrice.toLocaleString()} (${savingsPct}% savings). Competitive bid + volume commitment used as leverage.`,
      },
    });
    negotiationCreated++;
  }

  // ── Co-term Misalignment (Risk Radar) ─────────────────────────────────────
  // Two Microsoft contracts in the same coTermGroup with end dates >30 days
  // apart so the Risk Radar "Co-term Misaligned" section is always populated.
  const msftVendor = vendorMap['Microsoft'];
  let cotermCreated = 0;
  if (msftVendor) {
    const pairs = [
      { product: 'M365 E5 (co-term anchor)',     endOffset: 85,  value: 195000 },
      { product: 'Azure EA Commit (co-term)',     endOffset: 148, value: 216000 }, // 63d divergence
    ];
    for (const p of pairs) {
      const endDate   = addDays(today, p.endOffset);
      const startDate = addDays(endDate, -365);
      await prismaClient.contract.create({
        data: {
          accountId,
          vendorId:   msftVendor.id,
          contractNumber: `DEMO-COTERM-${cotermCreated + 1}`,
          product:    p.product,
          quantity:   1,
          costPerLicense: String(p.value),
          totalValue: p.value,
          startDate, endDate,
          evaluationStartByDate: addDays(endDate, -45),
          autoRenewal: false,
          coTermGroup: 'Microsoft-EA',
          department: 'Engineering',
          internalOwnerId: pick(ownerUserIds),
          status: 'active',
          notes: '[Demo] Co-term group: Microsoft-EA. End dates are misaligned — consolidate at next renewal to avoid split negotiations.',
        },
      });
      cotermCreated++;
    }
  }

  // ── Approaching Auto-Renewal Traps (Dashboard tile + cancel-urgent) ───────
  // v0.35.3 audit gap: the existing `trap` bucket above has cancelByDate in
  // the past (-5 to -25 days) so it populates Risk Radar's `traps` section
  // but NOT the Dashboard's `autoRenewalTraps` tile (which queries
  // cancelByDate gte now AND lte now+30) and NOT the `cancelUrgent`
  // sub-card (cancelByDate ≤ now+7). With the random bucket scatter,
  // upcoming-mid contracts only occasionally land cancel-by in the +0/+30
  // window — Dustin reported the tile showing 0 traps on the demo. These
  // 5 contracts guarantee a steady tile state: 2 are inside the +7d
  // cancel-urgent window, 3 sit in the +8/+25d window.
  const trapApproachingSpecs = [
    { vendorName: 'Datadog',   product: 'Datadog Pro — auto-renewal in 3 days',  qty: 45,  cost:   240, cancelInDays:  3, endInDays:  33, dept: 'Engineering', notes: '[Demo] Cancel-by window closes in 3 days. Need decision before EOW or this auto-rolls another year at +9% per MSA.' },
    { vendorName: 'Zoom',      product: 'Zoom Phone Pro — cancel-by next week',  qty: 32,  cost:   192, cancelInDays:  6, endInDays:  66, dept: 'Sales',       notes: '[Demo] Cancel-by in 6 days. Vendor offered $4K bundle credit to stay; need finance signoff today.' },
    { vendorName: 'Notion',    product: 'Notion Business — cancel-by in 12 days', qty: 95,  cost:    96, cancelInDays: 12, endInDays:  72, dept: 'Marketing',   notes: '[Demo] Cancel-by in 12 days. Headcount-utilization analysis pending from People Ops; decide by Wed.' },
    { vendorName: 'Slack',     product: 'Slack Business+ — cancel-by in 18 days',  qty: 240, cost:   180, cancelInDays: 18, endInDays:  78, dept: 'Sales',       notes: '[Demo] Cancel-by in 18 days. Considering migration to Teams (consolidation play); decision owed to procurement Thu.' },
    { vendorName: 'Atlassian', product: 'Jira Premium — cancel-by in 25 days',    qty: 120, cost:   108, cancelInDays: 25, endInDays:  85, dept: 'Engineering', notes: '[Demo] Cancel-by in 25 days. Atlassian Cloud price hike kicks in at renewal — RFP shortlist needed first.' },
  ];

  let approachingTrapsCreated = 0;
  for (const t of trapApproachingSpecs) {
    const vendor = vendorMap[t.vendorName];
    if (!vendor) continue;
    const endDate   = addDays(today, t.endInDays);
    const startDate = addDays(endDate, -365);
    const cancelByDate = addDays(today, t.cancelInDays);
    const noticeDays   = t.endInDays - t.cancelInDays;
    await prismaClient.contract.create({
      data: {
        accountId,
        vendorId:           vendor.id,
        contractNumber:     `DEMO-TRAP-APPR-${1200 + approachingTrapsCreated}`,
        product:            t.product,
        quantity:           t.qty,
        costPerLicense:     String(t.cost),
        totalValue:         t.qty * t.cost,
        startDate, endDate,
        evaluationStartByDate: addDays(endDate, -45),
        autoRenewal:           true,
        autoRenewalNoticeDays: noticeDays,
        cancelByDate,
        department:        t.dept,
        internalOwnerId:   pick(ownerUserIds),
        status:            'active',
        notes:             t.notes,
      },
    });
    approachingTrapsCreated++;
  }

  // ── Expired-but-still-active (Risk Radar `expiredActive` bucket) ──────────
  // Contracts whose endDate has passed but status is still active/under_review.
  // Risk Radar surfaces these distinctly from past-cancel-by traps. The seed's
  // `expired` bucket sets status='expired' which Risk Radar excludes; without
  // these rows the Expired-Active section renders empty on every demo.
  // Note: autoExpireContracts() in routes/dashboard.js will flip these to
  // status='expired' the first time the dashboard loads — that's fine for the
  // demo flow (visitor sees Risk Radar first or the dashboard first, then the
  // bucket migrates to "expired (audit history)" view on the second page load).
  // After the nightly reset they're back. Set autoRenewal=false so they do
  // NOT also count as auto-renewal traps.
  const expiredActiveSpecs = [
    { vendorName: 'GitHub',      product: 'GitHub Enterprise Cloud', qty: 75,  cost:   252, endDaysAgo: 12, dept: 'Engineering', notes: '[Demo] Expired 12 days ago but still showing active — procurement missed the renewal window. Vendor sent invoice anyway; finance disputing.' },
    { vendorName: 'CrowdStrike', product: 'Falcon Pro',              qty: 220, cost:   120, endDaysAgo: 22, dept: 'IT',          notes: '[Demo] Expired 22 days ago. Vendor still providing service per their grace clause; procurement scrambling to backfill the renewal paperwork.' },
    { vendorName: 'Cloudflare',  product: 'Cloudflare Enterprise',    qty:   1, cost: 48000, endDaysAgo: 35, dept: 'Engineering', notes: '[Demo] Expired over a month ago — internal owner left the company and nobody picked it up. Risk Radar surfaced this in time to negotiate a back-dated extension.' },
  ];

  let expiredActiveCreated = 0;
  for (const e of expiredActiveSpecs) {
    const vendor = vendorMap[e.vendorName];
    if (!vendor) continue;
    const endDate   = addDays(today, -e.endDaysAgo);
    const startDate = addDays(endDate, -365);
    await prismaClient.contract.create({
      data: {
        accountId,
        vendorId:        vendor.id,
        contractNumber:  `DEMO-EXPIRED-ACTIVE-${1300 + expiredActiveCreated}`,
        product:         e.product,
        quantity:        e.qty,
        costPerLicense:  String(e.cost),
        totalValue:      e.qty * e.cost,
        startDate, endDate,
        evaluationStartByDate: addDays(endDate, -45),
        autoRenewal:     false,
        department:      e.dept,
        internalOwnerId: pick(ownerUserIds),
        status:          'active',
        notes:           e.notes,
      },
    });
    expiredActiveCreated++;
  }

  // ── Open alerts (Dashboard `openAlerts` count) ────────────────────────────
  // The dashboard tile reads `prisma.alert.count({ where: { accountId,
  // acknowledgedAt: null } })`. Without seeded Alert rows the tile is always
  // 0 on a fresh demo (the alertEngine cron runs at 07:00 server time, not
  // during the seed). Plant a handful pointing at the soonest-due contracts
  // so the count is non-zero from the second the seed completes.
  const allActiveForAlerts = await prismaClient.contract.findMany({
    where: { accountId, status: 'active' },
    select: { id: true, endDate: true, cancelByDate: true },
    orderBy: { endDate: 'asc' },
    take: 25,
  });
  const alertAnchors = allActiveForAlerts
    .filter(c => c.cancelByDate || c.endDate)
    .slice(0, 8);
  let alertsCreated = 0;
  const alertSeedNow = new Date();
  for (let i = 0; i < alertAnchors.length; i++) {
    const c = alertAnchors[i];
    const types = ['cancel_by', 'review_by', 'renewal'];
    const alertType = types[i % types.length];
    await prismaClient.alert.create({
      data: {
        accountId,
        contractId:     c.id,
        alertType,
        daysBeforeEnd:  alertType === 'review_by' ? 30 : (alertType === 'cancel_by' ? 14 : 60),
        scheduledAt:    alertSeedNow,
        sentAt:         alertType === 'cancel_by' ? alertSeedNow : null,
        acknowledgedAt: null,
        status:         alertType === 'cancel_by' ? 'sent' : 'pending',
      },
    });
    alertsCreated++;
  }

  return {
    vendors: vendors.length,
    contracts: contractsCreated,
    archived: archivedCreated,
    news: 0,
    negotiation: negotiationCreated,
    coterm: cotermCreated,
    approachingTraps: approachingTrapsCreated,
    expiredActive: expiredActiveCreated,
    alerts: alertsCreated,
  };
}

/**
 * L3: seedAccountForUser(userId)
 *
 * Populate a freshly-created per-visitor demo Account with the same canned
 * vendor + contract data set the legacy 4-user seed produces. Used by the
 * DEMO_MODE registration handler in routes/auth.js after it creates the
 * visitor's User + Account.
 *
 * The user becomes the sole internalOwner for every seeded contract, which
 * is the most useful default: the visitor immediately sees their dashboard
 * populated with their own renewal queue.
 *
 * Idempotency: this is NOT idempotent — it always creates new vendors and
 * contracts. Calling twice on the same account doubles the data.
 */
async function seedAccountForUser(userId) {
  if (!userId) throw new Error('seedAccountForUser: userId is required');
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { id: true, accountId: true },
  });
  if (!user) throw new Error(`seedAccountForUser: user ${userId} not found`);
  // Demo polish (2026-06-01): make per-visitor sandboxes demo-ready.
  // Fail-safe: each block is independently guarded so a failure here never
  // produces an empty sandbox (the seed still runs with the sole owner).
  const accountId = user.accountId;
  const ownerIds = [user.id];
  try {
    await prisma.account.update({ where: { id: accountId }, data: { fteCount: 240 } });
  } catch (e) { console.warn('[seed-demo] fteCount set failed:', e.message); }
  try {
    await prisma.accountSetting.upsert({
      where:  { accountId_key: { accountId, key: 'ONBOARDING_COMPLETE' } },
      update: { value: 'true' },
      create: { accountId, key: 'ONBOARDING_COMPLETE', value: 'true' },
    });
  } catch (e) { console.warn('[seed-demo] onboarding flag failed:', e.message); }
  try {
    const teammatePw = await bcrypt.hash('Demo-Sandbox-Teammate!', 12);
    const teammates = [
      { name: 'Jordan Lee', role: 'manager' },
      { name: 'Priya Natarajan', role: 'manager' },
    ];
    for (let i = 0; i < teammates.length; i++) {
      const tm = await prisma.user.create({
        data: {
          accountId,
          name: teammates[i].name,
          email: 'demo.' + accountId.slice(0, 12) + '.' + i + '@lapseiq-sandbox.local',
          passwordHash: teammatePw,
          role: teammates[i].role,
        },
      });
      ownerIds.push(tm.id);
    }
  } catch (e) { console.warn('[seed-demo] teammate seeding failed; using sole owner:', e.message); }
  // Pre-record AI consent so the demo's AI features work immediately without
  // the consent modal (demo data is fabricated; the sandbox banner already
  // warns not to enter real data). DEMO_MODE-only via this seed path; the
  // commercial self-host flow still requires an explicit acknowledgment.
  try {
    const { getCurrentConsentVersion, getActiveProvider } = require('../lib/aiConsent');
    await prisma.user.update({
      where: { id: user.id },
      data: {
        aiConsentDismissedAt:          new Date(),
        aiConsentVersion:              getCurrentConsentVersion(),
        aiConsentProviderAtAcceptance: getActiveProvider(),
        aiConsentSilenced:             true,
      },
    });
  } catch (e) { console.warn('[seed-demo] AI consent pre-ack failed:', e.message); }
  return _seedDemoData(accountId, ownerIds);
}

// ── Legacy 4-user seed (kept for backward compatibility) ─────────────────────
// The pre-L3 demo flow seeded a single shared account with 4 named users that
// visitors logged into directly. The new flow is per-visitor accounts (see
// seedAccountForUser above), but the legacy account is preserved so anyone
// using the documented seeded credentials still has a sandbox to land in.
async function _seedAccount() {
  const account = await prisma.account.create({
    data: {
      id: DEMO_ACCOUNT_ID,
      companyName: 'Demo Co (Sandbox)',
      status: 'active',
      planType: 'saas',
      planTier: 'mid',
      // Phase 4: the hosted demo showcases the AI renewal brief, so flip the
      // per-account toggle on at seed time. Self-host install accounts (via
      // /api/setup/account and /api/auth/register) keep the default false
      // and an admin enables it explicitly in Settings > AI.
      aiBriefEnabled: true,
    },
  });

  // v0.18.0: opt-in upstream feedback sync — demo always on so ForgeRift
  // gets feedback signal from the hosted sandbox without requiring admins
  // to manually flip the toggle during demos.
  await prisma.accountSetting.create({
    data: {
      accountId: account.id,
      key:   'ai_feedback_upstream_enabled',
      value: 'true',
    },
  });

  // Skip the onboarding wizard for the demo — the account is pre-seeded
  // with 12 vendors and 121 contracts so the "Add your first vendor" flow
  // makes no sense. Real self-hosted installs start empty and see it normally.
  await prisma.accountSetting.create({
    data: {
      accountId: account.id,
      key:   'ONBOARDING_COMPLETE',
      value: 'true',
    },
  });

  // ── Users ────────────────────────────────────────────────────────────────
  const adminPw      = await bcrypt.hash('Admin1234!',      12);
  const managerPw    = await bcrypt.hash('Manager1234!',    12);
  const viewerPw     = await bcrypt.hash('Viewer1234!',     12);
  const consultantPw = await bcrypt.hash('Consultant1234!', 12);

  const admin = await prisma.user.create({
    data: {
      accountId: account.id,
      name:  'Demo Admin',
      email: 'admin@demo.local',
      passwordHash: adminPw,
      role: 'admin',
    },
  });
  const manager = await prisma.user.create({
    data: {
      accountId: account.id,
      name:  'Demo Manager',
      email: 'manager@demo.local',
      passwordHash: managerPw,
      role: 'manager',
    },
  });
  const viewer = await prisma.user.create({
    data: {
      accountId: account.id,
      name:  'Demo Viewer',
      email: 'viewer@demo.local',
      passwordHash: viewerPw,
      role: 'viewer',
    },
  });
  const consultant = await prisma.user.create({
    data: {
      accountId: account.id,
      name:  'Demo Consultant',
      email: 'consultant@demo.local',
      passwordHash: consultantPw,
      role: 'consultant',
    },
  });
  // Consultant access grant
  await prisma.consultantAccess.create({
    data: {
      accountId:    account.id,
      consultantId: consultant.id,
      grantedById:  admin.id,
    },
  });

  // 2026-05-10 v0.2.30 (H5 follow-up): emit account_created rows so the
  // seeded demo users show full provenance in the Activity Log. Mirrors
  // routes/auth.js:237 which fires the same event for real registrations.
  // Awaited so the rows are persisted before the script exits (the CLI
  // entrypoint disconnects Prisma immediately on return).
  for (const u of [admin, manager, viewer, consultant]) {
    await writeActivityLog({
      userId:  u.id,
      action:  'account_created',
      details: { seeded: true, role: u.role, demoMode: process.env.DEMO_MODE === 'true' },
    });
  }

  // Delegate vendor + contract creation to the shared populator. Both
  // manager and admin can be assigned as internalOwner.
  const seedResult = await _seedDemoData(account.id, [manager.id, admin.id]);

  // 2026-05-10 Phase 1 (non-SaaS categories): seed the 9 default categories
  // and backfill every contract just created above to the "saas" category.
  // Called AFTER _seedDemoData so the contracts exist; called only once per
  // demo seed (idempotent if re-run).
  const categoryResult = await seedCategoriesAndBackfill(account.id);
  console.log(
    `[seed-demo] categories: created=${categoryResult.created} ` +
    `alreadyExisted=${categoryResult.alreadyExisted} backfilled=${categoryResult.backfilled}`
  );

  // Phase 4 v0.4.1 (#3): layer in 7 non-SaaS showcase contracts so the
  // canonical demo account exercises all 9 brief templates.
  try {
    const showcaseResult = await seedNonSaasShowcase(account.id, admin.id);
    const created = showcaseResult?.created || 0;
    const skipped = showcaseResult?.skippedSlugs?.length || 0;
    console.log(`[seed-demo] non-SaaS showcase: created=${created}, skipped-slugs=${skipped} (${(showcaseResult?.skippedSlugs || []).join(',') || 'none'})`);
  } catch (showcaseErr) {
    console.error('[seed-demo] non-SaaS showcase failed:', showcaseErr.message);
  }

  // ── Synthetic activity log ──────────────────────────────────────────────────
  // The seed writes directly to the DB, bypassing the API layer that normally
  // fires activity log entries. Without this block, the Activity Log shows only
  // the 4 account_created rows — which looks empty and broken in a demo.
  // We backfill ~20 realistic events spread over the past 90 days so the log
  // tells a coherent story: data import, routine edits, reviews, AI usage.
  try {
    // Grab a handful of real contracts to attach events to.
    const sampleContracts = await prisma.contract.findMany({
      where:   { accountId: account.id, status: 'active' },
      orderBy: { createdAt: 'asc' },
      take:    10,
      select:  { id: true, product: true },
    });

    if (sampleContracts.length > 0) {
      const c = (i) => sampleContracts[i % sampleContracts.length].id;
      const daysAgo = (d) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);

      const events = [
        // Initial bulk import feel — contracts were entered ~3 months ago
        { contractId: c(0), userId: admin.id,   action: 'contract_created',  createdAt: daysAgo(88), details: { source: 'csv_import', product: sampleContracts[0].product } },
        { contractId: c(1), userId: admin.id,   action: 'contract_created',  createdAt: daysAgo(87), details: { source: 'csv_import', product: sampleContracts[1].product } },
        { contractId: c(2), userId: admin.id,   action: 'contract_created',  createdAt: daysAgo(86), details: { source: 'csv_import', product: sampleContracts[2].product } },
        { contractId: c(3), userId: manager.id, action: 'contract_created',  createdAt: daysAgo(85), details: { source: 'csv_import', product: sampleContracts[3].product } },
        { contractId: c(4), userId: manager.id, action: 'contract_created',  createdAt: daysAgo(84), details: { source: 'csv_import', product: sampleContracts[4].product } },
        // Ownership assignments after import
        { contractId: c(0), userId: admin.id,   action: 'owner_assigned',    createdAt: daysAgo(83), details: { assignedTo: 'Demo Manager' } },
        { contractId: c(3), userId: admin.id,   action: 'owner_assigned',    createdAt: daysAgo(82), details: { assignedTo: 'Demo Admin' } },
        // Routine field edits over the following weeks
        { contractId: c(1), userId: manager.id, action: 'fields_updated',    createdAt: daysAgo(70), details: { fields: ['quantity', 'costPerLicense'] } },
        { contractId: c(5), userId: admin.id,   action: 'fields_updated',    createdAt: daysAgo(55), details: { fields: ['evaluationStartByDate', 'cancelByDate'] } },
        { contractId: c(2), userId: manager.id, action: 'fields_updated',    createdAt: daysAgo(40), details: { fields: ['notes'] } },
        // Status changes — contracts moved to under_review
        { contractId: c(0), userId: manager.id, action: 'status_changed',    createdAt: daysAgo(45), details: { from: 'active', to: 'under_review' } },
        { contractId: c(6), userId: admin.id,   action: 'status_changed',    createdAt: daysAgo(30), details: { from: 'active', to: 'under_review' } },
        { contractId: c(0), userId: admin.id,   action: 'status_changed',    createdAt: daysAgo(28), details: { from: 'under_review', to: 'active' } },
        // AI brief generation
        { contractId: c(1), userId: manager.id, action: 'brief_generated',   createdAt: daysAgo(25), details: { category: 'saas', tokensUsed: 1840 } },
        { contractId: c(7), userId: admin.id,   action: 'brief_generated',   createdAt: daysAgo(12), details: { category: 'saas', tokensUsed: 2210 } },
        // Documents uploaded
        { contractId: c(2), userId: manager.id, action: 'document_uploaded', createdAt: daysAgo(20), details: { filename: 'renewal-quote-2026.pdf' } },
        { contractId: c(5), userId: admin.id,   action: 'document_uploaded', createdAt: daysAgo(8),  details: { filename: 'vendor-proposal-final.pdf' } },
        // Checklist progress
        { contractId: c(1), userId: manager.id, action: 'checklist_updated', createdAt: daysAgo(18), details: { step: 'Renewal notice sent', checked: true } },
        { contractId: c(6), userId: admin.id,   action: 'checklist_updated', createdAt: daysAgo(10), details: { step: 'Proposal received', checked: true } },
        // One renewal completed
        { contractId: c(9), userId: admin.id,   action: 'contract_renewed',  createdAt: daysAgo(5),  details: { previousEnd: '2025-12-31', newEnd: '2026-12-31', savings: 4200 } },
      ];

      await prisma.activityLog.createMany({
        data: events.map(e => ({
          contractId: e.contractId,
          userId:     e.userId,
          action:     e.action,
          details:    e.details,
          createdAt:  e.createdAt,
        })),
        skipDuplicates: false,
      });
      console.log(`[seed-demo] activity log: seeded ${events.length} synthetic events`);
    }
  } catch (actErr) {
    console.error('[seed-demo] activity log seeding failed:', actErr.message);
  }

  return {
    accountId: account.id,
    users:     { admin: admin.email, manager: manager.email, viewer: viewer.email, consultant: consultant.email },
    vendors:   seedResult.vendors,
    contracts: seedResult.contracts,
  };
}

/**
 * Wipe the demo account (cascades to all owned data) and re-seed.
 * @param {{ trigger?: 'cli'|'cron' }} opts
 */
async function resetAndSeedDemo(opts = {}) {
  await _resetDemoAccount();
  const summary = await _seedAccount();
  return { ...summary, trigger: opts.trigger || 'cli' };
}

// ── CLI entry ────────────────────────────────────────────────────────────────
if (require.main === module) {
  resetAndSeedDemo({ trigger: 'cli' })
    .then((s) => {
      console.log('Demo seed complete:');
      console.log(JSON.stringify(s, null, 2));
      console.log('\nLogin credentials:');
      console.log('  admin@demo.local      / Admin1234!');
      console.log('  manager@demo.local    / Manager1234!');
      console.log('  viewer@demo.local     / Viewer1234!');
      console.log('  consultant@demo.local / Consultant1234!');
      return prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error('Seed failed:', err);
      await prisma.$disconnect();
      process.exit(1);
    });
}

// ── Phase 4 v0.4.1 (#3) — non-SaaS showcase data ───────────────────────────
// _seedDemoData seeds 30+ SaaS-flavoured contracts; seedCategoriesAndBackfill
// then maps them all to the 'saas' category. To exercise the Phase 4
// per-category brief templates on a fresh demo signup, we add 7 small
// non-SaaS contracts (one per category: telecom, insurance, lease_rent,
// hardware, services, utilities, supplies). Each gets its own vendor with
// a real-sounding name + a stored vendor contact so the Watch For section
// can suggest a quote recipient.
//
// Idempotent: if the account already has any non-saas contracts, skip. So
// re-running on the same account (e.g. demo reset) doesn't duplicate.

const NON_SAAS_SHOWCASE = [
  {
    slug: 'telecom',
    vendor: { name: 'Verizon Business', contactName: 'Karen Hayes', contactEmail: 'k.hayes@verizonbusiness.example', contactTitle: 'Account Executive' },
    product: 'Business Internet 500/500 + 25 wireless lines',
    quantity: 25,
    // 2026-05-12 round-4 fix (Opus C3): costPerLicense was $52 — the
    // raw MONTHLY MRC per line. totalValue then rendered as $1,300
    // "annual" which a procurement reader would compute negotiation
    // leverage off of, dramatically wrong. Now $624 = $52/mo × 12mo
    // so the annual TCV reads $15,600 like every other contract on
    // the platform. Product description updated to spell out the
    // calculation so it's not opaque.
    costPerLicense: '624.00',
    endOffsetDays: 95,
    autoRenewal: true,
    autoRenewalNoticeDays: 30,
    notes: '[Demo] Bundled fiber + mobile fleet — $52/mo MRC per line × 25 lines × 12 months = $15,600 annual. Auto-renews at then-current rates if no notice 30 days before term end.',
  },
  {
    slug: 'insurance',
    vendor: { name: 'The Hartford', contactName: 'Marcus Chen', contactEmail: 'mchen@thehartford.example', contactTitle: 'Commercial Broker' },
    product: 'Business Owners Policy (BOP) + Cyber endorsement',
    quantity: 1,
    costPerLicense: '14400.00',
    endOffsetDays: 60,
    autoRenewal: false,
    notes: '[Demo] Annual commercial P&C with cyber endorsement. Loss runs requested for renewal market.',
  },
  {
    slug: 'lease_rent',
    vendor: { name: 'Brookfield Properties', contactName: 'Sarah Patel', contactEmail: 'spatel@brookfield.example', contactTitle: 'Tenant Rep' },
    product: 'Office space — 4,200 sqft, Class B downtown',
    quantity: 4200,
    costPerLicense: '32.00',
    endOffsetDays: 220,
    autoRenewal: false,
    notes: '[Demo] 4,200 sqft Class B office. Current rent $32/sqft net of CAM. Renewal option at FMR.',
  },
  {
    slug: 'hardware',
    vendor: { name: 'Dell Technologies', contactName: 'Tom Whitaker', contactEmail: 'tom.whitaker@dell.example', contactTitle: 'Enterprise Support Rep' },
    product: 'PowerEdge R750 Maintenance (8 servers, 24x7x4 SLA)',
    quantity: 8,
    costPerLicense: '1850.00',
    endOffsetDays: 135,
    autoRenewal: true,
    autoRenewalNoticeDays: 30,
    notes: '[Demo] OEM maintenance on 8 PowerEdge R750. EOSL is 2028. TPM quote pending from Park Place.',
  },
  {
    slug: 'services',
    vendor: { name: 'Accenture', contactName: 'Priya Ramesh', contactEmail: 'p.ramesh@accenture.example', contactTitle: 'Engagement Partner' },
    product: 'Managed SOC services (24x7 monitoring + IR retainer)',
    quantity: 1,
    costPerLicense: '186000.00',
    endOffsetDays: 75,
    autoRenewal: false,
    notes: '[Demo] Managed SOC engagement. KPIs: MTTD <15 min, MTTR <2 hrs. Need to tighten SLA at renewal.',
  },
  {
    slug: 'utilities',
    vendor: { name: 'Constellation Energy', contactName: 'Jamie Sutton', contactEmail: 'jsutton@constellation.example', contactTitle: 'Account Manager' },
    product: 'Electricity supply (fixed-rate, 1.4M kWh/year)',
    quantity: 1400000,
    costPerLicense: '0.092',
    endOffsetDays: 165,
    autoRenewal: true,
    autoRenewalNoticeDays: 30,
    notes: '[Demo] Deregulated supply contract (PJM zone). Evergreen rollover at variable rate if no 30-day notice — known trap.',
  },
  {
    slug: 'supplies',
    vendor: { name: 'Staples Business Advantage', contactName: 'Linda Park', contactEmail: 'l.park@staples.example', contactTitle: 'B2B Account Manager' },
    product: 'Office supplies catalog + janitorial program',
    quantity: 1,
    costPerLicense: '47500.00',
    endOffsetDays: 280,
    autoRenewal: false,
    notes: '[Demo] Annual catalog spend with 5% rebate at $40k tier. Top-100 SKUs negotiated; tail spend uncapped.',
  },
  // v0.4.1 round-2 (#14): 4 "Other" category contracts. The "Other"
  // category seeded empty in v0.4.1 — these are the kinds of recurring
  // facilities / operations contracts that don't fit cleanly into
  // services/supplies/etc. and end up in Other on most real customer
  // accounts. Realistic vendor + product mix for renewal-management
  // demo credibility.
  {
    slug: 'other',
    vendor: { name: 'Cintas', contactName: 'Brian Walsh', contactEmail: 'b.walsh@cintas.example', contactTitle: 'Service Sales Rep' },
    product: 'Uniform + floor mat rental program (weekly route service)',
    quantity: 1,
    costPerLicense: '34800.00',
    endOffsetDays: 120,
    autoRenewal: true,
    autoRenewalNoticeDays: 60,
    notes: '[Demo] Weekly route service for 45 employee uniforms + 18 entrance/utility mats. Auto-renews annually unless 60-day notice. Watch for the lost/damaged charges line on the invoice — common to be over-billed.',
  },
  {
    slug: 'other',
    vendor: { name: 'Orkin Commercial', contactName: 'Diane Russo', contactEmail: 'd.russo@orkin.example', contactTitle: 'Account Manager' },
    product: 'Quarterly pest control program (3 locations)',
    quantity: 3,
    costPerLicense: '2400.00',
    endOffsetDays: 200,
    autoRenewal: true,
    autoRenewalNoticeDays: 30,
    notes: '[Demo] Quarterly visits per location. Multi-site contract; price-per-site dropped 8% at last renewal after threatening to bid out. Auto-renews; verify scope hasn\'t silently expanded.',
  },
  {
    slug: 'other',
    vendor: { name: 'Compass Group / Canteen', contactName: 'Hector Velez', contactEmail: 'h.velez@compass.example', contactTitle: 'Business Development' },
    product: 'Break room program (coffee, vending, supplies refills)',
    quantity: 1,
    costPerLicense: '18600.00',
    endOffsetDays: 90,
    autoRenewal: false,
    notes: '[Demo] Full-service break-room program — coffee, vended snacks, supplies refills. Per-employee billing; watch the headcount-snapshot date in the renewal — providers sometimes lock in a peak-quarter number.',
  },
  {
    slug: 'other',
    vendor: { name: 'Ambius', contactName: 'Olivia Tran', contactEmail: 'o.tran@ambius.example', contactTitle: 'Account Executive' },
    product: 'Interior plantscaping + maintenance (HQ lobby + 2 floors)',
    quantity: 1,
    costPerLicense: '7200.00',
    endOffsetDays: 250,
    autoRenewal: true,
    autoRenewalNoticeDays: 30,
    notes: '[Demo] Monthly plant maintenance + replacement guarantee. Small-dollar but evergreen — the kind of contract that gets forgotten and quietly creeps 5% a year if you don\'t intercept it.',
  },
  // v0.5.12: substantial expansion of the showcase array — 41 new
  // contracts across the 9 non-SaaS categories, each with vendor- and
  // contract-specific notes (no boilerplate). Brings the total demo
  // contract count from ~41 to ~80+, with believable variety for a
  // multi-location operating company's portfolio.
  {
    slug: 'hardware',
    vendor: { name: 'Cisco Meraki', contactName: 'David Liu', contactEmail: 'd.liu@meraki.example', contactTitle: 'Senior Account Manager' },
    product: 'MX/MS/MR networking refresh + 3yr Enterprise license',
    quantity: 18,
    costPerLicense: '1100.00',
    endOffsetDays: 78,
    autoRenewal: true,
    notes: '[Demo] Branch-office stack — 18 devices across two offices. License renewal anchors the hardware; if we let Enterprise lapse the cloud dashboard reverts to read-only. Quote requested for 5yr term with co-term at the master MSA.',
  },
  {
    slug: 'hardware',
    vendor: { name: 'Lenovo', contactName: 'Marisol Vega', contactEmail: 'm.vega@lenovo.example', contactTitle: 'Field Sales Rep' },
    product: 'ThinkPad T-series lease — 85 endpoints, 3yr DaaS',
    quantity: 85,
    costPerLicense: '660.00',
    endOffsetDays: 320,
    autoRenewal: false,
    notes: '[Demo] Device-as-a-Service for end-user laptops. 36-month term, refresh half at month 18. New CFO wants to compare CapEx purchase vs continued DaaS — analysis owed Q3.',
  },
  {
    slug: 'hardware',
    vendor: { name: 'Apple', contactName: 'Jonas Reilly', contactEmail: 'j.reilly@apple.example', contactTitle: 'Business Solutions Specialist' },
    product: 'iPad Pro fleet for field ops (40 units, 2yr Care+)',
    quantity: 40,
    costPerLicense: '1450.00',
    endOffsetDays: 145,
    autoRenewal: false,
    notes: '[Demo] Field-team iPads with rugged cases + AppleCare+. Replacement attrition is running ~10% per year — budget for it. Sign-off needed from field-ops manager before next round.',
  },
  {
    slug: 'hardware',
    vendor: { name: 'Zebra Technologies', contactName: 'Renee Ostrowski', contactEmail: 'r.ostrowski@zebra.example', contactTitle: 'Channel Manager' },
    product: 'TC78 ruggedized handhelds + ZD621 label printers — 24 units',
    quantity: 24,
    costPerLicense: '1875.00',
    endOffsetDays: 240,
    autoRenewal: false,
    notes: '[Demo] Warehouse + dispatch handhelds. Repairs trending up — devices are end-of-life next year. EOL talking points: trade-in credit, push to TC73 successor.',
  },
  {
    slug: 'hardware',
    vendor: { name: 'Schneider Electric / APC', contactName: 'Tomas Krüger', contactEmail: 't.kruger@apc.example', contactTitle: 'Service Account Mgr' },
    product: 'Symmetra LX UPS maintenance — 4 units, on-site SLA',
    quantity: 4,
    costPerLicense: '2300.00',
    endOffsetDays: 95,
    autoRenewal: true,
    notes: '[Demo] On-site UPS maintenance for data closet + branch sites. Battery refresh due in 14 months — check if vendor will include in renewal vs charge separately.',
  },
  {
    slug: 'hardware',
    vendor: { name: 'HP Inc.', contactName: 'Anjali Iyer', contactEmail: 'a.iyer@hp.example', contactTitle: 'Print Services Rep' },
    product: 'Managed Print Services — 35 devices, cost-per-page',
    quantity: 35,
    costPerLicense: '740.00',
    endOffsetDays: 380,
    autoRenewal: true,
    notes: '[Demo] CPP model: $0.012 mono / $0.062 color. Color volume up 22% YoY post-rebrand. Renegotiate the tier breaks; current contract has tight overage penalties.',
  },
  {
    slug: 'hardware',
    vendor: { name: 'Cradlepoint', contactName: 'Brett Sandoval', contactEmail: 'b.sandoval@cradlepoint.example', contactTitle: 'Account Director' },
    product: 'E300 LTE/5G routers + NetCloud Manager — 12 sites',
    quantity: 12,
    costPerLicense: '920.00',
    endOffsetDays: 60,
    autoRenewal: true,
    notes: '[Demo] Backup connectivity + primary at 3 remote sites. Verizon\'s been pushing their CC Connect bundle as an alternative; worth a side-by-side at renewal.',
  },
  {
    slug: 'insurance',
    vendor: { name: 'Travelers', contactName: 'Annabelle Ford', contactEmail: 'a.ford@travelers.example', contactTitle: 'Senior Underwriter' },
    product: 'Commercial Auto fleet — 22 vehicles, hired/non-owned coverage',
    quantity: 22,
    costPerLicense: '23400.00',
    endOffsetDays: 110,
    autoRenewal: false,
    notes: '[Demo] Loss runs improved YoY (one claim closed favorably). Broker recommends shopping the market — quotes from Chubb and Liberty in hand. Decide before bind date.',
  },
  {
    slug: 'insurance',
    vendor: { name: 'Liberty Mutual', contactName: 'Curtis Han', contactEmail: 'c.han@libertymutual.example', contactTitle: 'Senior Broker' },
    product: 'General Liability + Property — $5M aggregate',
    quantity: 1,
    costPerLicense: '31200.00',
    endOffsetDays: 200,
    autoRenewal: false,
    notes: '[Demo] Property values inflated to 2026 rebuild costs. Carrier flagged the warehouse roof\'s age — preempt with the roofing-inspection report at renewal to keep premium flat.',
  },
  {
    slug: 'insurance',
    vendor: { name: 'Chubb', contactName: 'Yelena Petrov', contactEmail: 'y.petrov@chubb.example', contactTitle: 'Cyber Practice Lead' },
    product: 'Cyber Liability + Tech E&O — $3M limit',
    quantity: 1,
    costPerLicense: '18900.00',
    endOffsetDays: 35,
    autoRenewal: false,
    notes: '[Demo] Cyber market still hardening but loosening. Required answers on the MFA-everywhere questionnaire — IT to confirm 100% coverage by binder date. Otherwise expect a sub-limit on social engineering.',
  },
  {
    slug: 'insurance',
    vendor: { name: 'AIG', contactName: 'Greg Hollister', contactEmail: 'g.hollister@aig.example', contactTitle: 'Regional VP' },
    product: 'Umbrella / Excess Liability — $10M over scheduled primaries',
    quantity: 1,
    costPerLicense: '12600.00',
    endOffsetDays: 280,
    autoRenewal: false,
    notes: '[Demo] Sits on top of GL + Auto. Schedule of underlying needs updating to reflect new commercial auto carrier (Travelers, see policy above). Broker handling.',
  },
  {
    slug: 'insurance',
    vendor: { name: 'The Hartford', contactName: 'Marcus Chen', contactEmail: 'mchen@thehartford.example', contactTitle: 'Commercial Broker' },
    product: 'Workers\' Compensation — 47 employees, NCCI multi-class',
    quantity: 47,
    costPerLicense: '29800.00',
    endOffsetDays: 165,
    autoRenewal: false,
    notes: '[Demo] Experience mod dropped to 0.91 this year — material renewal credit owed. Confirm the carrier honors the new mod or push them to re-quote with the updated NCCI letter.',
  },
  {
    slug: 'telecom',
    vendor: { name: 'AT&T Business', contactName: 'Phillip Rashid', contactEmail: 'p.rashid@att.example', contactTitle: 'National Account Mgr' },
    product: 'DIA fiber 1Gbps + MPLS backbone — 3 locations',
    quantity: 3,
    costPerLicense: '5400.00',
    endOffsetDays: 130,
    autoRenewal: true,
    notes: '[Demo] MPLS days are numbered — SD-WAN migration plan in flight, transition target Q2 2027. Negotiate a shortened term or termination convenience for the MPLS leg this renewal.',
  },
  {
    slug: 'telecom',
    vendor: { name: 'T-Mobile for Business', contactName: 'Janelle Burke', contactEmail: 'j.burke@t-mobile.example', contactTitle: 'B2B Account Exec' },
    product: 'Field-team wireless — 38 lines, unlimited data + hotspot',
    quantity: 38,
    costPerLicense: '672.00',
    endOffsetDays: 88,
    autoRenewal: true,
    notes: '[Demo] $56/line/mo MRC × 12 = $672 annual. Verizon\'s been pitching to match + add $200 in device credits. Real leverage point — let\'s actually run the side-by-side.',
  },
  {
    slug: 'telecom',
    vendor: { name: 'RingCentral', contactName: 'Aaron McMillan', contactEmail: 'a.mcmillan@ringcentral.example', contactTitle: 'Mid-Market AE' },
    product: 'MVP Premium — 65 seats unified comms',
    quantity: 65,
    costPerLicense: '276.00',
    endOffsetDays: 215,
    autoRenewal: true,
    notes: '[Demo] Per-seat $23/mo × 12 = $276 annual. License utilization at 89% — room to right-size 6-8 seats. Zoom Phone has been quoting aggressively; worth a competitive RFP.',
  },
  {
    slug: 'telecom',
    vendor: { name: 'Twilio', contactName: 'Mei Hashimoto', contactEmail: 'm.hashimoto@twilio.example', contactTitle: 'Account Executive' },
    product: 'SMS + Voice API committed-use plan (40k msg/mo)',
    quantity: 1,
    costPerLicense: '8400.00',
    endOffsetDays: 50,
    autoRenewal: true,
    notes: '[Demo] Pay-as-you-go was running ~$1,100/mo; CUP commits at $700/mo with a 40k floor. Customer engagement team trending 35k/mo lately — confirm before re-committing.',
  },
  {
    slug: 'telecom',
    vendor: { name: 'Verizon Connect', contactName: 'Tony Marchetti', contactEmail: 't.marchetti@verizonconnect.example', contactTitle: 'Fleet Account Mgr' },
    product: 'Fleet GPS telematics — 22 vehicles, ELD compliance',
    quantity: 22,
    costPerLicense: '456.00',
    endOffsetDays: 305,
    autoRenewal: true,
    notes: '[Demo] $38/vehicle/mo. Driver-behavior dashboard helping insurance loss ratio (see Travelers policy). Worth keeping even if there are cheaper trackers — the carrier credit pays for it.',
  },
  {
    slug: 'lease_rent',
    vendor: { name: 'CBRE', contactName: 'Stephen Locke', contactEmail: 's.locke@cbre.example', contactTitle: 'Industrial Broker' },
    product: 'Distribution warehouse — 22,000 sqft, dock-high',
    quantity: 22000,
    costPerLicense: '9.40',
    endOffsetDays: 410,
    autoRenewal: false,
    notes: '[Demo] $9.40/sqft NNN. CAM pass-throughs jumped 11% YoY — request CAM reconciliation audit rights at renewal. Market comps suggest $8.20-$9.00 is more realistic.',
  },
  {
    slug: 'lease_rent',
    vendor: { name: 'JLL', contactName: 'Madeleine Quirk', contactEmail: 'm.quirk@jll.example', contactTitle: 'Tenant Representation' },
    product: 'Branch office — 1,800 sqft Class A, suburban',
    quantity: 1800,
    costPerLicense: '28.00',
    endOffsetDays: 95,
    autoRenewal: false,
    notes: '[Demo] Class A submarket softening — Tenant rep sees 4-6 months free rent on new 5yr terms in this submarket. Use as leverage on renewal.',
  },
  {
    slug: 'lease_rent',
    vendor: { name: 'Ryder System', contactName: 'Devon Atkinson', contactEmail: 'd.atkinson@ryder.example', contactTitle: 'Lease Account Manager' },
    product: 'Box truck lease — 4 vehicles, full-service maintenance',
    quantity: 4,
    costPerLicense: '14400.00',
    endOffsetDays: 175,
    autoRenewal: false,
    notes: '[Demo] Full-service lease incl. maintenance + tires. Mileage tracking shows we\'re under the contracted limit — request a downward rate adjustment, FSL contracts have under-mileage refunds rarely volunteered.',
  },
  {
    slug: 'lease_rent',
    vendor: { name: 'Iron Mountain', contactName: 'Lillian Vaughn', contactEmail: 'l.vaughn@ironmountain.example', contactTitle: 'Records Account Rep' },
    product: 'Records storage — 2,400 boxes + secure shred service',
    quantity: 2400,
    costPerLicense: '3.60',
    endOffsetDays: 75,
    autoRenewal: true,
    notes: '[Demo] Boxes-per-month + retrieval fees. Records retention review due — bet there\'s 600+ boxes past retention. Pre-clean before renewal to drop the floor.',
  },
  {
    slug: 'lease_rent',
    vendor: { name: 'Caterpillar Financial', contactName: 'Hank Bryson', contactEmail: 'h.bryson@catfinancial.example', contactTitle: 'Account Manager' },
    product: 'Equipment finance — 962M loader + 308 CR excavator',
    quantity: 2,
    costPerLicense: '32400.00',
    endOffsetDays: 480,
    autoRenewal: false,
    notes: '[Demo] 5yr financing schedule, balloon at end. Trade-in value tracking: residual will exceed buyout by ~$18k based on current used-market pricing. Decide before the 60-day buyout-notice deadline.',
  },
  {
    slug: 'lease_rent',
    vendor: { name: 'WeWork', contactName: 'Priscilla Adams', contactEmail: 'p.adams@wework.example', contactTitle: 'Member Success' },
    product: 'Flex desks — 6 dedicated seats at downtown location',
    quantity: 6,
    costPerLicense: '9000.00',
    endOffsetDays: 35,
    autoRenewal: true,
    notes: '[Demo] Sales team\'s downtown landing pad. Auto-renews monthly. Three of the six seats are unused — drop to three when renewing, save ~$4,500/yr.',
  },
  {
    slug: 'services',
    vendor: { name: 'Deloitte', contactName: 'Olivier Marchand', contactEmail: 'o.marchand@deloitte.example', contactTitle: 'Audit Partner' },
    product: 'Annual financial audit + SOC 1 attestation',
    quantity: 1,
    costPerLicense: '85000.00',
    endOffsetDays: 145,
    autoRenewal: false,
    notes: '[Demo] Engagement letter renewed annually. Audit hours overrun last cycle by 12%; clarify the scope of out-of-scope work in advance — engagement creep is the perennial issue.',
  },
  {
    slug: 'services',
    vendor: { name: 'PwC', contactName: 'Beatrix Underwood', contactEmail: 'b.underwood@pwc.example', contactTitle: 'Tax Senior Manager' },
    product: 'Federal + multi-state tax compliance + R&D credit study',
    quantity: 1,
    costPerLicense: '62000.00',
    endOffsetDays: 285,
    autoRenewal: false,
    notes: '[Demo] R&D credit study added last year; produced a $48k refund. Confirm the study is on the renewal scope and not a separate engagement letter.',
  },
  {
    slug: 'services',
    vendor: { name: 'Robert Half', contactName: 'Cody Tran', contactEmail: 'c.tran@roberthalf.example', contactTitle: 'Branch Manager' },
    product: 'Contract staffing — recurring temp-to-hire pipeline',
    quantity: 1,
    costPerLicense: '24000.00',
    endOffsetDays: 60,
    autoRenewal: true,
    notes: '[Demo] MSA stipulates 30% markup; conversion fee waived at 90-day mark. Three placements this year — verify all three were within MSA terms and not at one-off rates.',
  },
  {
    slug: 'services',
    vendor: { name: 'Cognizant', contactName: 'Niraj Mehta', contactEmail: 'n.mehta@cognizant.example', contactTitle: 'Engagement Director' },
    product: 'Application support + maintenance retainer',
    quantity: 1,
    costPerLicense: '94000.00',
    endOffsetDays: 195,
    autoRenewal: false,
    notes: '[Demo] Quarterly business reviews show ticket volume down 18% — fewer hands needed. Push for a step-down in the FTE schedule at renewal rather than flat.',
  },
  {
    slug: 'services',
    vendor: { name: 'Latham & Watkins (local counsel)', contactName: 'Tessa Boudreaux', contactEmail: 't.boudreaux@law-firm.example', contactTitle: 'Partner' },
    product: 'Corporate legal retainer — general counsel hours',
    quantity: 1,
    costPerLicense: '48000.00',
    endOffsetDays: 240,
    autoRenewal: false,
    notes: '[Demo] $400/hr blended rate × 120 hrs annual. Usage trending higher this year (M&A diligence). Renegotiate to either a flat retainer or a banked-hours pool.',
  },
  {
    slug: 'services',
    vendor: { name: 'ServiceMaster Restore', contactName: 'Dominic Pelletier', contactEmail: 'd.pelletier@servicemaster.example', contactTitle: 'Emergency Services Mgr' },
    product: 'Disaster recovery retainer + priority response SLA',
    quantity: 1,
    costPerLicense: '9600.00',
    endOffsetDays: 130,
    autoRenewal: true,
    notes: '[Demo] Zero claims since signing — vendor justifies on the SLA priority alone. Re-bid against ServPro this cycle; insurance carrier may have a preferred-partner discount.',
  },
  {
    slug: 'services',
    vendor: { name: 'ABM Industries', contactName: 'Rebecca Solanki', contactEmail: 'r.solanki@abm.example', contactTitle: 'Site Services Manager' },
    product: 'Facilities management — janitorial + day porter, 2 sites',
    quantity: 2,
    costPerLicense: '112000.00',
    endOffsetDays: 95,
    autoRenewal: false,
    notes: '[Demo] Two sites bundled — site A is bid out competitively, site B has higher specs (medical-grade cleaning). Don\'t accept a flat-percent uplift on the bundle; price each site separately.',
  },
  {
    slug: 'utilities',
    vendor: { name: 'Direct Energy Business', contactName: 'Wendell Park', contactEmail: 'w.park@directenergy.example', contactTitle: 'Commercial Sales' },
    product: 'Natural gas supply (fixed-rate, 18,000 therms/year)',
    quantity: 18000,
    costPerLicense: '0.640',
    endOffsetDays: 75,
    autoRenewal: true,
    notes: '[Demo] Locked in 2024 at $0.64/therm. NYMEX strip pricing for 2026 averaging $0.78 — current contract is in-the-money. Verify the renewal terms don\'t hide an out-of-market mark-up.',
  },
  {
    slug: 'utilities',
    vendor: { name: 'Waste Management', contactName: 'Eli Brodsky', contactEmail: 'e.brodsky@wm.example', contactTitle: 'Commercial Account Rep' },
    product: 'Commercial trash + recycling — 6-yard front-load, 3x weekly',
    quantity: 1,
    costPerLicense: '11400.00',
    endOffsetDays: 195,
    autoRenewal: true,
    notes: '[Demo] Fuel surcharge runs an additional 18-22% per invoice. Negotiate fuel-surcharge cap (industry typical: 12%). Republic Services is a credible alt-bid for leverage.',
  },
  {
    slug: 'utilities',
    vendor: { name: 'Republic Services', contactName: 'Sondra Whitman', contactEmail: 's.whitman@republicservices.example', contactTitle: 'Account Manager' },
    product: 'Single-stream recycling + cardboard bale pickup',
    quantity: 1,
    costPerLicense: '5400.00',
    endOffsetDays: 290,
    autoRenewal: true,
    notes: '[Demo] Volume-based pricing with floor minimums. Cardboard volume up significantly (warehouse intake) — see if the floor can become a credit on the trash side.',
  },
  {
    slug: 'utilities',
    vendor: { name: 'AT&T Business (Backup ISP)', contactName: 'Holly Greer', contactEmail: 'h.greer@att.example', contactTitle: 'Solutions Engineer' },
    product: 'Business fiber 500/500 as failover (separate carrier diversity)',
    quantity: 1,
    costPerLicense: '7200.00',
    endOffsetDays: 155,
    autoRenewal: true,
    notes: '[Demo] Geographic + carrier diversity from primary (Verizon Business). MTBF event last quarter justified the spend. Quote received from Crown Castle Fiber — middling, primary stays.',
  },
  {
    slug: 'utilities',
    vendor: { name: 'Aqua America', contactName: 'Pablo Reyes', contactEmail: 'p.reyes@aquaamerica.example', contactTitle: 'Commercial Accounts' },
    product: 'Commercial water service + monitoring',
    quantity: 1,
    costPerLicense: '3600.00',
    endOffsetDays: 410,
    autoRenewal: true,
    notes: '[Demo] Long-term municipal-utility contract. Adjustments come from rate cases at the public utility commission — track the docket; nothing to negotiate directly.',
  },
  {
    slug: 'supplies',
    vendor: { name: 'Grainger', contactName: 'Carmen Bissett', contactEmail: 'c.bissett@grainger.example', contactTitle: 'B2B Account Manager' },
    product: 'MRO industrial supplies — facility maintenance catalog',
    quantity: 1,
    costPerLicense: '62000.00',
    endOffsetDays: 110,
    autoRenewal: true,
    notes: '[Demo] Top-200 SKUs negotiated at 8-15% off list. Tail-spend (the other 60% of orders) at list. Push for a quarterly volume rebate to capture tail-spend value.',
  },
  {
    slug: 'supplies',
    vendor: { name: 'Uline', contactName: 'Vivian Cossart', contactEmail: 'v.cossart@uline.example', contactTitle: 'Field Account Rep' },
    product: 'Shipping + packaging supplies — corrugated, tape, labels',
    quantity: 1,
    costPerLicense: '38000.00',
    endOffsetDays: 360,
    autoRenewal: false,
    notes: '[Demo] No formal MSA — buying off the catalog. Spend pattern justifies negotiating a per-category discount; Uline rarely volunteers it.',
  },
  {
    slug: 'supplies',
    vendor: { name: 'Cintas First Aid & Safety', contactName: 'Russell Quaid', contactEmail: 'r.quaid@cintas-fas.example', contactTitle: 'Safety Specialist' },
    product: 'First aid restocking + AED maintenance — 6 cabinets, 2 AEDs',
    quantity: 6,
    costPerLicense: '4800.00',
    endOffsetDays: 250,
    autoRenewal: true,
    notes: '[Demo] AED battery replacements scheduled in 18 months — confirm covered under the maintenance program. Restocking invoices have historically included items we didn\'t request — audit a recent invoice before renewing.',
  },
  {
    slug: 'supplies',
    vendor: { name: 'MSC Industrial Supply', contactName: 'Inez Bartholomew', contactEmail: 'i.bartholomew@mscdirect.example', contactTitle: 'Industrial Account Mgr' },
    product: 'Cutting tools + abrasives + maintenance shop supplies',
    quantity: 1,
    costPerLicense: '29500.00',
    endOffsetDays: 80,
    autoRenewal: false,
    notes: '[Demo] Vendor-managed inventory at the shop bin level. VMI is convenient but tends toward \'over-stocked\' — audit the bin maxes for items that haven\'t moved in 12 months.',
  },
  {
    slug: 'supplies',
    vendor: { name: 'ULINE (PPE division)', contactName: 'Bernadette Quill', contactEmail: 'b.quill@uline-ppe.example', contactTitle: 'PPE Specialist' },
    product: 'PPE program — hi-vis, hard hats, gloves, eye protection',
    quantity: 1,
    costPerLicense: '21800.00',
    endOffsetDays: 175,
    autoRenewal: false,
    notes: '[Demo] Per-employee program ($350/employee/yr). Headcount is up — confirm the renewal doesn\'t lock in last year\'s headcount as the floor.',
  },
  {
    slug: 'other',
    vendor: { name: 'ADT Commercial', contactName: 'Quentin Beauchamp', contactEmail: 'q.beauchamp@adt.example', contactTitle: 'Commercial Account Exec' },
    product: 'Security alarm monitoring + access control — 3 sites',
    quantity: 3,
    costPerLicense: '8400.00',
    endOffsetDays: 220,
    autoRenewal: true,
    notes: '[Demo] Monitoring at three sites; access control on the corporate office. Camera footage retention upgrade quote pending. Old multi-year contract has automatic 5%/year escalator — negotiate that out at renewal.',
  },
  {
    slug: 'other',
    vendor: { name: 'Otis Elevator', contactName: 'Imogen Carstairs', contactEmail: 'i.carstairs@otis.example', contactTitle: 'Service Account Manager' },
    product: 'Elevator maintenance + 24/7 callback — 2 cars',
    quantity: 2,
    costPerLicense: '9600.00',
    endOffsetDays: 65,
    autoRenewal: true,
    notes: '[Demo] Full-maintenance contract — covers parts + callbacks. Older agreement bundles \'modernization\' add-ons that may not apply anymore; review carefully before signing.',
  },
  {
    slug: 'other',
    vendor: { name: 'Aramark Uniform Services', contactName: 'Donovan Spruill', contactEmail: 'd.spruill@aramark.example', contactTitle: 'Route Sales Manager' },
    product: 'Uniform rental — 28 employees, 11-pair rotation, weekly route',
    quantity: 28,
    costPerLicense: '780.00',
    endOffsetDays: 145,
    autoRenewal: true,
    notes: '[Demo] $15/employee/wk. 5%/year escalator buried in the original contract — they will quote a renewal at next-year\'s-escalator-PLUS-uplift. Push to remove the escalator.',
  },
  {
    slug: 'other',
    vendor: { name: 'ChargePoint', contactName: 'Naomi Albrecht', contactEmail: 'n.albrecht@chargepoint.example', contactTitle: 'Workplace Solutions Rep' },
    product: 'EV charging stations — 4 Level 2 dual-port + network service',
    quantity: 4,
    costPerLicense: '1800.00',
    endOffsetDays: 300,
    autoRenewal: true,
    notes: '[Demo] Network/subscription fee continues post-warranty. Hardware in year 2 of 5-year payback. Confirm the firmware-support clause runs the full life of the asset.',
  },
  {
    slug: 'other',
    vendor: { name: 'American Industrial Hygiene Assn', contactName: 'Phineas Locklear', contactEmail: 'p.locklear@aiha.example', contactTitle: 'Member Services' },
    product: 'Industrial hygiene testing — quarterly air/noise/exposure',
    quantity: 4,
    costPerLicense: '5400.00',
    endOffsetDays: 200,
    autoRenewal: false,
    notes: '[Demo] OSHA-driven quarterly testing program. Findings clean for 3 cycles — propose a downgrade to semi-annual at renewal, justified by the clean record.',
  },
  {
    slug: 'other',
    vendor: { name: 'Iron Mountain (data destruction)', contactName: 'Lillian Vaughn', contactEmail: 'l.vaughn@ironmountain.example', contactTitle: 'Records Account Rep' },
    product: 'Hard drive + media shredding — quarterly pickup, certificate-of-destruction',
    quantity: 4,
    costPerLicense: '3200.00',
    endOffsetDays: 130,
    autoRenewal: true,
    notes: '[Demo] Compliance-driven (HIPAA + customer-data deletion requirements). Per-pound vs flat-fee tradeoff worth modeling — we\'re hitting the flat-fee threshold mostly.',
  },
  // v0.27.0: named auto-renewal trap showcases — high-value contracts whose
  // cancel-by window already passed, so they appear in the Risk Radar
  // "Trap" bucket with realistic context rather than random-vendor filler.
  // cancelByDateDaysAgo is handled by seedNonSaasShowcase() → cancelByDate
  // set to a past date so the trap is visible immediately on a fresh seed.
  {
    slug: 'services',
    vendor: { name: 'Workday Professional Services', contactName: 'Jennifer Kwan', contactEmail: 'j.kwan@workday.example', contactTitle: 'Customer Success Director' },
    product: 'HCM implementation retainer + ongoing managed services (250 hrs/qtr)',
    quantity: 1,
    costPerLicense: '228000.00',
    endOffsetDays: 110,
    autoRenewal: true,
    autoRenewalNoticeDays: 90,
    cancelByDateDaysAgo: 14,
    notes: '[Demo] Missed the 90-day cancellation notice by 14 days — auto-renewed for another year at $228k. Engagement partner confirmed the notice window in the original SOW (page 18, Section 9.2). Legal reviewing whether the renewal clause is enforceable given the ambiguous notice method (email vs. certified mail).',
  },
  {
    slug: 'telecom',
    vendor: { name: 'AT&T Business', contactName: 'Raymond Flores', contactEmail: 'r.flores@att.example', contactTitle: 'Enterprise Account Director' },
    product: 'MPLS WAN — 6 sites, 100Mbps primary + 50Mbps backup per site',
    quantity: 6,
    costPerLicense: '18600.00',
    endOffsetDays: 85,
    autoRenewal: true,
    autoRenewalNoticeDays: 60,
    cancelByDateDaysAgo: 9,
    notes: '[Demo] Missed the 60-day written cancellation notice by 9 days — AT&T auto-renewed all 6 circuits for another 12 months at $111,600. SD-WAN migration was supposed to replace these circuits this quarter. Migration timeline has slipped to Q3; now carrying both costs simultaneously.',
  },
  {
    slug: 'hardware',
    vendor: { name: 'HPE Pointnext', contactName: 'Craig Hoffman', contactEmail: 'c.hoffman@hpe.example', contactTitle: 'Services Account Manager' },
    product: 'ProLiant DL380 Gen10 support (12 servers, 24x7x4 Proactive Care)',
    quantity: 12,
    costPerLicense: '3900.00',
    endOffsetDays: 65,
    autoRenewal: true,
    autoRenewalNoticeDays: 30,
    cancelByDateDaysAgo: 6,
    notes: '[Demo] Missed the 30-day cancellation window by 6 days — renewed at $46,800 for another year. TPM (third-party maintenance) quote from Park Place was $18,200 for the same coverage. Now locked in with HPE for 12 more months before we can switch. Saving the TPM quote for next year.',
  },
  {
    slug: 'other',
    vendor: { name: 'Aramark Uniform Services', contactName: 'Denise Murrow', contactEmail: 'd.murrow@aramark.example', contactTitle: 'Service Sales Manager' },
    product: 'Uniform rental + laundry program — 68 employees, weekly pickup',
    quantity: 1,
    costPerLicense: '31200.00',
    endOffsetDays: 140,
    autoRenewal: true,
    autoRenewalNoticeDays: 60,
    cancelByDateDaysAgo: 11,
    notes: '[Demo] Missed the 60-day cancellation notice by 11 days. Contract rolled for another year at $31,200. Had a competing quote from Cintas at $26,400 (15% less) ready to go. Now waiting for next renewal cycle to make the switch — date is calendared with a 90-day buffer this time.',
  },
];

async function seedNonSaasShowcase(accountId, ownerUserId, prismaClient = prisma) {
  if (!accountId || !ownerUserId) {
    throw new Error('seedNonSaasShowcase: accountId and ownerUserId required');
  }

  // v0.4.2 round-3 (#10) fix: the previous "skip if any non-saas
  // contract exists" check was too aggressive — accounts that got the
  // 7 initial non-SaaS contracts on v0.4.1 then upgraded to v0.4.2
  // would skip the 4 new "Other" entries entirely. Switch to per-slug
  // idempotency: count existing contracts in each NON_SAAS_SHOWCASE
  // category, only seed entries for slugs that currently have zero.
  const cats = await prismaClient.category.findMany({
    where:  { accountId },
    select: { id: true, slug: true },
  });
  const catBySlug = Object.fromEntries(cats.map((c) => [c.slug, c.id]));

  // Per-slug existing-contract counts
  const usedSlugs = [...new Set(NON_SAAS_SHOWCASE.map((s) => s.slug))];
  const slugCounts = await Promise.all(
    usedSlugs.map(async (slug) => {
      const categoryId = catBySlug[slug];
      if (!categoryId) return { slug, count: 0 };
      const count = await prismaClient.contract.count({
        where: { accountId, categoryId },
      });
      return { slug, count };
    })
  );
  const countBySlug = Object.fromEntries(slugCounts.map((x) => [x.slug, x.count]));

  const today = new Date();
  let created = 0;
  const skippedSlugs = [];

  for (const spec of NON_SAAS_SHOWCASE) {
    const categoryId = catBySlug[spec.slug];
    if (!categoryId) {
      console.warn(`[seedNonSaasShowcase] no category for slug '${spec.slug}' on account ${accountId} — skipping`);
      continue;
    }
    // Skip this entry if the slug already has contracts (e.g. seeded
    // on a previous version). Allows v0.4.2's "Other" entries to seed
    // even when v0.4.1's seven non-Other entries are already present.
    if ((countBySlug[spec.slug] || 0) > 0) {
      skippedSlugs.push(spec.slug);
      continue;
    }

    // Create the category-specific vendor (with one contact carrying an
    // email so the Phase 4 brief's Watch For can suggest it).
    const vendor = await prismaClient.vendor.create({
      data: {
        accountId,
        name:             spec.vendor.name,
        vendorType:       spec.vendor.type || spec.slug.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        cotermComplexity: 'none',
        contacts: {
          create: [{
            name:            spec.vendor.contactName,
            email:           spec.vendor.contactEmail,
            title:           spec.vendor.contactTitle,
            lastContactedAt: addDays(today, -rand(2, 80)),
          }],
        },
      },
    });

    const endDate   = addDays(today, spec.endOffsetDays);
    const startDate = addDays(endDate, -365);
    const cost      = parseFloat(spec.costPerLicense);
    const qty       = parseInt(spec.quantity, 10);

    // v0.8.1: pre-baked AI brief for the demo anchor (null for spec
    // entries without a hand-crafted brief — those still get the
    // "Generate brief" UI affordance on first view, exactly like a
    // real customer-created contract).
    const briefFields = briefFieldsForSpec(spec) || {};

    await prismaClient.contract.create({
      data: {
        accountId,
        vendorId:        vendor.id,
        categoryId,
        contractNumber:  `DEMO-${spec.slug.toUpperCase()}-${Math.floor(Math.random() * 9000 + 1000)}`,
        product:         spec.product,
        quantity:        qty,
        costPerLicense:  cost,
        totalValue:      qty * cost,
        startDate,
        endDate,
        evaluationStartByDate: addDays(endDate, -45),
        autoRenewal:     spec.autoRenewal,
        autoRenewalNoticeDays: spec.autoRenewalNoticeDays || null,
        // cancelByDate: if cancelByDateDaysAgo is set, the window has already passed (trap).
        // Otherwise compute forward from noticeDays for normal auto-renewal contracts.
        cancelByDate:    spec.autoRenewal
          ? (spec.cancelByDateDaysAgo != null
              ? new Date(today.getTime() - spec.cancelByDateDaysAgo * 86400000)
              : spec.autoRenewalNoticeDays
                ? new Date(endDate.getTime() - spec.autoRenewalNoticeDays * 86400000)
                : null)
          : null,
        department:      'Operations',
        internalOwnerId: ownerUserId,
        status:          'active',
        notes:           spec.notes,
        ...briefFields,
      },
    });
    created++;
  }

  return { created, skippedSlugs, skipped: created === 0 && skippedSlugs.length > 0 };
}

module.exports = { resetAndSeedDemo, seedAccountForUser, seedNonSaasShowcase, DEMO_ACCOUNT_ID };
