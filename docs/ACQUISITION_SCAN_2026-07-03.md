# Acquisition & Demo Readiness Scan — 2026-07-03

Six parallel Fable audits run against HEAD. No code changes made — findings only.
Priority tiers: **P0 = fix before any demo**, **P1 = fix before diligence**, **P2 = fix when convenient**.

---

## SCAN 1 — OpenAPI v1 Spec Drift

Spec: `server/data/openapi/v1.yaml` vs all v1 route handlers.

### P0 — Deficiency enum is completely wrong
- **Spec** severity values: `CRITICAL | HIGH | MEDIUM | LOW`
- **Code** (`DeficiencySeverity` in schema.prisma): `IMMEDIATE | RECOMMENDED | ADVISORY`
- Every documented value returns 400; every real value is invisible to spec consumers.
- Same issue: spec documents `code` and `status` fields that don't exist; code returns `resolvedAt` and `correctiveAction` (undocumented).

### P1 — Broken `$ref`s and undefined security scheme
- `components` section has no `responses` key; references to `#/components/responses/Unauthorized` and `#/components/responses/RateLimited` will cause strict OpenAPI tooling to error.
- `/me` declares `security: [{ bearerApiKey: [] }]` — only `ApiKeyAuth` is defined.

### P1 — Arc-flash devices endpoint drift
- Request body: spec requires `deviceType` (with `BREAKER_LV`/`FUSE_HV` examples); code accepts lowercase `breaker|fuse|relay|switch` and treats `deviceType` as optional.
- `tripSetting` and `notes` are documented but silently stripped by zod.
- Code accepts `label`, `partNumber`, `frameRatingA`, `sensorRatingA`, `settings` — none documented.
- 201 response shape: spec `{ success, data }`; code returns `{ device: {...} }`.
- Documented "Supports Idempotency-Key" — not implemented.

### P1 — Schema mismatches across endpoints
- `ArcFlashLabel`: `studyExpired` and `disclaimer` documented but never returned; `studyMethod` returned but undocumented.
- `GET /arc-flash/work-order-precheck`: spec has `success: boolean`; handler returns `{ assetId, canIssue, reasons, hazard, study, disclaimer }`.
- `POST /telemetry/notifications/{id}/acknowledge`: spec documents 13-field `TelemetryNotification`; handler returns 4 fields only.
- `WorkOrder.status`: spec missing `AWAITING_APPROVAL` (exists in code; those WOs appear with undocumented status).
- `AssetDetail.schedules`: spec says flat with `intervalDays`; code returns nested `{ taskDefinition: {...} }` with no `intervalDays`.

### P2 — Parameter drift
- `?severity=` on deficiencies: spec `OPEN|RESOLVED` (uppercase); code accepts only lowercase — documented values return 400.
- `GET /telemetry/channels`: undocumented `page`/`limit` params returned with undocumented `pagination` object.
- Stale comment at `index.ts:1448`: "Read-only — no write endpoints exist in v1" (3 write endpoints exist).

---

## SCAN 2 — Documentation Accuracy

### P0 — SOC2_CONTROLS.md CC5.3 claim fails inspection
- Claims: "CI runs tsc --noEmit + jest (unit + integration) on every PR."
- Reality: `.github/workflows/ci.yml` runs `--selectProjects unit` only (+ 3 smoke tests). The 107-file integration suite is never run in CI.
- An auditor who checks `ci.yml` will catch this immediately.

### P1 — ENGINEERING_HANDOFF.md: encryption hierarchy doesn't exist
- Claims per-account keys decrypted on auth into memory.
- Reality: `ENCRYPTED_KEYS` is a `Set` constant of 3 setting names in `settings.ts:77`; values encrypted directly with `MASTER_KEY` (`crypto.ts`). No per-account key hierarchy.

### P1 — ENGINEERING_HANDOFF.md: "nightly S3 backup" stated as fact
- `BACKUP_DEST` defaults to `local`. S3 only if operator configures `BACKUP_S3_*`.
- SOC2_CONTROLS.md CC9.1 repeats this. The repo's own `RISK_REGISTER.md` R-03 explicitly warns S3 is "NOT guaranteed unless configured and verified." The two docs contradict each other.
- Fix: verify `BACKUP_DEST=s3` on the live droplet and document the actual state; or qualify the claim.

