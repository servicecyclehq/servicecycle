/**
 * lib/schematicTopology.ts -- deterministic vector-GEOMETRY topology for true
 * "schematic" one-line / single-line (SLD) PDFs (drawn bus bars + drop conductors),
 * the sibling of lib/vectorTopology.ts (which handles the indent "card tree" style).
 *
 * Runs scripts/schematic_oneline.py (pdfplumber, NO AI): auto-finds the one-line sheet
 * among many, orients it upright, follows the drawn horizontal bus bars + vertical drops,
 * and reconstructs the feed tree + lateral ties from the actual vector coordinates.
 * FAILS OPEN: any failure, a too-dense sheet, a non-schematic PDF, or no confident
 * one-line yields isSchematic:false so the AI extraction path is left completely
 * untouched. This SUPPLEMENTS the already-live AI topology extraction; it never replaces it.
 *
 * reconcileSchematicTopology() overlays the deterministic connectivity onto the AI-extracted
 * buses (matched by normalized bus name), GATED on the follower's own nameConfidence: on a
 * schematic one-line the *geometry* is ground truth for "who feeds whom", but the *names* are
 * read from a noisy text layer, so we only auto-override connectivity when the names are
 * reliable enough to match. Regardless of confidence, a non-destructive geometry `advisory`
 * (bus/feed/tie counts + notes like ring-bus / multi-section / low-confidence) is always
 * returned so the review UI can show the human what the drawing geometry actually says.
 *
 * DELIBERATE differences from vectorTopology's reconcile (the card-tree types come from precise
 * header tokens; the schematic types are coarse voltage-based guesses):
 *   - fedFromBusName : OVERRIDE when different (geometry wins) -- but only when confident.
 *   - equipmentTypeGuess : FILL ONLY when the AI has none (never clobber the AI's finer type).
 *   - nominalVoltage : FILL ONLY when the AI missed it.
 */

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PY = process.env.PYEXTRACT_PYTHON || 'python3';
const SCRIPT = path.join(__dirname, '..', 'scripts', 'schematic_oneline.py');
// page-finding + orient can scan many sheets; give it more head-room than the card-tree reader,
// still bounded so ingest never hangs (execFile hard-kills at the timeout).
const TIMEOUT_MS = parseInt(process.env.PYEXTRACT_SCHEMATIC_TIMEOUT_MS || process.env.PYEXTRACT_TIMEOUT_MS || '60000', 10);
// only auto-override AI connectivity when the follower's names are reliable enough to match by name.
const MIN_NAME_CONF = parseFloat(process.env.SCHEMATIC_MIN_NAME_CONF || '0.5');

export interface SchematicBus {
  busName: string;
  equipmentTypeGuess: string | null;
  fedFromBusName: string | null;
  nominalVoltage: string | null;
  level: number;
}
export interface SchematicTopology {
  ok: boolean;
  isSchematic: boolean;
  buses: SchematicBus[];
  nameConfidence: number;
  notes: string[];
  feedCount: number;
  tieCount: number;
  page: number | null;
}

const EMPTY: SchematicTopology = { ok: false, isSchematic: false, buses: [], nameConfidence: 0, notes: [], feedCount: 0, tieCount: 0, page: null };

// Run the Python geometry follower on the PDF bytes. Never throws.
async function extractSchematicTopology(buffer: Buffer): Promise<SchematicTopology> {
  return new Promise((resolve) => {
    let tmp: string | null = null;
    try {
      tmp = path.join(os.tmpdir(), `afsch-${crypto.randomBytes(8).toString('hex')}.pdf`);
      fs.writeFileSync(tmp, buffer);
    } catch {
      return resolve(EMPTY);
    }
    execFile(PY, [SCRIPT, tmp], { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err: any, stdout: any) => {
      try { if (tmp) fs.unlinkSync(tmp); } catch { /* tmp reaped anyway */ }
      if (err || !stdout) return resolve(EMPTY);
      try {
        const out = JSON.parse(String(stdout).trim().split('\n').pop());
        if (out && out.ok && out.isSchematic && Array.isArray(out.buses)) {
          return resolve({
            ok: true,
            isSchematic: true,
            buses: out.buses,
            nameConfidence: typeof out.nameConfidence === 'number' ? out.nameConfidence : 0,
            notes: Array.isArray(out.notes) ? out.notes : [],
            feedCount: Array.isArray(out.feeds) ? out.feeds.length : 0,
            tieCount: Array.isArray(out.ties) ? out.ties.length : 0,
            page: typeof out.page === 'number' ? out.page : null,
          });
        }
      } catch { /* fall through */ }
      resolve(EMPTY);
    });
  });
}

