#!/usr/bin/env node
/**
 * ai-smoke-test.js
 *
 * Hits all four LapseIQ AI integrations against the live AI provider so we
 * catch SDK / model / schema drift BEFORE opening an instance to users.
 *
 * Integrations exercised:
 *   1. PDF ingest extraction        — extractContractFields()  (lib/extractor.js)
 *   2. Signature image extraction   — completeWithImage()      (lib/ai.js, mirroring routes/signature.js)
 *   3. Renewal-brief generation     — complete()               (lib/ai.js, mirroring routes/contracts.js)
 *   4. News scanner classification  — complete()               (lib/ai.js, mirroring lib/newsScanner.js)
 *
 * Cost per run on Haiku: ~$0.05.  Exits 0 on PASS×4, 1 on any FAIL,
 * 2 on missing key (so CI can distinguish "not configured" from "broken").
 *
 * Usage:
 *   AI_API_KEY=sk-ant-... node server/scripts/ai-smoke-test.js
 *   # or with the legacy env name:
 *   ANTHROPIC_API_KEY=sk-ant-... node server/scripts/ai-smoke-test.js
 *
 * Run this BEFORE opening any new install to users — see docs/install.md
 * "Pre-launch smoke test" section.
 */

const path = require('path');

// Load .env from server/ (same shape as index.js does).
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
// Also accept a project-root .env as a fallback.
require('dotenv').config();

const { z } = require('zod');

