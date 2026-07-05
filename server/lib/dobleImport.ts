'use strict';

/**
 * lib/dobleImport.ts -- pure parse + normalize for Doble (TestGuide / ProTest /
 * TDMS) transformer test-data exports. The neutral-reader half of the
 * "read BOTH ecosystems" positioning: PowerDB (Megger) already lands via
 * scripts/seed-powerdb-demo.js + routes/testReportImport.ts; this module gives
 * ServiceCycle a Doble on-ramp that normalizes into the SAME internal shape so
 * the downstream pool (drift analysis, measurement views, Installed-Base
 * queries) sees one unified body of readings regardless of vendor of origin.
 *
 * Strategic note (2026): Doble and Megger (PowerDB's owner) merged under ESCO
 * Technologies (announced 2026-04-15, ~$2.35B, USG group). Reading both
 * ecosystems neutrally is now a first-class feature, not a nicety.
 *
 * ============================================================================
 * ASSUMED SCHEMA v1  (Doble export contract -- DELIBERATELY VERSIONED)
 * ============================================================================
 * WHY ASSUMED: Doble does NOT publish a machine-readable test-record schema in
 * the public domain. Public research (Doble product pages / datasheets,
 * 2026-07 -- sources cited at bottom) establishes the following, which shapes
 * the mappings below from "assumed" toward "probable":
 *   - TestGuide / DTA (Doble Test Assistant) drive M4100-class PF/tan-delta sets
 *     (M4100 confirmed a real Doble PF/tan-delta instrument -> fixture TestSet);
 *   - the native persisted test-data format is the PROPRIETARY *.dtax* file --
 *     NOT open XML/CSV -- so a raw .dtax is NOT a realistic drop-in on-ramp;
 *   - TDMS / Doble Database is the results store; its *reports* export to MS
 *     Office (Word/Excel), PDF or RTF; the "Doble Database API" is an
 *     authenticated web-service (apparatus-type + test-type keyed, returns
 *     FRANK(TM) scores) -- a service layer, not a file schema;
 *   - SFRA v6 *does* export raw CSV plus IEC/CIGRE formats -- i.e. the realistic
 *     Doble file on-ramp is a TABULAR CSV (BI/SFRA/report export) rather than a
 *     documented native XML. The CSV path here is therefore the higher-fidelity
 *     assumption; the XML path covers a plausible report/BI XML flattening.
 *   - Insulation-component vocabulary is INDUSTRY-STANDARD, not proprietary:
 *     CH = HV winding-to-ground, CL = LV winding-to-ground, CHL = HV-to-LV
 *     inter-winding (used verbatim in the PF fixture). "Power factor" == "tan
 *     delta" == "dissipation factor" == "the Doble test" (folded in the alias
 *     table). These are PROBABLE, not merely assumed.
 * So this importer is built around a versioned contract + a fixture-driven test
 * set. Swapping in a real customer sample later should mean updating FIELD
 * ALIASES + fixtures, NOT rearchitecting: the parser keys off aliased
 * field/element NAMES, tolerates extra columns/elements, never hard-codes
 * column order. The single artifact that would upgrade this whole module from
 * "probable" to "confirmed" is ONE real TestGuide/TDMS export (or Doble
 * Database API sample) of a completed transformer test -- see route header.
 *
 * SOURCES (2026-07): doble.com/product/doble-database (DTAX + Database API +
 * FRANK scores, apparatus/test-type retrieval), doble.com/product/sfra-software-v6
 * (CSV + IEC/CIGRE export), doble.com/product/m4100 (PF/tan-delta set),
 * doble.com/product/dta-software (DTA templates); CH/CL/CHL per standard
 * transformer PF/tan-delta references.
 *
 * Two accepted physical formats (auto-detected):
 *
 *  (A) XML  -- an <Asset> tree. Assumed shape (element or attribute names are
 *      matched case-insensitively against the alias tables below):
 *        <...>                                   (any root)
 *          <Asset>
 *            <SerialNumber>..</SerialNumber>     (or Serial / SerialNo / Tag / DeviceId)
 *            <Manufacturer/> <Model/> <EquipmentType/> <Location/>
 *            <TestSession>                       (or Test / Session / Record)
 *              <TestDate>YYYY-MM-DD</TestDate>   (or Date)
 *              <AmbientC/> <Technician/>
 *              <TestSet make model serial/>
 *              <Test type="PowerFactor" voltage="10 kV">
 *                <Reading name phase value unit expected result />
 *              </Test>
 *            </TestSession>
 *          </Asset>
 *
 *  (B) CSV / table  -- one row PER READING (long/tidy form -- what
 *      "TDMS -> export to Excel" tends to emit). Header names matched via the
 *      same alias tables. Rows sharing (serial, testDate, testType) collapse
 *      into one test record. Required columns: a serial alias, a value alias,
 *      and a test-type alias. Everything else is optional.
 *
 * NO ENGINEERING DERIVATIONS happen here. Values pass through verbatim with
 * their reported unit. We normalize IDENTITY (which asset), STRUCTURE (which
 * test, which reading) and the canonical measurementType VOCABULARY so the
 * existing trend/analysis layer recognizes the reading -- we never compute PF
 * temperature corrections, ratio deviations, DGA conditions, etc. Those remain
 * the job of the sealed downstream evaluators.
 * ============================================================================
 */

