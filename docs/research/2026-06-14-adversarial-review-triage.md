# Adversarial Review - Code-Grounded Triage

**Date:** 2026-06-14
**Input:** 5.28.issues.txt - multiple external AI reviews run from the multi-persona prompt. The reviews explicitly state "no code was provided," so findings are assumptions about the architecture. This doc grounds each distinct finding against the ACTUAL ServiceCycle codebase.

## Headline

Most Critical/High findings are **already handled** - the blind reviews assumed the worst. Of ~50 distinct findings, the genuinely-open items are a short list (mostly Medium/hardening), plus a few real "trust/ops" enhancements. Nothing found here is a confirmed pre-launch-blocking vulnerability that isn't already mitigated.

## Already handled (reviewer assumed wrong) - with code evidence

| Finding(s) | Status | Evidence in code |
|---|---|---|
| Cross-tenant IDOR / missing accountId filter (SEC-01, S-003, SEC-03) | HANDLED | Every query filters `accountId: req.user.accountId`; dedicated `tests/idor.test.js` covers cross-tenant 404s |
| Share link 6-char brute-forceable / no expiry / no revocation (SEC-02, S-001, SEC-09) | HANDLED | Token = `crypto.randomBytes(24)` (192-bit opaque); ShareLink has `expiresAt` (default 14d, max 90) + `revokedAt` + viewCount |
| Stored XSS via rendered OCR text (SEC-05, S-002) | HANDLED | React escapes by default; the only `dangerouslySetInnerHTML` in the client is static HelpDrawer content, not user/OCR data |
| AI key stored plaintext / exfiltratable (AI-KEY-ENCRYPTION, S-002) | HANDLED | `AI_API_KEY` encrypted at rest AES-256-GCM (lib/crypto), masked on read (settings.ts) |
| Prompt injection sets readings (AI-01, S-013) | HANDLED (by design) | Core extraction is a deterministic Python parser (pyextract), not an LLM following document text; AI is optional/advisory |
| AI cost abuse / no spend cap (AI-05, S-014) | HANDLED | aiBudgetGuard (#44) with per-account monthly counters + budget guard |
| 2FA bypass via session set before verify (SESS-FIXATION) | HANDLED | Login returns only a pending `twoFactorToken`; full access token issued only after /2fa/verify-login |
| Rate limit fails on IPv6 rotation (SEC-10) | HANDLED | ipKeyGenerator / _clientIpKey IPv6-aware keying (#44 0.2) |
| Upload OOM via 2GB PDF / zip bomb (OPS-01, S-005) | LARGELY HANDLED | multer `fileSize` 10MB + `files:1`; no archive ingest (so zip-of-10k N/A); extractor has page caps + time budget; ingest moved off the request to the async queue (#2) |
| Health check is a liar (S-010 partial) | HANDLED | `/api/ready` does `SELECT 1` DB probe (+ `?deep=1` Brevo/Anthropic); the "health is a liar" audit finding was already fixed |
| Compliance inflation by importing only passing reports (BIZ-01, S-007, S-022) | HANDLED | buildComplianceGap reports honest `overallRate` folding overdue + unbaselined + uncovered + EMP gaps, plus a separate `coverageRate`; numbers framed as estimate |
| AI overconfidence not surfaced (AI-03, S-015) | HANDLED | #10 confidence triage: per-reading dots, flagged rows float up, "Review N of M" |
| Queue loses jobs on crash (OPS-02) | LARGELY HANDLED | Postgres-backed queue claims via FOR UPDATE SKIP LOCKED; recoverStaleJobs requeues crashed claims (#2) |
| Session offboarding / instant kill (S-004 partial) | HANDLED | POST /users/:id/revoke-sessions revokes all refresh tokens AND bumps tokenEpoch (instant access-token kill) |
| micro-ohm unicode mis-parse (DATA-01 partial) | HANDLED | parser round-trips uÎ© unicode (testReportMultiSection test) |
| Refresh rotation / token epoch (SEC-07) | HANDLED | tokenEpoch bumped on password change, reset, 2FA disable, revoke-sessions; middleware validates epoch |

## Genuine gaps worth considering (ranked)

| # | Gap | Severity | Effort | Note |
|---|---|---|---|---|
| 1 | **SSRF hardening**: webhook target URLs + BYO-AI custom base URL should block private / link-local ranges (169.254.169.254, 10/8, 127/8, etc.) at request time, not just URL-shape parse | Med-High | S-M | webhooks.ts validates URL shape; confirm/add private-range + DNS-rebinding block. Real on a cloud VM with metadata endpoint |
| 2 | **tokenEpoch not bumped on role change/demote** | Medium | S | A demoted user keeps their old access token (~1h TTL) until expiry unless an admin runs revoke-sessions. Fix: bump tokenEpoch in the role-update path. Mitigated by short TTL + manual revoke |
| 3 | **/api/ready has no ingest-worker heartbeat** | Medium | S | Readiness probes DB but not the queue worker; a dead worker passes health. Add last-success heartbeat (mitigated today by recoverStaleJobs) |
| 4 | **"Compliance by import" via incomplete report** | Medium | M | A report with a date but missing required readings for the asset type can still satisfy a schedule. Consider per-asset-type required-field enforcement before a completion counts |
| 5 | **Unit mis-scale guard (uohm vs mohm)** | Medium | S-M | Unicode is handled, but a wrong-magnitude unit (450 uohm read as 450 mohm) isn't range-validated. Add a plausibility/range check + review flag on extracted values |
| 6 | **Audit-chain external trust**: ship an independent verifier script for the hash chain; optionally anchor periodic snapshots to an external RFC-3161 TSA; store the ledger signing key separately from DB creds | Med (trust) | M-L | Design choice today (chain lives in same DB). Matters for the "show the underwriter" moat |
| 7 | **Share-link access logging** (timestamp/IP/UA per view, not just a viewCount) | Low-Med | S | Lets a tenant prove who viewed shared compliance data |
| 8 | **2FA step-up on sensitive actions** (create share link, reveal API key, disable 2FA) | Low-Med | M | TOTP enforced at login only today |
| 9 | **Backup RESTORE drill** (prove the pg_dump actually restores into a fresh DB) + **Retry-After header** on 429s + per-tenant (not just IP) rate-limit keying for authed routes | Low-Med | S each | Ops hygiene |

## N/A / assumption wrong

- 6-char share token brute force - token is 192-bit random.
- Zip-bomb archive ingest - no archive upload path; single-file 10MB cap.
- "RLS required" - app-layer accountId filtering + IDOR tests is an accepted posture; RLS is optional defense-in-depth, not a blocker.
- Marketing "100% compliant" lawsuit - the dashboard already shows an honest estimate + coverage, not a compliance guarantee; just keep copy disciplined.

## Two domains the reviewers said are MISSING (worth a future dedicated pass)

1. **Billing / quota integrity** - subscriptions, tenant quotas, AI usage accounting, overage. (Lower urgency pre-revenue.)
2. **Forensics / "3 years later in court"** - can you reconstruct exactly what was known/when/by whom for a given asset at a given date. This aligns with the product's audit moat and is the highest-value future review.