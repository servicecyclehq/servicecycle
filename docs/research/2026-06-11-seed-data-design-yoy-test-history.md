# Seed-Data Design Spec — Synthesizing 7–10 Years of YoY Electrical Test History

Date: 2026-06-11
Status: Design spec only (NO seed code, NO DB writes here). Input for the demo data-build task.
Purpose: Create a fresh DUMMY customer whose 2025 baseline = transcribed values from ONE real PowerDB report, then synthesize prior years (~2016–2024) BACKWARD so ServiceCycle's new year-over-year (YoY) reporting shows realistic trends that survive an industry-expert sniff test.

Companion docs:
- `2026-06-11-test-data-model-standard-vs-optional-yoy.md` (§4 YoY indicators — the diff engine the trends must trip)
- `powerdb-templates/` (field catalog — measurementType / unit names used below)

> **Anonymization rule (hard):** No real company, vendor, site, or person names appear anywhere in seed data. Only NUMERIC test values and generic device IDs (e.g. `B36S01`, circuit `SPARE 1`, `BUSS DUCT`) carry over as the 2025 anchor. Fake everything else (company, site, techs). The real report and its PII are referenced in this doc only as "the source baseline."

---

## 0. The 2025 anchor (transcribed from the source report)

Four unit substations, ~12 LV solid-state / molded-case breakers each, all on `Square D` LJ/PJ/RK frames, 600 V, tested on one date. Each breaker has: Contact Resistance A/B/C (µΩ), trip-unit function results (LTD timing band, STPU/GFPU trip/no-trip), and an Insulation Resistance matrix (phase-ground, phase-phase, line-to-load, in GΩ at 1000 VDC). This is exactly the "standard maintenance tier" the YoY engine trends.

Key real readings preserved verbatim as the 2025 anchor (these drive the story assets):

| Asset | Circuit | CR A | CR B | CR C | Note |
|---|---|---|---|---|---|
| B36S01 | SPARE 1 | **409** | 169 | 184 | A-phase already elevated (~2.4× siblings) |
| B36S01 | SPARE 7 | **411** | 140 | 205 | A-phase elevated |
| B36S01 | BUSS DUCT | 43 | 41 | 40 | tight/healthy reference |
| B41ST01 | (C-phase) | — | — | high | report deficiency **"A141 HIGH CONTACT RESISTANCE ON C PHASE — suggest remove & clean contacts"** |
| B47S01 | SPARE (3rd) | 183 | 195 | **403** | C-phase ~2× siblings |
| B47S01 | 3PA / BB36PP01 | ~42 | ~43 | ~42 | tight/healthy reference |

Healthy IR values are large (hundreds–thousands of GΩ line-to-load; phase-to-ground reads 0/open as expected with breaker closed). Trip-unit LTD results fall inside the 13–17 s band or read PASS. **These exact numbers are the year-2025 row for each measurement; synthesis only generates years < 2025.**

---

## 1. Backward-synthesis ALGORITHM

For every measurement reading R that has a 2025 anchor value `V_2025`, generate years `Y = 2024, 2023, … , Y_min` by walking backward. Because degradation moves the value toward "worse" as time advances, walking *backward* moves it toward "better" (younger equipment), with reversible step-events layered on top so the series is **non-monotonic and believable**, never a clean ramp.

### 1.1 State variables per reading
- `direction`: does this metric get WORSE up (contact resistance, PF/tanδ, DGA gas, battery ohmic) or WORSE down (insulation resistance, PI, battery capacity)? From the PARAMETER TABLE (§2).
- `driftPerYear`: the underlying secular trend magnitude (fraction/yr), sampled once per reading from the table's range so siblings differ.
- `noiseSigma`: gaussian measurement-noise σ (fraction of value) applied independently each year (repeatability of DLRO/megger + temp/contact variation).
- `eventProb`, `eventEffect`: probability per year of a maintenance/replacement step and its multiplicative reset.
- `tcf`: temperature-correction behavior for IR/PI/PF (corrected series must trend cleanly even though raw values wobble with ambient).

### 1.2 Core recurrence (worsens-with-time metric, e.g. contact resistance)
Let `f(Y)` = the *trend-only* value at year Y. Define the **as-found** value going backward:

