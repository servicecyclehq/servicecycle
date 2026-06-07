/**
 * HelpButton — DEPRECATED as of v0.37.1 (Pass-6 W5 MT-117).
 *
 * The 6 per-NavLink HelpButton instances in Sidebar.jsx were dropped to
 * close Pass-3 MUST-FIX D1 (active-row background was truncating ~28px
 * short of the right edge because of the .nav-item-row wrapper this
 * button required) and to consolidate help entry points down to the
 * standalone "Help" button + the Help & Share footer menu.
 *
 * The file is kept as a deprecation stub so a stray re-import surfaces
 * a clear error message instead of a silent component-not-found. Real
 * deletion is queued for the W6 polish wave alongside the lazy-load
 * cleanup of the other on-demand UI bits.
 *
 * If you find yourself wanting a per-page help affordance, dispatch the
 * `lapseiq:open-help` CustomEvent directly with `{ detail: { moduleSlug
 * } }`. HelpDrawer (mounted at App root since v0.37.1) listens globally
 * and opens itself.
 */

export default function HelpButton() {
  throw new Error(
    'HelpButton is deprecated as of v0.37.1 (MT-117). ' +
    'Dispatch a `lapseiq:open-help` CustomEvent instead, ' +
    'or open the standalone Help button in the sidebar.'
  );
}
