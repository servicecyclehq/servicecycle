# ServiceCycle — Unified Reprioritized Roadmap
_Authored 2026-06-20. Merges: Fable v3 review (44-item), the vetted feature shortlist, shipped state from session memory, and the multi-AI customer / PE-OEM buying-criteria findings (`5.28.issues.txt`)._

## Operating principle (applies to every "Larger build" below)
**Research current best practices BEFORE each larger build.** My base knowledge is May-2025; anything enterprise-grade (SSO, public API, telemetry ingestion, multi-OpCo) gets a web-research gate first so we ship to mid-2026 standards, not last year's. The SSO research gate is already done (see Phase 3). Each larger build also keeps the existing quality gates: server `tsc` + jest suite + client `vite build` green → commit/push → MCP deploy loop → health check.

---

## The honest framing
The multi-AI doc is ~80% **validation**, not new work. ServiceCycle already ships immutable hash-chained snapshots + auditor share links, evidence-gap detection, the Debt Ledger (= their "budget/funding package"), RUL/replacement forecast, fleet + portfolio rank + contractor benchmarking, multi-channel ingestion (PDF/email/nameplate/backfill, confidence-gated), severity-bucketed deficiencies, RBAC + tenant isolation (just hardened, F1–F11 closed), co-branding, and the quote→work-order closed loop. The doc's headline insight — "treat the asset record as a revenue-bearing digital twin; compliance gets you in, revenue intelligence is what an acquirer pays for" — **is already the product north star.**

So this roadmap is a small set of genuine gaps + high-leverage reframes, ordered by ROI-per-effort and by what unlocks bigger deals / acquisition diligence.

---

## PHASE 1 — Quick high-ROI reframes (each ~1–2 days; reuse data we already compute)
These are the "tidbits" with the best payoff: they surface intelligence we already calculate in a way customers and acquirers say almost nobody does.

