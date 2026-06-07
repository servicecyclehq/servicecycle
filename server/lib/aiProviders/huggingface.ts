/**
 * aiProviders/huggingface.js — HuggingFace Inference fallback (v0.35.0)
 *
 * Fallback #1 for chat (Ask LapseIQ) and news classification when
 * Cloudflare Workers AI returns 429 / 5xx / timeout. NOT used for
 * contract extraction or renewal briefs — those tasks are
 * Cloudflare-only because Mistral Small 24B is the quality bar and
 * Llama-8B-class fallback would degrade extraction accuracy too much.
 *
 * Wire model:
 *   - OpenAI-compatible chat completions at
 *     `https://api-inference.huggingface.co/v1/chat/completions`
 *   - Default model: meta-llama/Llama-3.1-8B-Instruct (matches the
 *     Cloudflare primary so cascade is invisible to the user)
 *   - axios (already a dep) — no new npm packages
 *
 * Errors are classified the same way as cloudflare.js so the cascade
 * layer can decide whether to keep cascading (QuotaError/ServerError/
 * TimeoutError) or fail fast (ClientError).
 *
 * v0.36.7 hot patch (Pass-6 W2 MT-012):
 *   Wire budgetGuard.checkAndConsume('huggingface') BEFORE the axios POST
 *   so an exhausted HF day throws QuotaError (cascade: true) and the
 *   cascade in ai.js falls through to Groq. Pre-fix, the DAILY_SERVICES
 *   registry declared `huggingface: 1000/day` but nothing enforced it —
 *   the gate was metadata-only. Pass-6/Lens-5 F-DEMO-NEW-01 modelled the
 *   exploit at "single afternoon to exhaust HF free tier from the demo"
 *   via the cascade trigger.
 *
 * Self-host operators set:
 *   HF_TOKEN=hf_...
 */

'use strict';

const axios = require('axios');
const budgetGuard = require('../aiBudgetGuard');

const HF_BASE = process.env.HF_API_BASE || 'https://api-inference.huggingface.co/v1';

const DEFAULT_MODEL = process.env.HF_MODEL || 'meta-llama/Llama-3.1-8B-Instruct';

class QuotaError   extends Error { cascade: boolean; constructor(msg) { super(msg); this.name = 'QuotaError';   this.cascade = true; } }
class ServerError  extends Error { cascade: boolean; constructor(msg) { super(msg); this.name = 'ServerError';  this.cascade = true; } }
class ClientError  extends Error { cascade: boolean; constructor(msg) { super(msg); this.name = 'ClientError';  this.cascade = false; } }
class TimeoutError extends Error { cascade: boolean; constructor(msg) { super(msg); this.name = 'TimeoutError'; this.cascade = true; } }

function _resolveCredentials(s) {
  // v0.35.3 bugfix (same as cloudflare.js): HF_TOKEN must be preferred over
  // s.apiKey. ai.js's resolveSettings populates s.apiKey from
  // process.env.AI_API_KEY which may be a placeholder string in the demo
  // configuration, leading to "Authentication error" on the HF endpoint
  // when the cascade fires. Honor HF-specific env vars first.
  const apiKey = process.env.HF_TOKEN
    || process.env.HUGGINGFACE_API_KEY
    || (s.apiKey && s.apiKey !== process.env.AI_API_KEY ? s.apiKey : null)
    || s.apiKey;
  if (!apiKey) throw new ClientError('[huggingface] HF_TOKEN is required when HF fallback is in the cascade');
  return { apiKey };
}

function _classifyAxiosError(err) {
  if (err && (err.code === 'ECONNABORTED' || /timeout/i.test(err.message))) {
    return new TimeoutError(`[huggingface] request timed out: ${err.message}`);
  }
  if (err && err.response && typeof err.response.status === 'number') {
    const status = err.response.status;
    const body   = err.response.data;
    const detail = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body || {}).slice(0, 300);
    if (status === 429) return new QuotaError(`[huggingface] 429 rate-limited: ${detail}`);
    if (status === 503) return new ServerError(`[huggingface] 503 model loading: ${detail}`);
    if (status >= 500)  return new ServerError(`[huggingface] ${status} server error: ${detail}`);
    return new ClientError(`[huggingface] ${status} client error: ${detail}`);
  }
  return new TimeoutError(`[huggingface] network error: ${err && err.message ? err.message : String(err)}`);
}

async function complete({ system, user, maxTokens = 1024, task, settings = {} }: any) {
  // Only chat + classification cascade through HF. Refuse the call if
  // someone wires an extraction/brief task into the fallback chain by
  // accident — the contract says CF-only for those.
  if (task && (task === 'extract' || task === 'brief')) {
    throw new ClientError('[huggingface] cascade not permitted for task=' + task + ' (Cloudflare-only per spec)');
  }

  // v0.36.7 (Pass-6 W2 MT-012a): consume the per-UTC-day HF budget at the
  // gate. Throws QuotaError when the daily quota is exhausted; QuotaError
  // carries cascade=true so ai.js falls through to Groq. No-op on
  // self-host installs (DEMO_MODE !== 'true').
  const gate = budgetGuard.checkAndConsume('huggingface');
  if (!gate.ok) {
    throw new QuotaError(
      `[huggingface] daily budget exhausted (${gate.callsToday}/${gate.budget} for today) — cascading to next provider`
    );
  }

  const { apiKey } = _resolveCredentials(settings);
  // Cascade safety (v0.92.22): ignore a foreign primary-provider model id
  // (DEMO_MODE pins claude-haiku-*, or a Cloudflare @cf/ id) and use HF's default.
  let model = settings.model || process.env.HF_MODEL || DEFAULT_MODEL;
  if (/^(claude|gpt|gemini|o1|o3|text-|dall)/i.test(model) || model.includes('@cf/')) {
    model = process.env.HF_MODEL || DEFAULT_MODEL;
  }

  const url = `${HF_BASE}/chat/completions`;
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: typeof system === 'string' ? system : '' },
      { role: 'user',   content: typeof user   === 'string' ? user   : '' },
    ],
  };

  let res;
  try {
    res = await axios.post(url, body, {
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
      validateStatus: () => true,
    });
  } catch (err) {
    throw _classifyAxiosError(err);
  }

  if (res.status >= 400) {
    throw _classifyAxiosError({ response: res });
  }

  const data   = res.data || {};
  const choice = Array.isArray(data.choices) && data.choices[0];
  const text   = (choice && choice.message && choice.message.content) || '';

  return { text: String(text).trim(), model };
}

module.exports = {
  complete,
  QuotaError,
  ServerError,
  ClientError,
  TimeoutError,
};

export {};
