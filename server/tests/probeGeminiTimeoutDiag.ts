/**
 * Diagnostic: does @google/generative-ai actually honor requestOptions.timeout?
 *
 * Mirrors _geminiPdf's exact call shape (in server/lib/ai.ts) against the ABB
 * reference PDF, with a caller-chosen short timeout, and prints timing + error
 * details so we can distinguish "SDK timeout works" (abort at ~timeout) from
 * "SDK timeout ignored" (elapsed >> timeout) from "cascade re-tries hide it"
 * (elapsed is a multiple of timeout).
 *
 * Guarded behind RUN_LIVE_AI_TEST=1 â€” never runs in normal CI or a jest sweep,
 * because it hits real, billed Gemini calls.
 *
 * Usage (inside a running server container):
 *   RUN_LIVE_AI_TEST=1 node node_modules/tsx/dist/cli.mjs \
 *     tests/probeGeminiTimeoutDiag.ts [timeoutMs] [pdfPath] [maxOutputTokens]
 *
 * Defaults: timeoutMs=15000, pdfPath=abb_dc_441kw_sideA_sideB.pdf, maxTokens=4096.
 */

import fs from "node:fs";
import path from "node:path";

// Late-load the SDK the same way _geminiPdf does, so the resolution/version
// this probe uses matches production.
const { GoogleGenerativeAI } = require("@google/generative-ai");

const timeoutMs = Number(process.argv[2]) || 15_000;
const pdfPath = process.argv[3] || path.join(__dirname, "fixtures", "real-world-samples", "abb_dc_441kw_sideA_sideB.pdf");
const maxTokens = Number(process.argv[4]) || 4096;
const modelName = process.env.PROBE_MODEL || "gemini-2.5-flash";

function line(obj) { console.log(JSON.stringify(obj)); }

async function main() {
  if (process.env.RUN_LIVE_AI_TEST !== "1") {
    console.log("Skipping: set RUN_LIVE_AI_TEST=1 to run (real, billed AI call).");
    process.exit(0);
  }
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.AI_API_KEY;
  if (!apiKey) {
    line({ step: "error", detail: "no API key in env (GEMINI_API_KEY / GOOGLE_API_KEY / AI_API_KEY)" });
    process.exit(2);
  }
  const buf = fs.readFileSync(pdfPath);
  line({
    step: "starting",
    timeoutMs,
    modelName,
    pdfPath,
    pdfBytes: buf.length,
    nodeVersion: process.version,
    sdkVersion: (() => { try { return require("@google/generative-ai/package.json").version; } catch { return "unknown"; } })(),
  });
  const genai = new GoogleGenerativeAI(apiKey);
  // Match _geminiPdf's call shape exactly (systemInstruction + requestOptions.timeout).
  const m = genai.getGenerativeModel(
    { model: modelName, systemInstruction: "You extract structured data." },
    { timeout: timeoutMs },
  );
  const t0 = Date.now();
  let out = null;
  let err = null;
  try {
    const result = await m.generateContent({
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: "application/pdf", data: buf.toString("base64") } },
          { text: "List every bus name in this document. JSON only: {\"buses\":[...]}. Nothing else." },
        ],
      }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json",
        temperature: 0,
      },
    });
    const text = result.response.text().trim();
    out = { finishReason: result.response.candidates?.[0]?.finishReason, textPreview: text.slice(0, 200) };
  } catch (e) {
    err = {
      name: e && e.name,
      constructor: e && e.constructor && e.constructor.name,
      message: e && e.message,
      matchAbortByName: e && e.name === "AbortError",
      matchAbortByMessage: e && /abort/i.test(String(e.message || e)),
      status: e && e.status,
    };
  }
  const elapsedMs = Date.now() - t0;
  line({
    step: "done",
    elapsedMs,
    timeoutMs,
    ratio: (elapsedMs / timeoutMs).toFixed(2),
    ok: out !== null,
    out,
    err,
  });
  // Give any late-firing setTimeout a moment to log if it were going to.
  setTimeout(() => process.exit(err ? 1 : 0), 250);
}

main().catch((e) => {
  console.error("[probe] fatal:", e);
  process.exit(3);
});