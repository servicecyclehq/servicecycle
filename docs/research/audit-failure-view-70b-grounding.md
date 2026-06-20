# Audit-Failure View — NFPA 70B grounding (2026-06-20)
_Grounded in `docs/research/2026-06-14-70b-procedures-ch11-15.md` (NFPA 70B-2023 preview: Ch 1–15 + Table 9.2.2) and `docs/help/compliance-scoring.md` (SC's encoded rules). This defines the finding taxonomy + severity + 70B citation for the "what will fail an audit" view. Each finding maps to data SC ALREADY computes — the view ranks/cites, it doesn't recompute._

## Finding taxonomy (ranked by audit severity)

### CRITICAL — would draw an immediate finding
1. **Lapsed asset not downgraded (auto-C3).** Asset missed ≥2 maintenance cycles. NFPA 70B 9.3.1 requires it be treated as C3 with tightened intervals. Finding if it's still rated C1/C2 or its schedule wasn't compressed. _Source: SC condition-rating (already auto-flags C3 on 2 misses)._
2. **Open as-found safety deficiency unresolved.** An open corrective/safety deficiency past a reasonable correction window (SC drift "unclosed_corrective" >120d). _Source: drift detector + deficiencies._
3. **C3 asset overdue.** Worst-condition assets past their compressed interval. _Source: condition + schedule._

### HIGH
4. **Required electrical-testing scope overdue.** The electrical-testing scope (Table 9.2.2 cadence, e.g. 60/36/12; transformer insulating-fluid override 12/12/6 per Table 11.2) is past due for an in-scope asset. _Source: evidence-gaps "stale/overdue" tier._
5. **Undocumented completion (no provenance).** Task marked complete but no work order / test report backing it — 70B is a records-based program (program docs §4.2). _Source: evidence-gaps "undocumented" tier._
6. **In-scope asset untracked.** Equipment with no schedule/history at all — can't be compliant if it's outside the program (Ch 9 scope). _Source: forgotten/untracked-assets lens._

### MEDIUM
7. **Non-electrical required scope overdue.** Visual/cleaning/mechanical scopes (Table 9.2.2) past due. _Source: evidence-gaps._
8. **Condition-governing inconsistency.** A C3 finding on one axis not reflected in the asset's governing rating (worst axis must govern). _Source: condition model._
9. **Missing baselines.** No baseline/commissioning reference for trendable tests. _Source: maturity "baselining" dimension._

### PROGRAM / LOW
10. **Missing program documentation (§4.2).** No documented EPM program scope/owner/intervals. _Source: maturity "program_docs §4.2" dimension._

### SEPARATE — flag as NFPA 70E (not 70B), keep distinct so the 70B view stays clean
11. **Arc-flash study/label gap.** Covered asset with an expired 5-yr study (70E 130.5(G)) or incomplete label data (130.5(H)). _Source: existing arc-flash binding._

## What the grounding ADDED beyond a generic overdue list
- Proper **70B section citations** per finding (9.3.1, Table 9.2.2, Table 11.2 override, §4.2) → audit-credible.
- **Severity ordering by audit risk**, not just due-date.
- Two checks a generic list misses: **auto-C3 lapse enforcement (9.3.1)** and **governing-condition consistency**.
- Clean **70B vs 70E separation** (arc-flash is 70E, flagged separately).

## Honest source caveat (carry into the UI copy)
Our 70B reference is the **preview (Ch 1–15 + Table 9.2.2)**. Intervals are verified to the primary source for all equipment; per-task PROCEDURE detail for Ch 16–38 is not in our source. The view should cite only findings we can back (interval/condition/evidence/program), and avoid asserting specific procedure-task requirements for equipment classes beyond Ch 15.
