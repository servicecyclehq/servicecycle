# ServiceCycle — Arc-Flash Data Model: PE Review Worksheet

**What this is.** ServiceCycle is becoming the place a facility *stores, tracks, and manages every data point from their arc-flash studies* over time — inputs, device details, results, and labels — kept study-over-study so each piece of equipment can be trended across re-studies and the 5-year cycle. We drafted the full data set below from **NFPA 70E-2024** and **IEEE 1584-2018**. You're our accuracy check: make sure the terms, values, units, and rules match how studies are actually performed. You are **not** deciding what a customer should keep (they decide that) — just whether our standards-based pieces are correct and complete.

**How to use this (5 minutes per section).** For every row there's a **OK?** column — just put **Y** or **N**. If **N**, scribble the fix in **Notes**. At the end of each section there's a blank "**Anything missing?**" line — that's where you add anything we don't have. Bullet points / shorthand are fine. Don't worry about formatting; we'll translate it.

Legend for the "Class" column: **REQ** = needed to run the calc · **TYP** = can default by equipment type · **OUT** = a result/label value · **MIT** = mitigation/context.

---

## 1. Equipment classes + their typical defaults
When a tech can't measure, we pre-fill these IEEE 1584-2018 typicals (a PE can override). Are the defaults right?

| Equipment class | Typ. electrode | Typ. gap (mm) | Typ. working dist. (in) | OK? | Notes / fix |
|---|---|---|---|---|---|
| LV panelboard (<=600 V) | VCB | 25 | 18 | | |
| LV MCC | VCB (HCB if horizontal bus) | 25 | 18 | | |
| LV switchgear (600 V) | VCB | 32 | 24 | | |
| Cable / cable junction | VCB | 13 | 18 | | |
| 5 kV switchgear | VCB | 104 | 36 | | |
| 15 kV switchgear | VCB | 152 | 36 | | |
| Open-air bus | VOA / HOA | by voltage | task-specific | | |

