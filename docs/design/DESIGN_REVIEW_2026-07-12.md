# ServiceCycle UI/UX design review — 2026-07-12

**Scope:** core demo path (dashboard → work orders → asset detail), reviewed against the live demo (servicecycle.app, Meridian Manufacturing seed) and the client source (`client/src/index.css`, `styles/tokens.css`, `brand/brand.md`, page components).
**Companion artifact:** `direction-board-2026-07-12.html` (same folder) — the current dashboard rendered next to three modernization directions. Look at that first; this doc is the evidence behind it.

## Verdict

ServiceCycle does **not** have a generic-AI palette problem — that was solved in May 2026 when the petrol/ink/emerald "Quietly Modern" brand was locked (`brand/brand.md` v1.1). What makes it still read as template-built is **composition and unfinished execution**:

1. **No width discipline.** Every card stretches the full viewport; on a 1500px screen a row's label and its value can sit 1,200px apart.
2. **No alarm budget.** Red/amber appears in six-plus modules simultaneously on the dashboard; when everything shouts, nothing does.
3. **The brand pass never finished.** 1,189 hardcoded hex values across 133 JSX files, a stock-Tailwind 8-hue chip palette that snuck back in, and `.page-title` defined three different ways in one stylesheet.

Fixing those three things gets ~90% of the "not AI-built" feel without touching layout. The directions in the board show how far past that you can push.

## What's already working — keep, don't redesign

- **The brand system itself.** A locked brand doc with usage rules ("emerald is signal, not decoration", "premium feel comes from craft, not noise") is more design infrastructure than most funded SaaS has. The direction is right; the app just doesn't fully obey it yet.
- **The content is the opposite of generic.** DPS scores, cal/cm² incident energy, NFPA 70B maturity levels, per-item "+0.3%" compliance recovery, "biggest lever recovers 73.6 pts" — no AI-generated demo site has this. Design's job here is staging, not decoration.
- **Ink sidebar chrome** — dark rail + light content is a solid, professional frame. Keep it in every direction.
- **A11y care is real** (v0.91 contrast fixes, `sr-only`, coarse-pointer touch targets, `prefers-reduced-motion`) — preserve through any restyle.
- **Dark mode** is token-driven and mostly survives — protect it during the hex sweep.

## Findings

### A. Composition — where the template feel comes from

| # | Finding | Evidence | Verdict |
|---|---------|----------|---------|
| A1 | No content max-width; cards stretch edge-to-edge on wide screens | `.page-body { padding: 28px 32px }`, no `max-width` (index.css); arc-flash stat columns ~350px apart on screenshot | **Fix first.** Single highest-value CSS change in the codebase |
| A2 | Dashboard is 8+ identical full-width white cards in one column — no visual hierarchy between "verdict" and "detail" | `grep -c 'className="card"' Dashboard.jsx` → 8, plus non-card modules; 1,167-line single-column page | Fix via direction A (order + emphasis) or B (zones) |
| A3 | Alarm overload: amber NWS banner + red inspector card + red maturity gauge + red compliance bar + red DANGER stat + red overdue pills + red dates, all at once | dashboard screenshots 2026-07-12 | **Fix.** Adopt a "one alarm per screen" budget |
| A4 | `Good evening, Avery` greeting as the H1, subtitle "Maintenance compliance at a glance" | Dashboard.jsx:858 | **Fix.** Consumer-app pattern; brand voice says serious/quiet. Use an operational header (org · scope · freshness · verdict) |
| A5 | Asset detail: 6 pills in 3 color languages before content (Phys C2 / Crit C2 / Env C2 / Governing / In service / Energized), and a **solid red Archive button** as the loudest element on a read screen | asset detail screenshot; `.btn-danger` in header row | **Fix.** One governing chip + overflow; Archive into a ⋯ menu |

### B. Brand drift — why polish feels off up close

