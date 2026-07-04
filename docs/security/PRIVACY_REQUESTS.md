# Privacy Request Handling

**Purpose:** the operational process for handling a data-subject request (export, deletion, correction, portability). SOC 2 P3 / P4 evidence and GDPR / CCPA compliance.

**Version:** 1.0
**Effective date:** 2026-07-04
**Owner:** Dustin
**SLA:** initial acknowledgment within 3 business days; completion within 30 days (target: 7 days).
**Anchor docs:** `docs/OFFBOARDING.md` §6 (operational script); `docs/compliance/DATA_RETENTION_MATRIX.md` (what gets deleted).

---

## Request types SC honors

| Type | Description | GDPR term | CCPA term |
|---|---|---|---|
| **Access / export** | Provide the requester a complete copy of their personal data | Right of access (Art. 15) | Right to know |
| **Erasure / deletion** | Delete the requester's personal data | Right to erasure (Art. 17) | Right to delete |
| **Correction / rectification** | Correct inaccurate personal data | Right to rectification (Art. 16) | Right to correct |
| **Portability** | Provide personal data in machine-readable format | Right to portability (Art. 20) | Right to portability |
| **Restrict processing** | Stop processing while a dispute is resolved | Right to restriction (Art. 18) | Limited use |
| **Object to processing** | Object to processing that relies on legitimate interest | Right to object (Art. 21) | Opt-out |

## Intake

- **Primary channel:** `support@servicecycle.app` (also serves as the DPO contact until a formal DPO is designated).
- **Secondary channel:** in-app request form (planned; not yet implemented).
- **Acknowledged from:** `security@servicecycle.app` or `support@servicecycle.app`.

Every request that references personal data — even if it doesn't use the specific legal term — is treated as a privacy request.

## Verification of the requester

Before any action is taken:

1. **Must originate from an admin user email of the account** OR the personal email of the specific user whose data is at issue.
2. If the request originates from a different email, we require verification: reply from a known admin, or a two-factor challenge via the account's registered channel.
3. If we cannot verify within 15 business days, we decline the request and document the decline.

Rationale: acting on an unverified deletion request would itself be a data incident.

## Timelines

| Milestone | Standard SLA | Target |
|---|---|---|
| Acknowledge receipt | 3 business days | Same day |
| Verify requester identity | 5 business days | 3 business days |
| Complete export | 30 days | 7 business days |
| Complete deletion (live systems) | 30 days | 7 business days |
| Backup age-out | 30 days from live delete | Automatic (S3 lifecycle) |
| Confirmation to requester | Within 3 business days of completion | Same day |

## Operational script

### Export request

1. Verify requester per §Verification.
2. Trigger `GET /api/export/account` while impersonating the account's admin user (or use the admin-tool equivalent).
3. Receive JSON bundle of all structured data: users, assets, sites, work orders, deficiencies, quote requests, arc-flash studies + labels, LOTO procedures, parts catalog, spare inventory, asset part requirements.
4. If uploaded files (test reports) are in scope, retrieve from storage and package alongside.
5. Encrypt the bundle with a one-time passphrase; send bundle to requester; send passphrase out-of-band (different channel from the bundle).
6. Log the export event in the audit chain (`data_subject_export`, CEF sev 6) with requester identity, scope, and volume.
7. Delete the bundle from staging within 7 days.

### Deletion request

1. Verify requester.
2. Confirm scope with requester (whole account? one user? a specific record set?).
3. Execute deletion:
   - If **whole account:** initiate account close flow; hard-delete after 30-day grace unless requester wants faster (in which case immediate hard-delete on written confirmation).
   - If **one user:** delete the user record + sign them out of all sessions; leave the account intact.
   - If **specific records:** targeted delete + audit chain entries redacted (payload only; `rowHash`/`prevHash` preserved so chain still verifies).
4. Confirm to the requester with a completion timestamp.
5. Log the deletion event in the audit chain (`data_subject_erasure`, CEF sev 7) with requester identity, scope, and record counts.
6. Backup archives age out automatically within 30 days.

### Correction request

1. Verify requester.
2. Confirm the exact field and the corrected value.
3. Update via admin console (audit-logged automatically).
4. Confirm to the requester.

### Portability request

Treated as an export request with the additional requirement that the format is standard (JSON per SC's export bundle; CSV on request).

### Restriction / objection

1. Verify requester.
2. Note the restriction in the account record.
3. If restriction affects processing (e.g., customer objects to free-tier AI inference on their data), toggle the per-account AI enable flag off.
4. Confirm to the requester with the concrete effect.

## What we cannot delete

- **The row itself in the audit chain**, only its payload. The `rowHash`/`prevHash` remain so chain verification still passes. This design choice is documented in `AUDIT_LOG_ARCHITECTURE.md` and `DATA_RETENTION_MATRIX.md`.
- **Historical backups already off-site** past the 30-day rolling window — but by then the backup has already aged out per the lifecycle policy.
- **Aggregate anonymized metrics** derived from the customer's data and used for internal service metrics.

## Evidence

Every privacy request generates:

- An entry in the audit chain (`data_subject_*` action).
- A dated file in `docs/compliance/evidence/YYYY-MM/privacy-request-YYYY-MM-DD-<requester-hash>.md` with:
  - date received
  - type of request
  - verification method used
  - actions taken
  - completion timestamp
  - requester identity redacted to a hash (for the evidence file only; the audit chain retains identity for internal traceability).

## Escalation

If a request is contested (SC believes it must decline, e.g., cannot verify requester after 15 business days, or the data is required for legal defense):

1. Written response to the requester citing the specific ground.
2. Provide the DPA / GDPR complaint channel.
3. Log the declination in the audit chain with the reason.

## Change triggers

- New jurisdiction with additional data-subject rights (Brazil LGPD, etc.).
- Formal DPO appointment.
- New regulated data class stored (health data would materially change scope).
