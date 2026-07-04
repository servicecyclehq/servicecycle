# Security Decision Log

**Purpose:** record intentional security decisions with reason, alternatives considered, and owner. This is where an auditor learns *why* the architecture looks the way it does, not just *what* it is. New decisions get appended; superseded decisions get marked but never deleted.

**Format:** newest first, dated. Each entry stands alone.

---

## 2026-07-04 — Audit chain retention: accept latent verifier discontinuity, fix before Q2 2027

- **Decision:** keep `activityLogPrune.ts` as a hard-delete (current behavior). Do not change it before Q1 2027. Track a code fix to make `verifyAccount` retention-aware before the first prune actually fires on production data.
- **Context:** the SOC 2 sweep on 2026-07-04 flagged a design tension. `activityLogPrune` hard-deletes rows older than 365 days. `verifyAccount` in `activityLogChain.ts` walks the surviving rows in ascending `createdAt` order and expects the first row to have `prevHash: null`. After the first real prune fires, the oldest surviving row will have a non-null `prevHash` (pointing at a now-deleted row), which the verifier will flag as a chain break — a stable "false break" that repeats every night and alerts Better Stack.
- **Why not fix now:** SC's first commit was 2026-06-06; 365 days lands on **2027-06-06**. The prune has never actually deleted a production row yet. Fixing pre-need is safe; fixing pre-need without a triggering scenario risks introducing a subtler bug.
- **Fix approach when we do:** make `verifyAccount` accept the oldest surviving row's stored `(prevHash, rowHash)` as a trusted anchor and verify forward from there. Rationale: RAR-001 already accepts that a DB + app-server insider can rewrite the chain; the retention-aware verifier does not materially worsen that residual risk (an insider capable of adjusting a `prevHash` was already capable of rewriting rowHash chains).
- **Alternatives considered:**
  - Convert prune to redact-in-place (preserves chain but unbounded row count) — rejected on disk-cost grounds.
  - Add a per-account `ChainWatermark` table — rejected as unnecessary complexity vs the "trust oldest surviving row" approach.
- **Owner:** Dustin.
- **Reconsider by:** 2027-03-01 (Q1 2027) — must ship the retention-aware verifier before 2027-06-06 to avoid the first false-break firing in production.
- **Cross-linked:** `docs/compliance/RISK_ACCEPTANCE_LOG.md` RAR-008 (this decision as an accepted risk), `docs/security/RETENTION_ENFORCEMENT_DESIGN.md` §Follow-up.

---

## 2026-07-04 — AiUsage retention: adopt 90d as effective policy

- **Decision:** update `docs/compliance/DATA_RETENTION_MATRIX.md` to state 90-day retention for `AiUsage` rows. My initial doc said 12 months.
- **Context:** the SOC 2 sweep on 2026-07-04 documented "12 months live for cost analysis, then aggregate-only" for AI call metadata. `prune-ai-usage` cron at 03:55 UTC uses 90 days.
- **Root cause of the mismatch:** my initial retention-matrix draft was written assuming per-call detailed rows would be aggregated at some point. Reality: `AiUsage` is already daily-aggregated as `(userId, action, day, count)` in the schema; there are no detailed rows to aggregate. The `api_v1_call` per-call metadata is in `ActivityLog.details`, which is subject to the 365-day activity-log retention.
- **Effect:** update the matrix. No code change required.
- **Owner:** Dustin.

---

## 2026-07-04 — Consolidate security decisions into one log

- **Decision:** create `docs/security/SECURITY_DECISIONS.md` as the single append-only log of security-relevant architectural decisions.
- **Reason:** decisions have been scattered across `AUDIT_LOG_ARCHITECTURE.md`, `SOC2_CONTROLS.md`, and PR bodies. Auditors ask "why did you choose X?" and expect a single grep target.
- **Alternatives:** keep decisions in commit messages only (rejected: not skimmable); adopt an ADR-per-file convention (rejected: overkill for solo dev).
- **Risk / tradeoff:** requires discipline to actually append when decisions are made.
- **Owner:** Dustin

---

## 2026-07-03 — Alpine → Debian container base for server image

