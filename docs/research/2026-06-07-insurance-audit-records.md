# What Insurance Auditors Check — Field Map & Gap Analysis

Research date: 2026-06-07. Five-agent web research pass over primary carrier
documents (FM Global DS 5-20, HSB/AIG EPM Standard ES420, AXA XL PRC.1.3.1,
Zurich Property Risk Solutions, Chubb inspection guide), NFPA 70B:2023
committee-member papers, the official NETA Test Report Guide (§5.4), and
trade/broker commentary. Full citations at bottom. Confidence flags:
[P] = primary source, [S] = secondary.

---

## Part 1 — What auditors ask for (consensus findings)

### The audit flow
Loss-control engineer visits annually-ish, walks the distribution system,
and asks the facility manager to produce documents ON THE SPOT. Findings
become written recommendations (RECs) with 30–90 day response windows [S].
Non-compliance escalation: premium surcharge → claim challenge ("known
hazard not corrected") → non-renewal [S]. Strong documented programs earn
premium credits; HSB's own number: "more than two-thirds of electrical
system failures can be prevented by routine preventive maintenance" [P].

### The documents requested (ranked by how often facilities FAIL to produce)
1. **IR thermography report** — current (annual under 70B:2023; HSB floor
   every 3yr [P]), covering the whole system, WITH corrective-action status.
2. **Written EMP document** (mandatory under NFPA 70B:2023 §4.2.1 [P]).
3. **Arc flash / incident-energy study ≤5 years old** [P].
4. **Current one-line diagram** reflecting the actual system [P: HSB].
5. **Proof of qualified personnel** (NETA ETT levels, 70E qualified-person
   designations, thermographer certs) [P].
6. **Trending data** — "record all routine maintenance activities and the
   results of routine testing for trending purposes" [P: HSB §5.0]. Values,
   not checkmarks: "all-okay sign-off sheets are not compliant."
7. **Test decals on equipment** (NETA §5.5; 70B:2023 requires the decal
   system) [P].
8. **Short-circuit + coordination studies** ≤5yr [S/P].
9. **Transformer oil/DGA history** — annual, trended [P: HSB, Zurich].
10. **Protective relay test records** — annual [P: HSB].

### NFPA 70B:2023 EMP — required elements (§4.2, from committee paper [P])
Named program coordinator · electrical safety program interface (70E) ·
equipment survey/inventory with prioritization · documented per-type
maintenance procedures · inspection/test plan · **written records-retention
policy** · documented corrective-measures process · design-for-
maintainability process · program review/revision process · controls &
measurement of the EMP · incident-feedback utilization. EMP audit at
intervals **≤5 years**. Interval changes from Table 9.2.2 must be
documented with justification, and an interval must hold for **two full
cycles** before modification.

### NETA MTS-2023 §5.4 — every test data record must carry [P]
Testing organization identity · equipment ID matching one-line · complete
nameplate data · **ambient temperature + humidity at test time** · date ·
**technician name** · tests performed · **expected results for comparison**
· as-found AND as-left · condition comment. Project level adds: device
settings, narrative analysis & recommendations ("a list of comments does
not meet this requirement"), typically engineer-reviewed. Test instruments:
**make/model/serial + calibration within 12 months, NIST-traceable** [P].
Decal colors: **WHITE = serviceable, YELLOW = limited service, RED =
non-serviceable** [P].

### Personnel/provenance fields [P]
NETA ETT: Level 3 minimum to lead/sign; Level 1–2 require supervision.
NFPA 70E qualified person = **employer's written designation** (a training
certificate alone is insufficient) + retraining ≤3 years. Thermographer:
Level II is the de-facto insurer minimum for signing IR reports. Arc flash
studies: PE involvement expected (name + license on the report). Retention:
no universal number exists — 70B requires the facility to HAVE a written
policy; practical norms: test records for equipment life, training records
employment+3yr, calibration records ≥3yr.

### Per-equipment record fields auditors expect (highlights)
- **Liquid transformer DGA**: H2/CH4/C2H2/C2H4/C2H6/CO/CO2 **+ O2 + N2**
  ppm, O2/N2 ratio (sealed vs breathing), TCG, IEEE C57.104-2019 Status
  1/2/3, Duval fault code (PD/T1-T3/D1-D2), **rate-of-change ppm/yr from
  ≥3 samples**; any C2H2 >1–2 ppm in a sealed unit escalates [P/S].
- **IR reports**: thermogram + visible-light photo pairs, ΔT vs similar
  component AND vs ambient, **load % at scan time (≥40% rule: HSB+Zurich
  [P])**, NETA priority 1–4 (ΔT>15°C similar / >40°C ambient = Priority 1),
  thermographer cert level, inaccessible areas listed, emissivity values.
- **Breakers**: primary-injection trip times at %-of-rated points vs curve
  tolerance band, as-found/as-left settings, pole contact resistance (µΩ,
  >50% deviation rule), insulation resistance vs NETA Table 100.1.
- **Generators (NFPA 110)**: weekly inspection log fields; monthly load
  test: **kW AND %-of-nameplate (≥30%), 30 min, transfer time (≤10s Level
  1)**, volts/Hz, oil pressure, coolant temp, battery V; annual 2hr test;
  records "kept on premises and available to the AHJ."
- **Batteries (IEEE 450/1188)**: per-cell float V, temp, ohmic value with
  **same instrument + probe placement each time**, baseline at ~6mo,
  30–50% rise from baseline = replace; annual capacity test, pass ≥80%
  rated; quarterly cadence.
- **Motors (IEEE 43)**: megohm @30s/1min/10min, PI (≥2.0 good, <1.0 do not
  energize), temperature-corrected to 40°C for trending, winding resistance
  imbalance >2% investigated.
- **Switchgear**: insulation resistance phase-phase/phase-ground vs Table
  100.1, bolted-connection µΩ with >50%-deviation rule, control wiring IR.

---

## Part 2 — Gap analysis vs ServiceCycle's data model (as of commit 73369c8)

### Already strong (validated by the research)
- Three-axis condition assessment + worst-axis-governs = exactly NFPA
  70B:2023 Ch9 ECA. ✓
- Condition-based intervals w/ documented standardRef per task. ✓
- As-found/as-left on work orders AND measurements (NETA 5.4.2 #9). ✓
- Deficiency → corrective-action workflow (EMP element #7). ✓
- DGA 7-gas columns + lab name. Mostly ✓ (see gaps)
- Arc flash study with 5yr expiry + supersession chain. ✓
- Audit snapshots, hash-anchored = stronger than anything carriers ask for. ✓
- Tamper-evident activity log. ✓

### GAP TIER 1 — auditors ask for these on the spot (build next)
| # | Gap | Change |
|---|-----|--------|
| 1 | **Test-condition + instrument provenance** (NETA 5.4.2 #4, §5.3): no ambient temp/humidity, no test-instrument identity/cal-date on records | WorkOrder: `ambientTempC`, `humidityPct`, `testEquipment Json[]` ({make, model, serial, calDate}); TestMeasurement: `testVoltage`, `expectedRange` |
| 2 | **Personnel qualification records**: techs have netaCertLevel only; no 70E qualified-person designation/training dates, no thermographer cert, no in-house staff concept | ContractorTech: `qualifiedPersonDesignatedAt`, `trainingExpiresAt`, `thermographerCertLevel`; Contractor: `isInternal` flag (in-house crew); schedule completion: `performedByTechId`/`performedByName` |
| 3 | **System studies beyond arc flash**: no short-circuit study, coordination study, or one-line diagram tracking — top-5 audit failures | Generalize: `SystemStudy` (type: arc_flash \| short_circuit \| coordination \| one_line_review, performedDate, expiresAt, performedBy, peName, peLicense, method, documents) or extend ArcFlashStudy with `studyType` + PE fields; Site: one-line `documentId` + `oneLineUpdatedAt` |
| 4 | **EMP document layer** (70B §4.2 mandatory): no named coordinator, no written program artifact, no retention policy, no ≤5yr program review tracking | Account/AccountSetting: `empCoordinatorUserId`, `empLastReviewedAt`, `retentionPolicyText`; PRODUCT FEATURE: "Generate EMP document" — render the written EMP from live system data (procedures from task definitions, inventory from assets, schedules, personnel) the same way snapshots work. Huge differentiator: the platform *writes the auditor's first ask*. |
| 5 | **IR survey fields**: ΔT, load %, NETA priority 1–4, thermographer | TestMeasurement: `loadPercent`, `severityPriority` (1–4); thermograms attach via existing Document path |
| 6 | **DGA completeness**: missing O2, N2, IEEE status, fault code | LabSample: `o2`, `n2`, `ieeeStatus` (1\|2\|3), `faultCode`; rate-of-change computed in report UI from history |
| 7 | **NETA decal colors**: ours is GREEN/YELLOW/RED; NETA is WHITE/YELLOW/RED (white=serviceable) | Keep enum (migration churn not worth it); change UI labels to "Serviceable", "Limited Service", "Non-serviceable" with NETA color note |

### GAP TIER 2 — strengthens the audit story (next sessions)
- **Generator run logs** (NFPA 110 weekly/monthly cadence is too granular
  for work orders): lightweight `RunLog` model — date, kW, %nameplate,
  duration, transfer time, volts/Hz, oil PSI, coolant °C, battery V.
- **Battery per-cell readings** (IEEE 450/1188 quarterly ohmic trending):
  `CellReading` model keyed (assetId, cellNumber, readingDate).
- **Trend charts** in per-standard reports (megohm trend, DGA ppm/yr,
  ohmic-rise-from-baseline) — the data is already stored; this is UI.
- **Loss-control REC tracker**: carriers issue recommendations with
  deadlines; track them like deficiencies with `source: insurer` + due
  date + response narrative. Maps 1:1 to the 30–45 day response workflow.
- **Acceptance-test baselines**: flag the first completed WO per
  (asset, task) as the baseline benchmark (70B requires keeping
  commissioning results for comparison).

### GAP TIER 3 — noted, deliberately deferred
- PE-stamp workflow on studies; label-inventory for arc flash labels;
  emissivity/imager metadata on IR; SF6/vacuum-bottle specifics; NERC
  PRC-005 (utility market, out of scope for PoC).

### Retention-policy caution (action item)
`ACTIVITY_LOG_RETENTION_DAYS` defaults to 365 — fine for security events,
but compliance-relevant rows (condition changes, snapshot anchors,
breach flags) should be exempted from pruning or the default raised for
this product. Maintenance records themselves (WOs/measurements) are never
pruned — correct, keep it that way.

---

## Sources (key primaries)
- FM Global DS 5-20 Electrical Testing (fetched PDF)
- HSB/AIG Guide for an EPM Program ES420 rev 12/2020 (fetched PDF, munichre.com + aig.com)
- AXA XL PRC.1.3.1 Infrared Inspection (fetched PDF)
- Zurich Property Risk Solutions — Electrical Maintenance & Testing Guidelines (fetched PDF)
- Chubb NZ Property Inspection Guide 2016 (fetched PDF)
- NETA Guide for Complying with MTS/ATS §5.4 Test Report (s3.amazonaws.com/NETA-MP)
- IEEE ESW2023-18 — The New NFPA 70B-2023 Standard (committee members' paper)
- ANSI/NETA ETT cert levels (netaworld.org); OSHA 1910.332, 1904.33
- Infraspection Standard for IR Inspection of Electrical Systems 2016 (ΔT tables)
- Secondary: Risk Logic (FM DS summaries), Liberty Mutual IR guidance, Leaf
  Electrical Safety, Eaton/Vertiv 70B analyses, Coyle Group / Boost USA
  (REC process), TestGuy, Eagle Eye (IEEE 1188), Turnkey (NFPA 110 logs).

Full agent transcripts with per-claim confidence flags available on request.
