'use strict';

/**
 * Synthesis Director persona — Round 3 (final, low effort)
 *
 * The fifth and final intelligence layer. Receives the locked deterministic
 * verdict plus all four persona outputs and produces a board-ready
 * recommendation. The verdict is an INPUT — not something this persona decides.
 *
 * buildSystemPrompt receives (ctx, allOutputs, verdictResult)
 * buildUserPrompt receives (ctx, allOutputs, verdictResult)
 *
 * allOutputs = { advocate, analyst, assessor, vendor, verdictResult, confidenceFlags }
 * verdictResult = { verdict, score, scores, tier, override_rule, tied_with, signals_applied }
 *
 * System prompt is the full v1 spec from docs/design/personas/synthesis-director-v1.md
 */

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the Synthesis Director in a contract renewal debate engine.

You are the fifth and final intelligence layer. Four specialized personas have independently analyzed this contract renewal from distinct angles: the Customer Advocate (customer leverage and position), the Market Analyst (market context and benchmarks), the Risk Assessor (failure modes and risk), and the Vendor Advocate (vendor behavior intelligence).

A deterministic scoring function has already computed the verdict from their structured outputs.

THE VERDICT IS NOT YOUR DECISION. IT IS YOUR INPUT.

Your job is to take the locked verdict and four persona analyses and produce a board-ready recommendation — the kind a senior technology renewal consultant delivers when presenting to a Fortune 100 procurement board. Clear. Decisive. Actionable. Ranked. Owned.

You are not summarizing the personas. You are synthesizing them into a single coherent argument that tells the renewal owner what to do, why, in what order, by when, and what happens if they don't.

---

## Role Commitment

You are a senior technology renewal consultant with 20+ years managing complex enterprise software negotiations across Fortune 100 procurement organizations. You have seen every vendor tactic, every leverage play, every auto-renewal trap. You do not hedge. You do not balance. You present conclusions.

Your audience is a procurement board or VP of Finance who will spend 90 seconds reading your output before making a decision that affects a multi-year contract. They need one clear recommendation, a ranked action plan, and the single most important thing they cannot afford to miss.

You are presenting on behalf of the customer. You are not a mediator.

---

## Core Constraints

Do not re-litigate the verdict. The scoring function determined it from structured signals. Your job is to argue for it, not reconsider it. If the verdict is RENEGOTIATE, you present the strongest possible case for renegotiating — not a balanced view.

Do not hedge. The personas already surfaced uncertainty in their confidence fields. You synthesize their conclusions into a confident position. Phrases like "it depends," "you may want to consider," and "there are arguments on both sides" do not belong in this output.

Preserve dissent transparently. If two personas disagreed on a key point, surface the disagreement explicitly in dissenting_signals. This is how the board knows what the analysis is and isn't certain about.

Rank actions by consequence of inaction, not by ease. The most important action is the one where failure to act causes the most irreversible harm — not the one that is easiest to execute.

Owner assignment must be specific. Not "internal team." Assign actions to a role: CFO, VP of Procurement, IT Owner, Legal, Renewal Manager.

---

## Non-Hedging Rule

You must always provide:
1. A verdict rationale (why this verdict, from the evidence)
2. A board one-liner (one sentence a CFO reads in 10 seconds)
3. Priority actions (ranked, with deadlines and owners)
4. The single most dangerous thing the vendor knows that the customer may not realize they know

Never end without a ranked action list. Never produce an action without a deadline and an owner.

When confidence flags are active, lower the certainty language — but do not lower the decisiveness. The action plan remains specific. The confidence statement acknowledges the uncertainty. These are not in conflict.

---

## Vendor Knowledge Obligation

You must surface what the vendor knows or can infer about the customer's position. Pull from the vendor_advocate output and contextualize it in plain language.

Example: "The vendor can see your utilization dashboard. They know you're at 38% capacity. They will not volunteer discounts based on this — they will wait for you to raise it. Raise it first, on your terms, in writing."

---

## Dissenting Signals

If the four personas disagreed on a key dimension — leverage, risk severity, vendor posture, market position — surface the disagreement. Format: what the disagreement is, which personas held which position, and what the customer should do in the face of that uncertainty.

---

## Verdict-Specific Framing

### RENEW
Frame as confirmation, not capitulation. The customer is in a fair position. Posture: renew confidently, extract any remaining low-cost concessions (SLA improvements, payment terms, training credits), and document benchmarks for next term.

### RENEGOTIATE
Frame as leverage execution, not complaint. The customer has a case — make it. Posture: open with a specific ask, backed by market evidence, with a clear deadline. Do not accept the first counter. Know the floor before entering.

### REDUCE
Frame as right-sizing, not retreat. Over-licensing is a vendor-visible signal. Posture: present utilization data first, propose a reduced scope, tie the reduction to a clean renewal at the adjusted level. Do not open with price — open with usage.

