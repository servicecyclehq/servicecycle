// Pass-3 audit MUST #3 (2026-05-17): focus trap for modal dialogs.
//
// Pre-fix, every modal in the SPA (AskModal, FeedbackModal, AiConsentModal,
// OnboardingWizard, WelcomeTourPanel) declared role="dialog" + aria-modal=true
// but didn't actually trap focus. Tab would escape to the page underneath
// and previousFocus wasn't saved/restored on close. WCAG 2.4.3 (Focus Order)
// + 2.4.11 (Focus Not Obscured) both failed.
//
// This hook:
//   1. Saves the element that had focus when the modal opened.
//   2. Moves focus to the modal's first focusable element on mount.
//   3. On Tab, cycles within the modal's focusable set; on Shift+Tab,
//      cycles in reverse.
//   4. On Escape, calls onClose (caller opts in).
//   5. On unmount, restores focus to the saved element so the keyboard
//      user is back where they started.
//
// Usage:
//   const dialogRef = useRef(null);
//   useFocusTrap(dialogRef, { onClose, autoFocus: true });
//   return <div ref={dialogRef} role="dialog" aria-modal="true">…</div>
//
// Notes:
//   - We use document.activeElement at the time of mount as the restore
//     target. If focus changes during the modal's life (because the
//     caller manually moves focus), we still restore to the original.
//   - The focusable selector includes everything that browsers consider
//     keyboard-navigable. Custom interactive divs are NOT included
//     intentionally — they should be real <button>/<a> elements; pass-3
//     and pass-1 both flagged any <div onClick> as a separate finding.

import { useEffect } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'area[href]:not([tabindex="-1"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'iframe:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
  'audio[controls]:not([tabindex="-1"])',
  'video[controls]:not([tabindex="-1"])',
  '[contenteditable]:not([contenteditable="false"]):not([tabindex="-1"])',
].join(',');

export function useFocusTrap(containerRef, { onClose, autoFocus = true } = {}) {
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    // Save the previously-focused element so we can restore on unmount.
    const previousActiveElement = document.activeElement;

    function getFocusable() {
      return Array.from(node.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement);
    }

    // Move focus into the dialog. Prefer the first input/textarea/button
    // marked autoFocus; otherwise just the first focusable.
    if (autoFocus) {
      const focusable = getFocusable();
      const explicitlyAutoFocus = focusable.find(el => el.hasAttribute('autofocus'));
      const target = explicitlyAutoFocus || focusable[0] || node;
      // setTimeout(0) lets React finish the mount paint before we move
      // focus — otherwise some browsers race with the focus call.
      setTimeout(() => target.focus(), 0);
    }

    function handleKey(e) {
      if (e.key === 'Escape' && onClose) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const focusable = getFocusable();
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      // Otherwise let the browser handle the Tab natively — focus
      // moves to the next focusable within the dialog.
    }

    node.addEventListener('keydown', handleKey);

    return () => {
      node.removeEventListener('keydown', handleKey);
      // Restore focus to the element that had it before the modal opened.
      // Defensive: only restore if the element is still in the DOM and
      // still focusable.
      if (previousActiveElement && typeof previousActiveElement.focus === 'function'
          && document.body.contains(previousActiveElement)) {
        try { previousActiveElement.focus({ preventScroll: true }); }
        catch { /* element no longer focusable; harmless */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export default useFocusTrap;
