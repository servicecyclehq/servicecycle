# DEMO LANDMINES v4 — Adversarial Scan Results

**Date:** 2026-06-26  
**Scan method:** 8 parallel agents with entirely new personas (not used in v1/v2/v3)  
**Base:** All v3 fixes applied (commit 564ab10)  
**Personas:** SOC2 Auditor · Mobile/PWA Engineer · API Penetration Tester · TypeScript/Code Quality Engineer · Customer Success Manager · Site Reliability Engineer · Multi-tenant Architecture Reviewer · Data Integrity/Migration Engineer

---

## Prioritized Fix Order

### 🔴 CRITICAL (Fix before any enterprise demo)
- SOC-1: Deactivation doesn't revoke sessions / bump tokenEpoch
- PWA-2: FieldJob.jsx mutations bypass offline outbox — subcontractor data loss
- DI-1: No DB FK constraints on safety-critical user ID fields (incident, arc flash records)
- DI-4: All pre-migration work orders silently reclassified as PREVENTIVE

### 🟠 HIGH (Fix before first-customer onboarding)
- SOC-4: No SAST/DAST/secret scanning in CI
- SOC-5: Production deploy SSHes as root, bypasses change control
- SOC-6: Login lockout is in-memory only, resets on every deploy
- PWA-1: Service worker doesn't cache /api/sites — offline gap
- PWA-3: Failed outbox entries never surfaced to user — silent data loss
- PWA-4: viewport-fit=cover missing — OfflineBanner overlaps header on iPhone
- PWA-5: apple-mobile-web-app-capable missing — iOS standalone mode broken
- APPSEC-1: No role gate on quote-request GET endpoints — consultant reads dossiers
- MT-3: AI/ingest/v1 rate limiters may be IP-keyed, not account-keyed
- MT-12: Alert engine take(2000) silently truncates at platform scale
- DI-2: Asset PUT — 3 sequential writes without transaction
- DI-3: Asset POST — custom fields written outside transaction
- DI-5: Archived assets processed by evidence trace/telemetry (no archivedAt filter)
- DI-6: SystemStudy has no PE credentials fields — NFPA 70E audit gap
- CS-1: Arc Flash feature invisible in nav/onboarding — never discovered by new users
- CS-2: No resend invite capability — expired invites strand users
- CS-3: Alert system silently absent when flag off — no explanation
- CS-4: LOTO Procedures card has zero in-app explanation
- SRE-1: No SLO defined — no error budget or availability commitment
- SRE-2: Better Stack wired but alert thresholds never configured
- SRE-3: Disk space: one-time startup check only, no ongoing monitoring
- SRE-4: runOnce has no per-job timeout — hung cron permanently deadlocks its slot
- SRE-5: Backup failure sends no Better Stack alert — only email (which may also be down)
- SRE-9: CI deploy health check targets port 3002 instead of 3001

---

## SOC2 Type II Auditor Findings [SOC-1 – SOC-13]

### [SOC-1] CRITICAL — CC6.3/CC6.4: Deactivation Does Not Revoke Sessions or Bump TokenEpoch
**File:** `server/routes/users.ts` lines 477–480  
`data: { isActive: false }` — no `refreshToken.updateMany` and no `tokenEpoch: { increment: 1 }`. The `/revoke-sessions` and password-change handlers both do this correctly (lines 348, 549). Deactivation does not. An admin who deactivates a departed employee leaves their refresh token valid indefinitely.  
**Fix:** Mirror the `revoke-sessions` pattern inside the deactivation handler — `refreshToken.updateMany(revokedAt: new Date())` + `user.update(tokenEpoch: { increment: 1 })`.

### [SOC-2] HIGH — CC6.1: No Periodic User Access Review Process
**File:** `docs/SOC2_CONTROLS.md` line 68  
No scheduled job, UI feature, or `access_review_completed` audit log action exists. A Type II auditor needs evidence that access was periodically reviewed during the audit period.  
**Fix:** Quarterly email digest to admins listing all active users/roles; admin acknowledgment writes `access_review_completed` to activityLog.

### [SOC-3] HIGH — CC6.3/CC7.2: Role Changes Write No Audit Log
**File:** `server/routes/users.ts` lines 386–443 (PUT /:id); lines 992–1025 (scope-restriction)  
Role change bumps `tokenEpoch` correctly (line 428) but no `writeActivityLog` call exists. Scope-restriction toggle also has no log.  
**Fix:** Add `writeActivityLog({ action: 'user_role_changed', details: { oldRole, newRole, targetUserId } })` in the role-change conditional.

### [SOC-4] HIGH — CC7.1: No SAST, DAST, or Secret Scanning in CI
**File:** `.github/workflows/ci.yml` lines 67–70  
Only `npm audit` (SCA) runs. No Semgrep/CodeQL, no DAST against running server, no TruffleHog/Gitleaks.  
**Fix:** Add `github/codeql-action` or Semgrep and `trufflesecurity/trufflehog-actions-scan` to CI workflow.

### [SOC-5] HIGH — CC8.1: Production Deploy SSHes as Root
**File:** `.github/workflows/deploy.yml` lines 9–10; `docs/DEPLOY_RUNBOOK.md` line 291  
`SC_SSH_USER = root` — full root access bypasses change control. Runbook contradicts this with "non-root sudo user" claim.  
**Fix:** Create non-root `deploy` user with minimum permissions. Disable root SSH login.

### [SOC-6] HIGH — CC7.2: Login Lockout State Is In-Memory Only
**File:** `server/routes/auth.ts` lines 243–247  
`loginFailMap` is a process-scoped `Map` — cleared on every deploy/restart. Comment acknowledges this: "Replace with DB-backed FailedLoginAttempt table."  
**Fix:** Implement `FailedLoginAttempt` DB-backed table. Document compensating control (Cloudflare rate limiting) in SOC2_CONTROLS.md in the interim.

### [SOC-7] MEDIUM — CC9.2: Vendor Review Questionnaires Are Blank
**File:** `docs/VENDOR_SECURITY_REVIEW.md` lines 79–83  
All response columns in the questionnaire template are empty. PII sub-processors (Brevo, Better Stack, Cloudflare) missing from the formal review entirely.  
**Fix:** Complete questionnaire for each PII sub-processor. Reconcile the three sub-processor lists.

