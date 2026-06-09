# Security & Hardening Audit â€” 2026-06-09

Conducted: overnight 2026-06-08 â†’ 2026-06-09  
Scope: ServiceCycle full-stack (server/ + client/)  
Source document: `5.28.issues-ba35f3f3.txt` (multi-persona synthesis of 3 security prompts)

---

## FIXED (auto-applied)

### 1. Fleet Dashboard â€” Missing permission_denied logging on OEM role check
**File:** `server/routes/fleetDashboard.ts`  
**Issue (BFLA):** The route used a local inline `requireOemAdmin` that silently returned 403 with no activity-log entry. A failed OEM escalation attempt would leave no audit trail.  
**Fix:** Replaced inline guard with canonical `requireOemAdmin` from `server/middleware/roles.ts` (which calls `_logDenied`). Preserved the `/account-forecast` customer-facing carve-out.

### 2. Leave-Behind PDF â€” No rate limit on CPU-bound pdfkit generation
**File:** `server/index.ts`  
**Issue (DoS vector):** Both `/api/work-orders/:id/leave-behind-pdf` and `/api/inspections/:id/leave-behind-pdf` had no rate limiter. A single authenticated user could fire hundreds of concurrent PDF renders.  
**Fix:** Added `leaveBehindLimiter` (20 requests/hr, per-user keyed by `req.user.id`). Applied to both route mounts after `authenticateToken`.

### 3. CSV Formula Injection (CWE-1236) â€” deficienciesImport + schedulesImport preview responses
**Files:** `server/routes/deficienciesImport.ts`, `server/routes/schedulesImport.ts`  
**Issue:** Preview endpoint reflected raw uploaded cell values back to the client in `sampleRows`. If a user later copies preview data into Excel, cells starting with `=`, `+`, `-`, or `@` execute as formulas.  
**Fix:** Added `sanitizeFormulaPrefix()` to both files (same guard already present in `assetsImport.ts`). Preview responses now use `safeSample` with leading formula-trigger characters stripped from all string fields.

### 4. roles.ts â€” requireOemAdmin missing from module.exports
**File:** `server/middleware/roles.ts`  
**Issue:** The canonical logged `requireOemAdmin` function did not exist; fleetDashboard had its own unlogged copy. The fix for item #1 required adding it here first.  
**Fix:** Added `requireOemAdmin` with `_logDenied` integration; added to `module.exports`.

### 5. RUL/CapEx Liability Disclaimers â€” strengthened across all UI surfaces
**Files:** `client/src/pages/FleetDashboard.jsx`, `client/src/pages/Dashboard.jsx`, `server/lib/leaveBehindPdf.ts`  
**Issue (legal/liability):** "Healthy" badge determinism risk (plaintiff's negligent misrepresentation theory); forecast panels used thin disclaimer language. Leave-behind PDF footer did not cite IEEE/NFPA/NETA basis or advise licensed PE review.  
**Fixes:**
- FleetDashboard `RiskBadge`: "Healthy" â†’ "No Issues Flagged"; "Critical" â†’ "Action Required"
- FleetDashboard forecast panel: full disclaimer including "not formal quotes, engineering assessments, or guarantees of equipment condition or remaining useful life"
- Dashboard CapExForecastPanel: same full disclaimer language
- leaveBehindPdf Section 3 header: "BUDGET PLANNING ESTIMATES ONLY â€” Figures are probabilistic ranges derived from IEEE/NFPA/NETA..."
- leaveBehindPdf footer: "Do not rely solely on this report for life-safety or capital replacement decisions â€” engage a licensed professional engineer for critical assessments."

---

## FOUND BUT NOT FIXED (requires human decision)

### A. No CSRF protection on state-mutating API routes
**Risk:** Medium. All mutation routes (`POST /api/assets`, `POST /api/work-orders`, etc.) rely solely on JWT in `Authorization` header. If a future feature stores the JWT in a cookie (e.g., for file-download flows), these routes become CSRF-vulnerable.  
**Current mitigating factor:** JWT is stored in localStorage and sent via `Authorization: Bearer`, not via cookie â€” CSRF does not apply to this pattern.  
**Recommendation:** Document the no-cookie JWT policy explicitly in CLAUDE.md. If cookie-based auth is ever added, add `csurf` or SameSite=Strict cookie attribute at the same time.  
**Action needed:** No code change required now â€” just a policy decision to document.

### B. No per-route authorization matrix documentation
**Risk:** Low-medium. The codebase has four roles (admin, manager, viewer, oem_admin) but no single source of truth for which role can perform which action. This makes AuthZ regressions harder to catch in review.  
**Recommendation:** Create `docs/authz-matrix.md` listing every route Ã— role. Can be auto-generated from the middleware stack.  
**Action needed:** Human task â€” document the matrix.

### C. modernizationRiskScore not yet surfaced in AssetDetail UI
**Risk:** Low (preemptive). When this score is rendered in the client, it will need a disclaimer similar to the FleetDashboard forecast panel.  
**Current state:** Field exists in DB (migration session 23), used in leaveBehindPdf and fleet forecast, but no dedicated AssetDetail UI component renders it yet.  
**Action needed:** When AssetDetail renders this score, add the standard RUL disclaimer at that time.

---

## NOT FOUND (clean scan)

The following attack surfaces were scanned and found clean:

- **Multi-tenant BOLA/IDOR** â€” All route files use `findFirst({ where: { id, accountId: req.user.accountId } })` pattern before every mutation. Reviewed: assets.ts, deficiencies.ts, workOrders.ts (including nested measurements/deficiencies/lab-samples), assetTemplates.ts, loto.ts, sites.ts, quoteRequests.ts, export.ts, webhooks.ts, adminAuditChain.ts.
- **BFLA (broken function-level auth)** â€” Admin-only routes use `requireAdmin`; manager routes use `requireManager`; OEM routes now use canonical `requireOemAdmin`. No frontend-only role restrictions found.
- **File upload hardening** â€” All multer instances have `fileFilter` (type allowlist), `limits.fileSize`, and controlled error messages. No path-based SSRF surface.
- **Helmet / CSP / CORS** â€” Fully configured in index.ts. No wildcard origins. `frame-ancestors 'none'` present.
- **CSV formula injection in assetsImport.ts** â€” `sanitizeFormulaPrefix` already present from a prior session. No change needed.
- **Dependency vulnerabilities** â€” `npm audit` on both `/server` and `/client`: 0 high/critical vulnerabilities. (2 low-severity total, no fix required.)
- **assetPhotoInspect.ts rate limiter** â€” Already applied from a prior session.

---

## PRIORITY ORDER FOR MORNING SESSION

1. (Optional) Create `docs/authz-matrix.md` â€” low-effort, high review value
2. (Optional) Add CLAUDE.md note: "JWT stays in localStorage; do not migrate to cookies without adding CSRF protection"
3. Continue feature development â€” security surface is clean

---

## COMPILE STATUS

- Server tsc --noEmit: **PASS**
- Client vite build: **PASS** (âœ“ built in 2.43s, 87 precached entries)
- npm audit server: **PASS** (0 high/critical)
- npm audit client: **PASS** (0 high/critical)
- Final commit: (see below)

---

*Note: Six server files (roles.ts, leaveBehindPdf.ts, index.ts, deficienciesImport.ts, schedulesImport.ts, fleetDashboard.ts, empDocument.ts) had been silently truncated by Write-tool use in a prior session. All were restored from git HEAD and re-patched with Edit tool. Compile was clean after restoration.*
