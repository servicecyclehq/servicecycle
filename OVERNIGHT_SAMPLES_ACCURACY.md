# Arc-Flash Extraction Accuracy — Sample Run

Generated: 2026-06-22T14:18:30.018Z
Samples dir: `C:\Users\ddeni\Desktop\ServiceCycle\Arc Flash Samples`
AI_ENABLED=true · provider key present: true  → full AI extraction ran

Files: 6

---

### Arc-Flash-Study-Report-Example.pdf
(5.99 MB)

**Deterministic probe (no AI):**
- pdfplumber: **53,009 text chars**, 25 tables, 381 table rows → **text path** (no vision tokens spent)
- rasterize: produced 2 page image(s) for the vision path

_auto extract threw: [GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: [503 Service Unavailable] This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later._
#### Auto path (pipeline default)
_(no result)_

#### Forced vision path (rasterized page 1)
- method: `vision`  ·  provider: —  ·  prompt: af-extract-v1
- system: sourceV=—, serviceFault=—, xfmr=—kVA —/—, PE=Zarheer Jooma, sw=—
- system gaps: missing utilityMaxFaultKA, utilityMinFaultKA, utilityXR
- **0 bus(es) extracted**

- warnings: _No buses were extracted — the document may not be a one-line / study, or the scan is too low quality._

---

### Arc_Flash_Risk_Assessment_Sample_Report.pdf
(0.97 MB)

**Deterministic probe (no AI):**
- pdfplumber: **41,645 text chars**, 2 tables, 9 table rows → **text path** (no vision tokens spent)
- rasterize: produced 2 page image(s) for the vision path

#### Auto path (pipeline default)
- method: `text`  ·  provider: —  ·  prompt: af-extract-v1
- system: sourceV=—, serviceFault=—, xfmr=—kVA —/—, PE=—, sw=—
- system gaps: missing utilityMaxFaultKA, utilityMinFaultKA, utilityXR
- **0 bus(es) extracted**

- warnings: _Could not parse the AI response as JSON — try re-uploading._

#### Forced vision path (rasterized page 1)
- method: `vision`  ·  provider: —  ·  prompt: af-extract-v1
- system: sourceV=—, serviceFault=—, xfmr=—kVA —/—, PE=—, sw=BRADY SAFETY SOFTWARE & SERVICES
- system gaps: missing utilityMaxFaultKA, utilityMinFaultKA, utilityXR
- **1 bus(es) extracted**
- readiness roll-up: 0/1 not-blocked · overall band **red**

| Bus | Type | Readiness | Conf | Still needs |
|---|---|---|---|---|
| Equipment 4 | SWITCHBOARD | blocked | red | Upstream device + trip settings |

---

### Arc_Flash_the_Easy_Way_2022_PART_2.pdf
(2.51 MB)

**Deterministic probe (no AI):**
- pdfplumber: **6,005 text chars**, 0 tables, 0 table rows → **text path** (no vision tokens spent)
- rasterize: produced 2 page image(s) for the vision path

#### Auto path (pipeline default)
- method: `text`  ·  provider: —  ·  prompt: af-extract-v1
- system: sourceV=—, serviceFault=—, xfmr=—kVA —/—, PE=Jim Chastain, sw=EasyPower
- system gaps: missing utilityMaxFaultKA, utilityMinFaultKA, utilityXR
- **0 bus(es) extracted**

- warnings: _No buses were extracted — the document may not be a one-line / study, or the scan is too low quality._

#### Forced vision path (rasterized page 1)
_threw: [GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent: [503 Service Unavailable] This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later._

---

### EasyPower arc flash hazard analysis.pdf
(3.68 MB)

**Deterministic probe (no AI):**
- pdfplumber: **0 text chars**, 0 tables, 0 table rows → too little text, would fall to vision
- rasterize: produced 2 page image(s) for the vision path

_auto extract threw: [GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: [503 Service Unavailable] This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later._
#### Auto path (pipeline default)
_(no result)_

#### Forced vision path (rasterized page 1)
_threw: [GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent: [503 Service Unavailable] This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later._

---

### EasyPower_Data_Collection_for_Arc_Flash_Studies_Sm_-1a.pdf
(1.56 MB)

**Deterministic probe (no AI):**
- pdfplumber: **22,921 text chars**, 4 tables, 33 table rows → **text path** (no vision tokens spent)
- rasterize: produced 2 page image(s) for the vision path

#### Auto path (pipeline default)
- method: `text`  ·  provider: —  ·  prompt: af-extract-v1
- system: sourceV=—, serviceFault=—, xfmr=—kVA —/—, PE=—, sw=—
- system gaps: missing utilityMaxFaultKA, utilityMinFaultKA, utilityXR
- **7 bus(es) extracted**
- readiness roll-up: 0/7 not-blocked · overall band **red**

| Bus | Type | Readiness | Conf | Still needs |
|---|---|---|---|---|
| VS2 | GENERATOR | blocked | red | System voltage, Available fault current, Upstream device + trip settings, Electrode configuration, Conductor gap, Working distance |
| S4 | GENERATOR | blocked | red | System voltage, Available fault current, Upstream device + trip settings, Electrode configuration, Conductor gap, Working distance |
| S5 | GENERATOR | blocked | red | System voltage, Available fault current, Upstream device + trip settings, Electrode configuration, Conductor gap, Working distance |
| M7 | GENERATOR | blocked | red | System voltage, Available fault current, Upstream device + trip settings, Electrode configuration, Conductor gap, Working distance |
| M8 | GENERATOR | blocked | red | System voltage, Available fault current, Upstream device + trip settings, Electrode configuration, Conductor gap, Working distance |
| L9 | GENERATOR | blocked | red | System voltage, Available fault current, Upstream device + trip settings, Electrode configuration, Conductor gap, Working distance |
| L9 (6w.) | GENERATOR | blocked | red | System voltage, Available fault current, Upstream device + trip settings, Electrode configuration, Conductor gap, Working distance |

#### Forced vision path (rasterized page 1)
_threw: [GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent: [503 Service Unavailable] This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later._

---

### PracSolGuideArcHaz-LR1.pdf
(1.64 MB)

**Deterministic probe (no AI):**
- pdfplumber: **61,726 text chars**, 1 tables, 6 table rows → **text path** (no vision tokens spent)
- rasterize: produced 2 page image(s) for the vision path

#### Auto path (pipeline default)
- method: `text`  ·  provider: —  ·  prompt: af-extract-v1
- system: sourceV=—, serviceFault=—, xfmr=—kVA —/—, PE=Chet Davis, P.E., sw=EasyPower
- system gaps: missing utilityMaxFaultKA, utilityMinFaultKA, utilityXR
- **0 bus(es) extracted**

- warnings: _No buses were extracted — the document may not be a one-line / study, or the scan is too low quality._

#### Forced vision path (rasterized page 1)
_threw: [GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent: [503 Service Unavailable] This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later._

---