const Papa = require('papaparse');

export const DOBLE_SCHEMA_VERSION = 'assumed-v1';

// ── Canonical measurement-type vocabulary ────────────────────────────────────
// Map Doble test-type + reading-name language onto the SAME measurementType
// strings the rest of ServiceCycle already trends on (see BAD_DIRECTION in
// lib/commitTestReport.ts: power_factor / dissipation_factor / winding_resistance
// / dissolved_gas ...). Using the shared vocabulary is what makes a Doble
// import show up in year-over-year drift beside a PowerDB/PDF import.
export type CanonicalType =
  | 'power_factor'
  | 'dissipation_factor'
  | 'turns_ratio'
  | 'winding_resistance'
  | 'insulation_resistance'
  | 'excitation_current'
  | 'dissolved_gas'
  | 'contact_resistance'
  | 'trip_time'
  | 'measurement';

// Test-type token (from XML @type or CSV "Test Type") -> canonical.
const TEST_TYPE_ALIASES: Array<[RegExp, CanonicalType]> = [
  [/power[\s_-]*factor|\bpf\b/i, 'power_factor'],
  [/tan[\s_-]*delta|dissipation|\bdf\b/i, 'dissipation_factor'],
  [/turns?[\s_-]*ratio|\bttr\b/i, 'turns_ratio'],
  [/winding[\s_-]*resist|\bwrm\b|\bdc[\s_-]*resist/i, 'winding_resistance'],
  [/exciting|excitation/i, 'excitation_current'],
  [/insulation|megger|\bir\b/i, 'insulation_resistance'],
  [/\bdga\b|dissolved[\s_-]*gas|gas[\s_-]*in[\s_-]*oil/i, 'dissolved_gas'],
  // [W8] Doble also makes breaker-timing/CRM test sets (TDR-90/similar) whose
  // exports flow through this same importer. These two canonical types were
  // previously unrecognized entirely -- a report using either test type fell
  // through to the generic 'measurement' bucket with the critical safety flag
  // silently lost (see CRITICAL_TYPES below), same shape as testReportParse.ts's
  // MEASUREMENT_VOCAB critical flags for contact_resistance/trip_time.
  [/contact[\s_-]*resist|\bcrm\b|\bductor\b/i, 'contact_resistance'],
  [/trip[\s_-]*(?:time|test)|timing[\s_-]*test|operating[\s_-]*time/i, 'trip_time'],
];

// [W8] Mirrors testReportParse.ts's MEASUREMENT_VOCAB `critical: true` flags.
// A RED reading of a critical type becomes an IMMEDIATE deficiency (vs.
// RECOMMENDED); toCommitMeasurements() previously emitted no `critical` field
// at all, so every Doble-imported RED reading was silently downgraded.
const CRITICAL_TYPES: ReadonlySet<CanonicalType> = new Set(['contact_resistance', 'trip_time']);

// A handful of DGA gas tokens so a lab row named only by gas (H2, CH4 ...) is
// still recognized as a dissolved-gas reading even if the test-type column is
// blank. Not chemistry -- purely identity so the row routes to the right type.
const DGA_GAS_TOKENS = /^(h2|ch4|c2h2|c2h4|c2h6|co2?|o2|n2|tdcg)$/i;

function canonicalType(testType: string, readingName?: string): CanonicalType {
  const t = String(testType || '');
  for (const [re, canon] of TEST_TYPE_ALIASES) if (re.test(t)) return canon;
  if (readingName && DGA_GAS_TOKENS.test(String(readingName).trim())) return 'dissolved_gas';
  return 'measurement';
}

// ── Field alias tables (the "swap a real sample = edit aliases" seam) ─────────
// Lower-cased header / element / attribute name -> internal field. Extend these
// (not the parser) when a real Doble sample uses different labels.
const ASSET_FIELD_ALIASES: Record<string, string> = {
  'serialnumber': 'serialNumber', 'serial': 'serialNumber', 'serialno': 'serialNumber',
  'serial number': 'serialNumber', 'serial no': 'serialNumber', 'tag': 'serialNumber',
  'assettag': 'serialNumber', 'asset tag': 'serialNumber', 'deviceid': 'serialNumber',
  'device id': 'serialNumber', 'equipmentid': 'serialNumber', 'nameplateserial': 'serialNumber',
  'manufacturer': 'manufacturer', 'mfg': 'manufacturer', 'maker': 'manufacturer',
  'model': 'model', 'type': 'model', 'catalog': 'model',
  'equipmenttype': 'equipmentType', 'equipment type': 'equipmentType',
  'assettype': 'equipmentType', 'apparatus': 'equipmentType',
  'location': 'location', 'position': 'location', 'bay': 'location', 'substation': 'location',
};

