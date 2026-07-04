# Risk Acceptance Log

**Purpose:** capture every risk we explicitly choose *not* to fully mitigate at this stage, with reason, approver, and reconsideration date. SOC 2 auditors accept accepted risks — as long as they're deliberate, dated, and revisited.

**Owner:** Dustin (approver at current stage)
**Cadence:** revisit every acceptance at least annually, or whenever a scoping condition changes (revenue, headcount, customer segment).

---

## Format

Each row is an accepted-risk record. Append only; if an accepted risk becomes mitigated, mark superseded and link the closing commit.

---

## Accepted risks

### RAR-001 — DB + application-server insider can rewrite audit chain

- **Risk:** an insider with both DB and application-server access could rewrite hash-chained activity log rows and re-compute `rowHash` chains. This is the residual documented in `docs/AUDIT_LOG_ARCHITECTURE.md` §Threat model.
- **Why accepted:** at solo-founder stage, an external append-only rollup store (Cloudflare R2 with object-lock, or GitHub tag artifact) is not cost-justified. The hash chain already defeats the more probable DB-only insider.
- **Compensating controls:** two-person integrity via founder + git; workstation endpoint policy; solo-founder compensating controls documented in `ENDPOINT_SECURITY.md`.
- **Approver:** Dustin
- **Accepted date:** 2026-06-25
- **Reconsider by:** 2027-06-25, or upon reaching 5 paying customers, whichever is sooner.

### RAR-002 — No dedicated staging environment

- **Risk:** production is the first place a change runs in a container matching prod. If CI passes and prod fails, only rollback mitigates.
- **Why accepted:** droplet cost; solo dev throughput; CI smoke tests + Docker parity + fast rollback are the compensating controls.
- **Compensating controls:** CI runs live-server smoke tests (`.github/workflows/ci.yml`); Docker container image matches prod; deploy runbook has a documented rollback path.
- **Approver:** Dustin
- **Accepted date:** 2026-06-25
- **Reconsider by:** 2027-01-04, or on first paying customer.

### RAR-003 — Single-region hosting (no multi-region failover)

- **Risk:** DigitalOcean regional outage takes ServiceCycle down; RTO ~2h via droplet rebuild.
- **Why accepted:** cost + operational complexity of multi-region without revenue.
- **Compensating controls:** off-host backups on separate provider; documented DR runbook; RTO/RPO stated in `SOC2_CONTROLS.md` CC9.1.
- **Approver:** Dustin
- **Accepted date:** 2026-06-25
- **Reconsider by:** 2027-06-25, or when a customer's SLA requires it.

### RAR-004 — No third-party penetration test yet

- **Risk:** SC has not commissioned a professional pen test. Internal audits + acquisition-scan agents catch most gaps but do not substitute.
- **Why accepted:** pen tests cost thousands; solo-founder stage cannot justify.
- **Compensating controls:** repeated internal audit fan-outs (see `docs/security/SECURITY_AUDIT_2026-06-20.md` etc.); acquisition scans; `SECURITY.md` invites responsible disclosure.
- **Approver:** Dustin
- **Accepted date:** 2026-07-04
- **Reconsider by:** on first enterprise deal, or on any acquisition diligence.

### RAR-005 — No formal capacity planning (A1.1)

- **Risk:** on rapid growth, we may exhaust the 2 GB droplet.
- **Why accepted:** current load is trivial; scaling is a droplet resize (minutes).
- **Compensating controls:** health check + Better Stack monitoring wired; scale-up runbook is "power off, resize droplet, power on."
- **Approver:** Dustin
- **Accepted date:** 2026-07-04
- **Reconsider by:** first month with any user hitting rate limits, or 10 concurrent users.

### RAR-006 — Solo-founder separation-of-duties

- **Risk:** the founder writes, reviews, approves, and deploys — SOC 2 CC8.1 expects segregation.
- **Why accepted:** it's a solo company. All SaaS SOC 2 examples in this size class have this deviation.
- **Compensating controls:** every change in git; every deploy in the audit chain; every schema change reviewed against `CHANGE_REVIEW_CHECKLIST.md`; `npm audit` + Dependabot + CI gate before merge to main.
- **Approver:** Dustin
- **Accepted date:** 2026-07-04
- **Reconsider by:** on hiring the second person with production access.

### RAR-008 — Audit chain verifier not yet retention-aware

- **Risk:** `activityLogPrune.ts` hard-deletes activity_logs older than 365 days; `verifyAccount` in `activityLogChain.ts` expects the chain to start from `prevHash: null`. After the first real prune fires on production data, the verifier will report a stable chain break at the oldest surviving row.
- **Why accepted:** SC's first commit was 2026-06-06; the 365-day mark lands on 2027-06-06. The prune has never actually deleted a production row yet. Time-boxed acceptance.
- **Compensating controls:**
  - Nightly `activityLogChainVerify` cron already logs breaks + pushes to Better Stack (via `activityLogChain.ts` line 311).
  - RAR-001 already accepts DB + app-server insider tampering as residual — the retention-aware fix does not materially widen that surface.
- **Approver:** Dustin.
- **Accepted date:** 2026-07-04.
- **Reconsider by:** 2027-03-01 (Q1 2027) — must ship retention-aware verifier before 2027-06-06.
- **Cross-linked:** `docs/security/SECURITY_DECISIONS.md` 2026-07-04 audit-chain retention entry; `docs/security/RETENTION_ENFORCEMENT_DESIGN.md` §Follow-up.

### RAR-007 — No formal DAST scanning yet

- **Risk:** SAST + `npm audit` + Dependabot cover static and dependency vulns; no dynamic scanner runs against a live surface.
- **Why accepted:** OWASP ZAP is being scheduled as a follow-up SOC 2 session (item C7 in `SOC2_READINESS_CHECKLIST.md`); wanted to sequence after evidence folder + monitoring matrix.
- **Compensating controls:** input validation via Zod on every route; parameterized queries via Prisma; internal audit fan-outs catch surface bugs.
- **Approver:** Dustin
- **Accepted date:** 2026-07-04
- **Reconsider by:** when Session 9 (C7) runs — target 2026-08.

---

## Superseded / closed acceptances

*(empty — none closed yet)*

---

## How to add a new acceptance

1. Give it a `RAR-NNN` id (next unused).
2. State the risk in one sentence, in the language of the SOC 2 criterion it maps to.
3. State why acceptance is deliberate, not neglect.
4. List the compensating controls in place.
5. Name the approver (currently always Dustin).
6. Set a reconsideration date.
7. Cross-link from wherever the risk surfaces (threat model, controls matrix, risk register).
