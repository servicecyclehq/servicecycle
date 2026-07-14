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
  // Provider-aware key resolution: read the conventionally-named env var for the
  // active provider first (so a key set as GEMINI_API_KEY / GROQ_API_KEY / etc.
  // is actually used), then fall back to the generic AI_API_KEY / ANTHROPIC_API_KEY.
  const PROVIDER_KEY_ENV: any = {
    gemini:       process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    groq:         process.env.GROQ_API_KEY,
    openai:       process.env.OPENAI_API_KEY,
    anthropic:    process.env.ANTHROPIC_API_KEY,
    azure_openai: process.env.AZURE_OPENAI_API_KEY,
  };
  const apiKey = settings.apiKey || PROVIDER_KEY_ENV[provider] || process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY;

  const DEFAULT_MODELS = {
    cloudflare:   undefined, // resolved per-task by cloudflare.js
    anthropic:    'claude-haiku-4-5',
    openai:       'gpt-4o-mini',
    azure_openai: settings.azureDeployment || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
    gemini:       'gemini-2.5-flash',
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

async function complete({ system, user, maxTokens = 4096, settings = {}, cacheSystem = false, task = null, responseMimeType = null }) {
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
  } else if (s.provider === 'groq') {
    // First-class Groq text provider — lets callers force settings.provider='groq'
    // as an explicit fallback. Groq reads GROQ_API_KEY itself and ignores a
    // foreign model id, so passing the primary's resolved settings is safe.
    result = await groqProvider.complete({ system, user, maxTokens, task, settings: s });
  } else if (s.provider === 'gemini') {
    // Cross-provider TEXT fallback (Gemini → Groq), mirroring completeWithImage.
    // _geminiComplete cascades across Gemini's OWN models first; if the WHOLE
    // free-tier family is quota-exhausted OR every model is 503 "experiencing
    // high demand" (2026-07-14 -- Google-side overload, not a quota issue) it
    // throws — at which point we fall to Groq so the gap-fill keeps working on
    // a second provider's free tier instead of failing the extraction. A
    // structural error (auth, bad request) still surfaces. Configurable via
    // AI_TEXT_FALLBACK.
    try {
      result = await _geminiComplete({ system, user, maxTokens, s, responseMimeType });
    } catch (err: any) {
      const exhausted = _isGeminiQuotaError(err) || _isGeminiOverloadedError(err) || /exhausted their free-tier/i.test(err?.message || '');
      const fb = (process.env.AI_TEXT_FALLBACK || 'groq').toLowerCase();
      if (exhausted && fb === 'groq' && process.env.GROQ_API_KEY) {
        console.warn(`[ai] gemini text ${_isGeminiOverloadedError(err) ? 'overloaded' : 'quota exhausted'} → falling back to groq text`);
        result = await groqProvider.complete({ system, user, maxTokens, task, settings: s });
      } else {
        throw err;
      }
    }
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

async function completeWithImage({ imageBuffer, mediaType = 'image/jpeg', prompt, maxTokens = 4096, settings = {}, responseMimeType }) {
  const s = resolveSettings(settings);

  let visionProvider = s.provider;
  if (visionProvider === 'cloudflare') {
    visionProvider = (process.env.AI_VISION_PROVIDER || 'anthropic').toLowerCase();
  }

  if (visionProvider === 'anthropic') {
    // COMP-8-10: Cloudflare Workers AI has no unified vision path for the
    // text models ServiceCycle uses, so image calls detour to Anthropic by
    // default — which requires ANTHROPIC_API_KEY *in addition to* the CF
    // credentials. If an operator configured only Cloudflare, every nameplate
    // / photo scan would otherwise throw a confusing SDK error deep in the
    // call. Detect the missing key up front and surface a clear, handled
    // setup error (callers can map AI_VISION_NOT_CONFIGURED to a 503 with
    // guidance) rather than a silent failure.
    const ak = process.env.ANTHROPIC_API_KEY || (s.provider !== 'cloudflare' ? s.apiKey : undefined);
    if (!ak) {
      const err: any = new Error(
        '[ai] Image analysis is not configured: AI_PROVIDER=cloudflare routes vision to Anthropic '
        + '(AI_VISION_PROVIDER), but ANTHROPIC_API_KEY is not set. Set ANTHROPIC_API_KEY, or set '
        + 'AI_VISION_PROVIDER=gemini (+ a Gemini key) / =groq (+ GROQ_API_KEY) for a vision provider '
        + 'that does not depend on Anthropic.',
      );
      err.code = 'AI_VISION_NOT_CONFIGURED';
      err.statusHint = 503;
      throw err;
    }
    return _anthropicImage({ imageBuffer, mediaType, prompt, maxTokens, s: Object.assign({}, s, { apiKey: ak }) });
  } else if (visionProvider === 'openai' || visionProvider === 'azure_openai') {
    return _openaiImage({ imageBuffer, prompt, maxTokens, azure: visionProvider === 'azure_openai', s });
  } else if (visionProvider === 'gemini') {
    // Cross-provider vision fallback (Gemini → Groq). When Gemini's free daily
    // quota is exhausted across the WHOLE model cascade, OR every model is 503
    // "experiencing high demand" (2026-07-14 -- Google-side overload, a real
    // production error, not a quota issue), fall to Groq's vision model so
    // nameplate/photo reads keep working on a second provider's free tier. A
    // structural error (bad image, auth) still surfaces immediately.
    // Configurable via AI_VISION_FALLBACK (default groq).
    try {
      return await _geminiImage({ imageBuffer, mediaType, prompt, maxTokens, s, responseMimeType });
    } catch (err: any) {
      const exhausted = _isGeminiQuotaError(err) || _isGeminiOverloadedError(err) || /exhausted their free-tier/i.test(err?.message || '');
      const fb = (process.env.AI_VISION_FALLBACK || 'groq').toLowerCase();
      if (exhausted && fb === 'groq' && process.env.GROQ_API_KEY) {
        console.warn(`[ai] gemini vision ${_isGeminiOverloadedError(err) ? 'overloaded' : 'quota exhausted'} → falling back to groq vision`);
        return await _groqImage({ imageBuffer, mediaType, prompt, maxTokens, s });
      }
      throw err;
    }
  } else if (visionProvider === 'groq') {
    return _groqImage({ imageBuffer, mediaType, prompt, maxTokens, s });
  } else {
    throw new Error(`[ai] Provider "${visionProvider}" does not support image input`);
  }
}

// ── Native-PDF completion (W1) ────────────────────────────────────────────────
// [W1 native-PDF ingestion, 2026-07-14] Send the PDF FILE ITSELF to a model that
// reads PDFs natively — Gemini reads text + layout + scanned page images in ONE
// call at ~258 tokens/page (up to ~1000 pages) — instead of the old lossy
// pre-extraction (24k-char text clip) or capped rasterization (4-page vision
// cap). Only providers with a native document part are supported (Gemini,
// Anthropic). A caller MUST treat a throw as "fall back to the deterministic
// text/vision path": there is no same-shape second provider for native PDF
// (Groq/HF vision read images, not documents), so this never silently degrades
// provider — it surfaces, and extractArcFlashDocument owns the fallback. Inline
// base64 only, gated to MAX_INLINE_PDF_BYTES; a larger file throws
// AI_NATIVE_PDF_TOO_LARGE so the caller chunks (structural boundaries) or falls
// back rather than sending a request past the provider's inline ceiling.
async function completeWithPdf({ pdfBuffer, system, user, maxTokens = 8192, settings = {}, responseMimeType = null }) {
  if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.length) {
    const err: any = new Error('[ai] completeWithPdf: empty or invalid pdfBuffer');
    err.code = 'AI_NATIVE_PDF_UNSUPPORTED';
    throw err;
  }
  if (pdfBuffer.length > MAX_INLINE_PDF_BYTES) {
    const err: any = new Error(
      `[ai] completeWithPdf: PDF ${(pdfBuffer.length / 1048576).toFixed(1)}MB exceeds the `
      + `${Math.floor(MAX_INLINE_PDF_BYTES / 1048576)}MB inline limit — caller should chunk or fall back`,
    );
    err.code = 'AI_NATIVE_PDF_TOO_LARGE';
    throw err;
  }
  const s = resolveSettings(settings);

  // cloudflare has no native-PDF path; honor an explicit doc-provider detour
  // (mirrors AI_VISION_PROVIDER for the vision path).
  let docProvider = s.provider;
  if (docProvider === 'cloudflare') {
    docProvider = (process.env.AI_DOC_PROVIDER || process.env.AI_VISION_PROVIDER || 'gemini').toLowerCase();
  }

  let result: any;
  if (docProvider === 'gemini') {
    result = await _geminiPdf({ pdfBuffer, system, user, maxTokens, s, responseMimeType });
  } else if (docProvider === 'anthropic') {
    result = await _anthropicPdf({ pdfBuffer, system, user, maxTokens, s });
  } else {
    const err: any = new Error(
      `[ai] Provider "${docProvider}" has no native-PDF path — caller should fall back to text/vision`,
    );
    err.code = 'AI_NATIVE_PDF_UNSUPPORTED';
    throw err;
  }

  // F-AI-LEAK: same output guard the text path applies in complete().
  if (result && typeof result.text === 'string') {
    result.text = scrubPromptLeak(result.text, 'task=extract');
  }
  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// COMP-8-11: provider completions are not guaranteed to put a text string in
// content[0]. Anthropic can return a non-text first block (a refusal carries a
// `stop_reason`, a tool-use block, or — on a safety stop — an empty content
// array); the OpenAI/Azure shape can carry a null `content` (e.g. a refusal /
// length stop with no text). Reaching straight for `.content[0].text.trim()`
// or `.message.content.trim()` then throws a raw TypeError that surfaces to the
// user as a 500 instead of a handled "couldn't read that". These helpers find
// the first text block (or empty string) and raise a clear, catchable error
// when the model genuinely returned no text.
function _anthropicText(msg: any, providerLabel = 'anthropic'): string {
  const blocks = Array.isArray(msg?.content) ? msg.content : [];
  const textBlock = blocks.find((b: any) => b && b.type === 'text' && typeof b.text === 'string');
  if (textBlock) return textBlock.text.trim();
  const reason = msg?.stop_reason ? ` (stop_reason=${msg.stop_reason})` : '';
  throw new Error(`[ai] ${providerLabel} returned no text content${reason} — the model may have refused or hit a safety stop.`);
}

function _openaiText(res: any, providerLabel = 'openai'): string {
  const content = res?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.length > 0) return content.trim();
  // Some responses (refusal / length-stop) carry an explicit refusal string or
  // an array of content parts rather than a plain string.
  const refusal = res?.choices?.[0]?.message?.refusal;
  if (typeof refusal === 'string' && refusal.length > 0) {
    throw new Error(`[ai] ${providerLabel} refused the request: ${refusal.slice(0, 200)}`);
  }
  if (Array.isArray(content)) {
    const part = content.find((p: any) => typeof p?.text === 'string' && p.text.length > 0);
    if (part) return part.text.trim();
  }
  const finish = res?.choices?.[0]?.finish_reason ? ` (finish_reason=${res.choices[0].finish_reason})` : '';
  throw new Error(`[ai] ${providerLabel} returned no text content${finish} — the model may have refused or returned an empty completion.`);
}

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
  return { text: _anthropicText(msg) };
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
  // model returned so callers (telemetry, distinguishing Gemini vs Groq reads)
  // can log the actual model used — hardcoded engine labels hide provider
  // differences and prevent per-provider accuracy comparison.
  return { text: _anthropicText(msg), model: s.model };
}

