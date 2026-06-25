# ServiceCycle Pilot — Statement of Work

**Version:** 1.0  
**Prepared by:** ServiceCycle  
**Prepared for:** [CONTRACTOR COMPANY NAME]  
**Date:** [DATE]  
**Pilot Duration:** 90 days from onboarding completion  

---

## 1. Purpose

This Statement of Work describes the scope, deliverables, and mutual obligations for a 90-day ServiceCycle pilot program. The goal of the pilot is to demonstrate that ServiceCycle can ingest [CONTRACTOR COMPANY NAME]'s existing test reports, build a live NFPA 70B maintenance program for [NUMBER] customer sites, and surface deficiency-driven quote opportunities within the pilot period.

This SOW does not constitute a long-term service agreement. Either party may decline to continue at the end of the pilot period without obligation.

---

## 2. Pilot Scope

### 2.1 Sites included in pilot
The pilot will cover the following customer sites:

| Site Name | Equipment Count (est.) | Primary Equipment Types |
|---|---|---|
| [SITE 1] | [~N] | [e.g., Switchgear, Transformers] |
| [SITE 2] | [~N] | |
| [SITE 3 — optional] | [~N] | |

### 2.2 What is in scope
- Ingestion of existing test reports (PDF format, any origin: PowerDB, Megger, Word-based)
- Automated extraction of equipment records, test results, condition ratings, and deficiencies
- NFPA 70B maintenance schedule generation for all extracted assets
- Deficiency tracking (open/resolved status, severity, linked work orders)
- Arc-flash label data entry and study-expiry tracking for sites with existing IEEE 1584 studies
- Customer leave-behind report generation
- Fleet Dashboard access for contractor admin view across all pilot sites
- Field Tech mobile access for one (1) field technician

### 2.3 What is out of scope
- Arc-flash energy calculations (these must be performed by a licensed PE using IEEE 1584-compliant software)
- CMMS integration or API-based data sync (available post-pilot via the v1 API)
- Custom report templates
- Training beyond the onboarding guide and one 60-minute kickoff call

---

## 3. Deliverables and Timeline

| Week | Milestone | Owner |
|---|---|---|
| Week 1 | Account created, admin user onboarded, first site configured | ServiceCycle |
| Week 1 | First 2–3 test reports uploaded and reviewed | [CONTRACTOR] |
| Week 2 | All pilot-site reports ingested, data reviewed and corrected | [CONTRACTOR] |
| Week 2 | Field tech invited and mobile access confirmed | [CONTRACTOR] |
| Week 3 | First outage plan generated and reviewed | [CONTRACTOR] |
| Week 4 | First customer leave-behind generated | [CONTRACTOR] |
| Week 8 | Mid-pilot check-in call (30 min) | Both |
| Week 12 | Pilot wrap-up call — review deficiencies surfaced, quote requests generated, feedback | Both |

---

## 4. Success Criteria

The pilot will be considered successful if, by the end of 90 days:

1. All test reports for pilot sites have been ingested with ≥ 90% equipment record accuracy (verified by contractor spot-check)
2. At least one customer leave-behind has been generated and reviewed
3. At least one outage plan has been generated from the deficiency/schedule data
4. The contractor has identified at least [N] open deficiencies that represent potential quote opportunities

Success criteria are informational — they are not contractual acceptance criteria. They exist to give both parties a clear basis for the post-pilot evaluation conversation.

---

## 5. Pricing and Terms

### 5.1 Pilot pricing
The 90-day pilot is provided at **no cost** to [CONTRACTOR COMPANY NAME].

### 5.2 Post-pilot pricing
If [CONTRACTOR COMPANY NAME] elects to continue after the pilot, pricing will be offered based on the number of active sites and the service tier. Standard pricing is available at servicecycle.app/pricing.

### 5.3 Data ownership
All data uploaded to ServiceCycle during the pilot — including test reports, equipment records, and extracted data — remains the property of [CONTRACTOR COMPANY NAME] and/or their end customers. Data may be exported at any time via the Export function or the v1 API.

### 5.4 Confidentiality
Both parties agree to keep the existence and terms of this pilot confidential. ServiceCycle will not reference [CONTRACTOR COMPANY NAME] in marketing materials without written consent.

---

## 6. Mutual Obligations

### ServiceCycle will:
- Provide access to the platform within 2 business days of SOW signature
- Respond to support requests within 1 business day during the pilot period
- Maintain platform uptime per the published status page
- Not use customer data for training AI models or any purpose other than providing the service

### [CONTRACTOR COMPANY NAME] will:
- Designate one primary admin contact for the pilot
- Complete the Day 1 onboarding steps within 5 business days of account creation
- Provide honest feedback at the mid-pilot and wrap-up calls
- Notify ServiceCycle of data quality issues as they are discovered (not saved for the end)

---

## 7. Signatures

| | ServiceCycle | [CONTRACTOR COMPANY NAME] |
|---|---|---|
| **Name** | | |
| **Title** | | |
| **Date** | | |
| **Signature** | | |
