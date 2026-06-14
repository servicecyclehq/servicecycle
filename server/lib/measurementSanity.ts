/**
 * lib/measurementSanity.ts
 *
 * Coarse plausibility check for ingested test readings. The goal is to catch
 * ORDER-OF-MAGNITUDE unit/scale errors -- the classic being a contact
 * resistance entered in milliohms that should be microohms (a 1000x error that
 * silently wrecks the trend) -- NOT to second-guess a legitimate reading.
 *
 * Bands are intentionally WIDE and keyed by measurement-type keyword; unknown
 * measurement types are never flagged. The check is advisory/non-blocking: the
 * caller surfaces an ADVISORY "data check" so a human verifies the value + unit
 * against the source report. It never rejects a commit.
 */

'use strict';

const BANDS = [
  { match: /insulation|megger|\bir[_-]|polarization/i, min: 0,    max: 1e7,  label: 'insulation resistance (MOhm/GOhm)' },
  { match: /contact|connection|micro[_-]?ohm|ductor|\bdlro\b/i, min: 0, max: 5e5, label: 'contact resistance (uOhm)' },
  { match: /winding[_-]?res/i,           min: 0,    max: 1e6,  label: 'winding resistance' },
  { match: /ground|earth|fall[_-]?of[_-]?potential/i, min: 0, max: 1e4, label: 'ground resistance (Ohm)' },
  { match: /turns?[_-]?ratio|\bttr\b/i,  min: 0,    max: 1e4,  label: 'turns ratio' },
  { match: /power[_-]?factor|tan[_-]?delta|dissipation/i, min: -100, max: 100, label: 'power factor / tan-delta (%)' },
];

/**
 * Returns a human-readable reason string if the value looks like a unit/scale
 * error for its measurement type, or null if it is plausible (or the type is
 * unknown / the value is non-numeric).
 */
function checkMeasurementSanity(measurementType, value) {
  if (value == null || value === '') return null;
  const v = Number(value);
  if (!isFinite(v)) return null;
  const t = String(measurementType || '');
  if (v < 0) {
    return `negative value (${v}) is physically implausible for ${t || 'this measurement'}`;
  }
  for (const b of BANDS) {
    if (b.match.test(t)) {
      if (v < b.min || v > b.max) {
        return `value ${v} is outside the plausible band for ${b.label} [${b.min}, ${b.max}] - possible unit/scale error`;
      }
      break;
    }
  }
  return null;
}

module.exports = { checkMeasurementSanity, BANDS };

export {};