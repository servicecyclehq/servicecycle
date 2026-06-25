# SOC 2 Controls Matrix — ServiceCycle

**Version:** 2026-06-24  
**Applies to:** ServiceCycle hosted deployment (servicecycle.app)  
**Scope:** Security (CC), Availability (A1), Confidentiality (C1)  
**Status:** Type I readiness assessment — controls implemented and documented.
Type II requires 6–12 months of operating evidence collection.

---

## How to read this document

Each row maps a SOC 2 Trust Service Criterion (TSC) to the control(s) implemented
in this codebase. **Evidence** points to the code artifact, test, or document a
Certified Public Accountant (CPA) would inspect. **Gap / next step** notes what
is deferred or manual.

---

## Security category (CC criteria)

### CC1 — Control Environment

| Criterion | Description | Control | Evidence | Gap |
|---|---|---|---|---|
| CC1.1 | Demonstrates commitment to integrity and ethical values | Code of conduct policy: data integrity, confidentiality, least-privilege access, security-first reporting; hash-chain audit log makes record tampering detectable | `docs/CODE_OF_CONDUCT.md`; `docs/OFFBOARDING.md` §4 (access removal); hash-chain architecture (see CC7.1) | — |
| CC1.2 | Board oversees internal controls | Founder oversees all controls (pre-board stage) | — | Accepted risk at current stage |
| CC1.3 | Competent individuals are hired and retained | Personnel security policy: identity verification + reference check before production access; documented solo-founder compensating controls (Git audit trail, VPS logs, hash-chain activity log); onboarding/offboarding checklists; access log | `docs/PERSONNEL_SECURITY.md`; Git commit history | — |
| CC1.4 | Accountability for internal controls | Owner accountable; RBAC limits what any one role can do | `server/middleware/roles.ts`; `multiTenantIsolation.test.ts` | — |
| CC1.5 | Enforces accountability via performance review | Founder-led review cycle at current stage | — | Accepted risk at current stage |

### CC2 — Communication and Information

| Criterion | Control | Evidence | Gap |
|---|---|---|---|
| CC2.1 | Security-relevant information flows to responsible parties via audit log + alerts | `server/lib/activityLog.ts`; `server/lib/aiBudgetGuard.ts`; SIEM export at `GET /api/activity/export` | — |
| CC2.2 | External communication of security commitments | `docs/SECURITY_TRUST_PACK.md`; `/.well-known/security.txt` (`contact: security@servicecycle.app`); privacy policy publicly served at `/privacy` + `/legal/privacy` (attorney review pending before formal publication) | — |
| CC2.3 | Relevant information is communicated to third parties | `docs/OFFBOARDING.md` §6 (sub-processor list); vendor list in CC9.2 below | — |

### CC3 — Risk Assessment

| Criterion | Control | Evidence | Gap |
|---|---|---|---|
| CC3.1 | Specifies objectives clearly enough to identify risks | Architecture documented | `docs/ARCHITECTURE.md` | — |
| CC3.2 | Identifies and analyzes risks to achievement of objectives | Periodic security audits + formal risk register with 10 risks, L×I scoring, mitigations, owners, and quarterly review cadence | `docs/security/SECURITY_AUDIT_2026-06-20.md`; `docs/RISK_REGISTER.md` | — |
| CC3.3 | Considers potential for fraud | Role-separation design; consultant read-only; no single role can forge + approve a compliance record | `server/middleware/roles.ts`; `requireManager` guards on all write routes | — |
| CC3.4 | Identifies and assesses changes that could impact controls | Mandatory change-impact review checklist for schema, auth, public API, and external-integration PRs; covers scope, tenant isolation, rollback, and test coverage | `docs/CHANGE_REVIEW_CHECKLIST.md` | — |

### CC4 — Monitoring Activities

