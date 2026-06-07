/**
 * aiBudgetGuard.js (v0.35.0, v0.36.7 reservation pattern, v0.73.1 T6-N6 hardstop >=)
 *
 * Generic per-service budget guard for paid external APIs the demo
 * instance depends on. Originally Gemini-only (v0.32.4); v0.33.0
 * extended to cover Tavily and Brevo with per-UTC-day call counters;
 * v0.35.0 extends to cover the multi-provider AI stack (Cloudflare
 * Workers AI primary, HuggingFace + Groq fallbacks) with a MONTHLY
 * dollar-and-Neuron budget on top of the daily call counters.
 *
 * v0.36.7 (Pass-6 W2 MT-011): close the Cloudflare TOCTOU race.
 * Pre-fix, checkAndConsume('cloudflare') compared the SNAPSHOT of
 * usdCost against the 90% hardstop and returned ok=true based on
 * pre-burst totals. N concurrent in-flight calls all passed the
 * gate, all executed, all recordNeurons'd post-hoc — final $ could
 * overshoot the hardstop by the burst-size × per-call cost.
 *
 * New shape: in-flight calls RESERVE their worst-case Neuron cost at
 * the gate via reserveCloudflareSpend(), and the gate compares
 * (usdCost + reservedUsd) against the hardstop. recordNeurons() now
 * accepts a `reserved` arg so it can subtract the reservation as it
 * commits the actual cost. A failed call calls releaseReservation()
 * to unwind the reservation without committing.
 *
 * Two tracking shapes coexist:
 *
 *   1. Per-UTC-DAY call counters (legacy v0.33.0 pattern). Used for
 *      gemini, tavily, brevo, huggingface, groq.
 *
 *   2. Per-UTC-MONTH dollar + Neuron tracker (NEW v0.35.0; reservation
 *      counters added v0.36.7). Used for cloudflare specifically.
 *
 * Default v0.35.0 budgets:
 *   gemini       : 1300 calls/day
 *   tavily       :   30 calls/day
 *   brevo        :   50 emails/day
 *   cloudflare   :  $25 / month
 *   huggingface  : 1000 calls/day
 *   groq        :  500 calls/day
 *
 * Operators override via these env vars:
 *   GEMINI_DAILY_CALL_BUDGET
 *   TAVILY_DAILY_CALL_BUDGET
 *   BREVO_DAILY_CALL_BUDGET
 *   HUGGINGFACE_DAILY_CALL_BUDGET
 *   GROQ_DAILY_CALL_BUDGET
 *   AI_BUDGET_MONTHLY_USD          (default 25)
 *   AI_BUDGET_ALERT_PCT            (default 75)
 *   AI_BUDGET_HARDSTOP_PCT         (default 90)
 *
 * Setting any DAILY budget to 0 or a negative number disables that
 * service's guard. Setting AI_BUDGET_MONTHLY_USD to 0 disables the
 * cloudflare $/Neuron tracker.
 *
 * Process-scope state: in-flight counters live in module-level memory.
 * Single-replica demo droplet only. Multi-replica needs Redis or a
 * Postgres counter table.
 *
 * No-op on self-hosted instances (DEMO_MODE !== 'true').
 */

'use strict';

const UTC_MIDNIGHT_MS = 86_400_000;

// Daily-call service registry.
const DAILY_SERVICES = {
  gemini:      { defaultBudget: 1300, envVar: 'GEMINI_DAILY_CALL_BUDGET'      },
  tavily:      { defaultBudget:   30, envVar: 'TAVILY_DAILY_CALL_BUDGET'      },
  brevo:       { defaultBudget:   50, envVar: 'BREVO_DAILY_CALL_BUDGET'       },
  huggingface: { defaultBudget: 1000, envVar: 'HUGGINGFACE_DAILY_CALL_BUDGET' },
  groq:        { defaultBudget:  500, envVar: 'GROQ_DAILY_CALL_BUDGET'        },
};

const _dailyState = Object.fromEntries(
  Object.keys(DAILY_SERVICES).map((s) => [s, { day: null, calls: 0, lastWarn: 0 }]),
);

