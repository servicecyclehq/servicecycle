# Threat Model — ServiceCycle

**Version:** 1.0
**Effective date:** 2026-07-04
**Next review:** 2026-10-04 (quarterly, or on material architectural change)
**Owner:** Dustin

**Method:** informal STRIDE per data flow. Not an OWASP full workshop — this is the working-document version an auditor and an acquirer's security reviewer will accept.

---

## Assets (what we protect, ranked)

1. **Customer test-report data** — nameplate scans, PowerDB reports, arc-flash studies, LOTO procedures. High confidentiality, high integrity (compliance records).
2. **Customer PII** — user emails, technician names, customer/site addresses.
3. **Auth secrets** — password hashes, TOTP secrets, JWT signing key.
4. **Master encryption key** — `MASTER_KEY` unlocks per-account `ENCRYPTED_KEYS`.
5. **Backup archives** — encrypted pg_dumps on S3-compatible target.
6. **Audit chain** — SHA-256 hash-chained activity log per account (tamper evidence).
7. **AI provider budget** — abuse of free-tier keys or BYO customer keys.
8. **Vendor credentials** — GH, DO, Cloudflare, email provider, DNS.
9. **Domain + DNS** — takeover leads to spoof site + credential harvest.
10. **Source code + release artifacts** — supply-chain vector.

## Trust boundaries

```
[ Public internet ]
        │
        │ HTTPS/TLS (Cloudflare edge, HSTS)
        ▼
[ Cloudflare proxy ]                   ← DDoS + WAF (basic tier)
        │
        │ HTTPS to origin
        ▼
[ nginx on DO droplet ]                ← TLS termination, basic-auth on demo
        │
        │ HTTP loopback
        ▼
[ Node/Express API ]                   ← JWT auth, RBAC, rate limits, redaction
        │           │            │
        │           │            └── [ Free-tier LLM providers ]  (PII-scrubbed)
        │           └────────────── [ Customer BYO LLM providers ] (per account)
        │
        │ Prisma
        ▼
[ Postgres (same droplet, docker network only) ]
        │
        │ pg_dump nightly, AES-256-GCM
        ▼
[ S3-compatible backup target ]         ← encrypted at rest + in transit
```

Trust boundaries where authorization is enforced:
- Cloudflare edge → origin (Cloudflare access rules if any).
- nginx → API (basic-auth on demo; nothing but TLS on prod).
- API entry → route handler (`authenticateToken`, `requireRole`, `requireManager`, tenant-scope predicate).
- Route handler → DB (Prisma query with `where: { accountId: req.user.accountId }`).
- API → external LLM (redacted body only on free tier; BYO key on paid).

## Data flow (per asset class)

**Test-report ingest (highest-risk path):**

```
User uploads PDF
  → Client posts multipart to /api/ingest
  → API validates auth + tenant scope
  → PDF parsed locally (pdfplumber / OCR)
  → If AI needed:
      → Free tier: PII-scrubbed vision call to Gemini (customer's own key preferred)
      → Paid tier: pass-through to BYO customer key
  → Extracted fields written to DB scoped to accountId
  → api_v1_call event logged to hash-chained activity log
```

**Audit chain read:**

```
Admin requests /api/activity/export
  → API returns ndjson + CEF with rowHash + prevHash
  → Nightly verifier confirms chain integrity per account
  → Break = automatic alert + block on further writes for that account
```

## Threats × mitigations × residual risk

### T1 — Credential theft from workstation (highest realistic threat)

**Mitigation:**
- Endpoint security policy (`ENDPOINT_SECURITY.md`) enforces disk encryption, screen lock, AV.
- Password manager + MFA on every vendor account.
- Secrets never in source (`.env.example` only; startup validation rejects weak defaults).

**Residual risk:** infostealer inside a browser-owned session that survives MFA. Rotation runbook exists (`KEY_ROTATION.md`). **Accepted** at current stage; revisit if second person joins.

### T2 — Auth bypass in application code

**Mitigation:**
- All routes gated by `authenticateToken` + tenant-scope predicate.
- Integration test `multiTenantIsolation.test.ts` verifies cross-tenant leak isn't possible via each API surface.
- Regular acquisition-scan agent fan-outs (last: 2026-07-03, f027483) catch missed guards.