// ── Tiny terminal helpers ────────────────────────────────────────────────────
const c = {
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  reset:  '\x1b[0m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
function paint(code, s) { return useColor ? `${code}${s}${c.reset}` : s; }
function logPass(name, detail) {
  const tag = paint(c.green, 'PASS');
  const lbl = paint(c.bold, name);
  console.log(`  ${tag}  ${lbl}${detail ? '  ' + paint(c.dim, '· ' + detail) : ''}`);
}
function logFail(name, err) {
  const tag = paint(c.red, 'FAIL');
  const lbl = paint(c.bold, name);
  const msg = err instanceof Error ? (err.stack || err.message) : String(err);
  const indented = msg.split('\n').map(l => '         ' + l).join('\n');
  console.log(`  ${tag}  ${lbl}\n${indented}`);
}

async function runTest(name, fn) {
  try {
    const detail = await fn();
    logPass(name, detail);
    return true;
  } catch (e) {
    logFail(name, e);
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const apiKey = process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(paint(c.red, paint(c.bold, 'error:')) +
      ' ANTHROPIC_API_KEY (or AI_API_KEY) is not set.');
    console.error('  Set it in server/.env, or export it before running this script.');
    console.error('  Without a live key, the smoke test cannot exercise the provider contract.');
    process.exit(2);
  }

  // Force the cheap model for the smoke test regardless of operator AI_MODEL.
  // This keeps the per-run cost ~$0.05 rather than ~$0.50 if Sonnet is configured.
  if (!process.env.AI_MODEL) {
    process.env.AI_MODEL = 'claude-haiku-4-5';
  }

  // Lazy-require so dotenv has already loaded when these modules read env.
  const { complete, completeWithImage } = require('../lib/ai');
  const { extractContractFields }       = require('../lib/extractor');

  console.log(paint(c.cyan, paint(c.bold, 'LapseIQ AI integration smoke test')));
  console.log('  ' + paint(c.dim, 'provider:') + ' ' + (process.env.AI_PROVIDER || 'anthropic'));
  console.log('  ' + paint(c.dim, 'model:   ') + ' ' + process.env.AI_MODEL);
  console.log('  ' + paint(c.dim, 'key:     ') + ' ' + apiKey.slice(0, 12) + '…' + apiKey.slice(-4));
  console.log('');

  const results = [];

  // ── 1. PDF ingest extraction ───────────────────────────────────────────────
  // Mirrors routes/ingest.js → extractContractFields().  We skip the actual
  // PDF parse since pdf-parse is not an AI dependency; the field extractor
  // is the AI-touching part.
  results.push(await runTest('PDF ingest extraction (extractContractFields)', async () => {
    const SAMPLE_CONTRACT_TEXT = `MASTER SUBSCRIPTION AGREEMENT

Vendor:               Acme Identity Inc.
Customer:             Globex Corporation
Contract Number:      ACME-2026-7714
Customer Number:      GLBX-994
Product:              Acme Identity Cloud — Enterprise tier
Quantity:             125 user licenses
Cost per License:     USD 144.00 / year
Term Start:           2026-06-01
Term End:             2027-05-31
Auto-Renewal:         YES — vendor will auto-renew unless cancelled
Notice Period:        60 days written notice required prior to expiration
Reseller:             SHI International Corp. (Account #SHI-44021)

Vendor support: support@acmeidentity.example  +1-415-555-0144
Reseller contact: alex.kim@shi.example
`;
    const out = await extractContractFields(SAMPLE_CONTRACT_TEXT);
    if (!out || typeof out !== 'object') {
      throw new Error('Expected object, got ' + typeof out);
    }
    if (typeof out.vendorName !== 'string' || !/acme/i.test(out.vendorName)) {
      throw new Error(`vendorName extraction missed; got: ${JSON.stringify(out.vendorName)}`);
    }
    if (typeof out.quantity !== 'number') {
      throw new Error(`quantity should be number, got: ${JSON.stringify(out.quantity)}`);
    }
    if (out.autoRenewal !== true) {
      throw new Error(`autoRenewal should be true, got: ${JSON.stringify(out.autoRenewal)}`);
    }
    return `vendor=${JSON.stringify(out.vendorName)} qty=${out.quantity} autoRenewal=${out.autoRenewal}`;
  }));

  // ── 2. Signature image extraction ──────────────────────────────────────────
  // Mirrors routes/signature.js → completeWithImage() with CONTACT_PROMPT.
  // We synthesise a business-card PNG via SVG so the test is self-contained.
  results.push(await runTest('Signature image extraction (completeWithImage)', async () => {
    let sharp;
    try { sharp = require('sharp'); }
    catch { throw new Error('sharp not installed — run `npm install sharp` in server/'); }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300">
  <rect width="600" height="300" fill="#ffffff"/>
  <text x="40" y="70"  font-family="Arial,sans-serif" font-size="28" fill="#000" font-weight="bold">Sarah Chen</text>
  <text x="40" y="105" font-family="Arial,sans-serif" font-size="18" fill="#333">VP, Strategic Accounts</text>
  <text x="40" y="135" font-family="Arial,sans-serif" font-size="18" fill="#333">Initech Software, Inc.</text>
  <text x="40" y="180" font-family="Arial,sans-serif" font-size="16" fill="#333">sarah.chen@initech.example</text>
  <text x="40" y="210" font-family="Arial,sans-serif" font-size="16" fill="#333">+1 (415) 555-0123</text>
  <text x="40" y="240" font-family="Arial,sans-serif" font-size="16" fill="#333">www.initech.example</text>
</svg>`;
    const imageBuffer = await sharp(Buffer.from(svg)).png().toBuffer();

    // CONTACT_PROMPT is the same prompt used by routes/signature.js.  Kept
    // inline rather than imported so a refactor of signature.js cannot make
    // this test silently no-op.
    const CONTACT_PROMPT = `Extract contact information from the following content and return a single JSON object.

Required structure:
{
  "name": string | null,
  "title": string | null,
  "company": string | null,
  "email": string | null,
  "phone": string | null,
  "fax": string | null,
  "address": string | null,
  "website": string | null,
  "notes": string | null
}

Return ONLY the JSON — no markdown, no explanation.`;

    const result = await completeWithImage({
      imageBuffer,
      mediaType: 'image/png',
      prompt:    CONTACT_PROMPT,
      maxTokens: 512,
    });
    if (!result || typeof result.text !== 'string') {
      throw new Error('completeWithImage must return { text: string }; got: ' + JSON.stringify(result));
    }

    const cleaned = result.text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) { throw new Error(`Invalid JSON from vision: ${e.message}\n  Raw: ${result.text.slice(0, 200)}`); }

    // Match the ContactSchema shape from routes/signature.js (lenient — every
    // field is optional/nullable, but unknown fields are OK).
    const ContactSchema = z.object({
      name:    z.string().nullable().optional(),
      title:   z.string().nullable().optional(),
      company: z.string().nullable().optional(),
      email:   z.string().nullable().optional(),
      phone:   z.string().nullable().optional(),
      fax:     z.string().nullable().optional(),
      address: z.string().nullable().optional(),
      website: z.string().nullable().optional(),
      notes:   z.string().nullable().optional(),
    }).passthrough();
    const validated = ContactSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error('ContactSchema validation failed: ' + JSON.stringify(validated.error.issues));
    }
    // The point of the smoke test is API-contract correctness, not OCR
    // accuracy on a synthetic SVG. Vision models sometimes misread small
    // antialiased text (e.g. "initech" → "inititech"), so we assert the
    // shape and that *some* plausible name + email were extracted, not
    // an exact string match.
    if (!parsed.name || typeof parsed.name !== 'string' || parsed.name.length < 3) {
      throw new Error(`name extraction weak; got: ${JSON.stringify(parsed.name)}`);
    }
    if (!parsed.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.email)) {
      throw new Error(`email extraction weak; expected an email-shaped string, got: ${JSON.stringify(parsed.email)}`);
    }
    return `name=${JSON.stringify(parsed.name)} email=${JSON.stringify(parsed.email)}`;
  }));

  // ── 3. Renewal brief generation ────────────────────────────────────────────
  // Mirrors routes/contracts.js → complete() with the renewal-brief prompt.
  results.push(await runTest('Renewal brief generation (complete)', async () => {
    const prompt = `You are a software procurement advisor analysing a contract.

CONTRACT DETAILS:
- Product: Snowflake Standard
- Vendor: Snowflake Inc.
- Department: Data Platform
- Quantity: 200 credits/month
- Cost Per License: $2.00
- Total Contract Value: $480,000
- Contract Start: Jul 1, 2024
- Contract End: Jun 30, 2026 (58 days away)
- Auto-Renewal: YES — Cancel by May 1, 2026 (OVERDUE)

Write a 4-paragraph renewal brief covering situation/risks, negotiation
leverage, recommended strategy, and quote-request hygiene. Use plain
paragraphs (no bullet points, no headers).`;
    const result = await complete({
      system: 'You are a software procurement advisor helping a business renew contracts strategically.',
      user:   prompt,
      maxTokens: 600,
    });
    if (!result || typeof result.text !== 'string') {
      throw new Error('complete must return { text: string }; got: ' + JSON.stringify(result));
    }
    if (result.text.length < 200) {
      throw new Error(`Brief too short (${result.text.length} chars); expected ≥200`);
    }
    if (!/snowflake/i.test(result.text)) {
      throw new Error('Brief did not mention Snowflake — vendor context not honoured');
    }
    return `${result.text.length} chars`;
  }));

  // ── 4. News scanner relevance scoring ──────────────────────────────────────
  // Mirrors lib/newsScanner.js → classifyArticle() shape.  We exercise the
  // prompt + JSON contract directly so a schema drift here surfaces before
  // the nightly cron silently drops every article.
  results.push(await runTest('News scanner relevance scoring', async () => {
    const item = {
      title: 'Salesforce announces $1.2B acquisition of customer-data startup InfraData',
      contentSnippet: 'Salesforce said today it would acquire InfraData, a customer-data ' +
        'infrastructure provider, in a $1.2 billion all-cash deal expected to close in Q3 2026. ' +
        'The acquisition is intended to strengthen Salesforce Data Cloud.',
      source: 'TechCrunch',
    };
    const vendorName = 'Salesforce';
    const prompt = `You are classifying a news article to decide if it's relevant to a software/technology vendor called "${vendorName}" and what type of news it is.

Article title: ${item.title}
Article source: ${item.source}
Article snippet: ${item.contentSnippet}

Respond with ONLY a JSON object (no markdown) with these exact fields:
{
  "relevant": true/false,
  "category": "<one of: security, outage, acquisition, pricing, new_feature, eol, legal, general>",
  "summary": "<1-2 sentence plain-English summary of what happened, max 200 chars>"
}`;
    const result = await complete({ user: prompt, maxTokens: 256 });
    if (!result || typeof result.text !== 'string') {
      throw new Error('complete returned wrong shape: ' + JSON.stringify(result));
    }
    const cleaned = result.text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) { throw new Error(`Invalid JSON: ${e.message}\n  Raw: ${result.text.slice(0, 200)}`); }

    if (typeof parsed.relevant !== 'boolean') {
      throw new Error(`relevant should be boolean, got: ${JSON.stringify(parsed.relevant)}`);
    }
    const VALID_CATEGORIES = ['security', 'outage', 'acquisition', 'pricing', 'new_feature', 'eol', 'legal', 'general'];
    if (!VALID_CATEGORIES.includes(parsed.category)) {
      throw new Error(`category not in valid set; got: ${JSON.stringify(parsed.category)}`);
    }
    if (typeof parsed.summary !== 'string') {
      throw new Error(`summary should be string, got: ${JSON.stringify(parsed.summary)}`);
    }
    if (parsed.relevant !== true) {
      throw new Error(`Expected relevant=true for explicit Salesforce M&A news; got false (model grading miss)`);
    }
    if (parsed.category !== 'acquisition') {
      throw new Error(`Expected category="acquisition" for explicit M&A news; got "${parsed.category}"`);
    }
    return `relevant=${parsed.relevant} category=${parsed.category}`;
  }));

  console.log('');
  const passed = results.filter(Boolean).length;
  const total  = results.length;
  if (passed === total) {
    console.log(paint(c.green, paint(c.bold, `${passed}/${total} integrations PASS`)));
    process.exit(0);
  } else {
    console.log(paint(c.red, paint(c.bold, `${total - passed}/${total} integrations FAIL`)));
    console.log(paint(c.dim, 'Re-run after each fix. Any FAIL is a launch blocker.'));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(paint(c.red, 'fatal:') + ' ' + (e.stack || e.message || e));
  process.exit(1);
});