| Criterion | Control | Evidence | Gap |
|---|---|---|---|
| CC4.1 | Selects, develops, and performs ongoing evaluations | Nightly audit-chain verifier; health check endpoint | `GET /api/admin/audit-chain/verify`; `GET /api/health`; `server/scripts/verify-audit-chain.js` | Automated uptime monitoring (Better Stack) wired but not activated for alerting |
| CC4.2 | Evaluates and communicates deficiencies | Security findings documented and fixed within same sprint; vulnerability SLA: Critical (≤24 h patch/workaround), High (≤7 days), Medium (≤30 days), Low (next sprint) | `docs/security/SECURITY_AUDIT_2026-06-20.md` → all findings resolved same day; `docs/INCIDENT_RESPONSE.md` §2 priority matrix | — |

### CC5 — Control Activities

| Criterion | Control | Evidence | Gap |
|---|---|---|---|
| CC5.1 | Selects and develops control activities over technology | RBAC, account-scoping, audit log, rate limiting | `server/middleware/roles.ts`; `server/index.ts` (limiter stack) | — |
| CC5.2 | Selects and develops general controls over technology | Dependency audit; CSP headers; HTTPS/TLS; `npm audit --audit-level=high` in CI; Dependabot enabled for server + client + GitHub Actions | `docs/DEPENDENCY_AUDIT_2026-06-18.md`; `.github/dependabot.yml`; `.github/workflows/ci.yml` | — |
| CC5.3 | Deploys through policies and procedures | Git-gated deploys via documented runbook; GitHub Actions CI runs `tsc --noEmit + jest` on every PR; `npm audit` in CI | `docs/DEPLOY_RUNBOOK.md`; `.github/workflows/ci.yml` | — |

### CC6 — Logical and Physical Access Controls

| Criterion | Control | Evidence | Gap |
|---|---|---|---|
| CC6.1 | Implements logical access controls | RBAC (8 roles); all routes require `authenticateToken`; `requireManager` / `requireRole` guards | `server/middleware/roles.ts`; `server/middleware/auth.ts` | — |
| CC6.2 | User authentication | bcrypt password hashing; TOTP/MFA per user; admin-enforced MFA (`mfaRequiredForAdmins`) | `server/routes/auth.ts` (TOTP blocks); `server/lib/totp.ts` | — |
| CC6.3 | Restricts access based on least privilege | Viewer cannot write; consultant is read-only; field_tech limited to assigned jobs; group/oem admins cannot cross-account; parts catalog and spare inventory writes require manager+ | `server/middleware/roles.ts` `requireQuoteWriter`, `requireManager`, field role scope; `server/routes/parts.ts` requireManager guards | — |
| CC6.4 | Manages changes to access | User activation/deactivation; instant token revocation on password reset; SCIM provisioning via SSO | `server/routes/auth.ts` `tokenEpoch`; `server/routes/sso.ts` SCIM | — |
| CC6.5 | Physical access | Hosted on DigitalOcean (SOC 2 certified DC) | DigitalOcean compliance: digitalocean.com/trust | Physical access at DC level; no ServiceCycle hardware |
| CC6.6 | Implements boundary protection | CSP headers; CORS allowlist; rate limiting stack; Cloudflare proxy | `server/index.ts` CSP + CORS + limiters | — |
| CC6.7 | Manages transmission confidentiality | HTTPS/TLS (nginx termination); HSTS header | `server/index.ts` HSTS; nginx config | — |
| CC6.8 | Manages encryption keys and access monitoring | AES-256-GCM for per-account secrets; `ENCRYPTED_KEYS` env var; backup crypto; every authenticated `/api/v1` call logged to the tamper-evident activity log (`action=api_v1_call`) with key name/ID, method, path, HTTP status, latency, and client IP; key rotation runbook in `docs/KEY_ROTATION.md` (zero-downtime JWT dual-verify, `MASTER_KEY` re-encrypt, `BACKUP_ENCRYPTION_KEY` rotation) | `server/lib/docCrypto.ts`; `server/lib/backupCrypto.ts`; `server/middleware/apiKeyAuth.ts`; `docs/KEY_ROTATION.md` | — |