### P1 — ENGINEERING_HANDOFF.md: CI and AI cascade claims wrong
- "CI runs jest (unit + integration)" — only unit project runs.
- "Cascade for ask/classify only" — cascade applies to all tasks on cloudflare provider since v0.38.3 (`ai.ts:155-173`).
- Cascade order documented as "Cloudflare → HuggingFace → Groq"; actual order is Cloudflare → Groq → HuggingFace.

### P1 — ARCHITECTURE.md: multiple wrong claims
- Email row says "Resend (transactional + inbound)." Reality: Brevo is transactional (`lib/email.ts` header: "Why Brevo (not Resend)"). Resend is inbound only.
- AI providers row says "Anthropic Claude (primary)." Cascade is Cloudflare → Groq → HuggingFace; Anthropic is a selectable single provider, not the cascade default.
- AFX endpoint paths documented as `/api/afx/...` — actual mount is `/api/arc-flash/afx/...` (index.ts:1361). Integrators get 404s.
- Port 3002 described as Express default — `index.ts` defaults to 3001; 3002 is only the live droplet override. Unexplained contradiction with DEPLOY_RUNBOOK.

### P1 — DEPLOY_RUNBOOK.md: describes wrong production topology
- Written for Caddy + `vite preview :5173`. Live system is nginx + static build at `/var/www/servicecycle/html` deployed via `deploy_client`.
- Missing: §Rollback (referenced by ENGINEERING_HANDOFF), §Disaster Recovery (referenced by SOC2 CC9.1), GitHub Actions auto-deploy (merged PR → live).

### P2 — Test count claims everywhere are stale
- All docs say "~500 tests" or "~450 tests." Actual: ~1,416 callsites across 164 files. Undersells by 3x.
- `README.md`: `npm test -- --grep parts` doesn't work (jest uses `-t`, not `--grep`).

---

## SCAN 3 — Auth Surface & Tenant Isolation

### CRITICAL — disasterEvents.ts regional GET has no accountId scope
- File: `server/routes/disasterEvents.ts` line ~133
- `disasterEvent.findMany({ where: { resolvedAt: null } })` — no `accountId` filter.
- The cross-tenant filter only runs `if (hasSites)`. An account with zero sites receives every tenant's manual emergency declarations (title, region, affectedStates, raw `affectedSiteIds`).

### CRITICAL — extractionTelemetry.ts: cross-tenant write
- File: `server/lib/extractionTelemetry.ts` line ~139
- `extractionEvent.update({ where: { id: clientSuppliedExtractionId } })` — no `accountId` in where clause.
- A valid foreign ID from another tenant succeeds, overwriting `committedAt`/`corrections` JSON.
- Fix: change to `updateMany({ where: { id, accountId } })`.

### CRITICAL — oemTargetAccount.ts: null partnerOrgId bypasses fleet check
- File: `server/lib/oemTargetAccount.ts` line ~27
- When `partnerOrgId = null`, `resolveTargetAccount` skips fleet-membership check and accepts any `accountId`.
- Any `oem_admin` with no partner org can commit assets/WOs/deficiencies into arbitrary tenants.
- Fix: require non-null `partnerOrgId` to use `targetAccountId`.

