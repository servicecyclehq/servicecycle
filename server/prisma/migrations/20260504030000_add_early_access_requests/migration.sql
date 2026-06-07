-- L7: EarlyAccessRequest — captures landing-page lead form submissions.
--
-- Rows are user-supplied via an unauthenticated POST /api/early-access
-- (rate-limited via the existing apiLimiter anon bucket). The auto-reply
-- email + admin view are downstream of this table; storing the raw
-- submission lets us recover from a Resend outage by replaying the queue
-- offline.
--
-- ipAddress + userAgent are captured for spam triage only — never displayed
-- back to other visitors. timing is a free-form short string ("now",
-- "this week", "this month", "browsing") so we don't have to migrate an
-- enum every time the funnel categories shift.

CREATE TABLE "early_access_requests" (
    "id"         TEXT         NOT NULL,
    "name"       TEXT         NOT NULL,
    "email"      TEXT         NOT NULL,
    "company"    TEXT,
    "timing"     TEXT,
    "ipAddress"  TEXT,
    "userAgent"  TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "early_access_requests_pkey" PRIMARY KEY ("id")
);

-- Admin view sorts by createdAt DESC; index keeps that scan bounded as
-- the table grows past a few thousand rows.
CREATE INDEX "early_access_requests_createdAt_idx"
  ON "early_access_requests"("createdAt" DESC);

-- Email lookups (admin search-by-email + dedup-warning at submit time)
-- without an index would full-scan once the table is non-trivial.
CREATE INDEX "early_access_requests_email_idx"
  ON "early_access_requests"("email");
