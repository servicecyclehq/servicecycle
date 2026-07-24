/**
 * Diagnostic: what happens when an abort fires from _geminiPdf?
 *
 * Runs the FULL extractArcFlashDocument path with a short AI_PDF_TIMEOUT_MS
 * override so the native-PDF call aborts, and measures how long the WHOLE
 * extraction takes -- the answer tells us how far the fallback cascade runs
 * after the abort is (currently) silently swallowed at arcFlashExtract.ts:618.
 *
 * Guarded behind RUN_LIVE_AI_TEST=1. Real, billed calls.
 *
 * Usage inside container:
 *   AI_PDF_TIMEOUT_MS=8000 RUN_LIVE_AI_TEST=1 \
 *     node node_modules/tsx/dist/cli.mjs tests/probeExtractPathDiag.ts
 */

import fs from "node:fs";
import path from "node:path";

const pdfPath = process.argv[2]
  || path.join(__dirname, "fixtures", "real-world-samples", "abb_dc_441kw_sideA_sideB.pdf");

async function main() {
  if (process.env.RUN_LIVE_AI_TEST !== "1") {
    console.log("Skipping: set RUN_LIVE_AI_TEST=1 to run (real billed calls).");
    process.exit(0);
  }
  const buf = fs.readFileSync(pdfPath);
  const { extractArcFlashDocument } = require("../lib/arcFlashExtract");

  console.log(JSON.stringify({
    step: "starting",
    pdfBytes: buf.length,
    AI_PDF_TIMEOUT_MS: process.env.AI_PDF_TIMEOUT_MS || null,
    AI_PROVIDER: process.env.AI_PROVIDER || null,
    AF_NATIVE_PDF: process.env.AF_NATIVE_PDF || null,
    nodeVersion: process.version,
  }));

  const t0 = Date.now();
  let result = null;
  let err = null;
  try {
    result = await extractArcFlashDocument({
      buffer: buf,
      mimeType: "application/pdf",
      fileName: "abb_dc_441kw_sideA_sideB.pdf",
    });
  } catch (e) {
    err = {
      name: e && e.name,
      constructor: e && e.constructor && e.constructor.name,
      message: e && e.message,
    };
  }
  const elapsedMs = Date.now() - t0;
  console.log(JSON.stringify({
    step: "done",
    elapsedMs,
    elapsedSec: (elapsedMs / 1000).toFixed(1),
    ok: !err,
    result: result ? {
      method: result.method,
      aiProvider: result.aiProvider,
      busCount: (result.buses || []).length,
      warnings: result.warnings,
    } : null,
    err,
  }));
  setTimeout(() => process.exit(err ? 1 : 0), 250);
}

main().catch((e) => { console.error("[probe] fatal:", e); process.exit(3); });