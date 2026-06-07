# LapseIQ brand system

**Version:** 1.1 · **Locked:** 2026-05-12 · **v0.91 palette update:** 2026-05-27 · **Direction:** Quietly Modern

This document defines the LapseIQ brand identity — palette, typography,
logo system, and usage rules. Single source of truth. When something
visual ships under the LapseIQ name (in-product, marketing site,
documents, signage, social), it pulls from this doc.

If a brand decision isn't in here, default to **restraint**. The brand
is built around the idea that procurement buyers want serious tools,
not flashy ones. Premium feel comes from craft, not noise.

---

## Logo system

LapseIQ has **three** primary lockups. All share the same brand mark
(a horizontal petrol bar with a vertical emerald tick) and the same
wordmark ("lapseiq" in Inter Medium with tight tracking).

### Lockup 1 — Horizontal (primary)

**File:** `brand/logo/lockup-horizontal.svg`

The default. Use this everywhere unless you have a specific reason
to reach for one of the alternates. Works in app headers, marketing
navigation, email signatures, business cards, social profile bios,
PDF document footers.

Aspect ratio: ~4.6 : 1. Minimum width: **120px** (below this the
green tick stops being visible).

### Lockup 2 — Stacked (alt)

**File:** `brand/logo/lockup-stacked.svg`

Mark centered above the wordmark, both horizontally centered. Reach
for this when you need a near-square footprint: favicon, social
media avatar (Twitter/LinkedIn/Facebook profile picture), side-nav
collapsed state, mobile splash, app icon backgrounds.

Aspect ratio: ~1.8 : 1. Minimum width: **64px**.

### Lockup 3 — Display (marketing only)

**File:** `brand/logo/lockup-display.svg`

The mark serves as a full-width underline beneath the wordmark.
Most distinctive composition. Reserve for **special-use moments**:
marketing site hero header, large signage, conference booth backdrops,
launch announcements, oversized printed materials.

Aspect ratio: ~2.3 : 1. Minimum width: **160px**. Do **not** use as
the everywhere primary — the mark fuses to the wordmark width, so
extracting just the mark at small scale is impossible.

### Monochrome variants

Each lockup has a single-color "ink" variant for cases where the
petrol-and-emerald palette can't render: single-color print, etched
signage, fax/scan reproduction, embossing.

- `lockup-horizontal-mono.svg`
- `lockup-stacked-mono.svg`
- `lockup-display-mono.svg`

The petrol bar and emerald tick both become `#0a0d12` (ink).

### Clear space

Around any lockup, maintain clear space equal to the **height of the
mark's bar** (6px at 1× scale, 12px at 2× scale, etc.) on all sides.
No other elements — text, logos, decorative shapes — should encroach
within that envelope.

### Do not

