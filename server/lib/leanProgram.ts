/**
 * lib/leanProgram.ts
 *
 * Splits the seeded task matrix into the INDUSTRY-STANDARD program (NFPA 70B:
 * inspection / clean / lube / insulation-resistance "megger" / visual, plus
 * annual IR thermography and the routine mandate-fixed operational tests) and
 * the EXTENDED testing layer -- the optional, customer-required NETA MTS test
 * battery of high-cost, occasional, de-energized specialized tests: contact/
 * connection/pole resistance, breaker trip tests, relay calibration & injection,
 * TTR / SFRA / PD / winding resistance, MV cable VLF & shield continuity,
 * ground-resistance, surge-arrester leakage, and GFP performance / coordination.
 * (Code symbols keep the "lean" / "neta_full_battery" names for compatibility.)
 *
 * NFPA 70B defers routine intervals to the manufacturer procedure: the lean
 * program is what a PM tech does every visit, while the NETA battery is the
 * contractor billable, occasional service (a low-voltage NETA breaker test is
 * ~2 hrs vs ~20 min for the manufacturer/70B procedure). A new asset gets the
 * lean set by default on bulk-apply; the full battery is added only when the
 * account neta_full_battery flag is on. Reversible -- nothing is deleted.
 *
 * Keyed by taskCode (seed-standards.js is the source of truth). A drift test
 * asserts every code here still exists in the seed.
 */

const NETA_BATTERY_TASK_CODES = new Set([
  // switchgear
  "SWGR_CONTACT_RES", "SWGR_CB_TRIP", "SWGR_RELAY_CAL",
  // liquid transformer
  "XFMR_TTR", "XFMR_SFRA", "XFMR_PD_SURVEY",
  // automatic transfer switch
  "ATS_CONTACT_IR_RES",
  // standalone circuit breaker
  "CB_TRIP_TEST", "CB_CONTACT_RES",
  // motor
  "MTR_WINDING_RES",
  // dry transformer
  "XFMRD_TTR", "XFMRD_WINDING_RES",
  // protective relay
  "RELAY_SEC_INJECTION", "RELAY_TRIP_PATH", "RELAY_SETTINGS_VS_STUDY",
  // ground-fault protection
  "GFP_PERFORMANCE_TEST", "GFP_ZONE_COORDINATION",
  // disconnect switch
  "DISC_CONTACT_RES",
  // surge arrester
  "SA_LEAKAGE_TEST",
  // MV/HV cable
  "CBLMV_VLF_PD", "CBLMV_SHIELD_CONTINUITY",
  // grounding system
  "GND_FALL_OF_POTENTIAL", "GND_POINT_TO_POINT",
  // fuse gear
  "FUSE_CLIP_RES",
]);

function isNetaBatteryTask(taskCode) {
  return NETA_BATTERY_TASK_CODES.has(taskCode);
}

// Filter task definitions for a program. fullBattery=false (lean default)
// drops the NETA battery; fullBattery=true keeps everything. Unknown codes
// (e.g. tenant custom tasks) are treated as lean and kept -- bulk-apply only
// ever passes global rows, but this keeps the helper safe for any caller.
function filterTaskDefsForProgram(defs, opts) {
  const fullBattery = !!(opts && opts.fullBattery);
  if (fullBattery) return defs;
  return defs.filter((d) => !isNetaBatteryTask(d.taskCode));
}

module.exports = {
  NETA_BATTERY_TASK_CODES,
  isNetaBatteryTask,
  filterTaskDefsForProgram,
};

export {};