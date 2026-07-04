# ServiceCycle — Vendor Security Review Template

**Version:** 1.1
**Effective date:** 2026-07-04 (v1.1 adds failure-mode column + AI provider rows)
**Next review:** 2027-07-04
**Owner:** Engineering / Operations
**Applies to:** Any new vendor or sub-processor that will receive, store, or process
ServiceCycle customer data or have access to production infrastructure.

This document closes SOC2 CC9.2 (assesses and manages risks of vendors and business
partners). For a list of current approved vendors, see `docs/OFFBOARDING.md` §6
(sub-processor list). For dated review cadence, see `docs/compliance/VENDOR_REVIEW_LOG.md`.

---

## Criteria for a full review

A full security review is required before onboarding a vendor that:

- Receives PII (names, emails, addresses) from ServiceCycle customers
- Has access to production infrastructure (VPS, DB, CI/CD secrets)
- Processes arc-flash study data or NFPA compliance records
- Is a single point of failure for a core feature (email delivery, AI inference, backup)

Low-risk integrations (e.g. a CDN for static assets, an analytics SDK with no PII) may
be approved by the Engineering owner without a full review; document the rationale below.

---

## Vendor questionnaire

### 1. Identity and compliance posture

| Question | Response |
|---|---|
| Company name and registered entity | |
| Primary security contact (email) | |
| SOC 2 Type II, ISO 27001, or equivalent certification? | |
| Certification expiry / last audit date | |
| GDPR Data Processing Agreement (DPA) available? | |
| Sub-processors list available? | |

### 2. Data handling

| Question | Response |
|---|---|
| What customer data will this vendor receive? | |
| In what country/region is data stored? | |
| Is data encrypted at rest? At transit? (specify algorithms) | |
| What is the retention window and deletion SLA for our data? | |
| Can the vendor provide a data deletion confirmation on request? | |

### 3. Access control

| Question | Response |
|---|---|
| Is MFA required for vendor-side access to our data? | |
| Is access to production systems limited to named individuals? | |
| Are access logs available on request? | |

### 4. Incident notification

| Question | Response |
|---|---|
| SLA to notify ServiceCycle of a breach affecting our data | |
| Security incident contact email | |

### 5. Business continuity

| Question | Response |
|---|---|
| Published uptime SLA (%) | |
| Status page URL | |
| Documented RTO/RPO for the service | |

---

## Approval record

| Vendor | Category | Reviewer | Date | Outcome | Notes |
|---|---|---|---|---|---|
| **Anthropic Claude** | AI inference | Engineering | 2026-06-25 | ✅ Approved | No PII sent; prompts contain asset metadata only; DPA available; SOC 2 Type II certified |
| **Resend** | Transactional email | Engineering | 2026-06-25 | ✅ Approved | Recipient email + notification content; GDPR DPA signed; SOC 2 Type II; data stored US |
| **DigitalOcean** | IaaS / hosting | Engineering | 2026-06-25 | ✅ Approved | Full infrastructure provider; SOC 2 Type II; GDPR DPA; data center: NYC; DO Managed DB upgrade path documented in RISK_REGISTER.md R-03 |
| **Google Gemini** | AI inference (fallback) | Engineering | 2026-06-25 | ✅ Approved | Cascade fallback only; no PII; API data not used for training (enterprise API terms) |
| **Groq** | AI inference (cascade) | Engineering | 2026-06-25 | ✅ Approved | Cascade fallback only; no PII; review on renewal |
| **Cloudflare** | CDN / DNS / WAF | Engineering | 2026-06-25 | ✅ Approved | Origin proxy + DNS + free-tier WAF; SOC 2 Type II; data region: global edge |
| **Backblaze B2** (or configured S3 target) | Encrypted backup storage | Engineering | 2026-06-25 | ✅ Approved | Ciphertext-only storage (client-side AES-256-GCM); provider sees encrypted blobs; SOC 2 varies by target |
| **GitHub** | Source + CI + secrets | Engineering | 2026-06-25 | ✅ Approved | Repo + Actions + secrets; SOC 2 Type II; MFA enforced on account |
| **Better Stack** | Uptime + heartbeat | Engineering | 2026-07-04 | ✅ Approved | Low-sensitivity data (health probe metadata only); no customer PII |