// Monthly $/Neuron tracker for Cloudflare Workers AI.
// v0.36.7 adds reservedNeurons + reservedUsd so the gate can include
// in-flight worst-case cost in the hardstop comparison.
const _monthlyCloudflare = {
  month:           null,
  neurons:         0,   // committed (post-call)
  usdCost:         0,   // committed (post-call)
  reservedNeurons: 0,   // in-flight worst-case (pre-call)
  reservedUsd:     0,   // in-flight worst-case (pre-call)
  lastAlertMonth:  null,
  // v0.71.3 (audit Medium 'Abuse Hardening'): 30/70/90 alert ladder.
  // Each tier is a one-shot per month; reset on rollover. The legacy
  // lastAlertMonth above is kept for backward compat with the previous
  // single-shot 70%-only behavior.
  alertsFired:     { thirty: false, seventy: false, ninety: false },
  hardStopped:     false,
};

function _todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function _thisMonthUtc() {
  return new Date().toISOString().slice(0, 7);
}

function _normalizeService(service) {
  const s = service == null ? 'gemini' : String(service).toLowerCase();
  if (!DAILY_SERVICES[s]) {
    console.warn(`[aiBudgetGuard] unknown daily service "${service}" — defaulting to gemini`);
    return 'gemini';
  }
  return s;
}

function _rolloverDailyIfNeeded(service) {
  const today = _todayUtc();
  const st = _dailyState[service];
  if (today !== st.day) {
    st.day = today;
    st.calls = 0;
    st.lastWarn = 0; // -1 sentinel means "exhaustion alerted today"; reset to 0 on rollover
  }
}

function _rolloverMonthlyIfNeeded() {
  const month = _thisMonthUtc();
  if (month !== _monthlyCloudflare.month) {
    _monthlyCloudflare.month           = month;
    _monthlyCloudflare.neurons         = 0;
    _monthlyCloudflare.usdCost         = 0;
    _monthlyCloudflare.reservedNeurons = 0;
    _monthlyCloudflare.reservedUsd     = 0;
    _monthlyCloudflare.hardStopped     = false;
    _monthlyCloudflare.alertsFired     = { thirty: false, seventy: false, ninety: false };
  }
}

function _dailyBudgetFor(service) {
  const cfg = DAILY_SERVICES[service];
  const raw = process.env[cfg.envVar];
  if (raw == null || raw === '') return cfg.defaultBudget;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return cfg.defaultBudget;
  return n;
}

function _monthlyUsdBudget() {
  const raw = process.env.AI_BUDGET_MONTHLY_USD;
  if (raw == null || raw === '') return 25;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return 25;
  return n;
}

function _alertPct() {
  const raw = process.env.AI_BUDGET_ALERT_PCT;
  if (raw == null || raw === '') return 75;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return 75;
  return n;
}

// v0.69.1 (audit Medium): middle alert tier between alert and hardstop.
// Demo uses 30/70/90 by default (alert / mid / stop). Self-host
// operators can tune via AI_BUDGET_MID_ALERT_PCT.
function _midAlertPct() {
  const raw = process.env.AI_BUDGET_MID_ALERT_PCT;
  if (raw == null || raw === '') return 70;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return 70;
  return n;
}

function _hardstopPct() {
  const raw = process.env.AI_BUDGET_HARDSTOP_PCT;
  if (raw == null || raw === '') return 90;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return 90;
  return n;
}

// v0.36.7 helper: combined effective spend = committed + in-flight reserved.
function _cloudflareEffectiveUsd() {
  return _monthlyCloudflare.usdCost + _monthlyCloudflare.reservedUsd;
}

/**
 * checkAndConsume(service) — synchronous gate before every call to that
 * service. `service` defaults to 'gemini' for backward compatibility
 * with the v0.32.4 single-service API.
 *
 * For 'cloudflare': checks (committed + reserved) against the monthly
 * $-budget hard-stop. Does NOT reserve here — the caller (cloudflareProvider)
 * calls reserveCloudflareSpend() after the gate passes but before the
 * network call. This keeps backward compatibility with existing callers
 * that don't have model/maxTokens context at gate time.
 *
 * Returns:
 *   { ok: true,  service, callsToday, budget, monthly? }
 *   { ok: false, service, callsToday, budget, reason: '...', monthly? }
 *
 * Only active when DEMO_MODE=true. Self-host returns { ok: true }.
 */
