/**
 * AI provider abstraction layer.
 *
 * Configure entirely via environment variables — no code changes needed to switch providers.
 * Self-hosted customers set these in their .env and restart. No rebuild required.
 *
 * ── Supported providers ──────────────────────────────────────────────────────
 *
 *  AI_PROVIDER=cloudflare       (NEW v0.35.0; demo default) Cloudflare Workers AI
 *  AI_PROVIDER=anthropic        Anthropic Claude
 *  AI_PROVIDER=openai           OpenAI (GPT-4o, etc.)
 *  AI_PROVIDER=azure_openai     Azure OpenAI — runs inside customer's Azure tenant
 *  AI_PROVIDER=gemini           Google Gemini
 *
 * Fallback chain for chat + classification ONLY (v0.35.0):
 *   When AI_PROVIDER=cloudflare AND task='ask' or task='classify':
 *     Cloudflare → HuggingFace → Groq (on 429 / 5xx / timeout)
 *   Extraction + brief stay Cloudflare-only — Mistral Small 3.1 24B is the
 *   quality bar; cascading to a Llama-8B-class fallback would degrade
 *   output too much for those high-value paths.
 *
 * ── Common env vars ──────────────────────────────────────────────────────────
 *
 *  AI_PROVIDER=cloudflare       Which provider to use (default: cloudflare on demo;
 *                               anthropic on self-host for back-compat with v0.34)
 *  AI_API_KEY=...               API key for the chosen provider
 *                               (falls back to ANTHROPIC_API_KEY for backwards compat)
 *  AI_MODEL=...                 Model name/deployment to use (provider-specific default if omitted)
 *
 * ── Cloudflare-specific vars (v0.35.0) ───────────────────────────────────────
 *
 *  CF_WORKERS_AI_ACCOUNT_ID=...       Cloudflare account UUID
 *  CF_WORKERS_AI_API_KEY=...          Workers AI token (separate from CF api token!)
 *  HF_TOKEN=...                       HuggingFace fallback token (cascade only)
 *  GROQ_API_KEY=...                   Groq fallback token (cascade only)
 *
 * ── Azure-specific vars ───────────────────────────────────────────────────────
 *
 *  AZURE_OPENAI_ENDPOINT=https://your-tenant.openai.azure.com
 *  AZURE_OPENAI_DEPLOYMENT=gpt-4o   (your deployment name)
 *  AZURE_API_VERSION=2024-02-01     (optional, defaults to 2024-02-01)
 *
 * ── Default models ────────────────────────────────────────────────────────────
 *
 *  cloudflare   → @cf/mistralai/mistral-small-3.1-24b-instruct (extract/brief)
 *                 @cf/meta/llama-3.1-8b-instruct                (ask/classify)
 *  anthropic    → claude-haiku-4-5  (fast, cheap, great for extraction)
 *  openai       → gpt-4o-mini
 *  azure_openai → uses AZURE_OPENAI_DEPLOYMENT
 *  gemini       → gemini-1.5-flash
 */

const cloudflareProvider  = require('./aiProviders/cloudflare');
const { logCascadeEvent } = require('./betterStack'); // Pass-6 W4 task #9
const { scrubPromptLeak } = require('./aiOutputGuard'); // F-AI-LEAK: system-prompt leak guard
const huggingfaceProvider = require('./aiProviders/huggingface');
const groqProvider        = require('./aiProviders/groq');

// ── Settings resolution ───────────────────────────────────────────────────────
// `settings` is an optional object passed per-call (from DB-backed account settings).
// Falls back to environment variables for each value.

