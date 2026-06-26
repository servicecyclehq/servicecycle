# ServiceCycle Arc-Flash — Integrated Roadmap

The existing slice plan, updated with the vetted "wow-factor" ideas folded in as **sub-slices**, plus net-new capabilities appended as **new slices**. Legend: ✅ shipped+deployed · 🔄 in progress · ⬜ planned · ⭐ high-impact/differentiating.

---

## Foundation — Schema Bootstrap (build it all from the standards; PE tunes values later)
> ✅ All bootstrap slices (1, B–H) SHIPPED + LIVE 2026-06-22 (commits e20580d / 96f08a6 / 7cc6739 / 75d9722).
- ✅ **Slice 1** — device taxonomy (`tripUnitType` + `fuseClass` enums; settings-required rule)
- ✅ **Slice B** — outcomes/label (arc rating, PPE method, shock boundaries, derived DANGER/WARNING) — ⚠️ follow-up (AI-validated): DANGER/WARNING is an ANSI Z535 convention, NOT an NFPA mandate; reframe the basis + revisit the >600 V trigger (make configurable). See ARC_FLASH_AI_VALIDATION.md.
- ✅ **Slice D** — enclosure type + dimensions (2018 size correction)
- ✅ **Slice F** — mitigation flags + dual-scenario + calc method
- ✅ **Slice C** — promote `electrodeConfig` String → enum (migration 20260622150000)
- ✅ **Slice E** ⭐ — source/system model (StudySourceModel: utility max/min/X-R, transformer, motors, generators, structured cable/conduit) (migration 20260622160000)
- ✅ **Slice G** — NETA as-found/as-left settings linkage / stale-study flag (DeviceTestRecord, migration 20260622170000)
- ✅ **Slice H** ⭐ — arc-flash equipment wired into the custom-fields system (`appliesTo`, migration 20260622180000)

## Slice 2.8 — The Drift Engine (readiness + change → re-study) ✅ COMPLETE 2026-06-22
- ✅ **2.8a** ⭐ — per-bus **confidence/trust score** (0–100%: input completeness, study age, field verification, drift) — `lib/arcFlashConfidence.ts`, on the per-asset tab (commit 9a6e542)
- ✅ **2.8b** ⭐ — **drift detection / change → re-study**: diff a new ingest revision vs the prior confirmed one; material change → re-study banner — `lib/arcFlashDrift.ts`, GET /ingest/:id/drift (commit ad88f8e)
- ✅ **2.8c** ⭐ — **contradiction engine / study sanity-checker**: auto-flag impossible/inconsistent data — `lib/arcFlashSanity.ts`, on ingest review + per-asset tab (commit 8841670)

## Slice 3 — Fleet, Reporting & Surfacing
- ⬜ **3a** — fleet arc-flash dashboard (cross-site DANGER %, hottest equipment, label readiness)
- ⬜ **3b** — printable arc-flash report (label schedule + study expiry + coverage)
- ⬜ **3c** — insurer/auditor package → extend to **audit bundle on demand** + **liability/$ executive reporting**
- ⬜ **3d** ⭐ — **plant heat-map** (2D floor-plan overlay first; 3D later) — the "exec instantly gets it" view
- ⬜ **3e** — **natural-language facility search** ("480V MCC buckets >8 cal with missing relay photos")
- ⬜ **3f** — per-asset **Arc Flash tab** on AssetDetail (label data + DANGER + IEEE 1584 inputs + study coverage + trend + print-label)

## Slice 3.5 — Close the Loop (PE round-trip + label lifecycle)
- ⬜ **3.5a** — SKM/EasyPower export of the collected model (CSV/JSON)
- ⬜ **3.5b** ⭐ — **two-way PE-tool round-trip**: import stamped study results back in (be the data layer the PE ecosystem syncs to)
- ⬜ **3.5c** ⭐ — label lifecycle → **live QR/NFC label → live record + label-mismatch detection** ("the label is a portal, not a sticker")
- ⬜ **3.5d** — **OEM / published-TCC device library**: photo a breaker → fetch its make/model TCC → clearing time computes with no manual lookup

## Slice 4 — Incident-Energy-Reduction Upsell
- ⬜ **4a** — DANGER bus → recommend trip-setting change / maintenance-mode switch → quote (reuse QuoteRequest + revenue attribution)
- ⬜ **4.5** ⭐ — **what-if mitigation sandbox + ROI**: fork the live model, simulate a setting/fuse/ERMS change, see the incident-energy/PPE delta and $/cal-reduced and $/DANGER-bus-removed ranking (the single best demo + capex tool)

---

## New Slices (net-new beyond original scope, appended)
- ⬜ **Slice 5** ⭐ — **Energized-work-permit / LOTO validator**: generate the NFPA 70E permit pre-filled with the bus IE/boundaries/PPE; block issuance if the study is expired/invalid (daily-use safety, sticky)
- ⬜ **Slice 6** — **Auto-build the one-line from field data** (forward direction — assemble the power-path diagram as buses are collected; we already do the reverse)
- ⬜ **Slice 7** — **AI safety copilot** ("can I safely rack this breaker?") answering from real study data + boundaries + procedures (after the data layer matures + guardrails)
- ⬜ **Slice 8** ⭐ — **CMMS/EAM closed loop** (Maximo/SAP): study change → work order; block a WO if the equipment's study is expired/unsafe; write verified settings back
- ⬜ **Slice 9** ⭐ — **Knowledge-graph / canonical asset graph + public-API expansion** ("Arc Flash OS" — the integration layer everyone syncs to; extends our v1 API)
- ⬜ **Slice 10** ⭐ — **Industry benchmark network + insurer risk-score integration** (anonymized data product; insurer as a new buyer persona) — the acquisition moat; needs scale, architect for it now
- ⬜ **Slice 11** — **Time-machine / timeline playback** of a bus's full history (studies, labels, settings) — we have the trend bones
- ⬜ **Slice 12** — **Regulatory-change matching** (an NFPA/IEEE *code* change, not a physical one, ages out affected labels)

## Could-Add Backlog (revisit later)
SCADA live-state synthesis · ghost-bus discovery (smart-meter vs model) · predictive breaker-wear decay (IoT) · contractor scorecard / trust ledger · PE-firm RFQ + replacement-parts marketplace · LiDAR cable-length · 3D room explorer / AR overlay · PPE-locker configurator · subscription/usage-based pricing (business-model decision).

## Explicitly Out of Scope (gimmick / standards-risk / liability)
Acoustic "zap" gap-sensing · thermal-derated boundaries (non-standard) · autonomous gear-scanning drones · Bluetooth e-paper as the *compliance* label (fails NFPA 70E 130.5(H) durability — supplement only) · access-control door interlocks / PPE-vending lockouts (liability minefield) · 3D plasma animation · disaster-$ simulator · tenant billing · NERC-CIP export · "protected bus-hours" billing.

---
*Source: 5-AI brainstorm (5.28.issues.txt) + internal review, vetted against ARC_FLASH_DOMAIN_MODEL.md and current build state. Most top ideas validated the existing roadmap; net-new high-value adds = contradiction engine, confidence score, heat-map, NL search, knowledge-graph/API, benchmark+insurer moat.*