function checkAndConsume(service) {
  if (process.env.DEMO_MODE !== 'true') {
    return { ok: true, service: service || 'gemini', callsToday: 0, budget: Number.POSITIVE_INFINITY };
  }

  const svcRaw = service == null ? 'gemini' : String(service).toLowerCase();

  if (svcRaw === 'cloudflare') {
    _rolloverMonthlyIfNeeded();
    const monthlyUsd = _monthlyUsdBudget();
    const hardstopUsd = monthlyUsd * (_hardstopPct() / 100);
    // v0.36.7: include in-flight reserved cost in the hardstop comparison.
    // This is what makes the gate race-free under burst — N concurrent
    // requests all see the same growing reserved + committed total.
    const effectiveUsd = _cloudflareEffectiveUsd();
    if (monthlyUsd > 0 && effectiveUsd >= hardstopUsd) {
      _monthlyCloudflare.hardStopped = true;
      return {
        ok: false,
        service: 'cloudflare',
        callsToday: 0,
        budget: monthlyUsd,
        reason: 'monthly_usd_hardstop',
        monthly: {
          usdCost: _monthlyCloudflare.usdCost,
          reservedUsd: _monthlyCloudflare.reservedUsd,
          usdBudget: monthlyUsd,
          neurons: _monthlyCloudflare.neurons,
          reservedNeurons: _monthlyCloudflare.reservedNeurons,
        },
      };
    }
    return {
      ok: true,
      service: 'cloudflare',
      callsToday: 0,
      budget: monthlyUsd,
      monthly: {
        usdCost: _monthlyCloudflare.usdCost,
        reservedUsd: _monthlyCloudflare.reservedUsd,
        usdBudget: monthlyUsd,
        neurons: _monthlyCloudflare.neurons,
        reservedNeurons: _monthlyCloudflare.reservedNeurons,
      },
    };
  }

  const svc = _normalizeService(svcRaw);
  _rolloverDailyIfNeeded(svc);

  const budget = _dailyBudgetFor(svc);
  if (budget <= 0) {
    return { ok: true, service: svc, callsToday: _dailyState[svc].calls, budget: Number.POSITIVE_INFINITY };
  }

  if (_dailyState[svc].calls >= budget) {
    // Pass-6 W4 task #9: fire an alert email the FIRST time we hit
    // exhaustion for this svc + day. lastWarn doubles as the dedupe stamp
    // so multiple requests in the exhausted state don't spam.
    if (_dailyState[svc].lastWarn !== -1) {
      _dailyState[svc].lastWarn = -1; // sentinel: alerted for this day
      _fireDailyExhaustionEmail({ service: svc, callsToday: _dailyState[svc].calls, budget, day: _dailyState[svc].day })
        .catch((e) => console.warn(`[aiBudgetGuard] daily-exhaustion alert send failed for ${svc}:`, e.message));
    }
    return { ok: false, service: svc, callsToday: _dailyState[svc].calls, budget, reason: 'budget_exhausted' };
  }

  _dailyState[svc].calls += 1;

  if (_dailyState[svc].calls > budget * 0.9 && Date.now() - _dailyState[svc].lastWarn > 3_600_000) {
    _dailyState[svc].lastWarn = Date.now();
    console.warn(
      `[aiBudgetGuard] Demo ${svc} usage at ${_dailyState[svc].calls}/${budget} for ${_dailyState[svc].day}; ` +
      `approaching the daily free-tier budget. ` +
      `Set ${DAILY_SERVICES[svc].envVar} to a higher value (with paid overage) ` +
      `or accept the soft-stop at ${budget}.`,
    );
  }

  return { ok: true, service: svc, callsToday: _dailyState[svc].calls, budget };
}

