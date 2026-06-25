# ServiceCycle — Vendor Security Review Template

**Owner:** Engineering / Operations  
**Applies to:** Any new vendor or sub-processor that will receive, store, or process
ServiceCycle customer data or have access to production infrastructure.

This document closes SOC2 CC9.2 (assesses and manages risks of vendors and business
partners). For a list of current approved vendors, see `docs/OFFBOARDING.md` §6
(sub-processor list).

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

---

## Notes for new vendor onboarding

1. Add the vendor to the sub-processor list in `docs/OFFBOARDING.md` §6 before going live.
2. If the vendor receives PII, ensure a signed DPA is on file and note the DPA date in the approval record above.
3. Add the vendor to the active risk register (`docs/RISK_REGISTER.md`) if it represents a new single-point-of-failure dependency.
4. Re-review annually or when the vendor undergoes a material change (acquisition, new data region, new product scope).
