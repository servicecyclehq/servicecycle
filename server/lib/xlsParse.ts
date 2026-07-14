/**
 * lib/xlsParse.ts — legacy binary .xls (BIFF8 / OLE2) reader via SheetJS.
 *
 * ExcelJS (the codebase's spreadsheet reader) only parses OOXML .xlsx — it
 * CANNOT read a genuine legacy .xls, which is an OLE2 compound document. Those
 * files were accepted by extension across the asset importers but failed to
 * load. This module fills that gap using SheetJS, used ONLY for the .xls
 * branch; .xlsx stays on ExcelJS.
 *
 * Security note: the codebase historically avoided SheetJS because the version
 * published to the npm registry under the `xlsx` name (0.18.5) carries
 * CVE-2023-30533 (prototype pollution, fixed in 0.19.3) and CVE-2024-22363
 * (ReDoS, fixed in 0.20.2). SheetJS's own fix stopped publishing to npm as
 * `xlsx` and moved to their own CDN — so 2026-07-13 we install via
 * `@e965/xlsx`, a community-maintained package that mirrors SheetJS's actual
 * releases back onto the normal npm registry (automated via their GitHub
 * Actions, https://github.com/e965/sheetjs-npm-publisher) so this stays an
 * ordinary versioned npm dependency instead of a raw CDN URL in package.json.
 * Pinned to 0.20.3, which fixes BOTH CVEs above. SheetJS never executes
 * VBA/macros, and we read with cellFormula:false so no formula evaluation runs.
 *
 * Fails SOFT: if `@e965/xlsx` is not installed, a .xls upload gets a clear
 * "save as .xlsx" message instead of a raw require crash. Returns the SAME
 * { headers, rows } shape as importMapping.parseUploadBuffer / assetsImport.
 */

'use strict';

const MAX_XLS_BYTES = 15 * 1024 * 1024; // input cap (matches attachment caps)
const MAX_XLS_ROWS  = 20000;            // fail LOUD above this — never silently truncate

/**
 * Parse a legacy .xls buffer into { headers: string[], rows: object[] }.
 * @throws Error (clear message) on missing lib, oversize, or over-row-cap input.
 */
function parseXlsBuffer(buffer: Buffer): { headers: string[]; rows: any[] } {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('The spreadsheet is empty.');
  }
  if (buffer.length > MAX_XLS_BYTES) {
    throw new Error(`Spreadsheet exceeds the ${Math.round(MAX_XLS_BYTES / 1024 / 1024)} MB limit.`);
  }

  let XLSX: any;
  try {
    XLSX = require('@e965/xlsx');
  } catch {
    throw new Error('Legacy .xls files are not supported on this server. Please open the file in Excel and "Save As" .xlsx (Excel Workbook), then re-upload.');
  }

  // cellFormula:false → never keep/evaluate formulas; raw:false → formatted
  // string values (dates render as printed). SheetJS does not run macros.
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellFormula: false, cellHTML: false });
  const wsName = wb.SheetNames && wb.SheetNames[0];
  if (!wsName) return { headers: [], rows: [] };
  const ws = wb.Sheets[wsName];
  if (!ws) return { headers: [], rows: [] };

  // Row-count guard from the declared sheet range — reject oversize LOUDLY
  // (don't silently drop rows) before materializing the whole grid.
  const ref = ws['!ref'];
  if (ref) {
    try {
      const range = XLSX.utils.decode_range(ref);
      const nRows = range.e.r - range.s.r + 1;
      if (nRows > MAX_XLS_ROWS) {
        throw new Error(`Spreadsheet has ${nRows} rows, over the ${MAX_XLS_ROWS}-row limit — split it into smaller files.`);
      }
    } catch (e: any) {
      if (e && /over the/.test(String(e.message))) throw e;
      /* unparseable ref → fall through; sheet_to_json still bounded by input size cap */
    }
  }

  const aoa: any[] = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '', raw: false });
  if (!aoa.length) return { headers: [], rows: [] };

  const headers = (aoa[0] || []).map((h: any) => String(h == null ? '' : h).replace(/^﻿/, '').trim());
  const rows: any[] = [];
  for (let i = 1; i < aoa.length; i++) {
    const cells = aoa[i] || [];
    if (cells.every((c: any) => c == null || String(c).trim() === '')) continue;
    const obj: any = {};
    for (let j = 0; j < headers.length; j++) {
      const h = headers[j];
      if (!h) continue;
      obj[h] = String(cells[j] == null ? '' : cells[j]);
    }
    rows.push(obj);
  }
  return { headers: headers.filter((h: string) => h !== ''), rows };
}

module.exports = { parseXlsBuffer, MAX_XLS_ROWS, MAX_XLS_BYTES };
export {};
