# The two-sided model — how facilities and contractors both win

**Date:** 2026-06-11 · Companion to `docs/research/2026-06-11-easy-button-northstar-recommendations.md` (gem R5). Internal positioning note.

## The point

ServiceCycle serves two people who need each other: the **facility** that has to stay compliant and keep its electrical equipment running, and the **NETA contractor** that already inspects and services that equipment. The product is built so that helping one helps the other — without ever making the facility feel like it's being sold to. The facility's experience is, and stays, about compliance and tracking. The contractor relationship runs alongside it, on a separate surface, and only ever surfaces to the facility when the *facility* reaches for it.

## What the facility gets (the only thing they should feel)

A facility owner opens ServiceCycle to answer one question: *am I compliant, and what do I need to fix?* That's the whole job. Their reports become a live NFPA 70B program, Path-to-100 shows exactly what's missing, the outage planner turns a shutdown date into a work list, and the test reports their contractor already emails them become a fix list instead of a 200-page PDF nobody reads. Nothing on the facility's screens asks them for money or steers them toward spend. If their gear is failing and *they* decide they want a quote, the button is there — but it's theirs to press.

## What the contractor gets (on their own surface — the Fleet Dashboard, oem_admin only)

The pieces a contractor needs to serve a book of facilities well: a fleet view of where attention is needed, an inbox of the quote requests facilities chose to send, a leave-behind summary after each visit, and a reliability/replacement outlook so they can help customers plan ahead instead of reacting to failures. None of this renders on a facility user's screen — it lives behind the `oem_admin` role.

## Why the two sides reinforce each other

1. **Onboard.** A contractor invites a facility (`POST /api/fleet/invites`); the facility's own test reports seed the program — data-in is free to the customer because the contractor already holds it.
2. **Program.** Imported assets get a baselined NFPA 70B program automatically (gem N5); Path-to-100 (gem N2) shows what's left.
3. **Customer-initiated quotes.** When a facility *chooses* to request work, a full asset dossier (with EMERGENCY call-now mode) reaches the contractor's inbox (`quoteRequests.ts` → `partnerEvents.ts`).
4. **Plan ahead, not upsell.** The contractor sees an end-of-life reliability outlook and can help the facility budget on its own schedule — framed as reliability risk, not a sales pitch.

The loop compounds in a way that's good for the customer: more reports ingested → richer programs → clearer compliance and earlier warning of failing equipment. The contractor's pipeline is a *byproduct* of doing right by the facility, not a tax on it.

## The wall (non-negotiable)

The facility view answers compliance and tracking. The channel — pipeline, forecasts framed as spend, the flywheel itself — lives behind the `oem_admin` gate or is customer-initiated, and never on a facility user's screen. See `docs/DESIGN_PRINCIPLE_customer-vs-channel.md`. Why competitor "Gimba" struggled is instructive: the burden a tool puts on the customer, and the sense that it's working an angle on them, is what erodes trust. The model only works because it's customer-aligned first.
