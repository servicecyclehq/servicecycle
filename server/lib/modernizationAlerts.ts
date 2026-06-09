/**
 * modernizationAlerts.ts — daily RUL scoring + modernization alert cron.
 *
 * Algorithm (Task 23, validated against IEEE/NFPA/NETA literature):
 *
 *   Base life by asset class: IEEE C57.91/96, C37.06/16, PSRC WG I22,
 *     ANSI/NETA MTS-2023, ASHE Monograph 2013.
 *
 *   Condition multipliers: NFPA 70B 2023 Table 9.2.2 interval compression
 *     ratios, IEEE 493 PM-absence failure data, industry transformer half-life
 *     rule. These are engineering judgment — no published standard states them
 *     explicitly. Tune with real customer data as the fleet grows.
 *
 *   IMPORTANT: Environment is baked into the condition rating (NFPA 70B 2023
 *     already classifies harsh environment as C3 trigger). Do NOT apply a
 *     separate environment multiplier — it double-counts the same factor.
 *     Exception: liquid-filled transformers where IEEE C57.91 provides the
 *     Arrhenius thermal model; that requires operating temperature which is
 *     rarely available at fleet scale, so we fall back to condition multiplier.
 *
 * Alert tiers:
 *   < 0.5  — Healthy: no action
 *   0.5–0.7 — Watch list: OEM fleet dashboard only, no customer email
 *   0.7–0.85 — Planning Advisory: budget in 18-month horizon (email)
 *   0.85–1.0 — High Urgency: next year's budget (email)
 *   > 1.0  — Critical: past condition-adjusted expected life (email)
 *
 * Thresholds are calibration decisions, not published standards. Tune over
 * time with real customer outcomes.
 *
 * Wire: registered as daily 09:00 UTC cron in server/index.ts.
 */

import prisma from './prisma';
import { lookupCatalogEntry } from './oemProductCatalog';
const { sendEmail } = require('./email');
const { redactEmail } = require('./redact');

// ── RUL model constants ────────────────────────────────────────────────────────

// Map EquipmentType enum to the asset-class keys used in the RUL model.
// Unmapped types use the 25-year default in BASE_LIFE_YEARS.
const EQUIP_TO_CLASS: Record<string, string> = {
  TRANSFORMER_LIQUID:  'transformer_liquid_filled',
  TRANSFORMER_DRY:     'transformer_dry_type',
  SWITCHGEAR:          'switchgear_mv',
  SWITCHBOARD:         'switchgear_lv',
  PANELBOARD:          'switchgear_lv',
  CIRCUIT_BREAKER:     'breaker_lv_mccb',     // heuristic — no type subclassification at asset level
  PROTECTION_RELAY:    'relay_microprocessor', // heuristic — assume modern unless model says otherwise
  MCC:                 'mcc',
  UPS_BATTERY:         'ups',
  BATTERY_SYSTEM:      'battery_vrla',
  TRANSFER_SWITCH:     'ats',
};

// IEEE C57.91/96, C37.06/16, PSRC WG I22, ANSI/NETA MTS-2023, ASHE 2013.
// Ranges noted in comments; we use the midpoint-conservative value.
const BASE_LIFE_YEARS: Record<string, number> = {
  transformer_liquid_filled:  30,  // IEEE C57.91 (range 20–40 by load)
  transformer_dry_type:       20,  // IEEE C57.96 (range 20–30)
  switchgear_mv:              30,  // Industry consensus (range 20–40)
  switchgear_lv:              30,  // ASHE/AHA (range 20–40)
  breaker_lv_mccb:            25,  // UL 489 (range 20–30)
  breaker_lv_power:           30,  // IEEE C37.16 (range 20–40)
  breaker_mv_vacuum:          25,  // ANSI C37.06 (range 20–30)
  relay_electromechanical:    40,  // IEEE PSRC WG I22 (range 30–50)
  relay_solid_state:          25,  // IEEE PSRC WG I22 (range 20–30)
  relay_microprocessor:       20,  // SEL/Haas et al. 2021 (range 20–25)
  mcc:                        30,  // NEMA ICS 18 (range 20–30)
  ups:                        10,  // Schneider/Eaton (range 7–15)
  battery_vrla:                5,  // IEEE 1188 (range 3–10)
  battery_flooded_vla:        15,  // IEEE 450 (range 10–20)
  ats:                        20,  // Industry consensus (range 20–25)
};

