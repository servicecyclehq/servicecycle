# DEMO LANDMINES v6 — Adversarial Scan Results

**Scan date:** 2026-06-26
**Personas:** CMMS-6, ESO-6, PEN-6, SE-6, INS-6, SRE-6, DD-6, NETA-6
**Findings:** 109 across 8 personas
**Prior scans:** v1 (baseline), v2, v3, v4, v5 (all fixed)

---

## CMMS-6: Reliability Engineer (14 findings)

[CMMS-1] CRITICAL: No Meter-Based PM Scheduling — Calendar-Only Engine
No runtime hours, cycle counts, or odometer fields on Asset or MaintenanceSchedule. computeNextDueDate() always adds months to lastCompletedDate. NFPA 70B §9.3 and ISO 55000 §8.6.2 recognize usage-based triggers. Generator seeded at 36-month interval drifts out of compliance with 250-hour oil change.
File: server/lib/maintenanceInterval.ts (entire file); prisma/schema.prisma (MaintenanceSchedule model)

[CMMS-2] CRITICAL: No MTBF, MTTR, or Availability Calculation Anywhere
Zero code computing MTBF, MTTR, or asset availability. laborHours, startedAt, completedDate timestamps exist — raw data is present but never aggregated. Admin KPIs endpoint returns DAU and retention but no reliability metrics. A plant manager asking "what's my MTTR for transformers at Plant 2?" gets nothing.
File: server/routes/admin.ts (no reliability aggregates); prisma/schema.prisma lines 1082–1089

[CMMS-3] CRITICAL: Approval Workflow Has No Cost Threshold Trigger — AWAITING_APPROVAL Is Client-Driven Only
No server-side cost threshold that automatically routes a WO to AWAITING_APPROVAL. No costApprovalThresholdCents on Account or Site. Any manager can directly transition SCHEDULED → IN_PROGRESS → COMPLETE on a $250K parts order without triggering approval. ISO 55000 §8.3.3 requires server-enforced approval thresholds.
File: server/routes/workOrders.ts lines 57–63, 1194–1237; prisma/schema.prisma (Account model)

[CMMS-4] HIGH: nextDueDate Is NULL Until First Completion — Newly Onboarded Assets Have No Due Dates
All 200 schedules for a newly imported facility have nextDueDate = null. Dashboard excludes null-date schedules — shows 0 overdue for a completely unmanaged fleet. NFPA 70B §4.3 requires an initial assessment baseline; no mechanism to anchor from install date at import time.
File: prisma/schema.prisma lines 993–997; server/routes/assets.ts lines 453–459

[CMMS-5] HIGH: Part Inventory Decrement Has No Negative-Quantity Guard — qtyOnHand Can Go Below Zero
POST /api/work-orders/:id/parts decrements qtyOnHand with no floor check. No CHECK constraint. If 5 fuses consumed when 2 are on hand, qtyOnHand goes to -3 with no error. Data integrity failure.
File: server/routes/workOrders.ts lines 1310–1317

[CMMS-6] HIGH: Work Order Completion Allows asFoundCondition = C1 With Open IMMEDIATE Deficiencies
COMPLETE handler does not cross-check as-found condition against existing deficiency severity. NETA MTS §5.5 defines IMMEDIATE as requiring equipment shutdown — recording C1 while IMMEDIATE deficiency is open is a fraudulent record. Poisons complianceSnapshot and AI brief.
File: server/routes/workOrders.ts lines 535–570, 716–721

[CMMS-7] HIGH: No Functional Location Code (FLOC) — No ISO 14224 / SAP-Compatible Taxonomy
EquipmentPosition.code is a short display label, not a structured hierarchical FLOC. No functionalLocationCode field on Asset. SAP PM integration impossible without FLOC. nameplateData JSON absorbs everything that doesn't fit.
File: prisma/schema.prisma lines 750–769, 776–909

[CMMS-8] HIGH: No Failure Code / Root Cause Analysis Fields on Work Orders or Deficiencies
No failureMode, failureCause, failureEffect, or faultCode on WorkOrder or Deficiency. No machine-readable failure data — only free-text description. Cross-asset failure trending impossible. Table-stakes gap versus any CMMS competitor.
File: prisma/schema.prisma lines 1032–1114, 1159–1183

[CMMS-9] HIGH: No Parts Reservation System — Parts Can Be Consumed by Multiple Concurrent Work Orders
No qtyReserved on SpareInventory. Stock only decremented at consumption time, not at scheduling. Two concurrent work orders can both see qtyOnHand = 1, both proceed, second technician finds part gone. ISO 55000 §8.6 requires staging/reservation.
File: prisma/schema.prisma lines 3297–3320, 3327–3346

[CMMS-10] HIGH: Schedule Roll-Forward After Condition Change Uses `now` as Anchor for Null lastCompletedDate
A C3 degradation on a never-maintained asset produces nextDueDate = 12 months from today instead of "immediately overdue." Most at-risk assets get farthest-out due dates. Safety-critical logic error.
File: server/routes/assets.ts lines 1079–1088; server/lib/maintenanceInterval.ts lines 127–132

[CMMS-11] MEDIUM: Blackout Windows Are Informational Only — Scheduler Does Not Block WO Creation Into Freeze Periods
POST /api/work-orders and PUT /api/work-orders/:id never query BlackoutWindow to validate scheduledDate. AI brief loads blackout context — advisory only. No server enforcement.
File: server/routes/workOrders.ts lines 301–403; server/lib/maintenanceBrief.ts lines 273–280

[CMMS-12] MEDIUM: Total Work Order Cost Never Aggregated — Parts + Labor = No Server-Side Total
No totalCostCents on WorkOrder. GET /api/work-orders/:id includes partsUsed but client must sum. No aggregated cost query in admin.ts. "What did all transformer maintenance cost last year?" is unanswerable.
File: prisma/schema.prisma lines 1080–1083; server/routes/workOrders.ts lines 1249–1260

[CMMS-13] MEDIUM: isAcceptanceTest Flag Can Only Be Set by Ingest — No UI Toggle
PUT /api/work-orders/:id does not accept isAcceptanceTest as a writable field. A manager receiving a paper commissioning report cannot set this flag. Oldest work order becomes baseline by default.
File: server/routes/workOrders.ts lines 419–425; prisma/schema.prisma line 1073

[CMMS-14] MEDIUM: No ERP/Historian Integration Hooks — Webhook Events Omit Asset Condition Changes and Cost Data
No webhook events for asset.condition_changed, work_order.cost_recorded, inventory.low_stock, or deficiency.immediate_opened. No bulk-export endpoint for historian systems. OSIsoft PI / SAP integration requires polling, not pushes.
File: server/lib/webhook.ts (narrow event taxonomy); server/routes/v1/ (no historian export)

