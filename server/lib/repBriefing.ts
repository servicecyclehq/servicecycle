export {};
/**
 * repBriefing.ts — COMPAT SHIM.
 *
 * The single combined rep briefing was split into the two-email monthly digest
 * (manager roll-up + rep email) in lib/monthlyDigest.ts. This file now just
 * delegates so the existing cron wiring and any callers/tests that import
 * `runRepBriefing` keep working. See lib/monthlyDigest.ts for the implementation
 * and lib/alertCadence.ts for the watermark cadence it rides on.
 */

const { runMonthlyDigest } = require('./monthlyDigest');

async function runRepBriefing(opts: any = {}) {
  return runMonthlyDigest(opts);
}

module.exports = { runRepBriefing };