- Distort the aspect ratio (no horizontal/vertical stretching).
- Recolor the wordmark and mark independently (they're locked).
- Place the full-color logo on a backdrop in the same hue family
  (no petrol logo on a petrol page — use mono or reversed white).
- Rotate the logo.
- Add drop shadows, glows, or other decorative effects.
- Reproduce the wordmark in any weight other than Inter Medium (500).
- Recreate the mark in another tool from memory — always use the
  shipped SVG.

### Reversed (white) use

For dark backgrounds, the wordmark fills white (`#ffffff`), the bar
stays petrol (`#073a52`), the tick stays emerald (`#10b981`). The
mark colors don't change — only the wordmark inverts. This treatment
isn't pre-built as a separate SVG; produce per-asset when needed.

### Outlining for production

The shipped SVGs use `<text>` elements that depend on Inter being
loaded. For high-stakes external uses (press, third-party press kits,
signage vendors, large-format print) **convert the text to outlined
paths** in Illustrator or Figma before sending. This guarantees the
wordmark renders identically regardless of font availability.

---

## Color palette

### Primary

| Token | Hex | Usage |
|-------|-----|-------|
| `--color-petrol` | `#073a52` | Brand primary — bar in logo, primary buttons, links, active states, focused inputs (v0.91: darker — was `#0d4f6e`) |
| `--color-petrol-hover` | `#0d4f6e` | Hover state for any petrol surface in light mode (v0.91: now the former primary). In dark mode, hover is `#2986b8`. |
| `--color-petrol-tint` | `#e6f0f5` | Backgrounds for info pills, badges, accent areas |
| `--color-emerald` | `#10b981` | Signal accent — logo tick, "live" indicators, fresh data, positive states. **Use sparingly.** |
| `--color-emerald-soft` | `#d1fae5` | Backgrounds for success/positive states (sparingly) |

### Neutrals

| Token | Hex | Usage |
|-------|-----|-------|
| `--color-ink` | `#0a0d12` | Primary text, headings, wordmark |
| `--color-surface-dark` | `#13171f` | Dark surfaces, dark-mode cards |
| `--color-text-muted` | `#1e293b` | Secondary text, captions, helper text (v0.91: darker — was `#5b6373`, audit-flagged for contrast) |
| `--color-text-faint` | `#334155` | Tertiary text, hint text, disabled-state labels (v0.91: darker — was `#9aa3b2`, failed AA on .sidebar-user-name) |
| `--color-hover-bg` | `#dde2eb` | Hover backgrounds on list rows, tertiary buttons |
| `--color-section-bg` | `#eef1f6` | Section dividers, sidebar backgrounds |
| `--color-page-bg` | `#fafbfd` | App page background, marketing-site body |
| `--color-card` | `#ffffff` | Card surfaces, modal surfaces |
| `--color-border` | `#c7cfdb` | Default borders |
| `--color-border-subtle` | `#e3e7ee` | Hairline borders (0.5px), separator lines |

### Semantic

Reserved for state communication. Use these — do not invent.

| Token | Hex | Background | Usage |
|-------|-----|-----------|-------|
| `--color-info` | `#073a52` (petrol) | `--color-info-bg` | Informational alerts, neutral indicators |
| `--color-success` | `#15803d` | `--color-success-bg` (`#dcfce7`) | Successful actions, completed states |
| `--color-warning` | `#b45309` | `--color-warning-bg` (`#fef3c7`) | Caution, attention needed |
| `--color-danger` | `#b91c1c` | `--color-danger-bg` (`#fee2e2`) | Errors, destructive actions, critical alerts |

### Color usage rules

1. **Petrol is for primary actions and brand surfaces.** Not body text.
2. **Emerald is signal, not decoration.** If you find yourself using
   it for visual interest rather than to communicate "this is live,
   fresh, or positive," replace it with a neutral.
3. **Ink for text, not for surfaces.** Card backgrounds are white,
   never ink-on-ink.
4. **Borders are subtle.** Default to 0.5px hairlines, not 1px.
   Visual structure comes from spacing and color, not from heavy
   borders.
5. **Reach for `--color-text-muted` for secondary content** before
   reaching for opacity. Faded ink reads as broken, muted gray reads
   as deliberate.

### Dark mode palette (v0.91 — LOCKED)

LapseIQ ships a dark mode. Light/dark switching changes **colours only** —
type, spacing, radius, motion, and component dimensions are identical
across modes. The dark-mode token map:

| Token | Light value | Dark value | Notes |
|-------|-------------|-----------|-------|
| `--color-petrol` | `#073a52` | `#1a6b91` | Dark promotes former light-hover to default — petrol reads as muddy at light-primary `#073a52` against near-black surfaces. |
| `--color-petrol-hover` | `#0d4f6e` | `#2986b8` | One stop lighter than the dark primary. |
| `--color-petrol-tint` | `#e6f0f5` | `#102b3d` | Info pill backgrounds. |
| `--color-ink` | `#0a0d12` | `#f5f7fa` | Primary text. |
| `--color-text-muted` | `#1e293b` | `#cbd5e1` | Secondary text. |
| `--color-text-faint` | `#334155` | `#94a3b8` | Tertiary text. |
| `--color-page-bg` | `#fafbfd` | `#0a0d12` | App page background. |
| `--color-card` | `#ffffff` | `#13171f` | Card / modal surfaces. |
| `--color-section-bg` | `#eef1f6` | `#1a1f2a` | Sidebar, section dividers. |
| `--color-hover-bg` | `#dde2eb` | `#2a3140` | Row hover. |
| `--color-border` | `#c7cfdb` | `#2a3140` | Default 1px borders. |
| `--color-border-subtle` | `#e3e7ee` | `#1f2530` | Hairline 0.5px borders. |
| Semantic (success/warning/danger) | unchanged | unchanged | Brand keeps semantic palette identical across modes — already AA on dark surfaces. |
| Emerald | `#10b981` | `#10b981` | Brand mark tick — never inverts. |

Dark mode is implemented via `[data-theme='dark']` on the `<html>` element
plus a CSS-variable swap in `tokens.css`. No JS theme branching in
components. No per-component dark variants. **A component that needs
different *dimensions* in dark vs light is a bug.**

### v0.91 system-level token additions (LOCKED 2026-05-27)

Verified via Claude Design 51-pair WCAG audit per mockup, 0 fails across all 4 mockup files (dashboard, contracts, contract-detail, settings) in both themes.

| Token | Light | Dark | Role |
|-------|-------|------|------|
| `--color-petrol-text` | `#073a52` | `#7dc4e0` | AA-safe foreground when petrol primary is used as text colour (on petrol-tint backgrounds, on dark cards). In dark, the value brightens to maintain 4.5:1+ on `#13171f`. |
| `--color-emerald-text` | `#047857` | `#10b981` | AA-safe foreground on emerald-soft chip backgrounds. Light `#047857` on `#d1fae5` = 4.59:1 ✓. The lighter brand emerald `#10b981` on `#d1fae5` would only hit 2.23:1 — use `--color-emerald-text` for any emerald-on-emerald text. |
| `--color-petrol-on-chrome` | `#7dc4e0` | `#7dc4e0` | Petrol-as-text for use on the **always-dark sidebar chrome** (`#0a0d12`). Theme-independent because the sidebar doesn't theme-switch. |
| `--color-petrol-tint-on-chrome` | `#102b3d` | `#102b3d` | Pill background for the bell-badge informational counter on the sidebar. Pair AA: `#7dc4e0` on `#102b3d` = 6.42:1 ✓. |
| `--color-chrome-faint` | `#94a3b8` | `#94a3b8` | Sidebar group labels (WORKSPACE / ADMIN headers). Theme-independent. Only "faint" tier that lives in the always-dark chrome. Don't use for page content. |
| `--color-mono-bg` | `#e2e8f0` | `#334155` | Background for mono-rendered keys / hashes / timestamps inline. |
| `--color-mono-fg` | `#1e293b` | `#cbd5e1` | Foreground for the same. |
| `--color-section-bg` | `#f3f5f9` | `#14181f` | Section dividers and inset content blocks. Shifted from v0.5.0 `#eef1f6` to give a slightly cooler grey that pairs better with the new neutrals. |
| `--color-hover-bg` | `#eef1f6` | `#1c2230` | Row hover. Shifted from v0.5.0 `#dde2eb` for the same reason. |

Dark-mode semantic variants — light values would fail contrast on the dark page background. Tokens.css now ships paired light/dark hex for these:

| Semantic | Light | Light bg | Dark | Dark bg |
|----------|-------|----------|------|---------|
| Success | `#15803d` | `#dcfce7` | `#4ade80` | `#0e2818` |
| Warning | `#b45309` | `#fef3c7` | `#fbbf24` | `#2e2107` |
| Danger | `#b91c1c` | `#fee2e2` | `#f87171` | `#2a0e0e` |

The base `--color-emerald` (`#10b981`) and `--color-petrol-tint` pair stay light-mode-only — use `--color-emerald-soft` in light and a dedicated dark `--color-emerald-soft` (`#0d2a20`) for the same role on dark surfaces.

---

## Typography

### Font families

- **Sans (primary):** Inter
- **Mono (technical detail):** JetBrains Mono

Both are free and ship via Fontsource (`@fontsource/inter`,
`@fontsource/jetbrains-mono`). Loaded once at app boot from
`client/src/main.jsx`. Fallback stack defined in `tokens.css`.

### Type scale (1.250 modular, 14px base)

| Token | Size | Use |
|-------|------|-----|
| `--font-size-caption` | 11px | Uppercase eyebrows, micro-labels |
| `--font-size-small` | 12px | Helper text, table footnotes, badges |
| `--font-size-body` | 14px | Default body text, form labels, button labels |
| `--font-size-lead` | 16px | Section intros, key paragraph text |
| `--font-size-h3` | 20px | Section headings within pages |
| `--font-size-h2` | 25px | Page subheadings |
| `--font-size-h1` | 32px | Page headings |
| `--font-size-display` | 40px | Marketing-only hero text |

### Weights

v0.91 ladder: **400 (regular)**, **500 (medium)**, **700 (bold)**.
Do NOT load 200 (too thin at body sizes), 300, 600, or 800.

- 400 → body text, helper, section descriptions, placeholders, table-row data
- 500 → wordmark (locked in lockup SVGs), section eyebrows, button labels, primary nav items
- 700 → section headings (h1/h2/h3), active tab labels, KPI hero numbers

The two-weight rule from v1.0 (400/500 only) was relaxed because
audit-bot found visual hierarchy reading as flat at section-heading
sizes. Adding 700 lets headings carry weight without size inflation,
while restricting to three weights preserves restraint.

### Tracking (letter-spacing)

| Token | Value | Use |
|-------|-------|-----|
| `--tracking-tight` | -0.02em | Wordmark, large display text |
| `--tracking-normal` | 0 | Body text, default |
| `--tracking-wide` | 0.08em | Uppercase eyebrows / micro-labels (always pair with `text-transform: uppercase`) |

### Mono usage

`var(--font-mono)` is for **technical data only** — contract numbers,
timestamps, currency values, API tokens, code snippets, file paths.
Don't use mono for general body text. Use it deliberately, where the
fixed-width grid makes the data feel "data-y."

### Line-height

Default body: `--leading-normal` (1.55). Headings: `--leading-tight`
(1.1). Long-form prose: `--leading-loose` (1.75).

---

## Spacing scale

4px base. Use the named scale, not arbitrary px values.

| Token | Value | Use |
|-------|-------|-----|
| `--space-1` | 4px | Tight rhythm (inline icon to label) |
| `--space-2` | 8px | Component-internal gaps |
| `--space-3` | 12px | Default grouping gap |
| `--space-4` | 16px | Card padding (small), form-row gap |
| `--space-5` | 20px | Section gap (small) |
| `--space-6` | 24px | Card padding (default), heading-to-body gap |
| `--space-8` | 32px | Section gap (default) |
| `--space-10` | 40px | Page section breathing room |
| `--space-12` | 48px | Major section divides |
| `--space-16` | 64px | Hero / marketing-only generous spacing |
| `--space-20` | 80px | Marketing-only generous spacing |

---

## Border radius

| Token | Value | Use |
|-------|-------|-----|
| `--radius-sm` | 4px | Inputs, small chips |
| `--radius-md` | 6px | Buttons, badges, default surfaces |
| `--radius-lg` | 10px | Cards, modals |
| `--radius-xl` | 14px | Hero cards, marketing-only large rounded surfaces |
| `--radius-pill` | 999px | Pills, status badges (use sparingly) |

---

## Iconography

Use **Tabler Icons (outline)** for any UI icon. Free, comprehensive
(5800+), and the line weight matches Inter at default 14px body.

Available via npm: `@tabler/icons-react`.

Sizes:
- 14px: inline within body text
- 16px: inline within form labels, buttons
- 20px: nav items, prominent labels
- 24px: page-header iconography

**Do not** mix icon families (no Heroicons, no Material Icons, no
custom-drawn icon paths). Always use Tabler outline, never filled.

---

## Motion

Use sparingly. Motion is for state changes, not decoration.

| Token | Duration | Use |
|-------|----------|-----|
| `--transition-fast` | 120ms | Hover states, button presses |
| `--transition-base` | 200ms | Modal opens, page transitions |
| `--transition-slow` | 320ms | Decorative reveals (rare) |

All transitions use `cubic-bezier(0.4, 0, 0.2, 1)` — material-style
ease-out. Linear feels mechanical; bouncy feels juvenile.

---

## What the brand sounds like

The visual brand has a voice. When writing for LapseIQ — product
copy, marketing, documentation, error messages — match the visual
restraint. Quietly confident. Plain English. No marketing-ese.

**Do:**
- Use plain English procurement and IT people understand
- Quantify when you can ("3 days before renewal" not "soon")
- Acknowledge the customer's intelligence ("you already know")

**Don't:**
- Use words like "leverage," "synergy," "transform" (unless literal)
- Use AI marketing buzzwords ("revolutionary," "magical," "10x")
- Promise outcomes you can't guarantee ("guaranteed 30% savings")
- Talk down to the reader

---

## Asset inventory

```
brand/
├── brand.md                              ← this file
├── logo/
│   ├── lockup-horizontal.svg             ← primary
│   ├── lockup-horizontal-mono.svg
│   ├── lockup-stacked.svg                ← square-space alt
│   ├── lockup-stacked-mono.svg
│   ├── lockup-display.svg                ← marketing-only
│   └── lockup-display-mono.svg
└── favicon/
    ├── favicon.svg                       ← scalable, primary
    ├── favicon-16.svg                    ← optimized for 16x16
    ├── favicon-32.svg                    ← optimized for 32x32
    └── apple-touch-icon.svg              ← 180x180 iOS home screen
```

CSS tokens live at `client/src/styles/tokens.css` and are the
authoritative palette / type / spacing / radius / motion source for
the application.

---

## When in doubt

The brand is built on **restraint**. If a decision is ambiguous,
default to the quieter / smaller / more-neutral choice. Premium feel
comes from precision and consistency, not from louder colors or
bigger type.

Questions? Update this file with the answer once you've decided —
brand decisions should accumulate here, not in chat.