```
value[2025]      = V_2025                          # anchor, never modified
trend[Y]         = trend[Y+1] / (1 + driftPerYear) # undo one year of secular creep
event[Y]         = sample maintenance step (see 1.4)
raw[Y]           = trend[Y] * event[Y] * (1 + N(0, noiseSigma))   # as-found, raw temp
value20c[Y]      = applyTCF(raw[Y], ambientTemp[Y], direction)    # corrected reading
```
For a **worsens-down** metric (IR, PI, capacity) invert: `trend[Y] = trend[Y+1] * (1 + driftPerYear)` (older year = healthier = higher IR). The sign of `driftPerYear` is always stated as "toward worse" in §2; the recurrence applies it in the right direction per metric.

### 1.3 Per-year temperature variation + TCF
- Assign each WorkOrder (annual test event) an `ambientTempC[Y]` drawn from a seasonal-realistic band for the plant floor, e.g. `N(22°C, 4°C)` clamped 12–34°C. Tests happen ~same month each year (Oct outage) so keep the mean stable but let it vary ±a few °C.
- IR/PI/PF readings are temperature-sensitive (IR roughly halves per +10°C; IEEE 43). Generate the **raw as-found** at that year's ambient, then store both the raw and the **20°C-corrected** value using `TCF = 0.5^((T−20)/10)` for IR. The corrected series carries the clean trend; the raw series carries believable wobble. This proves to a reviewer that temp-normalization matters (and exercises ServiceCycle's `temp_correction_factor_20c` / `insulation_resistance_20c` fields and `WorkOrder.ambientTempC`).
- Contact resistance has a mild temp coefficient; apply a small `(1 + 0.0004*(T−20))` factor to raw CR only (keeps it honest without overcorrecting). DLRO is largely temp-insensitive in practice, so keep this subtle.

### 1.4 Step "events" (make it non-monotonic)
Each year, with probability `eventProb`, inject a maintenance/replacement step that **resets the baseline**. Because we walk backward, a "cleaning in year Y" means the *as-found* value just *before* cleaning (year Y, before the tech cleaned) was HIGH and the *as-left* dropped — so model it as: raw[Y] spikes up by `eventEffect` then the following stored "as-left" returns to trend. Event catalog:

| Event | Applies to | Effect on as-found (going backward) | As-left | Frequency |
|---|---|---|---|---|
| Contact cleaning / re-torque | breaker/switchgear CR | as-found bumps up ~1.3–1.8×, as-left back to trend | reset to trend | rare on healthy, ~every 2–4 yr on a degrading unit |
| Breaker / contact-block replacement | breaker CR + IR | hard reset: pre-replacement year reads degraded, replacement year jumps to like-new (low CR, high IR) | new baseline | once across the window on a story asset |
| Insulation drying / re-gasket | IR/PI | as-found dips (moisture), as-left recovers | partial recovery | occasional after a wet year |
| Oil reclaim / filter (xfmr) | PF/tanδ, DGA, dielectric | step DOWN in PF & gases (improvement) at service year | reset toward new | once per ~5–7 yr if xfmr present |
| Battery cell/string replacement | battery ohmic + capacity | hard reset to commissioning baseline | new baseline | once if string is old |

Store as-found vs as-left into ServiceCycle's `TestMeasurement.asFoundValue` / `asLeftValue`. Most events leave as-found == as-left (no action). Story-asset events show a real gap.

### 1.5 Pass/fail + expectedRange
For each reading, set `passFail` and `expectedRange` from the metric's acceptance rule (§2 "flag threshold" column), evaluated on the **corrected** value. Healthy assets stay PASS every year; story assets flip to FAIL (or "investigate") in the most recent 1–3 years as the trend crosses threshold — which is exactly what makes the demo's YoY callout fire.

### 1.6 Determinism
Seed the RNG per `(assetId, circuit, measurementType, phase)` so re-runs reproduce identical history (idempotent reseed). Anchor year is excluded from RNG — it is copied verbatim.

---

## 2. PARAMETER TABLE (per test / equipment type)

Drift = secular trend "toward worse," expressed as fraction/yr. Noise σ = gaussian, fraction of reading. Event = annual probability / multiplicative effect. Flag threshold = the YoY rule from companion §4 the synthesized trend must eventually trip on story assets (and must NOT trip on healthy ones).

