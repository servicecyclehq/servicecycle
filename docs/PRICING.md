# ServiceCycle — Pricing Architecture

**Classification:** Confidential / Internal  
**Status:** Draft — not yet publicly listed  
**Updated:** 2026-06-25

This document describes the SaaS pricing model design. It is intended for
internal planning and acquisition diligence, not external communication.

---

## Pricing model

ServiceCycle is sold to **electrical contractors** (the primary user) as a
per-location SaaS subscription. The contractor's customers — the facilities
they service — are not separately billed; the contractor pays for their
portfolio.

The core pricing unit is a **managed site** (a customer facility where
equipment is tracked). This aligns the contractor's cost with their contract
value: a contractor who grows their book of business pays proportionally more.

### Tier structure (target)

| Tier | Target | Managed sites | Arc flash | Multi-OpCo | SSO | API |
|---|---|---|---|---|---|---|
| **Starter** | 1–5 person shop | Up to 10 | ✅ | — | — | — |
| **Professional** | Mid-size contractor | Up to 50 | ✅ | — | — | ✅ |
| **Enterprise** | Multi-branch / PE roll-up | Unlimited | ✅ | ✅ | ✅ | ✅ |

Annual billing; monthly available at +20%.

### Add-ons (target)

- **Field labor seats** (field_tech role): per-seat above base plan
- **OEM / partner org**: white-label portal access for testing contractors
  who resell the platform to their own customers
- **BYO AI key**: cost pass-through model; customer brings their own
  Anthropic/Google key for AI features

---

## Unit economics design

**Why location-based pricing:**
- Aligns with how contractors quote and price their own services (per-facility contracts)
- Creates natural expansion revenue as a contractor grows their portfolio
- Mirrors the incumbent model (inspection contracts are per-facility, per-year)
- Avoids "per-asset" granularity that is hard to track during onboarding

**Why not per-seat:**
- A contractor firm may have 3 admins and 20 field techs — seat-based pricing
  disadvantages the field-tech-heavy model
- Location count correlates more directly with contractor revenue than seat count

**Gross margin:**
- No per-seat COGS at scale (server is single-tenant per account on shared infra)
- AI call costs are the main variable COGS; partially offset by BYO-key add-on
- Target: 80%+ gross margin at 50+ accounts

---

## Current billing infrastructure

Stripe is integrated as a dependency (`stripe` npm package, v22.x) but billing
is **not yet activated** on the demo environment. The integration is provisioned
and ready to activate; no customer payment data is stored.

Activation path:
1. Create Stripe products + prices matching the tier structure above
2. Wire `stripe.subscriptions.create` on account provisioning
3. Add Stripe customer portal link to `/settings/billing`
4. Add webhook handler at `POST /api/webhooks/stripe` for `invoice.paid` /
   `customer.subscription.deleted` events

Estimated activation time: 1–2 days engineering.

---

## OEM licensing model (acquisition upside)

For an OEM acquirer, the SaaS subscription model can be replaced or
supplemented with an **OEM seat license** — a per-instrument or per-fleet
fee charged to the OEM's own customers who use the OEM's test instruments.

This is the "data atlas" upside described in `docs/ACQUISITION_BRIEF.md`:
the OEM gains a cross-fleet telemetry platform as a value-add to their
instrument sales, and ServiceCycle's subscription revenue is replaced by
a higher-margin recurring software attachment to hardware sales.

---

## Pricing signals from the market

- MaintainX Professional: ~$21/user/month (horizontal CMMS, no electrical domain)
- UpKeep Business: ~$75/user/month
- ABB ESAP / Schneider EcoStruxure: enterprise contract pricing (often $50K+/year)
- PowerDB Pro: ~$200–500/user/year (test-data recording only)

ServiceCycle targets a price point between PowerDB (narrower scope) and
OEM enterprise software (broader scope), at a contractor-palatable ARR per
managed account. A $500–2,000/year per contractor account is defensible at
the Starter tier; $5,000–20,000/year for Enterprise multi-site accounts.

---

*This document reflects the intended pricing architecture. Actual pricing
should be set in collaboration with sales and updated before any public
launch. Prospective acquirers should validate pricing assumptions through
their own market diligence.*