function resolveSettings(settings: any = {}) {
  const provider = (settings.provider || process.env.AI_PROVIDER || 'anthropic').toLowerCase();
  const apiKey   = settings.apiKey   || process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY;

  const DEFAULT_MODELS = {
    cloudflare:   undefined, // resolved per-task by cloudflare.js
    anthropic:    'claude-haiku-4-5',
    openai:       'gpt-4o-mini',
    azure_openai: settings.azureDeployment || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
    gemini:       'gemini-1.5-flash',
  };

  // L2: AI_MODEL_OVERRIDE (env) wins over every other source — including the
  // per-call `settings.model` argument and DB-backed account settings. This
  // is the operator's emergency lever: pin every AI call in the running
  // instance to a specific model without touching the DB or the code.
  // DEMO_MODE startup forces it to claude-haiku-4-5-20251001 so demo cost
  // can't be inflated by a rogue feature setting Sonnet.
  const modelName = process.env.AI_MODEL_OVERRIDE
    || settings.model
    || process.env.AI_MODEL
    || DEFAULT_MODELS[provider]
    || 'gpt-4o-mini';

  return {
    provider,
    apiKey,
    model:           modelName,
    azureEndpoint:   settings.azureEndpoint   || process.env.AZURE_OPENAI_ENDPOINT,
    azureDeployment: settings.azureDeployment || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
    azureApiVersion: settings.azureApiVersion || process.env.AZURE_API_VERSION || '2024-02-01',
    cloudflareAccountId: settings.cloudflareAccountId || process.env.CF_WORKERS_AI_ACCOUNT_ID,
  };
}

// ── Cascade routing (v0.35.0) ─────────────────────────────────────────────────
//
// Build a per-task provider chain. The chain is consulted only when
// AI_PROVIDER=cloudflare and the task is 'ask' or 'classify'. Every other
// combination is a single-element chain (no cascade).
//
// Circuit-breaker state per provider name. After 3 consecutive failures of
// server/timeout class within 60s, the breaker opens for 5 minutes; cascade
// skips an open breaker entirely. Same pattern as aiBudgetGuard but cheaper
// because we don't need to persist across restarts.
const _breaker = {
  cloudflare:  { fails: 0, lastFailAt: 0, openUntil: 0 },
  huggingface: { fails: 0, lastFailAt: 0, openUntil: 0 },
  groq:        { fails: 0, lastFailAt: 0, openUntil: 0 },
};
const BREAKER_FAILS_BEFORE_OPEN = 3;
const BREAKER_FAIL_WINDOW_MS    = 60_000;
const BREAKER_OPEN_MS           = 5 * 60_000;

function _breakerIsOpen(name) {
  const b = _breaker[name];
  if (!b) return false;
  return Date.now() < b.openUntil;
}

function _breakerRecordFailure(name) {
  const b = _breaker[name];
  if (!b) return;
  const now = Date.now();
  if (now - b.lastFailAt > BREAKER_FAIL_WINDOW_MS) {
    b.fails = 0;
  }
  b.fails += 1;
  b.lastFailAt = now;
  if (b.fails >= BREAKER_FAILS_BEFORE_OPEN) {
    b.openUntil = now + BREAKER_OPEN_MS;
    console.warn(`[ai.cascade] circuit-breaker opened for ${name} until ${new Date(b.openUntil).toISOString()}`);
  }
}

function _breakerRecordSuccess(name) {
  const b = _breaker[name];
  if (!b) return;
  b.fails = 0;
  b.openUntil = 0;
}

