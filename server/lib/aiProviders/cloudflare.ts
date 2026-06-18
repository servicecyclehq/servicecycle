/**
 * aiProviders/cloudflare.js — Cloudflare Workers AI adapter (v0.35.0)
 *
 * Primary AI provider for the ServiceCycle demo. Routes all four task types
 * (contract extraction, renewal brief, Ask ServiceCycle chat, news
 * classification) to Cloudflare Workers AI's OpenAI-compatible endpoint.
 *
 * Per-task model selection:
 *   - extract / brief    : @cf/mistralai/mistral-small-3.1-24b-instruct
 *   - ask / classify     : @cf/meta/llama-3.1-8b-instruct
 *
 * Wire model:
 *   - OpenAI-compatible chat completions; axios (already a dep) instead
 *     of the openai SDK to avoid a new npm dep.
 *   - Workers AI returns `usage` with token counts on every call.
 *     Neurons are charged at $0.011 per 1K beyond the 10K Neurons/day
 *     included with the $5/mo Workers Paid base.
 *
 * Errors:
 *   - 429 -> QuotaError (cascade)
 *   - 5xx -> ServerError (cascade w/ breaker)
 *   - 4xx (other than 429) -> ClientError (fail-fast)
 *       except CF code 5007 "no such model" → ServerError (cascade)
 *   - timeout -> TimeoutError (cascade w/ breaker)
 *
 * v0.36.7 hot patch (Pass-6 W2 MT-011):
 *   Reservation pattern for the $25/mo TOCTOU race. Pre-fix, the gate
 *   in aiBudgetGuard.checkAndConsume('cloudflare') compared committed
 *   $ against the 90% hardstop — N concurrent in-flight calls all saw
 *   the same pre-burst snapshot and all passed. Now: each call
 *   RESERVES its worst-case Neuron cost (maxTokens × per-model coeff)
 *   right before the axios POST, the gate compares (committed +
 *   reserved) against the hardstop, and recordNeurons releases the
 *   reservation while committing the actual cost. The catch path
 *   calls releaseReservation to undo the reservation cleanly. Net
 *   effect: the $25/mo cap becomes a hard ceiling that bursts cannot
 *   overshoot, at the cost of the cap firing ~$2-3 early (the
 *   conservative-reservation gap).
 *
 * Self-host operators bringing their own Cloudflare account set:
 *   CF_WORKERS_AI_ACCOUNT_ID=...
 *   CF_WORKERS_AI_API_KEY=...
 *   AI_PROVIDER=cloudflare
 */

'use strict';

const axios = require('axios');
const budgetGuard = require('../aiBudgetGuard');

const CF_BASE = 'https://api.cloudflare.com/client/v4/accounts';

// v0.38.3: request timeout for Workers AI calls. The previous hardcoded
// 10s was too aggressive for brief-sized prompts (mistral-small-3.1-24b
// on the brief/extract path frequently needs 15-25s with the full
// per-category template + Tavily context). Default bumped to 30s and
// made env-configurable. Set CF_WORKERS_AI_TIMEOUT_MS in /root/servicecycle/.env
// to retune per deployment; values < 1000 are coerced to the default.
const CF_TIMEOUT_DEFAULT_MS = 30_000;
const _cfTimeoutFromEnv = parseInt(process.env.CF_WORKERS_AI_TIMEOUT_MS, 10);
const CF_TIMEOUT_MS = (Number.isFinite(_cfTimeoutFromEnv) && _cfTimeoutFromEnv >= 1000)
  ? _cfTimeoutFromEnv
  : CF_TIMEOUT_DEFAULT_MS;

const MODEL_FOR_TASK = Object.freeze({
  extract:  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  brief:    '@cf/mistralai/mistral-small-3.1-24b-instruct',
  ask:      '@cf/meta/llama-3.1-8b-instruct',
  classify: '@cf/meta/llama-3.1-8b-instruct',
});
const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct';

// Cloudflare Workers AI billed in Neurons; 1K Neurons = $0.011 beyond the
// daily included 10K (May 2026 pricing).
const TOKEN_TO_NEURON = Object.freeze({
  '@cf/meta/llama-3.1-8b-instruct':            0.5,
  '@cf/mistralai/mistral-small-3.1-24b-instruct': 2.0,
});
const DEFAULT_TOKEN_TO_NEURON = 1.0;
const NEURON_USD_PER_1K = 0.011;