- **Decision:** switched `server/Dockerfile` from Alpine to `node:20-slim` (Debian).
- **Reason:** pdfplumber + tesseract + pypdfium2 did not run reliably on Alpine (musl vs glibc issues left the OCR chain inert in prod).
- **Alternatives:** stay Alpine + rebuild native deps (rejected — fragile); switch to full `node:20` (rejected — image size).
- **Risk:** slightly larger image; longer initial build. Cached rebuild is ~11s.
- **Owner:** Dustin
- **Commit:** c652578

---

## 2026-07-03 — Retain nameplateOcrContract regression test

- **Decision:** ship `nameplateOcrContract.test.ts` alongside the truncation-trap fix (83cb831).
- **Reason:** the 294613d nameplate regression was invisible in unit tests because it only showed under multi-field JSON completions — added a regression-lock so any future prompt/token change surfaces immediately.
- **Alternatives:** rely on live spot-checks (rejected — that's how the original bug shipped).
- **Owner:** Dustin

---

## 2026-06-28 — Site-level documents surface on every asset at the site

- **Decision:** `Document.siteId` model: a document uploaded to a site (e.g., an arc-flash one-line) shows on every asset at that site by default.
- **Reason:** field techs shouldn't have to re-attach the same document to each asset.
- **Alternatives:** per-asset only (rejected — the field workflow).
- **Risk:** cross-tenant leak if `siteId` is populated for a wrong tenant. Mitigated by `multiTenantIsolation.test.ts` + tenant-scope predicate on every document query.
- **Owner:** Dustin
- **Commit:** 5fbd557

---

## 2026-06-25 — Adopt tamper-evident audit log (SHA-256 hash chain per account)

- **Decision:** implement `activityLogChain.ts` — every activity row includes `prevHash` + `rowHash`; nightly verifier catches breaks.
- **Reason:** audit-record integrity is table stakes for enterprise buyers and SOC 2 CC2.1 evidence. Cheaper than an external append-only store, defeats DB-only insider.
- **Alternatives:** append-only external log (rejected at current stage — cost); no chain (rejected — no tamper evidence).
- **Risk / tradeoff:** does **not** defeat DB + application-server insider (see `docs/AUDIT_LOG_ARCHITECTURE.md` §Threat model). Accepted at current stage; will layer external cold-storage rollup at a later phase.
- **Owner:** Dustin
- **Commit:** 5329d1f

---

## 2026-06-25 — BYO customer AI keys as the moat, not per-tenant AI plumbing

- **Decision:** customers on paid tier bring their own AI provider API key; ServiceCycle only holds free-tier fallback keys for the free scan meter.
- **Reason:** solves data-residency + provider-agreement concerns in one move (customer owns the DPA with Anthropic/Gemini/OpenAI). Also frees SC from AI cost pass-through modeling.
- **Alternatives:** SC-brokered AI (rejected — DPA burden + margin pressure).
- **Risk:** more onboarding friction. Mitigated by admin console UX for adding a key.
- **Owner:** Dustin

---

## 2026-06-25 — Better Stack for uptime; healthchecks.io for cron heartbeat; keep both integrations wired but activation is stage-gated

- **Decision:** both integrations shipped in `server/lib/betterStack.ts` and `server/lib/heartbeat.ts`; activation thresholds documented but not turned on.
- **Reason:** wired-and-off costs less than not-wired when we do want to activate; keeps `A1.2` gap surfaced.
- **Alternatives:** none.
- **Owner:** Dustin

---

## 2026-06-24 — SOC 2 controls documented in `SOC2_CONTROLS.md` as a live TSC mapping

- **Decision:** every Trust Services Criterion gets a row with control + evidence + gap. Living doc; updated as gaps close.
- **Reason:** an acquirer's diligence team can read it top-to-bottom in one sitting; auditor uses it as the starting index.
- **Alternatives:** wait until Type I audit to write it (rejected — evidence discipline degrades if you postpone).
- **Owner:** Dustin

---

## Prior decisions

For any decision that predates this log's introduction (2026-07-04), consult:
- Design docs under `docs/security/` (SSO_DESIGN, AUDIT_LOG_ARCHITECTURE, KEY_ROTATION).
- Commit history on `main`.
- Session memory index at `MEMORY.md`.

Backfilling every prior decision is not required; forward from 2026-07-04 is disciplined.
