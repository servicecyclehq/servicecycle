# ServiceCycle — Demo Land Mines & Acquisition Due Diligence Scan
_Generated 2026-06-25 | 8 parallel agents: Security/CISO, Database, Integration/API, DevOps, UX/Product, Domain Expert, Field Ops, Playwright crawl_
_CTO/QA agent hit API overload — re-run separately_

---

## 🚨 FIX TONIGHT (before any demo)

These are either live server crashes or demo data that an Eaton engineer will catch in the first 5 minutes.

### 1. Backup cron fails 100% — all data unprotected
**File:** VPS `/root/ServiceCycle/backups` owned by root — Node (UID 1000) can't write  
**Impact:** Every nightly backup at 2:00am throws `EACCES: permission denied`. No backup has ever completed. `EMAIL_MOCK=true` so no alert fires.  
**Fix (one command on VPS):** `chown -R 1000:1000 /root/ServiceCycle/backups`

### 2. ServiceOpportunityTrigger cron crashes nightly
**File:** `server/index.ts` ~line 2205  
**Error:** `asset: { select: { name: true } }` — `Asset` has no `name` field in the schema  
**Impact:** The auto-QuoteRequest creation cron (runs nightly at 2:30am) has never successfully run  
**Fix:** Change to `{ select: { equipmentType: true, manufacturer: true, model: true } }` or remove the select and use `assetId` as fallback (already present at lines 2287/2295)

### 3. WeatherScanner throws every 15 minutes
**File:** `server/lib/weatherScanner.ts` line 160  
**Error:** `sendAlertEmail is not a function` — `email.ts` does not export this function  
**Impact:** Weather alert emails never fire; error logs every 15 minutes  
**Fix:** Replace `sendAlertEmail` call with `sendEmail`, or export `sendAlertEmail` from `lib/email.ts`

### 4. Demo data: PPE Cat 4 on buses that should be Cat 3
**File:** `server/scripts/seed-demo.js` lines ~1417, 1424  
**Error:** `incidentEnergyCalCm2: 14.2` and `19.6` are both seeded as `ppeCategory: 4`. Per NFPA 70E, 8–25 cal/cm² = Cat 3. Cat 4 starts at 25 cal/cm².  
**Impact:** The headline arc flash demo bus carries a wrong PPE category. An Eaton arc flash PE will catch this in under 60 seconds. The platform's own sanity engine doesn't catch over-categorization, so it passes silently.  
**Fix:** Change `ppeCategory: 4` to `ppeCategory: 3` for both buses. Reseed.

### 5. PPE category mapping missing the <1.2 cal/cm² floor
**File:** `server/lib/arcFlashMitigation.ts` lines 106-110  
**Error:** `PPE_BANDS = [[4,1],[8,2],[25,3],[40,4]]` — any IE from 0 to 4 cal/cm² returns Cat 1. Below 1.2 cal/cm² no arc-flash PPE category applies per NFPA 70E.  
**Fix:** Add: `if (ie < 1.2) return null; // Below AFB threshold — no PPE category required`

---

## ⚠️ HIGH PRIORITY — Fix before Eaton sees the product

### 6. Raw JSON input for NETA test settings — biggest "prototype" signal in the app
**File:** `client/src/components/` `ArcFlashAssetTab.jsx` ~line 808-809  
**What they see:** Form fields labeled "As-found settings (JSON)" with placeholder `{"ltPickupA":400}`  
**Impact:** A PE or product manager scrolling the arc flash tab will land on this and immediately conclude the form is a development scaffold. This is the single most visible signal that says "prototype, not product."  
**Fix:** Replace raw JSON textarea with structured key-value inputs for common trip settings (Long-time pickup, Short-time pickup, Instantaneous), with an "Advanced" toggle for raw JSON if needed.

### 7. Sidebar shows raw role string
**File:** `client/src/components/Sidebar.jsx` line ~1063  
**What they see:** `{user?.role}` renders as `admin`, `oem_admin`, `super_admin` in the bottom-left corner during the demo  
**Fix:** Map to display names: `{ admin: 'Administrator', manager: 'Manager', oem_admin: 'OEM Admin', field_tech: 'Field Technician', viewer: 'Viewer', group_admin: 'Group Admin', super_admin: 'Super Admin' }`

### 8. "Planned" report cards visible in Reports Hub
**File:** `client/src/tables/reportsRegistry.js` + `StubReport.jsx`  
**What they see:** Two grayed-out cards labeled "Planned" — **Maintenance Activity Summary** and **Trend Analysis**. Both are directly relevant to an Eaton evaluation.  
**Fix:** Remove the cards from the hub until they ship. Or replace "Planned" with "Beta — contact us" and gate behind a feature flag.

