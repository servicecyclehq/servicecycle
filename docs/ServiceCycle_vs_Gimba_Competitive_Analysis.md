# ServiceCycle vs. Gimba — Competitive Feature Analysis
Date: 2026-06-08

**Competitor:** Gimba (gimba.io)
Purpose-built NFPA 70B electrical maintenance compliance platform. Primary markets: data centers, hospitals, manufacturers, municipalities, universities, and electrical contractors (white-label). Their pitch: "the only software built specifically around NFPA 70B."

**Legend:**
- ✅ Built & shipped in ServiceCycle
- ❌ Not in ServiceCycle
- 🗺️ On the roadmap
- ➕ Should add — not currently planned, surfaces a gap

---

## Part 1 — Gimba Feature Checklist vs. ServiceCycle

### Core Asset Management

| Feature | Gimba | ServiceCycle | Notes |
|---|---|---|---|
| Electrical asset inventory (switchgear, transformers, breakers, MCCs, panelboards, UPS, generators, etc.) | ✅ | ✅ | ServiceCycle supports all equipment types with custom fields |
| Asset condition rating | ✅ | ✅ | ServiceCycle tracks condition on asset and via deficiencies |
| Asset nameplate photo capture → AI auto-populate record | ✅ | ✅ | Both use AI. ServiceCycle also logs condition observations (Normal/Monitor/Concern) |
| Maintenance history per asset | ✅ | ✅ | Full history in ServiceCycle via work orders, schedules, and activity log |
| Multi-site / multi-facility dashboard | ✅ | ✅ | ServiceCycle is full multi-tenant SaaS, site filter on every list view |
| QR code scanning → jump to asset record | ❌ Not mentioned | ✅ | ServiceCycle has full-screen QR camera scanner with torch + manual fallback |
| Power path / electrical hierarchy (upstream/downstream) | ❌ | ✅ | ServiceCycle has full power path graph — unique feature |
| Custom fields per asset type | ❌ Not documented | ✅ | ServiceCycle supports custom fields per account |
| SKM / ETAP / one-line diagram import | ✅ | ❌ ➕ | Big gap — these are standard tools electrical engineers use |
| CSV / spreadsheet import | Implied | ✅ | ServiceCycle has full CSV asset import |

---

### Maintenance Scheduling & Work Orders

| Feature | Gimba | ServiceCycle | Notes |
|---|---|---|---|
| Preventive maintenance scheduling | ✅ | ✅ | |
| Risk-based scheduling (auto-adjusts intervals when condition changes) | ✅ NFPA 70B-driven | ❌ ➕ | Gimba auto-recalculates based on condition rating. ServiceCycle is calendar-based. Worth adding. |
| Work order management | Basic | ✅ Full | ServiceCycle: status, priority, assignment, scheduling, labor, full lifecycle |
| Work order approvals / manager gate | ❌ | ✅ | ServiceCycle has requireManager on WO writes |
| Outage scheduling / downtime coordination | ❌ | ✅ | ServiceCycle has Outage Consolidation Planner — batch maintenance during planned downtime |
| Calendar / schedule view | ✅ | ✅ | |
| Overdue and upcoming task dashboard | ✅ | ✅ | ServiceCycle: Field Mode "My Day" + main dashboard |

---

### Field & Mobile

| Feature | Gimba | ServiceCycle | Notes |
|---|---|---|---|
| Mobile-optimized field app | ✅ | ✅ | |
| Offline data entry | ✅ | ✅ | ServiceCycle has full offline queue (fieldMutate/flushOutbox) with auto-sync |
| QR code scan → asset | ❌ | ✅ | |
| Photo capture with AI analysis | ✅ nameplate only | ✅ | ServiceCycle: nameplate + condition observations (Normal/Monitor/Concern) |
| Task completion in the field | ✅ | ✅ | |
| Deficiency report from the field (offline-capable) | ✅ | ✅ | |
| Torch / flashlight toggle on camera | ❌ | ✅ | Small but real: working in dim electrical rooms |
| Haptic feedback on successful QR scan | ❌ | ✅ | |

---

### LOTO & Safety

| Feature | Gimba | ServiceCycle | Notes |
|---|---|---|---|
| LOTO / Lockout-Tagout procedures (OSHA-compliant) | ❌ Not present | ✅ | ServiceCycle has full LOTO: energy sources, isolation steps, versioning, draft→active workflow |
| NFPA 70E compliance (electrical safety in the workplace) | ❌ Not present | ✅ | |
| Electronic permit-to-work / energy control | ❌ | ✅ via LOTO | |

---

### Compliance & Audits