/**
 * reserveCloudflareSpend(neurons, usdCost) — v0.36.7 reservation primitive.
 *
 * Adds the worst-case in-flight cost to the reserved counters. Called by
 * cloudflareProvider.complete() AFTER checkAndConsume('cloudflare') returns
 * ok=true and BEFORE the network call. Pair with recordNeurons() (on
 * success) or releaseReservation() (on failure) to keep the reserved
 * counter accurate.
 *
 * If the gate was just passed but a concurrent call has since pushed the
 * effective total over the hardstop, this returns { ok: false } and the
 * caller should refuse the call. Race-window: the gap between the gate
 * read and the reservation write is ~microseconds in single-process Node;
 * the reservation itself uses the SAME counter the next gate will read,
 * so the next request sees the updated total.
 *
 * Returns:
 *   { ok: true,  reservation: { neurons, usdCost } }
 *   { ok: false, reason: 'monthly_usd_hardstop', monthly: { ... } }
 *
 * No-op on self-host (DEMO_MODE !== 'true').
 */
function reserveCloudflareSpend(neurons, usdCost) {
  if (process.env.DEMO_MODE !== 'true') {
    return { ok: true, reservation: { neurons: 0, usdCost: 0 } };
  }
  _rolloverMonthlyIfNeeded();

  const resNeurons = Math.max(0, Number(neurons) || 0);
  const resUsd     = Math.max(0, Number(usdCost) || 0);

  // Second-chance gate: even though checkAndConsume just passed, a
  // concurrent reservation may have pushed us over since. Re-check.
  const monthlyUsd = _monthlyUsdBudget();
  if (monthlyUsd > 0) {
    const hardstopUsd = monthlyUsd * (_hardstopPct() / 100);
    if (_cloudflareEffectiveUsd() + resUsd >= hardstopUsd) {
      _monthlyCloudflare.hardStopped = true;
      return {
        ok: false,
        reason: 'monthly_usd_hardstop',
        monthly: {
          usdCost: _monthlyCloudflare.usdCost,
          reservedUsd: _monthlyCloudflare.reservedUsd,
          usdBudget: monthlyUsd,
          neurons: _monthlyCloudflare.neurons,
          reservedNeurons: _monthlyCloudflare.reservedNeurons,
        },
      };
    }
  }

  _monthlyCloudflare.reservedNeurons += resNeurons;
  _monthlyCloudflare.reservedUsd     += resUsd;

  return { ok: true, reservation: { neurons: resNeurons, usdCost: resUsd } };
}

/**
 * releaseReservation(neurons, usdCost) — v0.36.7 reservation cleanup
 * for the failure path. Subtracts the previously reserved amounts from
 * the reserved counters WITHOUT committing them to actual spend.
 *
 * Call after a failed network call so the reservation doesn't linger
 * until month rollover.
 */
function releaseReservation(neurons, usdCost) {
  if (process.env.DEMO_MODE !== 'true') return;
  _rolloverMonthlyIfNeeded();

  const resNeurons = Math.max(0, Number(neurons) || 0);
  const resUsd     = Math.max(0, Number(usdCost) || 0);

  _monthlyCloudflare.reservedNeurons = Math.max(0, _monthlyCloudflare.reservedNeurons - resNeurons);
  _monthlyCloudflare.reservedUsd     = Math.max(0, _monthlyCloudflare.reservedUsd     - resUsd);
}

/**
 * recordNeurons(neurons, usdCost, reservedNeurons, reservedUsd) — record
 * post-call Cloudflare spend against the monthly tracker.
 *
 * v0.36.7 backward-compatible signature: `reservedNeurons` and `reservedUsd`
 * are optional. When provided, the reservation amounts are subtracted from
 * the reserved counters as the actual amounts are added to the committed
 * counters. Pre-v0.36.7 callers that only pass (neurons, usdCost) still
 * work — they just won't release a reservation (acceptable because pre-
 * v0.36.7 callers didn't make one).
 *
 * Triggers the 75% Brevo alert when cumulative spend first crosses that
 * line in the current month.
 *
 * No-op on self-host (DEMO_MODE !== 'true').
 *
 * Returns the post-record snapshot { neurons, usdCost, usdBudget,
 * pctConsumed, reservedNeurons, reservedUsd }.
 */
