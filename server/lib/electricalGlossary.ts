/**
 * lib/electricalGlossary.ts — symbol / marking glossary for electrical drawings
 * and test reports (punch #4).
 *
 * A deterministic reference for the shorthand that shows up on one-lines, in
 * arc-flash / short-circuit study reports, and on NETA/NECA test reports:
 *   - IEEE C37.2 device FUNCTION NUMBERS (52 = breaker, 87 = differential, …)
 *     plus the standard SUFFIX letters (G = ground, N = neutral, T = transformer)
 *   - common IEEE 315 one-line device ABBREVIATIONS (SWGR, ATS, MCC, PDU, …)
 *   - NETA/NECA acceptance-test MARKINGS/abbreviations (IR, PI, TTR, DLRO, …)
 *
 * This is a legibility layer for the system of record — it EXPLAINS captured
 * designations, it does not compute or validate anything (no PPE, no analysis).
 * It complements lib/testReportParse.ts (which knows test MEASUREMENTS + their
 * IEEE 43 floors); this file knows what the DESIGNATIONS themselves mean.
 *
 *   lookupDesignation(raw)   -> GlossaryEntry[]  (exact + combo + suffix aware)
 *   explainDesignation(raw)  -> short human string | null
 *   annotateText(text)       -> [{ token, entries }]  for surfacing in the UI
 */

'use strict';

export type GlossaryCategory =
  | 'device_number'
  | 'device_suffix'
  | 'oneline_symbol'
  | 'test_marking'
  | 'test_standard';

export interface GlossaryEntry {
  code: string;            // canonical token, uppercased (e.g. "52", "SWGR", "IR")
  term: string;            // human name
  description: string;     // one-line plain-English explanation
  category: GlossaryCategory;
  standardRef: string;     // e.g. "IEEE C37.2", "IEEE 315", "NETA ATS"
  aliases?: string[];      // alternate spellings the same entry answers to
}