const SESSION_FIELD_ALIASES: Record<string, string> = {
  'testdate': 'testDate', 'test date': 'testDate', 'date': 'testDate', 'datetested': 'testDate',
  'ambientc': 'ambientC', 'ambient c': 'ambientC', 'ambient': 'ambientC',
  'ambienttemp': 'ambientC', 'temperature': 'ambientC', 'tempc': 'ambientC',
  'technician': 'technician', 'tester': 'technician', 'operator': 'technician',
  'testvoltage': 'testVoltage', 'test voltage': 'testVoltage', 'voltage': 'testVoltage', 'kv': 'testVoltage',
};

const READING_FIELD_ALIASES: Record<string, string> = {
  'readingname': 'name', 'reading name': 'name', 'name': 'name', 'measurement': 'name',
  'parameter': 'name', 'quantity': 'name',
  'phase': 'phase', 'winding': 'phase', 'terminal': 'phase', 'connection': 'phase',
  'value': 'value', 'result value': 'value', 'measured': 'value', 'reading': 'value', 'asfound': 'value',
  'unit': 'unit', 'units': 'unit', 'uom': 'unit',
  'expected': 'expected', 'expectedrange': 'expected', 'expected range': 'expected',
  'limit': 'expected', 'nameplate': 'expected', 'reference': 'expected',
  'result': 'result', 'passfail': 'result', 'pass/fail': 'result', 'assessment': 'result', 'verdict': 'result',
};

// CSV-only: which header carries the TEST TYPE for a long-form row.
const TEST_TYPE_HEADER_ALIASES = new Set([
  'testtype', 'test type', 'test', 'testname', 'test name', 'testkind',
]);

function aliasLookup(table: Record<string, string>, key: string): string | null {
  const k = String(key || '').trim().toLowerCase();
  return table[k] ?? null;
}

// ── Normalized output shapes (what the route/commit layer consumes) ──────────
// A "reading" mirrors the fields TestMeasurement + commitAssetReadings expect:
// measurementType/phase/value/unit/expected/result -- passed through, no math.
export interface DobleReading {
  measurementType: CanonicalType;
  rawTestType: string;      // original Doble test-type token (provenance)
  name: string | null;      // e.g. "CHL", "Ratio", "H2"
  phase: string | null;
  value: number | null;     // numeric passthrough (null if non-numeric/blank)
  rawValue: string | null;  // exact source text of the value cell
  unit: string | null;
  expected: string | null;
  result: 'GREEN' | 'YELLOW' | 'RED' | null; // report's own verdict, mapped
  testVoltage: string | null;
}

export interface DobleTestRecord {
  testDate: string | null;  // ISO yyyy-mm-dd if parseable, else raw string
  testType: string;         // raw Doble test-type label for this record
  ambientC: number | null;
  technician: string | null;
  testSet: { make: string | null; model: string | null; serial: string | null } | null;
  readings: DobleReading[];
}

export interface DobleAssetImport {
  identity: {
    serialNumber: string | null;
    manufacturer: string | null;
    model: string | null;
    equipmentType: string | null; // Doble's own label; NOT the SC enum
    location: string | null;
  };
  tests: DobleTestRecord[];
  measurementCount: number;
  issues: string[]; // per-asset non-fatal parse issues
}

export interface DobleParseResult {
  format: 'xml' | 'csv';
  schemaVersion: string;
  assets: DobleAssetImport[];
  assetCount: number;
  testCount: number;
  measurementCount: number;
  issues: string[]; // file-level issues (never throws for recoverable problems)
}

// ── Value / result coercion (passthrough, no derivation) ─────────────────────
function toNumber(raw: any): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  // Keep it strict-ish: strip a trailing unit-ish suffix only if the lead is a
  // clean number (e.g. "0.31%"). Never reinterpret magnitude.
  const m = s.match(/^[-+]?\d*\.?\d+(e[-+]?\d+)?/i);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

// Map a report's own verdict text onto the ResultRating enum used everywhere
// (GREEN/YELLOW/RED). We do NOT invent a verdict -- only translate one the file
// already states. Unknown / blank -> null.
function mapResult(raw: any): 'GREEN' | 'YELLOW' | 'RED' | null {
  const v = String(raw || '').trim().toUpperCase();
  if (!v) return null;
  if (['PASS', 'P', 'GOOD', 'GREEN', 'OK', 'SATISFACTORY', 'ACCEPT', 'ACCEPTABLE'].includes(v)) return 'GREEN';
  if (['CAUTION', 'YELLOW', 'MARGINAL', 'INVESTIGATE', 'MONITOR', 'LIMITED', 'WARN', 'WARNING'].includes(v)) return 'YELLOW';
  if (['FAIL', 'F', 'BAD', 'RED', 'DEFECT', 'DEFECTIVE', 'REJECT', 'UNSATISFACTORY'].includes(v)) return 'RED';
  return null;
}

