# Business Continuity Playbooks (per scenario)

**Purpose:** the generic BC/DR is in `DEPLOY_RUNBOOK.md`. This doc is scenario-specific: the six most probable failures and what to do, minute-by-minute. SOC 2 CC7.4 / CC9.1 evidence.

**Version:** 1.0
**Effective date:** 2026-07-04
**Owner:** Dustin
**Review cadence:** annually + after any drill.
**Companion:** `docs/INCIDENT_RESPONSE.md` (severity matrix + comms), `docs/DEPLOY_RUNBOOK.md` §Disaster Recovery.

For each scenario: **Detection · Immediate actions · Customer impact · Recovery · Post-review**.

---

## Playbook 1 — DigitalOcean droplet unreachable / regional outage

### Detection
- Better Stack alert (once activated) fires on `/api/health` failure.
- Cloudflare 522 error visible on `servicecycle.app`.
- DO status page shows regional issue.
- **Fallback detection:** customer email.

### Immediate actions
1. Confirm via `curl -I https://servicecycle.app/api/health`.
2. Cross-check DO status page + Cloudflare status.
3. Classify per `INCIDENT_RESPONSE.md`: P1 if broad customer impact, P2 if narrow.
4. Post a static maintenance notice on Cloudflare (if configured) or send customer comms directly.
5. If ETA is beyond 2h RTO **AND** we have a paying customer with SLA obligation: begin droplet rebuild in DO SFO region (steps below). Otherwise: wait + monitor.

### Customer impact
- Full outage while region is down.
- No data at risk (backups off-host).

### Recovery
1. `docs/DEPLOY_RUNBOOK.md` §Disaster Recovery has the full rebuild sequence.
2. Provision new droplet in DO SFO from the latest snapshot / rebuild image.
3. Restore latest pg_dump from S3 (RPO ≤24h).
4. Update DNS at Cloudflare to point to new IP.
5. Verify `/api/health` green from multiple locations.
6. Verify audit chain still passes verifier — hashes travel with the data.
7. Send all-clear email.

### Post-review
- Open incident file per `docs/compliance/incidents/`.
- Update `RISK_ACCEPTANCE_LOG.md` RAR-003 if this reveals we should be multi-region sooner.

---

## Playbook 2 — Database corruption

### Detection
- Query errors from application.
- Audit chain verifier fails (rows tampered or corrupted).
- Manual `pg_dumpall --schema-only` diff shows unexpected changes.

### Immediate actions
1. Stop writes: bring the API down or flip to read-only mode.
2. Snapshot the current corrupted state (`pg_dump` to a preserved file — do NOT overwrite backups).
3. Classify: P1 (data at risk).

### Customer impact
- Full outage during restore.
- Data loss window: since last good backup (worst case 24h).

### Recovery
1. Identify last known-good backup from S3.
2. Restore into a fresh DB volume; verify integrity (`pg_verify_checksums`).
3. Verify audit chain still passes.
4. Bring API back up pointing at restored DB.
5. Reconcile any customer-reported writes lost in the RPO window.

### Post-review
- Investigate root cause (bad migration? insider? disk?).
- Consider whether to add write-ahead log shipping for tighter RPO.

---

## Playbook 3 — Cloudflare outage

### Detection
- Cloudflare status page shows incident.
- Reports from customers.

### Immediate actions
1. Confirm scope on status.cloudflarestatus.com.
2. Classify: usually P2 (most Cloudflare outages are regional and partial).
3. If DNS is affected: manually update DNS at registrar to point directly to droplet IP (bypass Cloudflare). Note: exposes origin IP; only do this for a sustained major CF outage.

### Customer impact
- Depends on outage scope: DNS out → total outage; edge out → some regions affected; WAF out → we may need to allow-list explicitly.

### Recovery
1. Wait for Cloudflare to resolve.
2. If we bypassed Cloudflare, revert to CF proxy once restored.

### Post-review
- Note in vendor review log.
- Consider whether we need a secondary CDN — for solo-founder stage, single-CDN is accepted.

---

## Playbook 4 — GitHub / CI outage

### Detection
- GitHub status page.
- CI runs failing or stuck.