function recordNeurons(neurons, usdCost, reservedNeurons, reservedUsd) {
  if (process.env.DEMO_MODE !== 'true') {
    return { neurons: 0, usdCost: 0, usdBudget: 0, pctConsumed: 0, reservedNeurons: 0, reservedUsd: 0 };
  }
  _rolloverMonthlyIfNeeded();

  const inc = Math.max(0, Number(neurons) || 0);
  const usd = Math.max(0, Number(usdCost) || 0);
  _monthlyCloudflare.neurons += inc;
  _monthlyCloudflare.usdCost += usd;

  // v0.36.7: release the reservation if the caller made one.
  if (reservedNeurons != null || reservedUsd != null) {
    const resN = Math.max(0, Number(reservedNeurons) || 0);
    const resU = Math.max(0, Number(reservedUsd)     || 0);
    _monthlyCloudflare.reservedNeurons = Math.max(0, _monthlyCloudflare.reservedNeurons - resN);
    _monthlyCloudflare.reservedUsd     = Math.max(0, _monthlyCloudflare.reservedUsd     - resU);
  }

  const monthlyUsd = _monthlyUsdBudget();
  if (monthlyUsd <= 0) {
    return {
      neurons: _monthlyCloudflare.neurons,
      usdCost: _monthlyCloudflare.usdCost,
      usdBudget: 0,
      pctConsumed: 0,
      reservedNeurons: _monthlyCloudflare.reservedNeurons,
      reservedUsd: _monthlyCloudflare.reservedUsd,
    };
  }

  const pctConsumed = (_monthlyCloudflare.usdCost / monthlyUsd) * 100;
  const alertPct    = _alertPct();
  const hardstopPct = _hardstopPct();

  // v0.71.3 (audit Medium): 30/70/90 alert ladder. Each tier fires at
  // most once per month. legacy lastAlertMonth retained for backward compat.
  const af = _monthlyCloudflare.alertsFired;
  // T5-N2 (audit-2): send email FIRST, mark tier fired only on confirmed
  // delivery. Pre-fix: af[tier]=true before the Brevo call meant a Brevo
  // outage permanently silenced that tier — no retry possible.
  // Now: on rejection af[tier] stays false and the next recordNeurons()
  // call at the same threshold automatically retries.
  const fireAlert = (tier, label) => {
    if (af[tier]) return;
    _fireBudgetAlertEmail({
      month:        _monthlyCloudflare.month,
      usdCost:      _monthlyCloudflare.usdCost,
      usdBudget:    monthlyUsd,
      neurons:      _monthlyCloudflare.neurons,
      pctConsumed,
      hardstopPct,
      tier:         label,
    }).then(() => {
      af[tier] = true;
      _monthlyCloudflare.lastAlertMonth = _monthlyCloudflare.month;
    }).catch((e) => console.warn('[aiBudgetGuard] Brevo alert failed (will retry at next threshold):', e.message));
  };
  if (pctConsumed >= 90) fireAlert('ninety',  '90% (final warning)');
  else if (pctConsumed >= 70) fireAlert('seventy', '70% (mid)');
  else if (pctConsumed >= 30) fireAlert('thirty',  '30% (early)');

  if (pctConsumed >= hardstopPct) {
    _monthlyCloudflare.hardStopped = true;
    console.warn(
      `[aiBudgetGuard] Cloudflare monthly spend $${_monthlyCloudflare.usdCost.toFixed(2)} ` +
      `crossed ${hardstopPct}% of $${monthlyUsd}/mo — hard-stop engaged. ` +
      `Further CF calls will return 503 until 00:00 UTC on the 1st.`,
    );
  }

  return {
    neurons:         _monthlyCloudflare.neurons,
    usdCost:         _monthlyCloudflare.usdCost,
    usdBudget:       monthlyUsd,
    pctConsumed,
    reservedNeurons: _monthlyCloudflare.reservedNeurons,
    reservedUsd:     _monthlyCloudflare.reservedUsd,
  };
}


