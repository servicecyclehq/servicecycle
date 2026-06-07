# ServiceCycle â€” New Session Kickoff

## Who you are working with
Dustin â€” founder of ForgeRift LLC, 14-year renewal management expert, building ServiceCycle as a
separate product from LapseIQ. Dustin knows the business problem deeply but is not an electrical
engineering expert â€” build as close to correct as the research allows, document assumptions clearly.

---

## CRITICAL â€” Non-Negotiable Security Rule
A specific large electrical equipment OEM is the target acquirer/customer for this product. That
company's name **must never appear** in any code, commit message, comment, documentation, README,
or any artifact â€” ever. Reference only as "EM" or "Equipment Maintenance" or "target OEM."
This is a permanent, unconditional rule. Do not record the name anywhere.

---

## What is ServiceCycle

ServiceCycle is an **electrical equipment maintenance compliance platform** â€” a self-hosted SaaS
product targeting electrical service contractors and large facilities managers. It tracks
equipment maintenance schedules, enforces NFPA 70B condition-based intervals, generates compliance
reports, and alerts the right people at the right time before maintenance windows are missed.

**The forcing function:** NFPA 70B shifted from "recommended practice" to **mandatory standard**
in 2023. ~84% of facilities are not yet compliant as of 2024. Insurance carriers and OSHA are
driving adoption hard. The spreadsheet + PDF era is ending.

**The gap:** No CMMS (Maximo, SAP PM, Limble, MaintainX) has a NFPA 70B condition rating engine
or NETA interval templates. Competitors Gimba and Egalvanic are early-stage, no CMMS integration,
no regulatory intelligence feed, no AI. Every major OEM hands customers a PDF after a service
visit and walks away.

**Strategic value:** This is not just compliance software. For an OEM with a field services org,
it is a customer retention engine (customers stay on service contracts), a services revenue
flywheel (the software surfaces upcoming work to the sales org), and a new customer acquisition
tool. That is the $50-150M valuation story.

**Deployment:** On-prem / self-hosted Docker, same model as LapseIQ. No phone-home SaaS due to
customer data sensitivity (industrial facility layouts, equipment inventories).

---

## Codebase

**Local repo:** `C:\Users\ddeni\Desktop\ServiceCycle`
**GitHub:** `https://github.com/servicecyclehq/servicecycle` (private)
**GitHub account:** servicecyclehq@gmail.com â€” NO connection to ForgeRift or claudedussy

**Stack:** React 18 + Vite (client) Â· Express 5 + Prisma + TypeScript (server) Â· PostgreSQL 16
Â· Docker Compose Â· Caddy reverse proxy

**Origin:** Clean copy of LapseIQ v0.92 with no git history. All lapseiq/forgerift strings
replaced in package.json, docker-compose files. The Prisma schema and most UI files still use
LapseIQ terminology internally â€” that gets replaced as we build out ServiceCycle's own model.

**Git identity for all commits:**
```
git config user.email "servicecyclehq@gmail.com"
git config user.name "ServiceCycle"
```

**Key inherited patterns to preserve:**
- Auth / MFA / RBAC / JWT (HS256 pinned, DB-side revocation)
- Alert engine (server/lib/alertEngine.ts) â€” adapt lead times, do not rewrite
- Audit log with chain verification
- Demo mode guard (server/middleware/demoGuard.ts)
- AI quota guard + consent gate
- Webhook SSRF protection â€” fully hardened, do not touch
- Tenancy / IDOR scoping â€” every Prisma query must include accountId

**LapseIQ concepts â†’ ServiceCycle equivalents:**

| LapseIQ | ServiceCycle |
|---------|-------------|
| Contract | Asset (piece of equipment) |
| Renewal date | Next maintenance due date |
| Vendor | NETA-certified testing contractor |
| Consultant invite | Maintenance Vendor account manager (gets alerts in tandem) |
| Contract categories | Equipment types |
| Renewal brief (AI) | Maintenance recommendation + NFPA compliance summary |
| 30/60/90 day alerts | 7/30/60/90/120/180 day alerts (longer lead for engineer scheduling) |

---

## Governing Standards (seed into DB at setup)

