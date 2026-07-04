# Security Awareness Training Log

**Purpose:** SOC 2 CC1.4 / CC2.2 require that individuals with production access acknowledge the security program and complete periodic awareness training. Even in a solo-founder company, auditors want to see this control exist and be dated.

**Cadence:** annually, or on any material change to the security posture (new policy, new class of data, first employee/contractor).

---

## Training curriculum

Each annual training reviews:

1. **Policies read and re-acknowledged**
   - `docs/CODE_OF_CONDUCT.md`
   - `docs/PERSONNEL_SECURITY.md`
   - `docs/INCIDENT_RESPONSE.md`
   - `docs/security/ENDPOINT_SECURITY.md`
   - `SECURITY.md`

2. **Threat awareness**
   - Phishing patterns targeting founders (fake-invoice, fake-DMCA, fake-Stripe, fake-domain-renewal).
   - Credential theft via infostealer malware in cracked software / browser extensions.
   - Social engineering by targeting spouse / family / friends for pretext.

3. **Data handling recap**
   - What customer data ServiceCycle stores (see `docs/security/DATA_CLASSIFICATION.md`).
   - What must never leave a production system (customer PII, uploaded test reports, API keys).
   - What must never enter a production system (personal secrets, unrelated business data).

4. **Access hygiene**
   - Confirm MFA is on for every account in the secrets inventory (`docs/security/SECRETS_INVENTORY.md`).
   - Confirm password manager is used and has a strong master passphrase.
   - Confirm none of the accounts share credentials with any other service.

5. **Incident response readiness**
   - Reread `docs/INCIDENT_RESPONSE.md` severity matrix.
   - Confirm ability to reach `security@servicecycle.app` mailbox.
   - Reread the customer breach notification template.

---

## Log

| Date | Person | Curriculum version | Duration | Outcome | Evidence file |
|---|---|---|---|---|---|
| 2026-07-04 | Dustin | 1.0 (this doc, initial) | 30 min | Policies re-read; MFA verified on GH + DO + Cloudflare; no gaps found | `docs/compliance/evidence/2026-07/security-awareness-training-2026-07-04.md` |

## Next scheduled

**2027-07-04** — annual re-training. Set a calendar reminder.

## When a second person joins

- Add their row to the log on their onboarding date.
- Add them to `docs/PERSONNEL_SECURITY.md` as an authorized production-access individual.
- They complete the full curriculum before receiving any production credential.