| Equipment / Test | measurementType | Unit | Worse dir. | Annual drift (toward worse) | Noise σ | Event prob / effect | YoY flag threshold | Grounded in |
|---|---|---|---|---|---|---|---|---|
| LV breaker / switchgear — contact resistance | `contact_resistance` | µΩ | up | **2–6 %/yr** (healthy ~2–3 %; degrading 5–8 %) | 4–7 % | clean 0.05–0.25/yr → as-found ×1.3–1.8; replace once → ÷3–5 | YoY +>20–50% **or** one phase ≥1.5–2× siblings **or** >1.5× baseline → "remove & clean contacts" | NETA MTS ±50% phase-spread; "investigate >1.5× baseline"; LV breaker rule-of-thumb <100 µΩ good / >300 µΩ trouble [1][2] |
| Breaker / switchgear / bus — insulation resistance | `insulation_resistance` / `insulation_resistance_20c` | GΩ / MΩ | down | **3–7 %/yr** decline (corrected) | 8–15 % (raw, pre-TCF) | dry-out 0.05/yr → dip then recover | YoY drop >50% or value collapsing toward 0 vs siblings → moisture/insulation | IR halves per +10°C → temp-correct to 20°C; trend corrected values [3][4] |
| Breaker trip unit — LTD timing / STPU / GFPU | `lt_delay` / `st_pickup` / `gf_pickup` result | sec / trip-notrip | drift out of band / trip→no-trip | timing drift ~1–3 %/yr (electromech-ish); mostly stable for solid-state | 2–4 % | calibration/replacement reset; rare no-trip event | any function FAIL or timing outside min/max band | relay/trip-unit drift; recalibrate at commissioning, +1 yr, then every 2 yr [5] |
| Transformer (if added) — power factor / tanδ | `power_factor_pct` / `pf_corrected_20c` | % | up | **0.01–0.03 %-pt/yr** (slow; <1% healthy band) | 5–10 % | oil reclaim → step down | >1.0% investigate; trend up vs baseline | new <0.5%, aged 0.5–1% acceptable, >1% investigate [6] |
| Transformer — DGA key gases | `dga_h2` `dga_ch4` `dga_c2h2` `dga_co` `dga_co2` | µL/L (ppm) | up | H2/CH4/CO2 slow creep; C2H2 = 0 unless arcing event | 10–20 % | oil reclaim → reset; arcing event → C2H2 spike | gas-by-gas 90th/95th percentile (Status 1/2/3); rate-of-increase µL/L/yr; any C2H2 = arcing | IEEE C57.104-2019 percentile status + µL/L/yr rate [7] |
| Transformer — IR / PI | `polarization_index` `insulation_resistance_20c` | ratio / MΩ | down | PI drift −0.01–0.03/yr; IR −3–7%/yr | PI ±0.1; IR 8–15% | dry-out recovery | PI < ~1.0–2.0 or declining IR | IEEE 43; PI is a ratio (no temp-correction) [3] |
| Stationary battery — internal/ohmic resistance | `cell_internal_resistance` / `cell_impedance` | µΩ / mΩ | up | **3–6 %/yr** rise vs commissioning baseline | 3–6 % | string replace → reset to baseline | cell >20–25% above baseline → replace candidate | IEEE 1188: replace cell >20% above commissioning baseline [8] |
| Battery — capacity | `percent_capacity_pct` | % | down | ~1.5–3 %-pt/yr toward EOL | 2–4 % | string replace → reset to ~100% | <80% nameplate → string EOL | IEEE 1188/450: string EOL at <80% capacity [8] |
| MV cable (if added) — tanδ (VLF) | `tan_delta` / `power_factor_pct` | % / 1e-3 | up | slow creep; step jumps with water-tree onset | 10–20 % | re-termination reset | rising vs baseline; water-tree/PD pattern | VLF tanδ standard MV aging diagnostic (water trees) [9] |
| Protective relay (if added) — pickup / timing | `toc_pickup` `inst_pickup` `timing_*` | A / sec | drift either way out of tolerance | 1–3 %/yr (electromech), ~0 (microprocessor) | 2–4 % | recalibration reset | outside pickup_min/max or timing_min/max band | recalibrate at commission, +1yr, every 2yr; EM relays drift more [5] |

Notes:
- The report in hand is **all LV breakers + switchgear**, so rows 1–3 are the must-haves and produce the headline trends. Transformer/battery/cable/relay rows are included so the same algorithm and seeder generalize if those asset types are added to the dummy customer for a richer demo (recommended: add at least one liquid transformer and one battery string per §3).
- Drift ranges are intentionally per-reading-sampled so sibling breakers fan out instead of all tracking identically — the single biggest "fake" tell to avoid.

