# Lean PM Program vs NETA Battery - Marketplace Validation

**Date:** 2026-06-14
**Method:** deep-research harness, 4 parallel search agents (NETA routine-vs-acceptance framing; manufacturer/contractor PM scopes; borderline-test deep dive; real PM reports + small-facility framing). Sources at bottom. Standards bodies are paywalled, so clause-level frequencies rest on manufacturer + contractor + trade sources, not verbatim NETA/NFPA text.

## Bottom line

The lean-vs-battery split is **validated and should stay essentially as-is.** The industry universally separates a recurring PM visit (inspect / clean / torque / IR thermography / megger / mechanical exercise + operational tests) from a separately-sold ANSI/NETA acceptance & maintenance testing engagement (injection trip tests, relay calibration, TTR / SFRA / winding resistance / PD, cable VLF, fall-of-potential) performed on a ~3-5 year, outage-requiring cadence. Every one of our 24 battery-flagged tasks lands on the "separate engagement" side.

The key reassurance for the "do not omit something obvious" worry: for each borderline test we park in the battery, its **routine cousin is already in the lean set** - so the demo never hides a task a technician expects at a normal visit:

- connection integrity -> covered by torque verification + IR thermography (lean); the de-energized micro-ohm ductor is the redundant precise version (battery)
- circuit breakers -> mechanical exercise/operation is lean; injection trip testing is battery
- ATS -> monthly transfer test is lean; contact/insulation resistance is battery
- surge arresters -> visual / status-indicator / surge-counter check is lean; leakage-current/watt-loss test is battery

## Borderline test verdicts (the ~8 closest calls)

| Test (current bucket) | Marketplace reality | Verdict |
|---|---|---|
| Contact/connection resistance, micro-ohm/DLRO/ductor (BATTERY) | NETA MTS lists ductor as ONE of three accepted connection checks (torque, IR, ductor); routine scopes usually use torque+IR, formal ductor is on the 36-mo NETA cycle and needs an outage + DLRO set | KEEP in battery - torque+IR already cover it in lean. Closest call; move only if you want maximum generosity |
| Circuit-breaker injection trip test (BATTERY) | Mechanical exercise is routine; primary injection is occasional/billable; secondary (electronic trip-unit) injection is the lighter test some do annually but still needs outage + test set + electronic-trip breaker | KEEP in battery - exercise covers the routine part in lean |
| Relay calibration / secondary injection (BATTERY) | Comprehensive-tier NETA test, multi-year cycle, qualified relay techs | KEEP in battery (correct) |
| TTR / SFRA / winding resistance / PD (BATTERY) | Transformer diagnostics in the test engagement, not routine PM; SFRA needs expert/OEM interpretation | KEEP in battery (correct) |
| MV/HV cable VLF / PD / shield continuity (BATTERY) | Specialized HV sources, outage planning, sold separately | KEEP in battery (correct) |
| Ground fall-of-potential / point-to-point (BATTERY) | NETA recommends ~triennial; spaced electrodes; testing-crew task | KEEP in battery (correct) |
| GFP performance test (BATTERY) | NEC 230.95(C) mandates it only AT INSTALL with no periodic interval; periodic re-test is best-practice (annual-to-3yr) and billable | KEEP in battery (correct) |
| Surge-arrester leakage/watt-loss (BATTERY) | Routine task is the visual/indicator check (already lean); leakage is the specialized condition test | KEEP in battery (correct) |

## Lean-set inclusions - all validated

- **IR thermography: correctly LEAN.** Near-universal annual line item, highest-ROI predictive task. Caveat: it needs a certified Level I/II thermographer and >=40% load, so contractors often sub it out - it is routine in *scope* even if a separate *skill*. (This directly confirms the earlier judgment call to keep IR lean.)
- **Insulation resistance (megger): correctly LEAN.** The one instrument test most consistently inside routine PM ("the foundation of electrical testing").
- **Transformer oil DGA + oil screen: correctly LEAN, and already conditional.** Routine only where liquid-filled transformers exist (most small/mid facilities run dry-type), on a 1-3 yr cycle. Our DGA/oil tasks attach only to the TRANSFORMER_LIQUID type, so they self-gate. (Note: the routine *sampling task* is lean; the DGA lab-result *import/scoring card* stays behind the dga_import flag - reasonable, the task reminds you to sample, the card is the advanced ingestion feature.)
- Operational mandates (generator exercise/load bank/fuel/battery/engine, ATS transfer, emergency lighting, fire pump, UPS/stationary battery float/ohmic/capacity): all routine - correct.

## Obvious routine tasks we might be missing

Within our equipment-asset model, coverage is strong; the genuinely-missing items are mostly branch/receptacle-level or housekeeping, which fall outside an asset-keyed compliance tracker:

- **GFCI/AFCI testing** - common on commercial scopes, but receptacle/branch-level, not gear-asset. Out of model.
- **Panel-directory / circuit-schedule + arc-flash label verification** - we have arc-flash label verify; the directory-update line is housekeeping, not modeled.
- **Load-balance / phase-measurement** across panels - common PM line, not a compliance task in our model.
- **Working-space / NEC clearance / housekeeping check** - folded into our visual inspection task.

None are "super obvious omissions" given we model at the equipment-asset level and already carry visual + torque + IR + megger + operational per type. The strongest candidate to add later (if we ever model branch circuits) is GFCI/AFCI testing.

## Where practice genuinely varies

- **Facility size:** small/mid commercial = annual single-visit, inspect+clean+torque+IR+megger, ~$500-3,000; full NETA testing is an upsell. Data centers / utilities run the battery on tighter cycles.
- **Self-perform vs NETA contractor:** in-house teams do the lean set; the battery is what they hire a NETA firm for - which is exactly the lean/flag boundary.
- **Criticality & MV vs LV:** MV gear pulls more of the battery into the routine cycle (e.g., vacuum-bottle integrity, contact resistance) than LV gear.

## Sources

NETA / standards framing: netatesting.com/neta-acceptance-testing; blog.ansi.org ANSI/NETA MTS-2023; netaworld.org/standards/frequency-maintenance; ANSI-NETA Frequency of Maintenance Tests 2011 (meuw.org PDF); allumiax.com NETA scope.
Manufacturer/contractor PM scopes: Eaton field services + NFPA 70B brochure + MCCB primary-vs-secondary injection FAQ; Schneider EcoStruxure service plan + PowerPacT field testing + injection FAQ FA175036; Vertiv UPS/battery PM; ABB ReliaGear breaker testing + IR thermography; Martin Technical switchgear NETA; Quad Plus breaker PM.
Borderline tests: EC&M DC testing of breakers + GFP performance testing; UpCodes 230.95(C); ECmag performance testing & the NEC; Fluke earth ground + surge arrester; INMR arrester monitoring; TestGuy/Schneider primary-vs-secondary injection; HV Hipot fall-of-potential; SafetyCulture/Electro-Motion ATS NFPA 110.
Real reports / small facility: Limble + Oxmaint + BuildOps PM checklists/contracts; BayPower MCC checklist; CHINT/Relectric dry-transformer PM; Megger/MachineryLubrication DGA cadence; Kelco/Carter pricing & contract contents; infraredtraining.com thermographer certification.