---

## ESO-6: Electrical Safety Officer (14 findings)

[ESO-1] CRITICAL: LOTO Has No Gate on Work Order Issuance — 29 CFR 1910.147 Requires Procedure Before Work Begins
requiresOutage flag exists on MaintenanceTaskDefinition but POST /api/work-orders never checks LOTO status. A WO for requiresOutage=true can be created, started, and completed with no active LOTO procedure. LotoProc model exists but workOrders.ts never queries it.
File: server/routes/workOrders.ts lines 308–403, 535–570; server/routes/loto.ts

[ESO-2] CRITICAL: LOTO Cannot Record Per-Employee Lock Application — No Audit Trail
29 CFR 1910.147(c)(7)(iii) requires each employee to apply their own personal lock. LotoStep has no performedByUserId, performedAt, or lockSerialNumber. No LotoExecution model. Multi-craft lockout scenarios architecturally impossible to document.
File: prisma/schema.prisma lines 2434–2453; server/routes/loto.ts

[ESO-3] CRITICAL: Energized Work Permit Is Never Persisted to DB — No Durable Safety Record
buildEnergizedWorkPermit() returns JSON in HTTP response but never writes to any table. Permit content (who requested, justification, attestations, PPE, signatures) is lost on response delivery. NFPA 70E §130.2(B) requires retention. No EnergizedWorkPermit table in schema.
File: server/lib/arcFlashPermit.ts lines 59–147; prisma/schema.prisma (no EnergizedWorkPermit model)

[ESO-4] CRITICAL: IMMEDIATE Deficiency Can Be "Resolved" With a Text Note Alone — No Corrective WO Required
POST /api/deficiencies/:id/resolve sets resolvedAt with no gate requiring a linked corrective work order, no minimum note length, and no second-person attestation. No resolutionWorkOrderId FK. NFPA 70B EMP element 8 and OSHA 1910.303 require documented resolution.
File: client/src/pages/WorkOrderDetail.jsx lines 527–539; prisma/schema.prisma lines 1159–1183

[ESO-5] HIGH: WO Completion Allows asFoundCondition = null for requiresEnergized Tasks — No NFPA 70E Gate
CompleteModal defaults to "" ("Not recorded"). Server accepts null as-left silently. NFPA 70E §130.5(G) requires qualified person to verify conditions before and after energized task. No enforcement.
File: server/routes/workOrders.ts lines 536–556; client/src/pages/WorkOrderDetail.jsx lines 86–183

[ESO-6] HIGH: LOTO approvedById Is Set by the Status-Change Requester — Procedure Author Can Self-Approve
PATCH /api/assets/:assetId/loto/:id/status sets approvedById = req.user.id. No check that approvedById !== createdById. NFPA 70E requires independent review of safety procedures.
File: server/routes/loto.ts lines 279–285

[ESO-7] HIGH: requiresEnergized Work Orders Have No Pre-Work Arc Flash Permit Check — Work Begins Without Permit
Status transition to IN_PROGRESS never calls validatePermitIssuance() even when requiresEnergized = true. Crew can begin energized work with stale/missing study and no permit. No server-side block.
File: server/routes/workOrders.ts lines 519–533; server/lib/arcFlashPermit.ts lines 38–47

[ESO-8] HIGH: IncidentLog Has No OSHA Recordability Classification — ARC_FLASH_EVENT Cannot Be Triaged for 300 Log
No injuryOccurred, daysAwayFromWork, oshaRecordable, or firstAidOnly fields. note is nullable — ARC_FLASH_EVENT can be logged with no description. No investigation workflow linked to ARC_FLASH_EVENT. NFPA 70E §130.5(L) requires immediate investigation initiation.
File: prisma/schema.prisma lines 1191–1265

[ESO-9] HIGH: No PPE Availability Verification Before Work Order Issuance — System Assumes PPE Exists
Neither POST /api/work-orders nor IN_PROGRESS transition checks whether required PPE is available on site. No PpeInventory model. Permit's toComplete array includes PPE confirmation as self-attestation only. System can issue energized-work permits when no matching suit exists.
File: server/lib/arcFlashPermit.ts lines 119–124; server/routes/workOrders.ts lines 519–533

[ESO-10] HIGH: LotoStep Lacks Mandatory "Verify Zero Energy" Step Enforcement
PATCH /:id/status transitions draft → active without checking at least one verify-category step exists. 29 CFR 1910.147(d)(6) requires verification of de-energization before work begins. A LOTO procedure with only shutdown and lockout steps can be activated.
File: server/routes/loto.ts lines 263–311, 44–64

[ESO-11] MEDIUM: Arc Flash Study Expiry Alert Fires at 60 Days but In-Flight WOs Still Complete After Expiry
validatePermitIssuance() blocks new permits when study expired. But COMPLETE handler never re-validates. Crew can complete energized work 10 days after study expired. NFPA 70E §130.5(C) requires valid study at time of work, not just at permit issuance.
File: server/routes/workOrders.ts lines 535–570; server/lib/arcFlashPermit.ts lines 38–47

[ESO-12] MEDIUM: No Qualified Person Verification at WO Completion — requiresEnergized Tasks Accept Any Assignee
COMPLETE handler never compares assigned tech's actual cert level against netaCertLevel. A field_tech with LEVEL_I can complete an energized task requiring LEVEL_III. 29 CFR 1910.331–335 requires qualified worker verification.
File: server/routes/workOrders.ts lines 535–570, 585–605

[ESO-13] MEDIUM: ARC_FLASH_EVENT in IncidentLog Has No Automatic Re-Study Trigger
When ARC_FLASH_EVENT is logged, no StudyReviewFlag is created, no alert fires on the asset's SystemStudyAsset, and no re-study work order is auto-generated. NFPA 70E §130.5(C) requires re-evaluation after an arc flash event.
File: prisma/schema.prisma lines 1191–1265; server/lib/arcFlashIntegrity.ts

[ESO-14] MEDIUM: In-Progress Energized WO Can Be Cancelled Without Verifying LOTO Has Been Removed
cancelJob() sends status: CANCELLED with no check that crew has left hazard zone or LOTO devices have been properly removed. 29 CFR 1910.147(e)(1)–(3) specifies required re-energization sequence. No safety confirmation workflow for cancellation of IN_PROGRESS energized work.
File: client/src/pages/WorkOrderDetail.jsx lines 375–392; server/routes/workOrders.ts lines 759–773

