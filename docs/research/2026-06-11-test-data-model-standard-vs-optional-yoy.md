# Test-Data Model: Standard vs Optional, PowerDB Import & Year-over-Year Trending

Date: 2026-06-11
Status: Research / pre-build (no code yet — design input for the "Annual Testing Data" asset tab)
Trigger: Brother (industry expert) review of a real PowerDB/Megger annual test report + correction of the NETA framing.

---

## 1. The reframe (from the operator)

Direct corrections from the expert, and what they mean for the data model:

- **NETA is acceptance / advanced testing, not the maintenance standard.** It's for new equipment at installation, site acceptance, and advanced troubleshooting. Testing every device to NETA is "very expensive and super time consuming" — effectively only nuclear plants do it.
- **NETA certification is not a meaningful gate.** Manufacturer-affiliated service orgs are *structurally barred* from NETA cert, yet perform NETA-grade testing constantly. Requiring NETA cert is therefore actively wrong. The real requirement is "a qualified testing company following established maintenance and testing procedures." **NICET** and **NETA** are the two certs that exist; neither should be a hard gate.
- **The maintenance standard is NFPA 70B (Ch. 11–38) + the equipment manufacturer's recommended maintenance.** NFPA 70B largely mirrors typical manufacturer recommendations; there is heavy overlap across all the standards.
- **The real axis is STANDARD vs OPTIONAL testing.** Standard = routine maintenance tests that show up on every annual report. Optional/advanced = SFRA, partial discharge, full power-factor/Doble batteries, etc. — done at manufacturing, site acceptance, or for troubleshooting. Example called out: **SFRA is in the app today and should be marked optional (or removed) — it is an important test but not part of standard maintenance.**

### Product implication
Do **not** rip the standards out. **Demote and tag them.**
1. Add a **test/task tier**: `standard_maintenance` | `optional_advanced` (default catalog views show standard only; advanced is opt-in per customer/asset).
2. **Primary procedure reference = NFPA 70B Ch. 11–38 + manufacturer recommended maintenance.** Keep NETA MTS as a *secondary/optional* cross-reference, not the governing one.
3. **Demote cert from a gate to optional metadata.** Today the schema treats NETA as semi-required: `MaintenanceTaskDefinition.requiresNetaCertified`, `netaCertLevelMin`; `WorkOrder.netaCertLevel`, `netaDecal`. Reframe: "qualified testing company" boolean + optional cert tags (NICET/NETA/manufacturer-trained), never a hard requirement.
4. Keep the multi-standard catalog (the "one-stop compliance" vision) but **prioritize** NFPA 70B + manufacturer and mark everything else optional so a customer who only needs 2 standards isn't drowned.