### 9. Arc flash report pages missing page-header wrapper
**Files:** `ArcFlashReport.jsx`, `ArcFlashFleet.jsx`, `ArcFlashHeatMap.jsx`, `ArcFlashSearch.jsx`  
**What they see:** These four pages start with `<div className="page-body">` directly — no `page-header`, no sticky title bar. Every other page in the app has one. In a demo clicking between Dashboard, Assets, and Arc Flash reports — this visual inconsistency reads as "different developer built these."  
**Fix:** Wrap each with the standard `<div className="page-header"><h1>...</h1><p className="subtitle">...</p></div>` pattern.

### 10. Nav defaults to all groups collapsed in fresh session
**File:** `client/src/components/Sidebar.jsx` lines 524-542  
**What they see:** Demo opens to a sidebar showing only "Dashboard" and a row of closed group labels. Looks empty.  
**Fix:** Default "Equipment" and "Work" groups open on first authenticated session.

### 11. "Dustin reads every one" in production UI
**File:** `client/src/components/Sidebar.jsx` ~line 365  
**What they see:** Feedback menu item subtitle reads `'Bugs, ideas, anything — Dustin reads every one'`  
**Fix:** Replace with `'Bugs, ideas, anything — we read every one'`

### 12. NFPA 70E subsection citation inconsistency
**Files:** `server/lib/arcFlashIntegrity.ts`, `arcFlashConfidence.ts`, `help/arc-flash.txt`  
**Issue:** These cite bare **§130.5** while seed-standards.js and other files correctly cite **§130.5(G)** (review interval) and **§130.5(H)** (labeling).  
**Impact:** The emails that tell customers "re-study required" cite the wrong subsection. An Eaton PE will catch this.  
**Fix:** Audit all §130.5 bare references and update to §130.5(G) or §130.5(H) as appropriate.

### 13. No explicit de-energize instruction on >40 cal/cm² labels
**File:** `server/lib/arcFlashLabelDoc.ts` lines 100-120  
**Issue:** DANGER signal word is correctly set at IE>40, but the label body never renders "De-energize — energized work not permitted." Field crews expect this callout on >40 labels.  
**Fix:** When `signalWord === 'DANGER'`, add a bold line: "DE-ENERGIZE BEFORE WORKING — Energized work not permitted without documented justification."

---

## 🔒 CRITICAL BEFORE REPO HANDOFF (due diligence will find these)

### 14. Live API keys in server/.env
**File:** `server/.env` lines 10-13  
**Keys present:** Live Groq API key (`gsk_gl74H1fklBJwF8kqgaK9W...`), live Gemini API key  
**The file is gitignored** (not committed), but: (a) rotate both keys now, (b) run a full git history scan with `trufflehog` before handing the repo to Eaton — a prior commit `965b7cf` accidentally committed a Cloudflare Origin Certificate keypair and was subsequently rotated. Any security team will run `git log -S <key>` across the full history.  
**Also rotate:** MASTER_KEY (encrypts all stored credentials)

### 15. Stale seed-demo.js in prisma/ directory
**File:** `server/prisma/seed-demo.js`  
**Issue:** Seeds SaaS contract-renewal vendors (Microsoft, Salesforce, CrowdStrike, Okta) — leftover from the codebase's prior incarnation. Has zero relation to electrical equipment.  
**Fix:** Delete `server/prisma/seed-demo.js`. The real demo seed is `scripts/seed-demo.js`.

### 16. "PENDING BROTHER VALIDATION" comment in seed data
**File:** `server/scripts/seed-demo.js` ~line 436  
**Issue:** Comment references `jrivera@example-electrical.com` with annotation `PENDING BROTHER VALIDATION` — directly references the unnamed first customer  
**Fix:** Remove comment. Anonymize the email address.

### 17. `liq_` API key prefix — legacy from prior product
**File:** `server/routes/apiKeys.ts` line 70  
**Issue:** All API keys are prefixed `liq_` (likely from "LapseIQ"). This appears in the OpenAPI spec and any integration docs. An Eaton integration team will see this in every API key they generate.  
**Fix:** Change prefix to `sc_` at next key issuance. Existing keys can migrate on rotation.

