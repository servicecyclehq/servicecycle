# QR-Code Public Intake Audit — Can an Anonymous User Create a Work Order / Quote Request?

**Date:** 2026-07-05
**Scope:** Documentation/verification only. No source files were modified. No git commands were run.
**Question:** Can a non-authenticated user land on a QR-code deep-link URL, submit a photo + text description, and have that submission become a Work Order or a Quote Request — without ever logging in?

---

## What was checked

| File | What it contains |
|---|---|
| `server/routes/assetLabels.ts` (lines 1–40, 280–300) | QR label PDF generator — this is where the QR code image is actually produced and what URL it encodes |
| `server/index.ts` (route-mount section, ~lines 1000–1580) | Master list of `app.use(...)` route mounts, showing which middleware wraps which route prefix |
| `server/middleware/auth.ts` (lines 1–189) | `authenticateToken` / `optionalAuthenticateToken` definitions (JWT verification via `verifyToken`) |
| `server/routes/quoteRequests.ts` (lines 1–60, 219–532) | `/api/quote-requests` route handlers + role gate (`requireQuoteWriter = requireRole(['admin','manager','viewer'])`) |
| `server/routes/deficiencies.ts` (lines 1–50, 96–130, 166–335) | `/api/deficiencies` route handlers + role gate (`requireManager` on all writes) |
| `server/routes/fieldRoutes.ts` | `/api/field/*` handlers (Field Mode "My Day" + asset card data) |
| `client/src/App.jsx` (lines ~176–334) | React Router config: lazy imports of Field Mode pages, and the `<Route path="/field">` tree wrapped in `<ProtectedRoute>` |
| `client/src/components/ProtectedRoute.jsx` (full file, 44 lines) | Client-side auth gate: redirects to `/login` when `!loading && !user` |
| `client/src/pages/field/FieldAsset.jsx` (relevant excerpts ~lines 400–1080) | The actual field-card page — photo-inspect AI feature, "Report deficiency" form (severity + description), submission code |
| `server/routes/arcFlashLabelPublic.ts`, `shareLinkPublic.ts`, `publicParse.ts` | The codebase's *actual* no-auth-required routes, used as a contrast/control group |

---

## What was found

### 1. Where the QR code comes from and what it encodes

`server/routes/assetLabels.ts` generates a printable PDF sheet of QR labels for equipment stickers. Header comment and code:

```
* GET / streams a US-Letter PDF laid out as a 3 × 8 grid of equipment labels
*   - a QR code (left) encoding the ABSOLUTE field-card url
*     `${CLIENT_URL}/field/asset/<assetId>` — scanning the sticker on the
*     switchgear lands the tech straight on the asset's field card
...
* Read-only — any authenticated role can print labels. Mounted behind
* authenticateToken in index.ts...
```

```js
const clientBase = String(process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/+$/, '');
...
QRCode.toBuffer(`${clientBase}/field/asset/${a.id}`, { ... });
```

So the QR code encodes a **plain URL with a raw asset UUID** — `https://<client>/field/asset/<uuid>` — not a signed or time-limited token.

The label-generation route itself (`/api/assets/labels`) is mounted at `server/index.ts:1339`:
```js
app.use('/api/assets/labels',   authenticateToken, assetLabelRoutes);
```
so only a logged-in user can even print the sticker sheet in the first place.

### 2. What happens when the encoded URL is scanned

The QR-encoded URL is a **client-side** route, `/field/asset/:id`. In `client/src/App.jsx`:

```jsx
{/* Field Mode — authenticated but OUTSIDE the desktop Layout shell.
    FieldLayout provides its own slim phone chrome (no sidebar). */}
<Route
  path="/field"
  element={
    <ProtectedRoute>
      <FieldLayout />
    </ProtectedRoute>
  }
>
  <Route index element={<FieldHomeByRole />} />
  <Route path="scan" element={<FieldScan />} />
  <Route path="new" element={<FieldNewAsset />} />
  <Route path="batch" element={<FieldBatchNameplate />} />
  <Route path="asset/:id" element={<FieldAssetByRole />} />
</Route>
```

