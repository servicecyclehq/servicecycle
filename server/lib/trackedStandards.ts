'use strict';

/**
 * lib/trackedStandards.ts
 *
 * Per-account selection of WHICH compliance standards an account tracks. This
 * is the "wider net" lever: the seed ships a library of standards (NFPA 70B/
 * 70E/110/25/101/70, NETA ATS/MTS, IEEE C57.104/43/450/1188/81, OSHA), and an
 * account turns on the ones that apply to its facilities. bulk-apply then only
 * creates schedules for tracked standards, so the program (and the compliance
 * picture that follows from it) reflects exactly what the customer answers to.
 *
 * Stored in AccountSetting key `tracked_standards` as a JSON array of standard
 * CODES. UNSET = null = track ALL standards (preserves existing behavior for
 * accounts that have never configured it). An empty array means "track none"
 * (only no-standard / tenant-custom tasks apply).
 */

const prisma = require('./prisma').default;

const TRACKED_STANDARDS_KEY = 'tracked_standards';

// Returns the array of tracked standard codes, or null = track ALL.
async function getTrackedStandardCodes(accountId) {
  if (!accountId) return null;
  try {
    const row = await prisma.accountSetting.findFirst({
      where:  { accountId, key: TRACKED_STANDARDS_KEY },
      select: { value: true },
    });
    if (!row || row.value == null || row.value === '') return null;
    const arr = JSON.parse(row.value);
    if (!Array.isArray(arr)) return null;
    return arr.map((c) => String(c));
  } catch (_) {
    return null; // fail-open to "track all" so a settings hiccup never hides tasks
  }
}

// Pure predicate. trackedCodes null = track all; a task with no standard code
// (tenant-custom) always applies.
function isStandardTracked(trackedCodes, code) {
  if (trackedCodes == null) return true;
  if (!code) return true;
  return trackedCodes.includes(code);
}

module.exports = { getTrackedStandardCodes, isStandardTracked, TRACKED_STANDARDS_KEY };

export {};