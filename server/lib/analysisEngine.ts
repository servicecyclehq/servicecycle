/**
 * analysisEngine.js — Generic multi-persona AI debate orchestrator
 *
 * Zero LapseIQ dependencies. Accepts a topic definition and an aiCall
 * function, orchestrates the debate in two rounds, computes a deterministic
 * verdict, and returns the full structured result.
 *
 * Ported patterns from Sharpedge trading bot (artifacts/api-server/src/routes/analysis.ts):
 *   - withRetry: exponential backoff, retryable error detection
 *   - circuitBreaker: per-persona failure tracking, 5-min open window
 *
 * Execution flow:
 *   Round 1 (parallel)  : customerAdvocate + marketAnalyst via Promise.all
 *   Round 2 cold        : riskAssessor — ZERO Round 1 visibility (anti-anchoring)
 *   Round 2 informed    : vendorAdvocate — sees Round 1 + Round 2 cold
 *   Deterministic       : computeVerdict() — no AI, pure scoring
 *   Round 3             : synthesisDirector — receives locked verdict + all outputs
 *
 * aiCall signature:
 *   async ({ system, user, maxTokens, settings, cacheSystem }) => { text: string }
 *
 * topic shape:
 *   {
 *     context: {},   // built by buildContractContext()
 *     personas: {
 *       customerAdvocate:   { buildSystemPrompt(ctx), buildUserPrompt(ctx) }
 *       marketAnalyst:      { buildSystemPrompt(ctx), buildUserPrompt(ctx) }
 *       riskAssessor:       { buildSystemPrompt(ctx), buildUserPrompt(ctx) }
 *       vendorAdvocate:     { buildSystemPrompt(ctx, round1), buildUserPrompt(ctx, round1) }
 *       synthesisDirector:  { buildSystemPrompt(ctx, all, verdict), buildUserPrompt(ctx, all, verdict) }
 *     }
 *   }
 */

'use strict';

// ─── Retry wrapper (ported from Sharpedge analysis.ts) ───────────────────────
// Retries on transient errors only. Hard-fails on parse errors and permanent
// errors so we don't waste quota retrying bad prompts.