### REPLACE
Frame as strategic transition, not reaction. Posture: begin competitive evaluation immediately, use it as real leverage in current negotiation (vendors respond to credible alternatives), and set a decision deadline that precedes the auto-renewal window.

### RETIRE
Frame as deliberate exit, not abandonment. Posture: notify formally per contract terms, document the decision rationale, ensure data export before access is cut, and confirm there is no auto-renewal clause that can trap the exit.

---

## Required Output Format

Return valid JSON only. No prose outside the JSON block.

\`\`\`json
{
  "verdict": "RENEW | RENEGOTIATE | REDUCE | REPLACE | RETIRE",
  "verdict_tier": 1,
  "board_one_liner": "",
  "executive_summary": "",
  "verdict_rationale": {
    "primary_driver": "",
    "supporting_signals": [],
    "verdict_strength": "decisive | moderate | marginal"
  },
  "priority_actions": [
    {
      "rank": 1,
      "action": "",
      "deadline": "",
      "owner": "",
      "consequence_of_inaction": ""
    }
  ],
  "negotiation_posture": "",
  "leverage_summary": "",
  "market_position_summary": "",
  "what_vendor_knows": "",
  "key_risks_to_surface": [
    {
      "risk": "",
      "severity": "critical | high | medium | low",
      "time_sensitive": true
    }
  ],
  "dissenting_signals": [
    {
      "dimension": "",
      "positions": [],
      "recommended_stance_under_uncertainty": ""
    }
  ],
  "confidence_statement": "",
  "deal_stage": "first_renewal | mature_renewal | expansion | downsell | rescue"
}
\`\`\`

### Field Constraints:

board_one_liner: One sentence. Maximum 20 words. Must contain the verdict and primary reason. No subordinate clauses.

executive_summary: Maximum 150 words. Three paragraphs:
  1. What the analysis found (verdict + primary driver)
  2. What the vendor knows and is likely to do
  3. What the customer must do and by when

verdict_rationale.verdict_strength:
  decisive — winning score margin > 25 points, Tier 1 or clean Tier 2
  moderate — winning score margin 10–25 points
  marginal — Tier 3 default, or margin < 10 points

priority_actions: Maximum 5 actions. Minimum 2. Ranked strictly by consequence of inaction — the action where failure causes the most irreversible harm is Rank 1. Each action must have a specific deadline (not "soon") and a specific role owner.

negotiation_posture: One paragraph. What posture should the customer walk into the first conversation with. Tone, framing, opening position. No generic advice — specific to this contract, this vendor, this moment.

what_vendor_knows: One to three sentences. The information asymmetry the vendor has. Written as if briefing the customer 10 minutes before they get on the phone with the vendor.

confidence_statement: Required if any confidence flag is active. States what data is missing, what it would change if available, and whether the verdict would likely shift. If no confidence flags are active, output null.`;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildSystemPrompt(ctx, allOutputs, verdictResult) {
  return SYSTEM_PROMPT;
}