// Best-effort ISO date. Accepts YYYY-MM-DD, MM/DD/YYYY, DD.MM.YYYY (EU/TDMS),
// and anything Date can parse. Returns raw string if unrecognized so nothing is
// silently dropped -- the caller surfaces an issue instead of guessing.
function toIsoDate(raw: any): { iso: string | null; ok: boolean } {
  const s = String(raw || '').trim();
  if (!s) return { iso: null, ok: false };
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s.slice(0, 10) + 'T00:00:00Z');
    if (!isNaN(d.getTime())) return { iso: s.slice(0, 10), ok: true };
  }
  const mdy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (mdy) {
    const iso = `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
    if (!isNaN(new Date(iso + 'T00:00:00Z').getTime())) return { iso, ok: true };
  }
  const dmy = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/); // DD.MM.YYYY
  if (dmy) {
    const iso = `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    if (!isNaN(new Date(iso + 'T00:00:00Z').getTime())) return { iso, ok: true };
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return { iso: d.toISOString().slice(0, 10), ok: true };
  return { iso: s, ok: false };
}

// ── Format detection ─────────────────────────────────────────────────────────
// XML if it declares a prolog / looks angle-bracket-structured; otherwise CSV.
// Filename is a hint but content wins (a mislabeled .txt still parses).
export function detectFormat(input: string | Buffer, filename?: string): 'xml' | 'csv' {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const head = text.replace(/^﻿/, '').trimStart().slice(0, 4096);
  const fn = String(filename || '').toLowerCase();
  if (fn.endsWith('.xml')) return 'xml';
  if (fn.endsWith('.csv')) {
    // Content override: some tools emit XML into a .csv-named file.
    if (/^<\?xml|^<[A-Za-z]/.test(head)) return 'xml';
    return 'csv';
  }
  if (/^<\?xml/i.test(head)) return 'xml';
  // An early '<' opening an element, with no comma-delimited header, => XML.
  if (/^<[A-Za-z]/.test(head)) return 'xml';
  return 'csv';
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal XML element extractor.
//
// TRADEOFF (deliberate): the server has NO general XML parser (rss-parser is
// RSS-specific; adding a dep like fast-xml-parser was rejected to keep the
// dependency + supply-chain surface flat for acquisition diligence). The Doble
// ASSUMED SCHEMA is a shallow, regular <Asset><TestSession><Test><Reading>
// tree, so a small purpose-built extractor covers it without a library. LIMITS:
// it does NOT handle CDATA, namespaces, mixed content, or DTDs, and it is not a
// general XML parser -- it is a targeted reader for this one assumed shape.
// When a real customer sample arrives, re-evaluate whether its structure still
// fits this extractor or warrants a vetted dependency.
// ─────────────────────────────────────────────────────────────────────────────

// Strip comments/prolog so they never match as elements.
function stripXmlNoise(xml: string): string {
  return xml
    .replace(/<\?[\s\S]*?\?>/g, '')      // prolog / PIs
    .replace(/<!--[\s\S]*?-->/g, '')     // comments
    .replace(/<!DOCTYPE[\s\S]*?>/gi, ''); // doctype
}

// Decode the 5 predefined XML entities (enough for the assumed schema).
function xmlDecode(s: string): string {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Parse an element's attributes into a lower-cased-key bag (original values).
function parseAttrs(tagBody: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"|([A-Za-z_][\w.-]*)\s*=\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagBody)) !== null) {
    const key = (m[1] || m[3] || '').toLowerCase();
    const val = xmlDecode(m[2] != null ? m[2] : (m[4] || ''));
    if (key) attrs[key] = val;
  }
  return attrs;
}

// Return the immediate text (no child elements) of an element's inner content.
function directText(inner: string): string {
  // Remove nested elements, keep loose text.
  const noChildren = inner.replace(/<[^>]+>/g, ' ');
  return xmlDecode(noChildren).replace(/\s+/g, ' ').trim();
}

// Find every top-level <tag ...>...</tag> OR <tag ... /> block within `scope`
// whose local name matches `name` (case-insensitive). Returns { attrs, inner }.
// Balanced by counting same-name opens/closes so nested same-name tags don't
// terminate early. Adequate for the regular assumed tree (no same-name nesting
// in practice, but handled defensively).
function findElements(scope: string, name: string): Array<{ attrs: Record<string, string>; inner: string }> {
  const out: Array<{ attrs: Record<string, string>; inner: string }> = [];
  const open = new RegExp(`<${name}(\\s[^>]*?)?(/?)>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = open.exec(scope)) !== null) {
    const attrs = parseAttrs(m[1] || '');
    if (m[2] === '/') { out.push({ attrs, inner: '' }); continue; } // self-closing
    // Walk forward to the matching close, honoring same-name nesting.
    const closeRe = new RegExp(`<${name}(\\s[^>]*?)?(/?)>|</${name}\\s*>`, 'gi');
    closeRe.lastIndex = open.lastIndex;
    let depth = 1;
    let innerStart = open.lastIndex;
    let cm: RegExpExecArray | null;
    let innerEnd = scope.length;
    while ((cm = closeRe.exec(scope)) !== null) {
      const isClose = cm[0].startsWith('</');
      const selfClose = !isClose && cm[2] === '/';
      if (isClose) {
        depth--;
        if (depth === 0) { innerEnd = cm.index; open.lastIndex = closeRe.lastIndex; break; }
      } else if (!selfClose) {
        depth++;
      }
    }
    out.push({ attrs, inner: scope.slice(innerStart, innerEnd) });
  }
  return out;
}

// Read a scalar child element's text by trying each candidate local name.
function childText(inner: string, names: string[]): string | null {
  for (const n of names) {
    const els = findElements(inner, n);
    if (els.length) {
      const t = directText(els[0].inner);
      if (t) return t;
    }
  }
  return null;
}

// Resolve a field from an element's attributes using an alias table.
function fieldFromAttrs(attrs: Record<string, string>, table: Record<string, string>, field: string): string | null {
  for (const [k, v] of Object.entries(attrs)) {
    if (aliasLookup(table, k) === field && v != null && v !== '') return v;
  }
  return null;
}

// Resolve an asset-level scalar from either a child element OR an attribute.
function assetScalar(assetInner: string, assetAttrs: Record<string, string>, field: string): string | null {
  // child elements whose local name aliases to `field`
  const elementNames = Object.entries(ASSET_FIELD_ALIASES)
    .filter(([, f]) => f === field).map(([k]) => k.replace(/\s+/g, ''));
  // element names with spaces won't exist as tags; also try the CamelCase forms
  const tryNames = new Set<string>(elementNames);
  // common element spellings
  if (field === 'serialNumber') ['SerialNumber', 'Serial', 'SerialNo', 'DeviceId', 'Tag'].forEach((n) => tryNames.add(n));
  if (field === 'manufacturer') ['Manufacturer', 'Mfg'].forEach((n) => tryNames.add(n));
  if (field === 'model') ['Model', 'Catalog'].forEach((n) => tryNames.add(n));
  if (field === 'equipmentType') ['EquipmentType', 'AssetType', 'Apparatus'].forEach((n) => tryNames.add(n));
  if (field === 'location') ['Location', 'Position', 'Substation', 'Bay'].forEach((n) => tryNames.add(n));
  const fromChild = childText(assetInner, Array.from(tryNames));
  if (fromChild) return fromChild;
  return fieldFromAttrs(assetAttrs, ASSET_FIELD_ALIASES, field);
}

function sessionScalar(sessionInner: string, sessionAttrs: Record<string, string>, field: string): string | null {
  const tryNames = new Set<string>();
  if (field === 'testDate') ['TestDate', 'Date', 'DateTested'].forEach((n) => tryNames.add(n));
  if (field === 'ambientC') ['AmbientC', 'Ambient', 'Temperature', 'TempC'].forEach((n) => tryNames.add(n));
  if (field === 'technician') ['Technician', 'Tester', 'Operator'].forEach((n) => tryNames.add(n));
  if (field === 'testVoltage') ['TestVoltage', 'Voltage', 'kV'].forEach((n) => tryNames.add(n));
  const fromChild = childText(sessionInner, Array.from(tryNames));
  if (fromChild) return fromChild;
  return fieldFromAttrs(sessionAttrs, SESSION_FIELD_ALIASES, field);
}

function readingFromAttrs(attrs: Record<string, string>): Record<string, string> {
  const r: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const f = aliasLookup(READING_FIELD_ALIASES, k);
    if (f && r[f] == null) r[f] = v;
  }
  return r;
}

function parseXml(text: string): DobleParseResult {
  const issues: string[] = [];
  const cleaned = stripXmlNoise(text.replace(/^﻿/, ''));
  const assetEls = findElements(cleaned, 'Asset');
  const assets: DobleAssetImport[] = [];

  if (assetEls.length === 0) {
    issues.push('No <Asset> elements found. Expected the assumed-v1 Doble XML shape (see lib/dobleImport.ts header).');
  }

  for (const ae of assetEls) {
    const perIssues: string[] = [];
    const identity = {
      serialNumber: assetScalar(ae.inner, ae.attrs, 'serialNumber'),
      manufacturer: assetScalar(ae.inner, ae.attrs, 'manufacturer'),
      model: assetScalar(ae.inner, ae.attrs, 'model'),
      equipmentType: assetScalar(ae.inner, ae.attrs, 'equipmentType'),
      location: assetScalar(ae.inner, ae.attrs, 'location'),
    };
    if (!identity.serialNumber) perIssues.push('Asset has no serial/tag -- identity match will fall back to site/type only.');

    // TestSession | Session | Test-as-session | Record
    let sessionEls = findElements(ae.inner, 'TestSession');
    if (sessionEls.length === 0) sessionEls = findElements(ae.inner, 'Session');
    if (sessionEls.length === 0) sessionEls = findElements(ae.inner, 'Record');
    if (sessionEls.length === 0) {
      // No wrapping session: treat the asset body itself as one session.
      sessionEls = [{ attrs: {}, inner: ae.inner }];
    }

    const tests: DobleTestRecord[] = [];
    let measurementCount = 0;

    for (const se of sessionEls) {
      const dateRaw = sessionScalar(se.inner, se.attrs, 'testDate');
      const iso = toIsoDate(dateRaw);
      if (dateRaw && !iso.ok) perIssues.push(`Unrecognized test date "${dateRaw}" -- kept verbatim.`);
      const ambientC = toNumber(sessionScalar(se.inner, se.attrs, 'ambientC'));
      const technician = sessionScalar(se.inner, se.attrs, 'technician');
      const sessionVoltage = sessionScalar(se.inner, se.attrs, 'testVoltage');

      // TestSet provenance (instrument used) if present.
      let testSet: DobleTestRecord['testSet'] = null;
      const tsEls = findElements(se.inner, 'TestSet');
      if (tsEls.length) {
        const a = tsEls[0].attrs;
        testSet = { make: a['make'] || null, model: a['model'] || null, serial: a['serial'] || null };
      }

      const testEls = findElements(se.inner, 'Test');
      const effectiveTests = testEls.length ? testEls : [{ attrs: {}, inner: se.inner }];

      for (const te of effectiveTests) {
        const rawTestType = te.attrs['type'] || te.attrs['testtype'] || te.attrs['name'] || '';
        const testVoltage = te.attrs['voltage'] || te.attrs['testvoltage'] || sessionVoltage || null;
        // [W8] canonicalType() silently returns the generic 'measurement'
        // fallback for any test-type token it doesn't recognize -- readings
        // then lose type-specific PASS/FAIL floors, trend tracking, and (for
        // contact-resistance/trip-time) the critical-severity flag, with no
        // trace that anything was unrecognized. Check once per <Test> block
        // (test-type alone, matching the Doble-vendor vocabulary this
        // importer knows) so an unmapped test type surfaces as a review flag
        // instead of a silent generic bucket.
        if (rawTestType && canonicalType(rawTestType) === 'measurement') {
          perIssues.push(`Unrecognized test type "${rawTestType}" -- readings filed as generic "measurement" (no type-specific PASS/FAIL floor, trend tracking, or critical-severity flag) unless individually recognized by gas name.`);
        }
        const readingEls = findElements(te.inner, 'Reading');
        if (readingEls.length === 0) {
          // A <Test> with no <Reading> children carries nothing usable.
          if (rawTestType) perIssues.push(`Test "${rawTestType}" had no <Reading> rows.`);
          continue;
        }
        const readings: DobleReading[] = [];
        for (const re of readingEls) {
          const rf = readingFromAttrs(re.attrs);
          // Allow child-element readings too (<Value>..</Value> etc.).
          const name = rf['name'] || childText(re.inner, ['Name', 'Parameter']) || null;
          const valueRaw = rf['value'] != null ? rf['value'] : (childText(re.inner, ['Value', 'Reading', 'Measured']) || null);
          const canon = canonicalType(rawTestType, name);
          readings.push({
            measurementType: canon,
            rawTestType: String(rawTestType || '').trim(),
            name: name ? String(name).trim() : null,
            phase: (rf['phase'] || null) as any,
            value: toNumber(valueRaw),
            rawValue: valueRaw != null ? String(valueRaw).trim() : null,
            unit: rf['unit'] || null,
            expected: rf['expected'] || null,
            result: mapResult(rf['result']),
            testVoltage,
          });
        }
        measurementCount += readings.length;
        tests.push({
          testDate: iso.iso, testType: String(rawTestType || 'measurement').trim(),
          ambientC, technician: technician || null, testSet, readings,
        });
      }
    }

    if (tests.length === 0) perIssues.push('Asset had no readable tests.');
    assets.push({ identity, tests, measurementCount, issues: perIssues });
  }

  const testCount = assets.reduce((n, a) => n + a.tests.length, 0);
  const measurementCount = assets.reduce((n, a) => n + a.measurementCount, 0);
  return {
    format: 'xml', schemaVersion: DOBLE_SCHEMA_VERSION,
    assets, assetCount: assets.length, testCount, measurementCount, issues,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV (long / tidy form) -- one row per reading.
// ─────────────────────────────────────────────────────────────────────────────
function buildCsvHeaderMap(headers: string[]): {
  asset: Record<string, string>;   // header -> asset field
  session: Record<string, string>; // header -> session field
  reading: Record<string, string>; // header -> reading field
  testTypeHeader: string | null;
} {
  const asset: Record<string, string> = {};
  const session: Record<string, string> = {};
  const reading: Record<string, string> = {};
  let testTypeHeader: string | null = null;
  for (const h of headers) {
    const key = String(h || '').trim().toLowerCase();
    if (TEST_TYPE_HEADER_ALIASES.has(key)) { testTypeHeader = h; continue; }
    const af = aliasLookup(ASSET_FIELD_ALIASES, key);
    // reading.name and asset.model both alias from bare "type"/"name"; disambiguate:
    // prefer the READING mapping only for reading-specific tokens.
    const rf = aliasLookup(READING_FIELD_ALIASES, key);
    const sf = aliasLookup(SESSION_FIELD_ALIASES, key);
    // A header can only own one field; priority reading > session > asset for
    // the per-reading columns, but keep serial/mfg/model/location as asset.
    if (rf && !(af && ['serialNumber', 'manufacturer', 'location'].includes(af))) { reading[h] = rf; continue; }
    if (sf) { session[h] = sf; continue; }
    if (af) { asset[h] = af; continue; }
  }
  return { asset, session, reading, testTypeHeader };
}

function parseCsv(text: string): DobleParseResult {
  const issues: string[] = [];
  const parsed = Papa.parse(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: true });
  const headers: string[] = parsed.meta?.fields || [];
  const rows: any[] = parsed.data || [];
  if (!headers.length) {
    return { format: 'csv', schemaVersion: DOBLE_SCHEMA_VERSION, assets: [], assetCount: 0, testCount: 0, measurementCount: 0, issues: ['No header row found in CSV.'] };
  }

  const hmap = buildCsvHeaderMap(headers);
  if (!Object.values(hmap.reading).includes('value')) issues.push('No "value" column detected -- rows will have null values.');
  const serialHeader = Object.entries(hmap.asset).find(([, f]) => f === 'serialNumber')?.[0] || null;
  if (!serialHeader) issues.push('No serial/tag column detected -- assets fall back to site/type identity only.');
  if (!hmap.testTypeHeader) issues.push('No "Test Type" column detected -- reading names alone will drive type inference.');

  // Group rows by asset (serial), then by (testType, testDate).
  const assetOrder: string[] = [];
  const assetMap = new Map<string, {
    identity: DobleAssetImport['identity'];
    tests: Map<string, DobleTestRecord>;
    testOrder: string[];
    issues: Set<string>;
  }>();

  rows.forEach((row, idx) => {
    // Asset identity for this row.
    const identity: DobleAssetImport['identity'] = { serialNumber: null, manufacturer: null, model: null, equipmentType: null, location: null };
    for (const [h, f] of Object.entries(hmap.asset)) {
      const v = row[h]; if (v != null && String(v).trim() !== '') (identity as any)[f] = String(v).trim();
    }
    const assetKey = (identity.serialNumber || identity.location || `__row_${idx}`).toLowerCase();
    if (!assetMap.has(assetKey)) {
      assetMap.set(assetKey, { identity, tests: new Map(), testOrder: [], issues: new Set() });
      assetOrder.push(assetKey);
    }
    const bucket = assetMap.get(assetKey)!;
    // Enrich identity if later rows fill blanks.
    for (const k of ['serialNumber', 'manufacturer', 'model', 'equipmentType', 'location'] as const) {
      if (!bucket.identity[k] && identity[k]) bucket.identity[k] = identity[k];
    }

    // Session/reading fields.
    const sess: any = {};
    for (const [h, f] of Object.entries(hmap.session)) {
      const v = row[h]; if (v != null && String(v).trim() !== '') sess[f] = String(v).trim();
    }
    const rd: any = {};
    for (const [h, f] of Object.entries(hmap.reading)) {
      const v = row[h]; if (v != null && String(v).trim() !== '') rd[f] = String(v).trim();
    }
    const rawTestType = hmap.testTypeHeader ? String(row[hmap.testTypeHeader] || '').trim() : '';
    const iso = toIsoDate(sess.testDate);
    if (sess.testDate && !iso.ok) bucket.issues.add(`Unrecognized test date "${sess.testDate}" -- kept verbatim.`);

    const canon = canonicalType(rawTestType, rd.name);
    // [W8] Same unmapped-type flag as the XML path above. `bucket.issues` is a
    // Set so an identical message across many rows of the same unrecognized
    // test type collapses to one entry (no spam).
    if (rawTestType && canonicalType(rawTestType) === 'measurement') {
      bucket.issues.add(`Unrecognized test type "${rawTestType}" -- readings filed as generic "measurement" (no type-specific PASS/FAIL floor, trend tracking, or critical-severity flag) unless individually recognized by gas name.`);
    }
    const testKey = `${(rawTestType || canon).toLowerCase()}|${iso.iso || sess.testDate || ''}`;
    if (!bucket.tests.has(testKey)) {
      bucket.tests.set(testKey, {
        testDate: iso.iso, testType: rawTestType || canon,
        ambientC: toNumber(sess.ambientC), technician: sess.technician || null,
        testSet: null, readings: [],
      });
      bucket.testOrder.push(testKey);
    }
    const trec = bucket.tests.get(testKey)!;
    // Fill session-level fields if the first row for the test lacked them.
    if (trec.ambientC == null && sess.ambientC != null) trec.ambientC = toNumber(sess.ambientC);
    if (!trec.technician && sess.technician) trec.technician = sess.technician;

    trec.readings.push({
      measurementType: canon,
      rawTestType: rawTestType,
      name: rd.name || null,
      phase: rd.phase || null,
      value: toNumber(rd.value),
      rawValue: rd.value != null ? String(rd.value) : null,
      unit: rd.unit || null,
      expected: rd.expected || null,
      result: mapResult(rd.result),
      testVoltage: sess.testVoltage || null,
    });
  });

  const assets: DobleAssetImport[] = assetOrder.map((k) => {
    const b = assetMap.get(k)!;
    const tests = b.testOrder.map((tk) => b.tests.get(tk)!);
    const measurementCount = tests.reduce((n, t) => n + t.readings.length, 0);
    const perIssues = Array.from(b.issues);
    if (!b.identity.serialNumber) perIssues.push('Asset has no serial/tag -- identity match will fall back to site/type only.');
    return { identity: b.identity, tests, measurementCount, issues: perIssues };
  });

  const testCount = assets.reduce((n, a) => n + a.tests.length, 0);
  const measurementCount = assets.reduce((n, a) => n + a.measurementCount, 0);
  return { format: 'csv', schemaVersion: DOBLE_SCHEMA_VERSION, assets, assetCount: assets.length, testCount, measurementCount, issues };
}

// ── Public entry ─────────────────────────────────────────────────────────────
/**
 * Parse a Doble export (XML or CSV) into the normalized import shape. Pure:
 * never touches the DB, never derives engineering values. Detects the format,
 * dispatches, and returns assets/tests/readings + issues. Only throws for a
 * truly unreadable input; recoverable problems become `issues` entries.
 */
export function parseDobleExport(input: string | Buffer, filename?: string): DobleParseResult {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const format = detectFormat(text, filename);
  const result = format === 'xml' ? parseXml(text) : parseCsv(text);
  return result;
}

// Flatten one normalized asset's tests into the measurement[] array shape that
// lib/commitTestReport.commitAssetReadings expects. Passthrough only: the
// measurementType is the canonical string, phase/value/unit/expected/result map
// 1:1. `label` gives a friendly per-reading name for auto-deficiency text.
export function toCommitMeasurements(asset: DobleAssetImport): Array<{
  measurementType: string; phase: string | null; asFoundValue: number | null;
  asFoundUnit: string | null; passFail: 'GREEN' | 'YELLOW' | 'RED' | null;
  expectedRange: string | null; testVoltage: string | null; label: string;
  notes: string | null; critical: boolean;
}> {
  const out: any[] = [];
  for (const t of asset.tests) {
    for (const r of t.readings) {
      out.push({
        measurementType: r.measurementType,
        phase: r.phase,
        asFoundValue: r.value,
        asFoundUnit: r.unit,
        passFail: r.result,
        expectedRange: r.expected,
        testVoltage: r.testVoltage,
        label: [r.rawTestType || t.testType, r.name].filter(Boolean).join(' '),
        notes: `[doble:${DOBLE_SCHEMA_VERSION}] ${t.testType}${r.name ? ` / ${r.name}` : ''}${r.rawValue != null ? ` = ${r.rawValue}${r.unit || ''}` : ''}`,
        // [W8] See CRITICAL_TYPES -- without this, commitAssetReadings'
        // severityFor() always treated a Doble RED as RECOMMENDED, never
        // IMMEDIATE, even for a failed timing/contact-resistance test.
        critical: CRITICAL_TYPES.has(r.measurementType as CanonicalType),
      });
    }
  }
  return out;
}

// Earliest parseable test date across an asset's tests (used as the WorkOrder
// completedDate anchor when committing). Null if none parse.
export function assetTestDate(asset: DobleAssetImport): string | null {
  const dates = asset.tests.map((t) => t.testDate).filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}/.test(d));
  if (!dates.length) return null;
  return dates.sort()[0];
}

module.exports = {
  DOBLE_SCHEMA_VERSION,
  detectFormat,
  parseDobleExport,
  toCommitMeasurements,
  assetTestDate,
};

export {};