---

## PEN-6: Penetration Tester (13 findings)

[PEN-1] CRITICAL: Fleet Webhook SSRF — fleetDashboard.ts Bypasses validateWebhookUrl() Denylist
PATCH /api/fleet/settings stores webhookUrl with only scheme check — does NOT call validateWebhookUrl() from lib/webhook.ts (which has RFC1918/link-local/cloud-metadata denylist). oem_admin can set webhookUrl = "https://169.254.169.254/latest/meta-data/" and trigger POST /api/fleet/settings/webhook-test, receiving instance metadata in the 5xx error body.
File: server/routes/fleetDashboard.ts lines 1068–1137

[PEN-2] CRITICAL: Invite-Accept Role Mass Assignment via Token Replay — Expired Invites Not Purged on Role Change
Outstanding UserInvite tokens survive admin demotion/deactivation. POST /api/auth/invite/:token/accept stamps role: invite.role verbatim. An attacker with a 48-hour admin invite link sent before the inviting admin was demoted can create a full admin account after the issuer no longer has admin rights.
File: server/routes/auth.ts lines 1135–1163; server/routes/users.ts lines 462–531

[PEN-3] HIGH: Horizontal Privilege Escalation — Backdated completedDate Falsifies Maintenance Records
COMPLETE transition rejects dates >1 day future and <createdAt-1day but allows any date within that window. Manager can systematically back-date completions to defer overdue NETA maintenance from appearing in schedule. measurementType is unbounded — allows injection into tamper-evident audit chain.
File: server/routes/workOrders.ts lines 536–551, 844–893

[PEN-4] HIGH: Cross-Account Data Leak via GET /api/users/:id/export — API Keys for Admin Account Exposed
Export route collects apiKeysOnAccount using accountId: req.user.accountId (all API keys for requesting admin's account, not just target user's). A consultant simultaneously admin on another tenant can invoke export to get all API key metadata for that account.
File: server/routes/users.ts lines 668–762

[PEN-5] HIGH: JWT tokenEpoch Uses != Not < — Legacy Pre-Epoch Tokens Valid Indefinitely on Unmodified Accounts
(decoded.ep ?? 0) !== user.tokenEpoch. Users who never had epoch bumped have tokenEpoch=0. Pre-epoch tokens carry no ep claim, evaluates 0 !== 0 = false → pre-epoch tokens remain valid indefinitely until natural JWT TTL expiry.
File: server/middleware/auth.ts lines 109–111

[PEN-6] HIGH: Mass Assignment — featureFlags Accepts Arbitrary Keys in Batch Permissions Update
PUT /api/users/permissions calls sanitizeFlags but if it passes through unrecognised keys, admin can set arbitrary featureFlags on non-admin users, bypassing account-level feature gating. PUT /api/users/me/hidden-features accepts arbitrary hiddenFeatures keys beyond the allowlist.
File: server/routes/users.ts lines 283–311, 980–1018

[PEN-7] HIGH: Race Condition on Part Inventory Decrement — Negative qtyOnHand via Concurrent Requests
decrement: qty has no floor check and no advisory lock. Two concurrent requests each decrementing the full available quantity produce negative integers. No CHECK constraint in schema. DELETE of a parts usage record then re-delete via TOCTOU can over-increment above physical max.
File: server/routes/workOrders.ts lines 1299–1317, 1349–1355

[PEN-8] HIGH: IDOR — GET /api/v1/arc-flash/work-order-precheck Returns Full Study Data With Only Read Scope
Route has no requireScope('write') — any read-scoped API key suffices. Returns hazard, reasons, and full study. Attacker with read key can enumerate every arc-flash study by iterating assetId patterns (404 vs 200 timing confirms existence).
File: server/routes/v1/arcFlash.ts lines 125–142

[PEN-9] HIGH: Open Redirect via CLIENT_URL Misconfiguration — Invite Links Can Point to Attacker Domain
Invite URL constructed as ${appUrl}/accept-invite/${token} with no sanitization. CORS reflects matching origins from CLIENT_URL. If CLIENT_URL misconfigured to attacker domain, all pending invite tokens delivered to attacker who harvests them and creates admin accounts.
File: server/routes/users.ts lines 122–123; server/index.ts lines 580–610

[PEN-10] MEDIUM: Rate Limit Bypass — API Key Traffic Falls to IP Bucket, CF Header Spoofing Risk
API keys are not JWTs; verifyToken throws, falls through to _clientIpKey. v1IpLimiter allows 300/min/IP. Attacker controlling CF-Connecting-IP header (when server reachable direct, bypassing CF) gets 300/min per spoofed IP bucket. Internal Docker NAT makes CF IP range check unreliable.
File: server/index.ts lines 756–875; server/lib/rateLimitHelpers.ts

[PEN-11] MEDIUM: ShareLink Token Lookup Uses Plaintext Comparison — Timing Oracle for Enumeration
prisma.shareLink.findUnique() on plaintext token is not constant-time. Response time difference (200+data vs 404) allows timing-based prefix enumeration. Share links have no per-use rate limit separate from the anonymous apiLimiter bucket (30/min).
File: server/routes/shareLinkPublic.ts lines 20–47

[PEN-12] MEDIUM: Admin Self-Check at /api/admin/restore-test/deep Uses Inline Role Check — Bypasses Audit Logging
Inline if (req.user.role !== 'admin') check bypasses requireAdmin() middleware which calls _logDenied(). Unauthorized access attempts generate zero audit evidence. On demo instances any sandbox visitor can trigger pg_dump against PG_TEST_DB_URL returning row counts for every table.
File: server/index.ts lines 1368–1386

[PEN-13] MEDIUM: [outage-sched:id,...] Notes Pattern Allows Cross-Asset Schedule Manipulation
COMPLETE handler parses [outage-sched:id,...] regex from notes field. A manager can embed other assets' schedule UUIDs in notes, rolling forward maintenance schedules for unrelated assets on WO completion. Filter includes assetId scope but single-line deletion of that filter creates cross-asset primitive.
File: server/routes/workOrders.ts lines 610–624

---

## SE-6: Enterprise Sales Engineer (13 findings)

[SE-1] CRITICAL: Leave-Behind PDF Error Uses alert() — Raw Browser Dialog in Enterprise Demo
LeaveBehindButton catches PDF generation failures with window.alert(). When VP clicks "Leave-Behind PDF" and network hiccups, they see a native browser alert box. No other component in the app uses alert().
File: client/src/pages/WorkOrderDetail.jsx:201