### [SOC-8] MEDIUM — A1.1/A1.2: No Contractual Availability SLA or Active Uptime Alerting
**File:** `docs/SOC2_CONTROLS.md` lines 116–119; `docs/PILOT_SOW_TEMPLATE.md` line 97  
No uptime percentage commitment in ToS or SOW. Better Stack alert thresholds not configured.  
**Fix:** Add 99.5% monthly uptime to ToS/SOW. Configure Better Stack. Publish status.servicecycle.app.

### [SOC-9] MEDIUM — C1.1: No Standalone Data Classification Policy
**File:** `docs/SOC2_CONTROLS.md` line 127  
Self-identified gap: "Data classification policy not yet written as standalone doc."  
**Fix:** One-page policy defining Public/Internal/Confidential/Restricted tiers with handling requirements.

### [SOC-10] MEDIUM — CC6.2: No Email Verification Before Issuing Credentials
**File:** `server/routes/auth.ts` lines 330–524  
`issueTokenPair` called immediately after registration (line 518) — no email confirmation step. Full admin access to new tenant granted before any verification.  
**Fix:** Set `emailVerified: false` on registration, require email confirmation link before tokens are issued.

### [SOC-11] MEDIUM — CC7.2: No Automated Alerts on Privileged Actions
**File:** `server/lib/activityLog.ts` lines 9–22; `docs/SOC2_CONTROLS.md` lines 82–83  
No automated alerts when: new admin created, role changed to admin, `admin_password_reset` fired, `sessions_revoked`.  
**Fix:** Wire alert engine or email system to notify on privileged action events.

### [SOC-12] LOW — CC8.1: Change-Review Checklist Has Zero Completed Sign-Off Records
**File:** `docs/CHANGE_REVIEW_CHECKLIST.md` lines 70–74  
Template exists, sign-off rows are blank. No PR template enforces it. A Type II auditor needs completed records.  
**Fix:** Use PR description as checklist completion record. Add CODEOWNERS rule for auth/schema/middleware files.

### [SOC-13] LOW — C1.1/CC9.2: Sub-Processor List Is AI-Drafted and Counsel-Unreviewed
**File:** `client/src/legal/sub-processors-2026-05.md` lines 1–4  
Header says: "DISCLAIMER — DRAFT, NOT YET COUNSEL-REVIEWED." Currently published and linked from GDPR export responses.  
**Fix:** Complete counsel review, remove draft disclaimer. Reconcile all three sub-processor lists.

---

## Mobile/PWA Engineer Findings [PWA-1 – PWA-13]