**Anything missing (equipment classes we don't list)?** ________________________________________

---

## 2. Electrode configurations
We store these as a fixed list of 5 (IEEE 1584-2018). Right set, right names?

| Code | Meaning | OK? | Notes / fix |
|---|---|---|---|
| VCB | Vertical conductors in a box | | |
| VCBB | Vertical conductors / insulating barrier in a box | | |
| HCB | Horizontal conductors in a box | | |
| VOA | Vertical conductors in open air | | |
| HOA | Horizontal conductors in open air | | |

(We saw "VCCB" used some places for VCBB — we standardized on **VCBB**. OK? Y / N: ____)

---

## 3. Protective devices — what a tech records, and WHEN settings are required  ⭐ most important section
This is the big one. For each device family: are the fields we'd ask a tech to record correct, and is the "settings required?" call right?

| Device family | Fields we'd record | Settings required? | OK? | Notes / fix |
|---|---|---|---|---|
| Fuse (any class) | class, amp rating, voltage rating, mfr, model | **No** (clearing from class+rating via TCC) | | |
| MCCB — thermal-magnetic | frame A, trip rating A, mfr, model, (adj. instantaneous if present) | **No** (fixed; TCC from rating) | | |
| MCCB — electronic trip (LSI/LSIG) | frame A, sensor/plug A, mfr, model, **LSIG settings** | **Yes** | | |
| Insulated-case breaker (ICCB) | frame A, sensor A, mfr, model, **LSIG settings**, ERMS? | **Yes** | | |
| LV power breaker (LVPCB / air-frame) | frame A, sensor A, mfr, model, **LSIG settings**, ERMS? | **Yes** | | |
| Relay + breaker (MV, or relayed LV) | ANSI device #s, **CT ratio**, **relay settings**, breaker mfr/model | **Yes** | | |

**The rule we want to bake in — please confirm (Y / N): ____**
> Recorded trip **settings are required ONLY** for field-adjustable devices — **electronic trip units (LSI/LSIG)** and **relays**. For **fuses** and **thermal-magnetic breakers** (and plain switches), settings do **not** apply — type + frame/amp rating is the complete field record, and clearing time comes off the published TCC.

If that rule is wrong or has exceptions, tell us where: ________________________________________

**Anything missing (device families / fields you always record)?** ________________________________________

---

## 4. Fuse classes
Right list? Mark any to drop/add, and correct "current-limiting?" if needed.

| Class | Current-limiting? | OK? | | Class | Current-limiting? | OK? |
|---|---|---|---|---|---|---|
| L | Yes | | | CC | Yes | |
| RK1 | Yes | | | G | Yes | |
| RK5 | Yes | | | CF | Yes | |
| J | Yes | | | H | No | |
| T | Yes | | | K | Yes | |

**Missing fuse classes?** ________________________________________

---

## 5. Relay functions (ANSI device numbers) we let them record
| ANSI # | Function | Settings we capture | OK? | Notes |
|---|---|---|---|---|
| 50 | Instantaneous overcurrent | pickup | | |
| 51 | Time overcurrent | pickup, time dial, curve | | |
| 50G / 50N | Inst. ground/neutral | pickup | | |
| 51G / 51N | Time ground/neutral | pickup, time dial, curve | | |
| 87 | Differential | zone, slope, pickup | | |
| 50AF / fast-bus | Arc-flash relay | light setpoint, current supv., trip time | | |

**Missing relay functions you set in the field?** ________________________________________

---

## 6. Mitigation we capture (these change the result / drive a 2nd label state)
| Item | What we capture | OK? | Notes |
|---|---|---|---|
| ERMS / maintenance mode | present?, reduced instantaneous pickup, reduced energy (cal/cm2) | | |
| Zone-selective interlocking (ZSI) | enabled? | | |
| Differential relaying (87) | present?, zone | | |
| Arc-resistant switchgear | rated?, standard, doors-open vs closed | | |
| NEC 240.87 method (trip setting >= 1200 A) | which method + setting | | |

**Missing mitigation types?** ________________________________________

---

## 7. Units + sane ranges (so we can catch fat-finger entries)
Confirm the unit we store each value in, and a normal min-max.

| Data point | Unit we store | Proposed normal range | OK? | Correct unit / range |
|---|---|---|---|---|
| Nominal voltage | V | 120 - 38,000 | | |
| Bolted fault current | kA | 0.5 - 106 | | |
| Arcing current | kA | 0.2 - 100 | | |
| Conductor gap | mm | 6 - 254 | | |
| Working distance | in | 12 - 48 | | |
| Clearing time | ms | 8 - 2,000 | | |
| Incident energy | cal/cm2 | 0.1 - 200 | | |
| Arc-flash boundary | in | 1 - 600 | | |
| Required arc rating (ATPV/EBT) | cal/cm2 | 4 - 100 | | |
| Enclosure H / W / D | mm | 100 - 1,500 | | |
| Shock: limited / restricted approach | in | 0 - 120 | | |

**Any value we should store in a different unit, or a range that's off?** ________________________________________

---

## 8. Required vs typical vs outcome
Did we classify each input correctly? (REQ = must have to run · TYP = can default · OUT = result)

| Data point | Our classification | OK? | Fix |
|---|---|---|---|
| Nominal voltage | REQ | | |
| Bolted fault current (or feeder cable to compute it) | REQ | | |
| Upstream device + (settings only if adjustable) | REQ | | |
| Electrode config | TYP (default by class) | | |
| Conductor gap | TYP | | |
| Working distance | TYP | | |
| Enclosure type + dimensions | TYP (REQ for size correction) | | |
| Utility max + min fault + X/R | REQ (system) | | |
| Transformer kVA / %Z / connection | REQ (system) | | |
| Incident energy, AF boundary, PPE, arc rating | OUT | | |

**Anything classified wrong?** ________________________________________

---

## 9. Source / system inputs (feed the fault-current calc)
| Input | Fields we capture | OK? | Notes |
|---|---|---|---|
| Utility / service | available fault **max**, **min**, X/R | | |
| Transformer | kVA, primary V, secondary V, %Z, X/R, connection | | |
| Motors | total HP + count (no 50 HP exemption) | | |
| Generators | kVA, V, subtransient reactance | | |
| Cable / feeder | length, size, material (Cu/Al), # per phase, conduit type | | |

**Missing source data?** ________________________________________

---

## 10. Results, label, and DANGER/WARNING — confirm
- We capture **both** PPE approaches (incident-energy method *and* the PPE-category table method) and store which one a label uses. **OK? Y / N: ____**
- The NFPA 70E 130.5(H) label fields we store: nominal voltage, arc-flash boundary, incident energy + working distance OR arc rating OR PPE category, study date, shock boundaries, equipment ID. **Anything missing? ____**
- We flag **DANGER** when incident energy **> 40 cal/cm2 OR voltage > 600 V**, else **WARNING**. **Correct threshold? Y / N: ____**

---

## 11. Bottom line
- Are we capturing the right overall set of data for a real study? **Yes / Mostly / No: ____**
- The single most important thing we're missing: ________________________________________
- Anything that would make this genuinely useful to you and other engineers (contractor or in-house), at any experience level: ________________________________________

*Thanks — every "N" and every "missing" you write makes the platform store these studies the way the people who actually run them need it to.*