function _resolveCascadeChain(provider, task) {
  // v0.38.3: previously only `ask` and `classify` cascaded. That meant
  // a CF Workers AI timeout on a maintenance brief surfaced as a user-facing
  // "Failed to generate" error — the exact opposite of what the cascade
  // architecture was built for. Per the silent-failure design rule
  // (see memory feedback_ai_cascade_silent_failure.md), brief + extract
  // now cascade too so a single primary-provider hiccup is invisible to
  // the end user. Self-host operators on cheap CF primary still pay
  // nothing for the fallbacks they don't hit.
  if (provider !== 'cloudflare') return [provider];

  // Honour AI_DISABLED_PROVIDERS for runtime kill-switch.
  const disabled = new Set(
    (process.env.AI_DISABLED_PROVIDERS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );

  return ['cloudflare', 'groq', 'huggingface'].filter((p) => !disabled.has(p));
}

async function _callProviderOnce(providerName, args) {
  if (providerName === 'cloudflare') return cloudflareProvider.complete(args);
  if (providerName === 'huggingface') return huggingfaceProvider.complete(args);
  if (providerName === 'groq')        return groqProvider.complete(args);
  throw new Error(`[ai.cascade] unsupported cascade provider: ${providerName}`);
}

async function _cascadeComplete(args, chain) {
  let lastErr = null;
  for (let i = 0; i < chain.length; i++) {
    const providerName = chain[i];
    if (_breakerIsOpen(providerName)) {
      console.warn(`[ai.cascade] skipping ${providerName} — circuit-breaker is open`);
      // Pass-6 W4 task #9: emit a breaker-skip event so the Better Stack
      // dashboard shows the cascade routing decisions even when no
      // network call is attempted.
      logCascadeEvent({ provider: providerName, hop: i, task: args.task,
                        outcome: 'breaker_open', latencyMs: 0 });
      continue;
    }

    const _startedAt = Date.now();
    try {
      const result = await _callProviderOnce(providerName, args);
      _breakerRecordSuccess(providerName);
      const _latencyMs = Date.now() - _startedAt;
      if (i > 0) {
        console.log(`[ai.cascade] task=${args.task} hop=${i} primary=${chain[0]} -> ${providerName} succeeded`);
      }
      // Pass-6 W4 task #9: ship the success event to Better Stack.
      logCascadeEvent({ provider: providerName, hop: i, task: args.task,
                        outcome: 'success', latencyMs: _latencyMs });
      return Object.assign({ provider: providerName }, result);
    } catch (err) {
      const _latencyMs = Date.now() - _startedAt;
      const cascade = err && err.cascade === true;
      console.warn(
        `[ai.cascade] ${providerName} failed (${err && err.name ? err.name : 'Error'}): ` +
        `${err && err.message ? err.message.slice(0, 200) : String(err)}`
      );

      // Pass-6 W4 task #9: emit a fail/cascade event so the dashboard sees
      // BOTH the provider-level failure AND the cascade routing decision.
      logCascadeEvent({
        provider: providerName, hop: i, task: args.task,
        outcome: cascade ? 'cascade' : 'fail',
        latencyMs: _latencyMs,
        errorName: err && err.name,
        errorMessage: err && err.message,
      });

      // ServerError / TimeoutError: record breaker failure
      if (err && (err.name === 'ServerError' || err.name === 'TimeoutError')) {
        _breakerRecordFailure(providerName);
      }

      lastErr = err;

      if (!cascade) {
        // ClientError or non-cascading failure: fail-fast, no fallback.
        throw err;
      }
      // Otherwise: try next provider in the chain.
    }
  }

  // Exhausted the chain.
  throw lastErr || new Error('[ai.cascade] all providers exhausted');
}

// ── Text completion ───────────────────────────────────────────────────────────
// Returns { text: string }
//
// Optional `task` (v0.35.0): one of 'extract' | 'brief' | 'ask' | 'classify'.
// Used by the cloudflare provider for per-task model selection and by the
// cascade router to decide whether fallbacks are permitted.
//
// Optional `cacheSystem`: when true and provider=anthropic, the system prompt
// is sent as a single ephemeral cached block. Anthropic charges:
//   - +25% input tokens on the cache-write call (first call in a session)
//   - 10%  input tokens on cache-read calls (subsequent calls within 5 min TTL)
// Used by the Ask assistant where the AI Guide system prompt is ~50K tokens — the
// per-call cost drops ~12x on warm-cache calls (effective $0.005 vs $0.062
// on Haiku 4.5). Other providers ignore the flag — they don't expose
// equivalent per-block caching primitives, so we accept the larger first-call
// cost rather than emit a confusing error.

async function complete({ system, user, maxTokens = 4096, settings = {}, cacheSystem = false, task = null }) {
  const s = resolveSettings(settings);

  let result;
  if (s.provider === 'cloudflare') {
    const chain = _resolveCascadeChain(s.provider, task);
    result = await _cascadeComplete({ system, user, maxTokens, task, settings: s }, chain);
  } else if (s.provider === 'anthropic') {
    result = await _anthropicComplete({ system, user, maxTokens, s, cacheSystem });
  } else if (s.provider === 'openai') {
    result = await _openaiComplete({ system, user, maxTokens, s });
  } else if (s.provider === 'azure_openai') {
    result = await _azureComplete({ system, user, maxTokens, s });
  } else if (s.provider === 'gemini') {
    result = await _geminiComplete({ system, user, maxTokens, s });
  } else {
    throw new Error(`[ai] Unknown AI_PROVIDER: "${s.provider}". Valid options: cloudflare, anthropic, openai, azure_openai, gemini`);
  }

  // F-AI-LEAK: redact any response that reproduces a system prompt (OWASP
  // LLM07). Covers every text surface routed through complete(). The Ask
  // tool-protocol "LOAD_SECTION:" token is intentionally NOT a signature.
  if (result && typeof result.text === 'string') {
    result.text = scrubPromptLeak(result.text, task ? `task=${task}` : null);
  }
  return result;
}

// ── Image completion (vision) ─────────────────────────────────────────────────
// Returns { text: string }
//
// Cloudflare Workers AI does not expose a unified vision OpenAI-compat path
// for the Mistral / Llama text models ServiceCycle currently uses, so when
// AI_PROVIDER=cloudflare we route images through the existing Anthropic
// fallback (requires ANTHROPIC_API_KEY to be set in addition to the CF
// credentials). Operators who don't want any Anthropic dependency on the
// demo can set AI_VISION_PROVIDER=gemini and provide a Gemini key for the
// vision path only.

async function completeWithImage({ imageBuffer, mediaType = 'image/jpeg', prompt, maxTokens = 4096, settings = {} }) {
  const s = resolveSettings(settings);

  let visionProvider = s.provider;
  if (visionProvider === 'cloudflare') {
    visionProvider = (process.env.AI_VISION_PROVIDER || 'anthropic').toLowerCase();
  }

  if (visionProvider === 'anthropic') {
    const ak = process.env.ANTHROPIC_API_KEY || s.apiKey;
    return _anthropicImage({ imageBuffer, mediaType, prompt, maxTokens, s: Object.assign({}, s, { apiKey: ak }) });
  } else if (visionProvider === 'openai' || visionProvider === 'azure_openai') {
    return _openaiImage({ imageBuffer, prompt, maxTokens, azure: visionProvider === 'azure_openai', s });
  } else if (visionProvider === 'gemini') {
    return _geminiImage({ imageBuffer, mediaType, prompt, maxTokens, s });
  } else {
    throw new Error(`[ai] Provider "${visionProvider}" does not support image input`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseJSON(text, providerName) {
  const cleaned = text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`[ai] ${providerName} returned invalid JSON: ${e.message}\nRaw: ${text.slice(0, 500)}`);
  }
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

async function _anthropicComplete({ system, user, maxTokens, s, cacheSystem = false }) {
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); } catch {
    throw new Error('[ai] @anthropic-ai/sdk not installed. Run: npm install @anthropic-ai/sdk');
  }
  // S3-FN-02 (v0.74.1): timeout + maxRetries so a hung Anthropic call
  // cannot stall the event loop indefinitely. SDK default timeout is 10min.
  const client = new Anthropic({
    apiKey: s.apiKey,
    timeout:    60_000, // 60s — generous for long briefs
    maxRetries: 1,      // one retry on transient network flakes
  });

  // When cacheSystem is true, send `system` as a single block with
  // cache_control.ephemeral. Anthropic caches the whole prefix up to and
  // including the marked block; the first call in a session pays a +25%
  // write premium and subsequent calls within ~5 minutes pay 10% of the
  // input tokens. The string-form `system` parameter (the default path)
  // does NOT cache.
  const systemPayload = cacheSystem && typeof system === 'string'
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : system;

  const msg = await client.messages.create({
    model: s.model,
    max_tokens: maxTokens,
    system: systemPayload,
    messages: [{ role: 'user', content: user }],
  });
  return { text: msg.content[0].text.trim() };
}

async function _anthropicImage({ imageBuffer, mediaType, prompt, maxTokens, s }) {
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); } catch {
    throw new Error('[ai] @anthropic-ai/sdk not installed. Run: npm install @anthropic-ai/sdk');
  }
  // S3-FN-02 (v0.74.1): timeout + maxRetries so a hung Anthropic call
  // cannot stall the event loop indefinitely. SDK default timeout is 10min.
  const client = new Anthropic({
    apiKey: s.apiKey,
    timeout:    60_000, // 60s — generous for long briefs
    maxRetries: 1,      // one retry on transient network flakes
  });
  const msg = await client.messages.create({
    model: s.model,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBuffer.toString('base64') } },
        { type: 'text', text: prompt },
      ],
    }],
  });
  return { text: msg.content[0].text.trim() };
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