// [2026-07-08 acquisition audit W2-AI] Anthropic/Cloudflare/Groq call paths
// already bound their network calls (see the Anthropic client's `timeout:
// 60_000` below, S3-FN-02); the Gemini and OpenAI/Azure SDK paths did not, so
// a hung socket on either wedged the single in-process ingest worker
// indefinitely (the heartbeat can detect it, not survive it). Match
// Anthropic's existing 60s bound on every provider call below via each SDK's
// own requestOptions.timeout rather than hand-rolling a Promise.race, since
// both SDKs expose one.
const PROVIDER_TIMEOUT_MS = 60_000; // 60s — same bound as the Anthropic client

// [W1 native-PDF, 2026-07-14] Native-PDF extraction bounds. A large multi-page
// study read natively can legitimately take minutes, so the PDF call gets a
// longer timeout than the 60s vision/text bound — it runs in the async ingest
// worker, never a request handler. Inline base64 is capped under the provider's
// ~20MB request ceiling; larger PDFs must be chunked or fall back.
const PDF_TIMEOUT_MS = Number(process.env.AI_PDF_TIMEOUT_MS) || 180_000; // 3 min
const MAX_INLINE_PDF_BYTES = 18 * 1024 * 1024; // ~18MB, under Gemini's ~20MB inline limit