[SE-2] CRITICAL: TODO Comment Visible in Production Source — Security Scope Admission in Field Mode
FieldScan.jsx contains a developer TODO comment referencing an explicit security finding by name (SEC finding UX6) admitting field techs see all account assets instead of assigned only. Shipped in production bundle. A CISO doing source review sees acknowledged unfixed hole.
File: client/src/pages/field/FieldScan.jsx:55-57

[SE-3] HIGH: AssetsList Export Silently Excludes Per-Column Filters — Export Doesn't Match What User Sees
XLSX export tooltip warns "per-column header filters are not applied to exports" but no visible warning before clicking Export. Plant manager who drilled into filtered view gets hundreds of extra rows. Trust-destroying during demo.
File: client/src/pages/AssetsList.jsx:494-498

[SE-4] HIGH: Assets Table Title Shows Internal Abbreviation "Open Def." — Unprofessional Column Label
Column header "Open Def." instead of "Open Deficiencies." NETA, NFPA, and every CMMS vendor uses the full term. Reads as a prototype to anyone familiar with electrical industry tools.
File: client/src/pages/AssetsList.jsx:62, 713

[SE-5] HIGH: Work Order Measurement Form Has No Loading State While Save Is Inflight
measSaving disables the button but form fields stay enabled. Rapid double-submit creates duplicate measurement row. No success toast after measurement is added — table silently reloads.
File: client/src/pages/WorkOrderDetail.jsx:1011-1069

[SE-6] HIGH: CompleteScheduleModal in AssetDetail Has No Focus Trap — Tab-Cycles Behind Backdrop
CompleteScheduleModal uses role="dialog" aria-modal="true" but does NOT call useFocusTrap. WorkOrderDetail's CompleteModal correctly does. Keyboard users tab through entire background page.
File: client/src/pages/AssetDetail.jsx:179-238

[SE-7] HIGH: Measurement Type Is Free-Text — Typos Create Permanent Non-Aggregatable Records
Plain input placeholder "e.g. Insulation resistance" with no dropdown or autocomplete. "IR Scan", "IR scan", "Insulation Resistance", and "Megger" for same test type never aggregate. Looks like amateur data management to VP.
File: client/src/pages/WorkOrderDetail.jsx:1016

[SE-8] HIGH: AssetDetail Documents Card Renders Twice — Functional Duplication on Same Page
AssetDocumentsCard rendered at line 1294 AND a second simpler documents list at lines 1370-1386. Any uploaded document appears in both sections simultaneously. Looks like a bug.
File: client/src/pages/AssetDetail.jsx:1291-1386

[SE-9] HIGH: Field Tech Assignment Card and Lab Samples Card Both Have order: 4 — Layout Tie
Both cards assigned CSS order: 4 — browser resolves via DOM position, not design intent. On SCHEDULED work order, Field Technician card stacks unexpectedly against Lab Samples.
File: client/src/pages/WorkOrderDetail.jsx:1145, 1280

[SE-10] MEDIUM: Global Sidebar Search Queries Only Assets — Searching Work Order Name Returns Nothing
GET /api/assets?search= exclusively. Typing a work order task name, deficiency description, or contractor name returns "No matches" with no suggestion to search elsewhere. Demo-flow killer: prospects use search first.
File: client/src/components/Sidebar.jsx:77

[SE-11] MEDIUM: Activity Feed Shows Date Only, No Time — Audit Log Useless for Same-Day Events
fmtDate() formats as "Jun 25, 2026" with no time. Two activities on same day appear simultaneous. Enterprise audit logs always show date + time. Matters when CISO reviews audit trail.
File: client/src/pages/AssetDetail.jsx:1402

[SE-12] MEDIUM: Pagination Buttons Use ‹ Symbol Mixed With Text — Unprofessional on Tablet
"‹ Prev" and "Next ›" use single left-pointing angle quotation character. No aria-label or title. Screen readers announce "less than Prev." Looks unpolished on narrow tablet viewport.
File: client/src/pages/AssetsList.jsx:988-1002

[SE-13] MEDIUM: FieldScan Torch Button Uses 🔦 Emoji — Renders as Box on Enterprise MDM WebViews
Line 297 and 302 use 🔦 emoji in button text. On Android WebView in enterprise MDM containers (Workspace ONE, Intune Managed Browser), emoji render as blank boxes. First thing a field tech sees during demo.
File: client/src/pages/field/FieldScan.jsx:297, 302

---

## INS-6: Insurance & Risk Underwriter (14 findings)

[INS-1] CRITICAL: Contractor NETA Accreditation Has No Expiry Date — Boolean Is a Snapshot, Not Time-Bounded
netaAccredited Boolean @default(false) with no netaAccreditationExpiryDate or certNumber. NETA accreditation renews every 3 years. Lapsed contractor still shows green. No expiry alert, no cron flip. All work orders linked to that contractor show false green.
File: prisma/schema.prisma lines 590–617, 622–657

[INS-2] CRITICAL: Deferred Maintenance Leaves No Documented Risk-Acceptance Trail — Silent Liability Accumulation
No MaintenanceDeferral model. When manager pushes nextDueDate forward, prior due date is silently overwritten with no record of who approved, original date, justification, or accepted risk level. FM Global DS 5-19 and most property policies require documented risk acceptance for deferred critical maintenance.
File: prisma/schema.prisma lines 990–1030 (MaintenanceSchedule); server/routes/workOrders.ts (no deferral endpoint)

[INS-3] CRITICAL: No Insurer-Formatted Overdue Asset Export — Cannot Produce FM Global DS 5-19 Annual Summary
No dedicated export producing the per-asset row detail a carrier needs: asset tag, equipment type, last test date, next due date, days overdue, last condition rating, open deficiency count, test technician. ComplianceSnapshot stores aggregate counts only. No /api/reports/overdue-assets endpoint.
File: prisma/schema.prisma lines 1606–1637; server/routes/assets.ts lines 400–459

[INS-4] HIGH: No Manufacturer Warranty Interval Tracking — Warranty Void Risk Not Surfaced
No warrantyExpiresAt, manufacturerServiceIntervalMonths, or warrantyVoidConditions on Asset. No OEM service bulletin reference on MaintenanceTaskDefinition. System cannot warn that in-house inspection voids transformer warranty.
File: prisma/schema.prisma lines 750–900, 940–975

[INS-5] HIGH: Arc Flash Study Chain of Custody Incomplete — PE License Not Validated, No Jurisdiction Field
peName String? and peLicense String? are nullable free-text. Study can be posted with neither. No peLicenseState, no studyFirmAddress, no validation against any state PE license pattern. A study with peName = "John Smith" and no license number is legally worthless.
File: prisma/schema.prisma lines 1282–1315; server/lib/arcFlashLabelDoc.ts lines 55–57

