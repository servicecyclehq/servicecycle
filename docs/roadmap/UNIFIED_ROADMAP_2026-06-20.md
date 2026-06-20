# ServiceCycle — Unified Roadmap (rebuilt 2026-06-20)
_Single source of truth. Rebuilt from git log on `main` (authoritative) + session memory notes. Supersedes `servicecycle-roadmap-v3` and `servicecycle-next-features`._

> **Status check protocol (READ FIRST in any new session):** verify reality with `git log --oneline -30 main` + the `*-SHIPPED-*` memory notes BEFORE building anything. Multiple sessions run in parallel; a conversation thread can be stale. Don't rebuild what's already on `main`.

## ✅ SHIPPED + DEPLOYED (verified against `main`, HEAD 1c07b53)
- **Security audit F1–F11** — 25+ cross-tenant/authz/audience defects closed; F1/F5/F6 fail-closed; F2 quote draft/send; F3 declare gate; F8 consent-first invite; F9 WO idempotency; F10 soft-deleted-org hide; F11 import DPS. (`f28e1f0`→`925eaed`)
- **Phase 1** — #1 audit-failure view (`bf41dec`), #2 forgotten/untracked-assets lens (`c634f56`), #3 insurer underwriting package + break-glass insurer link (`03d6ec8`).
- **Phase 2** — revenue-attribution dashboard, closed-loop engagement→pipeline→$ (`4d87e20`).
- **Phase 3** — #5 export-everything/no-lock-in (`22bf81d`); **#6 SSO** OIDC+SAML+SCIM on Ory Polis, merged (`6412d14`) — **SHIPS DARK** (SSO_ENABLED unset); #7 bi-directional v1 public API + MaintainX/Salesforce guide (`d16e01d`).
- **Phase 4** — #8 continuous condition-monitoring telemetry ingestion (`6b8d218`); #9 enterprise-group (HoldCo) multi-OpCo roll-up + centralized rate cards (`82dafe5`).
- **Data-in moat** — deterministic parser + **AI gap-fill layer** (`lib/aiTestReportExtract.ts`: deterministic-first, coverage-gated, fail-soft, PII-scrubbed, budget/quota/consent-guarded, `pyextract/eval` harness). Real-PowerDB robustness = handled.

**Net: the entire pre-existing roadmap (Phases 1–4 + SSO) is DONE.** What follows is the forward plan.

## ▶ FORWARD PLAN (remaining + new)

### A. Now-ready, low-risk (build any time — isolated, no research gate)
1. **EMP generator — VERIFY/polish.** `POST /api/compliance/emp-document` already exists; confirm it's one-click + regulator-ready (§4.2) and polish. Neutralizes Gimba's one differentiator. Effort: S.
2. **Frictionless capture trio.** NFC/QR tap-to-asset + voice field entry ("Breaker 42, IR normal, 68°"). Contractor/field UX; deepens data-in. Effort: S–M each.
3. **Parts/BOM/obsolescence intelligence.** Map nameplate→replacement components; flag EOL/unsupported parts. Feeds the OEM Atlas (B1). Effort: M.
4. **Phase 5 smalls.** Vendor lead-time flag in forecast/debt views (S); customer training/competency tracker (S, niche).
5. **SSO dark→live enablement.** Runbook + checklist to flip SSO_ENABLED for a real customer (start Polis overlay, configure IdP, test break-glass). Effort: S (ops/docs).

### B. Research-gated big bets (design spike BEFORE build — like SSO was)
1. **OEM Installed-Base Atlas** — replacement-opportunity + competitive-encroachment intelligence (nameplate+condition+RUL+geo). The #1 acquisition centerpiece across all 6 wow-factor AIs. GATE: needs a **cross-tenant consent + anonymization framework** (k-anonymity/aggregation thresholds) — in tension with the F1–F11 isolation we just hardened. Pairs with multi-OpCo #9.
2. **Fleet-wide anonymized benchmarking / failure-mode atlas** — PE network-effect moat; SHARES the anonymization layer with B1 (build once, power both).
3. **PE service-revenue predictability + data-asset diligence room** — forward service-revenue valuation + packaged diligence; builds on the shipped revenue dashboard (verify incremental).

### C. Parallel non-code tracks
- **SOC 2 Type II** — cert engagement + policy docs; controls largely in place (audit log, RBAC, encryption, backups, tenant isolation).
- **Customer help docs** — RUL/ratings/forecast/arc-flash/QEMW (per `project_faq_helpcenter`).
- **Email aliases** — add support@ / sales@ (only noreply@ exists).

### D. Lowest priority
- Multi-site route planner (large for the value).

## PARK (moonshots — fun, defer)
Acoustic/phone-mic diagnostics · drone nameplate capture · AR x-ray HUD · subcontractor auto-bid marketplace · gamified compliance · electrical-asset "Zillow" valuation · "ask my switchgear" Q&A · single-line topology/blast-radius · insurance-premium optimizer.
**DO NOT BUILD:** self-healing microgrid API control (safety/liability) · OSHA/insurer "whistleblower automator" (destroys trust).

## DEFERRED / settled decisions (don't re-litigate)
- **Direct test-INSTRUMENT hardware integration (Megger/Doble/AVO)** — DEFERRED. SC ingests the test-REPORT (PDF/CSV) the instrument produces (brand-agnostic, same data, AI-gap-filled). Instruments are contractor-owned, not customer — at most a contractor-tier convenience for incremental gain on PowerDB's home turf. Not worth it.
- **SSO** — build in-house on **Ory Polis (Apache-2.0)**, no managed spend; containerize for internal reuse (SC + LapseIQ + ForgeRift) but DO NOT sell standalone. LapseIQ port needs Dustin's explicit go (project guardrail). _(DONE — shipped dark.)_
- **Non-goals:** RSMeans/NECA deep cost indexing; 70E/NETA module expansion (stay NFPA 70B); generic-CMMS breadth.

## AI tooling & ideation workflow (process, not build-items)
- **NotebookLM** (or upload 70B docs to Claude) — ground compliance logic in the standard.
- **v0** (or Claude inline `.jsx` prototypes) — UI-prototype gate before any client build; prototype only, never paste generated code into the live app.
- **Grok** — contrarian/real-time market seat (manual copy-back).
- **Method:** same brief → adversarial personas (OEM M&A / PE operator / maintenance mgr / OSHA / NFPA / CISO) → converge in Cowork vs the north star. Add v0/NotebookLM/Grok; skip the long tail. See memory `servicecycle-ai-panel`.

## Parallel-execution rules (learned 2026-06-20)
- Each active stream = its own **git worktree + branch** (main worktree stays the integration/coordinator home).
- **Serialize merges/deploys to `main`** through one coordinator — concurrent committers race the `.git` lock (Desktop/OneDrive/AV interference; we hit silent no-op commits + "operation not permitted").
- Keep ≤2 active build/design streams + 1 coordinator; more causes merge contention for little gain.
- Commit shared docs to `main` so fresh worktrees inherit context.