| Feature | Gimba | ServiceCycle | Notes |
|---|---|---|---|
| NFPA 70B compliance & EMP generation | ✅ Core product | ✅ | ServiceCycle tracks NFPA 70B as one of many supported standards |
| NFPA 70E compliance module | ❌ | ✅ | |
| NFPA 99 compliance module (healthcare) | ❌ | ✅ | |
| Custom compliance standards | ❌ | ✅ | ServiceCycle: custom standards library, per-facility programs |
| One-click EMP / compliance report generation | ✅ | ✅ | |
| Audit visit management (schedule, perform, snapshot) | ❌ | ✅ | ServiceCycle has full audit visit lifecycle with snapshots and recommendations |
| Compliance calendar | ❌ | ✅ | |
| Tamper-evident activity log / audit chain | ❌ | ✅ | ServiceCycle has cryptographically chained activity log |

---

### Deficiency Management

| Feature | Gimba | ServiceCycle | Notes |
|---|---|---|---|
| Deficiency logging and tracking | ✅ | ✅ | |
| Severity classification | ❌ Not detailed | ✅ | ServiceCycle: Critical / Major / Minor / Informational |
| Deficiency status lifecycle | ❌ | ✅ | ServiceCycle: Open → In Progress → Resolved → Closed |
| Link deficiency to work order | ❌ | ✅ | |
| Deficiency closeout documentation | ✅ | ✅ | |

---

### Document Management

| Feature | Gimba | ServiceCycle | Notes |
|---|---|---|---|
| Document storage per asset | Limited | ✅ | ServiceCycle: OEM manuals, procedures, drawings, field photos |
| External URL linking (OEM online portals) | ❌ | ✅ | ServiceCycle supports external URL docs alongside uploaded files |
| Document type classification (manual, drawing, procedure, etc.) | ❌ | ✅ | |
| LOTO procedure as versioned document | ❌ | ✅ | |

---

### Quoting & Service

| Feature | Gimba | ServiceCycle | Notes |
|---|---|---|---|
| Quote / service request workflow | ❌ | ✅ | ServiceCycle: 5-question structured intake, EMERGENCY mode, per-account service rep |
| Emergency "equipment down now" escalation | ❌ | ✅ | EMERGENCY mode: red banner, direct call link, [EMERGENCY] email flag |
| Per-account assigned service representative | ❌ | ✅ | |
| Quote request status lifecycle | ❌ | ✅ | |

---

### Notifications, Integrations & API

| Feature | Gimba | ServiceCycle | Notes |
|---|---|---|---|
| Email alerts and notifications | ❌ Not documented | ✅ | |
| Slack integration | ❌ | ✅ | |
| Microsoft Teams integration | ❌ | ✅ | |
| REST API with API keys | ❌ | ✅ | ServiceCycle has public v1 API |
| Webhook integrations | ❌ | ✅ | |
| News & grid outage monitoring | ❌ | ✅ | ServiceCycle monitors EIDL/breaking news relevant to customer facilities |
| ERP integration | Roadmap claim | 🗺️ | Neither has this today |
| IoT / sensor integration | ❌ | 🗺️ | ServiceCycle roadmap |

---

### Contractor & Multi-Account