function _openaiClient(s) {
  let OpenAI;
  try { OpenAI = require('openai').default || require('openai'); } catch {
    throw new Error('[ai] openai package not installed. Run: npm install openai');
  }
  return new OpenAI({ apiKey: s.apiKey });
}

async function _openaiComplete({ system, user, maxTokens, s }) {
  const client = _openaiClient(s);
  const res = await client.chat.completions.create({
    model: s.model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return { text: res.choices[0].message.content.trim() };
}

async function _openaiImage({ imageBuffer, prompt, maxTokens, azure, s }) {
  const client = azure ? _azureClient(s) : _openaiClient(s);
  const base64 = imageBuffer.toString('base64');
  const res = await client.chat.completions.create({
    model: s.model,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        { type: 'text', text: prompt },
      ],
    }],
  });
  return { text: res.choices[0].message.content.trim() };
}

// ── Azure OpenAI ──────────────────────────────────────────────────────────────

function _azureClient(s) {
  let OpenAI;
  try { OpenAI = require('openai').default || require('openai'); } catch {
    throw new Error('[ai] openai package not installed. Run: npm install openai');
  }
  if (!s.azureEndpoint) throw new Error('[ai] AZURE_OPENAI_ENDPOINT is required for azure_openai provider');

  return new OpenAI({
    apiKey:         s.apiKey,
    baseURL:        `${s.azureEndpoint}/openai/deployments/${s.azureDeployment}`,
    defaultQuery:   { 'api-version': s.azureApiVersion },
    defaultHeaders: { 'api-key': s.apiKey },
  });
}

