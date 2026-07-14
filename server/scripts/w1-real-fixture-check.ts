'use strict';
export {}; // module-scope marker so tsc doesn't treat this script as global
/**
 * W1 real-world sanity — MAKES ONE REAL AI CALL. Runs the native-PDF path over
 * Dustin's actual NETA report (the file that triggered this whole investigation)
 * to confirm native PDF reads it cleanly. Compare bus count to the old text
 * path's "13/24 buses" to see whether native reads at least as much.
 *
 * Usage: AI_PROVIDER=gemini npx tsx scripts/w1-real-fixture-check.ts
 */
try { require('dotenv').config(); } catch { /* optional */ }
const fs = require('fs');
const path = require('path');
const { extractArcFlashDocument } = require('../lib/arcFlashExtract');

const F = path.join(__dirname, '..', '..', 'Arc Flash Samples', 'NETA_Arc_Flash_Report_Test_2026-07-13.pdf');

(async () => {
  const buffer = fs.readFileSync(F);
  const t0 = Date.now();
  const res = await extractArcFlashDocument({ buffer, fileName: 'neta.pdf', mimeType: 'application/pdf' });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('method =', res.method, '| provenance =', res.provenance, '| buses =', (res.buses || []).length, '| time =', secs + 's');
  console.log('bus names:', JSON.stringify((res.buses || []).map((b: any) => b.busName)));
  if (res.warnings && res.warnings.length) console.log('warnings:', JSON.stringify(res.warnings));
})().catch((e) => { console.error('ERR', e && e.message ? e.message : e); process.exit(2); });