async function _fireDailyExhaustionEmail({ service, callsToday, budget, day }) {
  // Pass-6 W4 task #9: HF / Groq / Gemini / Tavily / Brevo daily-budget
  // exhaustion alert. Operator sees this so they can either raise the
  // budget or accept the soft-stop until 00:00 UTC.
  const to = process.env.BUDGET_GUARD_ALERT_EMAIL || process.env.SUPPORT_EMAIL || 'demofeedback@lapseiq.com';
  const subject = `[LapseIQ Demo] ${service} daily budget exhausted (${callsToday}/${budget}) for ${day}`;
  const html = `<div style="font-family:system-ui,sans-serif;padding:16px;border-left:4px solid #dc2626;background:#fef2f2">
  <h2 style="margin:0 0 12px;font-size:16px;color:#991b1b">${service} daily budget exhausted</h2>
  <p style="margin:0 0 8px">The shared demo <b>${service}</b> service has hit its daily call budget.</p>
  <p style="margin:0 0 8px">Calls today: <b>${callsToday}</b> &middot; Budget: <b>${budget}</b> &middot; Resets at 00:00 UTC.</p>
  <p style="margin:0 0 8px">Further demo AI calls that depend on ${service} will return 503 until reset. The cascade will route to fallback providers where available.</p>
  <p style="margin:0;font-size:12px;color:#64748b">Source: server/lib/aiBudgetGuard.js</p>
</div>`;
  try {
    const { sendEmail } = require('./email');
    await sendEmail({ to, subject, html });
  } catch (e) {
    console.warn(`[aiBudgetGuard] could not send daily-exhaustion email for ${service}: ${e.message}`);
  }
}

async function _fireBudgetAlertEmail({ month, usdCost, usdBudget, neurons, pctConsumed, hardstopPct, tier }) {
  // T6-N5 (audit-2): on self-host (DEMO_MODE !== 'true'), require an explicit
  // BUDGET_GUARD_ALERT_EMAIL. If absent, skip rather than forward to the
  // vendor inbox (demofeedback@lapseiq.com) — that was leaking AI-spend data.
  let to;
  if (process.env.DEMO_MODE === 'true') {
    to = process.env.BUDGET_GUARD_ALERT_EMAIL || process.env.SUPPORT_EMAIL || 'demofeedback@lapseiq.com';
  } else {
    to = process.env.BUDGET_GUARD_ALERT_EMAIL || process.env.SUPPORT_EMAIL;
    if (!to) {
      console.warn('[aiBudgetGuard] Budget alert triggered but BUDGET_GUARD_ALERT_EMAIL unset on self-host. ' +
        'Set it in .env so alerts reach you. Skipping email.');
      return;
    }
  }
  const subject = `[LapseIQ Demo] Cloudflare AI budget at ${pctConsumed.toFixed(1)}% for ${month}`;
  const html = `<div style="font-family:system-ui,sans-serif;padding:16px;border-left:4px solid #f59e0b;background:#fffbeb">
  <h2 style="margin:0 0 12px;font-size:16px;color:#92400e">Cloudflare Workers AI budget alert</h2>
  <p style="margin:0 0 8px">Demo instance has consumed <b>$${usdCost.toFixed(2)} of $${usdBudget}</b> (${pctConsumed.toFixed(1)}%) for ${month}.</p>
  <p style="margin:0 0 8px">Neuron count this month: <b>${neurons.toLocaleString()}</b></p>
  <p style="margin:0 0 8px">Hard-stop kicks in at ${hardstopPct}%; further CF AI calls will return 503 to demo visitors once tripped, until the budget resets 00:00 UTC on the 1st.</p>
  <p style="margin:0;font-size:12px;color:#64748b">Source: server/lib/aiBudgetGuard.js (v0.35.0)</p>
</div>`;
  try {
    const { sendEmail } = require('./email');
    await sendEmail({ to, subject, html });
  } catch (e) {
    console.warn(`[aiBudgetGuard] could not send alert email; logging instead. ${subject}`);
  }
}

function resetMonthlyCloudflare() {
  _rolloverMonthlyIfNeeded();
  _monthlyCloudflare.month           = _thisMonthUtc();
  _monthlyCloudflare.neurons         = 0;
  _monthlyCloudflare.usdCost         = 0;
  _monthlyCloudflare.reservedNeurons = 0;
  _monthlyCloudflare.reservedUsd     = 0;
  _monthlyCloudflare.hardStopped     = false;
  console.log(`[aiBudgetGuard] Cloudflare monthly budget reset for ${_monthlyCloudflare.month}`);
  return { month: _monthlyCloudflare.month };
}