**Residual risk:** a newly-added route without the tenant predicate. Change-review checklist requires the reviewer to confirm this on every schema/auth/API PR.

### T3 — Sub-processor compromise (LLM provider, email provider, S3 target)

**Mitigation:**
- BYO customer keys for paid AI use — customer owns provider agreement.
- Free-tier AI use scrubs PII before the call.
- S3 backup target encrypts with `BACKUP_ENCRYPTION_KEY` client-side — a provider breach yields ciphertext.
- Vendor risk review (`VENDOR_SECURITY_REVIEW.md`) captures SOC 2 status per vendor.

**Residual risk:** silent behavior change by a provider (e.g., a free-tier provider begins retaining prompts). Mitigated by cascade / fallback design and by vendor review cadence (`VENDOR_REVIEW_LOG.md`).

### T4 — Ransomware / destructive prod compromise

**Mitigation:**
- Nightly encrypted off-host backup with 30-day retention.
- Automated monthly restore test.
- RTO ~2h, RPO ~24h.
- Backup credentials scoped write-only where the S3-compatible target supports it.

**Residual risk:** simultaneous compromise of droplet + backup target. Mitigation: rotate backup credentials on any suspected compromise; consider a second, physically-separate cold backup at year 2.

### T5 — Audit chain tampering by application-server insider

**Mitigation:**
- Hash chain per account with `prevHash`; nightly verifier detects break.
- **Threat model of the audit chain itself** is documented in `docs/AUDIT_LOG_ARCHITECTURE.md` — defeats DB-only insider, not DB + app-server insider.

**Residual risk:** yes, an application-server + DB insider could rewrite history. Documented, acknowledged. Mitigation for future: export chain rollups to an append-only store (Cloudflare R2 object-lock or GitHub tag artifact) daily.

### T6 — SSRF / open-redirect / injection via ingest surface

**Mitigation:**
- Zod validation middleware on inputs.
- Prisma parameterized queries (no raw SQL from user input).
- LLM prompt-injection mitigations in `server/lib/ai.ts` (F-AI-LEAK measures).
- No open URL fetching from user-provided URLs without allowlist.

**Residual risk:** OCR pipeline consuming user PDFs — malicious PDF exploiting a parser CVE. Mitigation: keep pdfplumber and OCR chain patched (Dependabot + `npm audit`); container-scan (Trivy) planned.

### T7 — Denial of service on AI budget / rate limits

**Mitigation:**
- `aiIpLimit.ts` per-IP AI budget.
- `aiBudgetGuard.ts` per-account + per-user daily cap.
- `express-rate-limit` stack at `/api` entry with IPv6 /64 normalization.

**Residual risk:** distributed low-and-slow abuse. Mitigation: Cloudflare rules; alert on daily-cost overrun.

### T8 — Domain / DNS takeover

**Mitigation:**
- Registrar MFA + registrar-lock.
- Cloudflare account MFA.
- Named contact + backup contact on registrar.

**Residual risk:** registrar social-engineering. Rotation runbook covers post-recovery rekey.

### T9 — Supply-chain compromise (npm package)

**Mitigation:**
- `npm audit` in CI blocks high/critical.
- Dependabot updates weekly.
- SBOM at `server/sbom/cyclonedx.json`.
- Dependency approval process (see B10 in `SOC2_READINESS_CHECKLIST.md` — planned).

**Residual risk:** zero-day in a transitive dependency between weekly Dependabot runs. Accepted.

### T10 — Physical or platform loss of DigitalOcean droplet

**Mitigation:**
- Off-host encrypted backup.
- DR runbook rebuilds a fresh droplet from image + secrets + latest backup.

**Residual risk:** DO regional outage during business hours. Accepted at current stage; multi-region is a revenue-gated future control.

## Accepted residual risks (index)

Every "accepted" above is echoed into `docs/compliance/RISK_ACCEPTANCE_LOG.md` with an approver + date + reconsideration date.

## Change-triggers (rerun this threat model when...)

- Any new external integration.
- Any new class of data stored.
- Any major auth change (SSO scope expansion, session model change).
- Any change to encryption at rest.
- Any change to the backup target or backup encryption approach.
- Any second person receiving production access.