1. **"What will fail an audit" view** — single ranked list of likely audit findings (missing evidence, overdue tasks, undocumented assets, undocumented repairs). Inputs already exist: path-to-100 gaps + evidence-gap detector + drift detector. Pure re-presentation. Highest demo/sales punch.
2. **"Forgotten / untracked assets" lens** — assets with no maintenance history or not inspected in >N years. Already computed as uncovered assets in path-to-100; surface as its own view.
3. **Insurer underwriting package + scoped "break-glass" insurer share link** _(merges shortlist #9 "insurer risk passport")_ — one-click underwriting packet (compliance %, snapshots, debt ledger) + an expiring, view-only insurer link. Leverages snapshots + auditor share links + CFO report. Called out in the doc as "the most powerful ROI story you haven't weaponized" (premium credits, faster risk surveys).

## PHASE 2 — Acquisition-story dashboard (medium; disproportionate strategic value)
4. **Revenue-attribution dashboard** — ties platform engagement → service attach-rate / pipeline ("Path-to-100 alert → $X PO"). We already have the closed loop (quote→WO via `quoteRequestId`, partner events, portfolio rank). This is the literal "currency" PE/OEM buyers said earns an acquisition premium.

## PHASE 3 — Enterprise table-stakes (the deal/diligence gates)
5. **Export-everything / no-lock-in** _(smaller — do first here)_ — one-click full account export (assets, history, deficiencies, docs, snapshots) in open formats + documented offboarding. Procurement-trust item raised on BOTH the customer and acquirer sides. We're partial today (xlsx/csv, user export, backups).

6. **Enterprise SSO (OIDC-first + SAML) + SCIM** — _Larger build · research gate DONE below._ Confirmed **absent** today (no dep, no route). The single most universally cited "kills the deal" gap for enterprise IT and an acquisition diligence checkbox. **A build-vs-buy decision is required before starting (see below).**

7. **CMMS / CRM integration story + documented public REST API** — _Larger build · research-gated._ Confirmed absent (only referenced in help/roadmap text). "Single biggest barrier" (customer IT) and "feeds my pipeline" (sales). Realistic path: a documented, versioned, bi-directional REST API (we have webhooks + a read-only v1 to build on) + 1–2 reference integrations (e.g. MaintainX + Salesforce) — not all of Maximo/SAP at once.

## PHASE 4 — Differentiator bets (large; schedule after Phase 3)
8. **Instrument / telemetry ingestion** _(shortlist #7)_ — _Larger build · research-gated._ Test-instrument imports (Fluke/Megger/Doble) + condition-monitoring streams. The "is this forward- or backward-looking?" question an OEM acquirer probes hardest. Biggest moat, biggest lift.
9. **Multi-OpCo roll-up admin** — _Larger build · research-gated._ Parent/subsidiary rollup, centralized master-data, cross-OpCo reporting with strict isolation. The PE roll-up thesis. We have partnerOrg→accounts to build on.

## PHASE 5 — Small slot-ins / low priority
10. **Vendor lead-time flag** _(shortlist #8)_ — flag long-lead replacement parts in the forecast/debt views. Small.
11. **Customer training/competency tracker** _(shortlist #10)_ — niche; only if a customer asks.
12. **Multi-site route planner** _(shortlist #11)_ — lowest priority; large for the value.

## PARALLEL — Business track (not code)
- **SOC 2 Type II** — a cert engagement + policy docs, not a build. The underlying controls (immutable audit log, RBAC, encryption, backups, tenant isolation) are largely in place. Start the process in parallel; it gates enterprise + acquisition but doesn't consume the build queue.

## Explicitly deprioritized / non-goals (don't over-rotate)
- Deep RSMeans/NECA cost indexing (rate cards are sufficient for now).
- 70E / NETA / IEEE module expansion (deliberately out of scope — NFPA 70B is the lane).
- "My-PM-vs-their-PM collision calendar" (niche).

---

## SSO research gate — current (mid-2026) standards
_Web-researched 2026-06-20 so we don't ship 2025-grade auth._

- **OIDC-first.** 2026 default is OpenID Connect; add SAML 2.0 only for legacy enterprise IdPs that can't speak OIDC (still common with Okta/Entra/Ping, so SAML is required for full enterprise coverage — but OIDC is the primary path). SAML's XML-canonicalization / parser-differential class produced a disproportionate run of critical, actively-exploited auth-bypass CVEs in 2024–2026 — another reason to lead with OIDC and treat any SAML code as high-risk surface.
- **OAuth 2.1 baseline:** Authorization Code + **PKCE (S256)** for all flows, strict `state`/nonce, full ID-token validation (guard against alg-confusion and PKCE-downgrade).
- **SCIM 2.0** (RFC 7643/7644) for provisioning: `/Users` + `/Groups`, bearer auth, multi-tenant mapping by org. Nice-to-have under ~100 enterprise customers; hard requirement at large seat counts.
- **Libraries if we build in-house:** the unscoped `passport-saml` / `node-saml` are **deprecated** — use the scoped `@node-saml/passport-saml` (v5) / `@node-saml/node-saml`, and `openid-client` (panva) for OIDC. SCIM via `scimgateway` or a hand-rolled endpoint.
- **Build-vs-buy is the real decision.** In-house SSO+SCIM is ~12–16 weeks of focused work + ongoing per-IdP maintenance and CVE exposure (WorkOS pegs the 3-yr cost gap near ~$3M for a growth-stage B2B SaaS). Managed providers (Scalekit, WorkOS, Stytch, Auth0 Organizations, Frontegg) reach production in days and abstract every IdP behind one integration. Scalekit runs materially cheaper than WorkOS at comparable coverage. **For an acquisition-target product, a managed layer is likely the right call** — faster to "enterprise-ready," smaller maintenance/security surface, and it ports to LapseIQ almost for free.

## LapseIQ portability (answering the follow-up)
**Yes — and cheaply, if we design for it.** ServiceCycle is a clean copy of LapseIQ v0.92, so they share the same stack and the same identity model (User/Account + JWT). That makes SSO highly portable either way:
- **If we buy (managed SSO):** near drop-in. Same SDK, just add LapseIQ as a second project/tenant config + its own IdP connections. Lowest-effort port.
- **If we build in-house:** build it as a **self-contained, config-driven auth module** with a thin adapter over the identity model (not hard-wired to SC's schema). Porting = copy the module + set env/IdP metadata + remap to LapseIQ's User/Account. Modest, bounded effort.
Either way I'd build it portably in ServiceCycle first. **Per the project guardrail I will not touch LapseIQ without your explicit go** — when you greenlight it, the port is a follow-on task.

---

## SSO decision (2026-06-20) — BUILD in-house on open-source blocks (no managed spend)
Dustin's call: no managed-provider spend without revenue. Build in-house using free/OSS building blocks.

**Recommended foundation: Ory Polis** (formerly BoxyHQ "SAML Jackson") — OSS SSO (SAML + OIDC) **+ SCIM 2.0 directory sync** that abstracts every customer IdP behind one OAuth2 flow. Node/TS (`@boxyhq/saml-jackson`), backs onto **PostgreSQL (already in our stack)**, deployable **as its own container** (matches our Docker + MCP deploy loop) or embedded as a library. ServiceCycle implements ONE OAuth flow; Polis handles Okta/Entra/Ping/Google/etc.
- **License gate:** historically Apache-2.0 as BoxyHQ Jackson; **re-confirm Ory's current license before committing** (Zitadel went Apache→AGPL in 2025 — AGPL would block embedding/resale).
- **Raw-library alternative if we don't use Polis:** `@node-saml/passport-saml` v5 + `openid-client` (panva) + SCIM via `scimgateway`/hand-rolled. (Deprecated: unscoped `passport-saml`/`node-saml`.)
- **Full-platform alternatives (heavier):** Keycloak (Java, enterprise standard), Authentik (MIT), SuperTokens (Apache-2.0). Avoid Zitadel (AGPL).

**Containerize-and-sell question — resolved:**
- Containerize for INTERNAL reuse across ServiceCycle + LapseIQ + ForgeRift → **YES, worth it** (one auth container, every product points at it; Polis is built for this; trivial LapseIQ port).
- Sell SSO as a STANDALONE product → **NO.** Market is saturated by paid incumbents (WorkOS/Stytch/Scalekit) AND free OSS (Keycloak/Authentik/Polis); building on Polis = reselling something already free (no moat); productizing = a second company (sales/SOC2/on-call/IdP-cert treadmill) that steals focus from the real moat (NFPA 70B domain + frictionless data-in). SSO is table-stakes to OWN, not a product to SELL.

## Confirmed starting point
Start building at **Phase 1 reframes**, item #1 (the "what will fail an audit" view), reusing path-to-100 + evidence-gaps + drift. SSO (Phase 3 #6) stays planned-but-unstarted until we reach it (license re-confirm is the first step then).

---

## LICENSE GATE — RESOLVED 2026-06-20 (commercial-use go/no-go)
Verified against the actual repo `LICENSE` file + `package.json`:
- **Ory Polis = Apache License 2.0** (repo `ory/polis` v26.2.0, "Copyright 2025 Ory Corp"). Bundles `@boxyhq/saml-jackson` under the same license. OIDC dep `openid-client` = MIT.
- **Apache-2.0 is permissive and commercial-safe.** Permits: embedding in a proprietary paid product, running inside a SaaS we sell, and acquisition of the company with it baked in — **no copyleft, no source-disclosure trigger.** Includes an explicit patent grant (good for diligence).
- **Obligations = attribution only:** retain LICENSE + NOTICE, mark files we modify as changed, don't use Ory/Polis trademarks to market our product.
- **Stay-clean caveats:** (1) build on the PUBLIC OSS `ory/polis` repo only — do NOT pull in any "Ory Enterprise License" (OEL) component (separate terms); (2) run a transitive-dependency license scan at build time so nothing copyleft (AGPL/SSPL) sneaks in via a sub-dependency.
- **Verdict: GREEN — not a non-starter.** Polis stays the recommended SSO foundation.

---

## AI tooling & ideation workflow — where each tool slots in (added 2026-06-20)
These are process tools, not build-items. Panel = DIVERGE; bring output back to Claude (Cowork) to CONVERGE. Connector reality: NO generation MCP exists for any of the three (Vercel's MCP is deploy/docs only; NotebookLM + Grok have none). Two of three have in-Cowork substitutes.

**NotebookLM — NFPA 70B grounding** _(substitute: upload the 70B text/manuals to Claude in Cowork → grounded here)_
- TRIGGER: any feature that encodes NFPA 70B compliance logic or required data fields.
- IMMEDIATE consults: Phase 1 #1 audit-failure view (what *exactly* constitutes a likely audit finding + required inspection fields per 70B); Phase 1 #3 insurer package (what evidence an auditor/insurer expects).
- RECURRING: every compliance feature thereafter.

**v0 by Vercel — UI prototyping** _(substitute: Claude renders interactive React/Tailwind/.jsx prototypes inline in Cowork)_
- TRIGGER: a "UI prototype gate" at the START of the client-side build of any UI-bearing feature — prototype the screen, decide layout/interaction, THEN implement cleanly against the real API + auth (never paste generated code into the live app).
- IMMEDIATE: Phase 1 card UIs (audit-failure, forgotten-assets, insurer package).
- HIGH-VALUE: Phase 2 revenue-attribution dashboard; Phase 3 SSO admin-config screens + export UI.

**Grok — contrarian / real-time market** _(MANUAL copy-back only — no substitute for live-X data)_
- TRIGGER: strategic ideation/decision passes, NOT per-feature.
- NOW: the competitor-teardown + ideation exercise (`docs/research/competitor-ideation-prompt-2026-06-20.md`).
- BEFORE BIG BETS: SSO go-to-market, CMMS/CRM, telemetry ingestion, acquisition positioning.

**Standing method (all ideation passes):** same brief, different adversarial PERSONA per seat (OEM M&A lead @ Eaton/Schneider/ABB/Siemens; PE operating partner; maintenance mgr w/ 4000 assets; OSHA inspector; NFPA consultant; procurement/CISO) → converge in Cowork vs the north star. See memory `servicecycle-ai-panel`.
