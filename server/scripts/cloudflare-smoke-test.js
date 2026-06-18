#!/usr/bin/env node
/**
 * cloudflare-smoke-test.js (v0.35.0)
 *
 * One-shot smoke test for the new Cloudflare Workers AI provider +
 * the HF / Groq cascade introduced in v0.35.0.
 *
 * USAGE
 *   AI_PROVIDER=cloudflare CF_WORKERS_AI_ACCOUNT_ID=... CF_WORKERS_AI_API_KEY=... \
 *   node server/scripts/cloudflare-smoke-test.js
 *
 *   Optional: HF_TOKEN=... GROQ_API_KEY=... to exercise the cascade.
 *   Optional: --dry-run to skip the live network call and just verify
 *             provider modules load + classify errors correctly.
 *
 * The test sends a small synthetic contract excerpt to the extract path
 * (which forces Mistral Small 24B on Cloudflare with no fallback) and
 * prints the response shape + Neuron count. Then sends a tiny chat
 * prompt with task='ask' to exercise the cascade chain.
 *
 * Exits 0 on success, non-zero on failure. CI can wire this in for the
 * v0.35.0 deploy gate.
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const dryRun = process.argv.includes('--dry-run');

function header(s) { console.log('\n=== ' + s + ' ==='); }

async function main() {
  header('1. Module load test');
  let aiProvider, cloudflare, huggingface, groq, budgetGuard;
  try {
    aiProvider  = require('../lib/ai');
    cloudflare  = require('../lib/aiProviders/cloudflare');
    huggingface = require('../lib/aiProviders/huggingface');
    groq        = require('../lib/aiProviders/groq');
    budgetGuard = require('../lib/aiBudgetGuard');
    console.log('  - lib/ai.js                    OK');
    console.log('  - lib/aiProviders/cloudflare   OK');
    console.log('  - lib/aiProviders/huggingface  OK');
    console.log('  - lib/aiProviders/groq         OK');
    console.log('  - lib/aiBudgetGuard            OK');
  } catch (e) {
    console.error('  Module load FAILED:', e.message);
    process.exit(1);
  }

  header('2. Budget guard surface');
  console.log('  peekAll():');
  console.log(JSON.stringify(budgetGuard.peekAll(), null, 2));

  header('3. Cloudflare model registry');
  console.log('  MODEL_FOR_TASK:', JSON.stringify(cloudflare.MODEL_FOR_TASK, null, 2));

  if (dryRun) {
    console.log('\n[dry-run] skipping live network calls. Pass without --dry-run to exercise CF.');
    process.exit(0);
  }

  if (!process.env.CF_WORKERS_AI_ACCOUNT_ID || !process.env.CF_WORKERS_AI_API_KEY) {
    console.error('\nFAIL: CF_WORKERS_AI_ACCOUNT_ID and CF_WORKERS_AI_API_KEY required for live test.');
    console.error('      Set them in server/.env or pass --dry-run for module-load smoke only.');
    process.exit(2);
  }

  // Force-route through the cloudflare path even if AI_PROVIDER isn't set.
  process.env.AI_PROVIDER = 'cloudflare';

  header('4. Live: contract extraction (CF only, no cascade)');
  const sampleContract = `VENDOR QUOTE
Vendor: Acme Cloud Services, Inc.
Product: Acme Platform Standard Plan
Quantity: 50 seats
Unit price: $42.00/seat/month
Total monthly: $2,100.00
Term: 12 months
Quote valid through: June 30, 2026`;

  const extractSystem = `You extract structured pricing data from vendor quotes. Respond with ONLY a JSON object with these keys: vendor, product, quantity, unitPrice, totalPrice, termMonths, validThrough.`;

  try {
    const t0 = Date.now();
    const out = await aiProvider.complete({
      system:    extractSystem,
      user:      `Extract from:\n${sampleContract}`,
      maxTokens: 512,
      task:      'extract',
    });
    const ms = Date.now() - t0;
    console.log(`  CF extract OK in ${ms}ms`);
    console.log('  Output (first 600 chars):');
    console.log('  ' + (out.text || '').slice(0, 600).replace(/\n/g, '\n  '));
  } catch (e) {
    console.error('  CF extract FAILED:', e.name, e.message);
    process.exit(3);
  }

  header('5. Live: Ask ServiceCycle chat (CF -> HF -> Groq cascade)');
  try {
    const t0 = Date.now();
    const out = await aiProvider.complete({
      system:    'You are a concise assistant. Reply in one sentence.',
      user:      'What is a software renewal lapse?',
      maxTokens: 128,
      task:      'ask',
    });
    const ms = Date.now() - t0;
    console.log(`  CF ask OK in ${ms}ms`);
    console.log('  Response:', (out.text || '').slice(0, 300));
  } catch (e) {
    console.error('  CF ask FAILED:', e.name, e.message);
    process.exit(4);
  }

  header('6. Post-call budget guard snapshot');
  console.log('  cloudflare peek():');
  console.log(JSON.stringify(budgetGuard.peek('cloudflare'), null, 2));

  console.log('\nAll checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Unhandled smoke-test error:', err);
  process.exit(99);
});