[INS-6] HIGH: IMMEDIATE Deficiency Can Be Closed With Text Note — No Corrective WO Required
Deficiency.resolvedAt can be set with free-text correctiveAction only — no linked completed work order, no as-left measurement, no NETA decal. Most dangerous liability exposure in the schema. Opposing counsel presents IMMEDIATE items closed without documented corrective work as systemic negligence.
File: prisma/schema.prisma lines 1159–1180; server/routes/workOrders.ts lines 1069–1105

[INS-7] HIGH: Completed WO Allows Post-Completion Editing of completedDate Without Re-Attestation — Tamper Risk
workOrders.ts allows completedDate update on already-COMPLETE WO with no re-attestation or manager approval. No distinct "completion date amended" audit log action. Opposing counsel challenges whether date reflects actual performance or was backdated post-incident.
File: server/routes/workOrders.ts lines 742–757, 674–687

[INS-8] HIGH: Contractor Liability Insurance Tracking Absent — Cannot Prove Subcontractor Was Insured
No generalLiabilityInsuranceExpiry, workersCompInsuranceExpiry, or insuranceCertificateUrl on Contractor. No gate checking COI is current before work order assignment. Lapsed COI can call policyholder's own policy as primary.
File: prisma/schema.prisma lines 586–617; server/routes/workOrders.ts lines 284–299

[INS-9] HIGH: FM Global DS 5-19 Transformer Test Intervals Not Enforced — 2-Year IR Requirement Ignored
FM Global requires insulation resistance testing on liquid-filled transformers every 24 months regardless of condition. No insurerRequiredIntervalMonths field. A C1-rated transformer on NFPA 70B model could legitimately be scheduled at 60-month IR interval — 2.5× the FM Global maximum.
File: prisma/schema.prisma lines 940–975; server/scripts/seed-standards.js

[INS-10] HIGH: Energized Work Permit Not Persisted — Destruction of Primary Evidence (see ESO-3)
From an insurance claims standpoint: if a worker is injured during energized work and the permit exists only in browser memory, the policyholder cannot demonstrate they issued a permit. Insurer's coverage defense of "willful OSHA violation" becomes available to deny the claim.
File: server/lib/arcFlashPermit.ts lines 89–117; prisma/schema.prisma (no EnergizedWorkPermit table)

[INS-11] MEDIUM: Subcontractor Tech Qualification Has No Employer-of-Record Field — Misclassification Liability
No employerOfRecord, subcontractorRelationship, or workerClassification on ContractorTech. Combined with absent COI tracking (INS-8), system cannot support policyholder's defense that injured worker was covered employee of insured subcontractor.
File: prisma/schema.prisma lines 622–657

[INS-12] MEDIUM: ComplianceSnapshot Has No Soft Delete — Primary Compliance Evidence Can Be Permanently Destroyed
No deletedAt on ComplianceSnapshot, no onDelete: Restrict on Account FK. sha256 detects tampering at rest but if DB row deleted, proof that a compliance report existed is gone. In subrogation proceedings 3 years after loss, retrievable snapshot records are required.
File: prisma/schema.prisma lines 1606–1637

[INS-13] MEDIUM: LOTO Approver Has No Qualified Person Attestation — Administrative Manager Can Approve
LotoProc.approvedById is any User FK with no check that approver has electrical qualification. User model has no qualifiedPersonDesignatedAt or electricalQualificationLevel. OSHA 29 CFR 1910.147 requires procedures approved by qualified person.
File: prisma/schema.prisma lines 2373–2400, 458–519

[INS-14] MEDIUM: Expired Study Label Still Generates — ⚠ EXPIRED Annotation Prints but Doesn't Block
arcFlashLabelDoc.ts blocks when IE and PPE category absent. No block when study is expired — only adds footer annotation. A tech who prints an expired-study label and posts it on equipment has created a posted hazard assessment the system acknowledges is stale but did nothing to prevent.
File: server/lib/arcFlashLabelDoc.ts lines 48–57, 159–169

---

## SRE-6: Platform SRE (14 findings)

[SRE-1] CRITICAL: Advisory Lock Held on Prisma Connection — Graceful Shutdown Loses Cron Leader Silently
pg_try_advisory_lock(4242000001) is held by a Prisma backend connection. No SIGTERM handler calls prisma.$disconnect() before process exits. If PM2 sends SIGKILL before Prisma disconnects, lock held by dead connection until Postgres timeout. Restart may cause cron leader flip — double-firing prune batch and backup.
File: server/index.ts lines 1692–1706

[SRE-2] CRITICAL: No SIGTERM Handler — In-Flight Requests Not Drained, DB Pool Not Closed
Zero process.on('SIGTERM') or process.on('SIGINT') handlers. Docker sends SIGTERM then waits stop_grace_period: 30s before SIGKILL. httpServer.close() never called. prisma.$disconnect() never called. In-flight backup or cron silently abandoned mid-write.
File: server/index.ts (entire file — no shutdown hook); httpServer declared at line 1648 but never closed

[SRE-3] HIGH: Cold-Start Race — aiBudgetGuard setInterval Runs on ALL PM2 Instances, Not Just Cron Leader
setInterval registering persistMonthlyCounters() is NOT inside the advisory lock guard. On 2-instance PM2 cluster, two concurrent persistMonthlyCounters() calls every 60 seconds. Last writer wins — silently drops other instance's count. Budget guard can under-count spend and fail to enforce monthly cap.
File: server/index.ts lines 2226–2230; server/lib/aiBudgetGuard.ts

[SRE-4] HIGH: Backup Cron Not Idempotent — Restart Mid-Dump Leaks Temp Directories Into tmpfs
mkdtemp dir created but finally block never runs on SIGKILL. /tmp/servicecycle-pgdump-XXXXXX leaks. Server's tmpfs is size=100m — smaller than likely dump size. ENOSPC on next backup attempt.
File: server/lib/backup.ts lines 147–182; docker-compose.yml line 182

[SRE-5] HIGH: serviceOpportunityTrigger Cron Issues 1,000 Sequential DB Roundtrips — No Batching
02:30 UTC cron: up to 1,000 sequential prisma calls (findFirst + create per assetId) in a for loop with no concurrency limit. Overlaps with backup cron at 02:00 and partnerRetentionArchival at 02:05. Concurrent DB write storm during 02:00–02:30 UTC window on same 10-connection pool.
File: server/index.ts lines 2238–2362

