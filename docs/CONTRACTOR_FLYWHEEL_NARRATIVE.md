# The Contractor Flywheel — why a buyer purchases the channel, not the software

**Date:** 2026-06-11 · Companion to `docs/research/2026-06-11-easy-button-northstar-recommendations.md` (gem R5).

## The one-sentence thesis

ServiceCycle is not (only) facilities software sold one logo at a time. It is a **two-sided channel**: a NETA electrical-service contractor onboards their own facility customers using the reports they *already* produce, and every downstream signal — quote requests, modernization spend, renewal evidence — flows back to that contractor as pipeline. An acquirer (an OEM service network, a large NETA firm, a distributor) is buying that **motion and its installed base**, not a feature list.

## The loop (each step is already built)

1. **Onboard.** A contractor invites a facility from the Fleet Dashboard (`POST /api/fleet/invites` → `partnerInvitePublic` accept → `account.partnerOrgId` set). The facility's own test reports become the seed data — the moat is that data-in is free to the customer because the contractor already holds it (see gem R1, PDF report ingest).
2. **Program.** Imported assets auto-apply a baselined NFPA 70B program (gem N5), so the facility goes from a spreadsheet to a live compliance posture in minutes, and Path-to-100 (gem N2) shows exactly what's missing.
3. **Quote back.** The facility sends quote requests with a full asset dossier and EMERGENCY "call-now" mode (`quoteRequests.ts`); a `QUOTE_REQUEST_CREATED` partner event lands in the contractor's Fleet inbox (`partnerEvents.ts` → `GET /api/fleet/inbox`), routed to the assigned service rep (`Account.assignedRepId`).
4. **Pipeline.** The contractor sees a fleet-wide 3-year modernization forecast (`GET /api/fleet/forecast`, assets with `modernizationRiskScore ≥ 0.50` bucketed by year) — their CapEx sales pipeline — and leaves behind a one-page "what we found / what we fixed / what to budget for" PDF (`leaveBehind.ts`) that doubles as the next onboarding hook.

The loop compounds: more reports ingested → richer programs → more quote requests + clearer modernization forecasts → more work won → more facilities onboarded.

## Why this is the acquisition story

- **You acquire distribution, not just ARR.** Each contractor brings N facilities. CAC collapses because the contractor — not ServiceCycle — does the onboarding, and does it during work they're already paid for (the inspection walk, the report hand-off).
- **The data-in moat is structural, not incidental.** Competitor "Gimba" died because data entry wasn't worth the customer's time. Here the *contractor's* existing deliverable is the input. PowerDB *produces* those reports but has no compliance/action layer and no incentive to build the back-channel. Neither side of the market is served end-to-end by an incumbent.
- **Regulatory tailwind monetized as recurring value.** NFPA 70B's 2023 "should→shall" shift means insurers and OSHA now ask for the EMP at renewal; the contractor becomes the facility's program-of-record supplier, with hash-chained audit evidence no test-data tool can match.
- **Two-sided lock-in.** Facilities stay for always-on compliance + the easy buttons; contractors stay because the fleet view *is* their book of business. Switching costs accrue on both sides.

## What shipped to make the flywheel first-class (this sprint)

- **Fleet Dashboard now names the motion**: a `FlywheelExplainer` hero (Onboard → Program → Quote → Pipeline) with direct entry points to the invite flow and the quote-request inbox, so the onboarding path is the first thing a contractor sees — not buried behind tabs.
- The supporting machinery already existed and is referenced above; R5 was a *positioning* gem (make the loop obvious + frame the sale), not a rebuild.

## The "who acquires us and why" slide

> A buyer with an existing field-service network plugs their contractors into ServiceCycle and instantly converts every report they hand a customer into an onboarding event, every emergency into a routed quote, and every aging asset across the fleet into a forecasted modernization sale. They are not buying maintenance software. They are buying the channel that turns the unread EMP report — the document nobody reads — into a recurring, two-sided revenue loop.