---

## 3. STORY ASSETS plan

Majority of breakers (the BUSS DUCT / 3PA / tight-CR-in-40s circuits) stay **healthy**: low drift (~2%/yr), no events, PASS every year, flat-ish corrected IR. These are the "boring good" baseline that makes the bad ones legible.

Three deliberate degradation narratives:

1. **B41ST01 — C-phase contact resistance (the real-finding asset).** This is the anchor the source report flagged: *"A141 HIGH CONTACT RESISTANCE ON C PHASE — suggest remove & clean contacts."* Drive C-phase CR with high drift (6–8%/yr toward 2025), keep A/B near-flat, so the phase-spread ratio crosses the NETA ±50% / "one phase ≥1.5× siblings" rule in roughly 2023→2025. Add a single contact-cleaning event ~2020 (as-found bump, as-left recovery) so the long arc shows: cleaned once, then crept back up — narratively "should have addressed it sooner." YoY engine fires "remove & clean contacts," matching the real deficiency text.

2. **B36S01 — A-phase contact resistance creep (SPARE 1 / SPARE 7).** A-phase anchors are already ~2.4× siblings (409/411 µΩ). Walk back so A-phase was in-family (~150–200 µΩ) around 2018–2019 and steadily diverged — a slow loosening/oxidation story with NO cleaning event (untouched), so the trend is a clean monotone-ish climb that the YoY %-increase rule catches even before the phase-spread rule does. Demonstrates the "+>20% YoY" path distinct from the phase-imbalance path.

3. **B47S01 — insulation-resistance decline + late trip-unit drift.** Pick one circuit and drive its corrected line-to-load IR down 6–7%/yr from healthy thousands of GΩ toward a flagging value, with one moisture dip+recovery event mid-window (re-gasket). In the last 1–2 years also nudge its trip-unit LTD timing toward the edge of the 13–17 s band so it reads "investigate." This exercises the **falling-IR** and **trip-unit** YoY paths so the demo isn't a one-trick (contact-resistance-only) pony.

> Optional 4th (if transformer/battery added): one liquid transformer with slowly rising tanδ + a CO2 creep and a clean oil-reclaim step ~2021; one battery string with ohmic resistance climbing past +20% baseline on 2 cells in the last year. Both light up DGA / IEEE-1188 paths for a fuller "every indicator type" demo.

---

## 4. DUMMY COMPANY + ASSET plan

- **Company:** `Northwind Foods — Plant 2` (fake). **Site:** `Cedar Ridge Facility, Bay 4` (fake). **Service vendor on WorkOrders:** `Apex Power Testing LLC` (fake). **Techs:** `J. Carter`, `M. Alvarez` (fake) — populate `WorkOrder.contractor` / tested-by. None of these appear in the source report.
- **Asset hierarchy (matches model option (a) — breaker = child Asset, from companion §5):**
  - 4 parent assets = the four unit substations, generic device IDs preserved: `B36S01`, `B41ST01`, `B43N01`, `B47S01` (equipmentType SWITCHGEAR/SWITCHBOARD, equipmentDesignation "Unit Substation").
  - Each parent has its child breaker assets (`SPARE 1`, `4PA`, `BUSS DUCT`, `BB36PP01`, `3PA`, etc.) carrying `nameplateData` = MFG/Type/Frame/Trip/Functions from the report (Square D LJ400/PJ800/RK1200, 600 V, LSI/LSIG).
  - Optional enrichment assets (recommended): one `TRANSFORMER_LIQUID` feeding a substation + one `BATTERY_SYSTEM` (switchgear control/DC) so the demo shows non-breaker trend types too.
- **One WorkOrder per asset per year** (the annual outage test event), each with `completedDate` (~late-Oct each year), `ambientTempC`, `contractor`, `testEquipment` JSON (fake Megger DLRO-10HD + insulation tester, fake cal date), and the year's `measurements[]`.