const norm = (s: any) => String(s == null ? '' : s).trim().toLowerCase();

export interface SchematicOverride { busName: string; field: 'fedFromBusName' | 'equipmentTypeGuess'; ai: string | null; vector: string | null; }
export interface SchematicAdvisory { busCount: number; feedCount: number; tieCount: number; nameConfidence: number; notes: string[]; page: number | null; }

/**
 * Overlay deterministic connectivity onto AI buses (match by normalized name), gated on the
 * follower's nameConfidence. Returns { buses, disagreements, applied, advisory }.
 *   - applied=false (buses returned unchanged) when the PDF is not a schematic OR the
 *     follower's names are too unreliable to match (nameConfidence < MIN_NAME_CONF).
 *   - advisory is ALWAYS populated when a schematic was read (even if not applied), so the
 *     caller can surface the geometry read as a non-destructive review flag.
 */
function reconcileSchematicTopology(aiBuses: any[], sch: SchematicTopology): { buses: any[]; disagreements: SchematicOverride[]; applied: boolean; advisory: SchematicAdvisory | null } {
  const disagreements: SchematicOverride[] = [];
  const readSchematic = !!(sch && sch.isSchematic && Array.isArray(sch.buses) && sch.buses.length);
  const advisory: SchematicAdvisory | null = readSchematic
    ? { busCount: sch.buses.length, feedCount: sch.feedCount || 0, tieCount: sch.tieCount || 0, nameConfidence: sch.nameConfidence || 0, notes: sch.notes || [], page: sch.page ?? null }
    : null;

  // Not a schematic, or names too unreliable to match -> do not touch the AI buses.
  if (!readSchematic || (sch.nameConfidence || 0) < MIN_NAME_CONF) {
    return { buses: aiBuses, disagreements, applied: false, advisory };
  }

  const vByName = new Map<string, SchematicBus>();
  for (const v of sch.buses) vByName.set(norm(v.busName), v);
  const out = (Array.isArray(aiBuses) ? aiBuses : []).map((b: any) => {
    const v = vByName.get(norm(b.busName));
    if (!v) return b;
    const nb: any = { ...b };
    // connectivity: geometry is ground truth -> override when different.
    if (norm(v.fedFromBusName) !== norm(b.fedFromBusName)) {
      disagreements.push({ busName: b.busName, field: 'fedFromBusName', ai: b.fedFromBusName ?? null, vector: v.fedFromBusName ?? null });
      nb.fedFromBusName = v.fedFromBusName ?? null;
    }
    // type: coarse geometry guess -> only fill a gap, never clobber the AI's finer type.
    if (v.equipmentTypeGuess && !b.equipmentTypeGuess) {
      disagreements.push({ busName: b.busName, field: 'equipmentTypeGuess', ai: null, vector: v.equipmentTypeGuess });
      nb.equipmentTypeGuess = v.equipmentTypeGuess;
    }
    // voltage: fill only when the AI missed it.
    if (v.nominalVoltage && !b.nominalVoltage) nb.nominalVoltage = v.nominalVoltage;
    nb.topologySource = 'schematic_geometry';
    return nb;
  });
  return { buses: out, disagreements, applied: true, advisory };
}

module.exports = { extractSchematicTopology, reconcileSchematicTopology };
export {};
