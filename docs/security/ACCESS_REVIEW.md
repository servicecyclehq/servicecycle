# Access Review Procedure

**Version:** 1.0
**Effective date:** 2026-07-04
**Next review:** 2027-07-04
**Owner:** Dustin
**SOC 2 mapping:** CC6.1 / CC6.3 / CC6.4 (logical access, least privilege, change management).
**Cadence:** quarterly. Also on any material access event (contractor onboarding/offboarding, credential rotation).

**Companion:** `docs/security/ASSET_INVENTORY.md` (what accounts exist), `docs/security/SECRETS_INVENTORY.md` (what credentials exist), `docs/security/PERMISSIONS_MATRIX.md` (in-app roles).

---

## Purpose

Verify quarterly that:

1. Every account that has access to ServiceCycle production, source, or vendor systems is **still supposed to have that access**.
2. Every account still has MFA on.
3. Nothing has been silently added since the last review.
4. Every SC user account (in the app) has the right role for their current function.

An auditor's question is "who has access to production, and when did you last verify?" This procedure answers it.

## Scope — every account per the following checklist

### Vendor accounts (per `SECRETS_INVENTORY.md`)

| Account | Verify |
|---|---|
| GitHub org owner | Member list; MFA required for org; SSH + GPG keys still current; no unexpected deploy tokens |
| DigitalOcean | Team member list; MFA on account; SSH keys authorized to droplet |
| Cloudflare | User list; MFA on account; API tokens list; no unexpected API tokens |
| Domain registrar | Contact list; MFA on account; registrar-lock still on |
| Brevo / Resend | Team list; MFA; API keys list |
| Backblaze / S3 target | Team list; MFA; access-key list; bucket policies |
| Better Stack | User list; MFA; API tokens |
| Password manager | Account list; MFA + recovery vault; no unexpected shared vaults |
| Email provider (mailbox) | Forwarding rules; delegated access list; MFA |

### ServiceCycle in-app accounts

Run this query against prod (via activity chain export or admin console):

- List every user with role `admin` or `super_admin`.
- Confirm each still needs that role.
- Confirm `mfaEnrolled=true` for every admin (if `MFA_REQUIRED_FOR_ADMINS=true`, this should be enforced automatically — verify anyway).
- Confirm no user's `tokenEpoch` has been silently bumped without an audit record.

### Workstation / SSH

- List of SSH keys authorized on the droplet (`/root/.ssh/authorized_keys` + any non-root user).
- Confirm each key belongs to a currently-authorized workstation.
- Rotate keys older than 24 months per `SECRETS_INVENTORY.md` cadence.

---

## Procedure (do this each quarter — 30 minutes)

1. **Create the evidence file** at `docs/compliance/evidence/YYYY-QN/access-review-YYYY-MM-DD.md` from the frontmatter template.

2. **Vendor accounts sweep**: for each account in the table above, log in from a clean session, take a screenshot of the member list and MFA setting. Save screenshots inline in the evidence file or reference by filename in the frontmatter `artifacts` list.

3. **In-app user sweep**: export the current user list from the admin console. Filter for `admin` and `super_admin` roles. For each row, confirm the assignment is still correct. Attach the export to the evidence file.

4. **SSH sweep**: `cat /root/.ssh/authorized_keys` and paste (fingerprints only, not full keys) into the evidence file. Confirm each fingerprint is documented in `SECRETS_INVENTORY.md`.

5. **Password manager sweep**: open password manager; confirm no unexpected shared items; take a screenshot of the account list.

6. **Reconcile with `SECRETS_INVENTORY.md`**: does every account listed there still exist? Does every account NOT listed there need to be added?

7. **Fill in the evidence file's summary and outcome fields** in the frontmatter.

8. **Sign and date** the evidence file. Commit it.

9. **Update `docs/security/SECURITY_AWARENESS_TRAINING_LOG.md`** if any change to access changes what's covered in training.

10. **If anything unexpected was found**, open a corresponding incident record in `docs/compliance/incidents/` and follow the incident response plan.

---

## Evidence template

Copy this into `docs/compliance/evidence/YYYY-QN/access-review-YYYY-MM-DD.md`:

```markdown
---
date: YYYY-MM-DD
reviewer: Dustin
scope: Quarterly access review — YYYY-QN
outcome: pass | issues-found
next-review: <next quarter's target date>
artifacts:
  - github-members-YYYY-MM-DD.png
  - do-team-YYYY-MM-DD.png
  - cloudflare-users-YYYY-MM-DD.png
  - registrar-contacts-YYYY-MM-DD.png
  - email-forwarding-YYYY-MM-DD.png
  - s3-team-YYYY-MM-DD.png
  - better-stack-users-YYYY-MM-DD.png
  - password-manager-accounts-YYYY-MM-DD.png
  - sc-admin-users-export-YYYY-MM-DD.csv
  - ssh-authorized-fingerprints-YYYY-MM-DD.txt
---

## Vendor accounts reviewed

- [x] GitHub — 1 member (Dustin), MFA on, no unexpected deploy tokens.
- [x] DigitalOcean — 1 member, MFA on, SSH keys match `SECRETS_INVENTORY.md`.
- [x] Cloudflare — 1 user, MFA on, N API tokens (all justified).
- [x] Domain registrar — 1 contact, MFA on, registrar-lock on.
- [x] Brevo / Resend — 1 user, MFA on.
- [x] Backblaze / S3 target — 1 user, MFA on, access keys rotated within 6mo.
- [x] Better Stack — 1 user, MFA on.
- [x] Password manager — 1 account, MFA on, recovery vault verified.

## In-app admins

Current admins: <count>. Superadmins: <count>. Every admin has MFA enrolled. No unexpected roles.

## SSH keys

<fingerprint list, one per line, each cross-referenced to SECRETS_INVENTORY.md>

## Findings

- (none) — or list issues.

## Actions

- (none) — or list follow-ups with owners + dates.

## Approval

Reviewed and signed by Dustin on YYYY-MM-DD.
```

---

## What triggers an out-of-cadence review

Do a targeted access review immediately (not waiting for quarter end) if:

- A workstation is lost or compromised (Playbook 7).
- A vendor account shows an unauthorized-login alert.
- A contractor or employee departs.
- A credential appears in a breach dump.
- We add a new vendor with production data access.

Out-of-cadence reviews are logged in the same evidence pattern with `outcome: out-of-cadence` in the frontmatter.

---

## Automation opportunities (future)

- Script that dumps SC admin user list + MFA status to a text file (one command).
- Script that lists SSH fingerprints via `ssh-keygen -lf` for each key.
- Script that runs the retention sweeper's "who has admin" query and outputs a CSV.

None of these blocks the manual review — they just speed it up. Track as follow-ups when time permits.