### Immediate actions
1. Confirm on status.github.com.
2. Classify: P3 unless we have a hotfix pending.
3. If hotfix critical: deploy manually from workstation using `docs/DEPLOY_RUNBOOK.md` §Manual Deploy path (bypass CI temporarily; document the bypass in commit message).

### Customer impact
- None to running production.
- Us: can't ship changes.

### Recovery
- Wait for GH.

### Post-review
- Confirm the manual-deploy path is still documented and working.

---

## Playbook 5 — AI provider unavailable (Anthropic / Gemini / OpenAI / Groq)

### Detection
- Provider status page.
- API errors bubbling up in `server/lib/ai.ts` cascade.
- Customer reports "scan failed."

### Immediate actions
1. Confirm which provider.
2. `server/lib/ai.ts` cascade handles fallback for free-tier automatically (Gemini → Groq).
3. For paid-tier customers using a BYO key: notify the affected customer if their chosen provider is down; suggest they add a fallback provider key.
4. Classify: P2 if broad; P3 if one provider only.

### Customer impact
- Free-tier scan meter may be reduced.
- Paid-tier customer on a single-provider key: their AI features degraded until provider restored.

### Recovery
- Wait for provider.
- Ensure the cascade is actually triggering (check activity chain for `api_v1_call` events with provider swaps).

### Post-review
- Verify fallback logic held.
- If not, treat as a bug per `INCIDENT_RESPONSE.md`.

---

## Playbook 6 — Vendor account compromise (GitHub, DO, Cloudflare, registrar, email, S3)

### Detection
- Unauthorized login alert from vendor.
- Notification that credentials appear in a breach dump.
- Unexpected changes to configuration.
- Personal receipt of a suspicious "please verify" email from the vendor (phishing).

### Immediate actions
1. From a **known-clean workstation** (or the founder workstation confirmed clean), log in via password manager to the vendor account.
2. Rotate the credential immediately.
3. Sign out all other sessions from the vendor's session manager.
4. Verify MFA is still on and the recovery method hasn't been changed.
5. Rotate any SC secret that the vendor account could have exposed (see `SECRETS_INVENTORY.md`).
6. Classify: P1.

### Customer impact
- Potentially none if we catch it in time; potentially major if the attacker had time to exfiltrate.
- Full breach notification per `INCIDENT_RESPONSE.md` §5 if customer data was exposed.

### Recovery
1. Restore configuration to intended state.
2. Rotate all downstream secrets protected by the compromised vendor account.
3. Verify audit chain still verifies (attacker may have targeted the DB).
4. If the account was the GitHub org: consider force-pushing a clean history if malicious commits were introduced.

### Post-review
- Full incident record in `docs/compliance/incidents/`.
- Update `SECRETS_INVENTORY.md` rotation log.
- Consider whether workstation compromise is upstream (invoke Playbook 7 if so).

---

## Playbook 7 — Workstation lost / stolen / compromised

### Detection
- Physical loss/theft observed by founder.
- Endpoint anti-malware alert.
- Unexpected browser behavior; unrecognized process.

### Immediate actions
1. From a different device (phone counts), rotate `JWT_SECRET` following `docs/KEY_ROTATION.md` dual-verify procedure.
2. Rotate `MASTER_KEY` and `BACKUP_ENCRYPTION_KEY`.
3. Rotate every vendor credential in `SECRETS_INVENTORY.md`.
4. Force `tokenEpoch` bump for all admin users (invalidates all sessions).
5. If BitLocker was on and MFA on the login: the compromise ceiling is much lower — but rotate anyway.
6. Classify: P1.

### Customer impact
- Depends on how much attacker time before rotation completes.
- Full breach notification if any evidence of data exfiltration.

### Recovery
1. Do NOT restore a workstation image if compromised — order fresh hardware.
2. Rebuild the workstation from OS install.
3. Reissue credentials from password manager (which is itself protected by MFA + recovery vault).

### Post-review
- Full incident record.
- Reconsider whether the endpoint policy needs strengthening.

---

## Additional scenarios worth having (planned)

- **Stripe / payment processor outage** — deferred until we take direct payments.
- **Email deliverability failure** — soft-failure; failover secondary provider.
- **DNS registrar takeover attempt** — covered partially in Playbook 6 but worth its own doc if / when this becomes probable.