| Standard | Publisher | Cycle | Key Mandate |
|----------|-----------|-------|-------------|
| NFPA 70B:2023 | NFPA | ~3-5yr | Mandatory EMP, condition-based intervals, IR thermography annual |
| NFPA 70E:2024 | NFPA | 3yr | Arc flash study 5yr max, PPE requirements, LOTO |
| NFPA 110:2022 | NFPA | 3yr | Generator monthly exercise, annual load bank, 3yr full test |
| NETA MTS-2023 | NETA | ~4yr | Per-equipment test intervals (Appendix B matrix) |
| NETA ATS-2025 | NETA | ~4yr | Acceptance testing on new installations |
| IEEE C57.104-2019 | IEEE | Irregular | DGA interpretation for liquid-filled transformers |
| IEEE 43-2013 | IEEE | Irregular | Insulation resistance for motors/generators |
| OSHA 1910 Subpart S | OSHA | Ongoing | Fines $16,550/violation (serious), $165,514 (willful) |

No public APIs for NFPA/NETA content â€” encode as data in DB. Use eCFR API (ecfr.gov/api) for
OSHA monitoring. Track NFPA revision cycles via email list + manual update workflow.

---

## Data Model (Prisma schema target)

### Asset Hierarchy
sites â†’ buildings â†’ areas â†’ equipment_positions â†’ assets

**Asset fields:**
- equipment_type (enum: TRANSFORMER_LIQUID, TRANSFORMER_DRY, SWITCHGEAR, GENERATOR,
  MOTOR, MCC, UPS_BATTERY, CIRCUIT_BREAKER, ARC_FLASH_PANEL, VFD, FIRE_PUMP_CONTROLLER)
- manufacturer, model, serial_number, nameplate_data (JSONB â€” varies by type)
- install_date, last_commissioned_date
- condition_physical (C1/C2/C3), condition_criticality (C1/C2/C3), condition_environment (C1/C2/C3)
- governing_condition (computed = max of three â€” C3 wins)
- in_service (boolean), is_energized (boolean)

### Compliance Tables
compliance_standards â†’ maintenance_task_definitions â†’ maintenance_schedules

**maintenance_task_definitions:**
- equipment_type, task_name, task_code
- interval_c1_months, interval_c2_months, interval_c3_months
- requires_outage, requires_energized, requires_neta_certified (all boolean)
- neta_cert_level_min (I/II/III/IV)
- standard_ref (e.g. "NFPA 70B:2023 s9.7.3")

**maintenance_schedules:**
- asset_id, task_definition_id
- last_completed_date, next_due_date (computed)
- lead_time_scheduling_days (default 180)
- lead_time_customer_days (default 90)
- condition_override (nullable)

### Execution
work_orders â†’ test_measurements â†’ deficiencies

**work_orders:**
- schedule_id, contractor_id, assigned_tech_id
- neta_cert_level (I/II/III/IV)
- status (SCHEDULED/IN_PROGRESS/COMPLETE/CANCELLED)
- as_found_condition, as_left_condition
- neta_decal (GREEN/YELLOW/RED)
- report_pdf_url

**test_measurements:**
- work_order_id, measurement_type, phase
- as_found_value, as_found_unit
- as_left_value, as_left_unit (NETA MTS 5.4 â€” both required)
- pass_fail (GREEN/YELLOW/RED)

**deficiencies:**
- work_order_id, asset_id
- severity (IMMEDIATE/RECOMMENDED/ADVISORY)
- description, corrective_action, resolved_at

### Special Tables
- arc_flash_studies â€” site-level; 5yr expiry; triggered by system changes
- lab_samples â€” DGA/oil/fuel; columns: H2, CH4, C2H2, C2H4, C2H6, CO, CO2 (IEEE C57.104)
- blackout_windows â€” customer downtime windows; scheduler avoids overlap
- standard_revision_alerts â€” when NFPA/NETA publishes new edition, flags affected schedules

---

## Equipment Types + Maintenance Tasks (seed data)

**Switchgear:** IR thermography (annual), insulation resistance (annual), contact resistance
(1-3yr), circuit breaker trip (3-5yr), protective relay calibration (3-5yr), arc flash study (5yr)

**Transformers (liquid):** DGA oil sampling (annual), oil quality (annual), TTR test (3yr),
insulation resistance (annual), SFRA (3-5yr per NETA MTS-2023), partial discharge (annual >600V)

**Generators:** Monthly exercise (NFPA 110 â€” 30% nameplate kW, 30 min), load bank test (annual
if monthly load fails), full system test (3yr), fuel analysis (annual)

