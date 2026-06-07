/**
 * Fiscal-year helpers — anchored on the per-account FISCAL_YEAR_START_MONTH
 * setting (1-12, default 1 = calendar year).
 *
 * The FY label uses the year in which the FY *ends* — the more common
 * convention in software-asset reporting (a US federal "FY26" = Oct 1 2025
 * through Sep 30 2026). Calendar-year accounts (start month = 1) end in the
 * same year they start, so the label matches the start year.
 *
 * Pure functions, no DB access — load FISCAL_YEAR_START_MONTH at the call
 * site and pass it in. Easy to unit-test.
 */

'use strict';

/**
 * Return the FY range that contains `asOf`, offset by N years (negative =
 * past). Half-open [start, end) so endDate comparisons match Prisma's
 * `lt:` semantics.
 *
 * Example: startMonth=10 (Oct), asOf=2026-05-02, offset=0
 *   → start=2025-10-01, end=2026-10-01, label="FY2026"
 * Example: startMonth=1, asOf=2026-05-02, offset=-1
 *   → start=2025-01-01, end=2026-01-01, label="FY2025"
 */
function fiscalYearRange(asOf, startMonth, offset = 0) {
  // Out-of-range / unparseable startMonth defaults to 1 (calendar year)
  // rather than clamping to 12, which would silently shift the period
  // 11 months and produce surprising YoY comparisons.
  const parsed = parseInt(startMonth, 10);
  const month = (Number.isFinite(parsed) && parsed >= 1 && parsed <= 12) ? parsed : 1;
  const monthIdx = month - 1;
  const ref = asOf instanceof Date ? new Date(asOf.getTime()) : new Date(asOf);

  // Determine the start year of the FY containing `ref`.
  let startYear = ref.getUTCFullYear();
  if (ref.getUTCMonth() < monthIdx) startYear -= 1;
  startYear += offset;

  const start = new Date(Date.UTC(startYear, monthIdx, 1));
  const end   = new Date(Date.UTC(startYear + 1, monthIdx, 1));

  // Label uses the year in which the FY ENDS. Calendar-year accounts
  // (startMonth=1) end in the same year they start, so the label === startYear.
  // Non-calendar accounts span two calendar years and label by the second.
  const labelYear = month === 1 ? startYear : startYear + 1;

  return { start, end, label: `FY${labelYear}`, startYear, startMonth: month };
}

module.exports = { fiscalYearRange };

export {};
