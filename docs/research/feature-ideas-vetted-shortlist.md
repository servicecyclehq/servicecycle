# Vetted feature shortlist — from the 5-AI competitor/ideation pass

Scope: **NFPA 70B only** (the optional NETA/IEEE/70E modules are out of scope here).
Source: five independent AI runs of `competitor-research-prompt.md`. This doc is my
vetting of their ~60 raw ideas against what ServiceCycle (SC) actually ships today
and what's already on the roadmap.

Tags: **HAVE** (already shipped) · **ENHANCE** (extends something built) ·
**NET-NEW** · **ROADMAP** (already planned/gated) · **DROP** (off-strategy).
Lens: BUYER (contractor pipeline / customer interactions) · CUSTOMER (save money /
pass audits / stay compliant / stay documented) · BOTH. Effort: S / M / L.

---

## Strategic takeaway (validated by people who'd never seen SC)
All five runs independently landed on the same open lane: **excellent facility
compliance AND excellent contractor revenue at the same time.** They peg Gimba as
strong-compliance/weak-revenue and Egalvanic as strong-revenue/diluted-compliance,
with the "both" quadrant empty. That is exactly SC's thesis — outside confirmation
you're aimed at the right gap.

Competitor intel worth acting on: **Egalvanic** is the real one to study (named by
3 of 5, closest to the contractor-revenue angle). Others named: EPM480, MaintainX,
ETAP, eMaint/Fluke, Limble, Condoit. "PowerPro 360" looks hallucinated.

---

## Don't chase — SC already ships these (the AIs couldn't know)
| AI idea | SC status |
|---|---|
| Automated IR ΔT severity engine | **HAVE** — thermography ingest (NETA 100.18 bands) |
| DGA / Duval gas-trend engine | **HAVE** — DGA ingest (IEEE C57.104) |
| Asset end-of-life / "Healthspan" | **HAVE** — RUL + modernization-risk scoring |
| Boardroom mode / exec views | **HAVE** — CFO report + customer digest |
| Contractor "opportunity radar" / multi-site rollups | **HAVE** — Fleet path-to-100 |
| Contractor-branded customer output | **HAVE (partial)** — partner co-branding + share links |
| Electrical shutdown planner | **HAVE (partial)** — Outage Consolidation Planner |
| Audit "cold storage" / immutable evidence | **HAVE** — SHA-256 snapshots + auditor share links |
| Peer benchmark network / "bottom 20%" | **Split (revised)** — Tier 1 (vs-standard) + Tier 2 (contractor portfolio) are now in the shortlist below and need NO bought data and NO consent. Tier 3 (cross-network anonymized pool) stays parked behind #31's consent model. |
| Offline-first field ops | **ROADMAP** — your PWA #19 |

## Drop — off-strategy (70E / coordination / engineering-sim, not 70B)
AR arc-flash boundary overlay · LOTO interlocks · breaker trip-curve coordination ·
deep SKM/ETAP one-line simulation · cascade/fault-current modeling. Impressive, but
out of the 70B lane you fenced off and heavy builds for narrow value. Two models
drifted here chasing "wow."

---

## The shortlist (prioritized)

### Benchmarking — revised design (build now, no bought data, no consent)

**B1. Maturity score vs the NFPA 70B standard (customer-facing)** · ENHANCE · CUSTOMER · **S–M**
Reframe the existing compliance % / path-to-100 into a 0–100 program-maturity score that
shows where the customer stands against what 70B *requires* — not against other people.
Zero external data, zero consent. Establishes a per-account score the items below reuse.

**B2. Portfolio rank + talking points (contractor-only, on the Fleet dashboard)** · ENHANCE · BUYER · **S–M**
Rank each customer account across the contractor's own portfolio (percentile on completion
rate, overdue %, avg condition, clearance velocity, maturity score) with auto-generated
discussion points wired into the quote-request/dossier flow. Uses only data the contractor
already owns; **hard rule: never shown on any customer-facing surface** (digest, share links,
co-brand). Extends the existing Fleet dashboard (oem_admin). Tier 3 (cross-network pool)
stays parked behind #31's consent model.

### Tier 1 — build-soon, high leverage (mostly repackages data you already compute)

**1. Maintenance Debt Ledger + Capital-Plan generator** · ENHANCE · BOTH · **M**
Quantify overdue/deferred maintenance as accruing "$ debt," roll into a 1/3/5-year
funding plan grouped by site. Leverages: overdue obligations, `repairCostEstimate`,
RUL, rate cards — the data already exists; this is aggregation + a CFO-grade view +
export. Why it wins: CFO urgency unlocks the customer's CapEx, which *is* the
contractor's pipeline. Strongest cross-model theme. Slots next to the CFO report.

