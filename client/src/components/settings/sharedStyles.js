// ──────────────────────────────────────────────────────────────────────────────
// Shared CSS class names for /settings section components
// ──────────────────────────────────────────────────────────────────────────────
//
// v0.91.8 Phase 1c Chunk B: the JS-object inline style exports from v0.91.3
// have moved to real CSS classes in client/src/index.css (search for the
// `=== Settings section primitives (v0.91.8 Phase 1c Chunk B) ===` block).
//
// This module now exports the CSS class NAMES as plain string constants so
// every section file can switch its JSX attribute from `style={X}` to
// `className={X}` without touching imports.
//
// Why we kept this module instead of inlining the strings into each section
// file: the indirection means future renames (or a switch to CSS Modules /
// Tailwind-style utility namespacing) can happen in ONE file instead of 14.
//
// Three small nuances vs the v0.91.3-v0.91.7 JS-object era:
//
//   1. The `toggle` + `toggleThumb` pair used to be SPREAD into inline-style
//      objects with per-state overrides (`{...toggle, background: meta.color}`).
//      Now the state lives on a `data-state="on" | "off"` attribute on the
//      toggle element; the CSS handles the background + thumb-position swap.
//      Section files that need per-alert-type accent colors (AlertPreferences)
//      keep an inline `style={{ background: meta.color }}` ALONGSIDE the
//      `className={toggle} data-state="on"` to layer the accent over the
//      default petrol-primary background defined on `.settings-toggle[data-state="on"]`.
//
//   2. Hover/disabled states for the buttons used to be invisible because
//      inline styles can't carry pseudo-classes. The class versions now
//      include `:hover:not(:disabled)` and `:disabled` rules, so the primary
//      button correctly darkens on hover and grays out when disabled. This
//      is a small visual improvement that wasn't possible before.
//
//   3. The dead-fallback `var(--*, #hex)` patterns that lived in toggle.border
//      and btnSecondary.background are gone -- the CSS uses the resolved
//      token directly. No behavior change because the vars always resolved.
// ──────────────────────────────────────────────────────────────────────────────

export const sectionHeading = 'settings-section-heading';
export const sectionDesc    = 'settings-section-desc';
export const toggle         = 'settings-toggle';
export const toggleThumb    = 'settings-toggle-thumb';
export const btnPrimary     = 'btn-settings-primary';
export const btnSecondary   = 'btn-settings-secondary';