### CC7 — System Operations

| Criterion | Control | Evidence | Gap |
|---|---|---|---|
| CC7.1 | Detects and monitors for new vulnerabilities | Dependency audit; `npm audit --audit-level=high` in CI (blocks high/critical CVEs); Dependabot opens PRs weekly for server, client, and GitHub Actions | `docs/DEPENDENCY_AUDIT_2026-06-18.md`; `.github/workflows/ci.yml`; `.github/dependabot.yml` | — |
| CC7.2 | Monitors system components | Activity log for all security events (login, permission denied, admin ops); hash chain ensures tamper evidence | `server/lib/activityLog.ts`; `server/lib/activityLogChain.ts`; SIEM export | — |
| CC7.3 | Evaluates security events to determine if they are security incidents | Failed login tracking (per-email lockout + per-IP rate limit); logged to activity chain | `server/routes/auth.ts` `credentialLimiter`, `EMAIL_LOCKOUT_*`; `login_failed` events | No automated alerting on anomalous login patterns |
| CC7.4 | Responds to identified security incidents | Documented incident response procedure | `docs/INCIDENT_RESPONSE.md` | — |
| CC7.5 | Identifies and discloses disclosure requirements for security incidents | `/.well-known/security.txt`; `security@servicecycle.app`; customer breach notification thresholds and email template in `INCIDENT_RESPONSE.md`; GDPR Art. 33/34 + state breach-notification timelines documented | `server/index.ts`; `docs/INCIDENT_RESPONSE.md` §5 | — |

### CC8 — Change Management

| Criterion | Control | Evidence | Gap |
|---|---|---|---|
| CC8.1 | Manages changes to infrastructure, data, software, and procedures | All changes tracked in git; production deploys via documented runbook; migrations managed by Prisma | `docs/DEPLOY_RUNBOOK.md`; `server/prisma/migrations/`; git log | No PR approval requirement (single dev; founder approves by deploying) |

### CC9 — Risk Mitigation

| Criterion | Control | Evidence | Gap |
|---|---|---|---|
| CC9.1 | Identifies and assesses risks from business disruption | Backup + restore test; nightly backup with S3 off-host; **RTO target: ~2 hours** (rebuild droplet + restore latest dump); **RPO target: ~24 hours** (nightly `pg_dump` at 02:00 UTC, 30-day retention) | `server/lib/backup.ts`; `server/lib/restoreTest.ts`; `docs/DEPLOY_RUNBOOK.md` §Disaster Recovery | — |
| CC9.2 | Assesses and manages risks of vendors and business partners | Vendor security review template + approval record covering all current vendors (Anthropic, Resend, DigitalOcean, Google Gemini, Groq); DPA, SOC2, data-region, PII scope, and incident-notification SLA captured per vendor | `docs/VENDOR_SECURITY_REVIEW.md`; `docs/OFFBOARDING.md` §6 | — |

**Sub-processors / vendors:**

| Vendor | Purpose | Data processed | SOC 2? |
|---|---|---|---|
| DigitalOcean | VPS hosting | All customer data at rest + in transit | SOC 2 Type II |
| Brevo (Sendinblue) | Transactional email | Email addresses, names | ISO 27001 |
| Resend | Inbound email webhook | Test report attachments | SOC 2 Type II (in progress) |
| Cloudflare | CDN / DDoS protection / DNS | IP addresses; no request body | SOC 2 Type II |
| Backblaze / S3-compatible | Encrypted backup storage | Encrypted backup archives | Varies by configured target |
| AI provider (customer-supplied BYO) | Test report extraction (optional) | Test report text | Customer's own agreement |

---

## Availability (A1)