function peek(service) {
  const svcRaw = service == null ? 'gemini' : String(service).toLowerCase();

  if (svcRaw === 'cloudflare') {
    _rolloverMonthlyIfNeeded();
    const monthlyUsd = _monthlyUsdBudget();
    return {
      service:         'cloudflare',
      month:           _monthlyCloudflare.month,
      neurons:         _monthlyCloudflare.neurons,
      usdCost:         _monthlyCloudflare.usdCost,
      reservedNeurons: _monthlyCloudflare.reservedNeurons,
      reservedUsd:     _monthlyCloudflare.reservedUsd,
      usdBudget:       monthlyUsd,
      pctConsumed:     monthlyUsd > 0 ? (_monthlyCloudflare.usdCost / monthlyUsd) * 100 : 0,
      // v0.36.7: include in-flight in the effective pct so the admin UI
      // shows the same view the hardstop gate uses.
      pctEffective:    monthlyUsd > 0 ? (_cloudflareEffectiveUsd() / monthlyUsd) * 100 : 0,
      alertPct:        _alertPct(),
      hardstopPct:     _hardstopPct(),
      hardStopped:     _monthlyCloudflare.hardStopped,
    };
  }

  const svc = _normalizeService(svcRaw);
  _rolloverDailyIfNeeded(svc);
  return { service: svc, day: _dailyState[svc].day, callsToday: _dailyState[svc].calls, budget: _dailyBudgetFor(svc) };
}

function peekAll() {
  const out = Object.fromEntries(Object.keys(DAILY_SERVICES).map((s) => [s, peek(s)]));
  out.cloudflare = peek('cloudflare');
  return out;
}

function ensureAiBudget(req, res, service) {
  let svc;
  if (service) {
    svc = service;
  } else if ((process.env.AI_PROVIDER || '').toLowerCase() === 'cloudflare') {
    svc = 'cloudflare';
  } else {
    svc = 'gemini';
  }

  const result = checkAndConsume(svc);
  if (result.ok) return true;

  const errorCode = svc === 'cloudflare'
    ? 'ai_demo_monthly_budget_exhausted'
    : (svc === 'gemini' ? 'ai_demo_budget_exhausted' : `${svc}_demo_budget_exhausted`);

  let friendly;
  if (svc === 'cloudflare') {
    friendly = 'The shared demo AI monthly budget is exhausted. Demo AI features will return at 00:00 UTC on the 1st of next month. To remove all caps, self-host LapseIQ with your own AI key — https://lapseiq.com/install';
  } else if (svc === 'gemini') {
    friendly = 'The shared demo AI budget is exhausted for today. Demo AI features will return at 00:00 UTC. To keep going right now, self-host LapseIQ on your own infrastructure — install instructions at https://lapseiq.com/install.';
  } else {
    friendly = `The shared demo ${svc} budget is exhausted for today. It will return at 00:00 UTC. To keep going right now, self-host LapseIQ on your own infrastructure — install instructions at https://lapseiq.com/install.`;
  }

  const resetAt = svc === 'cloudflare'
    ? (() => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + 1, 1); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); })()
    : new Date(Math.floor(Date.now() / UTC_MIDNIGHT_MS + 1) * UTC_MIDNIGHT_MS).toISOString();

  res.status(503).json({
    success: false,
    error:   errorCode,
    message: friendly,
    data: {
      service:    svc,
      callsToday: result.callsToday || 0,
      budget:     result.budget,
      monthly:    result.monthly || null,
      resetAt,
    },
  });
  return false;
}


// v0.69.0 (audit Medium "Renewal Alert Rule Auditor"): persist the
// monthly counters to AccountSetting so a pm2 restart mid-day doesn't
// reset the daily/monthly cap. On boot, rehydrate from the latest
// persisted values for the current month. Best-effort -- failures log
// + fall back to in-memory state.
const _PERSIST_KEY = 'ai_budget_counters_v1';
const _PERSIST_FILE = require('path').join(
  process.env.DATA_DIR || require('path').join(__dirname, '..', '..', 'data'),
  'ai_budget_counters.json'
);
let _persistWarnedOnce = false;
let _prismaForPersist = null;
function _getPrisma() {
  if (_prismaForPersist) return _prismaForPersist;
  try { _prismaForPersist = require('./prisma').default; return _prismaForPersist; }
  catch { return null; }
}