[SRE-6] HIGH: _cronInFlight Object Never Pruned — Unhandled Rejection Permanently Locks a Cron Slot
If any cron throws an unhandled rejection outside runOnce try/catch, _cronInFlight[name] stays true permanently. That cron silently skips every subsequent tick for the life of the process. weatherScanner (every 15 min) and partnerWebhookRetry (every 15 min) most exposed.
File: server/index.ts lines 1534–1553, 1786, 2479

[SRE-7] HIGH: /api/ready Deep Probe Gated Behind ?deep=1 — Operators Never Pass This Flag
Without ?deep=1, ingest worker stall returns green 200. Docker HEALTHCHECK uses psql SELECT 1 not /api/ready. An operator using /api/ready to validate deploys will never see ingest worker failures unless they explicitly pass ?deep=1. No documentation sets this flag.
File: server/index.ts lines 1119–1207; docker-compose.yml line 138

[SRE-8] HIGH: S3 pruneS3Backups() Has No 1,000-Object Pagination Guard for DeleteObjects
pruneS3Backups() accumulates full toDelete array before issuing single DeleteObjectsCommand. AWS S3 DeleteObjects max is 1,000 keys per request. Account crossing 1,000 backup objects receives MalformedXML error, prune fails silently, files accumulate indefinitely.
File: server/lib/backup.ts lines 314–317

[SRE-9] HIGH: arcFlashIntegrity Runs N+1 DB Queries Per Account With No Batching
Path 3 (relay/breaker deficiencies) iterates up to 500 rows, each calling getAdmins() + maybeCreateArcFlashQuote() + notificationLog.findFirst() + account.findUnique() + sendEmail() sequentially. 50 accounts × 10 deficiencies = 2,000–2,500 sequential Prisma calls in the 09:30 cron slot, on shared 10-connection pool.
File: server/lib/arcFlashIntegrity.ts lines 459–506

[SRE-10] MEDIUM: pruneLocalBackups() Orphans Backups Written to Fallback /tmp Path
When getLocalPath() falls back to /tmp/servicecycle-backups (on EACCES), pruneLocalBackups() checks the configured path instead of the fallback — orphaned tmp backups in a different directory are never pruned.
File: server/lib/backup.ts lines 255–260, 200–246

[SRE-11] MEDIUM: aiBudgetGuard Counters Are Process-Local — Multi-Instance PM2 Under-Counts Spend
In-memory counters diverge between PM2 instances. Last writer wins upsert drops other instance's count. Budget guard can under-count and fail to enforce configured monthly cap.
File: server/index.ts lines 2226–2230; server/lib/aiBudgetGuard.ts

[SRE-12] MEDIUM: weatherScanner Runs Every 15 Minutes With No Debounce — Restart Doubles NWS API Rate
On container restart, old process mid-flight + new process winning its own runOnce lock doubles NWS request rate. NWS rate limit ~1 req/sec with no documented burst allowance. IP ban silently stops disaster event creation. No idempotency key — duplicate DisasterEvent rows on restart during event-creation loop.
File: server/index.ts lines 1786–1793

[SRE-13] MEDIUM: backup.ts Reads Entire pg_dump Buffer Into Node Heap Before S3 Upload
runPgDump() returns full Buffer which is encrypted then passed to PutObjectCommand Body. 1 GB production database loads entirely into Node.js heap simultaneously. Server memory limit is 1g in docker-compose. Nightly backup on busy instance spikes heap to ceiling, OOM killer fires mid-backup with no error in BackupLog.
File: server/lib/backup.ts lines 177, 286–296; docker-compose.yml line 75

[SRE-14] MEDIUM: Single-Node Postgres — Single Point of Failure, No Documented RTO
Single DigitalOcean droplet, all services in one docker-compose.yml, named volume postgres_data. No replica, no logical replication, no hot standby, no automated failover. Recovery time: 20–40 minutes minimum (provision + restore + migrate + DNS). HEALTHCHECKS_PING_KEY is unset.
File: docker-compose.yml (entire architecture); server/index.ts lines 425–427

---

## DD-6: M&A Due Diligence (14 findings)

[DD-1] CRITICAL: Entire Server Runtime Is tsx JIT Transpile — No Compiled Artifact, No Production Build Step
server/package.json "start": "node node_modules/tsx/dist/cli.mjs index.ts" — raw TypeScript in production via tsx JIT. No tsc --outDir dist. All devDependencies (jest, ts-jest, esbuild, nodemon) ship in production image. ~100–250ms cold-start overhead per restart. No reproducible binary.
File: server/package.json lines 7–8, 22

[DD-2] CRITICAL: Solo Founder Bus Factor — Self-Audited SOC2 Controls, Zero Second Reviewer
PERSONNEL_SECURITY.md documents single-developer reality explicitly: "No PR approval requirement (single dev; founder approves by deploying)." Entire codebase — auth, encryption, arc flash, GDPR erasure, Stripe — designed, written, and self-reviewed by one person. Post-close ramp-up: months.
File: docs/PERSONNEL_SECURITY.md line 25; docs/SOC2_CONTROLS.md line 91

[DD-3] CRITICAL: AlertEngine Hard-Capped at 2,000 Schedules Per Cron Run — Architecture Breaks at ~100 Tenants
take: 2000 global ceiling across all accounts. A single large customer with 1,000 assets × 5 task definitions = 5,000 schedule rows. Tail of schedule list silently never evaluated. Overdue assets in truncated accounts receive no alert. No paging loop, no per-account cursor, no observability metric for skipped schedules.
File: server/lib/alertEngine.ts lines 482–513

[DD-4] HIGH: In-Memory Login Lockout Resets on Every Deploy — Brute-Force Window Opens Post-Deploy
Per-email lockout state lives in process-scoped Map (loginFailMap). PM2 restart on every deploy resets all lockout state. Attacker can send 4 failed attempts, wait for deploy, repeat indefinitely — never triggering 5-failure lockout.
File: server/routes/auth.ts lines 233–247; prisma/schema.prisma lines 3376–3386

[DD-5] HIGH: Locale Hardcoded in Three Library Files — I18n Requires Code Surgery
alertEngine.ts line 131, cfoReport.ts line 35, monthlyDigest.ts line 44 each hardcode DEFAULT_LOCALE = process.env.DEFAULT_LOCALE || 'en-US' and USD currency. No locale field on Account. Supporting a second locale requires changes in 8+ files.
File: server/lib/alertEngine.ts line 131; server/lib/cfoReport.ts line 35; server/lib/monthlyDigest.ts line 44

