# NFPA 99 Healthcare Module — Research Synthesis & Proposal

Researched 2026-06-07 (three-agent pass: NFPA 99 requirements, CMS/TJC
enforcement, hospital operations + software market). Per-claim source URLs
and [VERIFIED]/[SINGLE-SOURCE]/[UNCERTAIN] flags are in the agent reports;
the load-bearing claims below are all [VERIFIED] multi-source unless noted.
**Decision owner: the brother.** This is a proposal, not a commitment.

---

## 1. The thirty-second version

Hospitals answer to NFPA 99 (Health Care Facilities Code), enforced through
CMS Conditions of Participation and accreditor surveys (Joint Commission,
DNV) — not the insurance-audit dynamic the rest of ServiceCycle targets.
The cadence is weekly/monthly with hard windows, the records are
survey-or-die, and **the research found that no CMMS on the market ships
the three things surveyors actually burn hospitals on**: pre-built
code-section log templates, native enforcement of the 20–40-day generator
test window, and a one-click surveyor-ready evidence bundle. Our existing
hash-anchored snapshot pipeline is two-thirds of that third item already.

## 2. The facts the module must be built on

- **Edition trap:** CMS enforces NFPA 99 **2012**; NFPA's current edition
  is **2024**; the 2021 edition applies only via a microgrid waiver.
  Facilities straddle editions — the module must bind tasks to editions.
- **Enforcement chain:** CMS CoPs → accreditors (TJC's new "Physical
  Environment" chapter as of Jan 2026 — old EC.02.05.05/.07 numbering just
  changed!) → state agencies. K-tags are the common currency: **K911**
  (NFPA 99 Ch.6 electrical), **K918** (EPSS/NFPA 110), **K920**
  (receptacles/NFPA 70).
- **The recurring calendar (hospital EPSS):** weekly generator/ATS
  inspections; monthly load test **in a 20–40-day window** (≥30% nameplate
  kW, ≥30 min, each ATS transferred); monthly 30-second battery-light
  tests + annual 90-minute (egress, NFPA 101) / annual **30-minute** (OR
  lighting, NFPA 99 §6.3.2.2.11.5 — different and frequently confused);
  annual receptacle testing in patient care vicinities (non-hospital-grade
  ≤12 months; hospital-grade per documented performance data; 115-gram
  retention force); LIM tests monthly (analog) or annual (self-testing);
  triennial 4-hour full-load test; conditional annual load-bank when
  monthly tests chronically miss 30%.
- **Generators are NOT AEM-eligible** (S&C 14-07): intervals are fixed by
  the referenced standards — the module should hard-flag any attempt to
  stretch them.
- **What surveyors cite most:** missed windows, "checkmark logs" without
  measured values, missing weekly logs, deficiencies with no linked
  corrective action, ATS tests not separately documented. They want 12
  months of logs with real readings, on demand.
- **Consequences ladder:** RFI → condition-level finding (PoC in 10 days,
  revisit 60–90) → Immediate Jeopardy (abate before surveyors leave or
  termination track, as few as 23 days).

## 3. What ServiceCycle already has (more than expected)

