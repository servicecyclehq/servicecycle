'use strict';
export {}; // module-scope marker so tsc doesn't treat this script as global
/**
 * W1 native-PDF raw-response diagnostic — MAKES ONE REAL AI CALL.
 * Dumps the raw native-PDF response (length, head, tail, parse result) so we can
 * tell truncation (tail cut mid-JSON) from a malformed/non-JSON response.
 * Usage: AI_PROVIDER=gemini npx tsx scripts/w1-native-raw.ts
 */
try { require('dotenv').config(); } catch { /* optional */ }
const fs = require('fs');
const path = require('path');
const ai = require('../lib/ai');
const { EXTRACT_SYSTEM, NATIVE_PDF_USER } = require('../lib/arcFlashExtract');

const F = path.join(__dirname, '..', '..', 'Arc Flash Samples', 'NETA_Arc_Flash_Report_Test_2026-07-13.pdf');

(async () => {
  const pdfBuffer = fs.readFileSync(F);
  const maxTokens = Number(process.env.AF_NATIVE_MAX_TOKENS) || 32768;
  const t0 = Date.now();
  const out = await ai.completeWithPdf({ pdfBuffer, system: EXTRACT_SYSTEM, user: NATIVE_PDF_USER, maxTokens, responseMimeType: 'application/json' });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const t = out && out.text ? out.text : '';
  console.log('model =', out && out.model, '| maxTokens =', maxTokens, '| time =', secs + 's', '| rawLen =', t.length);
  console.log('HEAD:', JSON.stringify(t.slice(0, 140)));
  console.log('TAIL:', JSON.stringify(t.slice(-220)));
  let parsed: any = null; let perr: string | null = null;
  try { parsed = ai.parseJSON(t, 'diag'); } catch (e: any) { perr = e && e.message ? e.message : String(e); }
  if (parsed) console.log('PARSED OK | buses =', (parsed.buses || []).length);
  else console.log('PARSE FAIL:', perr ? perr.slice(0, 200) : 'unknown');
})().catch((e) => { console.error('ERR', e && e.message ? e.message : e); process.exit(2); });
