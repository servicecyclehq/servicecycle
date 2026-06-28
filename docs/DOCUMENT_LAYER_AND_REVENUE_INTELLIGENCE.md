# Document Layer & Revenue Intelligence — design & security note

**Status:** shipped (2026-06). **Audience:** engineering handoff / diligence.

Two related surfaces were added on top of the existing `Document` model and the
super_admin platform tier. This note records the design, the security model, and
the deliberate scope boundaries (especially what is *not* built and why).

---

## 1. Revenue Intelligence (`/admin/opportunities`)

A **super_admin-only, read-only, cross-tenant** field-intelligence feed. SC
*detects* condition-driven pull-through opportunities; the acquirer's CRM
*manages* them. There is intentionally no pipeline state (no stages, owners,
forecasting).

- **Server:** `server/routes/adminOpportunities.ts`
  - `GET /api/admin/opportunities` — arc-flash study pipeline (0–100 composite
    score), system-change alerts, no-study / dormant / greenfield accounts, open
    IMMEDIATE deficiencies, summary.
  - `GET|PUT /api/admin/rate-sheet`, `POST /api/admin/rate-sheet/confirm` —
    platform pricing singleton (`RateSheet` model, `rate_sheet` table). Dollar
    estimates only render when the sheet is **fresh** (configured + confirmed
    within `expiresAfterDays`, default 180).
- **Security:** `requireSuperAdmin` on every route; cross-tenant by design (no
  `accountId` filter) — never reachable by a tenant/customer login. Confirm
  action writes a hash-chained `ActivityLog` entry (defensible pricing trail).
- **Client:** `client/src/pages/OpportunitiesPage.jsx` (Revenue → Opportunities,
  super_admin nav only), `components/settings/RateSheetSection.jsx`.
- **Schema:** `Site.oneLineDiagramOnFile` / `oneLineDiagramDate`; `RateSheet`.
  Migration `20260627000000_add_revenue_intelligence_schema`.

## 2. Document layer (storage / surfacing only)

Customer-**uploaded** documents (one-lines, OEM manuals, test reports, LOTO,
etc.) made findable everywhere a tech needs them. **SC stores and extracts data;
it does not author, verify, or generate documents.**

- **Surfaces:** asset detail (`AssetDocumentsCard`), **field mode / QR scan**
  (`pages/field/FieldAsset.jsx` Documents section — the asset QR label lands on
  `/field/asset/:id`), the **Site** page (Documents tab), and an account-wide
  **searchable library** (`pages/DocumentsLibrary.jsx`, top-nav).
- **Server:** `GET /api/documents?q=&docType=&siteId=&assetId=` (library list,
  asset→site joined); `GET /api/field/asset/:assetId/document/:documentId`
  (field-safe scoped download).
- **Security model:**
  - `accountId` is the hard tenant boundary on every document route.
  - Archived assets' documents are excluded from all serve paths (H5).
  - `field_tech` is default-denied on `/api/documents`; their **only** download
    path is the `/api/field/...` route, which re-checks assignment scope
    (`getFieldAssignmentScope`) so a sub can only fetch docs for assets they are
    assigned to. Managers+ are account-wide.
  - Encryption-at-rest (AES-256-GCM) is passed through unchanged
    (`docCrypto.decrypt` on serve when `encrypted`).
- **Accuracy disclaimer (defensible posture):** a single source of truth in
  `client/src/lib/documentDisclaimer.js` (`UPLOAD_DISCLAIMER`,
  `DOWNLOAD_DISCLAIMER`) drives a required acknowledgment at **upload** and an
  **acknowledge-to-download** gate at every download surface. Framing: SC is a
  storage / data-extraction / alerting platform; the customer / their contractors
  / OEMs author the files; SC does not guarantee accuracy or currency.
  *(Final legal wording should be blessed by counsel / a PE.)*

---

## 3. Deliberately NOT built (acquirer upside)

**One-line / single-line diagram auto-generation** — generating an as-built
one-line from the asset graph. Documented in `ACQUISITION_BRIEF.md` →
"What's deferred (acquisition upside)". **Rationale:** a data-generated one-line
relied on for switching / de-energization / LOTO carries professional-engineering
liability that a PE's seal normally absorbs; ServiceCycle (pre-revenue, no PE on
staff) should not assume it pre-acquisition. An acquirer can productize it behind
a PE-in-the-loop review/seal workflow with the insurance posture to match. The
app already auto-builds a power-path one-line *view*
(`GET /api/arc-flash/site/:siteId/one-line`) and stores uploaded engineered
drawings; only the *generated, exportable, relied-upon* drawing is deferred.

## 4. Recommended next steps

1. **Provenance as a first-class field** — distinguish *PE-sealed / engineered*
   vs *as-built / unverified* on the `Document` (badge + "not for switching unless
   sealed" treatment), rather than relying on the disclaimer alone.
2. **`Document.siteId`** (migration) — let a one-line attach at the
   site/substation directly so it surfaces (via an asset↔site union) on every
   asset at that site, not just the one it is pinned to. (Designed; needs
   migration approval.)
3. **Pagination + a trigram/tsvector index** on the library once a tenant's
   document count grows past the current 300-row cap.
4. **Tests** for the new routes (scoring, rate-sheet freshness, field-doc scope,
   library filters) — jest integration tests need a live `:3001` dev server.