### 18. Arc flash ingest not wrapped in transactions
**File:** `server/routes/arcFlashIngest.ts` lines 256-302 (POST `/ingest`), 527-630 (`/ingest/:id/confirm`)  
**Issue:** Multi-step writes (create-ingest → N×bus.create → update-ingest) run without `prisma.$transaction`. A crash mid-loop orphans bus rows and leaves the ingest stuck in `extracting`.  
**Impact:** The HERO demo feature could leave visibly inconsistent state if anything goes wrong mid-import during the demo.  
**Fix:** Wrap both handlers in `prisma.$transaction(async (tx) => { ... })`.

### 19. No CI/CD pipeline
**Finding:** No `.github/` directory, no GitHub Actions, no automated test gate before deployment  
**Impact:** Eaton's engineering team will ask "how do you verify nothing broke before deploying?" The answer is currently "manually."  
**Fix:** Minimum viable CI: GitHub Actions workflow → `npm test` → build → deploy. Even a passing test gate covers it.

---

## 📊 ACQUISITION DUE DILIGENCE SUMMARY BY TEAM

| Team | Verdict | Top Concern |
|---|---|---|
| **Security/CISO** | ✅ CLEAN | Rotate API keys in .env before repo handoff |
| **Database** | ✅ SOLID | Arc flash ingest not transactional; stale seed-demo.js |
| **Integration/API** | ⚠️ GAPS | v1 arc-flash envelope inconsistency; no AFX→SC study push endpoint; `liq_` prefix |
| **DevOps/Infrastructure** | ⚠️ GAPS | No CI/CD; no KMS; minimal observability; single node |
| **UX/Product** | ⚠️ NEEDS WORK | JSON test input fields; Planned report cards; collapsed sidebar |
| **Domain Expert (NETA/Arc Flash)** | ⚠️ FIXABLE | PPE Cat 3 vs 4 mislabel; <1.2 cal/cm² floor; 70E citation inconsistency |
| **Field Ops** | ✅ ADEQUATE | No PE review gate in WO lifecycle (defensible design choice) |
| **Live Server (Playwright)** | 🚨 BROKEN | Backups failing (EACCES); 2 crons crashing nightly |
| **CTO/QA** | ⚪ NOT RUN | Agent hit API overload — re-run |

---

## WHAT'S GENUINELY STRONG (for the acquisition narrative)

- **Security posture is enterprise-grade.** Multi-tenant isolation, layered rate limiting, JWT revocation, CORS strict, no injection vectors, SOC 2-ready controls. The CISO agent found no critical issues in 14 investigation areas.
- **Schema is clean and additive.** 39 migrations, zero destructive changes, proper indexes on all accountId columns, thoughtful cascade discipline.
- **Demo data is realistic.** Real nameplate data (2500 kVA, 13.8 kV delta → 480Y/277V, SEL-751 relay with real pickup settings), proper equipment hierarchy, IEEE C57.104 DGA codes. An Eaton engineer will recognize this as genuine domain knowledge, not placeholder content.
- **Cloud portability is high.** Already containerized, S3-compatible storage/backup wired, stateless API. Estimated 2-3 weeks to migrate to Azure/AWS — Eaton's team can take ownership cleanly.
- **Electrode configurations are exactly right.** VCB/VCBB/HCB/VOA/HOA per IEEE 1584-2018, units consistent throughout.

---

## RECOMMENDED FIX ORDER (prioritized by demo risk)

**Do tonight / tomorrow before any meeting:**
1. `chown -R 1000:1000 /root/ServiceCycle/backups` (one VPS command)
2. Fix `Asset.name` → `equipmentType+manufacturer+model` in serviceOpportunityTrigger cron
3. Fix `sendAlertEmail` in weatherScanner.ts
4. Fix PPE Cat 4 → Cat 3 on demo seed buses + reseed
5. Add <1.2 cal/cm² floor to PPE mapping

**Before any Eaton meeting:**
6. Fix raw JSON NETA test input fields → structured UI
7. Fix sidebar role display string → human-readable
8. Remove "Planned" report cards
9. Add page-header to arc flash report pages
10. Fix "Dustin reads every one" copy
11. Default Equipment + Work nav groups open

**Before repo handoff to Eaton:**
12. Rotate Groq/Gemini keys + MASTER_KEY; run trufflehog on git history
13. Delete `server/prisma/seed-demo.js`
14. Remove "PENDING BROTHER VALIDATION" comment
15. Change `liq_` API key prefix to `sc_`
16. Wrap arc flash ingest in transactions
17. Fix NFPA 70E §130.5 citation to §130.5(G)/(H) as appropriate
18. Add de-energize instruction to >40 cal/cm² labels
19. Wire minimum CI/CD pipeline
