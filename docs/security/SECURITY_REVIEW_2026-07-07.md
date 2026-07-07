# Security Review — 2026-07-07 (overnight session)

**Scope:** manual code review (the `security-review` skill requires the repo inside the bash sandbox, which this session avoided per the standing note that the sandbox's mount corrupts reads/writes for this repo — see `feedback_docker_compose5_security_opt`-style process notes in memory). Reviewed by reading current file state + `git show --stat` diffs directly via the Windows-side checkout.

**Focus (per the overnight prompt):**
1. The partner-webhook signing unification (`621798e`, 2026-07-06)
2. The field_tech scoped document-annotation endpoints (`e26354c`, 2026-07-06)
3. Tonight's own Tier 1–3 cron fixes that touch auth, tokens, or webhook delivery

**Verdict: no Critical or High findings.** Two Low/cleanup items noted below for Dustin; nothing fixed speculatively per the session's own scoping rule (fix Critical/High only, log Medium/Low).

---

## 1. Partner-webhook signing unification (`621798e`)

Reviewed: `lib/webhook.ts` (SSRF guard, `signPayload`, `postJsonToValidatedUrl`), `lib/partnerEvents.ts` (`firePartnerWebhook`), `lib/partnerWebhookRetry.ts` (`runWebhookRetryCron`), `routes/fleetDashboard.ts` (`POST /settings/webhook-test`).

- **SSRF hardening is solid and consistently applied.** `validateWebhookUrl()` requires HTTPS, rejects credentials-in-URL, blocks RFC1918/loopback/link-local/CGNAT ranges post-DNS-resolution (checking *every* resolved address, not just the first), and pre-DNS-denylists known cloud-metadata hostnames (`metadata.google.internal`, `metadata.azure.com`, etc.) so a hostile custom resolver can't return a non-private alias. `postJsonToValidatedUrl()` / `postOnce()` pin the outbound socket to the already-vetted IPs via a custom `lookup` function, closing the DNS-rebind TOCTOU window between validation and connect. No redirects followed (`3xx` treated as a hard failure, not chased).
- **`POST /settings/webhook-test` is not an SSRF oracle.** It never takes a user-supplied URL — `getCallerPartnerOrgId(req.user.accountId)` derives the partner org from the caller's own account, and the webhook target is always the org's own stored `webhookUrl`. The whole router is gated by `requireOemAdmin` (confirmed via `router.use(...)` near the top of the file), so a non-OEM-admin can't reach it at all.
- **Signing is now consistent across all three call sites** (`firePartnerWebhook`, `runWebhookRetryCron`, the webhook-test route): all sign over `<timestamp>.<body>` via the shared `signPayload()`, all send the same three headers (`X-ServiceCycle-Signature` / `-Timestamp` / `-Delivery-Id`). Confirmed via `grep` that every live call site in the codebase now passes the full 3-argument form.
- **Low / cleanup:** `signPayload(body, timestampOrSecret, maybeSecret)` still carries a backward-compatible 2-argument code path (`body, secret` with no timestamp → signs body alone, no replay protection) for "older callers." A full-codebase grep found **zero remaining callers** using that 2-arg form — every real call site already passes `(body, timestamp, secret)`. The dead branch isn't itself exploitable (nothing invokes it), but it's an attractive nuisance: a future contributor copying an old code sample could reintroduce the unsigned-timestamp shape. Recommend removing the 2-arg fallback in a future pass once confirmed no external script/tool still calls it that way.

## 2. Field_tech scoped document annotations (`e26354c`)

Reviewed: `routes/fieldRoutes.ts` (`resolveScopedWorkOrder`, `resolveScopedWorkOrderDocument`, the new `GET`/`POST /work-orders/:id/documents/:documentId/annotations`), `lib/documentAnnotations.ts` (`validatePinShapes`), `lib/fieldRoleScope.ts`.

- **Tenancy + assignment scoping is correctly enforced end-to-end.** `resolveScopedWorkOrder(user, workOrderId)` filters on `accountId: user.accountId` always, and additionally on `assignedUserId: user.id` when `user.role === 'field_tech'` — a tech cannot reach a work order assigned to a colleague, and no role can cross accounts. `resolveScopedWorkOrderDocument` layers the document lookup on top with `accountId` AND `workOrderId` both required to match the already-scoped work order, so a document belonging to a different work order (even in the same account) 404s rather than leaking.
- **Input validation is bounded.** `validatePinShapes` caps array length (50), rejects non-`"pin"` shape types (arrow/text reserved for a later pass), and bounds-checks `x`/`y` to `[0,1]` and `text` to 500 chars. No unvalidated field reaches the DB write.
- **The `GET` route has no explicit per-role middleware beyond `req.user`** (only the `POST` uses `requireFieldWriter`). This is **not a new gap** — it mirrors the pre-existing `GET /work-orders/:id/comments` pattern immediately above it in the same file, which was already reviewed and shipped in an earlier session. Any authenticated role can list annotations on a work order they're scoped to reach (via `resolveScopedWorkOrder`'s account/assignment check), which matches this codebase's established "Field Mode" convention (managers browse unscoped, field_tech only their own assignments).
- **`fieldRoleScope.ts`'s default-deny allowlist is unaffected** by this change — the new routes live under the already-allowlisted `/api/field` prefix, so field_tech's broader deny-by-default boundary (no `/api/assets`, `/api/quote-requests`, etc.) still holds.

## 3. Tonight's Tier 1–3 cron fixes touching auth/tokens/webhooks

- `refreshTokenPrune`, `activityLogChainSettle`/`Verify`, `webhookDlqAlarm`/`Prune`, `partnerWebhookRetry` — all were **test-only additions** (new real-Postgres regression-lock tests); no production code changed for these four.
- `renderErrorPrune` (column-name fix) and the `DEMO_ACCOUNT_ID` export fix (`scripts/seed-demo.js`) are narrow, mechanical corrections (wrong field name; missing export) with no new attack surface — reviewed as part of writing them, no auth/tenancy implication.
- `serviceOpportunityTrigger`'s extraction to `lib/serviceOpportunityTrigger.ts` was a verbatim code move (confirmed via diff review) — no logic, auth, or query-shape change.

No findings in this category.

## Methodology note

This review was code-reading + `git show`/`grep`-assisted, not tool-assisted static analysis (the `security-review` skill's automated diff/scan tooling requires a bash-sandbox-mounted repo, unavailable here per this repo's standing git-corruption note). For a future session with bash-sandbox access to a clean clone, re-running the automated skill against the last 48h of commits would be a useful complement to this manual pass — it may catch dependency/pattern-based issues a manual read misses.
