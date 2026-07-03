/**
 * aiProviders/groq.js — Groq Cloud fallback (v0.35.0)
 *
 * Fallback #2 for chat (Ask ServiceCycle) and news classification when both
 * Cloudflare Workers AI and HuggingFace return 429 / 5xx / timeout.
 * NOT used for contract extraction or renewal briefs — those tasks are
 * Cloudflare-only per the v0.35.0 spec.
 *
 * Wire model:
 *   - OpenAI-compatible chat completions at
 *     `https://api.groq.com/openai/v1/chat/completions`
 *   - Default model: openai/gpt-oss-20b (v0.92.x: was llama-3.1-8b-instant,
 *     which Groq deprecated 2026-06-17 with an 08/16/26 shutdown date —
 *     see console.groq.com/docs/deprecations. gpt-oss-20b is Groq's
 *     recommended replacement. This is no longer the exact same model
 *     family as the CF/HF primaries, so cascade behavior may be very
 *     slightly more visible to the user on the rare Groq-fallback path.)
 *   - axios (already a dep) — no new npm packages
 *
 * NOTE on Groq's free tier: per Groq's Community FAQ, the free tier is
 * positioned as dev/prototyping and does not authorise production
 * traffic. The demo defaults to free tier ONLY as a fallback-of-last-
 * resort; for self-host customers using Groq as primary, set
 * GROQ_API_KEY to a paid-tier key. The cascade itself doesn't
 * distinguish — same env var either way.
 *
 * v0.36.7 hot patch (Pass-6 W2 MT-012):
 *   Wire budgetGuard.checkAndConsume('groq') BEFORE the axios POST so an
 *   exhausted Groq day throws QuotaError. Because Groq is the last hop
 *   in the cascade (cloudflare -> huggingface -> groq), an exhausted
 *   Groq quota means the cascade is fully drained and ai.js bubbles the
 *   QuotaError to the route handler, which translates to a 503
 *   "AI temporarily unavailable" response. Cf. F-DEMO-NEW-01.
 *
 * Self-host operators set:
 *   GROQ_API_KEY=gsk_...
 */

'use strict';

const axios = require('axios');
const budgetGuard = require('../aiBudgetGuard');

const GROQ_BASE = process.env.GROQ_API_BASE || 'https://api.groq.com/openai/v1';

const DEFAULT_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

class QuotaError   extends Error { cascade: boolean; constructor(msg) { super(msg); this.name = 'QuotaError';   this.cascade = true; } }
class ServerError  extends Error { cascade: boolean; constructor(msg) { super(msg); this.name = 'ServerError';  this.cascade = true; } }
class ClientError  extends Error { cascade: boolean; constructor(msg) { super(msg); this.name = 'ClientError';  this.cascade = false; } }
class TimeoutError extends Error { cascade: boolean; constructor(msg) { super(msg); this.name = 'TimeoutError'; this.cascade = true; } }

function _resolveCredentials(s) {
  // v0.35.3 bugfix (same as cloudflare.js): GROQ_API_KEY must be preferred
  // over s.apiKey. See cloudflare.js comment for rationale.
  const apiKey = process.env.GROQ_API_KEY
    || (s.apiKey && s.apiKey !== process.env.AI_API_KEY ? s.apiKey : null)
    || s.apiKey;
  if (!apiKey) throw new ClientError('[groq] GROQ_API_KEY is required when Groq fallback is in the cascade');
  return { apiKey };
}

function _classifyAxiosError(err) {
  if (err && (err.code === 'ECONNABORTED' || /timeout/i.test(err.message))) {
    return new TimeoutError(`[groq] request timed out: ${err.message}`);
  }
  if (err && err.response && typeof err.response.status === 'number') {
    const status = err.response.status;
    const body   = err.response.data;
    const detail = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body || {}).slice(0, 300);
    if (status === 429) return new QuotaError(`[groq] 429 rate-limited: ${detail}`);
    if (status >= 500)  return new ServerError(`[groq] ${status} server error: ${detail}`);
    return new ClientError(`[groq] ${status} client error: ${detail}`);
  }
  return new TimeoutError(`[groq] network error: ${err && err.message ? err.message : String(err)}`);
}

async function complete({ system, user, maxTokens = 1024, task, settings = {} }: any) {
  // NOTE: the old v0.35.0 "extract is Cloudflare-only" guard was removed in
  // ServiceCycle — test-report extraction deliberately falls to Groq when the
  // Gemini primary is quota-exhausted (the cascade router decides WHEN to call
  // us; the provider shouldn't second-guess the task). Set AI_BLOCK_GROQ_EXTRACT=1
  // to restore the old behaviour.
  if (task === 'extract' && process.env.AI_BLOCK_GROQ_EXTRACT === '1') {
    throw new ClientError('[groq] cascade not permitted for task=' + task + ' (AI_BLOCK_GROQ_EXTRACT)');
  }

  // v0.36.7 (Pass-6 W2 MT-012b): consume the per-UTC-day Groq budget at
  // the gate. Throws QuotaError when exhausted; cascade=true means ai.js
  // bubbles it to the caller (no further fallback). No-op on self-host
  // installs (DEMO_MODE !== 'true').
  const gate = budgetGuard.checkAndConsume('groq');
  if (!gate.ok) {
    throw new QuotaError(
      `[groq] daily budget exhausted (${gate.callsToday}/${gate.budget} for today) — cascade exhausted`
    );
  }

  const { apiKey } = _resolveCredentials(settings);
  // Cascade safety (v0.92.22): as a fallback, settings.model may carry the PRIMARY
  // provider's model id (DEMO_MODE pins claude-haiku-*, or a Cloudflare @cf/ id).
  // Groq only serves its own models, so ignore a foreign id and use the Groq default.
  let model = settings.model || process.env.GROQ_MODEL || DEFAULT_MODEL;
  if (/^(claude|gpt|gemini|o1|o3|text-|dall)/i.test(model) || model.includes('@cf/')) {
    model = process.env.GROQ_MODEL || DEFAULT_MODEL;
  }

  const url = `${GROQ_BASE}/chat/completions`;
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
