# Deep tenant-security + audience-correctness audit — 2026-06-20 (overnight #2)

Mandate: hard scan of cross-tenant isolation, route auth/role gating, and the
contractor-vs-customer audience split. Method: full static route inventory +
per-route prisma query sweep + a focused subagent security review + new dynamic
integration tests. Everything kept green (tsc + 333-test suite + client build);
fixes deployed via the MCP loop. **Headline: 3 real HIGH cross-tenant holes
found and fixed; everything else came back clean.**

## Fixed + deployed (commit ae73909, server rebuilt)

**HIGH 1 — partner could steal another partner's customer.**
`POST /api/fleet/accounts/:id/link` updated `partnerOrgId` on any account by URL
id with no claim check — an oem_admin could pull a *different* contractor's
customer (and all their asset/deficiency/work-order data) into their own fleet.
Fix: 409 unless the target is unlinked or already in the caller's org. (Not
UI-exposed, so zero UX risk.)

**HIGH 2 — cross-partner rep reassignment.**
`PATCH /api/fleet/accounts/:id/assign-rep` updated any account by URL id; it
validated the rep but not that the *account* belonged to the caller's partner
org. Fix: 404 if the target account isn't in the caller's org. (The UI only
calls this for accounts already in the fleet, so legit use is unaffected.)

**HIGH 3 — unauthenticated invite-accept trusted a client userId.**
`POST /api/invite/accept` (mounted with NO auth) linked whatever `body.userId`
was supplied to the invite's partner org — anyone holding a leaked invite token
could attach an arbitrary victim's account. Fix: requires authentication, links
ONLY the caller's own account (never a body userId), and enforces that the
logged-in user's email matches the invited email. NOTE: the old flow was already
broken (the client never sent `userId`, so it always 400'd), so this is a net fix
with no working-feature regression. **Behavior change to be aware of:** accepting
an invite now requires the invitee to be **logged in as the invited email**. The
public invite page still loads the preview unauthenticated; only the final accept
needs a session. If you want a smoother flow, the page could route to login first
and return to the invite — flagging as a small UX follow-up, not a blocker.

**MED — defense-in-depth.** `GET /api/assets/:id/activity` now scopes the
activity-log queries by `accountId` (previously relied solely on the ownership
precheck).

New regression tests: `tenantSecurityFixes.test.ts` (all three above),
`authBoundaryNewRoutes.test.ts` (every new endpoint → 401 without a token),
updated `partnerInvites.test.ts` to the new accept contract.

## Came back clean (verified)
- **IDOR sweep across every route file:** documents (file download), compliance
  (snapshot download, asset-evidence, all new report endpoints), proposals
  (cross-account correctly gated to oem_admin + same partner org), quote-requests,
  access-blockers, work-orders, deficiencies, sites, schedules, audits, users,
  share-links, backup, settings, disaster-events — all account-scoped; per-id
  routes do same-account ownership checks.
- **Contractor↔customer wall:** `/api/fleet/*` incl. portfolio-rank are
  oem_admin-only (403 for customers); proposal $ is redacted for customer callers
  and the priced PDF is contractor-only; partner inbox/events are partner-scoped;
  the customer digest and public share links carry no contractor-only data
  (costs, rankings, other customers). Covered by existing + new tests.
- **Public/unauth surfaces:** `/api/inbound` (Svix HMAC + constant-time compare +
  slug + rate limit), `/api/public/share/:token` (high-entropy token, expiry/
  revoke, single-account), `/api/public/parse-report` (no tenant data, email-gated,
  rate-limited), `/api/early-access` (write-only lead capture), `/api/errors`
  (write-only telemetry), `/api/help` (static), `/api/setup` (self-closes once
  initialized) — all clean. Only the invite POST (HIGH 3) was a real hole.
- **Auth boundary:** every authenticated mount rejects missing tokens with 401
  (new auth-boundary test); token epoch/revocation already covered.

## Audience / access matrix (summary)
- **Customer (admin/manager/viewer):** dashboard, compliance + all new report
  cards (maturity, debt ledger w/ $ — their own budget, change brief, evidence
  trace, drift), assets/sites/work-orders/deficiencies/schedules, customer digest,
  proposals (COST-REDACTED) + "request a quote" CTA, access blockers, share-link
  creation. Tenant-scoped to their own account.
- **Contractor (oem_admin):** all of `/api/fleet/*` (dashboard, path-to-100,
  portfolio-rank, forecast, inbox, invites, rep assignment), proposals WITH costs
  + priced PDF (own account or a customer in their partner org). Walled from other
  partner orgs.
- **Public (no auth):** invite preview, share-link view (token), inbound webhook
  (HMAC), public parse (no tenant data), early-access, error telemetry, setup
  (pre-init only).

## Flagged for you (judgment calls, not changed)
- **Invite-accept now needs login** (see HIGH 3) — confirm that's the UX you want,
  or I can add a login-then-return redirect on the invite page.
- **`/link` of a genuinely *unlinked* account** is still allowed for any
  oem_admin (the intended "direct link without invite" convenience). That silently
  grants the contractor visibility into that customer with no customer consent
  step — if you'd rather require an accepted invite for ALL links, say so and I'll
  tighten it.
- **Droplet disk at 75%** (from the earlier health scan) still stands.

Net: the multi-tenant boundary is solid after tonight — the three ways one tenant
could reach another's data are closed and regression-tested, and the
contractor/customer split lands as intended on every surface.
