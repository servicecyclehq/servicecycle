# ServiceCycle Security & Trust Pack

**Audience:** enterprise / regulated-customer security reviewers (utilities, large industrials, healthcare).
**Status:** living document. The substance below is implemented today; SSO/SAML and SCIM are on the roadmap (noted as such).

---

## 1. Data protection

- **Encryption in transit:** all API + app traffic is HTTPS/TLS (nginx termination on the hosted deployment).
- **Encryption at rest (secrets):** per-account integration secrets — AI provider API keys, outbound-webhook signing secrets, the import-webhook secret — are encrypted with **AES-256-GCM** before they touch the database (`lib/docCrypto` / `ENCRYPTED_KEYS`). They are masked in the UI and never re-surfaced once saved.
- **Password storage:** bcrypt.
- **Backups:** database backups are supported with off-host (S3) destinations; backup crypto is configurable.

## 2. Tamper-evident audit log (hash chain)

Every security- and compliance-relevant event is written to a **per-account hash-chained activity log**. Each row stores `rowHash = sha256(prevHash || canonical(row))`, settled by a background job shortly after insert. Any retroactive edit or deletion breaks the chain and is detectable by the verifier.

- Covered events include: sign-in success/failure, permission-denied, asset/condition/field changes, work-order completion, document access, admin password resets, and compliance-snapshot integrity failures.
- **Compliance snapshots** (the audit-evidence PDFs) have their SHA-256 anchored into this same chain at generation time, so a snapshot presented to an auditor has exactly one immutable, verifiable answer. Snapshots are intentionally non-deletable.

### SIEM export

`GET /api/activity/export` (admin-only) streams the account's audit log for ingestion by a SIEM (Splunk, ArcSight, etc.):

- `?format=ndjson` (default) — one JSON event per line, including `rowHash` + `prevHash` so the SIEM stores tamper-evident records.
- `?format=cef` — ArcSight Common Event Format; security events carry elevated severity.
- Supports `dateFrom` / `dateTo` / `action` filters for scheduled incremental pulls. Oldest-first so events append in chain order.

## 3. Authentication & access control

- **Role-based access control:** admin / manager / viewer / consultant / oem_admin / super_admin, enforced at the route layer; every tenant query is account-scoped.
- **Two-factor authentication (TOTP):** supported per user; admins can require TOTP enrolment for all admin-role users on an account (`mfaRequiredForAdmins`). TOTP secrets are AES-256-GCM encrypted; replay is prevented by tracking the last used step; hashed one-time backup codes are supported.
- **Instant token revocation:** access tokens embed a monotonic `tokenEpoch`; password change/reset bumps the epoch and kills every outstanding token immediately.
- **Multi-tenant isolation:** enforced by account-scoped predicates on every query and FK constraints; covered by an integration test suite (`multiTenantIsolation`, `roleEnforcement`, `tokenEpochRevocation`).
- **SSO / SAML + SCIM provisioning:** on the roadmap (not yet implemented). This document will be updated when shipped.

## 4. AI data flow (BYO-AI)

ServiceCycle never resells AI. Customers **bring their own AI key** (Gemini / Anthropic / OpenAI / Azure / Cloudflare). The agreement and data-residency decision sit between the **customer and their AI provider**, not ServiceCycle:

- The deterministic document parser (the core data-in engine) runs **fully locally** — no third party sees test reports.
- AI is optional and gated: per-account enable flag + per-session user consent (versioned, provider-named at acceptance). Free-tier provider caveats (some may train on data) are surfaced in-product so the customer makes an informed choice; paid tiers do not train.
- Identifiers (email/phone) are scrubbed before any free-tier AI call.

## 5. Self-host / air-gap

A licensed-instance seam exists (`planType=licensed`) for customers who require that **no data leaves their network**: the deterministic parser runs locally and BYO-AI is optional. Productized self-host packaging (install runbook, offline license keys) is on the roadmap.

---

*Contact your ServiceCycle representative for the current pen-test attestation and a deployment-specific architecture diagram.*
