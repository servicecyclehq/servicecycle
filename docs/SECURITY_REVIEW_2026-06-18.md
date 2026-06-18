# Security Review — 2026-06-18

Scope: this session's new/changed attack surface — the email-in webhook
(`routes/inboundEmail.ts`), the #34 zip backfill (`routes/ingestBackfill.ts`),
the public `/api/help` and public parse endpoints, the storage layer, and
rate-limiter coverage. Severity uses CVSS-style bands (Critical / High / Medium /
Low / Info). Fixes marked **FIXED** were applied this session and are safe
(input validation / resource caps, no behavior change for legitimate callers).
Items marked **FLAG** need a product/infra decision and were NOT acted on.

## Summary

| # | Area | Finding | Severity | Status |
|---|------|---------|----------|--------|
| 1 | Backfill zip | Decompression bomb — entries inflated before any size check | Medium | FIXED |
| 2 | Inbound webhook | No rate limit in front of the 15 MB parse + HMAC | Low–Med | FIXED |
| 3 | Inbound webhook | Inline attachment count/size unbounded | Low | FIXED |
| 4 | Backfill / email-in | Auto-commit writes asset cards with no human review | Info/Med | FLAG |
| 5 | Uploads | No content/AV scanning of stored+parsed PDFs/images | Low | FLAG (accepted) |

Everything else reviewed was found sound — see "Reviewed and safe" below.

## 1. Backfill decompression bomb — Medium — FIXED

`POST /api/ingest/backfill` (manager+) accepts a ≤100 MB **compressed** zip and,
for each report entry, called `entry.async('nodebuffer')` and only then checked
`buf.length > MAX_FILE_BYTES`. A zip bomb (a small archive of highly compressible
data) could therefore inflate a single entry to multiple GB **in memory before
the size check ran**, OOM-killing the process. Authenticated (manager+), so not
trivially anonymous, but a single hostile/misconfigured upload could take the
server down.

**Fix** (`routes/ingestBackfill.ts`): before inflating each entry we now reject on
the **declared** uncompressed size from the zip metadata
(`entry._data.uncompressedSize > MAX_FILE_BYTES` → skip), and we track a
per-batch `MAX_TOTAL_UNCOMPRESSED` (400 MB) budget and stop inflating once it is
reached — so a lying header can't run memory away either. Legitimate batches
(real PDFs/photos under 15 MB each) are unaffected; the existing
post-decompression `MAX_FILE_BYTES` check remains as a third layer.

## 2. Inbound webhook unrated — Low–Medium — FIXED

`/api/inbound` is mounted **before** the global `apiLimiter`, parses up to 15 MB of
JSON (capturing `req.rawBody` for the Svix HMAC), and the handler ends the
response — so the global limiter never sees it. An unauthenticated attacker could
force unlimited 15 MB body parses + HMAC computations (each ending in 401), a
cheap-to-send / not-cheap-to-serve asymmetry.

**Fix** (`index.ts`): added `inboundLimiter` (120/min/IP, keyed by the IPv6-safe
`_clientIpKey`) in front of the json parser. 120/min is far above any real
provider's per-IP webhook burst; over-limit returns 429 + `Retry-After` so a
legitimate provider (Resend) simply retries. (Note: `rateLimitHandler` is a
`const` declared later in the file — TDZ — so the default express-rate-limit
handler is used here intentionally; it already emits `Retry-After`.)

## 3. Inbound attachments uncapped — Low — FIXED

The handler mapped every inline base64 attachment into a Buffer and enqueued one
auto-commit job per report attachment, with no cap on count or per-attachment
size. Signature-gated, so low risk, but a single signed-or-secret-holding caller
could fan out into unbounded jobs / large buffers.

**Fix** (`routes/inboundEmail.ts`): attachments are filtered to ≤15 MB each and
capped at 25 per message before anything is stored or enqueued.

## 4. Auto-commit without review — Info/Medium — FLAG (by design)

Both `kind=backfill` and `kind=email_in` ingest jobs run `autoCommit=true`: the
worker parses and writes asset cards with **no human in the loop** (this is the
intended #34/#6 behavior). The trust boundary is sound — email-in is gated by the
Resend/Svix signature or the shared secret, and backfill is manager+ — but a
malformed or hostile-but-authenticated report can create junk asset cards that an
operator must then clean up. **Decision for Dustin:** consider a lightweight
"review/undo this batch" affordance for auto-committed jobs (a batch id +
soft-delete), or a confidence floor below which a job parks for review instead of
committing. Not a vulnerability; a data-quality / blast-radius control.

## 5. No content/AV scanning of uploads — Low — FLAG (accepted)

Uploaded PDFs/images are stored and parsed (pdfplumber / pdfkit / image
normalization) without malware scanning. This is standard for this product tier
and the parsers run in-container; flagging it as a known, accepted risk rather
than a gap to fix tonight. Revisit if self-hosted customers ingest untrusted
third-party reports at scale.

## Reviewed and safe (no action needed)

- **Zip-slip / path traversal (backfill):** triple-mitigated — the route reduces
  each entry to its basename (`name.split('/').pop()`), `buildStorageKey()`
  sanitizes the filename to `[a-zA-Z0-9.\-_]`, and `resolveLocalPath()` asserts
  the resolved path stays within the storage root. No entry name can escape.
- **`/api/help` (public):** intentionally skipped from the global limiter because
  each sub-route carries its own limiter (60/min/IP markdown reads, 10/min/IP
  PDF), and the slug is validated against `MODULE_INDEX` before any FS read, so
  there is no traversal via `:slug`. The explicit `HEAD …/pdf` handler prevents
  the pdfkit write-after-end crash. Sound.
- **`/api/public/parse-report` (public):** 10/hr/IP limiter, email-gated, ≤10 MB
  PDF-only, **deterministic parser only** (no AI cost), client IP stored only as a
  truncated SHA-256, full extraction never returned, report not retained,
  fail-open lead capture. Sound.
- **Inbound signature verification:** Svix HMAC-SHA256 over `${id}.${ts}.${rawBody}`
  with `crypto.timingSafeEqual`; shared-secret fallback also constant-time;
  **fail-closed** when no secret is configured (returns 401, never fail-open).
  Mail-loop guards (`NO_REPLY_RE`, skip `reports-*`) and fail-open ack are correct.
- **`/api/public/share`:** unauthenticated (token *is* the credential) but, unlike
  `/api/help`, it is NOT in the limiter skip-list, so the global `apiLimiter`
  anonymous bucket covers it. Sound.
- **Storage path traversal (`lib/storage.ts`):** `resolveLocalPath` containment
  assertion + filename sanitization at key-build time. Sound.

## Rate-limiter coverage map (as of this review)

- Global `apiLimiter` on `/api/` with split authenticated/anonymous budgets;
  skip-list = `/api/v1/*` (own `apiKeyLimiter` 60/min/key), `/api/help/*` (own
  per-route limiters), `/api/health`, `/api/ready`, `/api/setup/status`,
  `/api/ai/usage/me`.
- `ingestLimiter` 20/min on all `/api/*/import` + `/api/ingest` (covers backfill).
- `publicParseLimiter` 10/hr/IP on `/api/public`.
- `aiIpLimiter` 100/hr/IP stacked on per-user AI limiters.
- `feedbackLimiter` 5/hr, `exportLimiter` 10/min, `leaveBehindLimiter`,
  `apiKeyLimiter` 60/min.
- **`inboundLimiter` 120/min/IP on `/api/inbound`** — added this session (was the
  one uncovered mount).

Coverage is comprehensive after this session's addition.