### HIGH — Missing ownership checks on FK writes
- `arcFlashIncidents.ts PATCH /:id`: `siteId`/`assetId` accepted without ownership check (POST validates both; PATCH doesn't).
- `documents.ts POST /link`: client `workOrderId` written without verification (sibling `/upload` verifies it).
- `arcFlashIngest.ts POST /devices`: `ingestBusId` written without ownership check.
- `arcFlashIngest.ts POST /device-tests`: `systemStudyAssetId` written without ownership check.

### MEDIUM — Role enforcement gaps
- `arcFlashIngest.ts` fleet/report/audit-bundle/export endpoints: no role middleware; viewer/consultant can pull risk rollups and full model CSV.
- `fieldRoutes.ts`: `consultant` role passes account-wide and can complete WOs, log deficiencies, create ProtectiveDevice rows (supposed to be read-only).
- `assetPhotoInspect.ts POST /photo-inspect`: no `requireManager`; viewer can persist a photo + create Document.
- `disasterEvents.ts POST /scan`: comment says "admin only" but gate is `requireManager`.
- `ssoScim.ts`: SCIM event matching a local admin sets `ssoManaged: true` unconditionally — a misconfigured IdP can lock break-glass accounts out of password login.

---

## SCAN 4 — Activity Log Coverage

### P0 — Full account export not logged
- `GET /api/export/account` — exports entire tenant (sites, assets, WOs, deficiencies, doc metadata, quote requests) with **no `writeLog` call** anywhere in `routes/export.ts` or `lib/accountExport.ts`.
- A manager can exfiltrate the full account with zero audit trail.
- `user_data_exported` IS logged for the much smaller per-user GDPR export. Parity gap.

### P0 — Arc-flash label PDF generation not logged
- `GET /asset/:assetId/label.pdf` and `GET /labels.pdf` in `arcFlashIngest.ts` — no `writeLog` anywhere.
- This is a NFPA 70E §130.5(H) safety document that gets physically posted on equipment. No record of who generated/printed which label when.

### P1 — User invite send + accept not logged
- `POST /api/users/invite` — creates `UserInvite` + sends email; no log entry.
- `POST /api/auth/invite/:token/accept` — creates new user (including consultants with cross-account `consultantAccess`); no `user_created` log (only direct-create users are logged).

### P1 — `document_uploaded` action is orphaned
- `document_uploaded` exists in the vocabulary (`activityLog.ts:9`) and `ACTION_LABELS` (`activity.ts:67`) but nothing writes it. Document uploads are silent; access and delete are logged.

### P2 — CEF severity under-classification
- The following security-critical events default to sev 3 (not in `CEF_SEVERITY`): `user_role_changed`, `api_key_created/revoked`, `sso_connection_created/deleted`, `sso_required_changed`, `refresh_token_revoked_reuse_detected` (token theft indicator), `sso_break_glass_login`, `2fa_disabled`, `user_erased`.
- They ARE logged; a SIEM triaging on severity will bury them.

### P2 — Partial logging gaps
- Self password change logs success only; a wrong `currentPassword` attempt on an authenticated session is unlogged (credential stuffing signal).
- Work order `IN_PROGRESS` transition unlogged (COMPLETE and CANCELLED are).
- `WORK_ORDER_DATE_AMENDED` uses inconsistent SCREAMING_CASE (rest is snake_case), missing from `ACTION_LABELS` and `CEF_SEVERITY`.

---

## SCAN 5 — Demo Script Accuracy

### P0 — Viewer/consultant passwords wrong in script
- Script claims "manager@ / viewer@ / consultant@demo.local — same password."
- Seed (`seed-demo.js:458-463`) hashes `Manager1234!`, `Viewer1234!`, `Consultant1234!` respectively.
- A live demo saying "same password" then failing to log in kills the room.

### P0 — 2:30 "create work order from deficiency" doesn't exist
- Script: "open the deficiency → create a work order → assign it."
- `DeficienciesPage.jsx` offers only Resolve / Reopen / View-linked-WO. No "create WO from deficiency" button anywhere. Server only supports attaching a deficiency to an *existing* WO.
- `DEMO_FIXES.md` still lists this as open. The centerpiece workflow beat cannot be performed as scripted.
- Workaround: create WO from Work Orders page or asset task, then link finding — update script to match.

### P0 — 4:00 partner view has no credentials in script
- `/fleet` is gated to `oem_admin`; `admin@demo.local` is role `admin` on Meridian.
- Required login: `sam.carter@apexpower.demo` / `Demo1234!` (seedContractorBook lines 26, 43).
- Not in the script; un-rehearsed this beat dead-ends.

### P1 — "Numbers computed" phrasing overstates SC's role
- Phrasing "every number here is computed" — SC stores PE-stamped study results; it does not compute IEEE 1584 server-side by design (see PPE liability posture).
- Safer: "PE-stamped and version-controlled."

### AT-RISK — Seed date drift
- Overdue/due-in-30/expiry dates are relative to seed time. Numbers stay coherent only near the last reseed.
- Reseed immediately before any high-stakes showing.

---

## SCAN 6 — Seed Data Coherence

### P0 — No field_tech demo user
- Demo users: admin/manager/viewer/consultant + contractor oem_admin (Sam Carter).
- Zero `field_tech` login exists, despite field-capture being a shipped feature.

### P1 — "Thanksgiving" blackout window in August
- `BlackoutWindow` reason is static text "Annual Thanksgiving production shutdown" but `startDate = now + 45d`.
- Reseeded today (July 3), that's mid-August. WO #5 notes reference the same window.
- Fix: change to "Annual production shutdown" or compute the text based on the relative date.

### P1 — def5 linked to a future work order
- Deficiency def5 (created −365d) has `workOrderId: wo5.id` where WO #5 is the *scheduled* job at +46 days.
- A deficiency "from" a work order that hasn't happened yet is incoherent.
- Almost certainly meant to be WO #10. Fix: repoint `workOrderId`.

### P1 — 3 schedule/WO date mismatches
- `SWGR-2M:SWGR_INSULATION_RES`: schedule `lastCompletedDate` = ~94d ago; latest COMPLETE WO #16 = 600d ago. Visible discrepancy on AssetDetail.
- `T-E1:XFMR_DGA`: schedule says ~283d ago vs WO #8 at 200d (~83d apart).
- `SWGR-1A-2:SWGR_IR_THERMO`: schedule says ~338d ago vs WO #12 at 210d (~128d apart).
- Fix: align `dueIn` values so `lastCompletedDate = now - (interval - dueIn)` matches WO dates.

### P2 — Static quote request dates
- QuoteRequest #1: "Weekend of July 12th / Available July 12-13" — looks live today but stale most of the year.
- Fix: make relative to now or drop the specific date from the text.

---

## Prioritized Fix List

| # | Priority | Area | Fix |
|---|----------|------|-----|
| 1 | **P0** | Demo Script | Correct viewer/consultant passwords in script |
| 2 | **P0** | Demo Script | Rewrite 2:30 beat — deficiency→WO flow as workaround |
| 3 | **P0** | Demo Script | Add partner view credentials (sam.carter@apexpower.demo / Demo1234!) |
| 4 | **P0** | Activity Log | Add `writeLog` to `GET /api/export/account` |
| 5 | **P0** | Activity Log | Add `writeLog` to arc-flash label PDF generation |
| 6 | **P0** | Seed | Add field_tech demo user (e.g., `tech@meridian.demo` / `Tech1234!`) |
| 7 | **P0** | Auth | Fix `disasterEvents.ts` regional GET — add `accountId` to where clause |
| 8 | **P0** | Auth | Fix `extractionTelemetry.ts` — `updateMany({ where: { id, accountId } })` |
| 9 | **P1** | Auth | Require non-null `partnerOrgId` in `oemTargetAccount.ts` |
| 10 | **P1** | SOC2 | Fix CC5.3: either wire integration suite into CI or reword |
| 11 | **P1** | Docs | Rewrite encryption hierarchy paragraph in ENGINEERING_HANDOFF.md |
| 12 | **P1** | Docs | Qualify S3 backup claim — verify actual `BACKUP_DEST` on droplet |
| 13 | **P1** | OpenAPI | Fix deficiency severity enum (`IMMEDIATE/RECOMMENDED/ADVISORY`) |
| 14 | **P1** | OpenAPI | Fix arc-flash devices body schema + response envelope |
| 15 | **P1** | Seed | Fix "Thanksgiving" text → "Annual production shutdown" |
| 16 | **P1** | Seed | Repoint def5 workOrderId → wo10 |
| 17 | **P1** | Seed | Align 3 schedule lastCompletedDate values to match WO dates |
| 18 | **P2** | Docs | Update DEPLOY_RUNBOOK for nginx topology + add Rollback section |
| 19 | **P2** | Docs | Fix ARCHITECTURE.md email row (Brevo vs Resend), AFX paths, AI cascade |
| 20 | **P2** | Activity Log | Log invite send + accept, add CEF severity to security-critical actions |
