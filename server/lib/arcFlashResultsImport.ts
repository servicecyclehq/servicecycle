/**
 * lib/arcFlashResultsImport.ts — Slice 3.5b: round-trip the stamped study results
 * back in. The PE runs the study (in SKM/ETAP/EasyPower) from the model SC handed
 * over (3.5a), then exports the per-bus OUTPUTS — incident energy, arc-flash
 * boundary, PPE category, required arc rating, working distance — as CSV. This
 * parses that CSV and matches it to the bound buses so SC stays the live data
 * layer the PE ecosystem syncs to (rather than a dead-end one-way export).
 *
 * Pure + deterministic: tolerant header matching, an RFC-4180-ish CSV reader, and
 * a (site, bus) matcher with a bus-only fallback. The route owns persistence.
 */

'use strict';

// Minimal RFC-4180 CSV reader: handles quoted fields with commas, escaped quotes
// ("" -> "), and CRLF/LF line breaks. Returns a matrix of string cells.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cell); cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      // Skip fully-empty trailing rows.
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}

function normHeader(h: string): string { return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Header aliases -> canonical field. First match wins.
const HEADER_ALIASES: Record<string, string[]> = {
  site: ['site', 'sitename', 'facility', 'location', 'plant'],
  busName: ['bus', 'busname', 'busid', 'equipment', 'equipmentid', 'equipmentname', 'name', 'tag'],
  incidentEnergyCalCm2: ['incidentenergy', 'incidentenergycalcm2', 'ie', 'energy', 'calcm2', 'incidentenergycalcm', 'iecalcm2'],
  arcFlashBoundaryIn: ['arcflashboundary', 'afb', 'boundary', 'arcflashboundaryin', 'afbin'],
  ppeCategory: ['ppecategory', 'ppe', 'ppecat', 'category', 'arcflashppecategory'],
  requiredArcRatingCalCm2: ['requiredarcrating', 'arcrating', 'atpv', 'minarcrating', 'requiredarcratingcalcm2'],
  workingDistanceIn: ['workingdistance', 'workingdistancein', 'wd', 'workingdist'],
};

function buildHeaderMap(headerRow: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  headerRow.forEach((h, i) => {
    const n = normHeader(h);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[field] === undefined && aliases.includes(n)) { map[field] = i; break; }
    }
  });
  return map;
}

function num(v: any): number | null {
  if (v == null || v === '') return null;
  const m = String(v).replace(/[, ]/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}
function intOrNull(v: any): number | null { const n = num(v); return n == null ? null : Math.round(n); }

export interface ParsedResultRow { site: string | null; busName: string; incidentEnergyCalCm2: number | null; arcFlashBoundaryIn: number | null; ppeCategory: number | null; requiredArcRatingCalCm2: number | null; workingDistanceIn: number | null; }

/**
 * Parse a results CSV into structured rows. Returns the rows + which result
 * columns were recognized + any errors. Pure.
 */
export function parseResultsCsv(text: string): { rows: ParsedResultRow[]; recognized: string[]; errors: string[] } {
  const matrix = parseCsv(text);
  const errors: string[] = [];
  if (!matrix.length) return { rows: [], recognized: [], errors: ['Empty file.'] };
  const headerMap = buildHeaderMap(matrix[0]);
  if (headerMap.busName === undefined) return { rows: [], recognized: [], errors: ['No "Bus" column found — include a Bus / Equipment column.'] };

  const resultFields = ['incidentEnergyCalCm2', 'arcFlashBoundaryIn', 'ppeCategory', 'requiredArcRatingCalCm2', 'workingDistanceIn'];
  const recognized = resultFields.filter((f) => headerMap[f] !== undefined);
  if (!recognized.length) errors.push('No result columns recognized (incident energy, arc-flash boundary, PPE category, arc rating, working distance).');

  const at = (cells: string[], field: string) => (headerMap[field] === undefined ? null : cells[headerMap[field]]);
  const rows: ParsedResultRow[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const cells = matrix[i];
    const busRaw = at(cells, 'busName');
    const busName = busRaw == null ? '' : String(busRaw).trim();
    if (!busName) continue;
    rows.push({
      site: headerMap.site !== undefined ? String(cells[headerMap.site] || '').trim() || null : null,
      busName,
      incidentEnergyCalCm2: num(at(cells, 'incidentEnergyCalCm2')),
      arcFlashBoundaryIn: num(at(cells, 'arcFlashBoundaryIn')),
      ppeCategory: intOrNull(at(cells, 'ppeCategory')),
      requiredArcRatingCalCm2: num(at(cells, 'requiredArcRatingCalCm2')),
      workingDistanceIn: num(at(cells, 'workingDistanceIn')),
    });
  }
  return { rows, recognized, errors };
}

function key(site: any, bus: any): string { return `${String(site || '').trim().toLowerCase()}||${String(bus || '').trim().toLowerCase()}`; }

const RESULT_FIELDS = ['incidentEnergyCalCm2', 'arcFlashBoundaryIn', 'ppeCategory', 'requiredArcRatingCalCm2', 'workingDistanceIn'] as const;

/**
 * Match parsed rows to bound buses. `buses` = [{ id, busName, site, ...current }].
 * Matches on (site, bus); falls back to a unique bus-name match when the CSV has
 * no site or the site doesn't line up. Returns the per-bus changes + unmatched.
 */
export function matchResults(parsed: ParsedResultRow[], buses: any[]): { updates: any[]; unmatched: ParsedResultRow[]; matchedBusIds: string[] } {
  const bySiteBus = new Map<string, any>();
  const byBus = new Map<string, any[]>();
  for (const b of buses || []) {
    bySiteBus.set(key(b.site, b.busName), b);
    const k = String(b.busName || '').trim().toLowerCase();
    const arr = byBus.get(k) || []; arr.push(b); byBus.set(k, arr);
  }

  const updates: any[] = [];
  const unmatched: ParsedResultRow[] = [];
  const matchedBusIds: string[] = [];
  for (const row of parsed) {
    let bus = row.site ? bySiteBus.get(key(row.site, row.busName)) : null;
    if (!bus) {
      const cand = byBus.get(String(row.busName).trim().toLowerCase()) || [];
      if (cand.length === 1) bus = cand[0];
    }
    if (!bus) { unmatched.push(row); continue; }

    const changes: Record<string, { from: any; to: any }> = {};
    for (const f of RESULT_FIELDS) {
      const to = (row as any)[f];
      if (to == null) continue;
      const from = bus[f] ?? null;
      if (Number(from) !== Number(to)) changes[f] = { from, to };
    }
    if (Object.keys(changes).length) { updates.push({ busId: bus.id, busName: bus.busName, site: bus.site, changes }); matchedBusIds.push(bus.id); }
  }
  return { updates, unmatched, matchedBusIds };
}

export { RESULT_FIELDS };
