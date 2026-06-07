// -----------------------------------------------------------------------------
// urgency.js - canonical renewal-urgency model (Dustin 2026-05-29, #6).
//
// ONE source of truth so the contract header, Key Dates chip, list-view chips,
// and dashboard all color the same contract identically. Driven by the
// contract's value-tiered Evaluate-By date (evaluationStartByDate), NOT a flat
// day count:
//   green  ('calm')     - before the Evaluate-By date (on track, no action yet)
//   amber  ('evaluate') - inside the Evaluate-By window (time to act)
//   red    ('urgent')   - <= 30 days to renewal
//   red    ('overdue')  - past the renewal/end date
//   ('neutral')         - non-active contracts (renewed/cancelled/expired)
// -----------------------------------------------------------------------------

export function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24));
}

// Returns 'overdue' | 'urgent' | 'evaluate' | 'calm' | 'neutral'.
export function renewalUrgency(contract) {
  if (!contract) return 'neutral';
  if (contract.status !== 'active' && contract.status !== 'under_review') return 'neutral';
  const d = daysUntil(contract.endDate);
  if (d === null) return 'calm';
  if (d < 0)   return 'overdue';
  if (d <= 30) return 'urgent';
  const e = daysUntil(contract.evaluationStartByDate);
  if (e !== null && e <= 0) return 'evaluate'; // at/past the Evaluate-By date
  return 'calm';
}

// Maps a level to the existing days-chip CSS class so chip styling is reused.
export const URGENCY_CHIP_CLASS = {
  overdue:  'days-chip-overdue',
  urgent:   'days-chip-urgent',
  evaluate: 'days-chip-soon',
  calm:     'days-chip-ok',
  neutral:  'days-chip-ok',
};

// Maps a level to a CSS color var for text/dot/stripe use.
export const URGENCY_COLOR = {
  overdue:  'var(--color-danger)',
  urgent:   'var(--color-danger)',
  evaluate: 'var(--color-warning)',
  calm:     'var(--color-success)',
  neutral:  'var(--color-text-secondary)',
};

// ===========================================================================
// #28 configurable evaluation lead-time model (mirror of server/utils/dates.ts)
//
// The contract's evaluationStartByDate is computed SERVER-SIDE (the single
// source of truth) using the account's EVALUATION_LEAD_TIMES setting, and the
// urgency model above consumes that date. These client helpers mirror the
// server's defaults + normalize/compute logic EXACTLY so the Settings control
// can render current values, validate edits, and preview the resulting window
// without drifting from how the server actually computes the date.
// ===========================================================================

export const DEFAULT_EVAL_LEAD_TIMES = {
  tiers: [
    { minValue: 100000, daysBack: 180 },
    { minValue: 25000,  daysBack: 90 },
    { minValue: 0,      daysBack: 30 },
  ],
  noValueDaysBack: 60,
};

const MAX_DAYS_BACK = 3650; // 10-year guardrail (matches server)

// Coerce arbitrary/parsed-JSON input into a valid config, falling back to the
// built-in defaults for anything missing or malformed. Mirrors
// normalizeEvalLeadTimes in server/utils/dates.ts.
export function normalizeEvalLeadTimes(raw) {
  const d = DEFAULT_EVAL_LEAD_TIMES;
  const fallback = () => ({ tiers: d.tiers.map((t) => ({ ...t })), noValueDaysBack: d.noValueDaysBack });
  if (!raw || typeof raw !== 'object') return fallback();

  let tiers = Array.isArray(raw.tiers) ? raw.tiers : null;
  if (tiers) {
    tiers = tiers
      .map((t) => ({
        minValue: Math.trunc(Number(t && t.minValue)),
        daysBack: Math.trunc(Number(t && t.daysBack)),
      }))
      .filter((t) =>
        Number.isFinite(t.minValue) && t.minValue >= 0 &&
        Number.isFinite(t.daysBack) && t.daysBack >= 1 && t.daysBack <= MAX_DAYS_BACK);
    const seen = new Set();
    tiers = tiers.filter((t) => (seen.has(t.minValue) ? false : (seen.add(t.minValue), true)));
    tiers.sort((a, b) => b.minValue - a.minValue);
    if (!tiers.some((t) => t.minValue === 0)) {
      tiers.push({ minValue: 0, daysBack: d.tiers[d.tiers.length - 1].daysBack });
    }
  }
  if (!tiers || tiers.length === 0) tiers = d.tiers.map((t) => ({ ...t }));

  let noValueDaysBack = Math.trunc(Number(raw.noValueDaysBack));
  if (!Number.isFinite(noValueDaysBack) || noValueDaysBack < 1 || noValueDaysBack > MAX_DAYS_BACK) {
    noValueDaysBack = d.noValueDaysBack;
  }
  return { tiers, noValueDaysBack };
}

// Parse the JSON string stored in the EVALUATION_LEAD_TIMES AccountSetting into
// a normalized config (defaults when absent/invalid).
export function parseEvalLeadTimes(jsonStr) {
  if (!jsonStr) return normalizeEvalLeadTimes(null);
  let raw = null;
  try { raw = JSON.parse(jsonStr); } catch { raw = null; }
  return normalizeEvalLeadTimes(raw);
}

// Days-before-end-date to begin evaluation for a given total value (or null
// when there's no usable cost data). Mirrors evalDaysBack in dates.ts.
export function evalDaysBack(totalValue, config) {
  const cfg = normalizeEvalLeadTimes(config);
  if (totalValue == null || !(totalValue > 0)) return cfg.noValueDaysBack;
  for (const t of cfg.tiers) {
    if (totalValue >= t.minValue) return t.daysBack;
  }
  return cfg.noValueDaysBack;
}