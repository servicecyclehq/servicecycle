# ServiceCycle — Golden-Path Demo Script (Acquisition Buyer)

**Format:** ~5-minute live demo, screenshare — rehearsable, one continuous story
**Audience:** PE operating partner / OEM corp-dev (the person who has to underwrite the asset)
**Live site:** https://servicecycle.app
**Logins** *(each account has its own password — see `server/scripts/seed-demo.js`)*:
- `admin@demo.local` / `Admin1234!` — admin *(drive the demo with this one)*
- `manager@demo.local` / `Manager1234!` — manager
- `viewer@demo.local` / `Viewer1234!` — viewer (read-only)
- `consultant@demo.local` / `Consultant1234!` — consultant
- `tech@demo.local` / `Tech1234!` — field_tech (field mode)
- `sam.carter@apexpower.demo` / `Demo1234!` — oem_admin, Apex Power Services partner org *(required for the 4:00 fleet beat — `admin@demo.local` cannot open `/fleet`)*
**Account:** Meridian Manufacturing — 2 sites (Riverside, Davenport IA · Eastgate, Moline IL), 18 assets, 231 historical work orders
**One thing to leave them thinking:** *"This is a defensible safety-data asset with a recurring compliance workflow and a channel to scale it."*

> Presenter rule: say the ONE line, let the screen do the work, move on. Don't narrate the UI. Watch the clock.

---

## THE ARC (≈5:00)

### 0:00 — The hook *(say this before you log in)*
**Do:** Nothing yet — talk to the camera.
**Say:** *"Electrical safety and compliance is high-stakes, regulated, and almost entirely run out of PDFs and spreadsheets. When a bus is one fault away from a fatality, that fact is sitting in a filing cabinet. We turn it into a live, monitored record that tells you what to do next."*
**Buyer takeaway:** Big, ugly, under-digitized problem with legal liability attached — the kind that rewards owning the data layer.

### 0:30 — Login → the "easy button" dashboard
**Do:** Log in as `admin@demo.local`. Land on the home/fleet dashboard. Don't scroll — let the action list sit there.
**Say:** *"This is the whole portfolio in one screen — 5 items overdue, 1 regulatory breach, and one asset flagged DANGER — the system already tells me where to look first."*
**Buyer takeaway:** Not a dashboard to interpret — a prioritized worklist. The product does the triage.
**Numbers on screen:** 5 overdue · 1 regulatory breach · 6 due within 30 days · 8 open deficiencies (1 immediate) · arc-flash expiring within ~10 months · 11 criticality-scored · 2 predictive-maintenance-flagged.

