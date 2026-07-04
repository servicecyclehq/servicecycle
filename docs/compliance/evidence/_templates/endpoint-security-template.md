---
date: YYYY-MM-DD
reviewer: Dustin
scope: Quarterly endpoint security verification — YYYY-QN
outcome: pass | issues-found
next-review: <first day of next quarter>
artifacts:
  - bitlocker-status-YYYY-MM-DD.png
  - screen-lock-setting-YYYY-MM-DD.png
  - windows-update-YYYY-MM-DD.png
  - defender-status-YYYY-MM-DD.png
  - account-type-YYYY-MM-DD.png
---

# Endpoint Security Verification — YYYY-QN

Follows `docs/security/ENDPOINT_SECURITY.md` §2 baseline requirements.

## Workstation checked

- **Hostname**: <hostname>
- **OS + version**: Windows 11 / macOS X.Y.Z / Ubuntu N.N
- **User account under review**: Dustin (founder)

## Baseline checks

| # | Control | Status | Evidence |
|---|---|---|---|
| 1 | Full-disk encryption (BitLocker / FileVault / LUKS) | ✅ | `bitlocker-status-YYYY-MM-DD.png` |
| 2 | OS auto-updates enabled + current within 30 days | ✅ | `windows-update-YYYY-MM-DD.png` |
| 3 | Endpoint anti-malware enabled | ✅ | `defender-status-YYYY-MM-DD.png` |
| 4 | Screen lock ≤15 min inactivity | ✅ | `screen-lock-setting-YYYY-MM-DD.png` |
| 5 | Strong login credential (password ≥12 or biometric) | ✅ | Posture-only (no screenshot) |
| 6 | Day-to-day account privileges (compensating control acknowledged) | ✅ (per RAR-006) | `account-type-YYYY-MM-DD.png` |
| 7 | No unencrypted DB dumps on local disk | ✅ | Command: `Get-ChildItem -Recurse -Include *.sql,*.dump C:\` returns 0 |

## Solo-founder compensating controls (per §5 of policy)

Confirmed still in place per `docs/compliance/RISK_ACCEPTANCE_LOG.md` RAR-006:
- Full-disk encryption at rest ✅
- Password manager + MFA on every vendor ✅
- All production actions in audit chain ✅
- Secrets never in plaintext files ✅

## Anomalies

- (none) — or list.

## Actions

- (none) — or list follow-ups.

## Approval

Verified by Dustin on YYYY-MM-DD.