| Need | Have |
|---|---|
| Multi-edition standards library | ✓ ComplianceStandard(code, edition) — add NFPA 99-2012 + 2024 rows |
| Generator/EPSS tasks | ✓ partial (NFPA 110 Tier-1 seed) — needs healthcare deltas |
| Real-readings test records (anti-checkmark-log) | ✓ TestMeasurement w/ values+units+expected, instrument calibration provenance |
| Deficiency → corrective action → resolution trail | ✓ (exactly the "no corrective action documented" citation killer) |
| Survey/audit visit records + findings (RECs) + PoC-style responses | ✓ AuditVisit + AuditRecommendation (add auditType already supports) |
| Tamper-evident, dated evidence | ✓ hash-anchored snapshots — unique in BOTH markets |
| Field capture for weekly logs | ✓ Field Mode (weekly inspection = its sweet spot) |
| Written program document generation | ✓ EMP generator (TJC's new mandatory written MMP is the same pattern) |

## 4. The honest gap list (what must be built)

**G1 — Interval granularity [schema].** Our intervals are integer MONTHS.
Weekly tasks and the 20–40-day window are inexpressible. Need day-granular
intervals plus **min/max window fields** (windowMinDays/windowMaxDays) and
schedule math that computes "window opens / target / window closes" dates.
The window concept is the moat: research confirmed no CMMS enforces it.

**G2 — Healthcare equipment types [schema].** Add: TRANSFER_SWITCH,
ISOLATED_POWER_PANEL (LIM), BATTERY_LIGHTING_UNIT (with egress-vs-OR
subtype), RECEPTACLE_GROUP (patient-care-area receptacle inventory — a
300-bed hospital has thousands; model as room/area-level groups with
counts, not one asset per outlet). Plus per-asset healthcare attributes:
EES branch (life_safety | critical | equipment) and NFPA 99 risk category
(1–4) — a separate axis from our C1–C3 condition.

**G3 — Per-task required-reading templates.** A monthly gen test log MUST
capture kW, %-of-nameplate, transfer time per ATS, run duration, readings.
Task definitions need a `requiredReadings` template the WO/Field-Mode form
renders and validates — incomplete log = flagged, not silently saved.
This is the direct counter to the #1 citation pattern.

**G4 — Conditional triggers.** %-nameplate < 30 on a monthly test →
auto-flag + generate the load-bank requirement. Simple rule, no one ships it.

**G5 — Healthcare alert cadence.** Our tiers think in 180/90/30 days; a
weekly inspection missed for 9 days is already survey ammunition. Per-task
alerting class: window-opens / target-day / window-closes-in-N / BREACHED
(with the breach writing to the audit chain like regulatory_breach does).

**G6 — Survey evidence binder.** Extend the snapshot pipeline: "Generate
PE/EC evidence package" = 12 months of generator+ATS+lighting+receptacle
logs grouped per standard/K-tag, hash-anchored. Research: no product ships
this; we're one renderer away.

**G7 — Regulatory tagging.** Task definitions carry standardRef already;
add K-tag / TJC-chapter tags so reports can speak surveyor language
(K918, PE chapter) — and seed NFPA 99-2012 task rows with the verified
citations from this research (every interval above has a section number).

**Explicitly later:** AEM program management (for eligible equipment),
ILSM/ICRA workflows (TheWorxHub just shipped this — don't chase v1),
medical gas (NFPA 99 Ch.5 — not electrical, out of scope).

## 5. Market check

Healthcare CMMS (~$235M→$495M by 2030) is owned by Accruent TMS, Brightly
TheWorxHub, Nuvolo — all of which tag work orders "NFPA 99" at the
standard level and leave the actual log fields, window math, and evidence
bundling as customer configuration. The gap list above (G1, G3, G4, G6)
is verbatim what the market research called "genuine differentiation."
Caveat honestly: those are entrenched enterprise vendors; the wedge is the
same as the NETA one — contractors and smaller/critical-access hospitals
first, not 800-bed systems day one.

## 6. Proposed phasing (sizes are build-block-scale, like prior blocks)

- **Phase 1 (the foundation):** G1 + G2 schema + migration; NFPA 99-2012
  + NFPA 101 + edition rows; verified healthcare task seed (citations per
  row, EE/brother review flagged same as the 70B seed); window-aware
  scheduling math + G5 alerting. → After this, a hospital's calendar is
  *representable and alerted correctly*, which no competitor does natively.
- **Phase 2 (the evidence story):** G3 required-readings templates in WO +
  Field Mode forms, G4 load-bank trigger, G6 survey binder, G7 tags.
- **Phase 3:** receptacle-group testing UX at scale, AEM module, ILSM.

## 7. Questions for the brother (decision owner)

1. Who's the hospital-side buyer he has in mind — facilities director at
   a hospital, or the electrical contractor serving hospitals? (Changes
   Phase 1 UX priorities.)
2. Is 2012-edition fidelity enough for v1 (the CMS floor), with 2021/2024
   deltas labeled, or does he need full multi-edition from day one?
3. Does he know facilities people who'd review the healthcare task seed
   the way we want a NETA reviewer for the 70B seed?
4. Generators/lighting/receptacles/LIM cover the survey hot zone — is
   anything in his experience cited more that we should front-load?