[DD-6] HIGH: Mixed CJS/ESM Module System — Production Fragility on Native ESM Migration
server/index.ts uses require() for all route imports but import prisma from './lib/prisma'. Multiple lib files use module.exports = {}; export {};. tsx handles via CJS/ESM shim today. Incompatible with native ESM, Next.js API routes, or standard Node build pipeline. Any acquirer refactoring faces ~100 files simultaneously.
File: server/index.ts lines 1–4, 1644–1645; server/lib/stripe.ts lines 161–170

[DD-7] HIGH: Test Suite Covers Only 3 HTTP Endpoints — Zero Coverage on Arc Flash, LOTO, WO State Machine, Billing
server/tests/ contains: health, auth, aiQuota, upload, promptSanitize, requestId, demoGuard, openapiRegistry. No tests for: WO state machine, arc-flash label generation, LOTO lifecycle, SCIM provisioning, SSO PKCE flow, parts inventory, any v1 API endpoint, or the ingest worker.
File: server/tests/ (directory); .github/workflows/ci.yml lines 86–121

[DD-8] HIGH: API v1 Has No Sunset Mechanism — Breaking v2 Is Architecturally Stranded
No Deprecation or Sunset HTTP header infrastructure. No version negotiation, no sunset date tracking, no per-tenant version pinning, no notification mechanism for breaking changes. An acquirer with existing integrations inherits a v1 12-month commitment they cannot operationally honor.
File: server/index.ts lines 1403–1413; docs/api/CHANGELOG.md lines 87–97

[DD-9] HIGH: $queryRawUnsafe in Production Hot Path — Pattern Sets Dangerous Precedent
ingestWorker.ts lines 31–43: claimNextJobId() uses $queryRawUnsafe. Additional call in admin.ts line 517. $queryRawUnsafe bypasses Prisma's type-safe parameterization entirely. Zero compile-time safety net for future developers adding tenant-scoped filtering to raw queries.
File: server/lib/ingestWorker.ts lines 31–43; server/routes/admin.ts line 517

[DD-10] HIGH: Data Export Excludes LOTO, SSO Config, Arc Flash Permits, Activity Log Hash Chain
GET /api/export/account covers sites, assets, schedules, WOs, deficiencies, quote requests. Does not include: LotoProc/LotoStep, SsoConnection/ScimDirectory, arc flash permits, IncidentLog, AuditVisit/AuditRecommendation, or ActivityLog hash-chain. GDPR Article 20 data portability claim unanswerable.
File: server/routes/export.ts lines 238–269; server/lib/exportHelpers.ts

[DD-11] MEDIUM: AlertEngine deliverWebhooks Is N×M Sequential — 1,000 HTTP Calls Per Cron at Scale
deliverWebhooks nested for loop: endpoints × alertItems, all sequential await postOnce(). At 10 accounts × 5 endpoints × 20 alerts = 1,000 sequential outbound HTTP calls with 5s timeout each (5,000s theoretical ceiling). No parallelism, no circuit breaker.
File: server/lib/alertEngine.ts lines 354–378, 399–401

[DD-12] MEDIUM: EquipmentType Is Append-Only Postgres Enum — New Categories Require Coordinated Redeploy
Adding FUEL_CELL, SOLAR_INVERTER, CHARGING_STATION requires ALTER TYPE + Prisma regeneration + SDK type exports + OpenAPI spec — all coordinated redeploy. No taxonomy expansion path for EV infrastructure or renewable assets without multi-system migration.
File: prisma/schema.prisma lines 73–101; sdk/src/types.ts line 13

[DD-13] MEDIUM: Core AI Features Are Commodity Prompt Wrappers — No Proprietary Training Data, No Moat
AI extraction prompts are wrappers around Anthropic/Gemini/Groq/OpenAI with no fine-tuning. pdfjs-dist table extraction is MIT-licensed public library. NETA standards compliance matrix is manually curated from public Appendix B values — not proprietary IP. Only true lock-in is accumulated per-customer data over time.
File: server/lib/ai.ts; server/lib/testReportParse.ts; server/scripts/seed-standards.js

[DD-14] MEDIUM: IncidentLog.resolvedById and createdById Are Orphaned Strings — No FK, No Cascade
No @relation declarations to User model. After GDPR user erasure, IncidentLog retains deleted user's UUID as dangling string with no SetNull cascade. Querying who resolved a safety incident post-turnover returns non-existent user ID.
File: prisma/schema.prisma lines 1244–1265; server/routes/users.ts lines 769–864

---

## NETA-6: NETA Technical Standards Council (14 findings)

[NETA-6-1] CRITICAL: No Report Release Gate — Completed Work Orders Immediately Accessible Without QA Review
NETA MTS-2023 §5.4.4 requires review by qualified person before report release. COMPLETE transition has zero report-review step. No reportStatus, reviewedBy, or releasedAt timestamp. PENDING_REVIEW → RELEASED gate does not exist. Tech submitting failing value immediately produces client-facing document.
File: server/routes/workOrders.ts lines 536–736; prisma/schema.prisma lines 1032–1110

[NETA-6-2] CRITICAL: No Client Signature or Third-Party Witness Record — Witnessed Testing Not Supported
NETA MTS-2023 §5.4.2 and §5.6 allow witnessed testing requiring client representative attestation. No clientSignedAt, clientSignatureName, witnessedBy, or thirdPartyWitnessAttestation on WorkOrder or TestMeasurement. Leave-behind PDF has no signature block.
File: prisma/schema.prisma lines 1032–1110; server/lib/leaveBehindPdf.ts lines 140–165

[NETA-6-3] CRITICAL: Instrument NIST Traceability Has No Machine-Readable Fields — Cal Certificate Is Freetext
testEquipment Json? captures {make, model, serial, calDate} as free-text strings. No calCertificateNumber, calLaboratoryName, calLaboratoryAccreditation (A2LA/NVLAP). NETA MTS-2023 §5.4.2 #4 requires documented NIST-traceable calibration records for every instrument. Auditor cannot verify the chain.
File: server/routes/workOrders.ts lines 71–78; prisma/schema.prisma lines 1063–1069

[NETA-6-4] HIGH: Maintenance Testing vs. Acceptance Testing Is a Single Boolean Flag — No Distinct Data Model
isAcceptanceTest Boolean is the only distinction between NETA MTS-2023 (maintenance) and NETA ATS-2021 (acceptance) work. Different required test points, pass criteria, and report sections are structurally indistinguishable beyond this one boolean. No acceptance test completion gate.
File: prisma/schema.prisma line 1073; server/routes/workOrders.ts lines 536–570

