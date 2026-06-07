/**
 * m365Overlap.ts - shared Microsoft 365 license-overlap detection.
 *
 * #19 (contract-section-refresh, 2026-05-29). The product's strongest
 * consolidation narrative is "you are paying for X, but its core function is
 * already bundled in the Microsoft 365 license you already hold." This module
 * is the single source of truth for that detection. Consumers:
 *   1. GET /api/contracts/:id/m365-overlap -> the contract-detail callout
 *      (renders only when this contract is displaceable AND the account holds
 *      a qualifying M365 anchor).
 *   2. routes/contracts.ts /:id/brief -> injects the overlap fact into the AI
 *      renewal-brief context so generated talking points cite it as leverage.
 * A future dedicated "Microsoft 365 Overlap" report consumes
 * computeAccountOverlap() too.
 *
 * Heuristic, advisory only: matches a contract's vendor (canonicalized via
 * vendorAliases) or product-name keywords against an M365 capability bundle
 * map. Tier-aware: E5-only capabilities (Sentinel/Defender, Power BI, Purview)
 * are suppressed unless the account holds an E5 anchor.
 */

const VENDOR_ALIASES = require('./vendorAliases');

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// alias (normalized) -> canonical display name, built once at module load.
const _aliasToCanonical = new Map();
for (const v of VENDOR_ALIASES) {
  _aliasToCanonical.set(norm(v.canonical), v.canonical);
  for (const a of (v.aliases || [])) _aliasToCanonical.set(norm(a), v.canonical);
}
function resolveCanonical(name) {
  const n = norm(name);
  if (!n) return '';
  return _aliasToCanonical.get(n) || (name || '');
}

// Microsoft 365 capability bundle map. `tiers` lists which anchor tier
// includes the capability (E3 capabilities are also in E5, so they list both;
// E5-only capabilities list only E5). `vendors` are canonical displaced-vendor
// names; `keywords` are lowercased product-name substrings (secondary signal).
const M365_BUNDLE = [
  {
    capability: 'Teams (chat, meetings and calling)',
    tiers: ['E3', 'E5'],
    vendors: ['Slack', 'Zoom', 'Webex', 'RingCentral', 'Dialpad', 'Google Workspace'],
    keywords: ['slack', 'zoom', 'webex', 'teams phone', 'voip', 'video conferencing', 'web conferencing', 'unified communications'],
    note: 'Microsoft Teams (chat, meetings, and with the included Teams Phone, calling) ships in your Microsoft 365 plan.',
  },
  {
    capability: 'Entra ID (SSO, MFA and identity)',
    tiers: ['E3', 'E5'],
    vendors: ['Okta', 'OneLogin', 'Ping Identity', 'Duo', 'Auth0'],
    keywords: ['okta', 'onelogin', 'single sign-on', 'single sign on', 'multi-factor', 'identity provider'],
    note: 'Microsoft Entra ID (SSO and MFA, P1) is included in your Microsoft 365 plan; identity governance (P2) comes with E5.',
  },
  {
    capability: 'OneDrive / SharePoint (file storage and sharing)',
    tiers: ['E3', 'E5'],
    vendors: ['Dropbox', 'Box', 'Egnyte'],
    keywords: ['dropbox', 'file storage', 'file sharing', 'cloud storage'],
    note: 'OneDrive and SharePoint file storage and sharing are included in your Microsoft 365 plan.',
  },
  {
    capability: 'Intune (device and endpoint management)',
    tiers: ['E3', 'E5'],
    vendors: ['Jamf', 'Ivanti'],
    keywords: ['jamf', 'intune', 'endpoint management', 'device management', 'mobile device management', 'workspace one'],
    note: 'Microsoft Intune device and endpoint management is included in your Microsoft 365 plan.',
  },
  {
    capability: 'Exchange Online (email and email security)',
    tiers: ['E3', 'E5'],
    vendors: ['Proofpoint', 'Mimecast'],
    keywords: ['email security', 'email archiving', 'secure email gateway'],
    note: 'Exchange Online email with built-in anti-spam and anti-malware is part of your Microsoft 365 plan.',
  },
  {
    capability: 'Sentinel and Defender (SIEM and endpoint security)',
    tiers: ['E5'],
    vendors: ['Splunk', 'CrowdStrike', 'Qualys', 'Rapid7', 'Tenable'],
    keywords: ['splunk', 'sentinel', 'siem', 'crowdstrike', 'endpoint detection', 'edr', 'xdr'],
    note: 'Microsoft Sentinel (SIEM) and Defender (endpoint security) are included in Microsoft 365 E5.',
  },
  {
    capability: 'Power BI Pro (analytics and BI)',
    tiers: ['E5'],
    vendors: ['Tableau', 'Qlik', 'MicroStrategy', 'Looker'],
    keywords: ['tableau', 'qlik', 'power bi', 'business intelligence', 'looker'],
    note: 'Power BI Pro is included in Microsoft 365 E5.',
  },
  {
    capability: 'Purview (eDiscovery, DLP and compliance)',
    tiers: ['E5'],
    vendors: [],
    keywords: ['ediscovery', 'e-discovery', 'data loss prevention', 'compliance archiving', 'legal hold'],
    note: 'Microsoft Purview (eDiscovery, DLP, and compliance archiving) is included in Microsoft 365 E5.',
  },
];

// Vendors in the Microsoft family that should NEVER be flagged as displaced
// by an M365 anchor (Azure, GitHub, etc. are not bundled into M365 seats).
const _MS_FAMILY = new Set(['Microsoft', 'Microsoft 365', 'Microsoft Azure', 'GitHub', 'LinkedIn']);