// ── OpenAI ────────────────────────────────────────────────────────────────────

function _openaiClient(s) {
  let OpenAI;
  try { OpenAI = require('openai').default || require('openai'); } catch {
    throw new Error('[ai] openai package not installed. Run: npm install openai');
  }
  return new OpenAI({ apiKey: s.apiKey, timeout: PROVIDER_TIMEOUT_MS, maxRetries: 1 });
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
  return { text: _openaiText(res) };
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
  return { text: _openaiText(res, azure ? 'azure_openai' : 'openai'), model: s.model };
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
    timeout:        PROVIDER_TIMEOUT_MS,
    maxRetries:     1,
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
  return { text: _openaiText(res, 'azure_openai') };
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

// 2026-07-03 verified against https://ai.google.dev/gemini-api/docs/models (last
// updated 2026-06-30): gemini-2.0-flash and gemini-2.0-flash-lite are both
// SHUT DOWN. Prior comment left the retired ids in the cascade, which would
// throw immediately mid-cascade (404 is not a quota error) — re-introducing
// exactly the silent-failure bug the 1.5-flash retirement caused.
// Fixed: cascade to live 2.5 buckets + two self-healing `*-latest` aliases.
// Live 2.5 models carry INDEPENDENT free-tier daily (RPD) buckets — cascading
// across the two multiplies daily headroom. The `-latest` aliases always
// resolve to a currently-live model, so this cascade can never hard-fail the
// way it did before; at worst the aliases re-hit an already-exhausted bucket.
// Also see _isGeminiCascadeError below: 404 model-not-found is now treated as
// a cascade signal too, so a future model retirement degrades to the next hop
// instead of throwing.
// NOTE: free buckets are small; a true bulk-ingest need is solved by a
// customer's own key (BYO-AI, Settings) or a paid tier, not by adding more
// free models here. Verify ids via ListModels before editing.
const DEFAULT_GEMINI_CASCADE = [
  'gemini-2.5-flash', 'gemini-2.5-flash-lite',
  'gemini-flash-latest', 'gemini-flash-lite-latest',
];

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

// 2026-07-14: Gemini's own infra returns 503 "This model is currently
// experiencing high demand" during capacity spikes -- a real, observed
// production error (hit live during an ingestion run: "[503 Service
// Unavailable] This model is currently experiencing high demand"). Unlike a
// quota exhaustion (429) or a retired model (404), this is GOOGLE'S servers
// being overloaded -- transient, model-specific, and not the caller's fault.
// Treated the same as the other two cascade triggers below: try the next
// Gemini model first (a demand spike on gemini-2.5-flash doesn't necessarily
// hit flash-lite or the -latest aliases -- separate capacity pools), and if
// EVERY model in the Gemini cascade is overloaded, fall through to Groq same
// as a real quota exhaustion (see the `complete()` / `completeWithImage()`
// gemini branches below).
function _isGeminiOverloadedError(err) {
  const msg = err?.message || String(err);
  return /\[?503\b|Service Unavailable|\bUNAVAILABLE\b|overloaded|experiencing high demand/i.test(msg);
}

// A model that gets retired by Google returns 404 NOT_FOUND from
// generateContent, which is NOT a quota error. Left untreated, that throws
// mid-cascade (the exact 1.5-flash retirement bug). Treat 404 / model-not-found
// as a "try the next hop" signal so an unnoticed retirement degrades instead
// of hard-failing. Any other non-quota error still surfaces immediately
// (auth, bad input, network — cascading those wastes calls).
function _isGeminiCascadeError(err) {
  if (_isGeminiQuotaError(err) || _isGeminiOverloadedError(err)) return true;
  const msg = err?.message || String(err);
  // [2026-07-05 review fix] The bare `not.?found` alternative was broad
  // enough to match ANY error whose message happened to contain "not found"
  // (e.g. an unrelated "Asset not found" / filesystem error bubbling up
  // through the same try/catch) -- that would silently cascade to the next
  // model and mask a real, unrelated bug behind a generic "all cascade
  // models exhausted" error instead of surfacing it. Real Gemini model-
  // retirement 404s always say "models/<name> is not found for API version"
  // or "is not supported for generateContent" -- require the "not found"
  // phrase to specifically be about a model, which keeps the real
  // retirement signal without the false-cascade risk.
  return /\b404\b|NOT_FOUND|models?\/\S+ is not found|is not supported for generateContent|no longer supported|deprecated/i.test(msg);
}

async function _geminiComplete({ system, user, maxTokens, s, responseMimeType = null }) {
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
      // [2026-07-08 acquisition audit W2-AI] requestOptions.timeout bounds the
      // underlying fetch — see PROVIDER_TIMEOUT_MS comment above.
      const m = genai.getGenerativeModel({ model: modelName, systemInstruction: system }, { timeout: PROVIDER_TIMEOUT_MS });
      const result = await m.generateContent({
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          // 2026-07-14: same fix as _geminiImage below -- Gemini 2.5 Flash is a
          // THINKING model whose internal reasoning bills against maxOutputTokens.
          // Without JSON mode, a verbose extraction schema (e.g. a multi-bus
          // arc-flash study) can have its output truncated mid-JSON because
          // reasoning ate most of the token budget before any content was
          // written (root-caused via a direct-call repro against a real
          // 13-bus report: 8144 raw chars cut off mid-string, well short of
          // where a naturally-ending JSON body would stop). Callers opt in by
          // passing responseMimeType; providers other than Gemini ignore it.
          ...(responseMimeType ? { responseMimeType } : {}),
        },
      });
      if (i > 0) {
        console.log(`[ai][gemini] cascaded ${cascade[0]} → ${modelName} after ${i} quota-exhausted hop(s)`);
      }
      return { text: result.response.text().trim() };
    } catch (err) {
      if (_isGeminiCascadeError(err)) {
        console.warn(`[ai][gemini] ${modelName} unavailable (${(err && err.message) || err}); trying next model in cascade`);
        lastError = err;
        continue;
      }
      throw err;  // real error (auth, bad input, network) — surface immediately
    }
  }
  throw lastError || new Error('[ai][gemini] all cascade models exhausted their free-tier quotas for today');
}