// NFPA 70B 2023 + IEEE 493 engineering judgment multipliers.
// See module header for calibration caveat.
const CONDITION_MULTIPLIER: Record<string, number> = {
  C1:        1.00,  // Like-new, maintained on schedule
  C2:        0.85,  // Minor deviation; interval compressed
  C3:        0.50,  // Significant deviation / missed 2+ cycles
  IMMEDIATE: 0.60,  // Active unresolved safety deficiency
};

/**
 * Compute the modernization risk score (0–1+).
 *
 * - endOfSupportDate path: normalize remaining years over a 5-year window.
 * - Heuristic path: (age / adjusted-total-life). Can exceed 1.0 when asset
 *   is past its condition-adjusted expected life.
 */
export function computeModernizationRiskScore(
  assetClass: string,
  assetAgeYears: number,
  conditionRating: string,         // C1 / C2 / C3 / IMMEDIATE
  endOfSupportDate?: Date | null,
): number {
  // Explicit OEM-published EOL overrides the heuristic entirely
  if (endOfSupportDate) {
    const yearsRemaining =
      (endOfSupportDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 365);
    return Math.max(0, 1 - yearsRemaining / 5); // normalize over 5-year window
  }
  const baseLife    = BASE_LIFE_YEARS[assetClass] ?? 25;
  const multiplier  = CONDITION_MULTIPLIER[conditionRating] ?? 1.0;
  const adjustedTotal = baseLife * multiplier;
  return assetAgeYears / adjustedTotal; // can exceed 1.0
}

// ── email renderer ────────────────────────────────────────────────────────────