async function persistMonthlyCounters() {
  const prisma = _getPrisma();
  if (!prisma) return;
  try {
    // The current model is process-global (no per-account scoping for the
    // in-memory counters) -- we persist under accountId='__global__' which
    // any operator can read but no Account FK points at it. If/when we
    // move to per-account counters, this key becomes accountId-specific.
    const payload = JSON.stringify({
      monthly: _monthlyCloudflare,
      daily:   _dailyState,
      ts:      new Date().toISOString(),
    });
    await prisma.accountSetting.upsert({
      where:  { accountId_key: { accountId: '__global__', key: _PERSIST_KEY } },
      update: { value: payload },
      create: { accountId: '__global__', key: _PERSIST_KEY, value: payload },
    });
  } catch (e) {
    // DB persist fails when AccountSetting FK has no matching account (__global__ sentinel).
    // Fall back to file-based persist so counters survive restarts. Log once only.
    if (!_persistWarnedOnce) {
      console.warn('[aiBudgetGuard] DB persist unavailable (FK), switching to file fallback:', e.message);
      _persistWarnedOnce = true;
    }
    try {
      const fs = require('fs');
      fs.mkdirSync(require('path').dirname(_PERSIST_FILE), { recursive: true });
      fs.writeFileSync(_PERSIST_FILE, JSON.stringify({
        monthly: _monthlyCloudflare, daily: _dailyState, ts: new Date().toISOString(),
      }));
    } catch (_) { /* file write also failed; counters remain in-memory only */ }
  }
}

async function rehydrateOnBoot() {
  const prisma = _getPrisma();
  if (!prisma) return;
  try {
    const row = await prisma.accountSetting.findUnique({
      where: { accountId_key: { accountId: '__global__', key: _PERSIST_KEY } },
    });
    if (!row || !row.value) return;
    const parsed = JSON.parse(row.value);
    if (parsed.monthly && typeof parsed.monthly.month === 'string') {
      Object.assign(_monthlyCloudflare, parsed.monthly);
      // S4-FN-03 (v0.74.0): zero stale reservations from crash — in-flight calls killed
      // by a crash leave phantom reserved counters that bleed into the new session.
      _monthlyCloudflare.reservedNeurons = 0;
      _monthlyCloudflare.reservedUsd     = 0;
      // CR-2 (audit-2): guard alertsFired after Object.assign. Pre-v0.71.3
      // persisted state won't have alertsFired; on upgrade the Object.assign
      // leaves it undefined, breaking af[tier] access in recordNeurons.
      if (typeof _monthlyCloudflare.alertsFired !== 'object' || !_monthlyCloudflare.alertsFired) {
        _monthlyCloudflare.alertsFired = { thirty: false, seventy: false, ninety: false };
      } else {
        _monthlyCloudflare.alertsFired.thirty  ??= false;
        _monthlyCloudflare.alertsFired.seventy ??= false;
        _monthlyCloudflare.alertsFired.ninety  ??= false;
      }
    }
    if (parsed.daily && typeof parsed.daily === 'object') {
      for (const k of Object.keys(parsed.daily)) {
        if (_dailyState[k]) Object.assign(_dailyState[k], parsed.daily[k]);
      }
    }
    console.log('[aiBudgetGuard] rehydrated counters from AccountSetting (persisted at', parsed.ts, ')');
  } catch (e) {
    console.warn('[aiBudgetGuard] rehydrate error (non-fatal, starting fresh):', e.message);
  }
}

// Run rehydrate on first require. Fire-and-forget; consumers may hit the
// guard before rehydrate finishes -- they'll see the in-memory zero state
// for those few ms which is fine (cap can't be violated; just a brief
// undercount).
rehydrateOnBoot().catch(() => {});

module.exports = {
  checkAndConsume,
  peek,
  peekAll,
  ensureAiBudget,
  recordNeurons,
  // v0.36.7: reservation primitives for the TOCTOU-safe pattern.
  reserveCloudflareSpend,
  releaseReservation,
  resetMonthlyCloudflare,
  persistMonthlyCounters,
  rehydrateOnBoot,
};

export {};