> Positioning note (Dustin's instinct, worth validating): gear the platform at **equipment that needs maintenance** first, but let customers also catalog **new** equipment — because new equipment becomes a maintenance/service-contract candidate over its life. New-equipment acceptance data (NETA ATS) then becomes the *baseline* (year 0) for later maintenance trending. That's a clean reason to keep acceptance tests in as optional rather than delete them.

---

## 2. What a PowerDB / Megger annual report actually contains

From the real sample (4 unit substations, ~15 breakers each, single year 2025). It is a standard PowerDB field-data protocol — highly consistent and parseable:

- **Per device (substation):** Customer/Owner/Site, Equipment Location, Equipment Designation, **Device ID**, **Date Tested**, tested-by.
- **FIELD DATA (per breaker/circuit = nameplate/config):** Circuit Designation, MFG, Type (e.g. LJ400/PJ800/RK1200), Volts, Frame Amp, Trip Amp Range, Functions (LSI/LSIG), Neutral Sensor Polarity.
- **ELECTRICAL TEST DATA (per breaker):** Contact Resistance A/B/C (µΩ); trip-unit results — LTD setting (A), LTD seconds min/max acceptance band, LTD result (s), STPU result (trip/no-trip), GFPU result (trip/no-trip/NA).
- **INSULATION RESISTANCE (per breaker):** 9 readings — phase-to-ground (A-G,B-G,C-G), phase-to-phase (A-B,B-C,A-C), line-to-load (A-A',B-B',C-C'); plus test voltage (e.g. 1000 VDC) and units (GΩ).
- **Comments / Deficiency** per device.

This *is* the "standard maintenance" tier. The import feeds the standard tier; the YoY engine trends these readings.

---

## 3. Standard-vs-optional test taxonomy by equipment type (we have these EquipmentTypes)

Legend: **[S]** standard maintenance (NFPA 70B / mfr rec — trend these YoY), **[O]** optional/advanced (acceptance, diagnostic, troubleshooting).

### Circuit breakers (LV molded-case, LV power, MV) / Switchgear / Switchboard / MCC / Panelboard / Busway
- [S] Insulation resistance (pole-pole, pole-ground, line-load) — trend
- [S] Contact / pole resistance (DLRO, µΩ) — trend (rising = degradation)
- [S] Trip-unit / protective-function test (LTD/STD/INST/GF pickup + timing vs settings)
- [S] Mechanical operation (charge/close/trip), interlocks
- [S] IR thermography (energized, ΔT at recorded load %)
- [S] Bus insulation resistance (switchgear/switchboard/busway)
- [O] Primary-injection full time-current curve at multiple points (beyond function check)
- [O] Circuit-breaker timing/travel analysis (MV vacuum/SF6)
- [O] Vacuum-bottle integrity (MV vacuum)

### Transformers (liquid-filled / dry-type)
- [S] Insulation resistance + Polarization Index (winding-winding, winding-ground)
- [S] Turns ratio (TTR)
- [S] Winding resistance
- [S] Oil quality (dielectric, moisture, acidity) + **DGA** (liquid) — trend key gases
- [S] IR thermography
- [O] Power factor / dissipation (tan δ) on windings + bushings — *borderline; treat as optional/advanced per operator, but high-value to trend if performed*
- [O] SFRA (sweep frequency response) — **advanced, mark optional**
- [O] Excitation current, leakage reactance, FRA

### Cables (LV / MV-HV)
- [S] Insulation resistance
- [O] VLF withstand, tan δ (MV)
- [O] Partial discharge

### Protective relays
- [S] Functional / pickup + timing calibration vs setpoints
- [O] Full coordination verification (study-driven)

### Battery systems / UPS battery
- [S] Cell/unit voltage, connection resistance (ohmic/impedance), float/charger check, IR thermography
- [O] Capacity (load/discharge) test — periodic but heavier; treat as scheduled-optional

### Grounding system
- [S] Point-to-point / continuity
- [O] Fall-of-potential (IEEE 81)

### Others present in enum (transfer switch, surge arrester, ground-fault protection, fire-pump controller, emergency lighting)
- [S] Functional / operational test + IR; [O] device-specific advanced as applicable.

---

## 4. Year-over-Year leading indicators (what the diff engine should watch)

The whole value of storing this annually is the trend, not the snapshot. Highest-signal callouts, with direction:

| Equipment | Reading | Bad direction | Rough flag logic (refine w/ brother) |
|---|---|---|---|
| Breaker/switchgear | Contact resistance (µΩ) per phase | **rising** | YoY +>20–50% or one phase >> others (phase imbalance) → "remove & clean contacts" (matches real deficiency in sample) |
| Breaker/switchgear/bus | Insulation resistance (GΩ) | **falling** | YoY drop >50%, or any reading collapsing toward 0 relative to siblings → moisture/insulation flag |
| Breaker trip unit | LTD timing / STPU / GFPU result | trip→no-trip, drift | Any function fail or timing outside min/max band |
| Transformer | Power factor / tan δ (%) | **rising** | >1.0% investigate; trend up vs baseline |
| Transformer | DGA key gases | **rising** | acetylene present = arcing; trend H2/C2H2/CO2 vs IEEE C57.104 |
| Transformer | Insulation / PI | **falling** | declining IR or PI < ~1.0–2.0 |
| Battery | Internal/ohmic resistance | **rising** | per-cell rising vs baseline; capacity declining |
| Any (energized) | IR thermography ΔT @ load% | **rising at same load** | NETA/Infraspection ΔT priority tiers |

Note: trending requires **load-normalization** (thermography) and **temperature-normalization** (IR/PF on transformers) to be apples-to-apples year over year — flag as a data-capture requirement.

---

## 5. Gap analysis vs current ServiceCycle schema

What already exists and is reusable (good foundation):
- **`TestMeasurement`** — measurementType, phase (free-form), asFound/asLeft value+unit, passFail, **expectedRange**, **testVoltage**, **loadPercent**, **severityPriority**, notes. Fits IR / contact / insulation readings as one row per phase/reading.
- **`WorkOrder`** — assetId, **completedDate** (the test date), **ambientTempC/humidityPct** (normalization!), **testEquipment** JSON (Megger make/model/serial/cal date — provenance), reportPdfUrl, asFound/asLeft condition, → `measurements[]`. This is the natural "annual test event" container.
- **`Asset`** + **`nameplateData` (JSON, per-type)** — manufacturer/model/serial/equipmentType; flexible nameplate for breaker frame amp / trip range / functions.
- **`AuditVisit`**, **`Deficiency`**, **`MaintenanceTaskDefinition`** (NETA/NFPA refs, intervals by condition).

Gaps to support PowerDB import + YoY:
1. **Circuit / sub-component identity.** PowerDB data is per *breaker/circuit within a substation* ("SPARE 1", "4PA", "BUSS DUCT"). Decide the model:
   - (a) each breaker = a **child Asset** (fedFrom/position) — richest, enables per-breaker cards & trends; or
   - (b) add `circuitDesignation`/`componentRef` to `TestMeasurement` — lighter, keeps substation as the asset.
   Recommendation: (a) for switchgear lineups (breakers are real assets), with the import auto-creating children. Confirm with brother how they think of a "device."
2. **Test event grouping.** Add a notion of a **test snapshot/event** (could just be WorkOrder, or a dedicated `TestEvent`) so a PowerDB form = one device's full test set on one date, for clean tab rendering + YoY diffing.
3. **Reliable test date on measurement** — currently inferred via WorkOrder.completedDate; PowerDB has explicit per-form "Date Tested." Ensure import sets it.
4. **Trip-unit test shape.** Current model (asFound + expectedRange string) is thin for setting(A) + min/max acceptance band + measured result + per-function trip/no-trip (LTD/STD/INST/GF). Consider a structured trip-test sub-shape.
5. **Tier flag** (`standard_maintenance` | `optional_advanced`) on the test catalog + measurement type, per §1.
6. **Normalization fields** — already have ambientTempC/loadPercent; ensure import captures them and the diff engine uses them.
7. **Device-ID normalization** — O-vs-zero ambiguity (B36S01 vs B36SO1). Importer needs a normalization/matching step (and a confirm-merge UI for existing assets).

---

## 6. Proposed "Annual Testing Data" asset-card tab (design sketch, not built)

- Generalize beyond "PowerDB" → **"Annual Testing Data"** tab on each asset card (source-agnostic: PowerDB/Megger today, others later).
- Sections:
  1. **Test history timeline** — each annual event (date, vendor, instruments, overall result).
  2. **Per-test trend** — line charts per reading (contact resistance A/B/C, insulation resistance, PF, DGA) across years, with threshold bands.
  3. **YoY diff table** — this year vs last, deltas, auto-flagged callouts (from §4), exportable to Excel.
  4. **Findings/deficiencies** tied to the event.
- "I imagine some of this is built already" (Dustin) — likely true: test_measurements + work-order test capture + condition assessment exist. The work is largely (a) the importer, (b) the trend/diff engine, (c) re-homing existing data cards into this tab and adding charts.

---

## 7. Open questions → see brother-conversation-guide.md (new Section 9)

---

## 8. RESOLVED: device modeling (researched 2026-06-11)

**Decision: switchgear lineup / unit substation = PARENT asset; each circuit breaker = CHILD asset.** Confirmed by both domains:

- **Asset-management standard (ISO 14224 / EAM-CMMS convention):** hierarchy is Facility → Area → System → Equipment → **Component**, parent-child, with maintenance/cost/downtime logged at the *child* level and rolling up to the parent. Breakers are classic **serialized rotable components** — removed, refurbished, reinstalled — and best practice tracks each with manufacturer/model/serial + genealogy.
- **Testing practice (NETA/PowerDB):** breakers are tested **individually** (own contact resistance, insulation, trip-unit results); PowerDB reports *by device* (the lineup) but carries **per-breaker** test rows. So the test data is inherently per-breaker.

**Why child-asset (not just rows on the substation):** breakers are individually replaceable and individually trended; per-breaker cards give real YoY history; rolls up to a lineup view. Matches how techs think about a rack-out breaker.

**No schema change needed for the hierarchy** — ServiceCycle already supports this:
- `Asset.fedFromAssetId` (self-relation power path) and/or `Asset.positionId` → `EquipmentPosition` give parent/lineup ↔ breaker.
- `Asset.nameplateData` (JSON) holds breaker frame amp / trip range / functions; `manufacturer/model/serialNumber` for genealogy.
- Importer auto-creates child breaker assets under the lineup, keyed on **circuit designation** (position label) + serial when present.

**Rotable caveat for the diff engine:** trend on the **position (circuit slot)** as the primary axis, but watch the **breaker serial** — if a breaker was swapped, a contact-resistance "improvement" is a *replacement*, not a repair. Flag swaps explicitly so a reset baseline isn't read as a healing trend. (Sample report had no breaker serials, only MFG/Type/frame → position-based trending is the practical default; capture serial when available.)

## 9. Export format & data ownership (confirmed 2026-06-11)

- **PowerDB output is PDF-only** (timestamped/encrypted for tamper-evidence; no CSV/XML export by design). So PDF parsing is the import path — confirmed acceptable (sample parsed cleanly; PDF was readable, not access-controlled).
- **Plan: after PDF import, offer an Excel export of the parsed data for the customer's own records.** Keep the **original signed PDF as system-of-record**; the Excel is a clearly-labeled *derived convenience copy*, never represented as the authoritative signed test report (preserves PowerDB's tamper-evidence chain). Use our own layout, not PowerDB's template. See legal note in chat (facts/data aren't copyrightable; the customer owns their equipment's test data).

---

## 10. Multi-vendor import (design decision, 2026-06-11)

Build a **vendor-agnostic import layer** now; build non-PowerDB adapters later.
- Each test-data tool = a **source adapter**: its templates/export format → parser → the *same* normalized TestMeasurement schema. PowerDB is adapter #1.
- Main alternatives to plan for: **Doble** (dobleARMS / Test Assistant) and **OMICRON** (Primary Test Manager / ADMO). ETAP/SKM are study tools (arc flash/coordination), not test-data capture — out of scope for this layer.
- Key difference vs PowerDB: PowerDB *publishes* blank templates publicly (we harvested ~280 → `docs/research/powerdb-templates/`). Doble/OMICRON generally don't (software-generated, login-gated), BUT some offer **structured data export (CSV/XML/DB)** — which can make import *easier* than PDF parsing, just a different path.
- Build order: PowerDB first (we have real samples). Add Doble/OMICRON only when (a) a real customer uses them and (b) we have a real sample report/export to build against. Confirm actual tool usage with brother (guide Q62–64).

## 11. PowerDB template catalog status (2026-06-11)
Harvested official PowerDB blank templates → per-equipment-type field-schema files in `docs/research/powerdb-templates/` (INDEX.md + 14 type files). ~280 forms enumerated from the AllForms master TOC; ~50 fully detailed with field labels. Verified-label files: transformer, circuit_breaker, switchgear, cable, battery, protection_relay, disconnect, generator, surge_arrester. Inferred (need label verification before parser work): motor/MCC/VFD, transfer_switch, instrument_transformers, grounding. No PowerDB form exists for EMERGENCY_LIGHTING, ARC_FLASH_PANEL, FIRE_PUMP_CONTROLLER (NFPA inspection/calc items → ServiceCycle-native test defs). Near-universal normalization field: **Temp Correction to 20°C (TCF)** on IR-based tests; relay/trip/meter tests carry **As-Found/As-Left** pairs.

---

## 12. PDF extractor choice (decided 2026-06-11, license-checked)

Target: clean, digitally-generated PDFs with heavily **ruled** test tables (PowerDB). All choices must be commercially clean for a self-hosted SaaS.

- **PRIMARY: Camelot (v1.0+).** As of v1.0.0 the default backend is **pdfium (BSD)**, shipping as a **pip wheel with NO system dependencies** (Ghostscript/poppler are now optional opt-in backends). Library is MIT → **MIT + BSD end-to-end, commercially clean.** Parsers: **Lattice** (uses ruling lines — ideal for PowerDB's bordered test tables) + **Hybrid/Network** (for non-ruled nameplate/header sections) + Stream. No-system-deps is a real win for the 1 GB droplet's constrained Docker build. NOTE: the pre-1.0 "Camelot pulls in AGPL Ghostscript" concern is obsolete — does not apply to v1.0+.
- **FALLBACK / cross-check: pdfplumber (MIT).** Word coordinates + line detection; good for sections Camelot misses.
- **TRIAGE: pdftotext (poppler).** Fast first-look only.
- **EXCLUDED: PyMuPDF / fitz.** AGPL + commercial dual-license; the AGPL network clause bites a self-hosted SaaS. Do not use as a core dependency.
- **OCR path (only if a PDF lacks a text layer — not the PowerDB case):** docling / unstructured / Tesseract / PaddleOCR.

Plan: when building the real parser, run a **Camelot(lattice/hybrid) vs pdfplumber bake-off** on the brother's real filled reports and standardize on the winner (likely Camelot-lattice for the test tables). Both are license-clean, so the decision is purely accuracy/robustness.