---

## Failure-mode matrix

For every vendor, name the concrete data they receive, the failure mode we should expect if they go down, and our fallback. This closes the "what if they go down?" column requested in the readiness checklist (J4).

| Vendor | Data they receive | Most probable failure mode | Blast radius | Fallback / mitigation |
|---|---|---|---|---|
| **DigitalOcean** | All customer data at rest + in transit through the droplet | Regional outage; single-droplet failure | Full ServiceCycle outage until DO recovers or we rebuild in a different region | RTO ~2h droplet rebuild from S3 backup + DNS switch; see `docs/security/BC_PLAYBOOKS.md` Playbook 1 |
| **Cloudflare** | Request metadata (IPs, headers); no request body access | DNS or edge outage; WAF false-positive block | Depends on scope; DNS out ⇒ total outage; edge out ⇒ regional | Bypass Cloudflare temporarily via direct-to-origin DNS switch at registrar (documented in Playbook 3) |
| **Brevo / Resend** | Recipient email addresses + notification contents | Provider outage; deliverability degradation | Delayed customer notifications; no data loss | Secondary provider standby (documented in Playbook 5); queue email locally with retry |
| **Backblaze B2 / S3 target** | Encrypted backup archives (ciphertext only) | Provider outage; account suspension | Backups cannot be written or restored; **data at rest in Postgres is unaffected** | 30-day rolling backup on target; multi-target redundancy is a Year-2 control per RISK_REGISTER |
| **GitHub** | Full source; CI logs; workflow secrets | Provider outage; account compromise (Playbook 6) | Cannot ship changes until GH recovers; production keeps running | Manual deploy from workstation using `docs/DEPLOY_RUNBOOK.md`; hotfix without CI is a documented bypass |
| **Anthropic / Gemini (customer BYO)** | Customer's own prompts (may include Tier-3 data per customer choice) | Provider outage; retention policy change | Customer's AI features degraded on their key; SC free-tier fallback still works | Customer's DPA governs; SC cascade in `server/lib/ai.ts` handles provider swap |
| **Google Gemini (SC free-tier)** | PII-scrubbed prompts only | Provider outage; free-tier throttle | Free-tier scan meter reduced | Cascade to Groq; documented in Playbook 5 |
| **Groq (SC free-tier)** | PII-scrubbed prompts only | Provider outage | Free-tier scan meter reduced | Cascade back to Gemini |
| **Better Stack** | Health-check response codes; no customer data | Provider outage | Uptime monitoring blind; alerts stop | Healthchecks.io as secondary heartbeat; nightly cron still runs |
| **Password manager** | All vendor credentials + `MASTER_KEY` copy + `JWT_SECRET` copy + `BACKUP_ENCRYPTION_KEY` copy | Provider outage (temporary lockout); account compromise (catastrophic) | Cannot authenticate to vendors until restored | Recovery vault + printed recovery key held physically; MFA on password-manager account |

---

## Notes for new vendor onboarding

1. Add the vendor to the sub-processor list in `docs/OFFBOARDING.md` §6 before going live.
2. If the vendor receives PII, ensure a signed DPA is on file and note the DPA date in the approval record above.
3. Add the vendor to the active risk register (`docs/RISK_REGISTER.md`) if it represents a new single-point-of-failure dependency.
4. **Add a row to the failure-mode matrix above** — name what data they receive, what happens when they fail, and what our fallback is.
5. Add a row to `docs/compliance/VENDOR_REVIEW_LOG.md` with the initial-review date and next-review date.
6. Re-review annually or when the vendor undergoes a material change (acquisition, new data region, new product scope).