| # | Finding | Evidence | Verdict |
|---|---------|----------|---------|
| B1 | Stock Tailwind 8-hue chip palette (incl. blue #2563eb, purple #7e22ce) added for equipment chips — violates brand rule "Semantic: use these — do not invent" | index.css `--chip-*` block (~line 1222); brand.md Semantic section | **Fix.** Map chips onto petrol + 3 semantic hues; this is the main place "generic Tailwind" leaks back in |
| B2 | `.page-title` defined 3× in one file: 24px/700 → accent-tinted → 28px/**800**; weight 800 is banned by the brand ladder and not in the shipped fonts (400/500/600/700) | index.css lines ~528, 1191; @font-face block ~849-862; brand.md weights | **Fix.** Cheap, removes a real inconsistency (renders as 700 anyway) |
| B3 | Token split-brain: `styles/tokens.css` is the "locked spec" but **is not imported**; index.css is runtime truth and has grown a second `:root` alias block that silently overrides values (`--radius` 6→8) | tokens.css header comment; index.css UX-A1-003 note | **Fix.** One source of truth; delete or generate one from the other |
| B4 | 1,189 hardcoded hex literals across 133 JSX files — the v0.5.7 brand pass admits this debt in its own comment | `grep -rEo '#[0-9a-fA-F]{6}' src/pages src/components \| wc -l`; index.css header | **Fix incrementally.** Scriptable sweep, top-20 files first; this is what keeps dark mode fragile |
| B5 | Border discipline: brand locks hairline `#e3e7ee`/`#c7cfdb`; app ships 1px `#dde2eb` (the *hover* shade) as default border | brand.md Neutrals; index.css `--color-border` comment admits it | Fix during direction A pass |
| B6 | Type scale drift: 15px body vs locked 14px modular scale; ad-hoc sizes accreted (`--font-size-2xs/ui/data/md`) alongside the spec scale | index.css font-size block vs brand.md type scale | Worth reconciling, lower priority than B1-B4 |

### C. Demo-path frictions (first-impression risk)

| # | Finding | Evidence | Verdict |
|---|---------|----------|---------|
| C1 | **Anonymous visit to `/` can hang on "Loading…"** — observed twice pre-login (>10s, landing never painted); after login everything was fast. Whole app render is gated on the auth probe (`if (loading) return <div className="loading">Loading…</div>`, App.jsx:19-20) | live observations 2026-07-12 ~a.m.; App.jsx:19-20, 285-286 | **Investigate first** — it's the first thing any prospect/acquirer sees. Mechanism is plausible but unverified; could also be the known PWA stale-SW issue |
| C2 | Heat-warning banner CTA ("View & Declare Emergency", solid orange) visually outranks every content element | dashboard screenshot | Minor; restyle to outline treatment within the banner |
| C3 | Sidebar: 7 uppercase section labels for ~20 items; org name is 11px faint text; Field Mode buried at the bottom | Sidebar screenshots | Fold into direction A/B nav pass |

Not captured: login screen (session was already authenticated; reviewed from CSS only — `.login-box` follows the card language and inherits whatever card fixes land).

## The three directions (rendered in the board)

| | A — Finish Quietly Modern | B — Control Room | C — Field Report |
|---|---|---|---|
| Thesis | The brand doc, actually executed | The dashboard becomes an instrument panel | The app reads like a stamped engineering report |
| Layout risk | None — CSS/token work only | Dashboard restructure, rest unchanged | Re-templating across pages |
| Effort (agent-time) | ~1-2 sessions | ~3-5 sessions | 1-2 weeks incremental |
| Palette | Locked brand palette | Locked brand palette | Locked brand palette |
| When to pick | Always — it's the floor for the others | If the demo needs to impress in the first 10 seconds | If you want unmistakable identity and accept the diff |

All three keep petrol/ink/emerald — modernization here is composition and discipline, **not** new colors. B builds on A; C builds on A. Recommendation: **ship A regardless**, then decide between B (safe, high demo impact) and C (distinctive, more work) after seeing the board.

## Punch list (ranked)

Effort: S = under half a session · M = about a session · L = multi-session.

| P | Item | Where | Effort | Direction |
|---|------|-------|--------|-----------|
| P0-1 | Root-cause the anonymous `/` "Loading…" hang (auth-probe gate vs stale SW), then fix so LandingPage paints immediately | App.jsx:19-20, 285-286; context/AuthContext.jsx | S-M | bug, all |
| P0-2 | Add content max-width (~1160px, centered) + retire full-bleed rows | index.css `.page-body` | S | all |
| P0-3 | Replace greeting H1 with operational header (org · sites · last-sync · verdict count) | Dashboard.jsx:858 | S | all |
| P0-4 | Demote Archive to overflow menu; reserve solid red for confirm dialogs | AssetDetail header | S | all |
| P0-5 | Alarm budget: one red module per screen; downgrade the rest to neutral/petrol with red only on datum glyphs | Dashboard.jsx modules | M | all |
| P1-6 | Re-map `--chip-*` palette onto brand semantics (petrol/success/warning/danger + slate); kill blue & purple chips | index.css chip block; lib/equipment.js metas | M | all |
| P1-7 | Collapse the 3 `.page-title` definitions to one (and `card-title`); drop weight 800; resolve the duplicate `:root` alias block | index.css ~528, ~1160-1241 | S | all |
| P1-8 | Hex sweep: migrate inline hexes to tokens, top-20 offender files first (scriptable, verify per-file) | pages/, components/ | M-L | all |
| P1-9 | Hairline borders per brand (`#e3e7ee` default, 1px only for emphasis) | index.css | S | A |
| P1-10 | Asset-detail pill consolidation: governing condition chip + "+3" overflow; status pills right-aligned | AssetDetail.jsx | M | A/B |
| P2-11 | Sidebar regroup (7 labels → 3-4), org identity block with switcher affordance, Field Mode promoted | Sidebar.jsx | M | B |
| P2-12 | Dashboard restructure: instrument strip + two-column zones (evidence left, action queue right) | Dashboard.jsx | L | B |
| P2-13 | Reconcile type scale to the locked modular scale; retire ad-hoc sizes | index.css + spot checks | M | A/B/C |
| P2-14 | Empty-state consistency (icon container pattern everywhere, incl. Incidents card) | components/EmptyState.jsx adoption | S | A |

## What changed in this review

Nothing. Read-only: live-demo screenshots + code reads + greps. No commits, no deploys, no file edits outside `docs/design/`. Implementation starts only on your pick of direction + punch-list approval.
