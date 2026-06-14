# ServiceCycle — Lean Build List (supersedes the v3 roadmap)
**Date:** 2026-06-14
**Why this exists:** the v3 roadmap (44 items, Waves 1–6) drifted toward two things that real-world feedback says are over-scope: (a) being a *standards-interval oracle*, and (b) feature breadth for an acquisition thesis. The practitioner (electrical-repair contractor, does this daily) was blunt:

> "Clean, lube, megger. Nobody is paying for that NETA stuff. NETA-test a low-voltage breaker = 2 hrs; the Eaton/NFPA 70B procedure = 20 min. $25K to NETA-test 8 transformers, 2 guys all day each. NFPA 70B defaults to the manufacturer's recommended procedures. All that stuff is overkill."

**Takeaways that reshape the build:**
1. There is **no universal 'correct' interval** to encode — 70B defers to the manufacturer's manual + the facility's program. Our job is to **track whatever the customer sets and remind them**, not to assert the standard. The seed table is a *labeled starting default*, not authority.
2. The everyday job is the **lean PM (clean/lube/megger/visual)**. The full NETA test battery is the contractor's **high-margin, occasional, billable** service — not the routine the tool should assume.
3. The moat is **frictionless data-in + tracking + reminders + compliance proof**, not exotic test modules. Stop adding breadth; validate the core with real users.

---

## Disposition of everything already built (nothing is deleted — code is kept)

**KEEP — the validated core (live):**
- Test-report ingest: PDF / photo-of-paper → readings → auto-deficiencies (#1/#10/#20), now with the async queue (#2) so big facility reports don't time out. **The moat.**
- Asset register, nameplate scan, batch scan, field mode, identity/“same device?” (#3/#12/#13).
- Schedules + “coming due” reminders; trend tracking of readings over time.
- Dashboard / Path-to-100 / one honest (now monotonic, estimate-framed) compliance number.
- Compliance **proof**: EMP document, hash-chained audit snapshots, per-standard PDF, auditor/insurer share link, co-branding (#7/#9/#15/#21). This is the “show the inspector/underwriter” differentiator — keep.
- Incident log (#24), acceptance/year-0 baseline (#27), quote→WO→green (#22), leave-behind + auto-send (#16).
- Channel (behind `oem_admin`, not shown to facility users): fleet dashboard, contractor bulk ingest, fleet Path-to-100 (#14/#23).
- Extraction telemetry / dedupe (#4/#5) — cheap, compounding; keep running.

**FLAG-OFF in the demo (deployed code, account feature flag, reversible):**
- Oil/DGA ingest (#28) and IR thermography ingest (#29) — the specialized big-transformer/lab world; not routine PM.
- The **full NETA test battery** — default new assets to the lean manufacturer/70B PM; keep the full matrix behind the flag.

**SHELVED — on `main`, NOT deployed; revive only on real demand (trigger noted):**
- #25 arc-flash per-study records + label binding — revive if a customer actually wants 70E arc-flash management.
- #37 QEMW credential wallet — revive if/when the contractor channel is real.
- #35 enterprise trust pack (SIEM export + SSO/SAML) — revive at the first enterprise/utility security review.
- #34 “bring us your decade” backfill (unbuilt; now unblocked by #2) — revive for the first real historical migration.
- #6 email-in (unbuilt; unblocked by #2) — revive at real report volume.

**KEEP-LATER (value-aligned but not urgent):**
- #26 genset/battery PM tasks — these are *lean* (monthly battery check, annual service); fine to keep as available templates, deploy with a re-seed when convenient.
- #30 customer weekly digest + quarterly CFO PDF — retention heartbeat + renewal artifact (server done; client toggle UI not built). Build the UI once there's a live customer to send to.

**DOC-ONLY (harmless, keep):** #36 self-host guide, #35 security trust-pack doc.

**NOT DOING (founder-gated / premature):** #31 benchmark product, #32 acquisition-KPI framing, #33 pricing, #38 acquirer dossiers, #18, #39–#43. The “acquisition crown jewels” framing was premature — drop it until there’s a product people use.

---

## What’s actually left to do (lean go-forward, in order)

1. **The lean pivot (in progress now).** Default to the manufacturer/NFPA-70B lean program (clean/lube/megger/visual) instead of auto-loading the NETA battery. Flag off DGA + thermography. Relabel the seed table as “starting defaults — adjust to the manufacturer / your program.” Redeploy the demo. *(Reversible via feature flags.)*
2. **Manufacturer-recommended interval model (small, honest).** Make each asset’s interval a first-class, editable field defaulted from the OEM/70B procedure; the standard table is just the seed default. This dissolves the “is our interval correct vs NETA” problem and matches how 70B actually works.
3. **Deploy the undeployed `main` selectively.** Ship the #2 async queue (good infra) + the kept items; leave shelved items flag-off. (Deploy needs: migrations 20260613000000 [#25] + 20260613010000 [#2] auto-applied by server-migrate; `seed-standards.js` re-run; client rebuild.)
4. **Validate with real users.** Get 5–10 real test reports from the brother to harden the parser; watch the brother + Dan actually use it; fix what’s genuinely clunky. **Let real usage pull the roadmap from here — stop pushing features.**
5. **Standards second pass (only if the brother sends primary-source docs).** Per the standards-accuracy review, correct the ~30 NETA App-B intervals, the grounding row, and the DGA-2019 method *against real tables* — but per (1), these are defaults, not authority, so this is lower priority than it looked.

## The one-line product, post-pivot
“Drop in your test reports; we track every asset’s lean PM, tell you what’s due, trend the readings, and hand you audit-ready proof — defaulting to the manufacturer’s procedure, not an all-day NETA battery nobody pays for.”