async function _azureComplete({ system, user, maxTokens, s }) {
  const client = _azureClient(s);
  const res = await client.chat.completions.create({
    model: s.model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return { text: res.choices[0].message.content.trim() };
}

// ── Gemini ────────────────────────────────────────────────────────────────────
//
// v0.32.8 — free-tier model cascade. The Gemini API exposes multiple models,
// each with INDEPENDENT free-tier RPD quotas per project:
//
//   gemini-2.5-flash       — 250 RPD,  highest quality, 5 RPM / 250k TPM
//   gemini-2.5-flash-lite  — 1000 RPD, cheaper variant of 2.5
//   gemini-1.5-flash       — 1500 RPD, legacy generation but still maintained
//
// Combined: ~2750 RPD across all three on a single free-tier project, vs
// 250 RPD if we only used 2.5-flash. When the primary model returns 429
// RESOURCE_EXHAUSTED, this cascade falls through to the next-best in
// priority order until one succeeds.
//
// The cascade order is configurable via GEMINI_MODEL_CASCADE (comma-
// separated env var). When unset, the default puts quality first, then
// quantity. The configured primary model (s.model — usually from
// AI_MODEL_OVERRIDE or AI_MODEL env) is forced to the head of the cascade
// so an operator who pinned a specific model still gets it as the first
// attempt.
//
// Errors other than 429 / quota exhaustion (auth, bad input, network)
// surface immediately without cascading — we don't waste calls on other
// models when the request is structurally broken.

const DEFAULT_GEMINI_CASCADE = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];

function _resolveGeminiCascade(primaryModel) {
  const raw = (process.env.GEMINI_MODEL_CASCADE || DEFAULT_GEMINI_CASCADE.join(','))
    .split(',').map(x => x.trim()).filter(Boolean);
  const ordered = [primaryModel, ...raw.filter(m => m !== primaryModel)];
  const seen = new Set();
  return ordered.filter(m => !seen.has(m) && seen.add(m));
}

function _isGeminiQuotaError(err) {
  const msg = err?.message || String(err);
  return /\b429\b|RESOURCE_EXHAUSTED|quota exceeded|rate.?limit/i.test(msg);
}

async function _geminiComplete({ system, user, maxTokens, s }) {
  let GoogleGenerativeAI;
  try { ({ GoogleGenerativeAI } = require('@google/generative-ai')); } catch {
    throw new Error('[ai] @google/generative-ai not installed. Run: npm install @google/generative-ai');
  }
  const genai = new GoogleGenerativeAI(s.apiKey);

  const cascade = _resolveGeminiCascade(s.model);
  let lastError = null;
  for (let i = 0; i < cascade.length; i++) {
    const modelName = cascade[i];
    try {
      const m = genai.getGenerativeModel({ model: modelName, systemInstruction: system });
      const result = await m.generateContent({
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      });
      if (i > 0) {
        console.log(`[ai][gemini] cascaded ${cascade[0]} → ${modelName} after ${i} quota-exhausted hop(s)`);
      }
      return { text: result.response.text().trim() };
    } catch (err) {
      if (_isGeminiQuotaError(err)) {
        console.warn(`[ai][gemini] ${modelName} returned 429 / quota-exhausted; trying next model in cascade`);
        lastError = err;
        continue;
      }
      throw err;  // non-quota error — surface immediately
    }
  }
  throw lastError || new Error('[ai][gemini] all cascade models exhausted their free-tier quotas for today');
}

async function _geminiImage({ imageBuffer, mediaType, prompt, maxTokens, s }) {
  let GoogleGenerativeAI;
  try { ({ GoogleGenerativeAI } = require('@google/generative-ai')); } catch {
    throw new Error('[ai] @google/generative-ai not installed. Run: npm install @google/generative-ai');
  }
  const genai = new GoogleGenerativeAI(s.apiKey);

  const cascade = _resolveGeminiCascade(s.model);
  let lastError = null;
  for (let i = 0; i < cascade.length; i++) {
    const modelName = cascade[i];
    try {
      const m = genai.getGenerativeModel({ model: modelName });
      const result = await m.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: mediaType, data: imageBuffer.toString('base64') } },
            { text: prompt },
          ],
        }],
        generationConfig: { maxOutputTokens: maxTokens },
      });
      if (i > 0) {
        console.log(`[ai][gemini] image cascade ${cascade[0]} → ${modelName} after ${i} quota-exhausted hop(s)`);
      }
      return { text: result.response.text().trim() };
    } catch (err) {
      if (_isGeminiQuotaError(err)) {
        console.warn(`[ai][gemini] image: ${modelName} returned 429 / quota-exhausted; trying next model in cascade`);
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('[ai][gemini] all cascade image models exhausted their free-tier quotas for today');
}

module.exports = { complete, completeWithImage, parseJSON };

export {};