### 1:00 — Drill into the HERO: arc-flash bus **SWGR-1A Main Bus** (the liability story)
**Do:** Click the DANGER flag → open **SWGR-1A Main Bus (SWGR-1A-1)** → Arc Flash tab.
**Say:** *"This 13.8 kV main bus carries a PE-stamped study at 19.6 cal/cm² — a DANGER label — and it's gotten worse, trending up from 14.2 to 19.6, so the hazard is moving the wrong way."*
**Do (point, don't dwell):** the study's **incident energy**, **PPE / arc rating**, and **arc-flash/shock boundaries**; then the **tamper-evident audit trail** and the **logged arc-flash incident** on this bus.
**Say:** *"Every number here is PE-stamped and version-controlled — ServiceCycle is the system of record for the licensed engineer's study, not a calculator — and there's already a recorded incident on this exact bus. That's the difference between 'we think we're safe' and a defensible, timestamped record when OSHA shows up."*
**Buyer takeaway:** This is the moat — proprietary, PE-stamped, audit-trailed life-safety data tied to real liability. You cannot rebuild this from a spreadsheet.
> Liability posture (don't ad-lib past it): ServiceCycle does **not** run the IEEE 1584 calc or assert PPE categories itself — it stores and version-controls the licensed PE's sealed study results. The Arc Flash tab says exactly this on screen ("a licensed PE runs and stamps the study").

### 2:30 — Turn the hazard into action (the workflow)
**Do:**
1. Open **Deficiencies** — the **OPEN · IMMEDIATE** finding sits at the top of the triage queue: SWGR-2M's B-phase hot joint (ΔT 38°C above ambient).
2. Click **Create work order** right on that row. The modal opens already locked to the right asset — **NorthStar Switchgear Co. NS-LV600** (that's SWGR-2M) — with the finding's description pre-seeded in the notes.
3. In the modal: Contractor: **Apex Electrical Testing** → Assigned tech: **Carmen Rios (NETA Level II)** → click **Create work order**. You land on the new job — the finding is already riding on it under **Deficiencies found**, and a red banner says the job **can't be completed** while the IMMEDIATE deficiency is open.
**Say:** *"Thirty seconds, and the hazard is an assigned, tracked work order with the finding riding on it — it doesn't die in a report. And notice the platform won't let anyone close this job until that IMMEDIATE finding is resolved with a documented corrective action. That's accountability the spreadsheet never gave them."*
**Optional flourish:** flip back to **Deficiencies** — the finding now shows a **View WO →** link where the Create button was.
**Buyer takeaway:** Recurring operational workflow, not a one-time inspection. This is the stickiness — and the path to recurring revenue.

### 3:15 — The leave-behind: the artifacts a customer/board actually holds
**Do:** Generate the **NETA leave-behind PDF**, then open the **CFO ROI / maintenance-debt report**.
**Say:** *"The contractor hands the customer a NETA compliance packet, and hands the CFO a maintenance-debt and ROI number — the tangible artifacts that justify the renewal and the next PO."*
**Buyer takeaway:** Two audiences, two artifacts, one system — the technical buyer AND the economic buyer both get something to hold. That's how this renews.

### 4:00 — The flywheel close: channel + the thesis
**Do:** Switch to the partner view: **log out** of `admin@demo.local`, **log in as `sam.carter@apexpower.demo` / `Demo1234!`** (role `oem_admin` — the fleet dashboard at `/fleet` is gated to this role; `admin@demo.local` cannot see it), then open the fleet dashboard — **Apex Power Services** (contractor org: 6 customers, 4 reps, 1 manager).
**Say:** *"And it rolls up: one contractor like Apex Power Services manages 6 customers, 4 reps, all on the same rails — so this scales through the existing electrical-contractor channel, not one facility at a time."*
**Say (the thesis — land it slowly):** *"So what you're buying is three things that compound: defensible, PE-stamped safety data; a recurring compliance workflow customers can't easily leave; and a contractor channel to roll it up. That's an acquirable asset, not a feature."*
**Buyer takeaway:** Data moat × recurring workflow × channel = a roll-up platform, priced as an asset.

### ~5:00 — Stop.
**Do:** Stop sharing the cursor. Don't keep clicking.
**Say:** *"That's the five-minute version — where do you want to go deeper?"*

---

## 30-SECOND ELEVATOR (3 beats)
1. *"Electrical safety/compliance is high-stakes and still run on PDFs."*
2. *"We have a live bus carrying a PE-stamped 19.6 cal/cm² DANGER label, trending worse, with a logged incident and a tamper-evident audit trail — proprietary safety data you can't fake."*
3. *"It turns hazards into assigned work, hands the customer a NETA packet and the CFO an ROI number, and rolls up through the contractor channel — defensible data + recurring workflow + channel = an acquirable asset."*

---

## IF THEY GRAB THE KEYBOARD (safe to let them click)
Everything is seeded and coherent — let them roam these:
- **Dashboard tiles / action list** — every count drills into a real list.
- **Assets:** SWGR-1A Main Bus (hero), **GEN-1** (generator — monthly NFPA 110 exercise history), **SWGR-2M** (thermography hot-spot deficiency), **T-1** (transformer installed 1997).
- **Arc-flash report** — 4 arc-flash incidents, labels by site.
- **Deficiencies** (9, one OPEN IMMEDIATE), **Work orders** (231 historical, 2 yrs), **Schedules** (88).
- **Incident register / incident log** (6 entries), **System studies** (3), **Audit visits** (4), **Recommendations** (6), **Alerts** (17), **Quote requests** (4), **Parts** (7), **LOTO procedures** (2).
- **Partner roll-up:** Apex Power Services (6 customers, 4 reps, manager).
- Log in as `viewer@demo.local` (`Viewer1234!`) or `consultant@demo.local` (`Consultant1234!`) to show **role-based access** is real.

## DO NOT CLICK / KNOWN ROUGH EDGES
- Don't live-edit or delete seed data mid-demo — if you must, reseed afterward (it powers the hero story; resolving or deleting SWGR-2M's IMMEDIATE deficiency breaks beat 2:30).
- Beat 2:30 **adds a work order and links the seeded IMMEDIATE finding to it** by design — deficiency counts stay accurate, but a linked finding shows **View WO →** instead of the **Create work order** button, so reseed between rehearsals to run the beat again.
- Don't free-type into AI/ingest fields under time pressure — live model calls can be slow; if asked, describe it, don't wait on it.
- Don't promise integrations on the call (MaintainX/Maximo/SAP) — say "documented v1 REST API, OpenAPI 3.1" and move on.
- Avoid empty/unseeded corners — stay on the named entities above; if a screen looks thin, navigate back to the dashboard.
- If anything is sluggish, narrate the story (you know the numbers cold) rather than waiting on a spinner.

---

## AFTER THE DEMO — send the buyer
1. Live demo link: **https://servicecycle.app** (creds above; spin up a read-only `viewer@` for them if needed)
2. `docs/ACQUISITION_BRIEF.md` — the written narrative
3. `docs/SECURITY_TRUST_PACK.md` + `docs/SOC2_CONTROLS.md` — for their security/diligence team
4. `docs/ARCHITECTURE.md` + `docs/ENGINEERING_HANDOFF.md` — for technical diligence
5. Offer NDA + source-code access for serious buyers.