class QuotaError   extends Error { cascade: boolean; constructor(msg) { super(msg); this.name = 'QuotaError';   this.cascade = true; } }
class ServerError  extends Error { cascade: boolean; constructor(msg) { super(msg); this.name = 'ServerError';  this.cascade = true; } }
class ClientError  extends Error { cascade: boolean; constructor(msg) { super(msg); this.name = 'ClientError';  this.cascade = false; } }
class TimeoutError extends Error { cascade: boolean; constructor(msg) { super(msg); this.name = 'TimeoutError'; this.cascade = true; } }

function _resolveCredentials(s) {
  const accountId = s.cloudflareAccountId || process.env.CF_WORKERS_AI_ACCOUNT_ID;
  const apiKey = process.env.CF_WORKERS_AI_API_KEY
    || (s.apiKey && s.apiKey !== process.env.AI_API_KEY ? s.apiKey : null)
    || s.apiKey
    || process.env.AI_API_KEY;
  if (!accountId) throw new ClientError('[cloudflare] CF_WORKERS_AI_ACCOUNT_ID is required when AI_PROVIDER=cloudflare');
  if (!apiKey)    throw new ClientError('[cloudflare] CF_WORKERS_AI_API_KEY is required when AI_PROVIDER=cloudflare');
  return { accountId, apiKey };
}

function _isWorkersAiModelId(s) {
  return typeof s === 'string' && s.startsWith('@cf/');
}

function _pickModel(task, override) {
  if (override && _isWorkersAiModelId(override)) return override;
  if (override) {
    if (!_warnedOverrides.has(override)) {
      console.warn(
        `[cloudflare] ignoring non-Workers-AI model override "${override.slice(0, 60)}" ` +
        `(must start with "@cf/"); using task-default for "${task || 'unknown'}" instead`,
      );
      _warnedOverrides.add(override);
    }
  }
  return MODEL_FOR_TASK[task] || DEFAULT_MODEL;
}
const _warnedOverrides = new Set();

function _classifyAxiosError(err) {
  if (err && (err.code === 'ECONNABORTED' || /timeout/i.test(err.message))) {
    return new TimeoutError(`[cloudflare] request timed out: ${err.message}`);
  }
  if (err && err.response && typeof err.response.status === 'number') {
    const status = err.response.status;
    const body   = err.response.data;
    const detail = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body || {}).slice(0, 300);
    if (status === 429) return new QuotaError(`[cloudflare] 429 rate-limited: ${detail}`);
    if (status >= 500)  return new ServerError(`[cloudflare] ${status} server error: ${detail}`);

    if (status === 400 && _isModelNotFound(body)) {
      return new ServerError(`[cloudflare] 400 model-not-found (cascading): ${detail}`);
    }

    return new ClientError(`[cloudflare] ${status} client error: ${detail}`);
  }
  return new TimeoutError(`[cloudflare] network error: ${err && err.message ? err.message : String(err)}`);
}