// ── IEEE C37.2 device function numbers (the commonly-encountered set) ─────────
const DEVICE_NUMBERS: GlossaryEntry[] = [
  { code: '1',  term: 'Master element', description: 'Initiating device such as a control switch that puts the equipment into or out of service.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '2',  term: 'Time-delay starting/closing relay', description: 'Introduces a time delay before (or in) a starting or closing sequence.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '3',  term: 'Checking / interlocking relay', description: 'Verifies that a condition or sequence is satisfied before permitting an operation.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '21', term: 'Distance relay', description: 'Operates on the impedance/distance to a fault; common transmission-line protection.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '25', term: 'Synchronizing / sync-check', description: 'Permits paralleling of two sources only when voltage, phase, and frequency match.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '27', term: 'Undervoltage relay', description: 'Trips or alarms when voltage falls below a set threshold.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '30', term: 'Annunciator relay', description: 'Non-automatically-reset device that indicates which of several conditions occurred.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '32', term: 'Directional power relay', description: 'Operates on real power flow in a defined direction (e.g. reverse-power).', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '37', term: 'Undercurrent / underpower relay', description: 'Operates when current or power drops below a set value (loss of load).', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '40', term: 'Field / loss-of-field relay', description: 'Detects loss or failure of a machine field (generator/synchronous motor).', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '46', term: 'Reverse-phase / phase-balance current relay', description: 'Operates on current unbalance or negative-sequence current.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '47', term: 'Phase-sequence / phase-balance voltage relay', description: 'Operates on voltage unbalance or wrong phase sequence.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '49', term: 'Thermal relay (machine/transformer)', description: 'Operates on measured or modeled thermal overload of a machine or transformer.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '50', term: 'Instantaneous overcurrent relay', description: 'Operates with no intentional time delay on overcurrent above a set pickup.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '51', term: 'AC time-overcurrent relay', description: 'Operates on overcurrent with an inverse time-current characteristic.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '52', term: 'AC circuit breaker', description: 'The power circuit breaker that interrupts fault and load current.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '55', term: 'Power-factor relay', description: 'Operates on power factor above/below a set value.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '59', term: 'Overvoltage relay', description: 'Trips or alarms when voltage rises above a set threshold.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '60', term: 'Voltage / current balance relay', description: 'Operates on the difference between two voltages or two currents (e.g. blown-fuse detection).', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '62', term: 'Time-delay stopping / opening relay', description: 'Introduces a time delay in a stopping or opening sequence.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '63', term: 'Pressure switch / sudden-pressure relay', description: 'Operates on fluid/gas pressure — e.g. transformer sudden-pressure (rapid rise) protection.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '64', term: 'Ground-fault (ground detector) relay', description: 'Detects insulation failure to ground; 64 variants protect stator, field, etc.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '67', term: 'AC directional overcurrent relay', description: 'Overcurrent element that operates only for current in a defined direction.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '68', term: 'Blocking / out-of-step relay', description: 'Blocks tripping (or initiates it) during power swings / out-of-step conditions.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '69', term: 'Permissive control device', description: 'Two-position device that permits or prevents a subsequent operation.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '74', term: 'Alarm relay', description: 'Operates an audible or visible alarm (not a monitored trip path).', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '78', term: 'Phase-angle / out-of-step relay', description: 'Operates on phase-angle difference (out-of-step protection).', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '79', term: 'AC reclosing relay', description: 'Automatically recloses a breaker after a trip, per a set reclose sequence.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '81', term: 'Frequency relay', description: 'Operates on over/under-frequency or rate-of-change of frequency.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '85', term: 'Pilot / communications channel', description: 'Carrier, pilot-wire, or fiber channel used by line protection schemes.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '86', term: 'Lockout relay (hand-reset)', description: 'Latching trip-and-lockout relay; must be manually reset before re-closing.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '87', term: 'Differential protective relay', description: 'Operates on the difference of currents into and out of a zone (bus/xfmr/gen/line).', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '90', term: 'Regulating device', description: 'Regulates a quantity (voltage, current, power) to a set value.', category: 'device_number', standardRef: 'IEEE C37.2' },
  { code: '94', term: 'Tripping / trip-free relay', description: 'Trips a breaker (auxiliary tripping relay); trip-free prevents re-close against a fault.', category: 'device_number', standardRef: 'IEEE C37.2' },
];

// ── C37.2 suffix letters (append to a device number, e.g. 51G, 87T, 50N) ──────
const DEVICE_SUFFIXES: GlossaryEntry[] = [
  { code: 'G', term: 'Ground', description: 'Applies to a ground connection/element (e.g. 51G = time-overcurrent ground).', category: 'device_suffix', standardRef: 'IEEE C37.2' },
  { code: 'N', term: 'Neutral', description: 'Applies to the neutral conductor/element (e.g. 50N = instantaneous neutral overcurrent).', category: 'device_suffix', standardRef: 'IEEE C37.2' },
  { code: 'T', term: 'Transformer', description: 'Applies to a transformer (e.g. 87T = transformer differential).', category: 'device_suffix', standardRef: 'IEEE C37.2' },
  { code: 'B', term: 'Bus', description: 'Applies to a bus (e.g. 87B = bus differential).', category: 'device_suffix', standardRef: 'IEEE C37.2' },
  { code: 'L', term: 'Line', description: 'Applies to a line/feeder (e.g. 87L = line differential).', category: 'device_suffix', standardRef: 'IEEE C37.2' },
  { code: 'GS', term: 'Ground sensor', description: 'Ground-sensor (zero-sequence CT) source for a ground element.', category: 'device_suffix', standardRef: 'IEEE C37.2' },
];

// ── Common IEEE 315 one-line device abbreviations ─────────────────────────────
const ONELINE_SYMBOLS: GlossaryEntry[] = [
  { code: 'CB', term: 'Circuit breaker', description: 'Power circuit breaker (see also device number 52).', category: 'oneline_symbol', standardRef: 'IEEE 315', aliases: ['BKR', 'BRKR'] },
  { code: 'FU', term: 'Fuse', description: 'Overcurrent protective fuse.', category: 'oneline_symbol', standardRef: 'IEEE 315', aliases: ['FUSE'] },
  { code: 'DS', term: 'Disconnect switch', description: 'Isolating/disconnect switch (may be load-break or non-load-break).', category: 'oneline_symbol', standardRef: 'IEEE 315', aliases: ['DISC', 'SW'] },
  { code: 'XFMR', term: 'Transformer', description: 'Power or distribution transformer.', category: 'oneline_symbol', standardRef: 'IEEE 315', aliases: ['XFR', 'TX', 'TFMR', 'TRANSFORMER'] },
  { code: 'SWGR', term: 'Switchgear', description: 'Metal-clad/metal-enclosed switchgear lineup.', category: 'oneline_symbol', standardRef: 'IEEE 315', aliases: ['SWG'] },
  { code: 'SWBD', term: 'Switchboard', description: 'Distribution switchboard.', category: 'oneline_symbol', standardRef: 'IEEE 315', aliases: ['SB'] },
  { code: 'MCC', term: 'Motor control center', description: 'Assembly of motor starters/feeders in a common enclosure.', category: 'oneline_symbol', standardRef: 'IEEE 315' },
  { code: 'PNL', term: 'Panelboard', description: 'Branch-circuit panelboard.', category: 'oneline_symbol', standardRef: 'IEEE 315', aliases: ['PANEL', 'PB'] },
  { code: 'ATS', term: 'Automatic transfer switch', description: 'Automatically transfers load between two sources (e.g. utility ↔ generator).', category: 'oneline_symbol', standardRef: 'IEEE 315' },
  { code: 'MTS', term: 'Manual transfer switch', description: 'Manually transfers load between two sources.', category: 'oneline_symbol', standardRef: 'IEEE 315' },
  { code: 'STS', term: 'Static transfer switch', description: 'Solid-state, sub-cycle transfer switch between two sources.', category: 'oneline_symbol', standardRef: 'IEEE 315' },
  { code: 'GEN', term: 'Generator', description: 'Engine-generator or other on-site generation source.', category: 'oneline_symbol', standardRef: 'IEEE 315', aliases: ['GENSET'] },
  { code: 'UPS', term: 'Uninterruptible power supply', description: 'Battery/flywheel-backed supply for ride-through and conditioning.', category: 'oneline_symbol', standardRef: 'IEEE 315' },
  { code: 'PDU', term: 'Power distribution unit', description: 'Distributes power (often with an isolation transformer) to critical loads.', category: 'oneline_symbol', standardRef: 'IEEE 315' },
  { code: 'RPP', term: 'Remote power panel', description: 'Remote branch-circuit panel fed from a PDU.', category: 'oneline_symbol', standardRef: 'IEEE 315' },
  { code: 'CT', term: 'Current transformer', description: 'Instrument transformer that scales line current for metering/protection.', category: 'oneline_symbol', standardRef: 'IEEE 315' },
  { code: 'PT', term: 'Potential (voltage) transformer', description: 'Instrument transformer that scales line voltage for metering/protection.', category: 'oneline_symbol', standardRef: 'IEEE 315', aliases: ['VT'] },
  { code: 'MOV', term: 'Metal-oxide varistor / surge arrester', description: 'Surge-protective device clamping transient overvoltages.', category: 'oneline_symbol', standardRef: 'IEEE 315', aliases: ['SPD', 'TVSS'] },
  { code: 'GND', term: 'Ground', description: 'Equipment/system grounding connection.', category: 'oneline_symbol', standardRef: 'IEEE 315', aliases: ['GRD', 'EGC'] },
  { code: 'NO', term: 'Normally open', description: 'A contact/tie that is open in the normal operating configuration.', category: 'oneline_symbol', standardRef: 'IEEE 315' },
  { code: 'NC', term: 'Normally closed', description: 'A contact/tie that is closed in the normal operating configuration.', category: 'oneline_symbol', standardRef: 'IEEE 315' },
];

// ── NETA/NECA acceptance-test markings & abbreviations ────────────────────────
const TEST_MARKINGS: GlossaryEntry[] = [
  { code: 'IR', term: 'Insulation resistance', description: 'Megohm insulation-resistance test (a.k.a. "Megger"); higher is better.', category: 'test_marking', standardRef: 'NETA ATS', aliases: ['MEGGER', 'MΩ'] },
  { code: 'PI', term: 'Polarization index', description: 'Ratio of 10-minute to 1-minute IR; IEEE 43 acceptance PI ≥ 2.0 (varies by class).', category: 'test_marking', standardRef: 'IEEE 43' },
  { code: 'DAR', term: 'Dielectric absorption ratio', description: 'Ratio of 60-second to 30-second IR; a shorter-duration insulation indicator.', category: 'test_marking', standardRef: 'IEEE 43' },
  { code: 'PF', term: 'Power factor (insulation)', description: 'Insulation power-factor / tan-δ test; rising values indicate insulation degradation.', category: 'test_marking', standardRef: 'NETA ATS', aliases: ['DF', 'TAN DELTA', 'DISSIPATION FACTOR'] },
  { code: 'TTR', term: 'Transformer turns ratio', description: 'Measures the winding turns ratio vs nameplate to find shorted/open turns.', category: 'test_marking', standardRef: 'NETA ATS' },
  { code: 'DLRO', term: 'Contact / winding resistance (micro-ohm)', description: 'Low-resistance ohmmeter test of contacts, connections, and windings.', category: 'test_marking', standardRef: 'NETA ATS', aliases: ['MICRO-OHM', 'CRM'] },
  { code: 'HIPOT', term: 'High-potential (dielectric withstand) test', description: 'Applies elevated AC/DC voltage to verify insulation withstand (pass/fail).', category: 'test_marking', standardRef: 'NETA ATS', aliases: ['HI-POT', 'DIELECTRIC WITHSTAND'] },
  { code: 'VLF', term: 'Very-low-frequency withstand test', description: '0.1 Hz withstand test for cable insulation (kinder to insulation than DC hipot).', category: 'test_marking', standardRef: 'NETA ATS' },
  { code: 'SFRA', term: 'Sweep frequency response analysis', description: 'Detects transformer winding/core mechanical deformation by frequency response.', category: 'test_marking', standardRef: 'NETA ATS' },
  { code: 'DGA', term: 'Dissolved gas analysis', description: 'Analyzes gases dissolved in transformer oil to diagnose incipient faults (IEEE C57.104).', category: 'test_marking', standardRef: 'IEEE C57.104' },
  { code: 'PD', term: 'Partial discharge', description: 'Detects/measures partial-discharge activity in insulation systems.', category: 'test_marking', standardRef: 'NETA ATS' },
];

// ── Reference standards / bodies ──────────────────────────────────────────────
const TEST_STANDARDS: GlossaryEntry[] = [
  { code: 'NETA', term: 'InterNational Electrical Testing Association', description: 'Publishes the ATS/MTS acceptance & maintenance testing specifications used for field testing.', category: 'test_standard', standardRef: 'NETA' },
  { code: 'ATS', term: 'NETA Acceptance Testing Specifications', description: 'Field acceptance tests for newly installed power equipment.', category: 'test_standard', standardRef: 'NETA ATS' },
  { code: 'MTS', term: 'NETA Maintenance Testing Specifications', description: 'Periodic maintenance tests for in-service power equipment.', category: 'test_standard', standardRef: 'NETA MTS' },
  { code: 'NECA', term: 'National Electrical Contractors Association', description: 'Publishes the NECA/NEIS installation standards ("standard practice") for electrical work.', category: 'test_standard', standardRef: 'NECA/NEIS' },
  { code: 'NFPA 70B', term: 'Standard for Electrical Equipment Maintenance', description: 'Requirements for an electrical maintenance program (now a mandatory-language standard).', category: 'test_standard', standardRef: 'NFPA 70B' },
  { code: 'IEEE 1584', term: 'Guide for Arc-Flash Hazard Calculations', description: 'Method for computing incident energy and arc-flash boundary.', category: 'test_standard', standardRef: 'IEEE 1584' },
];

const ALL_ENTRIES: GlossaryEntry[] = [
  ...DEVICE_NUMBERS,
  ...DEVICE_SUFFIXES,
  ...ONELINE_SYMBOLS,
  ...TEST_MARKINGS,
  ...TEST_STANDARDS,
];

// Index by normalized code + aliases. Suffix letters are indexed separately so a
// bare "G" doesn't collide with symbol lookups (a token is only treated as a
// suffix when it trails a device number).
const norm = (s: any) => String(s == null ? '' : s).trim().toUpperCase();

const BY_CODE = new Map<string, GlossaryEntry>();
const SUFFIX_BY_CODE = new Map<string, GlossaryEntry>();
for (const e of ALL_ENTRIES) {
  if (e.category === 'device_suffix') { SUFFIX_BY_CODE.set(norm(e.code), e); continue; }
  BY_CODE.set(norm(e.code), e);
  for (const a of e.aliases || []) BY_CODE.set(norm(a), e);
}

const DEVICE_NUMBER_SET = new Set(DEVICE_NUMBERS.map((e) => e.code));

/**
 * Resolve a single designation token to its glossary entries. Handles:
 *   - exact codes/aliases ("52", "SWGR", "IR", "MEGGER")
 *   - slash combos ("50/51", "27/59", "87/86") -> each part resolved
 *   - device-number + suffix ("87T", "51G", "50N") -> number entry + suffix note
 * Returns [] when nothing matches. Never throws.
 */
function lookupDesignation(raw: any): GlossaryEntry[] {
  const token = norm(raw);
  if (!token) return [];

  // Slash-combo: resolve each part, dedupe by code, preserve order.
  if (token.includes('/')) {
    const out: GlossaryEntry[] = [];
    const seen = new Set<string>();
    for (const part of token.split('/')) {
      for (const e of lookupDesignation(part)) {
        if (!seen.has(e.code)) { seen.add(e.code); out.push(e); }
      }
    }
    return out;
  }

  // Exact code or alias.
  const exact = BY_CODE.get(token);
  if (exact) return [exact];

  // Device-number + trailing suffix letters, e.g. 87T, 51G, 50GS, 87BT.
  const m = token.match(/^(\d{1,3})([A-Z]{1,3})$/);
  if (m && DEVICE_NUMBER_SET.has(m[1])) {
    const numEntry = BY_CODE.get(m[1]);
    if (numEntry) {
      const out: GlossaryEntry[] = [numEntry];
      // Greedily consume known suffix letters (e.g. "GS", then "T").
      let rest = m[2];
      while (rest.length) {
        const two = SUFFIX_BY_CODE.get(rest.slice(0, 2));
        const one = SUFFIX_BY_CODE.get(rest.slice(0, 1));
        if (two) { out.push(two); rest = rest.slice(2); }
        else if (one) { out.push(one); rest = rest.slice(1); }
        else break;
      }
      return out;
    }
  }
  return [];
}

/** Compact human explanation of a designation, or null if unknown. */
function explainDesignation(raw: any): string | null {
  const entries = lookupDesignation(raw);
  if (!entries.length) return null;
  return entries.map((e) => `${e.term}`).join(' + ');
}

// Token shapes worth scanning free text for: device numbers (+suffix/combo),
// and all-caps abbreviations of 2-5 letters (SWGR, ATS, HIPOT, …).
const TOKEN_RE = /\b(\d{1,3}[A-Za-z]{0,3}(?:\/\d{1,3}[A-Za-z]{0,3})?|[A-Za-z]{2,5})\b/g;

/**
 * Scan free text (a warnings line, an extracted device string, a report caption)
 * and return the glossary hits, in first-seen order. Only tokens that actually
 * resolve are returned, so it stays quiet on ordinary prose.
 */
function annotateText(text: any): Array<{ token: string; entries: GlossaryEntry[] }> {
  const s = String(text == null ? '' : text);
  const out: Array<{ token: string; entries: GlossaryEntry[] }> = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(s)) !== null) {
    const token = m[1];
    // A bare number trailing a hyphen is an equipment-tag suffix ("SWGR-1",
    // "ATS-2", "52-1"), not a standalone C37.2 device reference — don't annotate
    // it. (Direct lookupDesignation('1') still resolves; this only quiets scans.)
    if (/^\d+$/.test(token) && m.index > 0 && s[m.index - 1] === '-') continue;
    const key = norm(token);
    if (seen.has(key)) continue;
    const entries = lookupDesignation(token);
    if (entries.length) { seen.add(key); out.push({ token, entries }); }
  }
  return out;
}

function allEntries(): GlossaryEntry[] {
  return ALL_ENTRIES.slice();
}

module.exports = {
  lookupDesignation,
  explainDesignation,
  annotateText,
  allEntries,
  CATEGORIES: ['device_number', 'device_suffix', 'oneline_symbol', 'test_marking', 'test_standard'] as GlossaryCategory[],
};

export {};