### [PWA-1] CRITICAL — Service Worker Doesn't Cache `/api/sites`
**File:** `client/vite.config.js` lines 160–165  
`/api/sites` not covered by runtime cache rule (doesn't match `/api/field/*` or `/api/bootstrap`). Field techs lose site picker data when offline.  
**Fix:** Add `url.pathname.startsWith('/api/sites')` to the `urlPattern` condition.

### [PWA-2] HIGH — FieldJob.jsx Mutations Bypass Offline Outbox
**File:** `client/src/pages/field/FieldJob.jsx` lines 113, 130, 141  
All three write operations call `api.post()` directly instead of `fieldMutate()`. On network loss, measurement/deficiency data silently discarded. `FieldAsset.jsx` correctly uses `fieldMutate()` for the identical operations.  
**Fix:** Replace `api.post(...)` at lines 113/130/141 with `fieldMutate({ method, url, body })`.

### [PWA-3] HIGH — Failed Outbox Entries Never Surfaced to User
**File:** `client/src/lib/outbox.js` line 121  
`failedEntries()` exported but no UI component ever calls it. Server 4xx/5xx on replay silently moves entry to FAILED store — tech assumes saved, data gone.  
**Fix:** `OfflineBanner` or `FieldHome` should call `failedEntries()` on each flush and show persistent "N changes could not be saved" alert.

### [PWA-4] HIGH — `viewport-fit=cover` Missing — Safe Areas and OfflineBanner Broken on iOS
**File:** `client/index.html` line 4; `client/src/components/OfflineBanner.jsx` line 47; `client/src/pages/field/FieldLayout.jsx` line 109  
Without `viewport-fit=cover`, `env(safe-area-inset-*)` always returns `0px`. OfflineBanner uses `position: fixed; top: 0; z-index: 1000` — covers header content on notch devices.  
**Fix:** Add `viewport-fit=cover` to viewport meta. Add `padding-top: env(safe-area-inset-top)` to OfflineBanner and sticky header.

### [PWA-5] HIGH — `apple-mobile-web-app-capable` Meta Tags Absent
**File:** `client/index.html` (entirely absent)  
Without `apple-mobile-web-app-capable: yes`, iOS home screen launch still shows Safari browser chrome. Without `apple-mobile-web-app-status-bar-style: black-translucent`, status bar doesn't render edge-to-edge.  
**Fix:** Add both meta tags to `index.html`.

### [PWA-6] MEDIUM — Manifest Icon Uses Combined `"any maskable"` Purpose
**File:** `client/vite.config.js` line 142  
`purpose: 'any maskable'` deprecated in Chrome 93+. Needs two separate entries. Current icon also lacks 10% safe-zone padding.  
**Fix:** Split into two icon entries with `purpose: "any"` and `purpose: "maskable"` respectively.

### [PWA-7] MEDIUM — No Add-to-Home-Screen Install Guidance for Field Techs
**Files:** No `beforeinstallprompt` handler found anywhere in `client/src/`  
iOS never shows install prompt. Android prompt only appears if not dismissed. No in-app guidance for non-technical field techs.  
**Fix:** Add `beforeinstallprompt`-driven banner for Android; iOS detection banner with "Tap Share → Add to Home Screen" shown once on first `/field` visit.

### [PWA-8] MEDIUM — `getUserMedia` Called Without HTTPS Guard
**File:** `client/src/pages/field/FieldScan.jsx` lines 153–170  
`navigator.mediaDevices` is `undefined` on HTTP — throws `TypeError` not caught by the `NotAllowedError`/`SecurityError` handler. Tech sees generic "No camera" message.  
**Fix:** Guard with `navigator.mediaDevices?.getUserMedia`. Add specific `TypeError` branch for insecure context.

### [PWA-9] MEDIUM — FieldScan Runs jsQR Decode on Every Frame — Battery Drain
**File:** `client/src/pages/field/FieldScan.jsx` lines 129–150  
`requestAnimationFrame` at 60fps pegs main thread on mid-range Android/throttled iPhone. Comment acknowledges battery concern but only downscales.  
**Fix:** Throttle decode to every 3rd/4th frame or fixed 125ms interval.

### [PWA-10] MEDIUM — OfflineBanner Covers Header Content When Visible
**File:** `client/src/components/OfflineBanner.jsx` line 47; `client/src/pages/field/FieldLayout.jsx` line 31  
`z-index: 1000` banner renders over sticky header. `<main>` not padded to account for banner height.  
**Fix:** Either render OfflineBanner in normal document flow inside FieldLayout, or add CSS class to `<html>` when offline.

### [PWA-11] MEDIUM — `start_url: '/field'` but `scope` Unset
**File:** `client/vite.config.js` lines 137–138  
Without explicit scope, navigating to `/dashboard` leaves standalone PWA and opens Safari unexpectedly. "Full site →" link has no `target="_blank"`.  
**Fix:** Set `scope: '/field/'` explicitly. Add `target="_blank" rel="noopener"` to "Full site →" link.

### [PWA-12] LOW — FieldLayout Header Buttons Are 40px — Below 44px iOS HIG Minimum
**File:** `client/src/pages/field/FieldLayout.jsx` lines 67, 80; `client/src/pages/field/FieldJobs.jsx` line 84  
`minHeight: 40` on Sign Out, Full Site, and Refresh buttons. iOS HIG requires 44×44pt minimum tap target.  
**Fix:** Change `minHeight: 40` to `minHeight: 44` on all three elements.

### [PWA-13] LOW — iOS Speech API Voice Data Disclosure Gap
**File:** `client/src/lib/useSpeechRecognition.js` lines 38–39; `VoiceCaptureButton.jsx`  
iOS sends voice to Apple servers regardless of `interimResults`. No disclosure to users before tapping mic. For SOC2-posture app recording safety-critical measurements, this is a data handling gap.  
**Fix:** Add one-sentence disclosure: "Voice transcription uses your browser's built-in speech service." Consider first-use acknowledgment.

---

## API Security Penetration Tester Findings [APPSEC-1 – APPSEC-13]

*(APPSEC-4/5/6/11/12 confirmed secure — no finding)*

### [APPSEC-1] HIGH — No Role Gate on Quote-Request GET Endpoints
**File:** `server/routes/quoteRequests.ts` lines 218, 274, 295  
`requireQuoteWriter` applied to POST (line 313) but NOT to the three GET handlers. A `consultant`-role user can read all dossiers including service rep contact info, open deficiencies, LOTO state, and CapEx estimates.  
**Fix:** Add `requireQuoteWriter` as middleware to all three GET handlers.

### [APPSEC-2] MEDIUM — Arc Flash Incident POST Has No Write Role Gate
**File:** `server/routes/arcFlashIncidents.ts` line 66  
POST create path has no role middleware. `consultant` role can log incidents and set `oshaRecordable: true`. `reportUrl` field has no URL format/length validation.  
**Fix:** Apply `requireRole(['admin', 'manager', 'viewer'])` to POST. Add `z.string().url().max(2048)` validation to `reportUrl`.

### [APPSEC-3] LOW-MEDIUM — Arc Flash Incident PATCH Role Check Inconsistent with Super/OEM/Group Admin
**File:** `server/routes/arcFlashIncidents.ts` lines 158–163  
Hardcoded `MANAGER_ROLES = ['admin', 'manager']` — `super_admin`/`oem_admin`/`group_admin` would be incorrectly denied.  
**Fix:** Replace inline check with `requireManager` middleware which is kept in sync with role hierarchy.

### [APPSEC-7] MEDIUM — Telemetry Batch Compute Amplification
**File:** `server/routes/v1/telemetry.ts` line 29  
`MAX_BATCH = 1000` at 60 req/min = 60,000 Prisma transactions/min per API key. No per-account channel count cap — unbounded channel creation.  
**Fix:** Reduce `MAX_BATCH` to 100, or rate-limit by reading count not request count. Add `MAX_CHANNELS_PER_ASSET` cap (e.g., 200).

### [APPSEC-8] MEDIUM — Public Arc Flash Label Endpoint Has No Rate Limiter
**File:** `server/routes/arcFlashLabelPublic.ts` lines 27–30  
`GET /api/public/arc-flash-label/:token` has no rate limiter. Token enumeration possible on unauthenticated endpoint exposing PPE category, incident energy, and PE name.  
**Fix:** Apply per-IP rate limiter (20 req/min). Verify token generation uses `crypto.randomBytes(32)`.

### [APPSEC-9] MEDIUM — `INBOUND_WEBHOOK_SECRET` Has No Entropy Check at Startup
**File:** `server/routes/inboundEmail.ts` lines 128–135; `server/index.ts` validateEnv block  
`JWT_SECRET` has a 32-char minimum and startup blocklist; `INBOUND_WEBHOOK_SECRET` has none. Weak secret allows forged ingest payloads that auto-create asset records.  
**Fix:** Add same entropy check to `validateEnv()` in `server/index.ts`.

### [APPSEC-10] LOW — `field_tech` Excluded from Role-Change Allowlist Inconsistently
**File:** `server/routes/users.ts` lines 29 vs 417  
`field_tech` in `ROLES` for POST but missing from `validRoles` for PUT. Admin cannot change existing user's role to/from `field_tech` via API.  
**Fix:** Add `field_tech` to `validRoles` in the PUT handler, or document the intentional exclusion.

### [APPSEC-13] LOW — Consultant Can Enumerate All Staff Names via `/api/users/members`
**File:** `server/routes/users.ts` line 56  
`requireViewer` is effectively a no-op — all authenticated roles pass. Consultant role can list all staff member names and IDs.  
**Fix:** Change to `requireRole(['admin', 'manager', 'viewer'])` if consultant should not enumerate internal staff.

---

## TypeScript/Code Quality Findings [TSQ-1 – TSQ-9]

### [TSQ-1] HIGH — `jwt.sign()` Called Without Guard — Accepts `undefined` Secret
**File:** `server/routes/auth.ts` line 111  
No defense-in-depth check before `jwt.sign(payload, process.env.JWT_SECRET)`. `jsonwebtoken` v9 accepts `undefined` and signs with literal "undefined". Startup validator catches this normally, but no call-site guard.  
**Fix:** Add explicit `if (!jwtSecret) throw new Error('JWT_SECRET required')` guard immediately before `jwt.sign()`.

### [TSQ-2] MEDIUM — `JSON.parse(backupUpdate)` Without try/catch in `twoFactor.ts`
**File:** `server/routes/twoFactor.ts` lines 478–479  
Called inside a ternary expression at response construction — uncatchable boundary. DB corruption with malformed JSON blocks login with a 500.  
**Fix:** Parse once into a variable with try/catch before building the response.

### [TSQ-3] MEDIUM — `console.warn` Logs Raw Email Address in weatherScanner
**File:** `server/lib/weatherScanner.ts` line 181  
`` console.warn(`Email failed for ${user.email}:`, ...) `` — every other email-logging site uses `redactEmail()`. Full email in PM2 logs is a SOC2 log-controls gap.  
**Fix:** Replace `user.email` with `redactEmail(user.email)`.

### [TSQ-4] MEDIUM — Entire Prisma Model Cast to `any` in disasterEvents.ts
**File:** `server/routes/disasterEvents.ts` (~8 occurrences)  
`(prisma.disasterEvent as any).findMany(...)` — disables type-checking for all queries. Field name typos and schema drift compile silently.  
**Fix:** Run `npx prisma generate` and remove `as any` casts.

### [TSQ-5] MEDIUM — `prisma: any` Parameter in `accountExport.ts`
**File:** `server/lib/accountExport.ts` line 45  
`async function buildAccountExport(prisma: any, ...)` — disables Prisma type-checking across ~150 lines of DB access on the GDPR export path.  
**Fix:** Type parameter as `prisma: PrismaClient`.

### [TSQ-6] MEDIUM — AI Output JSON.parse Failures Look Like Infrastructure Errors
**File:** `server/lib/maintenanceBrief.ts` line 420  
Malformed AI JSON surfaces as generic 500 with only 120 chars context. Looks like infrastructure failure rather than AI output issue.  
**Fix:** Wrap in try/catch, re-throw with full failing span (capped 500 chars) and AI provider/model info.

### [TSQ-7] LOW — `@ts-ignore` Suppresses Definite-Assignment Check in backup.ts
**File:** `server/lib/backup.ts` line 360  
Comment: "pfx is initialised before this branch runs at call time" — not statically verifiable. If call sites change, `pfx` could be undefined.  
**Fix:** Initialize `pfx` at declaration with a default, or add an explicit runtime guard.

### [TSQ-8] LOW — `{} as any` Default Options Across 6 Signatures in complianceReport.ts
**File:** `server/lib/complianceReport.ts` lines 144, 220, 414, 552, 827, 876  
Suppresses compile-time protection in report generation. Propagates when copy-pasted.  
**Fix:** Define `ComplianceOptions` interface; type `prisma: PrismaClient` across all six.

### [TSQ-9] LOW — `$queryRaw<any[]>` Results Untyped in admin.ts
**File:** `server/routes/admin.ts` lines 130, 136, 138  
Column names unverified by TypeScript. A column rename produces silent `undefined` values.  
**Fix:** Define result-row interfaces for all 6 raw queries in the file.

---

## Customer Success / Onboarding Findings [CS-1 – CS-14]

### [CS-1] HIGH — Arc Flash Feature Never Surfaces in Navigation or Onboarding
**File:** `components/Sidebar.jsx` lines 963–973; `components/WelcomeTourPanel.jsx` lines 153–210; `components/OnboardingWizard.jsx` lines 27–103  
Arc Flash is only reachable via Reports → card. Onboarding wizard and welcome tour never mention arc flash. A customer who bought for arc flash label management won't find it without vendor training.  
**Fix:** Add arc flash callout in OnboardingWizard step 5 or Dashboard. Add to WelcomeTourPanel.

### [CS-2] HIGH — No Resend Invite Capability; Expired Invite Strands User
**File:** `pages/AcceptInvite.jsx` line 93; `pages/UsersPage.jsx` lines 200–209  
Invite expires silently with no pending-invites list, no expiry timestamp shown, no Resend button. Admin can't see if invite was accepted/expired.  
**Fix:** Add "Pending invites" section to UsersPage with email, role, sent-date, expiry, and Resend button.

### [CS-3] HIGH — Alert System Silently Absent When Flag Off — No Explanation
**File:** `components/Sidebar.jsx` lines 850–858; `components/WelcomeTourPanel.jsx` line 194  
`features.alerts = false` causes Alerts nav item to simply disappear. Welcome tour silently skips the row. Admin has no idea if it's paid tier, config setting, or bug.  
**Fix:** When `features.alerts` is false, render dimmed "Alerts — configure email delivery in Settings to enable" sidebar item.

### [CS-4] HIGH — LOTO Procedures Card Has Zero Explanation for Non-OSHA-Literate Users
**File:** `pages/AssetDetail.jsx` line 1271–1275; `components/AssetDocumentsCard.jsx` line 25  
No InfoTip, no inline help, no hover explanation. A facilities manager who doesn't know OSHA 1910.147 terminology will leave LOTO blank, creating a compliance gap.  
**Fix:** Add `<InfoTip content="Lockout/Tagout (LOTO) — OSHA 29 CFR 1910.147. Required for energized work on this equipment." />` next to the LOTO card title.

### [CS-5] MEDIUM — CSV Import "Could Not Read That File" Gives No Actionable Guidance
**File:** `pages/ImportAssets.jsx` lines 65–78  
Same error string fires for encoding failure, oversized file, empty file, and malformed CSV. UTF-16 export from Maximo gets "Could not read that file" with no hint.  
**Fix:** Map common error codes to specific messages. Add: "Try re-saving as CSV UTF-8 from Excel, or download the template."

### [CS-6] MEDIUM — Alert Configuration Never Mentioned in Onboarding
**File:** `components/OnboardingWizard.jsx` lines 27–103; `pages/SettingsPage.jsx` lines 1114–1124  
Condition-degradation and deficiency alerts are OFF by default. No onboarding step mentions Settings → Alerts. Customers run for weeks with zero notifications.  
**Fix:** Add step 5 to OnboardingWizard or Dashboard callout: "Configure who gets notified" → deep-link to `/settings?tab=alerts`.

### [CS-7] MEDIUM — Mock Email Mode Shows "Invite Sent" When No Email Was Delivered
**File:** `pages/SetupWizardPage.jsx` lines 221–259  
Setup wizard lets operator skip email config. UsersPage invite confirmation says "✓ Invite sent" — no email ever arrives. No persistent banner warning about mock mode.  
**Fix:** Persistent warning in Settings and Users page when `MAIL_PROVIDER=mock`.

### [CS-8] MEDIUM — "Contact Support" Is mailto-Only — Inaccessible in Enterprise Environments
**File:** `components/HelpDrawer.jsx` lines 508–524  
`href="mailto:support@servicecycle.app"` — no fallback form, no copy-to-clipboard, no support portal URL. Many corporate environments block browser mailto handlers.  
**Fix:** Show `support@servicecycle.app` as selectable text alongside the mailto. Surface contact link on the help picker screen.

### [CS-9] MEDIUM — Import Template CSV Shows One Example Row; Equipment Types Not Enumerated
**File:** `pages/ImportAssets.jsx` lines 218–240  
Only one example row with `TRANSFORMER_LIQUID`. Full equipment type enum not shown. Customers with switchgear/UPS guess wrong values and get 200 validation errors.  
**Fix:** Include a second sheet or comment row listing all valid equipment type values from `EQUIPMENT_TYPE_LABELS`.

### [CS-10] MEDIUM — Wizard Dismissal Leaves Users on Blank Pages With No CTA
**File:** `components/OnboardingWizard.jsx` line 268  
"Skip setup entirely" leads to empty dashboard with no restart prompt. Assets, Sites, and Compliance Calendar pages have no "get started" CTA for empty accounts.  
**Fix:** Add contextual empty-state prompts on key list pages when account has zero records.

### [CS-11] MEDIUM — Wizard Step 3 (NFPA 70B Schedules) Has No Example or Help Link
**File:** `components/OnboardingWizard.jsx` lines 57–71  
37-word body text provides no concrete example. Help drawer inaccessible from inside the wizard modal. Confused users skip step — empty Compliance Calendar.  
**Fix:** Add concrete example: "A liquid-filled transformer in fair condition (C2) gets an annual thermographic inspection." Add `?` link to Help Center schedules module.

### [CS-12] LOW — "Ships in a Later Release" Visible in Production Role Description UI
**File:** `pages/UsersPage.jsx` lines 459–465, 413  
Buyer-visible "ships in a later release" language in role description hint and badge tooltip. Enterprise evaluators notice.  
**Fix:** Replace with "Full site filtering coming soon" or simply remove the parenthetical.

### [CS-13] LOW — First Value Moment: Bulk Import Not Offered During Onboarding
**File:** `components/OnboardingWizard.jsx` steps 1–3  
Step 2 CTA navigates to single-asset form. No mention of bulk import anywhere in wizard. 500-asset enterprise customer adds one asset and gets stuck.  
**Fix:** Add secondary CTA on step 2: "Have a spreadsheet? Import multiple assets at once →" linking to `/import`.

### [CS-14] LOW — Self-Hosted Seeded Demo Data Has No "Sample Data" Banner
**File:** `components/DemoModeBanner.jsx` lines 24–72; `pages/SettingsPage.jsx` line 1071  
`demoMode = false` on self-hosted instances so DemoModeBanner returns null. A service partner who reseeds demo data for a pilot customer leaves the customer confused about what's real.  
**Fix:** Add account-level `hasDemoData` flag set by `reseed_demo`; show Dashboard callout: "This account contains sample data."

---

## Site Reliability Engineer Findings [SRE-1 – SRE-13]

### [SRE-1] CRITICAL — No SLO Defined
**File:** `docs/SOC2_CONTROLS.md` line 117; `docs/PILOT_SOW_TEMPLATE.md` line 97  
No uptime %, p95 latency target, or error rate budget defined anywhere. No error budget = no prioritization basis for incidents.  
**Fix:** Create `docs/SLO.md`: 99.5% monthly uptime, p95 ≤1s at `/api/ready`, ≤0.5% 5xx, RPO 24h/RTO 2h.

### [SRE-2] HIGH — Better Stack Wired But Alert Thresholds Never Configured
**File:** `docs/SOC2_CONTROLS.md` line 53, 118; `server/lib/betterStack.ts` lines 30–34  
`if (!url || !token) return null` — all `logEvent` calls are no-ops until env vars configured. SOC2 doc explicitly flags this as open gap. MTTD for server crash ≈ hours.  
**Fix:** Make `BETTERSTACK_INGEST_URL` + `BETTERSTACK_SOURCE_TOKEN` required in production startup validation.

### [SRE-3] HIGH — Disk Space: One-Time Startup Check Only
**File:** `server/index.ts` lines 1646–1663  
`statfsSync('/')` on startup only. No periodic cron, no threshold alert, no disk check in `/api/ready`. Silently approaches 100% as backups + uploads grow.  
**Fix:** Daily cron at 04:00 UTC probing disk; fires `logEvent('disk_space_warning')` below 20%, throws below 10%.

### [SRE-4] HIGH — `runOnce` Has No Per-Job Timeout
**File:** `server/index.ts` lines 1527–1546  
`_cronInFlight[name] = true` with `await fn()` and no timeout. Hung cron permanently deadlocks its slot — subsequent invocations skip silently.  
**Fix:** Wrap `await fn()` in `Promise.race()` with a 30-minute timeout. Log and throw on exceeded.

### [SRE-5] HIGH — Backup Failure Sends No Better Stack Alert
**File:** `server/lib/backup.ts` lines 316–337, 438–490  
Backup failure sends email via Brevo but no `logEvent` to Better Stack. If Brevo is also down, failure has no signal path except healthchecks.io (optional env var).  
**Fix:** Add `logEvent('backup_failed', { accountId, error })` to catch block in `runBackup`.

### [SRE-6] MEDIUM — `/tmp` Backup Fallback Silently Reports Success Then Data Disappears on Reboot
**File:** `server/lib/backup.ts` lines 227–237  
EACCES fallback to `/tmp` writes `status: 'success'` to BackupLog. `/tmp` cleared on container restart. Operator sees green while having zero durable backups.  
**Fix:** Log a `logEvent('backup_tmp_fallback')` to Better Stack. Set `BackupLog.status = 'warning'` with a note.

### [SRE-7] MEDIUM — No Circuit Breaker on Email (Brevo) — Outage Cascades Into All Crons
**File:** `server/lib/email.ts` lines 140–164  
`sendEmail` has 10s timeout but no circuit breaker. Sustained Brevo 429/503 floods failure channel from 7+ email-sending crons simultaneously.  
**Fix:** Add module-level circuit breaker to `email.ts` — after N failures, open breaker and log `logEvent('email_breaker_open')`.

### [SRE-8] MEDIUM — `/api/health` Blind to Connection Pool Exhaustion
**File:** `server/index.ts` lines 1084–1102; `server/lib/prisma.ts`  
No Prisma `P2024` error listener. `/api/ready` times out waiting for connection during pool exhaustion. No structured signal that pool exhaustion is the failure mode.  
**Fix:** Add Prisma `$on('error', ...)` listener for `P2024` codes, fire `logEvent('db_pool_exhausted')`.

### [SRE-9] HIGH — CI Deploy Health Check Targets Port 3002 Instead of 3001
**File:** `.github/workflows/deploy.yml` line 80  
Health check curls `127.0.0.1:3002/api/health`. Server runs on port 3001. A crashing deploy passes CI health gate.  
**Fix:** Change port `3002` to `3001` on line 80 of deploy.yml.

### [SRE-10] MEDIUM — Runbook Covers Zero Operational Failure Scenarios Beyond Deployment
**File:** `docs/DEPLOY_RUNBOOK.md`; `docs/INCIDENT_RESPONSE.md`  
`INCIDENT_RESPONSE.md` covers security incidents only. No runbook for: OOM kill, DB connection exhaustion, backup failure, SSL cert renewal failure, disk full, half-deploy.  
**Fix:** Create `docs/OPERATIONAL_RUNBOOK.md` with per-failure section: detection signal, containment command, recovery command.

### [SRE-11] LOW — Deep Health Check Never Called by Any Automated System
**File:** `server/index.ts` lines 1112–1114; `docker-compose.yml` lines 129–134  
`/api/ready?deep=1` (probes Brevo + Anthropic) never called by Docker HEALTHCHECK or uptime monitor. Only the shallow probe is automated.  
**Fix:** Scheduled job every 15 minutes calls deep probe and fires `logEvent` on any non-`ok` check.

### [SRE-12] LOW — `runOnceQuiet` Swallows Weekly Cron Failures Silently
**File:** `server/index.ts` lines 1548–1558  
`runOnceQuiet` correct for 30-second jobs. But `documentOrphanPrune` (weekly) uses it — weekly failure never reported to healthchecks.io.  
**Fix:** Use standard `runOnce` for `documentOrphanPrune` so weekly failures are reported.

### [SRE-13] LOW — MTTD Summary Reference
Server crash ≈ hours (Better Stack not configured). DB down ≈ hours. Backup fail ≈ 24h (healthchecks.io, if configured). Email outage ≈ days. Disk full ≈ hours/days.  
**Fix:** Wire `BETTERSTACK_INGEST_URL` + `BETTERSTACK_SOURCE_TOKEN` + `HEALTHCHECKS_PING_KEY` — 30-minute configuration task that converts MTTD from hours to minutes.

---

## Multi-Tenant Architecture Findings [MT-1 – MT-14]

### [MT-1] MEDIUM — Login Lockout Map Resets on Restart (cross-session enforcement gap)
**File:** `server/routes/auth.ts` lines 247–282  
`loginFailMap` process-scoped `Map` cleared on deploy/restart. Already documented as TODO. (See also SOC-6.)  
**Fix:** Implement DB-backed `FailedLoginAttempt` table.

### [MT-2] MEDIUM — `_denyTrack` FIFO Eviction Suppresses Wrong Tenants' Audit Logs
**File:** `server/middleware/roles.ts` lines 5–22  
At capacity (1,000 entries), oldest-inserted entries evicted FIFO. Scripted 403-producing requests from one account push out other tenants' entries, suppressing their permission-denied audit logs. Key also lacks `accountId`.  
**Fix:** Key as `"${accountId}|${userId}|${path}"`. Evict by oldest `last` timestamp (LRU), not insertion order.

### [MT-3] HIGH — AI/Ingest/v1 Rate Limiters May Be IP-Keyed in Shared-NAT Environments
**File:** `server/index.ts` (limiter declarations); `server/lib/rateLimitHelpers.ts` lines 29–40  
`ingestLimiter`, `publicParseLimiter`, `aiIpLimiter`, `v1IpLimiter` — if any don't pass `keyGenerator: buildRateLimitKey`, they fall back to `req.ip`. Behind a shared NAT, one user's burst throttles all 50 colleagues.  
**Fix:** Ensure all subsidiary limiters explicitly pass `keyGenerator: buildRateLimitKey`.

### [MT-4] MEDIUM — Global AI Budget Guard — One Account Exhausts Platform Quota
**File:** `server/lib/aiBudgetGuard.ts` lines 75–95  
`_dailyState` and `_monthlyCloudflare` are platform-wide module-level objects. One account bulk-processing 50 PDFs exhausts global daily cap — all other tenants get 503 for rest of UTC day.  
**Fix:** Enforce per-account daily caps via `aiQuota.ts`. Ensure no account has `UNLIMITED` effective cap.

### [MT-5] MEDIUM — Alert Engine Crash on One Account's Data Aborts All Subsequent Accounts
**File:** `server/lib/alertEngine.ts` lines 468–500  
Outer try/catch wraps entire run. Malformed schedule row in any account throws, aborting all accounts with later `nextDueDate ASC`. Since urgent schedules sort first, one integrity issue reliably breaks all less-urgent accounts.  
**Fix:** Per-account loop with per-account try/catch. Pattern already demonstrated in `monthlyDigest.ts`.

### [MT-6] LOW — Monthly Digest Partial-Send Advances Watermark Despite Failed Recipients
**File:** `server/lib/monthlyDigest.ts` lines 312–322  
`ok = true` if at least one email succeeds. `markBriefingSent` uses this to advance watermark. Failed recipients receive no retry on next cycle.  
**Fix:** Record failed addresses in `DigestFailure` table for retry, or log warning when partial failure.

### [MT-7] LOW — `super_admin` Cross-Tenant Metrics Access Not Audit-Logged
**File:** `server/routes/admin.ts` lines 376–443  
`GET /api/admin/metrics/overview` (super_admin only) reads platform-wide data with no ActivityLog write. Compromised super_admin enumeration is invisible to log review.  
**Fix:** Add `ActivityLog` write (`action: 'super_admin_metrics_accessed'`) to cross-tenant admin endpoints.

### [MT-8] LOW — `downloadFile()` Has No Built-In Ownership Check
**File:** `server/lib/storage.ts` lines 90–95, 162–177; `server/routes/documents.ts` lines 202–273  
`downloadFile()` serves any key passed to it. Isolation relies entirely on route-level DB check. Future developer writing new file-serving endpoint could bypass unknowingly.  
**Fix:** Add JSDoc warning that callers must verify ownership. For defense-in-depth, add S3 bucket policies scoped per-prefix.

### [MT-9] MEDIUM — IP-Level Credential Limiter Causes Shared-NAT Lockout Across Facility
**File:** `server/routes/auth.ts` lines 162–212  
`credentialLimiter` IP-keyed, `max: 10` per 15 minutes. 10 failed logins from any combination of 50 NAT users blocks login for all 50 for 15 minutes.  
**Fix:** Increase `max` on IP-level limiter, or remove and rely on per-email lockout. Exclude valid-refresh-token requests.

### [MT-10] LOW — `POST /api/news/refresh` Has Undocumented Platform-Wide Side Effects
**File:** `server/lib/newsScanner.ts` lines 8–11, 152–184  
News is shared cross-tenant (no `accountId`). Any manager-role user triggering a refresh updates the shared news feed visible to all tenants.  
**Fix:** Accept as designed. Add route comment documenting the platform-wide side effect.

### [MT-11] MEDIUM — SSO Domain Claim TOCTOU Race — P2002 Collision Surfaces as 500
**File:** `server/routes/ssoAdmin.ts` lines 163–176  
`findUnique` then `create` as separate operations. Concurrent requests both pass the check, second `create` gets Prisma `P2002` unique constraint — not caught, surfaces as raw DB error 500.  
**Fix:** Wrap `ssoDomain.create` in try/catch; catch `P2002` and return 409. Pattern already correct in `adminPartnerOrgs.ts` line 272.

### [MT-12] HIGH — Alert Engine `take(2000)` Silently Truncates at Platform Scale
**File:** `server/lib/alertEngine.ts` lines 480–488  
Platform-wide `take: 2000` cap on cross-account `findMany`. With 200 accounts × 20 schedules = 4,000 schedules. Accounts with latest due dates silently never alerted. No log, no error.  
**Fix:** Iterate per-account with separate queries, each with their own `take` guard. Pattern demonstrated by `monthlyDigest.ts`.

### [MT-13] LOW — `super_admin` 403'd by `requireAdmin` Behavior Undocumented
**File:** `server/routes/admin.ts` lines 95–173; `server/middleware/roles.ts` lines 155–166  
`requireAdmin` checks `role !== 'admin'` — `super_admin` is correctly blocked. But this surprises operators. Undocumented.  
**Fix:** Document in operator runbook: `super_admin` uses `/api/admin/metrics/overview`, not `/api/admin/kpis`.

### [MT-14] MEDIUM — `accountTouchCache` Uses Insertion-Order Eviction, Not LRU
**File:** `server/middleware/auth.ts` lines 14–52 (lines 38–39)  
Cap 5,000, evicts oldest-inserted entry (FIFO). Most active account inserted early gets evicted by new registrations even if touched 1ms ago. `lastActiveAt` drifts for most-active accounts.  
**Fix:** Delete-and-reinsert on each cache hit for true LRU. Pattern already in `loginFailMap` at `auth.ts` lines 265–270.

---

## Data Integrity / Migration Engineer Findings [DI-1 – DI-14]

### [DI-1] CRITICAL — No DB FK Constraints on User IDs in Safety-Critical Records
**Files:** `schema.prisma` lines 1253–1254 (`IncidentLog`), 3257 (`ArcFlashIncident`), 3175–3184 (`ArcFlashCollectionTask`), 3221 (`DeviceTestRecord`), 1213 (`ShareLink`)  
Scalar `String?` fields with no FK constraint or Prisma relation. Deleted user leaves stale UUID in incident authorship fields. For NFPA 70E audit trail, PE/inspector identity is legally required.  
**Fix:** Add SQL-level FK constraints with `ON DELETE SET NULL` via migration.

### [DI-2] HIGH — Asset PUT — 3 Sequential Writes Without Transaction
**File:** `server/routes/assets.ts` lines 1052–1109  
`asset.update` → `writeCustomFieldValues` → `maintenanceSchedule.update` (loop) — no `prisma.$transaction`. Crash between steps leaves condition changed but schedules with stale `nextDueDate`.  
**Fix:** Wrap all three steps in `prisma.$transaction([...])` or interactive transaction API.

### [DI-3] HIGH — Asset POST — Custom Fields Written Outside Transaction
**File:** `server/routes/assets.ts` lines 829–871  
`prisma.asset.create` (line 829) + `writeCustomFieldValues` (line 869) as separate operations. Process crash leaves asset row with no custom fields and no ActivityLog entry.  
**Fix:** Wrap `asset.create`, `writeCustomFieldValues`, and `ActivityLog.create` in a single `$transaction`.

### [DI-4] HIGH — Pre-Migration Work Orders Silently Reclassified as PREVENTIVE
**File:** `server/prisma/migrations/20260626120000_wo_features_labor_parts_approval/migration.sql` line 9  
`ADD COLUMN "workOrderType" NOT NULL DEFAULT 'PREVENTIVE'` — all historical WOs now read as PREVENTIVE. Corrective/emergency/acceptance test history destroyed irreversibly. Corrective vs. preventive ratio KPI permanently wrong for pre-migration period.  
**Fix:** For any future production import, require one-time reclassification step or inference from description/source fields.

### [DI-5] HIGH — Archived Assets Processed by Evidence Trace, Maintenance Brief, Telemetry
**Files:** `server/lib/evidenceTrace.ts` lines 89–92; `server/lib/maintenanceBrief.ts` lines 125–126; `server/lib/telemetryMonitoring.ts` lines 63–64; `server/lib/photoInspect.ts` lines 115–116  
`prisma.asset.findFirst({ where: { id, accountId } })` without `archivedAt: null`. Decommissioned equipment appears in compliance evidence, gets maintenance briefs generated, receives telemetry updates.  
**Fix:** Add `archivedAt: null` to `where` clause in each function, or extract shared `activeAsset()` helper.

### [DI-6] HIGH — SystemStudy Has No Engineer/PE Credentials Fields
**File:** `server/lib/arcFlashIntegrity.ts` line 153; `schema.prisma` (`SystemStudy` model)  
No `performedByName`, `performedByCredentials`, or `peStampNumber` on `SystemStudy`. NFPA 70E §130.5 requires arc flash studies be performed by a "qualified person." Auditors will ask for credentials; system has no answer.  
**Fix:** Add `performedByName String?`, `performedByCredentials String?`, `peStampNumber String?` to `SystemStudy`. Surface in integrity alerts and exports.

### [DI-7] MEDIUM — `toLocaleDateString()` Without Locale in Arc Flash Compliance Emails
**File:** `server/lib/arcFlashIntegrity.ts` lines 227–228, 288–289  
Server locale-dependent date formatting. Near UTC midnight, displayed date one day off. Study expiry dates in compliance notifications could cause incorrect re-evaluation scheduling.  
**Fix:** Replace with `study.performedDate.toISOString().slice(0, 10)` for explicit UTC date.

### [DI-8] MEDIUM — Outage Blackout Windows Use Server Local-Time Midnight, Not UTC
**File:** `server/routes/outagePlanner.ts` line 506  
`startsAt.setHours(0, 0, 0, 0)` sets midnight in server process timezone. VPS timezone change or customer in different timezone causes planned maintenance window time offset.  
**Fix:** Use `new Date(Date.UTC(year, month, date))` for explicit UTC midnight.

### [DI-9] MEDIUM — New Alert Types Have No Preference Rows for Existing Accounts
**File:** `server/prisma/migrations/20260625120000_add_alert_types/migration.sql`; `schema.prisma` `AlertPreference`  
Migration adds 4 new `AlertType` enum values but no `INSERT INTO alert_preferences` backfill. Existing users cannot opt out of new alerts without first receiving one. For `arc_flash_expiry`, this means unexpected compliance emails.  
**Fix:** Add migration seeding `AlertPreference` rows with defaults for all existing accounts for each new alert type.

### [DI-10] MEDIUM — CFO Report Missing Per-Site and Per-Equipment-Type Breakdown
**File:** `server/lib/cfoReport.ts` lines 47–122  
`buildCfoReportData` collapses to single `overallRate`. Missing: per-site compliance rates, per-equipment-class breakdown, tester credentialing summary, individual WO IDs traceable to specific inspections.  
**Fix:** Add `bySite` array (per-site compliance rate + open deficiency count) and `byAssetClass` array to `buildCfoReportData`.

### [DI-11] MEDIUM — `ieAfter <= 40` DANGER Boundary Sensitive to IEEE 754 Float Rounding
**File:** `server/lib/arcFlashMitigation.ts` lines 131–134  
`Math.round(ie * (1 - pct/100) * 100) / 100` compared to `40`. Float accumulation could produce `40.01` when mathematically `40.00`, failing to flag DANGER elimination.  
**Fix:** Add boundary unit tests at exactly 40 cal/cm² input. Consider `ieAfter <= 40 + Number.EPSILON * 100`.

### [DI-12] MEDIUM — `account.fteCount` Null on All Existing Accounts — Division Hazard
**File:** `schema.prisma` line 296 (`Account.fteCount Int?`)  
No backfill applied. Any cost-per-employee KPI divides by null — tile renders blank or NaN for all existing accounts.  
**Fix:** Null guard wherever `fteCount` is used. Or backfill with sentinel value and show "complete your profile" prompt.

### [DI-13] MEDIUM — Electrode Config Backfill Silently Destroys Non-Conforming Values
**File:** `server/prisma/migrations/20260622150000_arc_flash_electrode_enum/migration.sql` lines 9–10  
`UPDATE ... SET electrodeConfig = NULL WHERE NOT IN ('VCB', 'VCBB', 'HCB', 'VOA', 'HOA')` — irreversibly NULLs any non-conforming free-text electrode config. No audit log of affected rows. Electrode config affects IEEE 1584 calculations.  
**Fix:** For future destructive backfills, `INSERT INTO audit_log` before UPDATE. At minimum, `SELECT COUNT(*)` assertion before execution.

### [DI-14] LOW — Arc Flash Integrity Emails Omit Incident Energy and PPE Category
**File:** `server/lib/arcFlashIntegrity.ts` lines 39–66  
Alert emails include reason and dates but not current incident energy or PPE category. 1.2 cal/cm² panel vs 38 cal/cm² panel are very different priorities — recipient has no urgency context.  
**Fix:** Join to `SystemStudyAsset` to pull peak incident energy and PPE category; include summary table in alert email body.

---

## Finding Count Summary

| Persona | Findings | Critical | High | Medium | Low |
|---|---|---|---|---|---|
| SOC2 Auditor | 13 | 1 | 5 | 4 | 3 |
| PWA Engineer | 13 | 1 | 4 | 5 | 3 |
| API Pen Tester | 8 | 0 | 1 | 4 | 3 |
| TypeScript Quality | 9 | 0 | 1 | 4 | 4 |
| Customer Success | 14 | 0 | 4 | 6 | 4 |
| SRE | 13 | 1 | 5 | 4 | 3 |
| Multi-Tenant | 14 | 0 | 2 | 7 | 5 |
| Data Integrity | 14 | 2 | 5 | 6 | 1 |
| **TOTAL** | **98** | **5** | **27** | **40** | **26** |