async function withRetry(fn, label, maxRetries = 3) {
  let lastErr = new Error('unknown');
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = (err.message || '').toLowerCase();
      const isRetryable =
        msg.includes('rate_limit')     ||
        msg.includes('rate limit')     ||
        msg.includes('overloaded')     ||
        msg.includes('529')            ||
        msg.includes('503')            ||
        msg.includes('timeout')        ||
        msg.includes('timed out')      ||
        msg.includes('econnreset')     ||
        msg.includes('socket hang up') ||
        msg.includes('enotfound');
      if (!isRetryable || attempt === maxRetries) throw lastErr;
      const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      console.warn(`[analysisEngine] ${label} attempt ${attempt}/${maxRetries} failed — retrying in ${delayMs}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// ─── Per-persona circuit breaker (ported from Sharpedge analysis.ts) ─────────
// Opens for 5 minutes after 3 consecutive failures per persona.
// Prevents hammering a down provider mid-debate and burning quota.

const _breakers = {};

function _getBreaker(label) {
  if (!_breakers[label]) {
    _breakers[label] = { failures: 0, openUntil: 0 };
  }
  return _breakers[label];
}

const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS   = 5 * 60 * 1000;

function breakerCheck(label) {
  const b = _getBreaker(label);
  if (b.openUntil > Date.now()) {
    const secsLeft = Math.ceil((b.openUntil - Date.now()) / 1000);
    throw new Error(`[analysisEngine] ${label} circuit breaker open — ${secsLeft}s remaining`);
  }
}

function breakerSuccess(label) {
  const b = _getBreaker(label);
  b.failures = 0;
  b.openUntil = 0;
}

function breakerFailure(label) {
  const b = _getBreaker(label);
  b.failures += 1;
  if (b.failures >= BREAKER_THRESHOLD) {
    b.openUntil = Date.now() + BREAKER_OPEN_MS;
    console.error(`[analysisEngine] circuit breaker OPEN for ${label} — ${BREAKER_THRESHOLD} consecutive failures`);
  }
}

// ─── JSON extraction (3-pass) ─────────────────────────────────────────────────
// Pass 1: direct JSON.parse
// Pass 2: extract from markdown code block
// Pass 3: grab first {...} block

function parseJson(text, label) {
  // Pass 1: direct
  try { return JSON.parse(text.trim()); } catch (_) {}
  // Pass 2: markdown code block
  const blockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (blockMatch) {
    try { return JSON.parse(blockMatch[1].trim()); } catch (_) {}
  }
  // Pass 3: first {...} block
  const braceMatch = text.match(/(\{[\s\S]*\})/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[1].trim()); } catch (_) {}
  }
  throw new Error(`[analysisEngine] ${label} JSON extraction failed — raw: ${text.slice(0, 200)}`);
}

// ─── Effort → token budget mapping ───────────────────────────────────────────
// Maps effort level to maxTokens. When the effort param migration lands in
// lib/ai.js, pass settings.effort through — for now token budget is the lever.

const EFFORT_TOKENS = { high: 8192, medium: 4096, low: 2048 };

function effortTokens(level) {
  return EFFORT_TOKENS[level] || 4096;
}

// ─── Single AI call wrapper ───────────────────────────────────────────────────

async function callPersona(aiCall, settings, system, user, effort, label) {
  breakerCheck(label);
  try {
    const result = await withRetry(
      () => aiCall({ system, user, maxTokens: effortTokens(effort), settings, cacheSystem: true }),
      label,
    );
    breakerSuccess(label);
    return result.text;
  } catch (err) {
    breakerFailure(label);
    throw err;
  }
}

// ─── Confidence flags ─────────────────────────────────────────────────────────

function computeConfidenceFlags(advocate, analyst, assessor) {
  const flags = [];
  if ((analyst?.confidence?.score ?? 100) < 40)  flags.push('LOW_MARKET_CONFIDENCE');
  if ((assessor?.confidence?.score ?? 100) < 40)  flags.push('LOW_RISK_CONFIDENCE');
  if ((advocate?.confidence ?? 100) < 40)          flags.push('LOW_LEVERAGE_CONFIDENCE');
  if (flags.length >= 2)                           flags.push('VERDICT_PRELIMINARY');
  return flags;
}

// ─── Deterministic verdict computation ───────────────────────────────────────
// See docs/design/verdict-table.md for full spec and calibration notes.
// Point values are starting estimates — tune after 50+ rated debate sessions.

function _lock(verdict, tier, rule, signals) {
  return { verdict, score: 100, scores: {}, tier, override_rule: rule, tied_with: null, signals_applied: signals };
}

function computeVerdict(advocate, analyst, assessor, vendor) {
  const signals = [];
  function sig(label, bucket, pts) {
    signals.push(`${label}→${bucket}+${pts}`);
  }

  // Safe field accessors
  const walkAway          = advocate?.walk_away_signal ?? {};
  const leverageBand      = advocate?.leverage_band ?? 'weak';
  const leverageScore     = advocate?.leverage_score ?? 50;
  const openingAskPct     = advocate?.opening_ask?.percentage ?? 0;
  const advocateConf      = advocate?.confidence ?? 85;

  const benchmarkVerdict  = analyst?.benchmark_verdict ?? 'cannot_determine';
  const valueAlignment    = analyst?.value_alignment ?? 'cannot_determine';
  const priceDirection    = analyst?.price_direction_signal ?? 'neutral';
  const vendorPosture     = analyst?.vendor_posture_signal?.posture ?? 'cannot_determine';
  const compDensity       = analyst?.market_context?.competitive_density ?? 'moderate';
  const analystConf       = analyst?.confidence?.score ?? 50;

  const primaryRisk       = assessor?.primary_risk ?? {};
  const riskScore         = assessor?.risk_priority_score ?? 0;
  const compoundElevation = assessor?.compound_elevation_applied ?? false;
  const legalExposure     = assessor?.legal_exposure ?? {};
  const assessorConf      = assessor?.confidence?.score ?? 50;

  const vendorWalkAway    = vendor?.walk_away_signal ?? null;
  const escalationLevel   = vendor?.escalation_playbook?.current_level ?? 'NORMAL';

  // ── Tier 1: Hard Overrides ────────────────────────────────────────────────
  if (walkAway.walk_away_recommended) {
    if (valueAlignment === 'overpaying_for_underuse') return _lock('RETIRE',  1, 'H1', signals);
    return _lock('REPLACE', 1, 'H2', signals);
  }
  if (primaryRisk.category === 'vendor_instability' &&
      primaryRisk.severity  === 'critical' &&
      primaryRisk.probability === 'high') {
    return _lock('REPLACE', 1, 'H3', signals);
  }
  if (valueAlignment    === 'overpaying_for_underuse' &&
      benchmarkVerdict  === 'significantly_above_market' &&
      primaryRisk.category === 'utilization_mismatch' &&
      ['high', 'critical'].includes(primaryRisk.severity)) {
    return _lock('REDUCE', 1, 'H4', signals);
  }
  if (legalExposure.present &&
      legalExposure.severity === 'critical' &&
      vendorWalkAway         === 'accepted_churn') {
    return _lock('REPLACE', 1, 'H5', signals);
  }

  // ── Tier 2: Scoring ───────────────────────────────────────────────────────
  const scores = { RENEW: 0, RENEGOTIATE: 0, REDUCE: 0, REPLACE: 0, RETIRE: 0 };
  function add(bucket, pts, label) { scores[bucket] += pts; sig(label, bucket, pts); }

  // RENEW
  if (benchmarkVerdict === 'below_market')         add('RENEW', 30, 'below_market');
  if (benchmarkVerdict === 'at_market')            add('RENEW', 20, 'at_market');
  if (valueAlignment   === 'high_value')           add('RENEW', 20, 'high_value');
  if (primaryRisk.category === 'no_risk_identified') add('RENEW', 25, 'no_risk');
  if (riskScore < 25)                              add('RENEW', 20, 'risk_score<25');
  else if (riskScore < 40)                         add('RENEW', 10, 'risk_score<40');
  if (leverageBand === 'no_leverage')              add('RENEW', 15, 'no_leverage');
  if (leverageBand === 'weak')                     add('RENEW',  8, 'weak_leverage');
  if (priceDirection === 'neutral')                add('RENEW', 10, 'neutral_price');
  if (priceDirection === 'downward')               add('RENEW', 15, 'downward_price');
  if (vendorPosture  === 'mature_stable')          add('RENEW', 10, 'mature_stable');
  if (analystConf    > 75)                         add('RENEW',  5, 'high_analyst_confidence');

  // RENEGOTIATE
  if (benchmarkVerdict === 'above_market')             add('RENEGOTIATE', 25, 'above_market');
  if (benchmarkVerdict === 'significantly_above_market') add('RENEGOTIATE', 35, 'sig_above_market');
  if (priceDirection   === 'upward')                   add('RENEGOTIATE', 20, 'upward_price');
  if (leverageBand     === 'moderate')                 add('RENEGOTIATE', 10, 'moderate_leverage');
  if (leverageBand     === 'strong')                   add('RENEGOTIATE', 20, 'strong_leverage');
  if (leverageBand     === 'extreme')                  add('RENEGOTIATE', 30, 'extreme_leverage');
  if (vendorPosture    === 'aggressive_expansion')     add('RENEGOTIATE', 15, 'aggressive_expansion');
  if (riskScore >= 30 && riskScore <= 70)              add('RENEGOTIATE', 10, 'mid_risk');
  if (compoundElevation)                               add('RENEGOTIATE', 10, 'compound_elevation');
  if (legalExposure.present && legalExposure.severity === 'medium') add('RENEGOTIATE', 10, 'medium_legal');
  if (openingAskPct <= -15)                            add('RENEGOTIATE', 15, 'large_opening_ask');
  if (['VP', 'CRO'].includes(escalationLevel))         add('RENEGOTIATE', 10, 'vp_cro_escalation');

  // REDUCE
  if (valueAlignment   === 'overpaying_for_underuse')    add('REDUCE', 35, 'overpaying_underuse');
  if (primaryRisk.category === 'utilization_mismatch')   add('REDUCE', 25, 'utilization_mismatch');
  if (benchmarkVerdict === 'above_market')               add('REDUCE', 15, 'above_market');
  if (benchmarkVerdict === 'significantly_above_market') add('REDUCE', 20, 'sig_above_market');
  if (leverageScore > 50)                                add('REDUCE', 10, 'leverage>50');
  if (leverageScore > 65)                                add('REDUCE',  5, 'leverage>65');

  // REPLACE
  if (primaryRisk.category === 'competitive_displacement' && primaryRisk.severity === 'high')     add('REPLACE', 25, 'competitive_disp_high');
  if (primaryRisk.category === 'competitive_displacement' && primaryRisk.severity === 'critical')  add('REPLACE', 35, 'competitive_disp_critical');
  if (primaryRisk.category === 'vendor_instability'       && primaryRisk.severity === 'high')     add('REPLACE', 25, 'vendor_instability_high');
  if (vendorPosture === 'distressed')                                                              add('REPLACE', 20, 'distressed_vendor');
  if (compDensity   === 'crowded')                                                                 add('REPLACE', 10, 'crowded_market');
  if (riskScore     > 75)                                                                          add('REPLACE', 15, 'risk_score>75');
  if (['strong', 'extreme'].includes(leverageBand))                                               add('REPLACE', 10, 'strong_leverage');
  if (primaryRisk.category === 'customer_dependency_trap' && benchmarkVerdict === 'significantly_above_market') add('REPLACE', 20, 'dep_trap_sig_above');

  // RETIRE
  if (valueAlignment   === 'overpaying_for_underuse' && primaryRisk.category === 'utilization_mismatch')  add('RETIRE', 30, 'overuse_and_mismatch');
  if (benchmarkVerdict === 'significantly_above_market' && valueAlignment === 'overpaying_for_underuse')  add('RETIRE', 25, 'sig_above_and_overuse');
  if (leverageScore > 65 && walkAway.triggered)                                                           add('RETIRE', 20, 'leverage_and_walkaway');
  if (primaryRisk.category === 'no_risk_identified' && valueAlignment === 'overpaying_for_underuse')      add('RETIRE', 20, 'no_risk_but_overuse');

  // ── Winner ────────────────────────────────────────────────────────────────
  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  const [winner, winScore]       = sorted[0];
  const [runnerUp, runnerUpScore] = sorted[1];
  const margin = winScore - runnerUpScore;

  // Tier 3: Default — signals genuinely conflict or all scores too low
  if (winScore < 25 || margin < 10) {
    return {
      verdict:          'RENEGOTIATE',
      score:            winScore,
      scores,
      tier:             3,
      override_rule:    null,
      tied_with:        winScore >= 25 ? runnerUp : null,
      signals_applied:  signals,
    };
  }

  return {
    verdict:         winner,
    score:           winScore,
    scores,
    tier:            2,
    override_rule:   null,
    tied_with:       margin < 15 ? runnerUp : null,
    signals_applied: signals,
  };
}

// ─── Main debate orchestrator ─────────────────────────────────────────────────

async function runDebate(topic, aiCall, settings: any = {}) {
  const { context, personas } = topic;

  // -- Round 1: all three independent personas in parallel -----------------
  // riskAssessor fires cold from the same raw context as the other two --
  // it never sees CA/MA outputs regardless of when it fires, so parallelize
  // it here to eliminate one full sequential latency step.
  console.log('[analysisEngine] Round 1 -- customerAdvocate + marketAnalyst + riskAssessor (parallel)');
  const [advocateRaw, analystRaw, assessorRaw] = await Promise.all([
    callPersona(
      aiCall, settings,
      personas.customerAdvocate.buildSystemPrompt(context),
      personas.customerAdvocate.buildUserPrompt(context),
      'high',
      'customerAdvocate',
    ),
    callPersona(
      aiCall, settings,
      personas.marketAnalyst.buildSystemPrompt(context),
      personas.marketAnalyst.buildUserPrompt(context),
      'medium',
      'marketAnalyst',
    ),
    callPersona(
      aiCall, settings,
      personas.riskAssessor.buildSystemPrompt(context),
      personas.riskAssessor.buildUserPrompt(context),
      'high',
      'riskAssessor',
    ),
  ]);

  const advocate = parseJson(advocateRaw, 'customerAdvocate');
  const analyst  = parseJson(analystRaw,  'marketAnalyst');
  const assessor = parseJson(assessorRaw, 'riskAssessor');


  // ── Round 2 informed: vendorAdvocate (sees everything) ───────────────────
  console.log('[analysisEngine] Round 2 informed — vendorAdvocate');
  const round1 = { advocate, analyst, assessor };
  const vendorRaw = await callPersona(
    aiCall, settings,
    personas.vendorAdvocate.buildSystemPrompt(context, round1),
    personas.vendorAdvocate.buildUserPrompt(context, round1),
    'medium',
    'vendorAdvocate',
  );
  const vendor = parseJson(vendorRaw, 'vendorAdvocate');

  // ── Deterministic verdict (no AI) ─────────────────────────────────────────
  console.log('[analysisEngine] Computing deterministic verdict');
  const verdictResult      = computeVerdict(advocate, analyst, assessor, vendor);
  const confidenceFlags    = computeConfidenceFlags(advocate, analyst, assessor);

  // ── Synthesis Director (locked verdict → board narrative) ─────────────────
  console.log(`[analysisEngine] Synthesis — verdict=${verdictResult.verdict} tier=${verdictResult.tier}`);
  const allOutputs = { advocate, analyst, assessor, vendor, verdictResult, confidenceFlags };
  const synthesisRaw = await callPersona(
    aiCall, settings,
    personas.synthesisDirector.buildSystemPrompt(context, allOutputs, verdictResult),
    personas.synthesisDirector.buildUserPrompt(context, allOutputs, verdictResult),
    'low',
    'synthesisDirector',
  );
  const synthesis = parseJson(synthesisRaw, 'synthesisDirector');

  console.log(`[analysisEngine] Complete — verdict=${verdictResult.verdict} signals=${verdictResult.signals_applied.length}`);

  return {
    advocate,
    analyst,
    assessor,
    vendor,
    verdictResult,
    confidenceFlags,
    synthesis,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runDebate, computeVerdict };

export {};
