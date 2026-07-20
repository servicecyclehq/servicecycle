'use strict';

/**
 * routes/adminOpportunities.ts
 * ----------------------------
 * Revenue Intelligence module — super_admin-only, cross-tenant field-intelligence
 * feed. SC is the DETECTOR; the acquirer's CRM is the MANAGER. This surface never
 * manages a pipeline (no stages, no owners, no forecasting) — it only surfaces
 * condition-driven pull-through opportunities the platform can see and a CRM cannot.
 *
 * Mounted at /api/admin (alongside admin.ts). Every route is requireSuperAdmin —
 * NEVER reachable by a tenant/customer login. Cross-tenant by design: no accountId
 * scoping. authenticateToken is applied at the mount in index.ts.
 *
 *   GET  /api/admin/opportunities        full intelligence feed (read-only)
 *   GET  /api/admin/rate-sheet           platform pricing inputs (singleton)
 *   PUT  /api/admin/rate-sheet           update pricing inputs
 *   POST /api/admin/rate-sheet/confirm   re-affirm rates are current (audit trail)
 */

const express = require('express');
import prisma from '../lib/prisma';
const { requireSuperAdmin } = require('../middleware/roles');
const { writeLog: writeActivityLog } = require('../lib/activityLog');

const router = express.Router();

// Defense-in-depth: every route below is also individually requireSuperAdmin-gated;
// gating the whole router too means a future route added here without the per-route
// guard can never expose this cross-tenant feed to a regular tenant user.
router.use(requireSuperAdmin);

// ── Constants ────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const MONTH_MS = 30.44 * DAY_MS;

// Safety-critical equipment whose post-study modification can invalidate an arc
// flash study / label. Maps the spec's intent (CIRCUIT_BREAKER, TRANSFORMER,
// SWITCHGEAR, PROTECTION_RELAY, MCC) onto the real EquipmentType enum (which
// splits transformers into liquid/dry).
const SAFETY_CRITICAL_TYPES = [
  'CIRCUIT_BREAKER',
  'TRANSFORMER_LIQUID',
  'TRANSFORMER_DRY',
  'SWITCHGEAR',
  'PROTECTION_RELAY',
  'MCC',
];

// Equipment that receives an arc flash label / is enumerated as a "panel" in a
// study scope — used to size the per-panel study estimate.
const PANEL_TYPES = ['PANELBOARD', 'SWITCHBOARD', 'SWITCHGEAR', 'MCC', 'ARC_FLASH_PANEL'];

// Trip/calibration test types used to gauge protective-device PM currency.
const TRIP_TEST_TYPES = ['breaker_trip_test', 'relay_calibration', 'primary_injection'];

// ── Helpers ──────────────────────────────────────────────────────────────────

const num = (v: any): number => (typeof v === 'bigint' ? Number(v) : (v == null ? 0 : Number(v)));
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function daysUntil(date: Date | null, now: number): number {
  if (!date) return 0;
  return Math.floor((new Date(date).getTime() - now) / DAY_MS);
}
function monthsSince(date: Date | null, now: number): number {
  if (!date) return Infinity;
  return Math.floor((now - new Date(date).getTime()) / MONTH_MS);
}

