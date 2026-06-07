# STATUS: COMPLETE — 2026-05-02 (session 4 + remediation pass)

UX-review bigger-bet bucket closed in session 4. A subsequent Opus
review caught a handful of real defects in the session 4 work; those
fixes are bundled in this same wrap. Twelve commits pushed total
(eight session 4 features/scaffolds, one remediation, two doc wraps,
plus this NEXT_SESSION rewrite).

## What landed in session 4

### UX bigger-bet bucket
- `bde8541` — auto-save New Contract draft hardening (user-scoped key,
  1s debounce replacing the 5s setInterval, save-on-unmount via
  useRef/submittedRef, Cancel no-longer-discards, Discard requires
  confirm, "Saved Xm ago" indicator).
- `576c0ce` — Budget Forecast bulk-edit + global Save bar +
  per-vendor uplift propagation correctness fix.
- `a53f35e` — Vendor list polish (Co-term tooltip on header + badge,
  complexity filter, server-side `lastContactedAt = max(communications,
  vendor_contacts.lastContactedAt)`, filtered subtitle).

### Pre-existing defects surfaced during smoke testing
- `5ea014b` — zod schema accepts blank numeric fields and seed UUIDs.
  `NumLike`/`IntLike`/`DateLike` wrapped in `z.preprocess(emptyToUndef,
  ...)`; new format-only `UuidStr` helper in `lib/validate.js`. Three
  call sites in `routes/contracts.js` swapped over.

### Sprint 6 prep
- `be477ec` — Stripe billing seam. Migration
  `20260502190000_add_stripe_subscription_fields` (3 columns on
  Account: `stripeSubscriptionId`, `stripeSubscriptionStatus`,
  `stripeCurrentPeriodEnd`). New `lib/stripe.js`,
  `middleware/requireTier.js`, `.env.example` Stripe section,
  `docs/stripe-integration.md` with a 10-step integration checklist.

### Demo deployment + recording artifacts
- `36c6ae8` — `deploy/Caddyfile.demo` (preferred, auto-TLS),
  `deploy/nginx.demo.conf` (alternative), `docker-compose.demo.yml`
  override (DEMO_MODE=true, NODE_ENV=production, TRUST_PROXY=true,
  ports bound to 127.0.0.1 only), `docs/demo-deploy.md` runbook,
  `docs/demo-recording-script.md` 90-second storyboard.

### Doc wraps
- `bdb1338` — bigger-bet bucket closed in ROADMAP + ux-review.
- `d343c3a` — session 4 follow-up wrap.

## Opus review remediation

A three-agent Opus pass after the feature work caught:

- **`requireTier` landmine**: `req.user.account` was never populated
  by `middleware/auth.js`. Fix: `requireTier` now lazy-fetches the
  billing-relevant Account columns on demand (one indexed lookup per
  gated request, paid only on opted-in routes).
- **`docker-compose.demo.yml` port-list collision**: Compose merges
  `ports` arrays additively. Without an override directive the demo's
  `127.0.0.1:3001` binding stacked alongside the base's `0.0.0.0:3001`,
  silently exposing the demo backend publicly. Fix: `ports: !override`
  on both services in the demo file.
- **Base `docker-compose.yml` env passthrough**: TRUST_PROXY and the
  full STRIPE_*/STORAGE_*/BACKUP_*/AI_*/retention vars now flow from
  the host `.env` into the server container.
- **Stripe-not-in-package.json drift**: stripe `^22.1.0` is already
  in `server/package.json`. Comment + error message in `lib/stripe.js`
  and step 1 in `docs/stripe-integration.md` corrected.
- **`docs/install.md`**: new "Stripe billing" subsection under
  Optional environment + BACKUP_LOG_RETENTION_DAYS reference.
- This file (`server/NEXT_SESSION.md`) brought current.

Medium-severity findings deferred to next session (see
`project_security_gtm.md` Open Follow-Ups):

- `BudgetForecast.saveAllDirty` lost-edit race (clears `rowDirty`
  unconditionally on every row, racing with concurrent edits).
- `NewContract.restoreDraft` doesn't whitelist known form keys —
  stale fields from old drafts pass through `passthrough()` schema.
- Migration directory naming: two early `20260428_*` migrations omit
  the time component and sort lexicographically BEFORE the `_init`
  migration. Fresh `prisma migrate deploy` could fail; existing dev
  DBs are unaffected.
- `isStripeEnabled` returns false silently when `STRIPE_ENABLED=true`
  but no `STRIPE_SECRET_KEY` — should `console.warn` so a
  misconfigured SaaS deploy surfaces faster.

## Smoke

- `node -c` clean on every modified server file.
- `npm run build` from `client/` clean (116 modules, ~1.6s).
- Server boot smoke (PORT=3001) returns 200 on `/api/health`.
- Browser-verified end-to-end: auto-save (5 bullets), Budget bulk-edit
  (select → apply → save-all → reload), Vendor filter, contract
  create with seed UUID + blank numerics.

## Open follow-ups for the NEXT session

Infrastructure / market-signal items only:

- **Provision the demo VPS + DNS** — recipe in `docs/demo-deploy.md`,
  needs a half-day of focused work (mostly waiting for cert issuance).
- **Cut the demo recording** — gated on the URL above. Storyboard in
  `docs/demo-recording-script.md`.
- **Stripe integration session** — gated on first paying-customer
  signal. Checklist in `docs/stripe-integration.md`.
- **Audit medium-severity remediation items** above.
- **Beta outreach** — `Request Early Access` CTA already routes to
  `hello@lapseiq.com`.

Memory files refreshed: `project_security_gtm.md` carries the canonical
technical state; `project_lapseiq.md` and `project_backlog.md` brought
forward through Sprint 5/6.