The **entire `/field` subtree**, including `asset/:id` (the exact page the QR code points at), is wrapped in a single `<ProtectedRoute>`. `ProtectedRoute.jsx`:

```jsx
export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (!loading && !user) {
    return <Navigate to="/login" replace />;
  }
  return children;
}
```

A visitor with no session token gets `user === null`, and once the (async) auth probe resolves, is redirected to `/login`. `FieldAsset.jsx` (the component with the photo-inspect UI and the "Report deficiency" form) never mounts for that visitor.

### 3. Backend confirms the same gate independently

Even if the client-side check were somehow bypassed (e.g., calling the API directly), the server enforces the same boundary. From `server/index.ts`:

```js
app.use('/api/field',           authenticateToken, fieldRoutes);
...
app.use('/api/assets',          authenticateToken, assetRoutes);
...
app.use('/api/deficiencies',    authenticateToken, deficiencyRoutes);
...
app.use('/api/quote-requests',  authenticateToken, quoteRequestRoutes);
```

`authenticateToken` (`server/middleware/auth.ts`) requires and verifies a JWT (`verifyToken`) before `req.user` is populated and `next()` is called; an unauthenticated request gets rejected before reaching any handler.

### 4. Role gates on top of authentication (defense in depth)

Even a **logged-in but wrong-role** user cannot hit these two specific creation paths:

- `server/routes/quoteRequests.ts:39`: `const requireQuoteWriter = requireRole(['admin', 'manager', 'viewer']);` — applied to `POST /` (create quote request, line 314) and `POST /:id/send` (line 498). The file's own header comment states: *"field_tech is already denied upstream at the auth chokepoint (fieldRoleScope)."* So the role that a field worker who scanned a QR sticker would actually be logged in as (`field_tech`) is explicitly excluded from creating quote requests.
- `server/routes/deficiencies.ts:97`: `router.post('/', requireManager, ...)` — deficiency creation (the closest thing to a "field-reported issue becomes a ticket" flow, with `assetId` + `description` required per lines 102–108) requires the `manager` role, stricter than viewer.

### 5. What the field-card page actually lets a *logged-in* user submit

`FieldAsset.jsx` (reached only after authentication) has:
- A photo-inspect AI feature (`POST /api/assets/photo-inspect`, gated further by a feature flag `maintenance_brief` + AI-consent dialog + online-only).
- A "Report deficiency" form: severity buttons + free-text description, body `{ assetId: id, severity: defSeverity, description: defDesc.trim() }` (line 710) — this is the photo+description-shaped submission the audit was looking for, and it creates a **Deficiency**, not directly a WorkOrder or QuoteRequest.

Work Orders are not created from this page at all. Per the `quoteRequests.ts` header comment, the QuoteRequest lifecycle is `requested → quoted → accepted | declined`, and a WorkOrder is a separate downstream artifact created only when a manager/admin accepts an already-existing, already-authenticated QuoteRequest — never a direct, automatic output of field/QR input.

### 6. Contrast group — the codebase's actual public routes

To confirm the pattern isn't "public by omission," three routes in the codebase are deliberately public and follow a different, token-based design:
- `server/routes/shareLinkPublic.ts` — `/api/public/share/:token` (read-only, random token)
- `server/routes/arcFlashLabelPublic.ts` — `/api/public/arc-flash-label/:token` (read-only, random token)
- `server/routes/publicParse.ts` — `/api/public/parse-report` (creates only a `PublicParseLead` marketing row, not a WorkOrder/QuoteRequest/Deficiency)

None of these three are QR-linked, and none touch WorkOrder, QuoteRequest, or Deficiency models. This confirms the asset-QR path (raw UUID, full auth) is architecturally distinct from the app's intentional public surface (random token, read-only or lead-capture-only).

---

## Answer