| Feature | Gimba | ServiceCycle | Notes |
|---|---|---|---|
| Contractor management | ✅ | ✅ | |
| White-label portal (contractor's brand, client never sees vendor) | ✅ Core feature | ❌ ➕ | Big Gimba differentiator. Contractors white-label and resell to clients. Worth evaluating. |
| Consultant role (read-only with attribution) | ❌ | ✅ | |
| Multi-tenant SaaS (full account isolation) | ✅ | ✅ | ServiceCycle: hardened IDOR protection, per-account data isolation |

---

### Pricing & Go-to-Market

| Feature | Gimba | ServiceCycle | Notes |
|---|---|---|---|
| Flat-rate per-facility (no per-user fees) | ✅ | ❌ ➕ | Gimba charges per facility, not per seat. Attractive for large teams. Consider as an option. |
| Turnkey onboarding (vendor ingests your data) | ✅ | ❌ ➕ | Gimba does the data entry for you. Reduces friction at sale close. |
| Same-day onboarding claim | ✅ | ❌ | Depends on data volume |
| Self-serve demo environment | ✅ | ✅ | ServiceCycle has full demo seed |

---

## Part 2 — ServiceCycle Differentiators (What You Have That Gimba Doesn't)

These are your real competitive advantages. Lead with these in sales conversations with Gimba prospects:

**1. LOTO / Lockout-Tagout Procedures**
Full OSHA-compliant LOTO with energy source documentation, step-by-step isolation procedures, versioning, and draft→active workflow. Gimba has zero LOTO capability. For any customer with OSHA obligations (manufacturing, utilities, data centers with live maintenance), this alone wins the deal.

**2. QR Code Scanning**
Full-screen camera scanner, torch toggle, offline fallback to manual search. Gimba doesn't have it. In a real electrical room with 20 panels, not having to search for an asset by name is a meaningful time-saver for field techs.

**3. Outage Consolidation Planner**
Coordinate scheduled downtime and batch maintenance tasks across multiple assets in a single outage window. Gimba has no equivalent. For any customer managing planned shutdowns, this is a direct business value feature.

**4. Quote Request Workflow + EMERGENCY Mode**
Structured 5-question intake replaces the 3-4 call/email cycle. EMERGENCY mode (equipment down) surfaces the service rep's direct number immediately. Gimba has nothing close to this.

**5. Full Work Order Management**
Gimba's work order support is inspection-centric and basic. ServiceCycle has full WO lifecycle: priority, assignment, scheduling, labor tracking, manager approvals, link to deficiency and schedule.

**6. Multi-Standard Compliance (NFPA 70B + 70E + 99 + custom)**
Gimba is NFPA 70B only. ServiceCycle runs 70B, 70E, 99, and custom compliance programs in the same product. A hospital customer alone requires both 70B and 99 — Gimba can't serve them end-to-end.

**7. Power Path / Electrical Hierarchy**
Upstream/downstream visualization of the electrical single-line. Gimba has no graph model. For root-cause analysis and outage impact assessment, this is a capability that Gimba simply can't replicate.

**8. News & Outage Monitoring**
Automated scanning of grid events and breaking news relevant to customer facilities. No equivalent in Gimba.

**9. Audit Visit Management**
Full lifecycle: schedule, perform, snapshot, recommendations, compliance calendar. Gimba produces a compliance report but doesn't manage the audit visit process itself.

**10. Tamper-Evident Activity Log**
Cryptographically chained audit trail. Every write is logged and linked. Not something Gimba documents at all. Relevant for regulated industries (healthcare, utilities).

---

## Part 3 — Gaps to Address (Things Gimba Has That You Should Consider)

**Priority: Add These**

**➕ SKM / ETAP / One-Line Diagram Import**
Electrical engineers and contractors produce their equipment inventories in SKM PowerTools and ETAP (arc flash/power flow software). If a customer already has an SKM or ETAP file with all their assets, having to manually re-enter everything is a deal blocker. This is Gimba's single strongest sales tool and the most practical thing to add.
*Effort: Medium. SKM and ETAP export to CSV/XML. A custom parser for their formats could cover 80% of cases.*

**➕ Risk-Based Scheduling (Condition-Driven Maintenance Intervals)**
Gimba auto-recalculates maintenance frequency when a device's condition rating changes, per NFPA 70B Chapter 9 tables. ServiceCycle schedules are calendar-based only. This is core to the NFPA 70B value prop and the kind of feature that makes you look like you deeply understand the standard vs. just tracking tasks.
*Effort: Medium. Requires a maintenance interval table keyed to equipment type + condition rating, and a trigger when condition changes.*

**Priority: Evaluate**

**➕ White-Label / Contractor Portal**
Gimba's biggest go-to-market wedge: electrical contractors white-label the product and sell it to their clients as "their own" compliance program. This creates a distribution channel where contractors become your sales force. If your brother's OEM has a network of service contractors, this could be a direct revenue multiplier.
*Effort: Medium-High. Requires per-account branding (logo, color scheme) and a subdomain or custom domain option.*

**➕ Flat-Rate Per-Facility Pricing Option**
No per-user pricing is a strong sales angle for facilities with large maintenance teams or contractors with many technicians. Worth offering as an alternative pricing model.
*Effort: Zero (pricing model decision, not an engineering task).*

---

## Summary Scorecard

| Category | Gimba | ServiceCycle |
|---|---|---|
| NFPA 70B Compliance | ✅ Core | ✅ |
| NFPA 70E / 99 / Custom Standards | ❌ | ✅ |
| LOTO / Lockout-Tagout | ❌ | ✅ |
| QR Code Field Scanning | ❌ | ✅ |
| Full Work Order Management | Basic | ✅ Full |
| Outage Coordination | ❌ | ✅ |
| Quote Request + Emergency Mode | ❌ | ✅ |
| Power Path Visualization | ❌ | ✅ |
| AI Nameplate + Condition Observations | Nameplate only | ✅ Both |
| Multi-Standard Compliance | ❌ | ✅ |
| White-Label Contractor Portal | ✅ | ❌ |
| SKM / ETAP Import | ✅ | ❌ |
| Risk-Based Scheduling | ✅ | ❌ |
| API / Webhooks / Integrations | ❌ | ✅ |
| News & Outage Monitoring | ❌ | ✅ |
| Tamper-Evident Audit Chain | ❌ | ✅ |

**Net assessment:** ServiceCycle is significantly broader and deeper than Gimba. Gimba is a focused NFPA 70B compliance tool that does its one thing well. ServiceCycle is the full operating platform for electrical equipment lifecycle management. The three things worth adding from Gimba's playbook: SKM/ETAP import, risk-based scheduling, and white-label contractor portal.