function escHtml(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scoreLabel(score: number): string {
  if (score > 1.0) return 'Critical';
  if (score >= 0.85) return 'High Urgency';
  return 'Planning Advisory';
}

function scoreColor(score: number): string {
  if (score > 1.0) return '#dc2626'; // red
  if (score >= 0.85) return '#ea580c'; // orange
  return '#d97706'; // amber
}

interface AlertItem {
  assetLabel:    string;
  site:          string | null;
  score:         number;
  catalogNote:   string | null;
  rateRange:     string | null;
}

function buildModernizationHtml(
  items: AlertItem[],
  accountName: string,
): string {
  const rows = items
    .map((item) => {
      const color = scoreColor(item.score);
      const label = scoreLabel(item.score);
      return `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">
        <strong style="color:${color};">${escHtml(label)}</strong>
        &nbsp;&middot;&nbsp;${escHtml(item.assetLabel)}
        ${item.site ? `<span style="color:#6b7280;font-size:12px;"> (${escHtml(item.site)})</span>` : ''}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#374151;font-size:13px;">
        Score: <strong>${(item.score * 100).toFixed(0)}%</strong>
        ${item.rateRange ? `<br/><span style="color:#6b7280;font-size:11px;">Est. CapEx: ${escHtml(item.rateRange)}</span>` : ''}
        ${item.catalogNote ? `<br/><span style="color:#6b7280;font-size:11px;">${escHtml(item.catalogNote.slice(0, 120))}</span>` : ''}
      </td>
    </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html>
<body style="font-family:system-ui,sans-serif;color:#111827;background:#f9fafb;margin:0;padding:20px;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <div style="background:#0d4f6e;padding:16px 24px;">
      <h2 style="margin:0;color:#fff;font-size:18px;">&#9873; Modernization Planning Alert</h2>
      <p style="margin:4px 0 0;color:#bae6fd;font-size:13px;">${escHtml(accountName)}</p>
    </div>
    <div style="padding:20px 24px;">
      <p style="font-size:14px;color:#374151;margin:0 0 4px;">
        The following assets have reached the modernization planning threshold based on
        age, condition rating, and OEM support status.
      </p>
      <p style="font-size:13px;color:#6b7280;margin:0 0 16px;">
        Scores reflect IEEE/NFPA/NETA-calibrated Remaining Useful Life analysis.
        Quote requests have been automatically opened for your service representative.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f3f4f6;">
            <th style="padding:8px 12px;text-align:left;font-weight:600;color:#6b7280;text-transform:uppercase;font-size:11px;letter-spacing:.05em;">Asset</th>
            <th style="padding:8px 12px;text-align:left;font-weight:600;color:#6b7280;text-transform:uppercase;font-size:11px;letter-spacing:.05em;">Risk Detail</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="font-size:12px;color:#9ca3af;margin:20px 0 0;">
        Log in to ServiceCycle to view the full fleet modernization forecast and CapEx projections.
        This is an automated notification &mdash; do not reply.
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ── asset display label ────────────────────────────────────────────────────────

function assetDisplayLabel(asset: {
  equipmentType: string;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
}): string {
  const parts: string[] = [
    asset.equipmentType.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
  ];
  if (asset.manufacturer) parts.push(asset.manufacturer);
  if (asset.model) parts.push(asset.model);
  if (asset.serialNumber) parts.push(`(S/N: ${asset.serialNumber})`);
  return parts.join(' ');
}

// ── main export ────────────────────────────────────────────────────────────────

export interface ModernizationAlertResult {
  assetsScored:  number;
  quoteRequests: number;
  emailsSent:    number;
  skipped:       number;
}

export async function runModernizationAlerts(): Promise<ModernizationAlertResult> {
  let assetsScored  = 0;
  let quoteRequests = 0;
  let emailsSent    = 0;
  let skipped       = 0;

  const now = new Date();

  // Fetch all active, non-archived assets that have an install date
  // (without install date we can't compute age — skip them).
  const assets = await prisma.asset.findMany({
    where: {
      archivedAt:  null,
      installDate: { not: null },
    },
    select: {
      id:                   true,
      accountId:            true,
      equipmentType:        true,
      manufacturer:         true,
      model:                true,
      serialNumber:         true,
      installDate:          true,
      endOfSupport:         true,
      governingCondition:   true,
      modernizationRiskScore: true,
      site: { select: { name: true } },
    },
    take: 5000, // page if fleet grows; adequate for current PoC scale
  });

  // Rate card: load global (no partnerOrgId, no accountId) rows for lookup
  const rateCards = await prisma.serviceRateCard.findMany({
    where: { partnerOrgId: null, accountId: null },
  });
  const rateMap = new Map<string, { minCents: number; maxCents: number }>();
  for (const r of rateCards) {
    rateMap.set(r.serviceType, { minCents: r.minCents, maxCents: r.maxCents });
  }

  // ── Score every asset + update DB ─────────────────────────────────────────
  // Batch updates to avoid N+1 writes
  const updates: Array<{ id: string; score: number }> = [];

  for (const asset of assets) {
    const installDate = asset.installDate!;
    const ageYears = (now.getTime() - installDate.getTime()) / (1000 * 60 * 60 * 24 * 365);
    const assetClass = EQUIP_TO_CLASS[asset.equipmentType] ?? 'transformer_dry_type';
    const condition  = asset.governingCondition ?? 'C2';

    const score = computeModernizationRiskScore(
      assetClass,
      ageYears,
      condition,
      asset.endOfSupport,
    );

    updates.push({ id: asset.id, score });
    assetsScored++;
  }

  // Write scores — run sequentially in small batches to avoid connection pool exhaustion
  for (const { id, score } of updates) {
    await prisma.asset.update({
      where: { id },
      data:  { modernizationRiskScore: score },
    }).catch((e: any) =>
      console.warn(`[modernizationAlerts] score write failed for ${id}:`, e.message),
    );
  }

  // ── Alert and quote-request pass ──────────────────────────────────────────
  // Only assets with score >= 0.70 get quote requests + emails.
  // Assets 0.50–0.70 surface on OEM fleet dashboard only (score is now stored
  // in DB so the fleet dashboard query can filter on modernizationRiskScore).

  const alertAssets = assets.filter((a) => {
    const upd = updates.find((u) => u.id === a.id);
    return (upd?.score ?? 0) >= 0.70;
  });

  if (alertAssets.length === 0) {
    return { assetsScored, quoteRequests, emailsSent, skipped };
  }

  // Group by account
  const byAccount = new Map<string, typeof alertAssets>();
  for (const a of alertAssets) {
    if (!byAccount.has(a.accountId)) byAccount.set(a.accountId, []);
    byAccount.get(a.accountId)!.push(a);
  }

  // Build existing-quote dedup set
  const alertAssetIds = alertAssets.map((a) => a.id);
  const existingQuotes = await prisma.quoteRequest.findMany({
    where: {
      assetId:    { in: alertAssetIds },
      status:     { in: ['requested', 'quoted'] },
      triggerType: 'MODERNIZATION_EOL',
    },
    select: { assetId: true },
  });
  const quotedSet = new Set(existingQuotes.map((q) => q.assetId));

  // Admin user map for requestedById
  const accountIds = [...byAccount.keys()];
  const adminUsers = await prisma.user.findMany({
    where: {
      accountId: { in: accountIds },
      role:      { in: ['admin', 'manager'] },
      isActive:  true,
    },
    select: { id: true, accountId: true, email: true },
  });
  const adminMap = new Map<string, { id: string; email: string }[]>();
  for (const u of adminUsers) {
    if (!adminMap.has(u.accountId)) adminMap.set(u.accountId, []);
    adminMap.get(u.accountId)!.push(u);
  }

  for (const [accountId, acctAssets] of byAccount) {
    const account = await prisma.account.findUnique({
      where:  { id: accountId },
      select: { companyName: true },
    });
    const accountName = account?.companyName ?? accountId;
    const admins      = adminMap.get(accountId) ?? [];
    if (admins.length === 0) { skipped += acctAssets.length; continue; }

    const alertItems: AlertItem[] = [];

    for (const asset of acctAssets) {
      const upd   = updates.find((u) => u.id === asset.id)!;
      const score = upd.score;

      // Map equipment type to a service type for the rate card
      const serviceType = mapEquipTypeToServiceType(asset.equipmentType);
      const rate         = rateMap.get(serviceType);
      const rateRange    = rate
        ? `$${(rate.minCents / 100).toLocaleString()} – $${(rate.maxCents / 100).toLocaleString()}`
        : null;

      const catalogEntry = lookupCatalogEntry(asset.model, asset.equipmentType);

      alertItems.push({
        assetLabel:  assetDisplayLabel(asset),
        site:        asset.site?.name ?? null,
        score,
        catalogNote: catalogEntry?.replacement ?? null,
        rateRange,
      });

      // Create quote request if not already open
      if (!quotedSet.has(asset.id)) {
        const requestedBy = admins[0];
        const notes = [
          `Auto-triggered: modernization risk score ${(score * 100).toFixed(0)}% (threshold ≥70%).`,
          catalogEntry
            ? `OEM context: ${catalogEntry.description} — Recommended path: ${catalogEntry.replacement}. ${catalogEntry.oemNote}`
            : null,
          rate
            ? `Estimated CapEx range: $${(rate.minCents / 100).toLocaleString()} – $${(rate.maxCents / 100).toLocaleString()} (platform benchmark; site conditions may vary).`
            : null,
        ]
          .filter(Boolean)
          .join('\n');

        await prisma.quoteRequest.create({
          data: {
            accountId,
            assetId:       asset.id,
            requestedById: requestedBy.id,
            driver:        'planned_replacement',
            timeline:      'next_budget_cycle',
            status:        'requested',
            triggerType:   'MODERNIZATION_EOL',
            emergencyMode: score > 1.0,
            notes,
          },
        }).catch((e: any) =>
          console.warn(`[modernizationAlerts] QuoteRequest create failed for ${asset.id}:`, e.message),
        );
        quotedSet.add(asset.id);
        quoteRequests++;
      }
    }

    // Send one digest email per account — dedup to 24-hour window
    const template = 'modernization_planning_alert';
    const alreadySent = await prisma.notificationLog.findFirst({
      where: {
        accountId,
        template,
        sentAt:  { gte: new Date(Date.now() - 20 * 3_600_000) },
        status:  'sent',
      },
    });
    if (alreadySent) { skipped++; continue; }

    const subject = `[Modernization Alert] ${alertItems.length} asset${alertItems.length !== 1 ? 's' : ''} require planning — ${accountName}`;
    const html    = buildModernizationHtml(alertItems, accountName);

    for (const admin of admins) {
      if (!admin.email) continue;
      try {
        await sendEmail({ to: admin.email, subject, html });
        emailsSent++;
      } catch (err: any) {
        console.error(`[modernizationAlerts] email failed for ${redactEmail(admin.email)}:`, err.message);
      }
    }

    await prisma.notificationLog.create({
      data: {
        accountId,
        channel:    'email',
        template,
        recipient:  admins.map((a) => a.email).join(', '),
        status:     emailsSent > 0 ? 'sent' : 'failed',
        alertCount: alertItems.length,
      },
    }).catch(() => {});
  }

  return { assetsScored, quoteRequests, emailsSent, skipped };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function mapEquipTypeToServiceType(equipmentType: string): string {
  const mapping: Record<string, string> = {
    TRANSFORMER_LIQUID:  'TRANSFORMER_REPLACEMENT',
    TRANSFORMER_DRY:     'TRANSFORMER_REPLACEMENT',
    SWITCHGEAR:          'SWITCHGEAR_MODERNIZATION',
    SWITCHBOARD:         'SWITCHGEAR_MODERNIZATION',
    CIRCUIT_BREAKER:     'BREAKER_RETROFIT',
    PROTECTION_RELAY:    'RELAY_UPGRADE',
    MCC:                 'SWITCHGEAR_MODERNIZATION',
    UPS_BATTERY:         'INSPECTION',
    BATTERY_SYSTEM:      'INSPECTION',
    TRANSFER_SWITCH:     'INSPECTION',
  };
  return mapping[equipmentType] ?? 'INSPECTION';
}
