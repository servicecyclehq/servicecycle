# Data Classification Policy

**Version:** 1.0
**Effective date:** 2026-07-04
**Owner:** Dustin
**Next review:** 2027-01-04
**SOC 2 mapping:** C1.1 (identifies and maintains confidential information).

Companion to `DATA_FLOW.md` (how data moves) and `docs/compliance/DATA_RETENTION_MATRIX.md` (how long it lives).

---

## Classification tiers

ServiceCycle uses four tiers. Every field in the schema, every log line, and every export belongs to exactly one tier.

### Tier 1 — Public

Data that can be published to the internet without harm.

**Examples:** marketing copy, help-center articles, `SECURITY.md`, `/.well-known/security.txt`, public API docs.
**Storage:** may live in the repo, on the marketing site, or in the SPA bundle.
**In transit:** any channel is acceptable.
**Retention:** as long as useful.
**Destruction:** delete-in-place is sufficient.

### Tier 2 — Internal

Data that is not sensitive but should not be public.

**Examples:** operational metadata (feature flags, non-secret env vars), high-level system health metrics, aggregate telemetry (counts, not identifiers).
**Storage:** repo + droplet + admin console.
**In transit:** HTTPS only when leaving the droplet.
**Retention:** indefinite; no PII to age out.
**Destruction:** delete-in-place is sufficient.

### Tier 3 — Confidential

Customer data, PII, business records. This is the default classification for anything a customer produces or that identifies a customer.

**Examples:**
- User emails, technician names, site addresses.
- Test reports, arc-flash studies, LOTO procedures, nameplate scans, quote requests.
- Asset registries, maintenance history, deficiency records.
- Audit chain rows (they reference customer actions).
- AI usage counters (per customer).

**Storage:** Postgres scoped by `accountId`; optional per-account envelope encryption for test reports (`ENCRYPT_DOCS` flag + `ENCRYPTED_KEYS`).
**In transit:** HTTPS/TLS 1.3 only. TLS is a hard requirement.
**Retention:** indefinite while account is active; deletion on customer request per `docs/OFFBOARDING.md`.
**Destruction:** live delete + logical delete propagated through rolling backups within the retention window (30 days).
**Access:** enforced by RBAC; least-privilege by role; audit-logged.

### Tier 4 — Restricted

Data whose disclosure would cause immediate, severe harm.

**Examples:**
- Password hashes.
- TOTP secrets (already AES-256-GCM encrypted at rest).
- JWT signing key (`JWT_SECRET`).
- Master encryption key (`MASTER_KEY`).
- Backup encryption key (`BACKUP_ENCRYPTION_KEY`).
- Customer BYO AI provider keys.
- Vendor account credentials (DO, Cloudflare, DNS, email, S3).

**Storage:** droplet `.env` + password manager only. Never in code. Never in logs. Never in error responses.
**In transit:** never sent to a client. Bearer tokens are Tier 3-ish (short-lived) — the signing keys themselves are Tier 4.
**Retention:** rotates on schedule per `KEY_ROTATION.md` or on suspected compromise.
**Destruction:** zero-downtime rotation replaces the value; the old value is destroyed after the dual-verify window closes.

## How the tier is enforced

| Enforcement point | Mechanism |
|---|---|
| Ingress | Zod validation rejects malformed payloads before the tenant scope even fires |
| Route auth | `authenticateToken` on every `/api/*`; `requireManager` / `requireRole` where writes matter |
| Tenant scope | Every Prisma query filters by `req.user.accountId` |
| Encryption at rest | `MASTER_KEY` for `ENCRYPTED_KEYS`; volume encryption for the rest |
| Log redaction | `redactEmail()` before any log line that could carry PII |
| Free-tier AI | PII-scrubbing in `aiTestReportExtract.ts` before any provider call |
| Backup | Client-side AES-256-GCM before object leaves the droplet |
| Export | `/api/activity/export` scoped to requester's account |
| Destruction | GDPR erasure path in `docs/OFFBOARDING.md` §6 |

## Labeling responsibility

- Every new field added to the Prisma schema must be tagged in its comment with its tier.
- Every new external integration must state which tier of data it will receive, in the same PR.
- Every log statement carrying user input must go through `redactEmail()` (or an equivalent redactor for other PII).

## Handling exceptions

If a specific business need requires transmitting Tier 3 or Tier 4 data outside the standard flow (e.g., an enterprise customer requests a raw data export via non-standard channel):

1. Open a decision entry in `SECURITY_DECISIONS.md`.
2. Reference the request + business justification.
3. Document the safeguards (encryption in transit, expiry of the transmitted artifact, deletion from origin after transmission).
4. Log the export in the audit chain with the reason.
5. Communicate to the customer that the exception was recorded.

## What data ServiceCycle does not collect

- Payment card numbers (Stripe/PayPal handles PCI scope; SC only stores customer IDs).
- Government IDs / passport numbers.
- Health information.
- Biometric data.
- Location beyond site address (no continuous GPS on technicians).

## Change triggers

Revisit this policy when:

- A new class of customer data is stored (e.g., PCI data if we take payments direct).
- A new integration receives Tier 3 or Tier 4 data.
- Regulatory scope changes (SOC 2 Type II engagement, GDPR expansion, sector-specific rule).