| Criterion | Control | Evidence | Gap |
|---|---|---|---|
| A1.1 | Maintains current processing capacity | 2 GB RAM droplet; monitored via `GET /api/health` | Health check uptime ~seconds | No formal capacity planning |
| A1.2 | Monitors system capacity | Health endpoint; Better Stack heartbeat wired | `server/lib/betterStack.ts`; `GET /api/health` | Uptime alerting threshold not yet configured in Better Stack |
| A1.3 | Backs up and recovers data | Nightly encrypted S3 backup; automated restore test 1st of month | `server/lib/backup.ts`; `server/lib/restoreTest.ts`; `server/lib/backupCrypto.ts` | Backup destination credentials must be configured in `.env` |

---

## Confidentiality (C1)

| Criterion | Control | Evidence | Gap |
|---|---|---|---|
| C1.1 | Identifies and maintains confidential information | Customer data scoped to account; secrets encrypted; AI identifiers scrubbed | `server/lib/docCrypto.ts`; `server/lib/redact.ts` `redactEmail` | Data classification policy not yet written as standalone doc |
| C1.2 | Disposes of confidential information | Account export + deletion path; GDPR deletion-on-request via `support@servicecycle.app`. Export includes all structured data: assets, work orders, deficiencies, quote requests, arc-flash studies + labels, LOTO procedures, parts catalog, spare inventory, and asset part requirements | `GET /api/export/account`; `docs/OFFBOARDING.md` | Automated data-retention enforcement (e.g. prune records older than N years) not yet implemented |

---

## Gaps and prioritized next steps

Ordered by impact on an acquirer or enterprise customer's security review:

1. **Automated uptime alerting** — configure Better Stack alert thresholds (30-minute task; no code needed). Closes A1.2 gap.
2. ~~**Automated SCA / CVE scanning**~~ — ✅ CLOSED. `npm audit --audit-level=high` in CI; `.github/dependabot.yml` monitors server, client, and GitHub Actions weekly. Closes CC5.2 + CC7.1 gap.
3. ~~**CI pipeline**~~ — ✅ CLOSED. `.github/workflows/ci.yml` runs `tsc --noEmit + jest` (unit + integration) + `npm audit` on every PR. Closes CC5.3 gap.
4. **Data retention enforcement** — add a scheduled job to prune records older than the configured retention window. Closes C1.2 gap.
5. ~~**Formal risk register**~~ — ✅ CLOSED. `docs/RISK_REGISTER.md` documents 10 risks with L×I scoring, mitigations, residual scores, owners, and quarterly review cadence. Closes CC3.2 gap.
6. ~~**Key rotation runbook**~~ — ✅ CLOSED. `docs/KEY_ROTATION.md` documents zero-downtime rotation for `JWT_SECRET` (dual-verify window), `MASTER_KEY`/`ENCRYPTED_KEYS`, and `BACKUP_ENCRYPTION_KEY`. Closes CC6.8 gap.
7. ~~**Vulnerability remediation SLA**~~ — ✅ CLOSED. Critical ≤24h / High ≤7d / Medium ≤30d / Low next sprint; documented in CC4.2 row above. Closes CC4.2 gap.
8. ~~**Customer breach notification template**~~ — ✅ CLOSED. Thresholds + email template in `docs/INCIDENT_RESPONSE.md` §5. Closes CC7.5 gap.
9. ~~**RTO/RPO targets**~~ — ✅ CLOSED. RTO ~2h / RPO ~24h documented in `docs/DEPLOY_RUNBOOK.md` and CC9.1 row above. Closes CC9.1 gap.
10. ~~**Code of conduct / ethics policy**~~ — ✅ CLOSED. `docs/CODE_OF_CONDUCT.md` covers data integrity, confidentiality, least-privilege, and breach reporting obligations. Closes CC1.1 gap.
11. ~~**Privacy policy URL**~~ — ✅ CLOSED. Publicly accessible at `/privacy` + `/legal/privacy`; attorney review pending before formal publication. Closes CC2.2 gap.
12. **SOC 2 Type II evidence collection** — begin 6-month clock once Type I readiness is confirmed.
