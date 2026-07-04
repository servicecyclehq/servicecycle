# Monitoring Matrix

**Purpose:** for every failure mode we care about, name the signal, the threshold, the alerting channel, and the runbook. SOC 2 CC4.1 / CC7.2 evidence.

**Version:** 1.0
**Effective date:** 2026-07-04
**Owner:** Dustin
**Review cadence:** quarterly.

Legend: 🟢 wired + active · 🟡 wired but not activated · 🔴 not wired

---

## Availability

| Signal | Detection | Threshold | Channel | Runbook | Status |
|---|---|---|---|---|---|
| Site is down (any HTTP failure at edge) | Better Stack synthetic probe on `/api/health` | 2 consecutive failures | Email + SMS | `DEPLOY_RUNBOOK.md` §Disaster Recovery | 🟡 wired, thresholds not activated |
| Origin unhealthy behind Cloudflare | Cloudflare origin health monitor | Any non-2xx on `/api/health` for 3 min | Email | Same | 🔴 |
| Nightly cron missed | Healthchecks.io heartbeat from `server/lib/heartbeat.ts` | Missed 2 consecutive nights | Email | "restart nightly backup cron" | 🟡 |
| Backup upload failed | `backup.ts` catches exception + writes activity chain event | Any failure | Email via `betterStack.ts` alert notifier | Redo backup + investigate | 🟡 |
| Restore-test failed | `restoreTest.ts` monthly job | Any failure | Email | Investigate before next backup window | 🟡 |

## Security

| Signal | Detection | Threshold | Channel | Runbook | Status |
|---|---|---|---|---|---|
| Repeated login failures for one email | `_recordLoginFail` in `auth.ts` | 5 fails / 15 min triggers 15-min lockout + `login_lockout_triggered` event | Admin can query activity chain; no push alert yet | Review event, decide whether to force password reset | 🟢 detection; 🔴 push alert |
| Repeated login failures across many emails from one IP | Per-IP rate limit + Cloudflare | Rate limiter blocks; no push | Cloudflare logs | Escalate to Cloudflare rule if sustained | 🟢 detection; 🔴 push alert |
| Permission-denied event (RBAC block) | Activity chain `permission_denied` (CEF sev 5) | Any burst >10/min for one user | Not currently alerted | Investigate targeted access attempt | 🟢 detection; 🔴 alert |
| Audit chain integrity break | Nightly verifier | Any break | Email; also blocks further writes for the affected account | Investigate + escalate to incident | 🟢 detection wired; 🟡 push alert |
| Admin action: encryption toggle | `encryption_enabled` / `encryption_disabled` (CEF sev 7) | Any occurrence | Not alerted (rare, expected admin action) | Confirm expected | 🟢 detection |
| Suspicious API-v1 usage | `api_v1_call` events with anomalous provider or cost | No automated threshold yet | Not alerted | Manual review; consider adding threshold | 🔴 |
| Endpoint anti-malware alert | Windows Defender / macOS XProtect | Any | Founder eyeballs | Treat as P2 incident per `INCIDENT_RESPONSE.md` | 🟢 (workstation-side) |
| Repeated password reset requests for one user | `password_reset_requested` events | ≥3 within 24h | Not alerted | Investigate | 🟢 detection; 🔴 alert |

## Vulnerability + supply chain

| Signal | Detection | Threshold | Channel | Runbook | Status |
|---|---|---|---|---|---|
| `npm audit` finds high/critical | `npm audit --audit-level=high` in CI | Any finding | CI build fails | Patch or accept; document in dependency-decisions | 🟢 |
| Dependabot PR open | Dependabot | Weekly grouped | GitHub notifications | Review + merge or defer | 🟢 |
| CodeQL alert (once enabled per SOC 2 Session 3) | GitHub code scanning | Any high/critical | GitHub notifications | Patch | 🔴 (planned) |
| Container CVE (once Trivy enabled) | Trivy in CI | High/critical | CI build fails | Patch base image or dep | 🔴 (planned) |
| Secret in commit (Gitleaks) | Gitleaks in pre-commit + CI | Any | CI fails; developer must remove | Rotate secret, purge history if pushed | 🔴 (planned) |

## Cost / abuse

| Signal | Detection | Threshold | Channel | Runbook | Status |
|---|---|---|---|---|---|
| AI daily budget exceeded | `aiBudgetGuard.ts` | Configurable `AI_BUDGET_DAILY_USD` | Requests refused with 429; admin visible in usage panel | Investigate abuse; consider throttle | 🟢 |
| DO overage | DigitalOcean billing | Any surprise line item | Email from DO | Investigate | 🟢 (DO-side) |
| S3 backup storage growth | S3 bucket size metric | >2x baseline over a month | Manual quarterly review | Verify lifecycle rule is running | 🟡 |

## Infrastructure

| Signal | Detection | Threshold | Channel | Runbook | Status |
|---|---|---|---|---|---|
| Disk full on droplet | Not currently alerted; visible via `df -h` | 80% | Not alerted | Extend volume | 🔴 |
| Memory pressure | Not currently alerted | 85% sustained | Not alerted | Resize droplet | 🔴 |
| CPU sustained high | Not currently alerted | 90% sustained 10 min | Not alerted | Investigate; usually AI batch | 🔴 |
| Certificate expiry | Auto-renew via nginx + Cloudflare Origin CA | 30 days before expiry | Renewal automatic | Verify renewal succeeded | 🟢 |
| GitHub Actions failures | GH workflow status | Any failure on main | GitHub email | Investigate | 🟢 |

## Vendor + third-party

| Signal | Detection | Threshold | Channel | Runbook | Status |
|---|---|---|---|---|---|
| DigitalOcean outage | Trust page + status.digitalocean.com | Any incident affecting NYC region | Email if subscribed | Follow DR runbook | 🟡 |
| Cloudflare outage | status.cloudflarestatus.com | Any incident affecting us | Public status | Wait + monitor | 🟡 |
| AI provider outage | provider status page + fallback trigger in `ai.ts` | Any provider 5xx | Cascade to fallback; no alert | Fallback handles it | 🟢 |
| Email provider outage | provider status page | Any | Watch for bounces | Failover to secondary provider | 🟡 |

---

## Gaps to close (drive from `SOC2_READINESS_CHECKLIST.md`)

The 🔴 and 🟡 items above map to items in the readiness checklist:

- Section D5 — Better Stack alerts not activated.
- Section D8 — this matrix itself (now green with this doc's existence).
- Section D9 — monthly security-metrics rollup template needed in `docs/compliance/evidence/YYYY-MM/`.
- Section C4 — Gitleaks.
- Section C5 — CodeQL.
- Section C6 — Trivy.

## Cadence

- **Weekly**: eyeball GH Actions status + Dependabot PRs.
- **Monthly**: aggregate this matrix's alerts into `docs/compliance/evidence/YYYY-MM/security-metrics-YYYY-MM.md`.
- **Quarterly**: revisit thresholds; retire signals that never fire; add new signals for new integrations.
