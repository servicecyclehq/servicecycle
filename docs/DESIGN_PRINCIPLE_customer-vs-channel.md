# Design principle — the customer/channel wall

**Status:** binding design rule · **Date:** 2026-06-11

ServiceCycle has two audiences in one codebase: the **facility** (the customer — roles `admin` / `manager` / `viewer` / `consultant` within an account) and the **contractor / partner** (the channel — role `oem_admin`, with cross-account fleet visibility). These two experiences must never bleed together on screen.

## The rule

1. **Every customer-facing surface answers one question: "am I compliant, and what do I need to fix?"** Compliance status, tracking, action lists, schedules, deficiencies, audit evidence. That is the job. If an element on a facility user's screen does not help them get compliant or know what to do next, it does not belong there.

2. **Money is customer-initiated or it is not on the customer's screen.** A facility may *choose* to request a quote (their equipment is failing and they decide they want help) — that button is theirs to press. The product never pushes spend, never leads with a dollar figure, never shows the facility a "pipeline" or "flywheel." Anything that projects spend (e.g. replacement budgets) is framed as **reliability/compliance risk first**, with dollars as a clearly-labeled secondary planning estimate — never the headline.

3. **Channel features live behind the `oem_admin` gate.** The Fleet Dashboard, the flywheel explainer, the quote-request pipeline/inbox, fleet-wide modernization forecasts framed as sales pipeline — these are contractor tools. They render only for `oem_admin`. A facility user must never load them.

4. **Internal business framing stays internal.** Acquisition / "sell-the-company" / "purchase the channel" language belongs in private strategy notes, not in product copy and not in repo docs that set team culture. Position the two-sided model as mutual customer+contractor value.

## How to check yourself

Before shipping anything to a facility-facing surface, ask: *would a facility manager, sitting at their own desk worried about an OSHA visit, feel this is helping them — or feel they're being worked?* If there's any doubt, it's a channel feature; gate it or make it customer-initiated.

## Current state (2026-06-11)

- ✅ `FlywheelExplainer` renders only in `FleetDashboard.jsx`, gated `RequireRole roles={['oem_admin']}` (App.jsx). Facility users never see it.
- ✅ `CapExForecastPanel` (customer Dashboard) reframed to lead with reliability/end-of-life risk (asset counts), dollars demoted to a secondary "budget planning estimate."
- ✅ Path-to-100, outage planner, import action-lists, condition card — all compliance/operations, no spend framing.
- ⚠️ Watch list: quote-request entry points on customer surfaces are fine *because they are customer-initiated* — keep them that way; never auto-prompt or nudge.
