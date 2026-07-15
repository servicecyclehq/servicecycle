/**
 * lib/vectorTopology.ts -- deterministic vector-geometry topology for "card tree"
 * one-line PDFs. Runs scripts/vector_topology.py (pdfplumber, NO AI) to read the
 * PDF's actual vector coordinates and reconstruct the feed tree + equipment type
 * from the drawn indent. FAILS OPEN: any failure, or a non-card-tree PDF, yields
 * isCardTree:false so the AI extraction path is left completely untouched.
 *
 * reconcileVectorTopology() overlays the deterministic connectivity + type onto the
 * AI-extracted buses (matched by normalized bus name). On a vector card-tree the
 * geometry is ground truth for "who feeds whom", not a guess -- so it wins, and every
 * place the AI disagreed is recorded so the review UI can surface it for the human.
 */

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PY = process.env.PYEXTRACT_PYTHON || 'python3';
const SCRIPT = path.join(__dirname, '..', 'scripts', 'vector_topology.py');
const TIMEOUT_MS = parseInt(process.env.PYEXTRACT_TIMEOUT_MS || '30000', 10);

export interface VectorBus {
  busName: string;
  equipmentTypeGuess: string | null;
  fedFromBusName: string | null;
  nominalVoltage: string | null;
  level: number;
}
export interface VectorTopology { ok: boolean; isCardTree: boolean; buses: VectorBus[]; }

const EMPTY: VectorTopology = { ok: false, isCardTree: false, buses: [] };

// Run the Python vector reader on the PDF bytes. Never throws.
async function extractVectorTopology(buffer: Buffer): Promise<VectorTopology> {
  return new Promise((resolve) => {
    let tmp: string | null = null;
    try {
      tmp = path.join(os.tmpdir(), `afvec-${crypto.randomBytes(8).toString('hex')}.pdf`);
      fs.writeFileSync(tmp, buffer);
    } catch {
      return resolve(EMPTY);
    }
    execFile(PY, [SCRIPT, tmp], { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err: any, stdout: any) => {
      try { if (tmp) fs.unlinkSync(tmp); } catch { /* tmp reaped anyway */ }
      if (err || !stdout) return resolve(EMPTY);
      try {
        const out = JSON.parse(String(stdout).trim().split('\n').pop());
        if (out && out.ok && out.isCardTree && Array.isArray(out.buses)) {
          return resolve({ ok: true, isCardTree: true, buses: out.buses });
        }
      } catch { /* fall through */ }
      resolve(EMPTY);
    });
  });
}

const norm = (s: any) => String(s == null ? '' : s).trim().toLowerCase();

export interface VectorOverride { busName: string; field: 'fedFromBusName' | 'equipmentTypeGuess'; ai: string | null; vector: string | null; }

/**
 * Overlay deterministic connectivity + type onto AI buses (match by normalized name).
 * Returns { buses, disagreements, applied }. `applied` is false (buses returned
 * unchanged) when the PDF is not a card-tree.
 */
function reconcileVectorTopology(aiBuses: any[], vec: VectorTopology): { buses: any[]; disagreements: VectorOverride[]; applied: boolean } {
  const disagreements: VectorOverride[] = [];
  if (!vec || !vec.isCardTree || !Array.isArray(vec.buses) || !vec.buses.length) {
    return { buses: aiBuses, disagreements, applied: false };
  }
  const vByName = new Map<string, VectorBus>();
  for (const v of vec.buses) vByName.set(norm(v.busName), v);
  const out = (Array.isArray(aiBuses) ? aiBuses : []).map((b: any) => {
    const v = vByName.get(norm(b.busName));
    if (!v) return b;
    const nb: any = { ...b };
    if (norm(v.fedFromBusName) !== norm(b.fedFromBusName)) {
      disagreements.push({ busName: b.busName, field: 'fedFromBusName', ai: b.fedFromBusName ?? null, vector: v.fedFromBusName ?? null });
      nb.fedFromBusName = v.fedFromBusName ?? null;
    }
    if (v.equipmentTypeGuess && norm(v.equipmentTypeGuess) !== norm(b.equipmentTypeGuess)) {
      disagreements.push({ busName: b.busName, field: 'equipmentTypeGuess', ai: b.equipmentTypeGuess ?? null, vector: v.equipmentTypeGuess });
      nb.equipmentTypeGuess = v.equipmentTypeGuess;
    }
    if (v.nominalVoltage && !b.nominalVoltage) nb.nominalVoltage = v.nominalVoltage;
    nb.topologySource = 'vector_geometry';
    return nb;
  });
  return { buses: out, disagreements, applied: true };
}

module.exports = { extractVectorTopology, reconcileVectorTopology };
export {};