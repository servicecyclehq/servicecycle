/**
 * Date calculation utilities for LapseIQ contract management.
 *
 * Evaluation-start-by date tiers (based on total contract value). These are the
 * BUILT-IN DEFAULTS; an account can override the breakpoints + lead times via
 * the EVALUATION_LEAD_TIMES AccountSetting (#28, configurable in Settings). The
 * same model is mirrored on the client in client/src/lib/urgency.js so the
 * header/chip urgency colors and the server-computed evaluationStartByDate stay
 * in lockstep.
 *
 *   $100,000+        -> 180 days before end_date
 *   $25,000-$99,999  -> 90 days before end_date
 *   Under $25,000    -> 30 days before end_date
 *   No cost data     -> 60 days before end_date (safe default)
 *
 * Cancel-by date:
 *   end_date minus auto_renewal_notice_days
 *   Only calculated when auto_renewal = true and notice days is set.
 */

// Built-in default lead-time model. tiers are sorted high -> low by minValue;
// the first tier whose minValue <= totalValue wins. noValueDaysBack is used
// when the contract has no usable cost/quantity data.
const DEFAULT_EVAL_LEAD_TIMES = {
  tiers: [
    { minValue: 100000, daysBack: 180 },
    { minValue: 25000,  daysBack: 90 },
    { minValue: 0,      daysBack: 30 },
  ],
  noValueDaysBack: 60,
};

const MAX_DAYS_BACK = 3650; // 10-year guardrail

/**
 * Coerce an arbitrary (possibly user-supplied / parsed-JSON) value into a valid
 * lead-time config, falling back to the built-in defaults for anything missing
 * or malformed. Pure + defensive so the settings PUT validator and the date
 * calc can share one normalizer (and so a bad AccountSetting row can never
 * corrupt the computed dates).
 */
function normalizeEvalLeadTimes(raw) {
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
    // de-dupe by minValue (keep first occurrence), then sort high -> low
    const seen = new Set();
    tiers = tiers.filter((t) => (seen.has(t.minValue) ? false : (seen.add(t.minValue), true)));
    tiers.sort((a, b) => b.minValue - a.minValue);
    // guarantee a catch-all minValue:0 tier so every positive value matches
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

/**
 * How many days before end_date to begin the evaluation, given a total contract
 * value (or null when there is no usable cost data) and an optional config.
 */
function evalDaysBack(totalValue, config) {
  const cfg = normalizeEvalLeadTimes(config);
  if (totalValue == null || !(totalValue > 0)) return cfg.noValueDaysBack;
  for (const t of cfg.tiers) { // sorted high -> low
    if (totalValue >= t.minValue) return t.daysBack;
  }
  return cfg.noValueDaysBack;
}

/**
 * Calculate the evaluation_start_by_date from end date and contract value.
 * Higher-value contracts get a longer evaluation window because they tend to
 * involve more stakeholders and longer negotiation cycles. Pass the account's
 * EVALUATION_LEAD_TIMES config (parsed object) as the 4th arg to honor an
 * override; omit it to use the built-in defaults.
 * @param {Date|string|null} endDate
 * @param {number|string|null} costPerLicense
 * @param {number|string|null} quantity
 * @param {object|null} [config]
 * @returns {Date|null}
 */
function calculateEvaluationStartByDate(endDate, costPerLicense, quantity, config) {
  if (!endDate) return null;

  const end = new Date(endDate);
  if (isNaN(end.getTime())) return null;

  const cost = parseFloat(costPerLicense);
  const qty = parseInt(quantity);
  const totalValue = (!isNaN(cost) && !isNaN(qty) && cost > 0 && qty > 0) ? cost * qty : null;

  const daysBack = evalDaysBack(totalValue, config);

  const evalStart = new Date(end);
  // C10 (2026-05-22): use UTC date math so this is stable across DST + non-UTC operators
  evalStart.setUTCDate(evalStart.getUTCDate() - daysBack);
  return evalStart;
}

/**
 * Calculate the cancel_by_date for auto-renewal contracts.
 * @param {Date|string|null} endDate
 * @param {boolean} autoRenewal
 * @param {number|string|null} autoRenewalNoticeDays
 * @returns {Date|null}
 */
function calculateCancelByDate(endDate, autoRenewal, autoRenewalNoticeDays) {
  if (!endDate || !autoRenewal || !autoRenewalNoticeDays) return null;

  const end = new Date(endDate);
  if (isNaN(end.getTime())) return null;

  const noticeDays = parseInt(autoRenewalNoticeDays);
  if (isNaN(noticeDays) || noticeDays <= 0) return null;

  const cancelBy = new Date(end);
  // C10 (2026-05-22): use UTC date math so this is stable across DST + non-UTC operators
  cancelBy.setUTCDate(cancelBy.getUTCDate() - noticeDays);
  return cancelBy;
}

module.exports = {
  calculateEvaluationStartByDate,
  calculateCancelByDate,
  normalizeEvalLeadTimes,
  evalDaysBack,
  DEFAULT_EVAL_LEAD_TIMES,
};

export {};