[NETA-6-5] HIGH: DGA Lab Accreditation Not Captured — labName Is Unvalidated Free-Text
LabSample.labName String? accepts any string. No labAccreditationNumber, labAccreditationBody (A2LA, ISO/IEC 17025), or labReportNumber. NETA MTS-2023 §7.10 requires accredited laboratory for oil analysis. DGA record is inadmissible without lab accreditation documentation.
File: prisma/schema.prisma lines 1505–1551; server/routes/workOrders.ts lines 1107–1192

[NETA-6-6] HIGH: DeviceTestRecord Has No workOrderId Link — Relay/Breaker Trip Test Records Are Orphaned
DeviceTestRecord has assetId, protectiveDeviceId, systemStudyAssetId, and ingestBusId but no workOrderId FK. A primary-injection trip test cannot be traced back to the specific work order (contractor, date, instruments, tech cert level) under which it was performed. NETA MTS-2023 §7.6 and §7.19 require complete test provenance.
File: prisma/schema.prisma lines 3202–3234

[NETA-6-7] HIGH: Leave-Behind PDF Missing NETA MTS-2023 §5.4.2 Required Report Sections
NETA requires: (a) asset nameplate data, (b) test conditions (ambient temp, humidity), (c) calibrated instruments used, (d) expected results beside actuals, (e) standard reference citation. Leave-behind PDF renders deficiency list and quotes only. No ambient temp/humidity block, no instrument table, no standard reference. It's a sales summary, not a NETA test report.
File: server/lib/leaveBehindPdf.ts lines 100–265; server/lib/leaveBehindData.ts lines 37–102

[NETA-6-8] HIGH: passFail on TestMeasurement Uses GREEN/YELLOW/RED — Not NETA's Pass/Fail/Conditional Vocabulary
NETA MTS-2023 and ATS-2021 use Pass, Fail, Conditional. YELLOW has no defined NETA meaning — creates dangerous ambiguity on safety-critical documents. UI renders GREEN/YELLOW/RED as decal colors in the pass/fail column, conflating two distinct concepts.
File: prisma/schema.prisma line 1126; client/src/pages/WorkOrderDetail.jsx line 1059

[NETA-6-9] HIGH: No Voltage-Class Field on Asset — MV/HV Cable Test Cannot Be Distinguished From LV Cable Test
No ratedVoltageKv Decimal? on Asset. Voltage only in unstructured nameplateData JSON. NETA MTS-2023 §7.3 requires fundamentally different procedures (VLF at 0.1Hz for MV vs. DC hipot for LV) with different test voltages and acceptance criteria. Scheduler cannot select correct task definition.
File: prisma/schema.prisma lines 776–930, 92–97

[NETA-6-10] MEDIUM: Per-Measurement Acceptance Criterion Is Free-Text Entered by Tech — Not Standards-Derived
TestMeasurement.expectedRange String? is a plain free-text field. Tech types criterion by hand. NETA MTS-2023 §5.4.2 #8 requires expected results from applicable NETA tables, not field entry. A PE reviewing the report cannot verify the criterion was correctly applied.
File: client/src/pages/WorkOrderDetail.jsx line 1044; prisma/schema.prisma line 1129

[NETA-6-11] MEDIUM: IMMEDIATE Deficiency Resolution Requires No Re-Test — Corrective Action Chain Not Enforced
NETA MTS-2023 §5.5: IMMEDIATE = equipment must not be energized until deficiency corrected and re-tested. Resolve endpoint allows one-click confirm with no subsequent test evidence. Chain required by NETA MTS-2023 §8 (deficiency → corrective action → re-test → pass) is not enforced.
File: client/src/pages/WorkOrderDetail.jsx lines 527–539; prisma/schema.prisma lines 1159–1180

[NETA-6-12] MEDIUM: testVoltage on TestMeasurement Is Free-Text — Cannot Validate Against NETA Table 100.1
TestMeasurement.testVoltage String? accepts any string. NETA Table 100.1 specifies required test voltage by equipment voltage class. No typed testVoltageV Decimal?, no link to rated voltage, no validation that applied voltage meets NETA minimums. Tech can enter "500 VDC" on a 5kV cable with no warning.
File: prisma/schema.prisma line 1130; server/routes/workOrders.ts lines 844–893

[NETA-6-13] MEDIUM: IR/Thermal Images Have No Structured Metadata — No thermal_ir_survey DocType
NETA ATS-2021 §7.22 requires IR survey records to include deltaT, emissivity, load at scan time, instrument model and serial. No thermal_ir_survey DocType on Document. No structured metadata fields for IR-specific data. Automated trending of ΔT over successive annual surveys impossible.
File: prisma/schema.prisma lines 1692–1730, 217–245

[NETA-6-14] MEDIUM: PROTECTION_RELAY Assets Have No Coordination Study Reference — Relay Calibration Test Lacks Setting Authority
NETA MTS-2023 §7.19 requires relay calibration test records to include coordination study reference (date, engineer of record) against which settings were verified. No coordinationStudyRef, studyDate, or studyEngineer on WorkOrder, TestMeasurement, or DeviceTestRecord. Relay calibration can be marked GREEN with no reference to what the authoritative settings should be.
File: prisma/schema.prisma lines 3202–3234, line 88

---

## Summary by Severity

CRITICAL: 18 findings (CMMS: 3, ESO: 4, PEN: 2, SE: 2, INS: 3, SRE: 2, DD: 3, NETA-6: 3)
HIGH: 59 findings
MEDIUM: 32 findings

## Priority Fix Targets for v6

1. **ESO-3 / INS-10**: Energized work permit persistence — create EnergizedWorkPermit table and persist every permit issued
2. **ESO-1**: LOTO gate on work order issuance for requiresOutage=true tasks
3. **PEN-1**: SSRF via fleet webhook — apply validateWebhookUrl() in fleetDashboard.ts
4. **PEN-2**: Invite token replay after role change — expire UserInvite on issuer demotion
5. **CMMS-1**: Add meter-based PM scheduling fields to schema
6. **CMMS-3**: Server-enforced cost approval threshold
7. **DD-3**: AlertEngine schedule pagination — remove the 2,000-row hard cap
8. **SE-1**: Replace alert() with proper error toast in LeaveBehindButton
9. **SE-2**: Remove TODO comment revealing security scope in FieldScan production bundle
10. **SRE-2**: Add SIGTERM handler with graceful shutdown
11. **INS-1**: Add netaAccreditationExpiresAt to Contractor model
12. **NETA-6-3**: Add calCertificateNumber and calLaboratoryName to test equipment schema
