# Incident Response Plan — ServiceCycle

**Version:** 2026-06-24  
**Owner:** Dustin (founder / sole operator)  
**Review cadence:** Annually, or after any security incident  

---

## Scope

This plan covers security incidents affecting the ServiceCycle hosted deployment
(`servicecycle.app` and the DigitalOcean droplet at 198.211.99.45), including:

- Unauthorized access to customer data
- Credential compromise or account takeover
- Data loss or corruption
- Denial-of-service attacks
- Vulnerability disclosure
- Third-party vendor incidents (DigitalOcean, Brevo, Resend, Cloudflare)

---

## Severity classification

| Severity | Criteria | Target initial response |
|---|---|---|
| **P0 — Critical** | Active data breach; unauthorized cross-account data access; production down >15 min | Immediate — drop everything |
| **P1 — High** | Suspected credential compromise; single-account data exposure; critical vulnerability reported via security.txt | Within 2 hours |
| **P2 — Medium** | Rate limiting bypass; suspicious login patterns; non-critical vulnerability | Within 24 hours |
| **P3 — Low** | Vulnerability reports with no active exploitation; informational findings | Within 7 days |

---

## Response phases

### Phase 1 — Detect

**Automated detection signals:**

- Activity log: `login_failed` flood, `permission_denied` spikes → `GET /api/activity?action=login_failed` (admin)
- Rate limit 429 spike in nginx / Cloudflare dashboard
- `GET /api/health` returning non-200 (Better Stack heartbeat alert)
- Nightly audit-chain verifier: `GET /api/admin/audit-chain/verify` returns `integrity: false`
- Customer or third-party report to `security@servicecycle.app`

**Manual detection:**

```bash
# Check recent login failures on the droplet
docker exec -i servicecycle-server-1 node -e \
  "const p=require('./lib/prisma').default; \
   p.activityLog.findMany({where:{action:'login_failed'},orderBy:{createdAt:'desc'},take:20}).then(r=>console.log(JSON.stringify(r,null,2)))"
```

---

### Phase 2 — Contain

**Immediate containment steps by scenario:**

**Active data breach / unauthorized access:**
1. Kill all sessions for affected account(s): bump `tokenEpoch` for all users on the account via direct DB update
2. If scope is unclear, take the server offline:
   ```bash
   docker compose -f /root/ServiceCycle/docker-compose.yml stop server
   ```
3. Preserve logs before any remediation: export activity log via `GET /api/activity/export?format=ndjson`
4. Block attacker IP at Cloudflare firewall (Dashboard → Security → WAF → Custom rules)

**Credential compromise (admin password stolen):**
1. Reset the compromised user's password via admin panel → `/users` → Reset password
2. Bump token epoch (password reset does this automatically)
3. Review the activity log for what the attacker accessed

**Suspected SQL injection / auth bypass:**
1. Immediately put Cloudflare in "Under Attack" mode (Dashboard → Security → Settings → Security Level)
2. Take a heap dump if the server is still running for forensic analysis
3. Stop the server container

**Production down:**
1. Check container status: `docker ps` on the droplet
2. Check server logs: `docker logs servicecycle-server-1 --tail=100`
3. Restart: `docker compose -f /root/ServiceCycle/docker-compose.yml up -d server`
4. If DB is corrupted: stop server, restore from last nightly backup (see `docs/DEPLOY_RUNBOOK.md` §5)

---

### Phase 3 — Investigate

**Evidence to preserve (before any changes):**

1. Activity log export (NDJSON): `GET /api/activity/export?format=ndjson&dateFrom=<incident-date>`
2. Nginx access logs: `/var/log/nginx/access.log` on the droplet
3. Docker container logs: `docker logs servicecycle-server-1 --since=<incident-date>`
4. Cloudflare analytics: Log → HTTP requests filtered by time window

**Audit chain integrity check:**

```bash
# On the droplet
cd /root/ServiceCycle
node server/scripts/verify-audit-chain.js <path-to-exported-ndjson>
# exit 0 = intact; exit 1 = tampered
```

**Questions to answer:**
- Which accounts were accessed?
- What data was read or modified?
- How did the attacker gain access (credential stuffing, session hijack, vulnerability)?
- Is the attacker still active?
- What is the timeline of events?