**2. Evidence-to-requirement trace map + evidence-gap detector** · NET-NEW · BOTH · **M**
For each asset, show which evidence satisfies which 70B program requirement, and flag
what's missing ("no torque log / IR scan for this requirement"). Builds on the task
matrix you already seed per equipment type. Why it wins: the most genuinely
70B-defensible idea in the batch — useful *at audit time* (customer survives audit)
and hands the contractor a list of missing tests to upsell. My pick for the durable moat.

**3. "What changed since last cycle" audit brief** · NET-NEW · BOTH · **S–M**
Auto change-log per site: assets added/removed, condition shifts, overdue cleared,
policy changes since last visit. Leverages test history + snapshots. Cheap, high
audit + customer-conversation value. Pairs with snapshots (#21) and customer digest.

### Tier 2 — strong differentiators, moderate build

**4. Repeat-failure / compliance-drift detector** · NET-NEW · BOTH · **M**
Detect assets drifting out of tolerance across cycles, or inspections-done-but-
corrective-not-closed, and recommend an **interval or procedure change** — not just
another ticket. Leverages YoY trends + deficiency-closure data. "Changes maintenance
policy instead of just recording it." Real differentiation.

**5. Multi-year scope / proposal builder (repair / replace / defer)** · ENHANCE · BUYER · **M**
Turn the asset population + deficiencies + rate cards + RUL into a sellable multi-year
maintenance program with options. Extends the quote-request flow (#22). The #1 *buyer*
theme across models — the pipeline engine.

**6. Missing-access / open-items blocker portal** · NET-NEW · BOTH · **S**
Track assets that couldn't be inspected (locked door, outage needed, missing label,
customer access) as customer-owned blockers tied to compliance impact. Unglamorous,
cheap, attacks a real reason 70B programs fail; keeps the contractor blameless and
moves deals.

### Tier 3 — bigger bets / watch

**7. Direct test-instrument sync (Fluke / Megger / Doble)** · NET-NEW · BOTH · **L**
Pull readings straight from test sets — the next frontier of your data-in moat beyond
PDF parsing. Big moat, but heavy (format normalization, partnerships).

**8. Vendor-lead-time-aware replacement flag** · ENHANCE · BOTH · **S–M**
Flag assets whose replacement lead time (switchgear/transformer/breaker) exceeds
remaining life. Pairs directly with your RUL scoring. Very practical post-supply-chain.

**9. Insurer-readiness "risk passport"** · ENHANCE · CUSTOMER (+buyer diff) · **S–M**
Package compliance score + evidence + clearance velocity into a defensible,
broker-ready readiness score. Extends share links + snapshots. ⚠ Founder call on framing.

**10. 70B training tracker for the *customer's* staff** · NET-NEW · CUSTOMER · **S**
QEMW tracks the contractor's techs; this tracks the facility's own staff against their
70B program responsibilities. Niche but cheap audit-readiness stickiness.

**11. Multi-site capacity / route planner for 70B cycles** · NET-NEW · BUYER · **L**
Map all customers' required cycles to crew availability/skills/travel. Operationally
valuable but a large scheduling-optimization build — lower priority.

---

## Build order for tonight (dependency-aware — I picked these)
1. **B1 — Maturity score vs the 70B standard (customer-facing).** Smallest; reframes
   compliance %/path-to-100; produces the per-account score the rest reuse.
2. **B2 — Portfolio rank + talking points (contractor-only, Fleet).** Ranks accounts
   using B1's score + portfolio distribution; wired to the quote flow. Walled off from
   customer-facing surfaces.
3. **Maintenance Debt Ledger + capital plan.** Adds the $ layer (overdue + repair
   estimates + RUL + rate cards → 1/3/5-yr funding plan). The CFO-grade wow.
4. **"What changed since last cycle" brief.** Structured diff/narrative; makes the
   above sing in customer/auditor conversations.
5. **(stretch) Missing-access / open-items blocker log** — small, if time remains.

These reinforce each other: score (B1) → contractor prioritization (B2) → money
(debt ledger) → audit/trust (change brief). All serve both lenses and lean on systems
already built. Remaining big bets (evidence trace map, scope builder, instrument sync)
are next-session candidates.

## Founder calls (only you can make these)
1. **Insurer-readiness framing** — how far to lean in without becoming "insurance
   advice" or implying guaranteed premium outcomes. Liability + positioning.
2. **Proposal-builder pricing posture** — if SC starts generating *sellable* proposals
   for contractors, does that shift you toward value-based pricing vs. seats?
3. **Benchmarking Tier 3 only** — IF you later want the cross-network anonymized pool
   (the network-effect moat), that's when you'd need the consent model (ToS clause +
   opt-in). Tiers 1 and 2 above need none of this; Tier 3 stays parked until you decide.

## Suggested next step
Study **Egalvanic** firsthand (it's the closest real competitor to your dual-sided
thesis) and decide the benchmarking-consent question — that one unlocks the single
most-validated moat idea in the whole exercise.