// Mirror routes/reports.ts contractSpend() precedence so the report and the
// callout agree on "spend at stake".
function spendOf(c) {
  const qty = c.quantity ? parseInt(c.quantity, 10) : null;
  const negotiated = c.finalNegotiatedPrice != null ? parseFloat(String(c.finalNegotiatedPrice)) : null;
  const list = c.costPerLicense != null ? parseFloat(String(c.costPerLicense)) : null;
  if (qty != null && negotiated != null) return qty * negotiated;
  if (qty != null && list != null) return qty * list;
  if (c.totalValue != null) return parseFloat(String(c.totalValue));
  return 0;
}

// Returns 'E3' | 'E5' if the row IS a Microsoft 365 suite license, else null.
// Plain "Microsoft Azure" etc. are NOT anchors (they do not bundle seats).
function anchorTierOf(row) {
  const p = String(row.product || '').toLowerCase();
  const vn = String(row.vendorName || '').toLowerCase();
  const canon = resolveCanonical(row.vendorName);
  const isSuite =
    canon === 'Microsoft 365' ||
    /m365|microsoft\s*365|office\s*365|o365|office365/.test(p) ||
    /m365|microsoft\s*365|office\s*365|o365|office365/.test(vn);
  if (!isSuite) return null;
  return /e5/i.test(p) ? 'E5' : 'E3';
}

function matchBundle(row, effectiveTier) {
  const canon = resolveCanonical(row.vendorName);
  const vn = norm(row.vendorName);
  const p = String(row.product || '').toLowerCase();
  for (const e of M365_BUNDLE) {
    if (!e.tiers.includes(effectiveTier)) continue;
    const vendorHit = e.vendors.some((v) => {
      const cn = norm(v);
      return canon === v || vn === cn || (cn.length >= 4 && vn.startsWith(cn));
    });
    const kwHit = e.keywords.some((k) => p.includes(k));
    if (vendorHit || kwHit) return e;
  }
  return null;
}

// rows: [{ id, product, vendorName, department, spend }]
function computeAccountOverlap(rows) {
  const decorated = (rows || []).map((r) => ({ ...r, _tier: anchorTierOf(r) }));
  const anchors = decorated.filter((r) => r._tier);
  if (anchors.length === 0) {
    return { hasAnchor: false, anchorTier: null, anchor: null, overlaps: [], totalSpendAtStake: 0 };
  }
  const effectiveTier = anchors.some((a) => a._tier === 'E5') ? 'E5' : 'E3';
  const anchor = anchors.slice().sort((a, b) => {
    if (a._tier !== b._tier) return a._tier === 'E5' ? -1 : 1;
    return (b.spend || 0) - (a.spend || 0);
  })[0];
  const anchorIds = new Set(anchors.map((a) => a.id));

  const overlaps = [];
  for (const r of decorated) {
    if (anchorIds.has(r.id)) continue;
    const canon = resolveCanonical(r.vendorName);
    if (_MS_FAMILY.has(canon)) continue;
    const entry = matchBundle(r, effectiveTier);
    if (!entry) continue;
    overlaps.push({
      contractId: r.id,
      product: r.product,
      vendorName: r.vendorName,
      department: r.department || null,
      spend: r.spend || 0,
      capability: entry.capability,
      note: entry.note,
      requiresTier: entry.tiers.includes('E3') ? 'E3' : 'E5',
    });
  }
  overlaps.sort((a, b) => b.spend - a.spend);
  const totalSpendAtStake = overlaps.reduce((s, o) => s + (o.spend || 0), 0);

  return {
    hasAnchor: true,
    anchorTier: effectiveTier,
    anchor: { id: anchor.id, product: anchor.product, vendorName: anchor.vendorName, tier: anchor._tier },
    overlaps,
    totalSpendAtStake,
  };
}

// Per-contract: returns the callout payload for ONE contract, or null when it
// is not displaceable / is itself the anchor / no anchor exists.
function overlapForContract(rows, contractId) {
  const result = computeAccountOverlap(rows);
  if (!result.hasAnchor) return null;
  const hit = result.overlaps.find((o) => o.contractId === contractId);
  if (!hit) return null;
  return {
    capability: hit.capability,
    note: hit.note,
    requiresTier: hit.requiresTier,
    anchorTier: result.anchorTier,
    anchor: result.anchor,
    spend: hit.spend,
  };
}

// ---- Prisma-backed loaders (the route layer calls these) -------------------

async function loadOverlapRows(prisma, accountId, scopeWhere) {
  const contracts = await prisma.contract.findMany({
    take: 2000,
    where: {
      accountId,
      archivedAt: null,
      status: { in: ['active', 'under_review'] },
      ...(scopeWhere || {}),
    },
    select: {
      id: true, product: true, department: true,
      totalValue: true, finalNegotiatedPrice: true, quantity: true, costPerLicense: true,
      vendor: { select: { name: true } },
    },
  });
  return contracts.map((c) => ({
    id: c.id,
    product: c.product || '',
    vendorName: c.vendor && c.vendor.name ? c.vendor.name : '',
    department: c.department || null,
    spend: spendOf(c),
  }));
}

async function m365OverlapForContract(prisma, opts) {
  const { accountId, contractId, scopeWhere } = opts || {};
  const rows = await loadOverlapRows(prisma, accountId, scopeWhere);
  return overlapForContract(rows, contractId);
}

async function computeM365OverlapForAccount(prisma, opts) {
  const { accountId, scopeWhere } = opts || {};
  const rows = await loadOverlapRows(prisma, accountId, scopeWhere);
  return computeAccountOverlap(rows);
}

module.exports = {
  M365_BUNDLE,
  norm,
  resolveCanonical,
  anchorTierOf,
  spendOf,
  computeAccountOverlap,
  overlapForContract,
  loadOverlapRows,
  m365OverlapForContract,
  computeM365OverlapForAccount,
};

export {};