async function _geminiImage({ imageBuffer, mediaType, prompt, maxTokens, s, responseMimeType }) {
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
      // [2026-07-08 acquisition audit W2-AI] requestOptions.timeout bounds the
      // underlying fetch — see PROVIDER_TIMEOUT_MS comment above.
      const m = genai.getGenerativeModel({ model: modelName }, { timeout: PROVIDER_TIMEOUT_MS });
      const result = await m.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: mediaType, data: imageBuffer.toString('base64') } },
            { text: prompt },
          ],
        }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          // JSON mode (opt-in per caller). Gemini 2.5 Flash is a THINKING model
          // whose reasoning tokens bill against maxOutputTokens; without a
          // forced mimetype it also wraps/fences output. responseMimeType makes
          // the model emit a single valid, escaped JSON object — the caller is
          // still responsible for a generous maxTokens so thinking + JSON fit.
          ...(responseMimeType ? { responseMimeType } : {}),
        },
      });
      if (i > 0) {
        console.log(`[ai][gemini] image cascade ${cascade[0]} → ${modelName} after ${i} quota-exhausted hop(s)`);
      }
      return { text: result.response.text().trim(), model: modelName };
    } catch (err) {
      if (_isGeminiCascadeError(err)) {
        console.warn(`[ai][gemini] image: ${modelName} unavailable (${(err && err.message) || err}); trying next model in cascade`);
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('[ai][gemini] all cascade image models exhausted their free-tier quotas for today');
}

// [W1 native-PDF, 2026-07-14] Native-PDF extraction on Gemini. Mirrors
// _geminiImage's cascade + timeout, but sends an application/pdf inlineData part
// so the model reads the whole document (text layer, layout, AND any scanned
// page images) in one call instead of us pre-extracting or rasterizing. Uses
// PDF_TIMEOUT_MS (longer than the 60s vision bound) because a large multi-page
// study legitimately takes minutes — this runs in the async ingest worker, not
// a request handler, so the longer bound is safe.
async function _geminiPdf({ pdfBuffer, system, user, maxTokens, s, responseMimeType = null }) {
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
      const m = genai.getGenerativeModel({ model: modelName, systemInstruction: system }, { timeout: PDF_TIMEOUT_MS });
      const result = await m.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } },
            { text: user },
          ],
        }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          // JSON mode (opt-in): 2.5 Flash is a thinking model whose reasoning
          // bills against maxOutputTokens — same rationale as _geminiComplete /
          // _geminiImage. Callers pass responseMimeType:'application/json'.
          ...(responseMimeType ? { responseMimeType } : {}),
        },
      });
      if (i > 0) {
        console.log(`[ai][gemini] pdf cascade ${cascade[0]} → ${modelName} after ${i} unavailable hop(s)`);
      }
      return { text: result.response.text().trim(), model: modelName };
    } catch (err) {
      if (_isGeminiCascadeError(err)) {
        console.warn(`[ai][gemini] pdf: ${modelName} unavailable (${(err && err.message) || err}); trying next model in cascade`);
        lastError = err;
        continue;
      }
      throw err;  // real error (auth, bad input, network) — surface immediately
    }
  }
  throw lastError || new Error('[ai][gemini] all cascade models exhausted their free-tier quotas for native-PDF extraction');
}