**Regulatory triage:** Run account audit query to determine which accounts had data exposure: `SELECT a.id, a.company_name FROM accounts a JOIN users u ON u.account_id = a.id WHERE u.last_login > [breach_start]`. Cross-reference against customer list to identify any EU/EEA or UK-resident accounts (check Account.companyName or billing records). Document approximate number of affected data subjects and categories of personal data involved for GDPR Article 33(3) notification.

---

### Phase 4 — Eradicate

1. Rotate all compromised credentials:
   - JWT signing key (`JWT_SECRET`) → invalidates ALL active sessions across all accounts
   - `ENCRYPTED_KEYS` → re-encrypt all per-account integration secrets
   - `BACKUP_ENCRYPTION_KEY` → rotate; re-encrypt next backup
   - Affected user passwords → force reset via admin panel
2. Deploy patched code if a vulnerability was exploited (standard deploy runbook)
3. Apply any Cloudflare WAF rules to block the attack pattern going forward

---

### Phase 5 — Recover

1. Restore service to normal operation
2. Monitor closely for 72 hours post-incident (check activity log daily)
3. Verify audit chain integrity post-recovery: `GET /api/admin/audit-chain/verify`
4. Remove temporary Cloudflare "Under Attack" mode if activated

---

### Phase 6 — Notify

**Customer notification thresholds:**

| Scenario | Notify? | Timeline | Channel |
|---|---|---|---|
| Data breach confirmed (PII accessed) | Yes | Within 72 hours (GDPR Art. 33/34) | Email to affected account admins |
| Production down >1 hour | Yes | Within 2 hours of confirmation | Email to all account admins |
| Suspected breach, under investigation | Yes | Within 24 hours | Email (acknowledged, under investigation) |
| Vulnerability fixed, no data exposed | Optional | Disclosure at discretion | Release notes or direct email |

**Notification template — data breach:**

> Subject: Important security notice — ServiceCycle
>
> We are writing to notify you of a security incident that may have affected your
> ServiceCycle account.
>
> **What happened:** [brief description]
> **When:** [date/time range]
> **What data was involved:** [types of data]
> **What we have done:** [containment and eradication steps]
> **What you should do:** [specific actions for the customer]
>
> We take security seriously and are deeply sorry for any inconvenience. If you have
> questions, please contact us at security@servicecycle.app.

**Regulatory notification:**
- GDPR Article 33: Notify the relevant supervisory authority within 72 hours of
  becoming aware of a breach involving EU resident data.
- State breach notification laws (US): Varies by state; consult counsel for
  incidents involving PII of residents in notification-statute states.

### Regulatory Contact Quick Reference

**EU/EEA -- GDPR Article 33 (72-hour notification):**
- Irish DPC (lead SA for many US-based controllers): https://www.dataprotection.ie/en/individuals/data-breaches
- French CNIL: https://www.cnil.fr/en/report-a-personal-data-breach
- German BSI/LfDI: varies by state; see https://www.bfdi.bund.de

**UK -- UK GDPR Article 33 (72-hour notification):**
- ICO: https://ico.org.uk/for-organisations/report-a-breach/

**US -- State breach notification (without unreasonable delay):**
- NCSL tracker: https://www.ncsl.org/technology-and-communication/security-breach-notification-laws
- California AG: https://oag.ca.gov/privacy/databreach/reporting

---

### Phase 7 — Post-mortem

Within 5 business days of incident resolution:

1. Write a post-mortem document in `docs/incidents/INCIDENT-<YYYY-MM-DD>.md`
2. Document: timeline, root cause, contributing factors, what worked, what didn't
3. Identify and log corrective actions (code fixes, process changes, monitoring improvements)
4. Update this document with any lessons learned

---

## Key contacts and resources

| Resource | Location |
|---|---|
| Droplet access | DigitalOcean console → ServiceCycle droplet |
| Cloudflare dashboard | dash.cloudflare.com → servicecycle.app |
| Brevo (email) | app.brevo.com |
| Resend (inbound) | resend.com |
| Activity log export | `GET https://servicecycle.app/api/activity/export` (admin token) |
| Audit chain verifier | `server/scripts/verify-audit-chain.js` |
| Security disclosure | `security@servicecycle.app` |