function _isModelNotFound(body) {
  if (!body) return false;
  if (typeof body === 'object') {
    if (Array.isArray(body.errors)) {
      for (const e of body.errors) {
        if (e && e.code === 5007) return true;
        if (e && typeof e.message === 'string' && /no such model/i.test(e.message)) return true;
      }
    }
    if (typeof body.error === 'string' && /no such model/i.test(body.error)) return true;
  }
  if (typeof body === 'string' && /no such model|code"\s*:\s*5007/i.test(body)) return true;
  return false;
}

function _estimateNeurons(model, usage) {
  if (usage && typeof usage.neurons === 'number') return usage.neurons;
  const tokens = (usage && typeof usage.total_tokens === 'number')
    ? usage.total_tokens
    : ((usage && (usage.prompt_tokens || 0) + (usage.completion_tokens || 0)) || 0);
  const coeff = TOKEN_TO_NEURON[model] || DEFAULT_TOKEN_TO_NEURON;
  return Math.ceil(tokens * coeff);
}

/**
 * v0.36.7 (Pass-6 W2 MT-011): compute the worst-case Neuron + USD cost for
 * a given model and maxTokens. Used as the reservation amount at gate time
 * so the hardstop comparison is race-free.
 *
 * The reservation is a CONSERVATIVE upper bound (model coefficient × max
 * completion tokens). Actual cost includes prompt tokens too, but at typical
 * brief/extract/ask prompts the prompt tokens are small relative to the
 * completion budget (extract: ~2-3k prompt vs 4096 maxTokens; ask: ~50k
 * cached prompt vs 1024 maxTokens). For prompt-heavy ask calls the actual
 * cost can EXCEED the reservation — recordNeurons will commit the actual,
 * which then becomes visible to the next gate. The race-window concern is
 * BURST overshoot, not single-call overshoot; this addresses the former.
 */
function _worstCaseReservation(model, maxTokens) {
  const coeff = TOKEN_TO_NEURON[model] || DEFAULT_TOKEN_TO_NEURON;
  const neurons = Math.ceil(Math.max(1, Number(maxTokens) || 1024) * coeff);
  const usd = (neurons / 1000) * NEURON_USD_PER_1K;
  return { neurons, usd };
}

/**
 * complete({ system, user, maxTokens, task, settings })
 *
 * Returns { text, model, neurons, usdCost }.
 * `task` is one of: 'extract' | 'brief' | 'ask' | 'classify'.
 *
 * v0.36.7 sequence:
 *   1. resolve creds + model
 *   2. compute worst-case reservation
 *   3. reserveCloudflareSpend (race-safe second gate)
 *   4. axios POST
 *   5. on success: recordNeurons(actual, actual, reserved, reserved)
 *   6. on error: releaseReservation(reserved) + rethrow
 */
async function complete({ system, user, maxTokens = 1024, task, settings = {} }: any) {
  const { accountId, apiKey } = _resolveCredentials(settings);
  const model = _pickModel(task, settings.model || process.env.AI_MODEL_OVERRIDE);

  // v0.36.7 MT-011: reserve the worst-case Neuron cost BEFORE the network
  // call so concurrent in-flight calls don't all see the same pre-burst
  // snapshot of usdCost. If the reservation fails the hardstop, abort
  // with a QuotaError so the cascade can decide what to do (for the CF
  // primary, the cascade will surface this as a "all providers
  // exhausted" once HF + Groq are also drained).
  const reservation = _worstCaseReservation(model, maxTokens);
  const reserveResult = budgetGuard.reserveCloudflareSpend(reservation.neurons, reservation.usd);
  if (!reserveResult.ok) {
    throw new QuotaError(
      `[cloudflare] monthly USD budget hardstop reached (effective spend includes in-flight reservations); cascade-eligible`
    );
  }

  const url = `${CF_BASE}/${accountId}/ai/v1/chat/completions`;
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
      timeout: CF_TIMEOUT_MS, // v0.38.3: was hardcoded 10_000 — now env-tunable, default 30_000
      validateStatus: () => true,
    });
  } catch (err) {
    // v0.36.7: release the reservation on network-layer failure.
    try { budgetGuard.releaseReservation(reservation.neurons, reservation.usd); } catch (e) {
      console.warn('[cloudflare] releaseReservation failed (axios path):', e.message);
    }
    throw _classifyAxiosError(err);
  }

  if (res.status >= 400) {
    // v0.36.7: release the reservation on HTTP-error failure.
    try { budgetGuard.releaseReservation(reservation.neurons, reservation.usd); } catch (e) {
      console.warn('[cloudflare] releaseReservation failed (status path):', e.message);
    }
    throw _classifyAxiosError({ response: res });
  }

  const data    = res.data || {};
  const choice  = Array.isArray(data.choices) && data.choices[0];
  const text    = (choice && choice.message && choice.message.content) || '';
  const neurons = _estimateNeurons(model, data.usage);
  const usdCost = (neurons / 1000) * NEURON_USD_PER_1K;

  // v0.36.7: record actual cost AND release the reservation atomically.
  // Safe to fail-open on the record itself; the reservation will linger
  // until the next month rollover but that's bounded by the per-call
  // reservation size (worst-case ~$0.09 per Mistral-24B brief call).
  try {
    budgetGuard.recordNeurons(neurons, usdCost, reservation.neurons, reservation.usd);
  } catch (e) {
    console.warn('[cloudflare] budget guard recordNeurons failed:', e.message);
    // Belt-and-suspenders: try to release the reservation separately so
    // a recordNeurons bug doesn't leak the in-flight counter forever.
    try { budgetGuard.releaseReservation(reservation.neurons, reservation.usd); } catch (_) { /* noop */ }
  }

  return { text: String(text).trim(), model, neurons, usdCost };
}

module.exports = {
  complete,
  MODEL_FOR_TASK,
  QuotaError,
  ServerError,
  ClientError,
  TimeoutError,
};

export {};
