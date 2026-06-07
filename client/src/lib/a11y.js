// ─────────────────────────────────────────────────────────────────────────────
// client/src/lib/a11y.js
// ─────────────────────────────────────────────────────────────────────────────
//
// Tiny a11y helpers used by Dashboard, ReportsHub, AlertsPage, VendorDetail
// and any future "clickable card / clickable row" surface.
//
// Why this exists: those surfaces use <div onClick={...}> for navigation,
// which is unreachable to keyboard-only users and screen readers. The fully-
// semantic fix is to swap each div for a <button> or <Link>, but the existing
// styling depends on the divs being non-button (no UA defaults to reset).
// The WCAG-compliant workaround that React Aria, Material UI ButtonBase,
// and friends use under the hood: add role="button" + tabIndex={0} +
// onKeyDown handler that activates on Enter/Space. This file ships that
// onKeyDown handler so every site doesn't re-implement it.
//
// Audit reference: persona "Accessibility Engineer", Critical C9.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns an onKeyDown handler that invokes `handler` when the user presses
 * Enter or Space, mirroring native <button> keyboard activation. Space gets
 * preventDefault() so the page doesn't scroll.
 *
 * Usage:
 *   <div
 *     role="button"
 *     tabIndex={0}
 *     onClick={() => navigate('/foo')}
 *     onKeyDown={kbdActivate(() => navigate('/foo'))}
 *   >…</div>
 *
 * For disabled-style clickables, pass null and the helper returns undefined
 * so React skips the listener entirely.
 */
export function kbdActivate(handler) {
  if (!handler) return undefined;
  return (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handler(e);
    }
  };
}
