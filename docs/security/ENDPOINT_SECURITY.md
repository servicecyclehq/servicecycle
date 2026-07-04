# Endpoint Security Policy

**Version:** 1.0
**Effective date:** 2026-07-04
**Owner:** Dustin (founder)
**Next review:** 2027-01-04
**Applies to:** every workstation with access to ServiceCycle production, source, or customer data.

---

## 1. Scope

The endpoint policy applies to:

- Founder workstation(s) used for coding, deploying, or accessing production.
- Any future contractor or employee workstation that will access source or production.
- Mobile devices are **out of scope** at this stage — no production access from mobile is authorized.

## 2. Baseline requirements

Every in-scope workstation must have all of the following enabled at all times:

| # | Control | How verified | Evidence artifact |
|---|---|---|---|
| 1 | **Full-disk encryption** (BitLocker on Windows, FileVault on macOS, LUKS on Linux) | `manage-bde -status` on Windows; `fdesetup status` on macOS | Screenshot in `docs/compliance/evidence/YYYY-MM/endpoint-security-YYYY-MM-DD.md` |
| 2 | **OS auto-updates** enabled and current within 30 days | Settings > Windows Update, or `softwareupdate --list` on macOS | Screenshot |
| 3 | **Endpoint anti-malware** enabled (Windows Defender is acceptable) | Windows Security > Virus & threat protection | Screenshot |
| 4 | **Screen lock** with auto-lock after ≤15 minutes of inactivity | Settings > Personalization > Lock screen (Windows) or Security & Privacy (macOS) | Screenshot |
| 5 | **Strong login credential** — password ≥12 chars OR Windows Hello / Touch ID | Login process visible when awakening from lock | N/A (posture only) |
| 6 | **Local admin used only for install** — day-to-day work is under a standard-privilege account **OR** the founder-solo compensating control (see §5) is invoked | User account type in OS settings | Screenshot |
| 7 | **No local unencrypted copies of production DB dumps** — dumps are encrypted at rest per `docs/KEY_ROTATION.md` | Grep local drive for `*.sql`, `*.dump` | Log line in evidence file |

## 3. Cadence

- **Quarterly** — take fresh screenshots of items 1–4 above and drop them into `docs/compliance/evidence/YYYY-QN/endpoint-security-YYYY-MM-DD.md` with the frontmatter template.
- **On any workstation change** — new laptop, OS reinstall, contractor onboarding — repeat the full checklist and archive fresh evidence.
- **Immediately** — if endpoint anti-malware raises an alert, treat as a P2 incident per `docs/INCIDENT_RESPONSE.md` and log it under `docs/compliance/incidents/`.

## 4. Prohibited on production-access workstations

- Browser extensions that read all sites (crypto wallets, uncertified assistants).
- Personal cloud sync of source-controlled paths (Dropbox / OneDrive on the SC repo folder).
- Physically leaving the workstation unlocked in a location where a third party could access it.

## 5. Solo-founder compensating controls

At current stage, the founder operates as sole administrator on the workstation. This is a documented deviation from "least-privilege day-to-day account" per SOC 2 CC6.3. Compensating controls:

- Full-disk encryption at rest (item 1).
- Strong login credential (item 5).
- Endpoint anti-malware always on (item 3).
- Every action against production is captured in the SC audit log (`server/lib/activityLogChain.ts`, tamper-evident) and in git history — a compromised workstation would produce reviewable evidence.
- The MASTER_KEY, JWT_SECRET, and cloud provider credentials are stored in a password manager, not in plaintext files, and never in the SC repository.

This compensating-controls note is the answer to any auditor question of the form "how do you enforce separation of admin vs. daily user on a one-person team."

## 6. Failure mode

If the workstation is lost, stolen, or believed compromised:

1. Rotate `JWT_SECRET` following the zero-downtime dual-verify procedure in `docs/KEY_ROTATION.md`.
2. Rotate `MASTER_KEY` and re-encrypt affected `ENCRYPTED_KEYS`.
3. Revoke and rotate all DigitalOcean, Cloudflare, GitHub, and email-provider credentials.
4. Force `tokenEpoch` bump for all admin users (invalidates all outstanding sessions).
5. File an incident record under `docs/compliance/incidents/` and communicate to customers if their data was accessible.
6. Order replacement hardware; do not restore a backup image of a compromised workstation.

## 7. Evidence archive

Latest endpoint-security evidence lives in `docs/compliance/evidence/YYYY-MM/endpoint-security-YYYY-MM-DD.md`. If the folder is empty at audit time, this policy is unproven.