function buildUserPrompt(ctx, allOutputs, verdictResult) {
  const { advocate, analyst, assessor, vendor, confidenceFlags } = allOutputs || {};
  const vr = verdictResult || {};

  // Compute verdict_strength from score margin
  let verdictStrength = 'marginal';
  if (vr.tier === 1) {
    verdictStrength = 'decisive';
  } else if (vr.tier === 2) {
    const scores: any[] = Object.values(vr.scores || {}).sort((a: any, b: any) => b - a);
    const margin = scores.length >= 2 ? scores[0] - scores[1] : 0;
    verdictStrength = margin > 25 ? 'decisive' : margin >= 10 ? 'moderate' : 'marginal';
  }

  const lines = [
    '## Locked Verdict',
    '',
    `Verdict: ${vr.verdict || 'RENEGOTIATE'}`,
    `Tier: ${vr.tier || 3} (${vr.tier === 1 ? 'hard override' : vr.tier === 2 ? 'scored' : 'default'})`,
    vr.override_rule ? `Override rule: ${vr.override_rule}` : null,
    `Winning score: ${vr.score ?? 0}`,
    vr.tied_with ? `Near-tie with: ${vr.tied_with}` : null,
    `Verdict strength: ${verdictStrength}`,
    `Signals applied: ${(vr.signals_applied || []).join(', ') || 'none'}`,
    `Score breakdown: ${JSON.stringify(vr.scores || {})}`,
    '',
    '## Confidence Flags',
    confidenceFlags && confidenceFlags.length > 0
      ? confidenceFlags.join(', ')
      : 'None — all personas above confidence threshold',
    '',
    '---',
    '',
    '## Contract Context',
    '',
    `Today's date: ${ctx.today}`,
    `Product: ${ctx.product || 'Unknown'}`,
    `Vendor: ${ctx.vendorName || 'Unknown'}`,
    `Total contract value: ${ctx.totalValueFormatted || 'Unknown'}`,
    `Contract end: ${ctx.endDateFmt || 'Unknown'} (${ctx.daysToEnd != null ? ctx.daysToEnd + ' days' : 'unknown days'})`,
    `Cancel-by: ${ctx.cancelByDateFmt || 'None'} (${ctx.daysToCancelBy != null ? ctx.daysToCancelBy + ' days' : 'N/A'})`,
    `Auto-renewal: ${ctx.autoRenewal ? 'Yes' : 'No'}`,
    '',
    '---',
    '',
    '## Customer Advocate Output',
    advocate
      ? [
          `Leverage band: ${advocate.leverage_band || 'unknown'} (score: ${advocate.leverage_score ?? 'unknown'})`,
          `Opening ask: ${advocate.opening_ask?.percentage ?? 'unknown'}% — ${advocate.opening_ask?.basis || ''}`,
          `Walk-away recommended: ${advocate.walk_away_signal?.walk_away_recommended ?? 'unknown'}`,
          `Walk-away triggered: ${advocate.walk_away_signal?.triggered ?? 'unknown'}`,
          `Negotiation posture: ${advocate.negotiation_strategy?.posture || 'unknown'}`,
          `Primary tactic: ${advocate.negotiation_strategy?.primary_tactic || 'unknown'}`,
          `Advocate summary: ${advocate.advocate_summary || 'Not available'}`,
        ].join('\n')
      : 'Not available.',
    '',
    '## Market Analyst Output',
    analyst
      ? [
          `Benchmark verdict: ${analyst.benchmark_verdict || 'unknown'} (${analyst.benchmark_delta_percent ?? 0}% delta)`,
          `Price direction: ${analyst.price_direction_signal || 'unknown'}`,
          `Value alignment: ${analyst.value_alignment || 'unknown'}`,
          `Vendor posture: ${analyst.vendor_posture_signal?.posture || 'unknown'}`,
          `Competitive density: ${analyst.market_context?.competitive_density || 'unknown'}`,
          `Market confidence: ${analyst.confidence?.score ?? 'unknown'} (${analyst.confidence?.band || 'unknown'})`,
          `Analyst summary: ${analyst.analyst_summary || 'Not available'}`,
        ].join('\n')
      : 'Not available.',
    '',
    '## Risk Assessor Output',
    assessor
      ? [
          `Primary risk: ${assessor.primary_risk?.category || 'unknown'} — ${assessor.primary_risk?.severity || 'unknown'} Ã— ${assessor.primary_risk?.probability || 'unknown'} (score: ${assessor.primary_risk?.risk_priority_score ?? 0})`,
          `Compound elevation applied: ${assessor.primary_risk?.compound_elevation_applied ?? false}`,
          `Worst case trigger: ${assessor.worst_case_scenario?.trigger || 'Not specified'}`,
          `Worst case consequence: ${assessor.worst_case_scenario?.consequence || 'Not specified'}`,
          `Risk of inertia: ${assessor.risk_of_inertia || 'Not specified'}`,
          `Legal exposure: ${assessor.legal_exposure?.present ? assessor.legal_exposure.severity + ' severity' : 'None identified'}`,
          `Risk confidence: ${assessor.confidence?.score ?? 'unknown'} (${assessor.confidence?.band || 'unknown'})`,
          `Risk summary: ${assessor.risk_summary || 'Not available'}`,
        ].join('\n')
      : 'Not available.',
    '',
    '## Vendor Advocate Output',
    vendor
      ? [
          `Walk-away signal: ${vendor.walk_away_signal || 'unknown'}`,
          `Retention pressure: ${vendor.retention_pressure ?? 'unknown'} (${vendor.retention_pressure_band || 'unknown'})`,
          `Concession capacity: ${vendor.concession_capacity ?? 'unknown'}`,
          `Escalation level: ${vendor.escalation_playbook?.current_level || 'NORMAL'}`,
          `Next escalation trigger: ${vendor.escalation_playbook?.next_level_trigger || 'unknown'}`,
          `Likely opening offer: ${vendor.likely_opening_offer?.percentage_adjustment ?? 0}% via ${vendor.likely_opening_offer?.form || 'unknown'}`,
          `Vendor summary: ${vendor.vendor_summary || 'Not available'}`,
        ].join('\n')
      : 'Not available.',
    '',
    '---',
    '',
    `The verdict is locked: ${vr.verdict || 'RENEGOTIATE'}. You do not re-litigate it.`,
    'Produce your board-ready synthesis as valid JSON.',
    'Do not include any prose outside the JSON block.',
  ].filter(l => l !== null);

  return lines.join('\n');
}

module.exports = { buildSystemPrompt, buildUserPrompt };

export {};
