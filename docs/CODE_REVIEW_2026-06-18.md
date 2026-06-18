# Code Review — 2026-06-18 (overnight session)

Read-only review of this session's commits (`39f02ac` email-in ack → `e505e42`
FAQ module → `0d51139` #34 backfill) plus the surrounding recent code. Trivially
safe issues were fixed during the session (noted as **FIXED**); everything else is
queued for Dustin with a priority. P1 = fix soon, P2 = schedule, P3 = nice-to-have.

## Fixed during this session

- **Help Center was wrong-product content.** Every registered help doc except
  `compliance-scoring` was still LapseIQ material (contracts/vendors/renewals),
  and 5 registered slugs had no content file at all (drawer 404s). Rewrote all 12
  grounded in the real code, removed 5 LapseIQ orphans, and made `MODULE_INDEX`
  mirror the sidebar. (commit `89f4b9c`)
- **Latent test-mock bug.** `__tests__/helpers/setup.ts` mocked `lib/email` but
  omitted `reportReceivedHtml`, which `inboundEmail.ts` imports — any test
  exercising the ack path would have thrown `TypeError`. Added it. (`3accc42`)
- **Broken context-Help.** `HelpDrawer.ROUTE_MODULE_MAP` mapped `/calendar` to a
  non-existent `calendar` module, so context-Help on the compliance calendar
  404'd. Remapped to `schedules` and added the data-in routes → `imports`.
  (`63d1ed6`)
- **Security hardening** (see `docs/SECURITY_REVIEW_2026-06-18.md`): backfill
  decompression-bomb guard, inbound webhook rate limiter, inbound attachment
  caps. (`24975a0`)
- **Dependency patches** (see `docs/DEPENDENCY_AUDIT_2026-06-18.md`): form-data
  CRLF, @babel/core file-read. (`3accc42`)

## Queued for Dustin

### P2 — auto-commit blast radius (email-in + #34 backfill)
Both paths run `autoCommit=true`: the worker writes asset cards with no human
review. The auth boundary is sound, but a malformed or hostile-but-authenticated
report creates junk cards an operator must hunt down and delete. There is no
"undo this batch" or per-job confidence floor. Recommend a batch id +
soft-delete, or parking low-confidence parses for review. (Also raised in the
security review as a blast-radius control, not a vuln.)

### P2 — dependency upgrades needing a breaking bump
`js-yaml` 3→4 (server; exposure negligible — only parses our own OpenAPI spec, and
the call site is already 4.x-compatible) and `vite` 6→8 (client; the esbuild
advisory is dev-server-only, not the shipped static build). Both are safe to defer
but should be scheduled. Details in the dependency audit doc.

### P3 — `inboundEmail.fetchResendAttachments` downloads before size-checking
The Resend-attachments fallback does `Buffer.from(await dl.arrayBuffer())` with no
streaming size cap; the new per-attachment cap filters *after* the buffer is
materialized. The source is Resend (trusted) and the inline-attachment path (the
common one) is capped before storage, so risk is low. If hardened, add a
`Content-Length` check / streamed size guard before buffering.

### P3 — `ingestBackfill` job ownership split (OEM cross-account)
For an `oem_admin` targeting a fleet customer, the `IngestJob.accountId` is the
OEM's account while `fileKey`/`targetAccountId` point at the customer account.
This appears intentional (matches the #14 target-account design and the
status-route scoping), but it is subtle and undocumented — worth a one-line
comment so a future reader doesn't "fix" it into an inconsistency.

### P3 — `HelpDrawer` uses `inert={!open ? '' : undefined}`
Works, but React's JSX `inert` handling is version-sensitive (boolean attribute);
`inert={open ? undefined : true}` is clearer and avoids the empty-string idiom.
Cosmetic.

## Reviewed and deliberately NOT changed (not issues)

- **`client/src/api/client.js` `lapseiq_*` sweep** — this is intentional cleanup
  that wipes pre-rebrand localStorage keys on upgraded clients, not scrub residue.
- **Brevo (outbound) vs Resend (inbound) split** — deliberate: Resend's free tier
  (one domain) is consumed by another product line, so outbound goes via Brevo and
  inbound parsing via Resend. Documented in `lib/email.ts`.
- **Mixed CommonJS `require()` / ESM `import`** in route files — established
  convention, internally consistent per file; not worth churning.

## Overall

The recent code has a strong defensive baseline: per-route rate limiters,
constant-time secret comparisons, triple-layered path-traversal guards, fail-open
ack that never blocks ingest, and signature-verified webhooks. The session's new
surfaces (#34 backfill, email-in) follow those patterns. The main forward risk is
not security but **data quality from unreviewed auto-commit** — the P2 above is the
one worth a product decision.