**UPS/Batteries:** Battery visual (monthly), impedance testing (quarterly), capacity/discharge
test (2yr or when impedance flags), functional test (semi-annual)

**MCCs/Distribution Panels:** IR thermography (annual), insulation resistance (annual), breaker
trip (3-5yr), torque verification (3yr), contactor inspection (3yr)

**Motors:** Megger/PI (annual), vibration analysis (quarterly for critical), thermography
(annual), bearing lubrication (per hours), winding resistance (3yr)

**NFPA 70B Condition Multipliers (NETA Appendix B):**
- C1: up to 60 months (multiplier 2.5x)
- C2: base interval (multiplier 1.0x)
- C3: 12 months max (multiplier 0.25x)

next_due_date = last_completed_date + (base_interval_months x condition_multiplier)

---

## Alert Engine (adapt from server/lib/alertEngine.ts)

| Lead Time | Alert Type | Recipient |
|-----------|-----------|-----------|
| 180 days | Engineer booking window opens | Maintenance Vendor account manager |
| 120 days | Contractor confirmation needed | Maintenance Vendor account manager |
| 90 days | Customer planning notice | Maintenance supervisor + plant manager |
| 60 days | Outage coordination | Maintenance supervisor |
| 30 days | Final prep | All parties |
| 7 days | Imminent reminder | Tech lead + customer contact |
| Overdue | Overdue flag | Supervisor |
| +7d overdue | Escalation tier 1 | Plant manager |
| +30d overdue | Escalation tier 2 | Executive / compliance officer |
| +90d overdue | Regulatory breach risk | All parties + audit log |

---

## Buyer Profile

1. Electrical service contractors â€” manage 50+ client facilities; $150-400/mo. Best beachhead.
2. Facility managers at large industrial/commercial sites â€” $200-800/mo per site.
3. OEM Maintenance Vendors â€” channel partner / white-label deal.
4. Insurance underwriters â€” influencers, not buyers.

**Buying triggers:** Insurance renewal requiring docs, OSHA citation, arc flash incident, new
facility manager inheriting undocumented equipment, switchgear >20yr old never formally documented.

---

## PoC Build Priority

**Tier 1 (build first):** Transformers Â· Generators Â· Switchgear
**Tier 2:** UPS systems Â· Circuit breakers Â· MCCs
**Tier 3:** Arc flash study tracking (flag only) Â· VFDs Â· Fire pump controllers
**Skip for PoC:** PCB transformers Â· LOTO procedures Â· state law matrix Â· training records

---

## CMMS Integrations Roadmap

- Day 1: CSV/Excel import + PDF report output
- Phase 2: Limble REST, UpKeep REST, MaintainX REST
- Phase 3: SAP PM, Fiix, IoT/SCADA (OPC-UA, MQTT)
- Phase 4: OEM proprietary monitoring (SNMP/Modbus TCP/MQTT) + insurance carrier API

---

## First Session Goals

1. **Prisma schema** â€” Add equipment hierarchy, condition assessment, maintenance schedules,
   work orders, test measurements, deficiencies, arc flash studies, lab samples. Keep User,
   Account, AuditLog, AlertPreference, ApiKey, Webhook tables unchanged. Remove/rename
   contract-specific tables. Create and run migration.

2. **Navigation / Sidebar** â€” Replace contract-centric nav with: Assets, Sites, Work Orders,
   Compliance Calendar, Reports, Settings.

3. **Dashboard** â€” Replace renewal countdown widgets with: assets due in 30/60/90 days,
   overdue count by severity, compliance rate by site, recent work orders.

4. **Seed data** â€” Pre-seed compliance_standards and maintenance_task_definitions for Tier 1
   equipment (Transformers, Generators, Switchgear) with correct NFPA 70B / NETA intervals.

5. **Environment check** â€” Confirm npm ci runs clean in client/ and server/ directories.

---

## Shell / File Write Rules (important)

- Use Local Terminal MCP (Windows PowerShell) for all shell operations
- Never ask Dustin to run commands himself
- Write tool truncates large files â€” always use PowerShell WriteAllText for file writes:
  [System.IO.File]::WriteAllText($path, $content, [System.Text.Encoding]::UTF8)
- Git working directory: C:\Users\ddeni\Desktop\ServiceCycle
- Push after meaningful milestones: git add . && git commit -m "feat: ..." && git push origin main
- Remote is already configured. For auth, ask Dustin for the PAT (servicecyclehq@gmail.com account)