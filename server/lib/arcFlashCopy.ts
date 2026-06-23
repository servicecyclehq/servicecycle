'use strict';

/**
 * arcFlashCopy.ts - canonical user-facing microcopy for the arc-flash surfaces.
 *
 * SC_DATA_LAYER_DISCLAIMER is the single "ServiceCycle is the data layer, not the
 * safety authority" line. It is reused VERBATIM at every place where SC reports a
 * data-validity gate or hazard - the energized-work permit, the work-order
 * precheck, and the field-collection task - so the positioning + disclaimer reads
 * the same everywhere. SC surfaces data and flags when its own data is stale; it
 * never authorizes work, prescribes PPE, or decides whether it is safe to proceed.
 * Those calls belong to the customer's electrical safety program and a qualified
 * person under NFPA 70E.
 */
const SC_DATA_LAYER_DISCLAIMER =
  'ServiceCycle surfaces the data; it cannot authorize this work or judge whether it is safe to proceed. ' +
  "That decision follows your facility's electrical safety program and a qualified person under NFPA 70E. " +
  'When the work is complete, return to ServiceCycle to log the results.';

module.exports = { SC_DATA_LAYER_DISCLAIMER };

export {};