const TYPE_LABELS: Record<string, string> = {
  CIRCUIT_BREAKER: 'Circuit Breaker',
  TRANSFORMER_LIQUID: 'Transformer (Liquid)',
  TRANSFORMER_DRY: 'Transformer (Dry)',
  SWITCHGEAR: 'Switchgear',
  SWITCHBOARD: 'Switchboard',
  PANELBOARD: 'Panelboard',
  MCC: 'Motor Control Center',
  PROTECTION_RELAY: 'Protection Relay',
};
function prettyType(t: string | null | undefined): string {
  if (!t) return 'Equipment';
  if (TYPE_LABELS[t]) return TYPE_LABELS[t];
  return String(t).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function displayAssetName(a: { manufacturer?: any; model?: any; serialNumber?: any; equipmentType?: any }): string {
  const parts = [a.manufacturer, a.model].filter(Boolean);
  const joined = parts.join(' ').trim();
  if (joined) return joined;
  if (a.serialNumber) return `S/N ${a.serialNumber}`;
  return prettyType(a.equipmentType);
}

const centsToUsd = (c: number): string =>
  '$' + Math.round(c / 100).toLocaleString('en-US');

// Map a real EquipmentType onto a rate-sheet equipmentReplacementRanges key.
function replacementKey(etype: string): string | null {
  if (etype === 'CIRCUIT_BREAKER') return 'CIRCUIT_BREAKER';
  if (etype === 'TRANSFORMER_LIQUID' || etype === 'TRANSFORMER_DRY') return 'TRANSFORMER';
  if (etype === 'SWITCHGEAR') return 'SWITCHGEAR';
  if (etype === 'MCC') return 'MCC';
  return null;
}

// ── Rate-sheet status + estimate logic ───────────────────────────────────────

function isRateSheetConfigured(rs: any): boolean {
  if (!rs) return false;
  const monetary = [
    rs.arcFlashStudyPerPanelCents,
    rs.arcFlashStudyMinimumCents,
    rs.arcFlashStudyMaximumCents,
    rs.pmServiceHourlyRateCents,
    rs.pmVisitMinimumCents,
    rs.oneLineDiagramCreationCents,
  ];
  if (monetary.some((v) => v != null)) return true;
  const ranges = rs.equipmentReplacementRanges;
  return !!(ranges && typeof ranges === 'object' && Object.keys(ranges).length > 0);
}

function rateSheetStatus(rs: any, now: number): 'not_configured' | 'fresh' | 'stale' {
  if (!isRateSheetConfigured(rs)) return 'not_configured';
  const touchedAt = Math.max(
    rs.lastConfirmedAt ? new Date(rs.lastConfirmedAt).getTime() : 0,
    rs.updatedAt ? new Date(rs.updatedAt).getTime() : 0,
  );
  const ageDays = (now - touchedAt) / DAY_MS;
  return ageDays <= (rs.expiresAfterDays ?? 180) ? 'fresh' : 'stale';
}

type Estimate = { low: number | null; high: number | null; detail: string | null };

// Arc flash study estimate: panels x per-panel, clamped to site min/max, with a
// 1.5x complexity-variance upper bound. Only produced when the rate sheet is fresh.
function studyEstimate(panels: number, rs: any, status: string): Estimate {
  if (status !== 'fresh' || !rs) return { low: null, high: null, detail: null };
  const per = rs.arcFlashStudyPerPanelCents;
  const min = rs.arcFlashStudyMinimumCents;
  const max = rs.arcFlashStudyMaximumCents;

  if (per != null && panels > 0) {
    const point = panels * per;
    let low = point;
    let high = Math.round(point * 1.5);
    if (min != null) { low = Math.max(low, min); high = Math.max(high, min); }
    if (max != null) { low = Math.min(low, max); high = Math.min(high, max); }
    const detail =
      `${panels} panels × ${centsToUsd(per)}/panel = ${centsToUsd(point)}. ` +
      `Range reflects typical study complexity variance.`;
    return { low, high, detail };
  }
  if (min != null || max != null) {
    // Guard against a misconfigured rate sheet (min > max) producing an inverted range.
    const a = min ?? max;
    const b = max ?? min;
    return { low: Math.min(a, b), high: Math.max(a, b), detail: 'Flat study range from rate sheet (no per-panel rate set).' };
  }
  return { low: null, high: null, detail: null };
}

// System-change estimate: prefer the changed equipment's replacement/upgrade
// range; otherwise fall back to a site study refresh estimate.
function systemChangeEstimate(etype: string, sitePanels: number, rs: any, status: string): Estimate {
  if (status !== 'fresh' || !rs) return { low: null, high: null, detail: null };
  const key = replacementKey(etype);
  const ranges = rs.equipmentReplacementRanges;
  if (key && ranges && ranges[key] && (ranges[key].min != null || ranges[key].max != null)) {
    const low = ranges[key].min ?? ranges[key].max;
    const high = ranges[key].max ?? ranges[key].min;
    return {
      low,
      high,
      detail: `${prettyType(etype)} replacement/upgrade range from rate sheet.`,
    };
  }
  const est = studyEstimate(sitePanels, rs, status);
  if (est.detail) est.detail = 'Study refresh after equipment change. ' + est.detail;
  return est;
}

// ── Composite score (0-100) — Arc Flash Study Pipeline ───────────────────────

function studyScore(p: {
  daysUntilExpiry: number;
  systemChanges: number;
  drift: number;
  monthsSinceTrip: number;
  incomplete: number;
  total: number;
  oneLineOnFile: boolean;
}): number {
  let s = 0;
  // Expiry horizon — 40 pts max
  const d = p.daysUntilExpiry;
  if (d < -180) s += 40;
  else if (d < -90) s += 35;
  else if (d < 0) s += 30;
  else if (d < 60) s += 20;
  else if (d < 120) s += 10;
  // System changes since last study — 25 pts max
  if (p.systemChanges >= 3) s += 25;
  else if (p.systemChanges === 2) s += 18;
  else if (p.systemChanges === 1) s += 10;
  // Drift-flagged devices — 15 pts max
  if (p.drift >= 3) s += 15;
  else if (p.drift === 2) s += 10;
  else if (p.drift === 1) s += 5;
  // Protective-device PM currency (trip-test age) — 10 pts max
  const m = p.monthsSinceTrip;
  if (m > 36) s += 10;
  else if (m >= 24) s += 7;
  else if (m >= 12) s += 3;
  // Nameplate incompleteness — 5 pts max
  const pct = p.total > 0 ? p.incomplete / p.total : 0;
  if (pct > 0.5) s += 5;
  else if (pct >= 0.25) s += 3;
  // One-line diagram missing — 5 pts
  if (!p.oneLineOnFile) s += 5;
  return clamp(Math.round(s), 0, 100);
}

function systemChangeScore(daysSinceStudy: number, etype: string): number {
  let age = 12;
  if (daysSinceStudy > 1825) age = 40;
  else if (daysSinceStudy > 1095) age = 30;
  else if (daysSinceStudy > 730) age = 20;
  let weight = 15;
  if (etype === 'CIRCUIT_BREAKER' || etype === 'SWITCHGEAR') weight = 25;
  else if (etype === 'TRANSFORMER_LIQUID' || etype === 'TRANSFORMER_DRY') weight = 22;
  else if (etype === 'PROTECTION_RELAY') weight = 20;
  else if (etype === 'MCC') weight = 18;
  return clamp(age + weight + 10, 0, 100);
}

function noStudyScore(assetCount: number, monthsOld: number): number {
  const assetScore = Math.min(60, assetCount * 2);
  const ageScore = Math.min(40, (monthsOld === Infinity ? 20 : monthsOld) * 2);
  return clamp(Math.round(assetScore + ageScore), 0, 100);
}

// ── Rate sheet persistence helper ────────────────────────────────────────────

async function getOrCreateRateSheet() {
  let rs = await prisma.rateSheet.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (!rs) rs = await prisma.rateSheet.create({ data: {} });
  return rs;
}

// Serialize a rate sheet for the client: append fresh/stale status + resolved
// user names for the updated-by / confirmed-by audit fields.
async function rateSheetPayload(rs: any) {
  const ids = [rs.updatedById, rs.lastConfirmedById].filter(Boolean) as string[];
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  return {
    ...rs,
    status: rateSheetStatus(rs, Date.now()),
    updatedByName: rs.updatedById ? (nameById.get(rs.updatedById) || null) : null,
    lastConfirmedByName: rs.lastConfirmedById ? (nameById.get(rs.lastConfirmedById) || null) : null,
  };
}

// ── GET /api/admin/opportunities ─────────────────────────────────────────────

router.get('/opportunities', requireSuperAdmin, async (req: any, res: any) => {
  try {
    const now = Date.now();
    // Audit the cross-tenant read: a super_admin viewing every tenant's contact
    // book + pipeline should leave a trail (the rate-sheet confirm path logs; this
    // read previously did not). Fire-and-forget; never block the response.
    writeActivityLog({
      assetId: null,
      userId: req.user?.id ?? null,
      accountId: req.user?.accountId ?? null,
      action: 'revenue_intel_viewed',
      details: { surface: 'opportunities' },
    });
    const oneYearAgo = now - 365 * DAY_MS;
    const twelveMonthsAgo = oneYearAgo; // identical 1-year cutoff; named alias for readability

    // ── Bulk loads (cross-tenant) ──────────────────────────────────────────
    const [
      accounts,
      sites,
      studies,
      assetBySite,
      assetByAccount,
      deviceBySite,
      safetyWOs,
      woByAccount,
      immDefs,
      qrAccounts,
      admins,
      rs,
    ] = await Promise.all([
      prisma.account.findMany({
        select: { id: true, companyName: true, createdAt: true },
      }),
      prisma.site.findMany({
        where: { archivedAt: null },
        select: {
          id: true, accountId: true, name: true,
          primaryContactName: true, primaryContactEmail: true, primaryContactPhone: true,
          oneLineDiagramOnFile: true, oneLineDiagramDate: true, createdAt: true,
        },
      }),
      prisma.systemStudy.findMany({
        where: { studyType: 'arc_flash' },
        select: { accountId: true, siteId: true, performedDate: true, expiresAt: true },
      }),
      prisma.$queryRaw<any[]>`
        SELECT "siteId",
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE "nameplateData" IS NULL OR "nameplateData"::text = '{}')::int AS incomplete,
               COUNT(*) FILTER (WHERE "equipmentType" IN ('PANELBOARD','SWITCHBOARD','SWITCHGEAR','MCC','ARC_FLASH_PANEL'))::int AS panels
        FROM "assets" WHERE "archivedAt" IS NULL GROUP BY "siteId"`,
      prisma.$queryRaw<any[]>`
        SELECT "accountId", COUNT(*)::int AS total
        FROM "assets" WHERE "archivedAt" IS NULL GROUP BY "accountId"`,
      prisma.$queryRaw<any[]>`
        SELECT "siteId",
               COUNT(*) FILTER (WHERE "driftFlagged")::int AS drift,
               COUNT(*) FILTER (WHERE "matchesStudy" = false)::int AS nomatch,
               MAX("testDate") FILTER (WHERE "testType" IN ('breaker_trip_test','relay_calibration','primary_injection')) AS last_trip
        FROM "device_test_records" GROUP BY "siteId"`,
      prisma.$queryRaw<any[]>`
        SELECT wo."id" AS wo_id, wo."completedDate" AS completed, wo."notes" AS notes,
               a."equipmentType" AS etype, a."manufacturer" AS manufacturer, a."model" AS model,
               a."serialNumber" AS serial, a."siteId" AS site_id, a."accountId" AS account_id
        FROM "work_orders" wo
        JOIN "assets" a ON a."id" = wo."assetId"
        WHERE wo."status" = 'COMPLETE' AND wo."completedDate" IS NOT NULL
          AND a."equipmentType" IN ('CIRCUIT_BREAKER','TRANSFORMER_LIQUID','TRANSFORMER_DRY','SWITCHGEAR','PROTECTION_RELAY','MCC')`,
      prisma.$queryRaw<any[]>`
        SELECT "accountId", MAX("completedDate") AS last_completed
        FROM "work_orders" WHERE "status" = 'COMPLETE' AND "completedDate" IS NOT NULL GROUP BY "accountId"`,
      prisma.deficiency.findMany({
        where: { severity: 'IMMEDIATE', resolvedAt: null },
        select: {
          accountId: true, createdAt: true,
          asset: { select: { manufacturer: true, model: true, serialNumber: true, equipmentType: true } },
        },
      }),
      prisma.quoteRequest.findMany({ select: { accountId: true }, distinct: ['accountId'] }),
      prisma.user.findMany({
        where: { role: 'admin' },
        select: { accountId: true, name: true, email: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.rateSheet.findFirst({ orderBy: { updatedAt: 'desc' } }),
    ]);

    const status = rateSheetStatus(rs, now);

    // ── Index maps ─────────────────────────────────────────────────────────
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    const sitesById = new Map(sites.map((s) => [s.id, s]));
    const sitesByAccount = new Map<string, any[]>();
    for (const s of sites) {
      if (!sitesByAccount.has(s.accountId)) sitesByAccount.set(s.accountId, []);
      sitesByAccount.get(s.accountId)!.push(s);
    }
    const adminByAccount = new Map<string, any>();
    for (const u of admins) if (!adminByAccount.has(u.accountId)) adminByAccount.set(u.accountId, u);

    const assetSite = new Map(assetBySite.map((r) => [r.siteId, r]));
    const assetAcct = new Map(assetByAccount.map((r) => [r.accountId, num(r.total)]));
    const deviceSite = new Map(deviceBySite.map((r) => [r.siteId, r]));
    const lastCompletedByAccount = new Map(woByAccount.map((r) => [r.accountId, r.last_completed]));
    const qrSet = new Set(qrAccounts.map((q) => q.accountId));

    // Most-recent arc-flash study per site + the set of accounts that have any.
    const studyBySite = new Map<string, { performedDate: Date; expiresAt: Date }>();
    const accountsWithStudy = new Set<string>();
    for (const st of studies) {
      accountsWithStudy.add(st.accountId);
      const cur = studyBySite.get(st.siteId);
      if (!cur || new Date(st.performedDate) > new Date(cur.performedDate)) {
        studyBySite.set(st.siteId, { performedDate: st.performedDate as any, expiresAt: st.expiresAt as any });
      }
    }

    // System changes per site (completed WO on safety-critical asset after study).
    const sysChangeCountBySite = new Map<string, number>();
    for (const wo of safetyWOs) {
      const st = studyBySite.get(wo.site_id);
      if (st && new Date(wo.completed) > new Date(st.performedDate)) {
        sysChangeCountBySite.set(wo.site_id, (sysChangeCountBySite.get(wo.site_id) || 0) + 1);
      }
    }

    // Contact resolution. Site-level uses the site's primary contact; account-level
    // falls back across sites then the account's oldest admin user. The internal
    // service rep is intentionally NOT used — these are customer-facing CRM contacts.
    function siteContact(site: any) {
      const acctContact = accountContact(site.accountId);
      return {
        contactName: site.primaryContactName || acctContact.contactName,
        contactEmail: site.primaryContactEmail || acctContact.contactEmail,
        contactPhone: site.primaryContactPhone || acctContact.contactPhone,
      };
    }
    function accountContact(accountId: string) {
      const list = sitesByAccount.get(accountId) || [];
      const withName = list.find((s) => s.primaryContactName) || null;
      const withEmail = list.find((s) => s.primaryContactEmail) || null;
      const withPhone = list.find((s) => s.primaryContactPhone) || null;
      const admin = adminByAccount.get(accountId);
      return {
        contactName: (withName && withName.primaryContactName) || admin?.name || null,
        contactEmail: (withEmail && withEmail.primaryContactEmail) || admin?.email || null,
        contactPhone: (withPhone && withPhone.primaryContactPhone) || null,
      };
    }

    // ── 1. Arc Flash Study Pipeline (per site with a study) ────────────────
    const studyOpportunities = [];
    for (const site of sites) {
      const st = studyBySite.get(site.id);
      if (!st) continue;
      const acct = accountById.get(site.accountId);
      const ag = assetSite.get(site.id) || { total: 0, incomplete: 0, panels: 0 };
      const dv = deviceSite.get(site.id) || { drift: 0, nomatch: 0, last_trip: null };
      const dExp = daysUntil(st.expiresAt, now);
      const sysChanges = sysChangeCountBySite.get(site.id) || 0;
      const drift = num(dv.drift);
      const total = num(ag.total);
      const incomplete = num(ag.incomplete);
      const panels = num(ag.panels);
      const mTrip = monthsSince(dv.last_trip ? new Date(dv.last_trip) : null, now);

      let planningStatus: string;
      if (dExp < 0) planningStatus = 'expired';
      else if (dExp < 60) planningStatus = 'critical';
      else if (dExp < 120) planningStatus = 'warning';
      else planningStatus = 'ok';

      const score = studyScore({
        daysUntilExpiry: dExp, systemChanges: sysChanges, drift,
        monthsSinceTrip: mTrip, incomplete, total, oneLineOnFile: site.oneLineDiagramOnFile,
      });
      const est = studyEstimate(panels, rs, status);

      studyOpportunities.push({
        accountId: site.accountId,
        accountName: acct?.companyName || 'Unknown',
        siteId: site.id,
        siteName: site.name,
        ...siteContact(site),
        studyPerformedDate: st.performedDate,
        studyExpiresAt: st.expiresAt,
        daysUntilExpiry: dExp,
        planningStatus,
        systemChangesSinceStudy: sysChanges,
        driftFlaggedDevices: drift,
        matchesStudyFalse: num(dv.nomatch),
        incompleteNameplateAssets: incomplete,
        totalAssets: total,
        oneLineDiagramOnFile: site.oneLineDiagramOnFile,
        estimatedRangeLowCents: est.low,
        estimatedRangeHighCents: est.high,
        estimatedRangeCalcDetail: est.detail,
        score,
        quoteRequestExists: qrSet.has(site.accountId),
      });
    }
    studyOpportunities.sort((a, b) => b.score - a.score);

    // ── 2. System-Change Alerts (per WO event, study > 1yr old) ────────────
    const systemChangeOpportunities = [];
    for (const wo of safetyWOs) {
      const st = studyBySite.get(wo.site_id);
      if (!st) continue;
      const performedMs = new Date(st.performedDate).getTime();
      if (!(new Date(wo.completed).getTime() > performedMs)) continue;
      if (!(performedMs < oneYearAgo)) continue; // study must be > 1 year old
      const site = sitesById.get(wo.site_id);
      const acct = accountById.get(wo.account_id);
      const ag = assetSite.get(wo.site_id) || { panels: 0, total: 0 };
      const panels = num(ag.panels);
      const daysSinceStudy = Math.floor((now - performedMs) / DAY_MS);
      const est = systemChangeEstimate(wo.etype, panels, rs, status);
      systemChangeOpportunities.push({
        accountId: wo.account_id,
        accountName: acct?.companyName || 'Unknown',
        siteName: site?.name || 'Unknown site',
        ...(site ? siteContact(site) : accountContact(wo.account_id)),
        assetName: displayAssetName(wo),
        assetType: wo.etype,
        workOrderCompletedAt: wo.completed,
        workOrderDescription: wo.notes || null,
        studyPerformedDate: st.performedDate,
        daysSinceStudy,
        totalAssets: num(assetAcct.get(wo.account_id)),
        score: systemChangeScore(daysSinceStudy, wo.etype),
        estimatedRangeLowCents: est.low,
        estimatedRangeHighCents: est.high,
        estimatedRangeCalcDetail: est.detail,
      });
    }
    systemChangeOpportunities.sort((a, b) => b.score - a.score);

    // ── 3. No Arc Flash Study on Record (accounts w/ assets, no study) ─────
    const noStudyAccounts = [];
    for (const acct of accounts) {
      const assetCount = num(assetAcct.get(acct.id));
      if (assetCount <= 0) continue;
      if (accountsWithStudy.has(acct.id)) continue;
      const monthsOld = monthsSince(acct.createdAt, now);
      noStudyAccounts.push({
        accountId: acct.id,
        accountName: acct.companyName,
        ...accountContact(acct.id),
        assetCount,
        createdAt: acct.createdAt,
        score: noStudyScore(assetCount, monthsOld),
      });
    }
    noStudyAccounts.sort((a, b) => b.score - a.score);

    // ── 4. Open IMMEDIATE Deficiencies (per account) ───────────────────────
    const defByAccount = new Map<string, { count: number; oldest: Date; names: string[] }>();
    for (const d of immDefs) {
      let e = defByAccount.get(d.accountId);
      if (!e) { e = { count: 0, oldest: d.createdAt as any, names: [] }; defByAccount.set(d.accountId, e); }
      e.count += 1;
      if (new Date(d.createdAt) < new Date(e.oldest)) e.oldest = d.createdAt as any;
      if (e.names.length < 3 && d.asset) {
        const nm = displayAssetName(d.asset);
        if (!e.names.includes(nm)) e.names.push(nm);
      }
    }
    const immediateDeficiencies = [];
    for (const [accountId, e] of defByAccount) {
      const acct = accountById.get(accountId);
      immediateDeficiencies.push({
        accountId,
        accountName: acct?.companyName || 'Unknown',
        ...accountContact(accountId),
        count: e.count,
        oldestOpenedAt: e.oldest,
        assetNames: e.names,
      });
    }
    immediateDeficiencies.sort((a, b) => b.count - a.count);

    // ── 5. Dormant Accounts (serviced before, but not in 12+ months) ───────
    // ── 6. Greenfield Accounts (have assets, never serviced) ───────────────
    const dormantAccounts = [];
    const greenfieldAccounts = [];
    for (const acct of accounts) {
      const assetCount = num(assetAcct.get(acct.id));
      if (assetCount <= 0) continue;
      const last = lastCompletedByAccount.get(acct.id);
      if (last) {
        const lastMs = new Date(last).getTime();
        if (lastMs < twelveMonthsAgo) {
          dormantAccounts.push({
            accountId: acct.id,
            accountName: acct.companyName,
            ...accountContact(acct.id),
            lastCompletedAt: last,
            monthsSinceActivity: monthsSince(new Date(last), now),
            assetCount,
          });
        }
      } else {
        greenfieldAccounts.push({
          accountId: acct.id,
          accountName: acct.companyName,
          ...accountContact(acct.id),
          assetCount,
          createdAt: acct.createdAt,
          monthsSinceCreation: monthsSince(acct.createdAt, now),
        });
      }
    }
    dormantAccounts.sort((a, b) => b.monthsSinceActivity - a.monthsSinceActivity);
    greenfieldAccounts.sort((a, b) => b.assetCount - a.assetCount);

    // ── Platform totals ────────────────────────────────────────────────────
    let totalDriftRisks = 0;
    for (const r of deviceBySite) totalDriftRisks += num(r.drift);

    const summary = {
      totalExpiredStudies: studyOpportunities.filter((o) => o.planningStatus === 'expired').length,
      totalCriticalStudies: studyOpportunities.filter((o) => o.planningStatus === 'critical').length,
      totalWarningStudies: studyOpportunities.filter((o) => o.planningStatus === 'warning').length,
      totalSystemChangeAlerts: systemChangeOpportunities.length,
      totalDriftRisks,
      totalImmediateDeficiencies: immDefs.length,
      totalDormant: dormantAccounts.length,
      totalGreenfield: greenfieldAccounts.length,
      totalNoStudy: noStudyAccounts.length,
      rateSheetLastConfirmed: rs?.lastConfirmedAt ?? null,
    };

    return res.json({
      success: true,
      data: {
        rateSheetStatus: status,
        rateSheetExpiresAfterDays: rs?.expiresAfterDays ?? 180,
        rateSheetLastConfirmedAt: rs?.lastConfirmedAt ?? null,
        rateSheetUpdatedAt: rs?.updatedAt ?? null,
        studyOpportunities,
        systemChangeOpportunities,
        noStudyAccounts,
        immediateDeficiencies,
        dormantAccounts,
        greenfieldAccounts,
        summary,
        generatedAt: new Date(now).toISOString(),
      },
    });
  } catch (err: any) {
    console.error('[adminOpportunities] feed error:', err?.message, err?.stack);
    return res.status(500).json({ success: false, error: 'Failed to build opportunities feed' });
  }
});

// ── GET /api/admin/rate-sheet ────────────────────────────────────────────────

router.get('/rate-sheet', requireSuperAdmin, async (_req: any, res: any) => {
  try {
    const rs = await getOrCreateRateSheet();
    return res.json({ success: true, data: await rateSheetPayload(rs) });
  } catch (err: any) {
    console.error('[adminOpportunities] rate-sheet GET error:', err?.message);
    return res.status(500).json({ success: false, error: 'Failed to load rate sheet' });
  }
});

// ── PUT /api/admin/rate-sheet ────────────────────────────────────────────────

const INT_FIELDS = [
  'arcFlashStudyPerPanelCents',
  'arcFlashStudyMinimumCents',
  'arcFlashStudyMaximumCents',
  'pmServiceHourlyRateCents',
  'pmVisitMinimumCents',
  'oneLineDiagramCreationCents',
  'expiresAfterDays',
];

router.put('/rate-sheet', requireSuperAdmin, async (req: any, res: any) => {
  try {
    const body = req.body || {};
    const data: any = {};

    for (const f of INT_FIELDS) {
      if (!(f in body)) continue;
      const v = body[f];
      if (v === null || v === '') {
        if (f === 'expiresAfterDays') continue; // never null the NOT NULL column
        data[f] = null;
        continue;
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        return res.status(400).json({ success: false, error: `${f} must be a non-negative integer (cents)` });
      }
      data[f] = n;
    }

    if ('equipmentReplacementRanges' in body) {
      const r = body.equipmentReplacementRanges;
      if (r !== null && (typeof r !== 'object' || Array.isArray(r))) {
        return res.status(400).json({ success: false, error: 'equipmentReplacementRanges must be an object or null' });
      }
      // Normalize: keep only {min,max} integer-cents (or null) per known key.
      if (r) {
        const clean: any = {};
        for (const [k, val] of Object.entries(r as Record<string, any>)) {
          if (!val || typeof val !== 'object') continue;
          const min = val.min == null || val.min === '' ? null : Number(val.min);
          const max = val.max == null || val.max === '' ? null : Number(val.max);
          if ((min != null && (!Number.isFinite(min) || min < 0)) || (max != null && (!Number.isFinite(max) || max < 0))) {
            return res.status(400).json({ success: false, error: `equipmentReplacementRanges.${k} must use non-negative cents` });
          }
          if (min == null && max == null) continue;
          clean[k] = { min: min == null ? null : Math.round(min), max: max == null ? null : Math.round(max) };
        }
        data.equipmentReplacementRanges = clean;
      } else {
        data.equipmentReplacementRanges = null;
      }
    }

    data.updatedById = req.user?.id ?? null;

    const existing = await getOrCreateRateSheet();

    // Reject an inverted arc-flash study range (min > max) so the feed never shows
    // a "$X – $Y" with X > Y. Validate the effective values (incoming or existing).
    const effMin = 'arcFlashStudyMinimumCents' in data ? data.arcFlashStudyMinimumCents : existing.arcFlashStudyMinimumCents;
    const effMax = 'arcFlashStudyMaximumCents' in data ? data.arcFlashStudyMaximumCents : existing.arcFlashStudyMaximumCents;
    if (effMin != null && effMax != null && effMin > effMax) {
      return res.status(400).json({ success: false, error: 'arcFlashStudyMinimumCents cannot exceed arcFlashStudyMaximumCents' });
    }

    const rs = await prisma.rateSheet.update({ where: { id: existing.id }, data });
    return res.json({ success: true, data: await rateSheetPayload(rs) });
  } catch (err: any) {
    console.error('[adminOpportunities] rate-sheet PUT error:', err?.message);
    return res.status(500).json({ success: false, error: 'Failed to update rate sheet' });
  }
});

// ── POST /api/admin/rate-sheet/confirm ───────────────────────────────────────

router.post('/rate-sheet/confirm', requireSuperAdmin, async (req: any, res: any) => {
  try {
    const existing = await getOrCreateRateSheet();
    const rs = await prisma.rateSheet.update({
      where: { id: existing.id },
      data: { lastConfirmedAt: new Date(), lastConfirmedById: req.user?.id ?? null },
    });

    // Audit trail: snapshot the confirmed rate values. Defensible pricing integrity.
    writeActivityLog({
      assetId: null,
      userId: req.user?.id ?? null,
      accountId: req.user?.accountId ?? null,
      action: 'rate_sheet_confirmed',
      details: {
        confirmedAt: rs.lastConfirmedAt,
        confirmedById: rs.lastConfirmedById,
        snapshot: {
          arcFlashStudyPerPanelCents: rs.arcFlashStudyPerPanelCents,
          arcFlashStudyMinimumCents: rs.arcFlashStudyMinimumCents,
          arcFlashStudyMaximumCents: rs.arcFlashStudyMaximumCents,
          pmServiceHourlyRateCents: rs.pmServiceHourlyRateCents,
          pmVisitMinimumCents: rs.pmVisitMinimumCents,
          oneLineDiagramCreationCents: rs.oneLineDiagramCreationCents,
          equipmentReplacementRanges: rs.equipmentReplacementRanges,
          expiresAfterDays: rs.expiresAfterDays,
        },
      },
    });

    return res.json({ success: true, data: await rateSheetPayload(rs) });
  } catch (err: any) {
    console.error('[adminOpportunities] rate-sheet confirm error:', err?.message);
    return res.status(500).json({ success: false, error: 'Failed to confirm rate sheet' });
  }
});

module.exports = router;

export {};
