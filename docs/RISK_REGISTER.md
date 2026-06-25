# ServiceCycle — Risk Register

**Classification:** Internal / Diligence  
**Owner:** Engineering / Security  
**Last reviewed:** 2026-06-25  
**Review cadence:** Quarterly (or after a material incident or architecture change)

This register lists the top operational, security, and compliance risks for
ServiceCycle. Each risk is assessed on a 1–5 scale for **Likelihood** (L) and
**Impact** (I); **Inherent Score = L × I** before mitigations; **Residual
Score** reflects the current control posture.

---

## Risk Matrix

| # | Risk | Category | L | I | Inherent | Controls / Mitigations | Residual | Owner | Status |
|---|---|---|---|---|---|---|---|---|---|
| R-01 | Single-tenant DB isolation failure (cross-account data leak) | Security | 2 | 5 | 10 | Row-level `accountId` on every table; Prisma enforces no raw SQL; IDOR test suite in `tests/idor.test.js`; quarterly penetration-test target | 3 | Engineering | Active |
| R-02 | Secrets exfiltration (`MASTER_KEY`, `JWT_SECRET`, API keys) | Security | 2 | 5 | 10 | `MASTER_KEY` only in VPS `.env` (not in repo); per-account AES-256-GCM encryption at rest; key rotation runbook `docs/KEY_ROTATION.md`; API keys stored as SHA-256 hashes only | 4 | Engineering | Active |
| R-03 | VPS compromise / single point of failure | Infrastructure | 3 | 4 | 12 | DigitalOcean SOC 2 certified DC; daily Postgres backups (encrypted, offsite S3); 30-day retention; `docs/DEPLOY_RUNBOOK.md`; swap + memory limits via Docker Compose | 6 | Engineering | Active — migrate to managed DB (PaaS) as scale grows |
| R-04 | Arc-flash label data integrity error (energized-work safety) | Compliance/Safety | 2 | 5 | 10 | AI gap-fill is advisory only (`ADVISORY` badge); human sign-off on all label data via ArcFlashAssetTab; disclaimer on every label PDF; AFX export includes confidence score; NFPA 70E 130.5(H) compliance documented | 4 | Product | Active |
| R-05 | Dependency vulnerability (npm supply-chain attack) | Security | 3 | 3 | 9 | `npm audit --audit-level=high` blocks high/critical CVEs in CI; `.github/dependabot.yml` opens weekly PRs for server, client, and GitHub Actions; `tsc --noEmit` catches type-level API surface changes; Docker base image pinned to digest | 4 | Engineering | Active |
| R-06 | Service outage / data loss during deploy | Operational | 3 | 3 | 9 | Zero-downtime JWT rotation (dual-verify window); Docker Compose rolling rebuild; DB migrations run in a separate `server-migrate` container before the server restarts; `docs/DEPLOY_RUNBOOK.md` rollback steps | 4 | Engineering | Active |
| R-07 | GDPR / data subject rights request not fulfilled | Compliance | 2 | 4 | 8 | `DELETE /api/admin/users/:id/erase` hard-deletes PII, nulls `userId` in audit log (SetNull cascade); activityLog retains chain integrity after erasure; process in `docs/INCIDENT_RESPONSE.md` | 3 | Engineering | Active |
| R-08 | API rate limit bypass allowing scraping or DoS | Security | 3 | 2 | 6 | Per-IP `v1IpLimiter` (10 req/min unauthenticated); per-key `apiKeyLimiter` (60 req/min); global `apiLimiter` (200 req/min for JWT sessions); `express-rate-limit` with `standardHeaders: true` | 3 | Engineering | Active |
| R-09 | Email inbound injection (malicious payload via `support@` ingest) | Security | 2 | 3 | 6 | Inbound email parsed server-side with strict type checking; attachments processed only as documents (PDF/image); no code execution path from email; sender domain not trusted for auth | 3 | Engineering | Active |
| R-10 | Customer data export used by terminated employee | Compliance | 2 | 3 | 6 | Export requires `manager`+ role; all exports logged to activityLog (`account_export` action); SSO SCIM provisioning (Ory Polis) deprovisions accounts on identity provider signal; API keys can be revoked per-key | 2 | Operations | Active |

---

## Risk Score Guide

| Score | Label |
|---|---|
| 1–4 | Low — accept; monitor quarterly |
| 5–9 | Medium — mitigate; review monthly |
| 10–15 | High — active remediation required |
| 16–25 | Critical — immediate escalation |

---

## Open Remediation Items

| Risk | Action | Target |
|---|---|---|
| R-03 | Evaluate managed PostgreSQL (DigitalOcean Managed DB or RDS) as scale grows | Q3 2026 |

---

## Review History

| Date | Reviewer | Changes |
|---|---|---|
| 2026-06-25 | Engineering | Initial register; 10 risks assessed; R-01 through R-10 baselined |
| 2026-06-25 | Engineering | R-05 updated — Dependabot + npm audit in CI now active; residual score 6→4; open remediation items for R-05 closed |