// [W1 native-PDF, 2026-07-14] Native-PDF extraction on Anthropic (self-host
// operators on AI_PROVIDER=anthropic). Claude reads a base64 application/pdf
// `document` content block directly. Same 3-min bound as the Gemini path.
async function _anthropicPdf({ pdfBuffer, system, user, maxTokens, s }) {
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); } catch {
    throw new Error('[ai] @anthropic-ai/sdk not installed. Run: npm install @anthropic-ai/sdk');
  }
  const client = new Anthropic({ apiKey: s.apiKey, timeout: PDF_TIMEOUT_MS, maxRetries: 1 });
  const msg = await client.messages.create({
    model: s.model,
    max_tokens: maxTokens,
    system,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { type: 'text', text: user },
      ],
    }],
  });
  return { text: _anthropicText(msg), model: s.model };
}

// ── Groq vision (cross-provider fallback) ─────────────────────────────────────
// Groq's OpenAI-compatible chat endpoint with a multimodal vision model. Used
// as the second free tier behind Gemini for image reads (nameplate OCR). The
// existing aiProviders/groq.js is text-only and refuses task=extract, so the
// image path lives here. Model is env-configurable; default verified present on
// the account via ListModels.
// NOTE: llama-4-scout-17b-16e-instruct deprecated 2026-06-24, decommissioned
// 2026-07-17. Replacement: qwen/qwen3.6-27b (vision-capable, 20 MB file limit,
// same speed tier). Set GROQ_VISION_MODEL env var to override.
async function _groqImage({ imageBuffer, mediaType = 'image/jpeg', prompt, maxTokens = 1024, s }) {
  const axios = require('axios');
  const apiKey = process.env.GROQ_API_KEY || (s && s.apiKey);
  if (!apiKey) throw new Error('[ai][groq] GROQ_API_KEY is not set — cannot use Groq vision fallback');
  const model = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';
  const dataUrl = `data:${mediaType || 'image/jpeg'};base64,${imageBuffer.toString('base64')}`;
  const res = await axios.post(
    `${process.env.GROQ_API_BASE || 'https://api.groq.com/openai/v1'}/chat/completions`,
    {
      model,
      max_tokens: maxTokens,
      // JSON mode — forces syntactically valid JSON. The smaller Llama-4 model
      // otherwise emits malformed JSON on the nested {value,confidence} schema.
      // Requires the literal word "json" in the prompt (the OCR prompt has it).
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
    },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30_000, validateStatus: () => true },
  );
  if (res.status >= 400) {
    const detail = typeof res.data === 'string' ? res.data.slice(0, 200) : JSON.stringify(res.data || {}).slice(0, 200);
    throw new Error(`[ai][groq] vision ${res.status}: ${detail}`);
  }
  const text = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content;
  return { text: String(text || '').trim(), model };
}

module.exports = { complete, completeWithImage, completeWithPdf, parseJSON };

export {};
