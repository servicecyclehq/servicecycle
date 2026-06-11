'use strict';

/**
 * scripts/seed-powerdb-demo.js
 * ----------------------------
 * Standalone seed: a fresh dummy customer ("Northwind Foods") whose 2025
 * electrical-test baseline is transcribed VERBATIM from one real PowerDB-style
 * outage report (4 LV unit substations, ~12 breakers each), then synthesizes
 * 8 prior years (2017-2024) BACKWARD so ServiceCycle's year-over-year (YoY)
 * reporting shows realistic, expert-credible trends.
 *
 * Design spec: docs/research/2026-06-11-seed-data-design-yoy-test-history.md
 *
 * Run (from /app on the server):
 *   node node_modules/tsx/dist/cli.mjs scripts/seed-powerdb-demo.js
 *
 * Idempotent: pins a FIXED account id and deletes-then-recreates ONLY that
 * account's tree (same pattern as seed-demo.js). No other account is touched.
 *
 * Login after seeding:  powerdb@demo.local / Powerdb1234!  (role: admin)
 *
 * ANONYMIZATION: no real company / vendor / site / person names appear here.
 * Only generic device IDs (B36S01, SPARE 1, BUSS DUCT, ...) and the numeric
 * 2025 test values carry over from the source report.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const prisma = require('../lib/prisma').default;
const bcrypt = require('bcryptjs');

// ── Pinned identifiers ───────────────────────────────────────────────────────
// Distinct from seed-demo's DEMO_ACCOUNT_ID (11111111-...) so the two demos
// coexist. Valid UUID v4 with a recognisable repeating pattern.
const POWERDB_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';

// 9-year window (2017-2025 inclusive); 2025 is the verbatim anchor, prior
// years are synthesized backward. Trivially retune to 7-10.
const YEARS_BACK = 8;            // anchor year minus this = first synthesized year
const ANCHOR_YEAR = 2025;
const FIRST_YEAR = ANCHOR_YEAR - YEARS_BACK; // 2017

// ── Deterministic PRNG (mulberry32 over a string seed) ───────────────────────
function hashStr(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// A reading-scoped RNG: seed by (asset, circuit, measurementType, phase) so
// re-runs reproduce identical history (spec §1.6).
function rngFor(...parts) {
  return mulberry32(hashStr(parts.join('|')));
}
// Box-Muller standard normal off a uniform RNG.
function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function round(n, dp) {
  const f = Math.pow(10, dp == null ? 2 : dp);
  return Math.round(n * f) / f;
}

// ── Temperature correction (spec §1.3) ───────────────────────────────────────
// IR halves per +10C (IEEE 43): TCF to 20C = 0.5^((T-20)/10). Multiply a raw
// reading by TCF to get the 20C-corrected value.
function irTcf(tempC) { return Math.pow(0.5, (tempC - 20) / 10); }
// Contact resistance has a mild positive temp coefficient; subtle factor on raw.
function crTempFactor(tempC) { return 1 + 0.0004 * (tempC - 20); }

// ── 2025 ANCHOR DATA (transcribed verbatim from the source report) ───────────
// Per substation: list of breakers. Each breaker:
//   id        circuit designation (generic; safe to keep)
//   mfg/type/volts/frameAmp/tripRange/functions  field-data nameplate
//   cr        [A,B,C] contact resistance in micro-ohms (µΩ)
//   irUnit    'GΩ' | 'MΩ'  (report's stated unit for IR)
//   ir        line-to-load IR readings { 'A-A\'':v, 'B-B\'':v, 'C-C\'':v }
//   ltd       null | seconds (LTD timing result) | 'PASS'
//   stpu      'Trip' | 'No-Trip'
//   gfpu      'Trip' | 'No-Trip' | 'NA'
// NA / 0 / locked-out readings preserved as-is.

const SUBSTATIONS = [
  {
    deviceId: 'B36S01',
    breakers: [
      { id: 'SPARE 1',   mfg: 'Square D', type: 'LJ400',  volts: 600, frameAmp: 400,  tripRange: '400',  functions: 'LSI',  cr: [409, 169, 184], irUnit: 'GΩ', ir: { "A-A'": 793,   "B-B'": 2250,  "C-C'": 2210 }, ltd: null, ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: 'SPARE 2',   mfg: 'Square D', type: 'LJ600',  volts: 600, frameAmp: 600,  tripRange: '600',  functions: 'LSI',  cr: [163, 144, 192], irUnit: 'GΩ', ir: { "A-A'": 395,   "B-B'": 1770,  "C-C'": 2250 }, ltd: null, ltdSetting: 600, stpu: 'Trip', gfpu: 'NA' },
      { id: '4PA',       mfg: 'Square D', type: 'PJ800',  volts: 600, frameAmp: 800,  tripRange: '800',  functions: 'LSI',  cr: [59, 53, 43],    irUnit: 'GΩ', ir: { "A-A'": 185,   "B-B'": 330,   "C-C'": 155 },  ltd: null, ltdSetting: 1,   stpu: 'Trip', gfpu: 'NA' },
      { id: 'BUSS DUCT', mfg: 'Square D', type: 'RK1200', volts: 600, frameAmp: 1200, tripRange: '1200', functions: 'LSIG', cr: [43, 41, 40],    irUnit: 'GΩ', ir: { "A-A'": 185,   "B-B'": 270,   "C-C'": 159 },  ltd: null, ltdSetting: 1,   stpu: 'Trip', gfpu: 'Trip' },
      { id: 'SPARE 5',   mfg: 'Square D', type: 'PJ1200', volts: 600, frameAmp: 1200, tripRange: '1200', functions: 'LSIG', cr: [49, 42, 35],    irUnit: 'GΩ', ir: { "A-A'": 3000,  "B-B'": 2730,  "C-C'": 159 },  ltd: null, ltdSetting: 1,   stpu: 'Trip', gfpu: 'Trip' },
      { id: 'SPARE 6',   mfg: 'Square D', type: 'LJ600',  volts: 600, frameAmp: 600,  tripRange: '600',  functions: 'LSI',  cr: [203, 192, 144], irUnit: 'GΩ', ir: { "A-A'": 1282,  "B-B'": 785,   "C-C'": 1570 }, ltd: null, ltdSetting: 600, stpu: 'Trip', gfpu: 'NA' },
      { id: 'SPARE 7',   mfg: 'Square D', type: 'LJ400',  volts: 600, frameAmp: 400,  tripRange: '400',  functions: 'LSI',  cr: [411, 140, 205], irUnit: 'GΩ', ir: { "A-A'": 1619,  "B-B'": 1665,  "C-C'": 1377 }, ltd: null, ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: 'SPARE 8',   mfg: 'Square D', type: 'LJ400',  volts: 600, frameAmp: 400,  tripRange: '400',  functions: 'LSI',  cr: [200, 142, 153], irUnit: 'GΩ', ir: { "A-A'": 1198,  "B-B'": 1547,  "C-C'": 1467 }, ltd: null, ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: '4HB',       mfg: 'Square D', type: 'LJ400',  volts: 600, frameAmp: 400,  tripRange: '400',  functions: 'LSI',  cr: [175, 148, 126], irUnit: 'GΩ', ir: { "A-A'": 168,   "B-B'": 349,   "C-C'": 149 },  ltd: null, ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: '4HC',       mfg: 'Square D', type: 'LJ400',  volts: 600, frameAmp: 400,  tripRange: '400',  functions: 'LSI',  cr: [171, 169, 182], irUnit: 'GΩ', ir: { "A-A'": 217,   "B-B'": 339,   "C-C'": 168 },  ltd: null, ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: '4HA',       mfg: 'Square D', type: 'LJ400',  volts: 600, frameAmp: 400,  tripRange: '400',  functions: 'LSI',  cr: [142, 137, 131], irUnit: 'GΩ', ir: { "A-A'": 244,   "B-B'": 287,   "C-C'": 187 },  ltd: null, ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: 'SPARE 12',  mfg: 'Square D', type: 'LJ400',  volts: 600, frameAmp: 400,  tripRange: '400',  functions: 'LSI',  cr: [212, 237, 146], irUnit: 'GΩ', ir: { "A-A'": 1.57,  "B-B'": 1.43,  "C-C'": 1.37 }, ltd: null, ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
    ],
  },
  {
    deviceId: 'B41ST01',
    breakers: [
      { id: 'S355',          mfg: 'Square D', type: 'HJA36060', volts: 600, frameAmp: 60,  tripRange: '60',  functions: 'TM', cr: [2.2, 2.3, 2.4],     irUnit: 'MΩ', ir: { "A-A'": 105,   "B-B'": 145,   "C-C'": 125.7 }, ltd: null, ltdSetting: 0, stpu: 'NA', gfpu: 'NA' },
      { id: '800A I LINE',   mfg: 'Square D', type: 'WJ300',    volts: 600, frameAmp: 300, tripRange: '300', functions: 'TM', cr: [101.9, 97.5, 108.7], irUnit: 'MΩ', ir: { "A-A'": 135,   "B-B'": 125,   "C-C'": 118 },   ltd: null, ltdSetting: 0, stpu: 'NA', gfpu: 'NA' },
      { id: 'A70',           mfg: 'Square D', type: 'JJ250',    volts: 600, frameAmp: 250, tripRange: '250', functions: 'TM', cr: [1.51, 1.51, 1.42],   irUnit: 'MΩ', ir: { "A-A'": 165,   "B-B'": 247,   "C-C'": 195 },   ltd: null, ltdSetting: 0, stpu: 'NA', gfpu: 'NA' },
      { id: 'A75',           mfg: 'Square D', type: 'JJ250',    volts: 600, frameAmp: 250, tripRange: '250', functions: 'TM', cr: [1.41, 1.75, 1.71],   irUnit: 'MΩ', ir: { "A-A'": 141,   "B-B'": 205,   "C-C'": 175 },   ltd: null, ltdSetting: 0, stpu: 'NA', gfpu: 'NA' },
      { id: 'B40PP01',       mfg: 'Square D', type: 'KA36200',  volts: 600, frameAmp: 200, tripRange: '200', functions: 'TM', cr: [379.5, 373.6, 386.3], irUnit: 'MΩ', ir: { "A-A'": 98,    "B-B'": 122,   "C-C'": 156 },   ltd: null, ltdSetting: 0, stpu: 'NA', gfpu: 'NA' },
      { id: 'FEEDS A143',    mfg: 'Square D', type: 'JJ250',    volts: 600, frameAmp: 250, tripRange: '250', functions: 'TM', cr: [334, 321, 258],      irUnit: 'MΩ', ir: { "A-A'": 163,   "B-B'": 199,   "C-C'": 192 },   ltd: null, ltdSetting: 0, stpu: 'NA', gfpu: 'NA' },
      { id: 'BUSS DUCT B40', mfg: 'Square D', type: 'MJ800',    volts: 600, frameAmp: 800, tripRange: '800', functions: 'TM', cr: [118, 113, 98],       irUnit: 'MΩ', ir: { "A-A'": 134,   "B-B'": 197,   "C-C'": 165 },   ltd: null, ltdSetting: 0, stpu: 'NA', gfpu: 'NA' },
      { id: 'A156',          mfg: 'Square D', type: 'HJ150',    volts: 600, frameAmp: 150, tripRange: '150', functions: 'TM', cr: [2.5, 2.1, 2.1],      irUnit: 'MΩ', ir: { "A-A'": 150,   "B-B'": 213,   "C-C'": 198 },   ltd: null, ltdSetting: 0, stpu: 'NA', gfpu: 'NA' },
      // STORY ASSET 1: the real flagged breaker. C-phase contact resistance.
      { id: 'A141',          mfg: 'Square D', type: 'HJ150',    volts: 600, frameAmp: 150, tripRange: '150', functions: 'TM', cr: [210, 205, 655],      irUnit: 'MΩ', ir: { "A-A'": 165,   "B-B'": 233,   "C-C'": 198 },   ltd: null, ltdSetting: 0, stpu: 'NA', gfpu: 'NA', story: 'b41_cphase' }, // source report literal CR was [643,590,2.5] but its own deficiency flags C-phase HIGH (data-entry error in original); anchored C high + A/B normal so the high-C story is coherent
      { id: 'B40 I LINE',    mfg: 'Square D', type: 'MJ800',    volts: 600, frameAmp: 800, tripRange: '800', functions: 'TM', cr: [90, 117, 119],       irUnit: 'MΩ', ir: { "A-A'": 144,   "B-B'": 202,   "C-C'": 170 },   ltd: null, ltdSetting: 0, stpu: 'NA', gfpu: 'NA' },
    ],
  },
  {
    deviceId: 'B43N01',
    breakers: [
      { id: 'BLD43 800A N BUSS', mfg: 'Square D', type: 'POWERPACT PJ', volts: 480, frameAmp: 800, tripRange: '.4-1',     functions: 'LSI', cr: [70, 68, 62],      irUnit: 'MΩ', ir: { "A-A'": 0, "B-B'": 0, "C-C'": 0 }, ltd: 20.98, ltdSetting: 1000, stpu: 'Trip', gfpu: 'NA' },
      { id: 'SPARE',             mfg: 'Square D', type: 'POWERPACT LJ', volts: 480, frameAmp: 400, tripRange: '125-400',  functions: 'LSI', cr: [512, 402, 222],   irUnit: 'MΩ', ir: { "A-A'": 0, "B-B'": 0, "C-C'": 0 }, ltd: 'PASS', ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: 'B48C05 DISC SW',    mfg: 'Square D', type: 'POWERPACT LJ', volts: 480, frameAmp: 400, tripRange: '125-400',  functions: 'LSI', cr: [180, 201, 163],   irUnit: 'MΩ', ir: { "A-A'": 0, "B-B'": 0, "C-C'": 0 }, ltd: 'PASS', ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: 'UNLABELED',         mfg: 'Square D', type: 'POWERPACT LJ', volts: 480, frameAmp: 400, tripRange: '125-400',  functions: 'LSI', cr: [227, 189, 213],   irUnit: 'MΩ', ir: { "A-A'": 0, "B-B'": 0, "C-C'": 0 }, ltd: 'PASS', ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: 'B48C02 DISC SW',    mfg: 'Square D', type: 'POWERPACT LJ', volts: 480, frameAmp: 400, tripRange: '125-400',  functions: 'LSI', cr: [167, 177, 197],   irUnit: 'MΩ', ir: { "A-A'": 0, "B-B'": 0, "C-C'": 0 }, ltd: 'PASS', ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: 'B48C03 DISC SW',    mfg: 'Square D', type: 'POWERPACT LJ', volts: 480, frameAmp: 400, tripRange: '125-400',  functions: 'LSI', cr: [171, 165, 208],   irUnit: 'MΩ', ir: { "A-A'": 0, "B-B'": 0, "C-C'": 0 }, ltd: 'PASS', ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: 'B48C01 DISC SW',    mfg: 'Square D', type: 'POWERPACT LJ', volts: 480, frameAmp: 400, tripRange: '125-400',  functions: 'LSI', cr: [300, 271, 256],   irUnit: 'MΩ', ir: { "A-A'": 0, "B-B'": 0, "C-C'": 0 }, ltd: 'PASS', ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: 'PANEL 2HD',         mfg: 'Square D', type: 'POWERPACT LJ', volts: 480, frameAmp: 400, tripRange: '125-400',  functions: 'LSI', cr: [211, 169, 265],   irUnit: 'MΩ', ir: { "A-A'": 0, "B-B'": 0, "C-C'": 0 }, ltd: 'PASS', ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: 'PANEL 2HB',         mfg: 'Square D', type: 'POWERPACT LJ', volts: 480, frameAmp: 400, tripRange: '125-400',  functions: 'LSI', cr: [157, 152, 190],   irUnit: 'MΩ', ir: { "A-A'": 0, "B-B'": 0, "C-C'": 0 }, ltd: 'PASS', ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: 'PANEL 2HA',         mfg: 'Square D', type: 'POWERPACT LJ', volts: 480, frameAmp: 400, tripRange: '125-400',  functions: 'LSI', cr: [217, 171, 197],   irUnit: 'MΩ', ir: { "A-A'": 0, "B-B'": 0, "C-C'": 0 }, ltd: 'PASS', ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: 'B48C04 DISC SW',    mfg: 'Square D', type: 'POWERPACT LJ', volts: 480, frameAmp: 300, tripRange: '125-400',  functions: 'LSI', cr: [186, 1879, 179],  irUnit: 'MΩ', ir: { "A-A'": 0, "B-B'": 0, "C-C'": 0 }, ltd: 'PASS', ltdSetting: 300, stpu: 'Trip', gfpu: 'NA' },
    ],
  },
  {
    deviceId: 'B47S01',
    breakers: [
      { id: 'SPARE 1',        mfg: 'Square D', type: 'PJ1200', volts: 600, frameAmp: 1200, tripRange: '1200', functions: 'LSIG', cr: [42, 39, 37],   irUnit: 'GΩ', ir: { "A-A'": 200, "B-B'": 200, "C-C'": 200 }, ltd: 14.36, ltdSetting: 1200, stpu: 'Trip', gfpu: 'Trip' },
      { id: 'BB36PP01',       mfg: 'Square D', type: 'RK1200', volts: 600, frameAmp: 1200, tripRange: '1200', functions: 'LSIG', cr: [40, 38, 38],   irUnit: 'GΩ', ir: { "A-A'": 200, "B-B'": 200, "C-C'": 200 }, ltd: 14.82, ltdSetting: 1200, stpu: 'Trip', gfpu: 'Trip' },
      { id: '3PB-PRESS',      mfg: 'Square D', type: 'RK1200', volts: 600, frameAmp: 1200, tripRange: '1200', functions: 'LSIG', cr: [50, 51, 53],   irUnit: 'GΩ', ir: { "A-A'": 200, "B-B'": 200, "C-C'": 200 }, ltd: 15.65, ltdSetting: 1200, stpu: 'Trip', gfpu: 'Trip' },
      { id: '3PA',           mfg: 'Square D', type: 'PJ800',  volts: 600, frameAmp: 800,  tripRange: '800',  functions: 'LSI',  cr: [42, 43, 42],   irUnit: 'GΩ', ir: { "A-A'": 200, "B-B'": 200, "C-C'": 200 }, ltd: 15.13, ltdSetting: 800, stpu: 'Trip', gfpu: 'NA' },
      { id: 'F 46',          mfg: 'Square D', type: 'LJ400',  volts: 600, frameAmp: 400,  tripRange: '400',  functions: 'LSI',  cr: [180, 148, 147], irUnit: 'GΩ', ir: { "A-A'": 200, "B-B'": 200, "C-C'": 200 }, ltd: 'PASS', ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: 'SPARE 6',       mfg: 'Square D', type: 'LJ400',  volts: 600, frameAmp: 400,  tripRange: '400',  functions: 'LSI',  cr: [256, 188, 209], irUnit: 'GΩ', ir: { "A-A'": 200, "B-B'": 200, "C-C'": 200 }, ltd: 'PASS', ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      // STORY ASSET 3 (C-phase elevated): the spec's B47S01 3rd-SPARE 403 reading.
      { id: 'SPARE 7',       mfg: 'Square D', type: 'LJ400',  volts: 600, frameAmp: 400,  tripRange: '400',  functions: 'LSI',  cr: [183, 195, 403], irUnit: 'GΩ', ir: { "A-A'": 200, "B-B'": 200, "C-C'": 200 }, ltd: 'PASS', ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: 'SPARE 8',       mfg: 'Square D', type: 'LJ400',  volts: 600, frameAmp: 400,  tripRange: '400',  functions: 'LSI',  cr: [312, 245, 345], irUnit: 'GΩ', ir: { "A-A'": 200, "B-B'": 200, "C-C'": 200 }, ltd: 'PASS', ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: 'SPARE 9',       mfg: 'Square D', type: 'LJ400',  volts: 600, frameAmp: 400,  tripRange: '400',  functions: 'LSI',  cr: [233, 263, 848], irUnit: 'GΩ', ir: { "A-A'": 200, "B-B'": 200, "C-C'": 200 }, ltd: 'PASS', ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      { id: '3HA',           mfg: 'Square D', type: 'LJ400',  volts: 600, frameAmp: 400,  tripRange: '400',  functions: 'LSI',  cr: [127, 122, 128], irUnit: 'GΩ', ir: { "A-A'": 200, "B-B'": 200, "C-C'": 200 }, ltd: 'PASS', ltdSetting: 400, stpu: 'Trip', gfpu: 'NA' },
      // STORY ASSET 3 (IR decline + late trip drift): drive this circuit.
      { id: '3HB',           mfg: 'Square D', type: 'LJ600',  volts: 600, frameAmp: 600,  tripRange: '600',  functions: 'LSI',  cr: [158, 143, 130], irUnit: 'GΩ', ir: { "A-A'": 200, "B-B'": 200, "C-C'": 200 }, ltd: 15.95, ltdSetting: 600, stpu: 'Trip', gfpu: 'NA', story: 'b47_ir_trip' },
      { id: 'New Servo Press', mfg: 'Square D', type: 'PJ800', volts: 600, frameAmp: 800, tripRange: '800',  functions: 'LSI',  cr: [0, 0, 0],      irUnit: 'GΩ', ir: { "A-A'": 200, "B-B'": 200, "C-C'": 200 }, ltd: 14.93, ltdSetting: 800, stpu: 'Trip', gfpu: 'NA', lockedOut: true },
    ],
  },
];

// ── Synthesis parameter table (spec §2) ──────────────────────────────────────
// Contact resistance: worse=up. Insulation resistance: worse=down. LTD timing:
// drifts toward band edge on story asset, otherwise stable.

function pick(rng, lo, hi) { return lo + rng() * (hi - lo); }

// Per-year ambient temperatures for a substation's annual Oct outage test.
// Same mean year to year (same month), small ±C wobble. Deterministic.
function ambientForYear(deviceId, year) {
  const rng = rngFor('ambient', deviceId, String(year));
  let t = 22 + gauss(rng) * 4;
  if (t < 12) t = 12;
  if (t > 34) t = 34;
  return round(t, 1);
}

// Build the YoY series for ONE contact-resistance phase reading.
// Returns map year -> { asFound, asLeft } in µΩ (raw, at that year's ambient).
function synthContactResistance(deviceId, breaker, phaseIdx, phaseLabel) {
  const v2025 = breaker.cr[phaseIdx];
  const series = {};
  // Locked-out / zero anchor: no synthesis, every year reads 0 (not tested).
  if (!v2025 || v2025 === 0) {
    for (let y = FIRST_YEAR; y <= ANCHOR_YEAR; y++) series[y] = { asFound: 0, asLeft: 0, event: false };
    return series;
  }
  const rng = rngFor('cr', deviceId, breaker.id, phaseLabel);

  // Story behaviour overrides drift/event for the targeted phase.
  const story = breaker.story;
  let driftPerYear, eventProb, allowEvent = true;
  if (story === 'b41_cphase' && phaseLabel === 'C') {
    // A141 C-phase: high drift toward 2025, single cleaning event ~2020.
    driftPerYear = pick(rng, 0.06, 0.08);
    eventProb = 0; allowEvent = false; // we place the event deterministically below
  } else if (story === 'b41_cphase') {
    driftPerYear = pick(rng, 0.015, 0.025); // A/B near-flat
    eventProb = 0.03;
  } else if (deviceId === 'B36S01' && (breaker.id === 'SPARE 1' || breaker.id === 'SPARE 7') && phaseLabel === 'A') {
    // STORY ASSET 2: B36S01 A-phase creep (SPARE 1 / SPARE 7). Untouched.
    driftPerYear = pick(rng, 0.06, 0.075);
    eventProb = 0; allowEvent = false;
  } else {
    // Healthy reference: low drift, rare cleaning.
    driftPerYear = pick(rng, 0.02, 0.035);
    eventProb = 0.05;
  }
  const noiseSigma = pick(rng, 0.04, 0.07);

  // trend[] walks backward from anchor.
  const trend = {}; trend[ANCHOR_YEAR] = v2025;
  for (let y = ANCHOR_YEAR - 1; y >= FIRST_YEAR; y--) {
    trend[y] = trend[y + 1] / (1 + driftPerYear);
  }

  for (let y = ANCHOR_YEAR; y >= FIRST_YEAR; y--) {
    if (y === ANCHOR_YEAR) {
      series[y] = { asFound: v2025, asLeft: v2025, event: false }; // anchor verbatim
      continue;
    }
    const tempC = ambientForYear(deviceId, y);
    let asFoundTrend = trend[y];
    let event = false;
    let asLeftTrend = trend[y];

    // Deterministic story cleaning event for A141 C-phase ~2020: as-found
    // bumps up, as-left returns to trend (the "cleaned once, crept back" arc).
    if (story === 'b41_cphase' && phaseLabel === 'C' && y === 2020) {
      asFoundTrend = trend[y] * pick(rng, 1.5, 1.8);
      asLeftTrend = trend[y];
      event = true;
    } else if (allowEvent && rng() < eventProb) {
      asFoundTrend = trend[y] * pick(rng, 1.3, 1.8);
      asLeftTrend = trend[y];
      event = true;
    }

    const noise = 1 + gauss(rng) * noiseSigma;
    const tf = crTempFactor(tempC);
    const asFound = Math.max(0.5, round(asFoundTrend * noise * tf, 1));
    const asLeft = event
      ? Math.max(0.5, round(asLeftTrend * (1 + gauss(rng) * noiseSigma * 0.5) * tf, 1))
      : asFound;
    series[y] = { asFound, asLeft, event };
  }
  return series;
}

// Pass/fail for contact resistance, evaluated per spec §2: phase ≥1.5-2x
// siblings, or >1.5x the breaker's own oldest-year baseline. Returns
// 'GREEN'|'YELLOW'|'RED' and an expectedRange string.
function crPassFail(value, siblingValues, baseline) {
  const sibs = siblingValues.filter((v) => v > 0);
  const minSib = sibs.length ? Math.min(...sibs) : value;
  const ratioSib = minSib > 0 ? value / minSib : 1;
  const ratioBase = baseline > 0 ? value / baseline : 1;
  let rating = 'GREEN';
  if (value > 300 || ratioSib >= 2 || ratioBase >= 2) rating = 'RED';
  else if (value > 150 || ratioSib >= 1.5 || ratioBase >= 1.5) rating = 'YELLOW';
  return { rating, expectedRange: '<1.5x phase spread / <1.5x baseline (NETA MTS)' };
}

// Insulation resistance YoY series for one line-to-load reading.
// worse=down. Returns year -> { raw, corrected, tempC } in the breaker's unit.
function synthInsulationResistance(deviceId, breaker, phaseLabel) {
  const v2025 = breaker.ir[phaseLabel];
  const series = {};
  if (v2025 == null || v2025 === 0) {
    for (let y = FIRST_YEAR; y <= ANCHOR_YEAR; y++) {
      series[y] = { raw: v2025 == null ? null : 0, corrected: v2025 == null ? null : 0, tempC: ambientForYear(deviceId, y) };
    }
    return series;
  }
  const rng = rngFor('ir', deviceId, breaker.id, phaseLabel);
  const story = breaker.story === 'b47_ir_trip';

  // Decline toward worse going forward => older years are HIGHER (healthier).
  const driftPerYear = story ? pick(rng, 0.06, 0.07) : pick(rng, 0.03, 0.05);
  const noiseSigma = pick(rng, 0.08, 0.15);

  const trend = {}; trend[ANCHOR_YEAR] = v2025;
  for (let y = ANCHOR_YEAR - 1; y >= FIRST_YEAR; y--) {
    trend[y] = trend[y + 1] * (1 + driftPerYear); // older = higher IR
  }

  for (let y = ANCHOR_YEAR; y >= FIRST_YEAR; y--) {
    const tempC = ambientForYear(deviceId, y);
    if (y === ANCHOR_YEAR) {
      series[y] = { raw: v2025, corrected: v2025, tempC };
      continue;
    }
    // Story moisture dip + recovery event mid-window (re-gasket) ~2021.
    let factor = 1;
    if (story && y === 2021) factor = pick(rng, 0.55, 0.7); // as-found dip
    const corrected = Math.max(0.01, round(trend[y] * factor, 2));
    // raw = corrected un-corrected for that year's ambient: raw = corrected / TCF
    const raw = Math.max(0.01, round((corrected / irTcf(tempC)) * (1 + gauss(rng) * noiseSigma), 2));
    series[y] = { raw, corrected, tempC };
  }
  return series;
}

function irPassFail(corrected, baseline) {
  // worse=down: flag a >50% drop vs baseline (spec §2).
  let rating = 'GREEN';
  if (baseline > 0) {
    const dropPct = (baseline - corrected) / baseline;
    if (dropPct > 0.6) rating = 'RED';
    else if (dropPct > 0.5) rating = 'YELLOW';
  }
  return { rating, expectedRange: 'no >50% YoY drop vs baseline (IEEE 43, 20C corrected)' };
}

// LTD timing YoY series (only for breakers with numeric LTD). worse = drift to
// band edge on story asset. Band per report = 13-17 s where applicable.
function synthLtd(deviceId, breaker) {
  if (typeof breaker.ltd !== 'number') return null;
  const v2025 = breaker.ltd;
  const story = breaker.story === 'b47_ir_trip';
  const rng = rngFor('ltd', deviceId, breaker.id);
  const series = {};
  // Going backward, story asset was MORE centred (healthier) in older years;
  // recent years drift toward the 17 s upper edge ("investigate").
  const driftPerYear = story ? pick(rng, 0.012, 0.02) : pick(rng, 0.002, 0.006);
  const noiseSigma = pick(rng, 0.02, 0.04);
  const trend = {}; trend[ANCHOR_YEAR] = v2025;
  for (let y = ANCHOR_YEAR - 1; y >= FIRST_YEAR; y--) {
    trend[y] = trend[y + 1] / (1 + driftPerYear); // older = lower (more centred)
  }
  for (let y = ANCHOR_YEAR; y >= FIRST_YEAR; y--) {
    if (y === ANCHOR_YEAR) { series[y] = round(v2025, 2); continue; }
    series[y] = round(trend[y] * (1 + gauss(rng) * noiseSigma), 2);
  }
  return series;
}

function ltdPassFail(seconds) {
  // Band 13-17 s (spec). Outside => investigate.
  let rating = 'GREEN';
  if (seconds < 13 || seconds > 17) rating = 'YELLOW';
  if (seconds < 12 || seconds > 18) rating = 'RED';
  return { rating, expectedRange: '13-17 s (LTD band)' };
}

// Each year's test date ~ late October of that year.
function testDateFor(year, deviceId) {
  const rng = rngFor('date', deviceId, String(year));
  const day = 18 + Math.floor(rng() * 12); // 18-29 Oct
  return new Date(Date.UTC(year, 9, day, 15, 0, 0)); // month 9 = Oct
}

// ── Reset (delete-then-recreate ONLY this account's tree) ────────────────────
async function _resetPowerdbAccount() {
  const filter = { accountId: POWERDB_ACCOUNT_ID };
  await prisma.activityLog.deleteMany({
    where: {
      OR: [
        { accountId: POWERDB_ACCOUNT_ID },
        { user: { accountId: POWERDB_ACCOUNT_ID } },
        { asset: { accountId: POWERDB_ACCOUNT_ID } },
      ],
    },
  }).catch(() => {});

  await prisma.alert.deleteMany({ where: filter }).catch(() => {});
  await prisma.testMeasurement.deleteMany({ where: filter }).catch(() => {});
  await prisma.deficiency.deleteMany({ where: filter }).catch(() => {});
  await prisma.labSample.deleteMany({ where: filter }).catch(() => {});
  await prisma.workOrder.deleteMany({ where: filter }).catch(() => {});
  await prisma.maintenanceSchedule.deleteMany({ where: filter }).catch(() => {});
  await prisma.maintenanceTaskDefinition.deleteMany({ where: filter }).catch(() => {});

  await prisma.customFieldValue.deleteMany({ where: { asset: { accountId: POWERDB_ACCOUNT_ID } } }).catch(() => {});
  await prisma.communication.deleteMany({ where: filter }).catch(() => {});
  await prisma.ingestionSession.deleteMany({ where: filter }).catch(() => {});
  await prisma.document.deleteMany({ where: filter }).catch(() => {});
  await prisma.asset.deleteMany({ where: filter });

  await prisma.equipmentPosition.deleteMany({ where: filter }).catch(() => {});
  await prisma.area.deleteMany({ where: filter }).catch(() => {});
  await prisma.building.deleteMany({ where: filter }).catch(() => {});
  await prisma.auditRecommendation.deleteMany({ where: filter }).catch(() => {});
  await prisma.auditVisit.deleteMany({ where: filter }).catch(() => {});
  await prisma.systemStudy.deleteMany({ where: filter }).catch(() => {});
  await prisma.blackoutWindow.deleteMany({ where: filter }).catch(() => {});
  await prisma.quoteRequest.deleteMany({ where: filter }).catch(() => {});
  await prisma.site.deleteMany({ where: filter });

  await prisma.contractorTech.deleteMany({ where: { contractor: { accountId: POWERDB_ACCOUNT_ID } } }).catch(() => {});
  await prisma.contractor.deleteMany({ where: filter });

  await prisma.standardRevisionAlert.deleteMany({ where: filter }).catch(() => {});
  await prisma.notificationLog.deleteMany({ where: filter }).catch(() => {});
  await prisma.outboundWebhookDLQ.deleteMany({ where: filter }).catch(() => {});
  await prisma.webhookEndpoint.deleteMany({ where: filter }).catch(() => {});
  await prisma.apiKey.deleteMany({ where: filter }).catch(() => {});
  await prisma.consultantAccess.deleteMany({ where: filter }).catch(() => {});
  await prisma.userInvite.deleteMany({ where: filter }).catch(() => {});
  await prisma.accountSetting.deleteMany({ where: filter }).catch(() => {});
  await prisma.backupLog.deleteMany({ where: filter }).catch(() => {});
  await prisma.customFieldDefinition.deleteMany({ where: filter }).catch(() => {});

  await prisma.alertPreference.deleteMany({ where: { user: { accountId: POWERDB_ACCOUNT_ID } } }).catch(() => {});
  await prisma.userPreference.deleteMany({ where: { user: { accountId: POWERDB_ACCOUNT_ID } } }).catch(() => {});
  await prisma.aiUsage.deleteMany({ where: { user: { accountId: POWERDB_ACCOUNT_ID } } }).catch(() => {});
  await prisma.refreshToken.deleteMany({ where: { user: { accountId: POWERDB_ACCOUNT_ID } } }).catch(() => {});
  await prisma.user.deleteMany({ where: filter });

  try {
    await prisma.account.delete({ where: { id: POWERDB_ACCOUNT_ID } });
  } catch (err) {
    if (err.code !== 'P2025') throw err;
  }
}

// ── Shared equipment+history seeder ──────────────────────────────────────────
// Creates ONLY the PowerDB equipment tree + multi-year test history under an
// EXISTING account (the caller owns the Account + User). Builds: a Site, one
// Building + Area, EquipmentPosition rows, the 4 substation parent assets, the
// 45 breaker child assets (fedFromAssetId -> parent), and per-year WorkOrders +
// TestMeasurements (+ story deficiencies). Does NOT create an Account or User.
//
//   await seedPowerDbInto(prisma, accountId, {
//     siteName: 'Cedar Ridge Facility',  // site label
//     ownerUserId: admin.id,             // optional: set asset.ownerId
//     log: console.log,                  // optional progress logger
//   })
//
// Returns { assets, workOrders, measurements }.
async function seedPowerDbInto(db, accountId, opts = {}) {
  const {
    siteName = 'Cedar Ridge Facility',
    ownerUserId = null,
    log = () => {},
  } = opts;

  const counts = { assets: 0, workOrders: 0, measurements: 0 };

  // ── Contractor (Apex Power Testing LLC) ────────────────────────────────────
  // Contractor only requires accountId + name; everything else optional. It is
  // account-scoped, so the account-tree reset wipes it with everything else.
  const contractor = await db.contractor.create({
    data: {
      accountId,
      name: 'Apex Power Testing LLC',
      netaAccredited: true,
      supportEmail: 'dispatch@apexpowertesting-demo.local',
      supportPhone: '800-555-0177',
      notes: 'Annual outage testing partner (fictional).',
    },
  });

  // ── Site / building / area ────────────────────────────────────────────────
  const site = await db.site.create({
    data: {
      accountId,
      name: siteName,
      address: '1200 Cedar Ridge Road', city: 'Plainfield', state: 'WI', postalCode: '54966',
      primaryContactName: 'Riley Morgan', primaryContactEmail: 'powerdb@demo.local',
      primaryContactPhone: '555-200-3300',
      notes: 'Food-processing plant. Four LV unit substations on the production floor.',
    },
  });
  const building = await db.building.create({
    data: { accountId, siteId: site.id, name: 'Production Floor' },
  });
  const area = await db.area.create({
    data: { accountId, siteId: site.id, buildingId: building.id, name: 'Bay 4' },
  });

  log('[powerdb-seed] creating assets (substations + breakers)...');
  // ── Parent substations + child breakers ────────────────────────────────────
  // Parents are created BEFORE children so the breaker fedFromAssetId
  // self-relation resolves to an already-existing substation asset.
  const breakerAssets = []; // { asset, deviceId, breaker }
  for (const sub of SUBSTATIONS) {
    const position = await db.equipmentPosition.create({
      data: {
        accountId, siteId: site.id, areaId: area.id,
        name: `Unit Substation ${sub.deviceId}`, code: sub.deviceId,
      },
    });
    const parent = await db.asset.create({
      data: {
        accountId, siteId: site.id, buildingId: building.id, areaId: area.id,
        positionId: position.id,
        ...(ownerUserId ? { ownerId: ownerUserId } : {}),
        equipmentType: 'SWITCHGEAR',
        manufacturer: 'Square D',
        serialNumber: sub.deviceId,
        nameplateData: {
          deviceId: sub.deviceId, equipmentDesignation: 'Unit Substation',
          systemVoltage: '480Y/277V', ratedCurrent: 3000, breakerCount: sub.breakers.length,
        },
        notes: `LV unit substation ${sub.deviceId}; ${sub.breakers.length} breakers tested annually.`,
      },
    });
    counts.assets++;

    for (const br of sub.breakers) {
      const child = await db.asset.create({
        data: {
          accountId, siteId: site.id, buildingId: building.id, areaId: area.id,
          positionId: position.id,
          ...(ownerUserId ? { ownerId: ownerUserId } : {}),
          equipmentType: 'CIRCUIT_BREAKER',
          manufacturer: br.mfg,
          model: br.type,
          fedFromAssetId: parent.id, // breaker fed from its parent substation
          nameplateData: {
            deviceId: sub.deviceId, circuitDesignation: br.id,
            mfg: br.mfg, type: br.type, volts: br.volts,
            frameAmp: br.frameAmp, tripAmpRange: br.tripRange, functions: br.functions,
          },
          notes: `${sub.deviceId} / ${br.id} (${br.mfg} ${br.type})`,
        },
      });
      counts.assets++;
      breakerAssets.push({ asset: child, deviceId: sub.deviceId, breaker: br });
    }
  }

  log('[powerdb-seed] generating ' + (YEARS_BACK + 1) + ' years of work orders + measurements...');
  // ── Per breaker per year: WorkOrder + TestMeasurements ─────────────────────
  const phaseLabels = ['A', 'B', 'C'];
  const irPhases = ["A-A'", "B-B'", "C-C'"];

  for (const { asset, deviceId, breaker } of breakerAssets) {
    // Pre-compute series per reading.
    const crSeries = phaseLabels.map((p, i) => synthContactResistance(deviceId, breaker, i, p));
    const irSeries = irPhases.map((p) => synthInsulationResistance(deviceId, breaker, p));
    const ltdSeries = synthLtd(deviceId, breaker); // null if no numeric LTD

    for (let year = FIRST_YEAR; year <= ANCHOR_YEAR; year++) {
      const completedDate = testDateFor(year, deviceId);
      const ambientTempC = ambientForYear(deviceId, year);

      const wo = await db.workOrder.create({
        data: {
          accountId,
          assetId: asset.id,
          contractorId: contractor.id,
          status: 'COMPLETE',
          scheduledDate: completedDate,
          startedAt: completedDate,
          completedDate,
          netaDecal: 'GREEN', // refined below if any measurement flags
          ambientTempC,
          testEquipment: [
            { make: 'Megger', model: 'DLRO-10HD micro-ohmmeter', serial: 'MG-DLRO-7781', calDate: `${year}-09-15` },
            { make: 'Megger', model: 'MIT1025 insulation tester', serial: 'MG-MIT-4420', calDate: `${year}-09-15` },
          ],
          notes: `Annual outage test — ${deviceId} / ${breaker.id} (${year}).`,
        },
      });
      counts.workOrders++;

      let worstRating = 'GREEN';
      const bump = (r) => {
        if (r === 'RED') worstRating = 'RED';
        else if (r === 'YELLOW' && worstRating !== 'RED') worstRating = 'YELLOW';
      };

      // Contact resistance: 3 phase rows (unit µΩ).
      const crYearVals = crSeries.map((s) => s[year].asFound);
      for (let i = 0; i < 3; i++) {
        const s = crSeries[i][year];
        if (s.asFound === 0 && breaker.lockedOut) {
          // Locked-out breaker: record a not-tested row with notes.
          await db.testMeasurement.create({
            data: {
              accountId, workOrderId: wo.id,
              measurementType: 'contact_resistance', phase: phaseLabels[i],
              asFoundValue: null, asFoundUnit: 'µΩ',
              passFail: null, notes: 'Breaker locked out — contact resistance not performed.',
            },
          });
          counts.measurements++;
          continue;
        }
        const siblings = crYearVals.filter((_, j) => j !== i);
        const baseline = crSeries[i][FIRST_YEAR].asFound;
        const { rating, expectedRange } = crPassFail(s.asFound, siblings, baseline);
        bump(rating);
        await db.testMeasurement.create({
          data: {
            accountId, workOrderId: wo.id,
            measurementType: 'contact_resistance', phase: phaseLabels[i],
            asFoundValue: s.asFound, asFoundUnit: 'µΩ',
            asLeftValue: s.asLeft, asLeftUnit: 'µΩ',
            passFail: rating, expectedRange,
            notes: s.event ? 'Contacts cleaned/re-torqued (as-found vs as-left gap).' : null,
          },
        });
        counts.measurements++;
      }

      // Insulation resistance: line-to-load rows (A-A', B-B', C-C').
      for (let p = 0; p < irPhases.length; p++) {
        const s = irSeries[p][year];
        if (s.raw == null) continue; // reading not present in source
        const baseline = irSeries[p][FIRST_YEAR].corrected;
        const { rating, expectedRange } = irPassFail(s.corrected, baseline);
        if (s.raw > 0) bump(rating);
        await db.testMeasurement.create({
          data: {
            accountId, workOrderId: wo.id,
            measurementType: 'insulation_resistance', phase: irPhases[p],
            asFoundValue: s.raw, asFoundUnit: breaker.irUnit,
            asLeftValue: s.corrected, asLeftUnit: `${breaker.irUnit} @20C`,
            passFail: s.raw > 0 ? rating : null,
            expectedRange,
            testVoltage: '1000 V DC',
            notes: `20C-corrected: ${s.corrected} ${breaker.irUnit} (raw at ${s.tempC}C).`,
          },
        });
        counts.measurements++;
      }

      // Trip-unit results: LTD timing (numeric series) or PASS, plus STPU/GFPU.
      if (ltdSeries) {
        const sec = ltdSeries[year];
        const { rating, expectedRange } = ltdPassFail(sec);
        bump(rating);
        await db.testMeasurement.create({
          data: {
            accountId, workOrderId: wo.id,
            measurementType: 'trip_unit_ltd', phase: null,
            asFoundValue: sec, asFoundUnit: 's',
            passFail: rating, expectedRange,
            notes: 'Long-time-delay trip timing (primary injection).',
          },
        });
        counts.measurements++;
      } else if (breaker.ltd === 'PASS') {
        await db.testMeasurement.create({
          data: {
            accountId, workOrderId: wo.id,
            measurementType: 'trip_unit_ltd', phase: null,
            asFoundValue: null, asFoundUnit: null,
            passFail: 'GREEN', expectedRange: 'PASS (test-set verified)',
            notes: 'LTD function PASS (test-set provided pass/fail).',
          },
        });
        counts.measurements++;
      }

      // STPU result row (trip / no-trip), where applicable.
      if (breaker.stpu && breaker.stpu !== 'NA') {
        const stpuPass = breaker.stpu === 'Trip' ? 'GREEN' : 'RED';
        await db.testMeasurement.create({
          data: {
            accountId, workOrderId: wo.id,
            measurementType: 'trip_unit_stpu', phase: null,
            asFoundValue: null, asFoundUnit: null,
            passFail: stpuPass, expectedRange: 'Trip',
            notes: `Short-time pickup result: ${breaker.stpu}.`,
          },
        });
        counts.measurements++;
      }

      // GFPU result row (trip / no-trip / NA).
      if (breaker.gfpu && breaker.gfpu !== 'NA') {
        const gfpuPass = breaker.gfpu === 'Trip' ? 'GREEN' : 'RED';
        await db.testMeasurement.create({
          data: {
            accountId, workOrderId: wo.id,
            measurementType: 'trip_unit_gfpu', phase: null,
            asFoundValue: null, asFoundUnit: null,
            passFail: gfpuPass, expectedRange: 'Trip',
            notes: `Ground-fault pickup result: ${breaker.gfpu}.`,
          },
        });
        counts.measurements++;
      }

      // Roll the work order's decal up to the worst measurement rating.
      if (worstRating !== 'GREEN') {
        await db.workOrder.update({
          where: { id: wo.id },
          data: { netaDecal: worstRating },
        });
      }
    }

    // Spawn a current (2025) deficiency on the flagged story breakers so the
    // YoY callout has a matching finding record.
    if (breaker.story === 'b41_cphase') {
      await db.deficiency.create({
        data: {
          accountId, assetId: asset.id,
          severity: 'RECOMMENDED',
          description: `A141 HIGH CONTACT RESISTANCE ON C PHASE — ${breaker.id}`,
          correctiveAction: 'Suggest remove and clean contacts.',
          createdAt: testDateFor(ANCHOR_YEAR, deviceId),
        },
      });
    }
  }

  log('[powerdb-seed] equipment + history done.');
  return counts;
}

// ── Standalone (Northwind Foods) seed ────────────────────────────────────────
// Creates the dedicated Northwind account + admin user, then layers the shared
// equipment+history onto it via seedPowerDbInto. Running this file directly
// still produces the standalone Northwind demo exactly as before.
async function seedPowerdbDemo() {
  console.log('[powerdb-seed] resetting account tree...');
  await _resetPowerdbAccount();

  // Make the whole instance "set up" so this account is immediately usable and
  // not blocked behind the setup wizard. setupCompletedAt lives on the global
  // InstanceConfig singleton (not on Account). Idempotent upsert.
  await prisma.instanceConfig.upsert({
    where: { id: 'singleton' },
    update: { setupCompletedAt: new Date() },
    create: { id: 'singleton', setupCompletedAt: new Date() },
  });

  console.log('[powerdb-seed] creating account + user...');
  const account = await prisma.account.create({
    data: {
      id: POWERDB_ACCOUNT_ID,
      companyName: 'Northwind Foods',
      status: 'active',
      planType: 'licensed',   // self-host licensed — bypasses SaaS tier enforcement
      planTier: 'mid',
      aiBriefEnabled: true,
      fteCount: 240,
      // Recent activity timestamp keeps the row OUT of the demoPrune TTL sweep
      // (lastActiveAt < cutoff won't match; non-null avoids the never-returned
      // NULL branch). This is NOT a per-visitor sandbox TTL marker.
      lastActiveAt: new Date(),
      serviceRepName: 'Jordan Avery',
      serviceRepEmail: 'javery@example-electrical.com',
      serviceRepPhone: '(555) 200-3344',
    },
  });

  const passwordHash = await bcrypt.hash('Powerdb1234!', 12);
  const user = await prisma.user.create({
    data: {
      accountId: account.id,
      name: 'Riley Morgan',
      email: 'powerdb@demo.local',
      passwordHash,
      role: 'admin',
    },
  });

  // Skip the onboarding wizard for this account.
  await prisma.accountSetting.create({
    data: { accountId: account.id, key: 'ONBOARDING_COMPLETE', value: 'true' },
  });

  const counts = await seedPowerDbInto(prisma, account.id, {
    siteName: 'Cedar Ridge Facility',
    ownerUserId: user.id,
    log: console.log,
  });
  counts.account = account.id;

  console.log('[powerdb-seed] done.');
  return counts;
}

// ── CLI entry ────────────────────────────────────────────────────────────────
if (require.main === module) {
  seedPowerdbDemo()
    .then((c) => {
      console.log('\nPowerDB demo seed complete:');
      console.log(JSON.stringify({ account: 'Northwind Foods', ...c }, null, 2));
      console.log('\nLogin:');
      console.log('  powerdb@demo.local / Powerdb1234!  (admin)');
      console.log(`\nCounts -> assets: ${c.assets}, workOrders: ${c.workOrders}, measurements: ${c.measurements}`);
      return prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error('[powerdb-seed] FAILED:', err);
      await prisma.$disconnect();
      process.exit(1);
    });
}

module.exports = { seedPowerDbInto, seedPowerdbDemo, POWERDB_ACCOUNT_ID };
