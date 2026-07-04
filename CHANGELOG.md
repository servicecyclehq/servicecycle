# Changelog

All notable, customer-visible or security-relevant changes to ServiceCycle are recorded here.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/) with SOC 2 evidence in mind: each entry names what changed, why, and links to the commit range where possible. Git history is still authoritative; this file is the human-readable summary an auditor or acquirer can skim.

Version numbers follow the `server/package.json` version. Release tags on GitHub match.

---

## [Unreleased]

### Added
- `docs/SOC2_READINESS_CHECKLIST.md` — synthesized 95-item SOC 2 checklist scored against current state (2026-07-04).
- `docs/compliance/evidence/` folder with dated-evidence convention.
- SOC 2 governance docs under `docs/security/` (endpoint security, secrets inventory, environment inventory, threat model, decision log, asset inventory, data flow, monitoring matrix, permissions matrix, session management, data classification, privacy requests, per-scenario BC playbooks) and under `docs/compliance/` (risk acceptance log, data retention matrix, vendor review log).
- First tabletop drill evidence in `docs/compliance/evidence/2026-07/`.

---

## [0.1.2] — Live at time of checklist compile (2026-07-04)

Prior history is authoritative in git. Notable recent milestones (from memory index):

- **2026-07-04** — Nameplate OCR validator calibration; morning parser wins (clean parser recall 91→97%).
- **2026-07-03** — Ingestion hardening + Debian container switch + free ingest accuracy wins; PDF review P0 fixes; tier-0 hardening; acquisition scan fixes; import lattice + Installed-Base Intelligence.
- **2026-06-28** — Domain accuracy audit shipped; Phase 3 + provenance system.
- **2026-06-26** — v8 + v9 scan cycles complete.
- **2026-06-25** — SOC2 sweep + diligence docs.

---

## How to log an entry

At the end of any session that touches production, prepend a bullet under `[Unreleased]` describing:
- What changed (feature / policy / doc / bug fix).
- Why (customer ask, audit gap, incident, refactor).
- Commit SHA if landed.

When a release tag is cut, move `[Unreleased]` to `[X.Y.Z] — YYYY-MM-DD` and start a fresh Unreleased section.