**No.** An anonymous, non-authenticated user cannot create a Work Order or a Quote Request via QR scan, on the current codebase, by any observed path.

Both halves of the chain agree with each other — there is no gap between "client renders a public form" and "server would reject it anyway," and no gap in the other direction either (no unprotected backend route sitting unlinked):

1. **Client gate:** the QR-encoded URL (`/field/asset/:id`) sits entirely inside `<ProtectedRoute>` in `App.jsx`; an unauthenticated visitor is redirected to `/login` before `FieldAsset.jsx` (the page with the photo + description form) ever renders.
2. **Server gate:** `/api/field`, `/api/assets`, `/api/deficiencies`, and `/api/quote-requests` are all mounted behind `authenticateToken` in `server/index.ts`; a direct API call without a valid JWT gets rejected before any handler runs.
3. **Role gate (belt-and-suspenders):** even a logged-in user needs `manager` to create a Deficiency, and `admin`/`manager`/`viewer` (explicitly excluding `field_tech`) to create/send a QuoteRequest. WorkOrders are never a direct product of this flow — they're created later, by a manager, from an already-authenticated, already-existing QuoteRequest.

What's missing for a "yes" to be possible: someone would have to (a) remove `authenticateToken` from the `/api/field`, `/api/deficiencies`, or `/api/quote-requests` mounts in `server/index.ts`, AND (b) remove or bypass the `<ProtectedRoute>` wrapper around `/field` in `App.jsx` (or hit the API directly), AND (c) loosen the `requireManager` / `requireQuoteWriter` role checks. None of these conditions hold today.

---

## Risk callouts

- **No dedicated rate limiter on `/api/field`, `/api/deficiencies`, or `/api/quote-requests` specifically.** A global `apiLimiter` appears to cover `/api/` broadly (referenced near `server/index.ts:747`), and a separate `publicParseLimiter` exists for the one genuinely public lead-capture route — but there's no bespoke, tighter limiter on the field/deficiency/quote paths. Low urgency today since these routes require auth first, but worth a look if the auth requirement is ever relaxed.
- **No captcha/honeypot on the genuinely public routes** (`shareLinkPublic`, `arcFlashLabelPublic`, `publicParse`). Blast radius there is limited to fake marketing leads (`PublicParseLead` rows) or token-guessing against read-only share links, not fabricated work orders — acceptable risk today, but flag if `publicParse.ts` output is ever wired to anything more consequential.
- **QR-encoded URL uses a raw asset UUID, not a signed/expiring token**, unlike the app's two other genuinely-public link types (`shareLinkPublic.ts`, `arcFlashLabelPublic.ts`), which correctly use random tokens. This is a **defense-in-depth gap, not a current vulnerability**: today the route requires login regardless of whether the UUID is guessed, so UUID enumeration buys an attacker nothing. But if `authenticateToken` were ever accidentally dropped from `/api/field` or the `<ProtectedRoute>` wrapper were ever removed from `/field` in a future refactor, the raw UUID would offer zero enumeration protection (sequential/guessable asset IDs could be walked). Recommend treating "QR sticker URLs use unsigned raw IDs" as a standing item to re-verify any time the field-mode auth wrapping is touched.
- **File upload validation asymmetry:** the one route confirmed to do server-side MIME + extension checks and a size cap (10MB) is `publicParse.ts`'s multer config — the more defensible pattern for a public-facing upload. The photo-inspect path on the (currently auth-gated) `FieldAsset.jsx` page showed only client-side MIME checks in the reviewed excerpts (line 524: `'Unsupported image type — use a JPEG, PNG, or WebP photo.'`); this audit did not confirm equivalent server-side validation on `POST /api/assets/photo-inspect` itself. Since that endpoint is currently behind `authenticateToken`, the exposure is limited to authenticated abuse today — but client-side-only checks are trivially bypassed by any authenticated caller hitting the API directly, so it's worth a follow-up read of the photo-inspect handler's multer/file-type config specifically.