### Recommended # of years: **9 (2017–2025 inclusive)**
Rationale:
- Long enough that slow trends (3–7%/yr) accumulate into a visually obvious slope and that step-events have room to land without crowding (a 9-point series reads as a real history, not 3 dots).
- Matches real industrial practice: annual outage testing on a ~25–35 yr-old plant substation typically has a credible digital record going back ~8–10 years (PowerDB era), beyond which records get spotty — so 9 years is both believable and at the edge where a reviewer would expect data to thin out. 10 is fine; 7 is the floor. Pick 9 as the sweet spot; the seeder takes `yearsBack` as a parameter so it's trivially 7–10.
- Optionally simulate one or two "missing year" gaps on a single asset (e.g., 2019 outage skipped) to look authentic — but keep the story assets' series complete so trends are clean to demo.

### Rough row count
Per the source structure: 4 substations × ~12 breakers = ~48 breakers. Per breaker per year:
- Contact resistance: 3 phases = 3 rows
- Insulation resistance: ~9-reading matrix (subset non-zero) = up to 9 rows (count ~9)
- Trip-unit: LTD timing + STPU + GFPU ≈ 3 rows
≈ **15 measurement rows per breaker per year.**

`48 breakers × 15 rows × 9 years ≈ 6,480 TestMeasurement rows`, plus `48 × 9 = 432 WorkOrders`, plus ~52 assets (4 parents + 48 children). With optional transformer (+~25 rows/yr: TTR/winding/IR/PI/oil/DGA) and battery (~per-cell ohmic × N cells), add a few hundred more. **Plan for ~6,500–7,500 measurement rows total.**

---

## 5. Reconciliation note

- **2025 == real, exactly.** The synthesized year-2025 WorkOrder for every asset must contain the transcribed source values byte-for-byte (contact resistances 409/169/184, etc., IR matrix, trip results). Synthesis writes years 2017–2024 only; 2025 is a literal copy of the transcription table. A post-seed assertion should diff the 2025 rows against the transcription fixture and fail the build on any mismatch.
- **Trend reconciliation:** the YoY engine, run over the seeded data, must (a) raise the contact-cleaning flag on B41ST01 (C-phase) and B36S01 (A-phase), (b) raise the falling-IR / trip-unit flag on B47S01, and (c) raise NOTHING on the healthy reference breakers. That pass/fail of the engine on known-seeded ground truth doubles as the acceptance test for both the seeder and the YoY logic.
- **Anonymization check:** grep the seeded DB for the real company/vendor/site/person strings → must return zero. Only generic device IDs and numbers survive.

---

## Sources
1. TestGuy / EC&M — LV breaker contact-resistance acceptance & trending (NETA MTS ±50% phase-spread; <100 µΩ good, >300 µΩ trouble; investigate >1.5× baseline): https://forum.testguy.net/threads/2736 ; https://www.ecmweb.com/test-measurement/article/20896912/dc-testing-of-circuit-breakers
2. Schneider Electric 0600DB1901 — Circuit Breaker Contact Resistance Testing Data Bulletin (trend annually): https://www.productinfo.schneider-electric.com/0600db1901resistancetesting/
3. Megger — Individual Temperature Correction for IR (IR halves per +10°C; correct to 20°C; PI is a ratio): https://media.megger.com/.../individual-temperature-correction-for-insulation-resistance-measurements.pdf
4. xbrele — IR / PI / Tan Delta interpretation (trending, temp dependence): https://xbrele.com/ir-pi-tan-delta-test-interpretation-guide/
5. SEL / field guidance — protective-relay & trip-unit calibration drift; recalibrate at commission, +1 yr, every 2 yr; EM drift > microprocessor: https://selinc.com/api/download/3683/id/3705/0/
6. IEEE C57.152 via tan-delta references — new <0.5%, aged 0.5–1% acceptable, >1% investigate: https://www.hvtechnologies.com/evaluation-tan-delta-power-factor-results/
7. IEEE C57.104-2019 DGA — gas-by-gas 90th/95th percentile Status 1/2/3, µL/L/yr rate-of-increase, C2H2=arcing: https://powerprognosis.com/ieee-c57-104-2019-vs-2008-what-changed-why-it-matters-for-transformer-dga/
8. IEEE 1188 / 450 stationary battery — replace cell >20–25% above commissioning ohmic baseline; string EOL <80% capacity: https://eepowersolutions.com/resources/tech-notes/ohmic-measurements-and-ieee-standard-1188-2005/
9. NETA World / VLF tan-delta — MV cable aging diagnostic (water trees), trend vs baseline: https://netaworldjournal.org/2020/09/thomasdsandri/features/acceptance-and-maintenance-testing-medium-voltage-electrical-power-cables/
