# ServiceCycle — Tamper-Evident Audit Log Architecture

**Classification:** Confidential / Diligence  
**Updated:** 2026-06-25

---

## Summary

Every security-relevant event in ServiceCycle is recorded in a SHA-256
hash-chained audit log. The chain structure means that any after-the-fact
modification to an audit record — by anyone, including a database
administrator — can be detected programmatically. This is not a common
feature at this stage of product maturity.

---

## How it works

### What gets logged

Every meaningful security and compliance event writes an `ActivityLog`
row to the database, including:

- Login attempts (success, failure, lockout trigger)
- Permission denied events
- Asset condition changes
- Document uploads and downloads
- Work order completions
- Admin operations (password reset, user creation)
- API v1 calls (method, path, HTTP status, latency, key ID)
- Arc flash study events
- Field encryption enable/disable (CEF severity 7)
- Compliance snapshot integrity failures (CEF severity 9)

Each event carries: `id`, `accountId`, `assetId`, `userId`, `action`,
`details` (JSON), `createdAt`, `cefSeverity`, and `rowHash`.

### The hash chain

After each write, a background settler job (runs every ~30 seconds) picks
up un-hashed rows and computes:

```
rowHash = sha256(prevHash || canonical(row))
```

Where `canonical(row)` is a stable deterministic JSON serialization of the
compliance-relevant fields (id, accountId, assetId, action, details,
createdAt). The chain is per-account — each account has its own chain that
starts from a genesis hash. A global chain (accountId = null) covers
cross-tenant events like failed logins for unknown email addresses.

The "stable serialization" function recursively sorts object keys, so the
hash is deterministic regardless of which database client inserted the row
or in what order the JSON fields arrived.

### Why the settler is decoupled from writes

Hash computation happens in a separate pass — not inline with the write.
This means even routes that bypass the `writeLog()` helper and use
`prisma.activityLog.create()` directly still get chained; the settler
picks up any row with `rowHash IS NULL`.

### Nightly verification

A scheduled job (runs nightly) calls `verifyAllChains()`, which
recomputes the entire chain for every account end-to-end and checks
each computed hash against the stored `rowHash`. If any row has been
modified, deleted, or re-ordered since it was chained, the computed
hash will not match.

**When a break is detected:**
- A new `audit_chain_break` event is written to the audit log itself
  (ironically, this event is also chained — so if someone tries to
  delete the break notification, that deletion is also detectable)
- The affected row IDs and account are recorded in the event details
- Better Stack receives a `logEvent('audit_chain_break', ...)` alert
- Operators can query the break via `GET /api/admin/audit-chain/verify`

---

## Threat model

**Defeats:** An insider with database access (`SELECT / INSERT / UPDATE /
DELETE` on `activity_logs`) who modifies rows to cover tracks. Without
simultaneous access to the application server and knowledge of the
canonical serialization function, they cannot recompute the correct hashes
for all downstream rows. The nightly verifier detects the discontinuity.

**Does not defeat:** An insider who has both database write access AND
application-server code execution, who rewrites the target rows AND
recomputes all subsequent hashes. This is an explicit scope decision: the
threat model is the database-only insider, not a full system compromise.
At full system compromise, all audit controls in any system are defeated.

---

## Code location

| Component | File |
|---|---|
| Hash chain settler + verifier | `server/lib/activityLogChain.ts` |
| Audit log writer | `server/lib/activityLog.ts` |
| Admin verify endpoint | `server/routes/adminAuditChain.ts` |
| CEF severity map | `server/routes/activity.ts` (CEF_SEVERITY) |

---

## Operational controls

The `GET /api/admin/audit-chain/verify` endpoint (admin role required)
returns the per-account verification status, allowing operators to:
- Confirm all chains are intact
- Identify which account's chain has a break (if any)
- View the row IDs of modified/deleted records

This endpoint is readable from the Admin panel in the UI.

---

## Compliance coverage

The hash-chained audit log supports the following SOC 2 Type I Trust
Service Criteria:

| Criterion | How the audit log contributes |
|---|---|
| CC7.2 | Monitors system components — all security events recorded |
| CC7.3 | Login anomaly detection — login_failed + login_lockout_triggered |
| CC6.8 | Encryption key monitoring — encryption_enabled/disabled audited |
| CC4.1 | Evaluates changes — all admin operations logged and chained |
| CC2.2 | Communicates externally — SIEM export via CEF-formatted log |

---

## Comparison to standard practice

| Feature | Typical early-stage SaaS | ServiceCycle |
|---|---|---|
| Audit logging | Often absent or application-only | ✅ All security events |
| CEF severity levels | Rarely implemented | ✅ 5 severity levels (3–9) |
| Tamper evidence | Not present | ✅ SHA-256 hash chain per account |
| Nightly verification | Not present | ✅ Full chain re-verification nightly |
| Break alerting | Not present | ✅ Audit log event + Better Stack alert |
| Admin UI for verification | Not present | ✅ /api/admin/audit-chain/verify |
| GDPR erasure compatibility | Would break hash chain | ✅ userId excluded from canonical() |

The GDPR compatibility point is noteworthy: most hash-chain implementations
include the user ID in the canonical form, which means every GDPR Art. 17
erasure request breaks the chain for all records that user touched. The
ServiceCycle design explicitly excludes userId from the canonical form
(the design decision is documented in the code) so that erasure of a
user's identity does not invalidate the chain.
